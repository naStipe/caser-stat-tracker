import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CasePrices, upgradeRows, caseRows, feedDrops, volumeSample, hashUser } from '../src/parse.js';
import { aggregate, ratioOf, compareRatios, combine, volumeRates, pulseSummary, pulseWindows, indexOf, compareIndex, HOUR } from '../dashboard/stats.js';
import { rangeSpec, buildReport, monitorHealth, compareSpec, windowsFor, pickWindow, settledAt, againstNormal, STEP, DEFAULT_LAG } from '../dashboard/view.js';
import { createCollector, HttpError, fieldNames } from '../src/collector.js';
import { createSite, jwtExpiry } from '../src/site.js';
import { createCloud } from '../src/cloud.js';
import { alertRequest, createNotifier } from '../src/notify.js';
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
  for (const r of ups) assert.deepEqual(Object.keys(r).sort(), ['back', 'chance', 'id', 'kind', 'returned', 'stake', 'ts', 'u', 'won']);
  for (const r of cs) assert.deepEqual(Object.keys(r).sort(), ['back', 'chance', 'id', 'kind', 'returned', 'slug', 'stake', 'tier', 'ts', 'u']);
  assert.deepEqual(ups.map((r) => r.won), [true, false]);
  assert.equal(cs[0].slug, 'magnum');
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
  site.ups[42].push(upRow(0, T0 - 8 * 86400000, 10, true), upRow(1, T0 - 60000, 10, false), big);
  site.inv[42].push(caseRow(10, T0 - 5000, 'magnum', 50));
  const { c, saved, now } = harness(site);
  let added = false;
  let budget = 30;
  const origGet = site.getJson;
  site.getJson = async (path) => {
    if (--budget === 0) c.stop();
    if (!added && saved.some((r) => r.kind === 'case')) {
      added = true;
      site.ups[42].push(upRow(3, now(), 10, false), upRow(4, now(), 10, true));
      site.inv[42].push(caseRow(11, now(), 'magnum', 5));
    }
    return origGet(path);
  };
  await c.start();
  const by = Object.fromEntries(saved.map((r) => [r.id, r]));
  assert.ok(!by['upgrade:2'], 'the feed win is never counted');
  assert.ok(!by['upgrade:0'], 'rows older than 7 days are not read');
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

// ---- site login ----

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (expMs, n = 0) => `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(expMs / 1000), n })}.sig`;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Fake site behind fetch, with rotating refresh tokens. */
function fakeWorld(clock) {
  const w = { issued: 0, refreshTokens: new Set(['r0']), access: new Set(), calls: [], htmlNext: false, killAccess: false };
  w.db = { rows: new Map(), volume: new Map(), status: null, events: [], private: {}, deletes: [], fail: 0 };
  w.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.host === 'db.supabase.test') return fakeSupabase(w.db, u, init);
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

/** The parts of Supabase's REST API the monitor uses. */
function fakeSupabase(db, u, init) {
  assert.equal(init.headers.apikey, 'sb_secret_test');
  if (db.fail) {
    db.fail--;
    return json(503, { message: 'down' });
  }
  const table = u.pathname.replace('/rest/v1/', '');
  if (init.method === 'DELETE') {
    db.deletes.push(`${table}?${u.searchParams}`);
    return new Response(null, { status: 204 });
  }
  const body = JSON.parse(init.body);
  if (table === 'monitor_status') {
    db.status = body;
    return new Response(null, { status: 201 });
  }
  if (table === 'monitor_events') {
    db.events.push(...body);
    return new Response(null, { status: 201 });
  }
  if (table === 'monitor_private') {
    db.private[body.key] = body.value;
    return new Response(null, { status: 201 });
  }
  if (table === 'monitor_rows') {
    assert.match(init.headers.prefer, /merge-duplicates/);
    const ids = body.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, 'no id twice in one request');
    for (const r of body) db.rows.set(r.id, r);
  } else {
    assert.match(init.headers.prefer, /ignore-duplicates/);
    for (const r of body) if (!db.volume.has(r.ts)) db.volume.set(r.ts, r);
  }
  return new Response(null, { status: 201 });
}

// ---- monitor ----

const ENV = { CASER_REFRESH_TOKEN: 'r0', CASER_BASE: 'https://caser.test', SUPABASE_URL: 'https://db.supabase.test', SUPABASE_SECRET_KEY: 'sb_secret_test' };

async function startMonitor(w, env, clock, budgetN = 12) {
  let budget = budgetN;
  const m = await createMonitor({
    env,
    fetch: async (url, init) => {
      if (!String(url).includes('supabase.test') && --budget === 0) m.stop();
      return w.fetch(url, init);
    },
    version: 'test',
    log: () => {},
    now: clock.now,
    sleep: async (ms) => clock.advance(ms),
  });
  return m;
}

