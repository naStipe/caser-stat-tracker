import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CasePrices, upgradeRows, caseRows, feedDrops, volumeSample, hashUser } from '../src/parse.js';
import { aggregate, ratioOf, compareRatios, combine, volumeRates, pulseSummary, pulseWindows, HOUR } from '../src/stats.js';
import { createCollector, HttpError } from '../src/collector.js';
import { createSite, jwtExpiry } from '../src/site.js';
import { createStore } from '../src/store.js';
import { createServer, authorized } from '../src/server.js';
import { createMonitor } from '../src/main.js';

const T0 = Date.parse('2026-11-14T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const tmp = () => mkdtemp(join(tmpdir(), 'pulse-monitor-'));

const upRow = (id, ms, stake, won, target = stake * 2) => ({
  id: String(id), status: won ? 'won' : 'lost', probability: String((stake / target) * 1.03), addedBalance: '0',
  betItems: [{ id: 'b', price: String(stake) }], targetItem: { id: 't', price: String(target) },
  wonItem: won ? { id: 't', price: String(target) } : null, createdAt: iso(ms),
});
const caseRow = (id, ms, slug, price) => ({
  id: String(id), action: 'won_case', price: String(price), createdAt: iso(ms),
  item: { id: 'i', marketName: 'X', price: String(price) }, source: { type: 'case', case: { slug } },
});
const prices = () => {
  const p = new CasePrices();
  p.learnList({ cases: [{ id: '1', slug: 'magnum', price: '19' }] });
  return p;
};

// ---- parse ----

test('parse: settled upgrades and paid case drops become anonymous rows', () => {
  const ups = upgradeRows({ items: [upRow(1, T0, 10, true), upRow(2, T0, 10, false), { ...upRow(3, T0, 10, false), status: 'pending' }] }, 'h1');
  assert.deepEqual(ups.map((r) => [r.id, r.stake, r.returned, r.u]), [['upgrade:1', 10, 20, 'h1'], ['upgrade:2', 10, 0, 'h1']]);
  assert.ok(Math.abs(ups[0].chance - 51.5) < 1e-9);
  const unknown = new Set();
  const cs = caseRows({ items: [caseRow(5, T0, 'magnum', 7), caseRow(6, T0, 'gone', 3), { id: 7, action: 'sold' }] }, prices(), 'h1', { unknownSlugs: unknown });
  assert.deepEqual(cs.map((r) => [r.id, r.kind, r.stake, r.returned]), [['case:5', 'case', 19, 7]]);
  assert.deepEqual([...unknown], ['gone']);
  for (const r of [...ups, ...cs]) assert.deepEqual(Object.keys(r).sort(), ['back', 'chance', 'id', 'kind', 'returned', 'stake', 'ts', 'u']);
});

test('parse: feed wins are skipped by item name, featured upgrades are read once, prices of one case', () => {
  const win = { ...upRow(1, T0, 10, true, 100), targetItem: { id: 't', marketName: 'AWP | Asiimov', price: '100' } };
  const loss = { ...upRow(2, T0, 10, false, 100), targetItem: { id: 't', marketName: 'AWP | Asiimov', price: '100' } };
  const skip = new Set(['AWP | Asiimov', 'Knife']);
  assert.deepEqual(upgradeRows({ items: [win, loss] }, 'h', { skip, back: true }).map((r) => [r.id, r.back]), [['upgrade:2', true]]);
  assert.equal(upgradeRows({ items: [loss], featured: [loss, win] }, 'h').length, 2, 'featured adds the win, not the repeat');
  const drop = { ...caseRow(5, T0, 'magnum', 7), item: { marketName: 'Knife', price: '7' } };
  assert.equal(caseRows({ items: [drop] }, prices(), 'h', { skip }).length, 0);
  const p = new CasePrices();
  p.learnOne({ case: { slug: 'gone', price: '3.5' } });
  assert.equal(p.get('gone'), 3.5);
  const mystery = { ...upRow(9, T0, 10, false), isMystery: true, wonItem: { price: '4' } };
  assert.deepEqual(upgradeRows({ items: [mystery] }, 'h').map((r) => [r.returned, r.chance]), [[4, null]]);
});

test('parse: feed, volume, hash', () => {
  const d = feedDrops({ liveDrops: [{ user: { id: '1' }, item: { marketName: 'A' } }, { user: { id: 1 }, item: { marketName: 'B' } }], hotDrops: [{ user: { id: 'bad id!' } }] });
  assert.deepEqual([...d.keys()], ['1']);
  assert.deepEqual([...d.get('1')], ['A', 'B']);
  assert.deepEqual(volumeSample({ cases_opened: 10, upgrader_count: 5, online: 3 }, T0), { ts: T0, cases: 10, upgrades: 5, online: 3 });
  assert.equal(volumeSample({}, T0), null);
  assert.equal(hashUser('941604', 'a'), hashUser('941604', 'a'));
  assert.notEqual(hashUser('941604', 'a'), hashUser('941604', 'b'));
  assert.match(hashUser('941604', 'a'), /^[0-9a-f]{16}$/);
});

// ---- stats ----

test('stats: return per 1 with an interval clustered by player', () => {
  const rows = [];
  for (let p = 0; p < 10; p++) for (let i = 0; i < 10; i++) rows.push({ id: `${p}-${i}`, kind: 'upgrade', ts: T0 + i, u: `p${p}`, stake: 10, returned: i % 2 ? 19 : 0 });
  const [a] = aggregate(rows, { from: T0, to: T0 + HOUR, bucketMs: HOUR });
  assert.equal(a.n, 100);
  assert.equal(a.players, 10);
  const r = ratioOf(a);
  assert.ok(Math.abs(r.ratio - 0.95) < 1e-12);
  assert.ok(r.se < 1e-9, 'every player has the same total');
  assert.equal(ratioOf({ ...a, players: 3 }).ci, null);
});

test('stats: a clear change is flagged, noise is not', () => {
  const mk = (players, perPlayer, ret) => {
    const rows = [];
    for (let p = 0; p < players; p++) for (let i = 0; i < perPlayer; i++) rows.push({ id: `${p}-${i}`, kind: 'case', ts: T0, u: `p${p}`, stake: 10, returned: ret(p, i) });
    return combine(aggregate(rows, { from: T0, to: T0 + 1, bucketMs: 1 }), 'case');
  };
  const low = mk(20, 10, (p, i) => (i < 2 ? 30 : 2));
  const high = mk(20, 10, (p, i) => (i < 4 ? 30 : 2));
  assert.equal(compareRatios(high, low).verdict, 'better');
  assert.equal(compareRatios(low, high).verdict, 'worse');
  assert.equal(compareRatios(mk(20, 10, (p, i) => ((p + i) % 5 === 0 ? 30 : 2)), mk(20, 10, (p, i) => ((p + i + 1) % 5 === 0 ? 30 : 2))).verdict, 'same');
  assert.equal(compareRatios(mk(2, 5, () => 10), low).verdict, 'few');
});

test('stats: volume rates and summary windows', () => {
  const s = [0, 1, 2, 3].map((m) => ({ ts: T0 + m * 60000, cases: 1000 + m * 100, upgrades: 500 + m * 60, online: 10 + m }));
  assert.equal(volumeRates(s, { from: T0, to: T0 + HOUR }).casesPerMin, 100);
  const now = T0 + 30 * 60000;
  const w = pulseWindows(now);
  const rows = [{ id: 'a', kind: 'upgrade', ts: now - 10 * 60000, u: 'x', stake: 10, returned: 12 }];
  const one = (win) => aggregate(rows, { from: win.from, to: win.to, bucketMs: win.to - win.from });
  const sum = pulseSummary({ recent: one(w.recent), base: one(w.base), day: one(w.day), hours: aggregate(rows, w.hours) }, [], now);
  assert.equal(sum.hours.length, 24);
  assert.equal(sum.hours[0].start, T0);
  assert.equal(sum.compare.upgrade.recent.ratio, 1.2);
});

// ---- collector ----

function fakeSite() {
  const site = { feed: { liveDrops: [{ user: { id: '42' } }] }, ups: { 42: [] }, inv: { 42: [] }, fail: null };
  site.getJson = async (path) => {
    if (site.fail) {
      const f = site.fail;
      site.fail = null;
      throw new HttpError(f, path);
    }
    const p = path.split('?')[0];
    if (p === '/api/game/cases') return { cases: [{ id: '1', slug: 'magnum', price: '19' }] };
    if (p === '/api/live-drops') return site.feed;
    if (p === '/api/statistics') return { cases_opened: 100, upgrader_count: 50, online: 5 };
    let m = p.match(/^\/api\/game\/upgrade\/public-history\/(\w+)$/);
    if (m) return { items: [...site.ups[m[1]]].reverse() };
    m = p.match(/^\/api\/users\/(\w+)\/inventory\/history$/);
    if (m) return { items: [...site.inv[m[1]]].reverse() };
    throw new HttpError(404, p);
  };
  return site;
}

function harness(site, options = {}) {
  let t = T0;
  const saved = [];
  const c = createCollector({
    getJson: (p) => site.getJson(p),
    hashUser: async (id) => `h${id}`,
    saveRows: async (rows) => saved.push(...rows),
    saveVolume: async () => {},
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    options: { gapMs: 1000, ...options },
  });
  return { c, saved, advance: (ms) => (t += ms), now: () => t };
}

test('collector: a found player is backfilled without the feed win, then followed for new rows', async () => {
  const site = fakeSite();
  site.feed = { liveDrops: [{ user: { id: '42' }, item: { marketName: 'Big Win' } }] };
  const big = { ...upRow(2, T0 - 1000, 100, true, 1000), targetItem: { id: 't', marketName: 'Big Win', price: '1000' } };
  site.ups[42].push(upRow(0, T0 - 2 * 86400000, 10, true), upRow(1, T0 - 60000, 10, false), big);
  site.inv[42].push(caseRow(10, T0 - 5000, 'magnum', 50));
  const { c, saved, now } = harness(site);
  let added = false;
  let budget = 30;
  const origGet = site.getJson;
  site.getJson = async (path) => {
    if (--budget === 0) c.stop();
    if (!added && saved.length) {
      added = true;
      site.ups[42].push(upRow(3, now(), 10, false), upRow(4, now(), 10, true));
      site.inv[42].push(caseRow(11, now(), 'magnum', 5));
    }
    return origGet(path);
  };
  await c.start();
  const by = Object.fromEntries(saved.map((r) => [r.id, r]));
  assert.ok(!by['upgrade:2'], 'the feed win is never counted');
  assert.ok(!by['upgrade:0'], 'rows older than 24 h are not backfilled');
  assert.equal(by['upgrade:1'].back, true);
  assert.equal(by['case:10'].back, true);
  assert.equal(by['upgrade:3'].back, false);
  assert.equal(by['case:11'].back, false);
  assert.equal(saved.length, 5, 'nothing is counted twice');
});

test('collector: 429 pauses, 401 stops', async () => {
  const site = fakeSite();
  const { c } = harness(site);
  site.fail = 429;
  let n = 0;
  const orig = site.getJson;
  site.getJson = async (p) => {
    if (++n === 2) site.fail = 401;
    return orig(p);
  };
  await c.start();
  assert.equal(c.status().running, false);
  assert.match(c.status().error, /refused/);
  assert.equal(n, 2);
});

test('collector: caps and expiry', async () => {
  const site = fakeSite();
  site.feed = { liveDrops: Array.from({ length: 50 }, (_, i) => ({ user: { id: String(100 + i) }, item: { marketName: 'W' } })) };
  for (let i = 0; i < 50; i++) {
    site.ups[100 + i] = [upRow(i, T0 - 1000, 10, false)];
    site.inv[100 + i] = [];
  }
  const { c, advance } = harness(site, { maxPlayers: 5, maxQueue: 10 });
  let budget = 3 + 2 * 8;
  const orig = site.getJson;
  site.getJson = async (p) => {
    if (--budget === 0) c.stop();
    return orig(p);
  };
  await c.start();
  assert.equal(c.status().players, 5);
  assert.ok(c.status().queued <= 10);
  advance(3 * HOUR);
  assert.equal(c.status().players, 0);
});

// ---- store ----

test('store: rows are unique by id, survive a restart, old files are pruned', async () => {
  const dir = await tmp();
  try {
    let t = T0;
    const a = await createStore({ dir, now: () => t });
    assert.equal(await a.putRows([{ id: 'x', ts: T0 - 1000 }, { id: 'y', ts: T0 - 2000 }]), 2);
    assert.equal(await a.putRows([{ id: 'x', ts: T0 - 1000 }]), 0);
    await a.putVolume({ ts: T0, cases: 1, upgrades: 1, online: 1 });
    const b = await createStore({ dir, now: () => t });
    assert.equal(b.count(), 2);
    assert.equal(await b.putRows([{ id: 'y', ts: T0 - 2000 }]), 0, 'repeats are spotted after a restart');
    assert.equal(b.since(T0 - HOUR).volume.length, 1);
    t += 20 * 24 * HOUR;
    await b.prune();
    assert.equal(b.count(), 0);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- site login ----

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (expMs, n = 0) => `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(expMs / 1000), n })}.sig`;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Fake site behind fetch, with rotating refresh tokens. */
function fakeWorld(clock) {
  const w = { issued: 0, refreshTokens: new Set(['r0']), access: new Set(), calls: [], htmlNext: false, killAccess: false };
  w.fetch = async (url, init = {}) => {
    const u = new URL(url);
    w.calls.push(`${init.method || 'GET'} ${u.pathname}`);
    assert.match(init.headers['user-agent'], /^pulse-collector\//);
    if (u.pathname === '/api/users/auth/refresh') {
      const { refreshToken } = JSON.parse(init.body);
      if (!w.refreshTokens.has(refreshToken)) return json(401, { code: 401 });
      const token = jwt(clock() + 15 * 60000, ++w.issued);
      w.access.add(token);
      w.refreshTokens.delete(refreshToken);
      w.refreshTokens.add(`r${w.issued}`);
      return json(200, { token, refreshToken: `r${w.issued}` });
    }
    if (w.killAccess) {
      w.killAccess = false;
      w.access.clear();
    }
    if (!w.access.has((init.headers.authorization || '').replace(/^Bearer /, ''))) return json(401, { code: 401, message: 'JWT Token not found' });
    if (w.htmlNext) {
      w.htmlNext = false;
      return new Response('<html>challenge</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    }
    if (u.pathname === '/api/game/cases') return json(200, { cases: [{ id: '1', slug: 'magnum', price: '19' }] });
    if (u.pathname === '/api/live-drops') return json(200, { liveDrops: [{ user: { id: '42' }, item: { marketName: 'Big' } }] });
    if (u.pathname === '/api/statistics') return json(200, { cases_opened: 100, upgrader_count: 50, online: 5 });
    if (u.pathname === '/api/game/upgrade/public-history/42') return json(200, { items: [upRow(7, clock() - 60000, 10, false)] });
    if (u.pathname === '/api/users/42/inventory/history') return json(200, { items: [caseRow(9, clock() - 30000, 'magnum', 5)] });
    return json(404, {});
  };
  return w;
}

test('site: jwt expiry, renewal before expiry, rotated token kept', async () => {
  assert.equal(jwtExpiry(jwt(T0)), Math.floor(T0 / 1000));
  assert.equal(jwtExpiry('junk'), null);
  let t = T0;
  const w = fakeWorld(() => t);
  const saved = [];
  const site = createSite({ fetch: w.fetch, base: 'https://caser.test', userAgent: 'pulse-collector/test', tokens: { refresh: 'r0' }, saveTokens: (x) => saved.push(x), now: () => t });
  await site.getJson('/api/statistics');
  await site.getJson('/api/statistics');
  assert.deepEqual(w.calls, ['POST /api/users/auth/refresh', 'GET /api/statistics', 'GET /api/statistics']);
  assert.equal(saved.at(-1).refresh, 'r1');
  t += 15 * 60000;
  await site.getJson('/api/statistics');
  assert.equal(site.tokens().refresh, 'r2');
});

test('site: a 401 renews once; a dead refresh token or an HTML page throws', async () => {
  let t = T0;
  const w = fakeWorld(() => t);
  const site = createSite({ fetch: w.fetch, base: 'https://caser.test', userAgent: 'pulse-collector/test', tokens: { refresh: 'r0' }, saveTokens: () => {}, now: () => t });
  await site.getJson('/api/statistics');
  w.killAccess = true;
  assert.equal((await site.getJson('/api/statistics')).online, 5);
  w.htmlNext = true;
  await assert.rejects(site.getJson('/api/statistics'), (e) => e instanceof HttpError && e.status === 403);
  w.refreshTokens.clear();
  w.killAccess = true;
  await assert.rejects(site.getJson('/api/statistics'), (e) => e instanceof HttpError && e.status === 401);
});

// ---- monitor ----

async function startMonitor(w, env, clock, budgetN = 12) {
  let budget = budgetN;
  const m = await createMonitor({
    env,
    fetch: async (url, init) => {
      if (--budget === 0) m.stop();
      return w.fetch(url, init);
    },
    version: 'test',
    log: () => {},
    now: clock.now,
    sleep: async (ms) => clock.advance(ms),
  });
  return m;
}

test('monitor: collects into the store, summarizes, keeps tokens and salt across restarts', async () => {
  const dir = await tmp();
  try {
    let t = T0;
    const clock = { now: () => t, advance: (ms) => (t += ms) };
    const w = fakeWorld(() => t);
    const env = { CASER_REFRESH_TOKEN: 'r0', CASER_BASE: 'https://caser.test', DATA_DIR: dir };
    const first = await startMonitor(w, env, clock);
    assert.equal(first.config.gapMs, 8000);
    assert.equal((await first.run()).error, null);
    const snap = first.snapshot();
    assert.equal(snap.info.stored, 2);
    assert.equal(snap.summary.day.upgrade.n, 1);
    assert.equal(snap.summary.day.case.n, 1);
    const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    assert.equal(state.tokens.refresh, `r${w.issued}`);
    assert.ok(!JSON.stringify(state).includes('"42"'), 'no player ids in the state');

    t += 20 * 60000; // the saved access token has run out
    const issued = w.issued;
    const second = await startMonitor(w, env, clock);
    assert.equal(second.state.salt, state.salt);
    assert.equal(second.store.count(), 2, 'rows are loaded back');
    await second.run();
    assert.equal(w.issued, issued + 1, 'the rotated refresh token still works');

    w.refreshTokens.add('fresh');
    const third = await startMonitor(w, { ...env, CASER_REFRESH_TOKEN: 'fresh' }, clock);
    assert.equal(third.state.tokens.refresh, 'fresh', 'a new env token replaces the saved one');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('monitor: a dead refresh token stops the collector before any data request', async () => {
  const dir = await tmp();
  try {
    let t = T0;
    const w = fakeWorld(() => t);
    w.refreshTokens.clear();
    const m = await startMonitor(w, { CASER_REFRESH_TOKEN: 'gone', CASER_BASE: 'https://caser.test', DATA_DIR: dir }, { now: () => t, advance: (ms) => (t += ms) }, 100);
    assert.match((await m.run()).error, /signed out/);
    assert.deepEqual(w.calls, ['POST /api/users/auth/refresh']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('monitor: refuses to start without a token', async () => {
  const dir = await tmp();
  try {
    await assert.rejects(createMonitor({ env: { DATA_DIR: dir }, fetch: async () => {}, version: 't', log: () => {} }), /CASER_REFRESH_TOKEN/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- server ----

test('server: password on everything but the health check', async () => {
  assert.equal(authorized(undefined, null), true);
  assert.equal(authorized(`Basic ${Buffer.from('any:pw').toString('base64')}`, 'pw'), true);
  assert.equal(authorized(`Basic ${Buffer.from('any:no').toString('base64')}`, 'pw'), false);
  const server = createServer({ snapshot: () => ({ ok: 1 }), html: '<p>page</p>', password: 'pw' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { authorization: `Basic ${Buffer.from('me:pw').toString('base64')}` };
  try {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/`)).status, 401);
    assert.equal((await fetch(`${base}/api/summary`)).status, 401);
    assert.equal(await (await fetch(`${base}/`, { headers: auth })).text(), '<p>page</p>');
    assert.deepEqual(await (await fetch(`${base}/api/summary`, { headers: auth })).json(), { ok: 1 });
    assert.equal((await fetch(`${base}/nope`, { headers: auth })).status, 404);
  } finally {
    server.close();
  }
});
