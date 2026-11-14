import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { Context } from '../src/capture/parsers.js';
import { upgradeRows, caseRows, feedUserIds, feedDrops, volumeSample, hashUser } from '../src/pulse/rows.js';
import { aggregate, ratioOf, compareRatios, combine, volumeRates, pulseSummary, pulseWindows, HOUR } from '../src/pulse/stats.js';
import { createCollector, HttpError } from '../src/pulse/collector.js';

const T0 = Date.parse('2026-11-14T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

const upRow = (id, ms, stake, won, target = stake * 2) => ({
  id: String(id), status: won ? 'won' : 'lost', probability: String((stake / target) * 1.03), addedBalance: '0',
  betItems: [{ id: 'b', price: String(stake) }], targetItem: { id: 't', price: String(target) },
  wonItem: won ? { id: 't', price: String(target) } : null, createdAt: iso(ms),
});
const caseRow = (id, ms, slug, price) => ({
  id: String(id), action: 'won_case', price: String(price), createdAt: iso(ms),
  item: { id: 'i', marketName: 'X', price: String(price) }, source: { type: 'case', case: { slug } },
});

test('upgrade and case rows: settled only, anonymous, case price from the case list', () => {
  const ctx = new Context();
  ctx.learn({ method: 'GET', path: '/game/cases', status: 200, resBody: { cases: [{ id: '1', slug: 'magnum', price: '19' }] } });
  const ups = upgradeRows({ items: [upRow(1, T0, 10, true), upRow(2, T0, 10, false), { ...upRow(3, T0, 10, false), status: 'pending' }] }, ctx, 'h1');
  assert.deepEqual(ups.map((r) => [r.id, r.stake, r.returned, r.u]), [['upgrade:1', 10, 20, 'h1'], ['upgrade:2', 10, 0, 'h1']]);
  assert.ok(Math.abs(ups[0].chance - 51.5) < 1e-9);
  const unknown = new Set();
  const cs = caseRows({ items: [caseRow(5, T0, 'magnum', 7), caseRow(6, T0, 'gone', 3), { id: 7, action: 'sold' }] }, ctx, 'h1', { unknownSlugs: unknown });
  assert.deepEqual(cs.map((r) => [r.id, r.kind, r.stake, r.returned]), [['case:5', 'case', 19, 7]]);
  assert.deepEqual([...unknown], ['gone']);
  for (const r of [...ups, ...cs]) assert.deepEqual(Object.keys(r).sort(), ['back', 'chance', 'id', 'kind', 'returned', 'stake', 'ts', 'u']);
});

test('feed wins are skipped by item name, backfill rows are marked', () => {
  const ctx = new Context();
  ctx.learn({ method: 'GET', path: '/game/cases', status: 200, resBody: { cases: [{ id: '1', slug: 'magnum', price: '19' }] } });
  const win = { ...upRow(1, T0, 10, true, 100), targetItem: { id: 't', marketName: 'AWP | Asiimov', price: '100' } };
  const loss = { ...upRow(2, T0, 10, false, 100), targetItem: { id: 't', marketName: 'AWP | Asiimov', price: '100' } };
  const skip = new Set(['AWP | Asiimov', 'Knife']);
  const ups = upgradeRows({ items: [win, loss] }, ctx, 'h', { skip, back: true });
  assert.deepEqual(ups.map((r) => [r.id, r.back]), [['upgrade:2', true]], 'a loss on the same target is kept');
  const drop = { ...caseRow(5, T0, 'magnum', 7), item: { marketName: 'Knife', price: '7' } };
  assert.equal(caseRows({ items: [drop] }, ctx, 'h', { skip }).length, 0);
  const d = feedDrops({ liveDrops: [{ user: { id: '1' }, item: { marketName: 'A' } }, { user: { id: '1' }, item: { marketName: 'B' } }] });
  assert.deepEqual([...d.get('1')], ['A', 'B']);
});

test('feed ids and volume sample', () => {
  const body = { liveDrops: [{ user: { id: '941604' } }, { user: { id: 509926 } }], hotDrops: [{ user: { id: '941604' } }, { user: { id: 'bad id!' } }] };
  assert.deepEqual(feedUserIds(body), ['941604', '509926']);
  assert.deepEqual(volumeSample({ cases_opened: 10, upgrader_count: 5, users_count: 1, online: 3 }, T0), { ts: T0, cases: 10, upgrades: 5, online: 3 });
  assert.equal(volumeSample({}, T0), null);
});

test('hashUser is salted and stable', async () => {
  const a = await hashUser('941604', 'salt-a', webcrypto.subtle);
  assert.equal(a, await hashUser('941604', 'salt-a', webcrypto.subtle));
  assert.notEqual(a, await hashUser('941604', 'salt-b', webcrypto.subtle));
  assert.match(a, /^[0-9a-f]{16}$/);
});

test('aggregate and ratio: return per 1 staked with an interval clustered by player', () => {
  const rows = [];
  for (let p = 0; p < 10; p++) for (let i = 0; i < 10; i++) rows.push({ id: `${p}-${i}`, kind: 'upgrade', ts: T0 + i, u: `p${p}`, stake: 10, returned: i % 2 ? 19 : 0 });
  const [a] = aggregate(rows, { from: T0, to: T0 + HOUR, bucketMs: HOUR });
  assert.equal(a.n, 100);
  assert.equal(a.players, 10);
  const r = ratioOf(a);
  assert.ok(Math.abs(r.ratio - 0.95) < 1e-12);
  // Every player has the same total, so the clustered error is 0.
  assert.ok(r.se < 1e-9);
  assert.equal(ratioOf({ ...a, players: 3 }).ci, null, 'too few players for an interval');
  assert.equal(ratioOf(null).ratio, null);
});

test('compareRatios flags a clear change and stays quiet on noise', () => {
  const mk = (players, perPlayer, ret) => {
    const rows = [];
    for (let p = 0; p < players; p++) for (let i = 0; i < perPlayer; i++) rows.push({ id: `${p}-${i}`, kind: 'case', ts: T0, u: `p${p}`, stake: 10, returned: ret(p, i) });
    return combine(aggregate(rows, { from: T0, to: T0 + 1, bucketMs: 1 }), 'case');
  };
  const low = mk(20, 10, (p, i) => (i < 2 ? 30 : 2)); // 0.76
  const high = mk(20, 10, (p, i) => (i < 4 ? 30 : 2)); // 1.32
  assert.equal(compareRatios(high, low).verdict, 'better');
  assert.equal(compareRatios(low, high).verdict, 'worse');
  const noisy = mk(20, 10, (p, i) => ((p + i) % 5 === 0 ? 30 : 2));
  const noisy2 = mk(20, 10, (p, i) => ((p + i + 1) % 5 === 0 ? 30 : 2));
  assert.equal(compareRatios(noisy, noisy2).verdict, 'same');
  assert.equal(compareRatios(mk(2, 5, () => 10), low).verdict, 'few');
});

test('volume rates from counter samples', () => {
  const s = [0, 1, 2, 3].map((m) => ({ ts: T0 + m * 60000, cases: 1000 + m * 100, upgrades: 500 + m * 60, online: 10 + m }));
  const v = volumeRates(s, { from: T0, to: T0 + HOUR });
  assert.equal(v.casesPerMin, 100);
  assert.equal(v.upgradesPerMin, 60);
  assert.equal(v.online, 11.5);
  assert.equal(volumeRates(s.slice(0, 1), { from: T0, to: T0 + HOUR }).casesPerMin, null);
});

test('pulseSummary: windows, hours newest first', () => {
  const now = T0 + 30 * 60000;
  const w = pulseWindows(now);
  const rows = [{ id: 'a', kind: 'upgrade', ts: now - 10 * 60000, u: 'x', stake: 10, returned: 12 }];
  const one = (win) => aggregate(rows, { from: win.from, to: win.to, bucketMs: win.to - win.from });
  const s = pulseSummary({ recent: one(w.recent), base: one(w.base), day: one(w.day), hours: aggregate(rows, w.hours) }, [], now);
  assert.equal(s.hours.length, 24);
  assert.equal(s.hours[0].start, T0);
  assert.equal(s.hours[0].upgrade.n, 1);
  assert.equal(s.compare.upgrade.recent.ratio, 1.2);
  assert.equal(s.compare.upgrade.verdict, 'few');
});

// ---- collector ----

function fakeSite() {
  const site = {
    cases: { cases: [{ id: '1', slug: 'magnum', price: '19' }] },
    feed: { liveDrops: [{ user: { id: '42' } }], hotDrops: [] },
    ups: { 42: [] },
    inv: { 42: [] },
    calls: [],
    fail: null,
  };
  site.getJson = async (path) => {
    site.calls.push(path);
    if (site.fail) {
      const f = site.fail;
      site.fail = null;
      throw new HttpError(f, path);
    }
    const p = path.split('?')[0];
    if (p === '/api/game/cases') return site.cases;
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
  const volume = [];
  const c = createCollector({
    getJson: (p) => site.getJson(p),
    hashUser: async (id) => `h${id}`,
    saveRows: async (rows) => saved.push(...rows),
    saveVolume: async (v) => volume.push(v),
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    options: { gapMs: 1000, ...options },
  });
  return { c, saved, volume, advance: (ms) => (t += ms), now: () => t };
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
    // After the backfill: the player makes new upgrades and opens a case.
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
  assert.equal(by['upgrade:4'].back, false);
  assert.equal(by['case:11'].back, false);
  assert.equal(saved.length, 5, 'nothing is counted twice');
  assert.ok(saved.every((r) => r.u === 'h42'));
});

test('collector: 429 pauses and backs off, 401 stops', async () => {
  const site = fakeSite();
  const { c } = harness(site);
  site.fail = 429;
  let n = 0;
  const orig = site.getJson;
  site.getJson = async (p) => {
    n++;
    if (n === 1) {
      return orig(p); // consumes site.fail -> 429
    }
    if (n === 2) {
      const st = c.status();
      assert.ok(st.pausedUntil == null, 'pause is over before the next request');
      site.fail = 401;
    }
    return orig(p);
  };
  await c.start();
  const st = c.status();
  assert.equal(st.running, false);
  assert.match(st.error, /refused/);
  assert.equal(n, 2);
});

test('collector: the queue and the follow list are capped, players expire after the follow time', async () => {
  const site = fakeSite();
  site.feed = { liveDrops: Array.from({ length: 50 }, (_, i) => ({ user: { id: String(100 + i) }, item: { marketName: 'W' } })) };
  for (let i = 0; i < 50; i++) {
    site.ups[100 + i] = [upRow(i, T0 - 1000, 10, false)];
    site.inv[100 + i] = [];
  }
  const { c, advance } = harness(site, { maxPlayers: 5, maxQueue: 10 });
  let budget = 3 + 2 * 8; // cases, feed, statistics, then 8 backfills
  const orig = site.getJson;
  site.getJson = async (p) => {
    if (--budget === 0) c.stop();
    return orig(p);
  };
  await c.start();
  const st = c.status();
  assert.equal(st.players, 5);
  assert.ok(st.queued <= 10);
  advance(3 * HOUR);
  assert.equal(c.status().players, 0);
});