test('monitor: sends rows, volume and its status to Supabase, keeps tokens and salt across restarts', async () => {
  const dir = await tmp();
  try {
    let t = T0;
    const clock = { now: () => t, advance: (ms) => (t += ms) };
    const w = fakeWorld(() => t);
    const env = { ...ENV, DATA_DIR: dir };
    const first = await startMonitor(w, env, clock);
    assert.equal(first.config.gapMs, 8000);
    assert.equal(first.config.retentionDays, 30);
    assert.equal((await first.run()).error, null);
    assert.deepEqual([...w.db.rows.keys()].sort(), ['case:9', 'upgrade:7']);
    const row = w.db.rows.get('upgrade:7');
    assert.match(row.u, /^[0-9a-f]{16}$/);
    assert.equal(row.back, true);
    assert.ok(w.db.volume.size >= 1);
    assert.equal(w.db.status.id, 1);
    assert.equal(w.db.status.status.running, false, 'the final report says it stopped');
    assert.equal(w.db.status.status.version, 'test');
    assert.ok(w.db.deletes.some((d) => d.startsWith('monitor_rows?ts=lt.')), 'old rows are pruned');
    const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    assert.equal(state.tokens.refresh, `r${w.issued}`);
    assert.equal(state.pendingRows.length, 0);
    // Real player ids stay in the local state (for revisits) and never reach Supabase.
    assert.deepEqual(state.collector.known.map((k) => k.id), ['42']);
    const sent = JSON.stringify({ rows: [...w.db.rows.values()], events: w.db.events, status: w.db.status, private: w.db.private });
    assert.ok(!sent.includes('"42"') && !sent.includes(':42,') && !sent.includes(':42}'), 'no player ids in Supabase');
    assert.ok(w.db.events.some((e) => e.code === 'start'), 'the start is logged');
    assert.equal(w.db.private.alert_url, '', 'no alert URL set');
    assert.equal(state.alive, true, 'still marked alive until shutdown()');
    await first.shutdown();
    assert.equal(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).alive, false);

    t += 20 * 60000; // the saved access token has run out
    const issued = w.issued;
    const second = await startMonitor(w, env, clock);
    assert.equal(second.state.salt, state.salt);
    await second.run();
    assert.equal(w.issued, issued + 1, 'the rotated refresh token still works');

    w.refreshTokens.add('fresh');
    const third = await startMonitor(w, { ...env, CASER_REFRESH_TOKEN: 'fresh' }, clock);
    assert.equal(third.state.tokens.refresh, 'fresh', 'a new env token replaces the saved one');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('monitor: rows wait on disk while Supabase is down and go out on the next try', async () => {
  const dir = await tmp();
  try {
    let t = T0;
    const clock = { now: () => t, advance: (ms) => (t += ms) };
    const w = fakeWorld(() => t);
    w.db.fail = 100;
    const m = await startMonitor(w, { ...ENV, DATA_DIR: dir }, clock);
    await m.run();
    assert.equal(w.db.rows.size, 0);
    const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    assert.equal(state.pendingRows.length, 2, 'kept for later');
    w.db.fail = 0;
    await m.flush();
    assert.equal(w.db.rows.size, 2);
    assert.equal(m.state.pendingRows.length, 0);
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
    const m = await startMonitor(w, { ...ENV, CASER_REFRESH_TOKEN: 'gone', DATA_DIR: dir }, { now: () => t, advance: (ms) => (t += ms) }, 100);
    assert.match((await m.run()).error, /login/);
    assert.deepEqual(w.calls, ['POST /api/users/auth/refresh']);
    assert.match(w.db.status.status.error, /login/, 'the dashboard learns why');
    assert.ok(w.db.events.some((e) => e.code === 'login' && e.level === 'error'), 'logged as an event');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('monitor: refuses to start without a token or a Supabase key', async () => {
  const dir = await tmp();
  try {
    await assert.rejects(createMonitor({ env: { DATA_DIR: dir, SUPABASE_SECRET_KEY: 'k' }, fetch: async () => {}, version: 't', log: () => {} }), /CASER_REFRESH_TOKEN/);
    await assert.rejects(createMonitor({ env: { DATA_DIR: dir, CASER_REFRESH_TOKEN: 'r' }, fetch: async () => {}, version: 't', log: () => {} }), /SUPABASE_SECRET_KEY/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- cloud ----

test('cloud: batches inserts, sends a legacy JWT key as Authorization too', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(null, { status: 201 });
  };
  const rows = Array.from({ length: 2500 }, (_, i) => ({ id: `upgrade:${i}`, kind: 'upgrade', ts: T0, u: 'h', stake: 1, returned: 0, chance: null, back: false }));
  await createCloud({ fetch, url: 'https://x.supabase.co/', key: 'sb_secret_abc' }).push(rows, []);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'https://x.supabase.co/rest/v1/monitor_rows?on_conflict=id');
  assert.equal(calls[0].init.headers.authorization, undefined);
  calls.length = 0;
  await createCloud({ fetch, url: 'https://x.supabase.co', key: 'eyJhbGciOi.x.y' }).status({ running: true });
  assert.equal(calls[0].init.headers.authorization, 'Bearer eyJhbGciOi.x.y');
  const failing = createCloud({ fetch: async () => json(401, { message: 'Invalid API key' }), url: 'https://x.supabase.co', key: 'bad' });
  await assert.rejects(failing.push(rows.slice(0, 1), []), /401.*Invalid API key/);
});

// ---- dashboard ----

test('dashboard view: windows, comparison, heat map and tables from the report', () => {
  const now = T0 + 25 * 60000;
  const spec = rangeSpec('24h', now, 15);
  const W = 15 * 60000;
  assert.equal(spec.window, W);
  assert.equal(spec.to, Math.floor(now / W) * W + W);
  assert.equal(spec.coarse.bucket, HOUR);
  assert.equal(rangeSpec('nope', now).key, '24h');
  assert.deepEqual(windowsFor('30d'), [60, 120, 360, 1440]);
  assert.equal(pickWindow('30d', 15), 360, 'the range default');
  assert.deepEqual(windowsFor('30m'), [1, 2, 5, 10]);
  assert.equal(pickWindow('30m', 15), 1);
  assert.equal(pickWindow('1h', 5), 5);
  // The comparison report: 5-minute steps over the glance's 6 hours plus the longest compared part.
  const cs = compareSpec(now, 30);
  assert.equal(cs.bucket, STEP);
  assert.equal(cs.to, Math.floor(now / STEP) * STEP + STEP);
  assert.equal(cs.to - cs.from, 7 * HOUR);
  assert.equal(pickWindow('6h', 20), 20);
  // Arrival lag: measured once enough rows have it, else assumed; at least one step, at most 2 hours.
  assert.equal(settledAt(null, now).lagMs, DEFAULT_LAG);
  assert.equal(settledAt({ rows: 50, p80: 60000 }, now).known, false);
  assert.equal(settledAt({ rows: 500, p50: 30000, p80: 60000 }, now).lagMs, STEP);
  assert.equal(settledAt({ rows: 500, p50: 30000, p80: 9 * HOUR }, now).lagMs, 2 * HOUR);
  assert.equal(settledAt({ rows: 500, p50: 30000, p80: 60000 }, now).at, Math.floor((now - STEP) / STEP) * STEP);
  // Shapes as monitor_report sends them (some numbers as strings, empty sums as null). Normal ("ea") expects 8 wins, the shown chances 10.
  const up = (bucket, w, extra = {}) => ({ bucket, kind: 'upgrade', n: 40, players: 10, up: 4, sx: '400', sy: 380, gxx: 16000, gyy: 15000, gxy: 15000, nw: 40, w, ew: 10, vw: 8, ea: 8, va: 6, nh: 0, h: null, eh: null, vh: null, ...extra });
  const phaseRow = { phase: 1, cg: 1, n: 100, players: 9, sx: 1000, sy: 1100, w: 30, ew: 20, vw: 16, ea: 25, va: 18 };
  const report = {
    series: [up(spec.to - 3 * W, 12), up(spec.to - 2 * HOUR, 8), up(spec.to - W, 8)],
    heat: [{ dow: 4, hour: 13, kind: 'upgrade', n: 40, sx: 400, sy: 380, nw: 40, w: 12, ew: 10, vw: 8, ea: 8, va: 6, nh: 0, h: null, eh: null, vh: null }],
    bands: [{ band: 'b', n: 100, players: 9, sx: 1000, sy: 950, w: 25, ew: 20, vw: 16, ea: 25, va: 18 }],
    phases: [phaseRow],
    phases_norm: [{ phase: 1, cg: 1, n: 1000, w: 250, ew: 200 }],
    cases: [{ slug: 'magnum', n: 50, players: 7, sx: 950, sy: 900, h: 20, eh: 17.5, vh: 11, price: 19 }],
    stakes: [{ kind: 'case', sb: 2, n: 50, players: 7, sx: 950, sy: 900, nw: 0, w: null, ew: null, vw: null, nh: 50, h: 20, eh: 17.5, vh: 11 }],
    totals: [{ kind: 'upgrade', players: 12, up: 5 }],
    excluded: [{ kind: 'upgrade', n: 7 }],
    lag: { rows: 500, p50: 30000, p80: 60000 },
  };
  const settled = settledAt(report.lag, now).at;
  // The 30 minutes before the settled time win 11 of 8 normal per step; the 90 before, 8 of 8.
  const cmpSeries = [];
  for (let t = cs.from; t < cs.to; t += STEP) {
    if (t >= settled) continue;
    cmpSeries.push(up(t, t >= settled - 30 * 60000 ? 11 : 8, { n: 50, nw: 50 }));
  }
  const cmp = { series: cmpSeries, phases: [phaseRow] };
  const v = buildReport({ report, cmp, compareMinutes: 30, volume: [{ bucket: String(spec.coarse.to - HOUR), samples: '60', cases_per_min: '9000.5', upgrades_per_min: '6000', online: '2500' }], spec, now });
  const k = v.kinds.upgrade;
  assert.equal(k.windows.length, 96);
  const at = (t) => k.windows.find((w) => w.start === t);
  assert.equal(at(spec.to - 3 * W).index.index, 1.5, 'against normal');
  assert.equal(at(spec.to - 3 * W).shown.index, 1.2, 'against the shown chances');
  assert.equal(at(spec.to - 3 * W).provisional, false);
  assert.equal(k.windows.at(-1).provisional, true, 'the current window is still arriving');
  assert.equal(k.avg.index, 28 / 24);
  assert.equal(k.shownAvg.index, 28 / 30);
  assert.equal(k.best[0].start, spec.to - 3 * W, 'the best settled window; the provisional one is left out');
  assert.ok(!k.best.some((w) => w.provisional));
  assert.equal(k.worst[0].start, spec.to - 2 * HOUR);
  assert.ok(at(spec.to - 3 * W).smooth != null);
  assert.equal(k.money.ratio, 0.95);
  // Against normal over the 30 minutes before the settled time: 66 wins where 48 are normal, z = 3.
  assert.equal(v.compare.upgrade.to, settled);
  assert.equal(v.compare.upgrade.index, 66 / 48);
  assert.equal(v.compare.upgrade.verdict, 'better');
  assert.equal(v.compare.upgrade.base.index, 1);
  assert.equal(v.compare.upgrade.before.verdict, 'better');
  assert.equal(v.compare.case.verdict, 'few');
  // Glance: one point per step over 6 hours; the one at the settled time is the compared part.
  const g = v.glance.upgrade;
  assert.equal(g.points.length, 6 * 12 + 1);
  assert.equal(g.points.find((p) => p.t === settled).index, 66 / 48);
  assert.equal(g.points.at(-1).provisional, true);
  assert.equal(g.points.find((p) => p.t === settled).provisional, false);
  assert.equal(v.heat.upgrade[3][13].index.index, 1.5);
  assert.equal(v.hours.upgrade[13].index.index, 1.5);
  assert.equal(v.hours.upgrade[12].index.index, null);
  assert.equal(v.bands[0].label, '10–15%');
  assert.equal(v.bands[0].winRate, 0.25);
  assert.equal(v.bands[0].index.index, 1.25);
  assert.equal(v.bands[0].normal.index, 1);
  // Session phase x chance group.
  const first = v.phases.find((r) => r.phase === 1).cells[0];
  assert.equal(first.shown.index, 1.5);
  assert.equal(first.normal.index, 1.2);
  assert.equal(first.usual.index, 1.25);
  assert.equal(v.phases.find((r) => r.phase === 2).cells[0].n, 0);
  assert.equal(v.fresh.now.index, 1.5);
  assert.equal(v.fresh.usual.index, 1.25);
  assert.deepEqual(v.excluded, { upgrade: 7, case: 0 });
  assert.equal(v.settled.known, true);
  // A report without "ea" (an older database function) falls back to the shown chances.
  const old = buildReport({ report: { series: [up(spec.to - 3 * W, 12, { ea: null, va: null })] }, cmp: {}, spec, now });
  assert.equal(old.kinds.upgrade.windows.find((w) => w.start === spec.to - 3 * W).index.index, 1.2);
  assert.equal(againstNormal({ n: 100, obs: 30, exp: 20, se: 0.2, index: 1.5 }).verdict, 'better');
  assert.equal(againstNormal({ n: 100, obs: 24, exp: 20, se: 0.2, index: 1.2 }).verdict, 'same');
  assert.equal(againstNormal({ n: 10, obs: 3, exp: 2, se: 0.5, index: 1.5 }).verdict, 'few');
  assert.equal(againstNormal({ n: 100, obs: 30, exp: 20, se: 0.2, index: 1.5 }).z, 2.5);
  assert.equal(v.cases[0].hitRate, 0.4);
  assert.equal(v.cases[0].index.index, 20 / 17.5);
  assert.equal(v.stakes[0].index.index, 20 / 17.5);
  assert.deepEqual(v.totals.upgrade, { players: 12, up: 5 });
  assert.equal(v.volume.buckets.length, 24);
  assert.equal(v.volume.buckets.at(-1).casesPerMin, 9000.5);
  assert.equal(v.volume.buckets[0].casesPerMin, null);
});

test('stats: win and hit index with a binomial range, and its comparison', () => {
  const ix = indexOf({ n: 100, obs: 30, exp: 25, v: 18 });
  assert.equal(ix.index, 1.2);
  assert.ok(Math.abs(ix.se - Math.sqrt(18) / 25) < 1e-12);
  assert.equal(indexOf({ n: 0, obs: 0, exp: 0, v: 0 }).index, null);
  assert.equal(compareIndex({ n: 100, obs: 40, exp: 25, v: 18 }, { n: 300, obs: 75, exp: 75, v: 55 }).verdict, 'better');
  assert.equal(compareIndex({ n: 100, obs: 26, exp: 25, v: 18 }, { n: 300, obs: 75, exp: 75, v: 55 }).verdict, 'same');
  assert.equal(compareIndex({ n: 10, obs: 9, exp: 2, v: 1.6 }, { n: 300, obs: 75, exp: 75, v: 55 }).verdict, 'few');
});

test('dashboard view: monitor health from its last report', () => {
  const now = T0;
  const at = (ms) => new Date(now - ms).toISOString();
  assert.equal(monitorHealth(null, now).level, 'warn');
  assert.equal(monitorHealth({ updated_at: at(60000), status: { running: true } }, now).level, 'ok');
  assert.equal(monitorHealth({ updated_at: at(10 * 60000), status: { running: true } }, now).level, 'bad');
  assert.match(monitorHealth({ updated_at: at(60000), status: { running: false, error: 'signed out?' } }, now).text, /signed out/);
  assert.equal(monitorHealth({ updated_at: at(60000), status: { running: true, pausedUntil: now + 60000 } }, now).level, 'warn');
  assert.equal(monitorHealth({ updated_at: at(60000), status: { running: true, cloudError: 'x' } }, now).level, 'warn');
  assert.equal(monitorHealth({ updated_at: at(60000), status: { running: true, errorStreak: 6, error: 'fetch failed' } }, now).level, 'warn');
});

test('dashboard page: its script parses', async () => {
  const { spawnSync } = await import('node:child_process');
  const { writeFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../dashboard/index.html', import.meta.url), 'utf8');
  const script = html.match(/<script type="module">([\s\S]*)<\/script>/)?.[1];
  assert.ok(script, 'module script found');
  const dir = await tmp();
  try {
    const file = join(dir, 'page.mjs');
    await writeFile(file, script);
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- collector: history, revisits, page size, errors ----

/** A site whose history lists page by limit/offset, newest first, with an optional page size cap. */
function pagedSite({ upgrades = 0, cases = 0, stepMs = 30 * 60000, cap = Infinity, refuseOver = Infinity } = {}) {
  const site = { calls: [], ups: [], inv: [], feed: { liveDrops: [{ user: { id: '7' }, item: { marketName: 'W' } }] }, fail: null };
  for (let i = 0; i < upgrades; i++) site.ups.push(upRow(i, T0 - i * stepMs, 10, i % 4 === 0));
  for (let i = 0; i < cases; i++) site.inv.push(caseRow(1000 + i, T0 - i * stepMs, 'magnum', 9));
  site.getJson = async (path) => {
    site.calls.push(path);
    if (site.fail) throw site.fail;
    const [p, q] = path.split('?');
    const qs = new URLSearchParams(q ?? '');
    const limit = Number(qs.get('limit'));
    if (limit > refuseOver) throw new HttpError(400, p);
    const off = Number(qs.get('offset'));
    const page = (list) => ({ items: list.slice(off, off + Math.min(limit, cap)) });
    if (p === '/api/game/cases') return { cases: [{ id: '1', slug: 'magnum', price: '19' }] };
    if (p === '/api/live-drops') return site.feed;
    if (p === '/api/statistics') return { cases_opened: 1, upgrader_count: 1, online: 1 };
    if (/^\/api\/users\/[^/]+\/stats$/.test(p)) return { withdrawnAmount: 0, upgradesMade: site.ups.length, casesOpened: site.inv.length };
    if (p.startsWith('/api/game/upgrade/public-history/')) return page(site.ups);
    if (p.startsWith('/api/users/')) return page(site.inv);
    throw new HttpError(404, p);
  };
  return site;
}

function run(site, { budget, options = {}, initial } = {}) {
  let t = T0;
  const saved = [];
  const events = [];
  let left = budget;
  const c = createCollector({
    getJson: async (p) => {
      if (--left === 0) c.stop();
      return site.getJson(p);
    },
    hashUser: async (id) => `h${id}`,
    saveRows: async (rows) => saved.push(...rows),
    saveVolume: async () => {},
    onEvent: (e) => events.push(e),
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    initial,
    options: { gapMs: 1000, ...options },
  });
  return { c, saved, events, now: () => t, done: c.start() };
}

test('collector: reads a found player history back 7 days with larger pages when the site allows them', async () => {
  // 600 upgrades every 30 min = 12.5 days; 7 days = 337 rows.
  const site = pagedSite({ upgrades: 600, cases: 3 });
  const { c, saved, events, done } = run(site, { budget: 40 });
  await done;
  const ups = saved.filter((r) => r.kind === 'upgrade');
  assert.ok(site.calls.some((p) => p.includes('limit=100')), 'asked for 100 rows');
  assert.ok(events.some((e) => e.code === 'page-size' && /100/.test(e.message)));
  assert.equal(c.status().pageSize, 100);
  assert.ok(ups.length >= 330 && ups.length <= 337, `about 7 days of rows (${ups.length})`);
  assert.ok(ups.every((r) => r.ts >= T0 - 7 * 24 * 3600e3));
  assert.equal(new Set(ups.map((r) => r.id)).size, ups.length, 'no row twice');
  const offsets = site.calls.filter((p) => p.includes('public-history')).map((p) => Number(new URLSearchParams(p.split('?')[1]).get('offset')));
  assert.deepEqual(offsets.slice(0, 4), [0, 100, 200, 300], 'pages follow each other');
  assert.deepEqual(c.exportState().known.map((k) => k.id), ['7']);
  assert.equal(c.exportState().pageProbe, 'ok');
});

test('collector: falls back to 50-row pages when the site caps or refuses larger ones', async () => {
  for (const [opts, probe] of [[{ cap: 50 }, 'capped'], [{ refuseOver: 50 }, 'refused']]) {
    const site = pagedSite({ upgrades: 200, ...opts });
    const { c, done } = run(site, { budget: 12 });
    await done;
    assert.equal(c.status().pageSize, 50, probe);
    assert.equal(c.exportState().pageProbe, probe);
    const later = site.calls.filter((p) => p.includes('public-history')).slice(-1)[0];
    assert.match(later, /limit=50/);
  }
  // The decision is kept across restarts.
  const site = pagedSite({ upgrades: 10 });
  const { c, done } = run(site, { budget: 6, initial: { pageProbe: 'capped', pageSize: 50 } });
  await done;
  assert.ok(site.calls.filter((p) => p.includes('limit=')).every((p) => p.includes('limit=50')));
  assert.equal(c.status().pageSize, 50);
});

test('collector: revisits a known player after the revisit time, only for rows newer than the last seen', async () => {
  const site = pagedSite({ upgrades: 5 });
  site.feed = { liveDrops: [] };
  const initial = { profileProbed: true, known: [{ id: '7', seen: T0, revisited: T0 - 4 * 3600e3, newest: { upgrade: T0 - 2 * 30 * 60000, case: 0 }, deep: true, ctr: { upgrade: 3, case: 0 } }] };
  const { c, saved, done } = run(site, { budget: 6, initial });
  await done;
  // Rows 0 and 1 are newer than the last seen (row 2's time); nothing older comes back.
  assert.deepEqual(saved.filter((r) => r.kind === 'upgrade').map((r) => r.id).sort(), ['upgrade:0', 'upgrade:1']);
  assert.ok(c.exportState().known[0].revisited >= T0, 'marked as revisited');
  assert.ok(site.calls.includes('/api/users/7/stats'), 'not playing now: counters first');
  assert.ok(!site.calls.some((p) => p.includes('/inventory/history') && /offset=0\b/.test(p)), 'the case counter did not move, so that list is not checked for new rows');
  assert.deepEqual(c.exportState().known[0].ctr, { upgrade: 5, case: 0 });
});

const DAY_MS = 24 * 3600e3;
const quietPlayer = (id, played, revisited, ctr) => ({ id, seen: played, revisited, newest: { upgrade: played, case: played }, hist: { upgrade: null, case: null }, ctr });

test('collector: a quiet player whose counters did not move costs one request; a moved counter reads only its list', async () => {
  const site = pagedSite({ upgrades: 3, cases: 2 });
  site.feed = { liveDrops: [] };
  const still = run(site, { budget: 4, initial: { profileProbed: true, known: [quietPlayer('q', T0 - 2 * DAY_MS, T0 - 7 * 3600e3, { upgrade: 3, case: 2 })] } });
  await still.done;
  assert.equal(site.calls.at(-1), '/api/users/q/stats');
  assert.ok(!site.calls.some((p) => /history/.test(p)), 'no list read');
  assert.equal(still.c.status().counterChecks, true);

  site.calls.length = 0;
  const moved = run(site, { budget: 5, initial: { profileProbed: true, known: [quietPlayer('q', T0 - 2 * DAY_MS, T0 - 7 * 3600e3, { upgrade: 3, case: 1 })] } });
  await moved.done;
  assert.ok(site.calls.some((p) => p.includes('/api/users/q/inventory/history')), 'case list read');
  assert.ok(!site.calls.some((p) => p.includes('public-history')), 'upgrade list not read');
  assert.equal(moved.saved.filter((r) => r.kind === 'case').length, 2);
});

test('collector: the first counter check only sets the base', async () => {
  const site = pagedSite({ upgrades: 3 });
  site.feed = { liveDrops: [] };
  const { c, done } = run(site, { budget: 5, initial: { profileProbed: true, known: [quietPlayer('q', T0 - 2 * DAY_MS, T0 - 7 * 3600e3)] } });
  await done;
  assert.ok(site.calls.includes('/api/users/q/stats'));
  assert.ok(!site.calls.some((p) => /history/.test(p)));
  assert.deepEqual(c.exportState().known[0].ctr, { upgrade: 3, case: 0 });
});

test('collector: cold tiers by recency, and the most overdue for its tier goes first', async () => {
  const site = pagedSite({ upgrades: 1 });
  site.feed = { liveDrops: [] };
  const ctr = { upgrade: 1, case: 0 };
  const known = [
    quietPlayer('stale', T0 - 10 * DAY_MS, T0 - 25 * 3600e3, ctr), // 24 h tier, 25 h ago: 1.04 times its interval
    quietPlayer('cold', T0 - 2 * DAY_MS, T0 - 7 * 3600e3, ctr), // 6 h tier, 7 h ago: 1.17 times
    quietPlayer('later', T0 - 10 * DAY_MS, T0 - 20 * 3600e3, ctr), // 24 h tier, not due
  ];
  const { c, done } = run(site, { budget: 6, initial: { profileProbed: true, known } });
  await done;
  const order = site.calls.filter((p) => p.endsWith('/stats')).map((p) => p.split('/')[3]);
  assert.deepEqual(order, ['cold', 'stale']);
  assert.equal(c.status().revisitsDue, 0);
});

test('collector: reports counters that said "no new play" when the list later shows some', async () => {
  const site = pagedSite({ upgrades: 3 });
  site.feed = { liveDrops: [] };
  const orig = site.getJson;
  let checks = 0;
  // The first check still shows the old counter although three rows are newer than the last seen.
  site.getJson = async (p) => (p.endsWith('/stats') && ++checks === 1 ? { upgradesMade: 0, casesOpened: 0 } : orig(p));
  const initial = { profileProbed: true, known: [quietPlayer('q', T0 - 2 * DAY_MS, T0 - 7 * 3600e3, { upgrade: 0, case: 0 })] };
  const { c, events, done } = run(site, { budget: 7, initial, options: { revisitColdMs: 5000 } });
  await done;
  assert.ok(site.calls.some((p) => p.includes('public-history/q')), 'list read after the counter moved');
  const e = events.find((x) => x.code === 'counters');
  assert.ok(e && e.level === 'warn', 'reported');
  assert.match(e.message, /2 upgrade row/, 'the row from the check time itself is within the slack');
  assert.equal(c.status().counterMisses, 1);
});

test('collector: the feed is read less often while it brings no players to look at, and at once again when it does', async () => {
  const site = pagedSite({ upgrades: 1 });
  const feedTimes = [];
  let clock = () => 0;
  const orig = site.getJson;
  site.getJson = async (p) => {
    if (p === '/api/live-drops') {
      feedTimes.push(clock());
      // From the 7th read on, two players the monitor has not seen.
      if (feedTimes.length === 7) site.feed = { liveDrops: ['n1', 'n2'].map((id) => ({ user: { id }, item: { marketName: 'W' } })) };
    }
    return orig(p);
  };
  // Reads 1-6 show the same player: the first queues them (one player keeps 30 s), the rest add nobody.
  const r = run(site, { budget: 60, initial: { profileProbed: true } });
  clock = r.now;
  await r.done;
  const gaps = feedTimes.slice(1).map((x, i) => Math.round((x - feedTimes[i]) / 1000));
  const want = [30, 45, 68, 90, 90, 90, 30];
  assert.ok(gaps.length >= want.length, `feed read ${feedTimes.length} times`);
  // Turns are about a second long here, so a read can come a few seconds after it is due.
  want.forEach((w, i) => assert.ok(gaps[i] >= w && gaps[i] <= w + 4, `gap ${i + 1}: ${gaps[i]} s, want about ${w} s`));
  assert.ok([30_000, 45_000, 68_000, 90_000].includes(r.c.status().feedEveryMs));
});

test('collector: falls back to reading lists when stats lose their counters', async () => {
  const site = pagedSite({ upgrades: 2, cases: 1 });
  site.feed = { liveDrops: [] };
  const orig = site.getJson;
  site.getJson = async (p) => (p.endsWith('/stats') ? { withdrawnAmount: 1 } : orig(p));
  const initial = { profileProbed: true, known: [quietPlayer('q', T0 - 2 * DAY_MS, T0 - 7 * 3600e3, { upgrade: 0, case: 0 })] };
  const { c, events, done } = run(site, { budget: 6, initial });
  await done;
  assert.ok(events.some((e) => e.code === 'counters'));
  assert.equal(c.status().counterChecks, false);
  assert.ok(site.calls.some((p) => p.includes('public-history/q')) && site.calls.some((p) => p.includes('/api/users/q/inventory/history')));
});

test('collector: a run of failed turns is reported once, and so is the recovery', async () => {
  const site = pagedSite({ upgrades: 1 });
  site.fail = new Error('fetch failed');
  let calls = 0;
  const orig = site.getJson;
  site.getJson = async (p) => {
    if (++calls === 7) site.fail = null;
    return orig(p);
  };
  const { c, events, done } = run(site, { budget: 10, options: { errorStreak: 5 } });
  await done;
  const codes = events.map((e) => e.code);
  assert.equal(codes.filter((x) => x === 'errors').length, 1);
  assert.ok(codes.includes('recovered'));
  assert.equal(c.status().errorStreak, 0);
});

test('collector: HTTP 403 stops with a block reason', async () => {
  const site = pagedSite({ upgrades: 1 });
  site.fail = new HttpError(403, '/api/game/cases');
  const { c, events, done } = run(site, { budget: 50 });
  await done;
  assert.equal(c.status().stopReason, 'blocked');
  assert.equal(events.at(-1).code, 'blocked');
  assert.equal(site.calls.length, 1, 'nothing after the block');
});

// ---- alerts ----

test('alerts: request format per service', () => {
  const d = alertRequest('https://discord.com/api/webhooks/1/abc', 'T', 'M');
  assert.deepEqual(d, { url: 'https://discord.com/api/webhooks/1/abc', body: { content: 'T\nM' } });
  const t = alertRequest('https://api.telegram.org/bot123:XYZ/sendMessage?chat_id=-100', 'T', 'M');
  assert.deepEqual(t, { url: 'https://api.telegram.org/bot123:XYZ/sendMessage', body: { chat_id: '-100', text: 'T\nM' } });
  const n = alertRequest('https://ntfy.sh/my-topic', 'T', 'M');
  assert.deepEqual(n, { url: 'https://ntfy.sh/', body: { topic: 'my-topic', title: 'T', message: 'M', priority: 4 } });
  const o = alertRequest('https://example.test/hook', 'T', 'M');
  assert.deepEqual(o.body, { title: 'T', text: 'M' });
});

test('alerts: the same problem is sent at most once per quiet time, unless forced; failures do not throw', async () => {
  let t = T0;
  const sent = [];
  const okFetch = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(null, { status: 204 });
  };
  const n = createNotifier({ fetch: okFetch, url: 'https://ntfy.sh/x', now: () => t, log: () => {} });
  assert.equal(await n.send('paused', 'T', 'a'), true);
  assert.equal(await n.send('paused', 'T', 'b'), false);
  assert.equal(await n.send('login', 'T', 'c'), true);
  assert.equal(await n.send('paused', 'T', 'd', { force: true }), true);
  t += 31 * 60000;
  assert.equal(await n.send('paused', 'T', 'e'), true);
  assert.deepEqual(sent.map((b) => b.message), ['a', 'c', 'd', 'e']);
  const offline = async () => {
    throw new Error('offline');
  };
  assert.equal(await createNotifier({ fetch: offline, url: 'https://ntfy.sh/x', log: () => {} }).send('x', 'T', 'M'), false);
  assert.equal(await createNotifier({ fetch: offline, url: null }).send('x', 'T', 'M'), false);
});

test('monitor: alerts on a stop, confirms alert setup once, and reports a restart after a hard kill', async () => {
  const dir = await tmp();
  try {
    let t = T0;
    const clock = { now: () => t, advance: (ms) => (t += ms) };
    const w = fakeWorld(() => t);
    const alerts = [];
    const env = { ...ENV, DATA_DIR: dir, ALERT_URL: 'https://ntfy.sh/pulse-test' };
    let m;
    const make = async (budget) => {
      let left = budget;
      m = await createMonitor({
        env,
        fetch: async (url, init) => {
          if (String(url).startsWith('https://ntfy.sh/')) {
            alerts.push(JSON.parse(init.body));
            return new Response(null, { status: 200 });
          }
          if (!String(url).includes('supabase.test') && --left === 0) m.stop();
          return w.fetch(url, init);
        },
        version: 'test',
        log: () => {},
        now: clock.now,
        sleep: async (ms) => clock.advance(ms),
      });
      return m;
    };
    await (await make(6)).run();
    assert.equal(w.db.private.alert_url, 'https://ntfy.sh/pulse-test', 'the watchdog gets the URL');
    assert.equal(alerts.filter((a) => /set up/.test(a.title)).length, 1, 'setup message once');
    // No shutdown(): like a killed container. The next start says so, and setup is not sent again.
    await (await make(6)).run();
    assert.ok(alerts.some((a) => /without shutting down/.test(a.message)));
    assert.equal(alerts.filter((a) => /set up/.test(a.title)).length, 1);
    await m.shutdown();
    // The login dies: an error event and an alert.
    w.refreshTokens.clear();
    w.access.clear();
    t += 20 * 60000;
    await make(50);
    assert.match((await m.run()).error, /login/);
    assert.ok(alerts.some((a) => /refused the account/.test(a.message)));
    assert.ok(w.db.events.some((e) => e.code === 'login'));
    // A crash is remembered and logged on the next start.
    await m.shutdown({ crash: 'TypeError: boom' });
    w.refreshTokens.add('again');
    env.CASER_REFRESH_TOKEN = 'again';
    await (await make(4)).run();
    assert.ok(w.db.events.some((e) => e.code === 'restarted' && /boom/.test(e.message)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('collector: players playing now are revisited first and often, quiet ones rarely', async () => {
  const site = pagedSite({ upgrades: 3 });
  site.feed = { liveDrops: [] };
  const M = 60000;
  const initial = {
    profileProbed: true,
    known: [
      { id: 'quiet', seen: T0 - 2 * 24 * 3600e3, revisited: T0 - 3600e3, newest: { upgrade: T0 - 2 * 24 * 3600e3, case: 0 }, hist: { upgrade: null, case: null } },
      { id: 'warm', seen: T0 - 3600e3, revisited: T0 - 40 * M, newest: { upgrade: T0 - 2 * 3600e3, case: 0 }, hist: { upgrade: null, case: null }, ctr: { upgrade: 0, case: 0 } },
      { id: 'hot', seen: T0 - 3600e3, revisited: T0 - 15 * M, newest: { upgrade: T0 - 10 * M, case: 0 }, hist: { upgrade: null, case: null } },
    ],
  };
  const { c, done } = run(site, { budget: 12, initial });
  await done;
  const order = site.calls.filter((p) => p.includes('public-history')).map((p) => p.split('/').pop().split('?')[0]);
  assert.deepEqual(order.slice(0, 2), ['hot', 'warm'], 'playing now first, then recently');
  assert.ok(!order.includes('quiet'), 'not due yet');
  assert.equal(c.status().activeNow, 2, 'hot, and warm once its revisit found a row from now');
  assert.equal(c.exportState().profileProbed, true);
});

test('collector: probes profile field names once, and a refused profile does not stop it', async () => {
  const site = pagedSite({ upgrades: 1 });
  site.feed = { liveDrops: [] };
  const orig = site.getJson;
  site.getJson = async (p) => {
    if (/^\/api\/users\/[^/]+$/.test(p)) return { user: { id: '7', nickname: 'secret-name', lastSeenAt: '2026-11-14T12:00:00Z' }, online: true };
    if (/\/stats$/.test(p)) throw new HttpError(403, p);
    return orig(p);
  };
  const initial = { known: [{ id: '7', seen: T0, revisited: T0, newest: { upgrade: T0, case: 0 }, deep: true }] };
  const { c, events, done } = run(site, { budget: 8, initial });
  await done;
  const e = events.find((x) => x.code === 'profile-fields');
  assert.ok(e, 'reported');
  assert.match(e.message, /user\.lastSeenAt/);
  assert.match(e.message, /online/);
  assert.ok(!e.message.includes('secret-name'), 'names only, never values');
  assert.match(e.message, /HTTP 403/);
  assert.equal(c.status().stopReason, null, '403 on the probe does not stop the collector');
  assert.equal(events.filter((x) => x.code === 'profile-fields').length, 1, 'once');
  assert.deepEqual(fieldNames({ a: 1, b: { c: 2 }, d: [1] }), ['a', 'b.c', 'd']);
});

test('collector: history keeps its share while followed players always have work, and resumes after a restart', async () => {
  const site = pagedSite({ upgrades: 600, cases: 3 });
  site.feed = { liveDrops: Array.from({ length: 12 }, (_, i) => ({ user: { id: `p${i}` }, item: { marketName: 'W' } })) };
  const deepCalls = () => site.calls.filter((p) => p.includes('public-history') && !/offset=0\b/.test(p));
  const options = { profileEveryMs: 1, revisitHotMs: 1 };
  const first = run(site, { budget: 80, options, initial: { profileProbed: true } });
  await first.done;
  const n = deepCalls().length;
  assert.ok(n >= 10, `history pages read while follows are busy (${n})`);
  const state = first.c.exportState();
  const p0 = state.known.find((k) => k.hist.upgrade && k.hist.upgrade.offset >= 100);
  assert.ok(p0, 'progress is saved');
  // A restart picks up where it stopped instead of starting over or forgetting.
  site.calls.length = 0;
  site.feed = { liveDrops: [] };
  const second = run(site, { budget: 20, options, initial: JSON.parse(JSON.stringify(state)) });
  await second.done;
  const resumed = deepCalls().find((p) => p.includes(`/${p0.id}?`));
  assert.ok(resumed, 'its history is read again after the restart');
  assert.equal(Number(new URLSearchParams(resumed.split('?')[1]).get('offset')), p0.hist.upgrade.offset);
});

test('collector: a state saved before 1.4 reads recent players history again', async () => {
  const site = pagedSite({ upgrades: 600 });
  site.feed = { liveDrops: [] };
  const initial = {
    profileProbed: true,
    known: [
      { id: 'old', seen: T0 - 9 * 24 * 3600e3, revisited: T0, newest: { upgrade: T0 - 9 * 24 * 3600e3, case: 0 }, deep: true },
      { id: 'recent', seen: T0, revisited: T0, newest: { upgrade: T0 - 3600e3, case: 0 }, deep: true },
    ],
  };
  const { c, done } = run(site, { budget: 4, initial });
  await done;
  const hist = site.calls.filter((p) => p.includes('public-history'));
  assert.ok(hist.length && hist.every((p) => p.includes('/recent?')), 'only the player who played in the last 7 days');
  assert.match(hist[0], /offset=50\b/);
  assert.equal(c.exportState().known.find((k) => k.id === 'old').hist.upgrade, null);
});
