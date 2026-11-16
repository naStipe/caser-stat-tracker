import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, encode, decode, cumulative, outlookModelLite, historyBase, VIEW_NAMES } from '../src/server/views.js';
import * as stats from '../src/stats/index.js';

const t0 = Date.UTC(2026, 9, 1, 12);

function up(i, userId = '1', extra = {}) {
  const won = i % 3 === 0;
  return { id: `u${i}`, kind: 'upgrade', ts: t0 + i * 60000, userId, site: 'caser.gg', source: 'import', stake: 100, chanceShown: 30, target: { name: 'T', price: 343 }, status: won ? 'won' : 'lost', won, returned: won ? 343 : 0, mystery: false, ...extra };
}
function cs(i, userId = '1', extra = {}) {
  return { id: `c${i}`, kind: 'case', ts: t0 + i * 60000, userId, site: 'caser.gg', source: 'import', caseSlug: 'k', caseName: 'K', casePrice: 50, item: { name: 'S', price: i % 2 ? 80 : 10 }, ...extra };
}

// Storage stand-in that counts loads, like the Edge Function's database.
function fakeDeps(events) {
  const db = { events: [...events], rev: 1, cache: new Map(), loads: 0, deleted: [] };
  return {
    db,
    version: async () => `v${db.rev}`,
    cacheGet: async (keys, version) => {
      const out = new Map();
      for (const k of keys) {
        const c = db.cache.get(k);
        if (c && c.version === version) out.set(k, c.value);
      }
      return out;
    },
    cachePut: async (version, entries) => {
      for (const { key, value } of entries) db.cache.set(key, { version, value: JSON.parse(JSON.stringify(value)) });
    },
    loadEvents: async () => {
      db.loads++;
      return JSON.parse(JSON.stringify(db.events));
    },
    markDeleted: async (ids) => {
      db.deleted.push(...ids);
      db.events = db.events.filter((e) => !ids.includes(e.id));
      db.rev++;
    },
  };
}

test('views give the same results as the stats module, through JSON', async () => {
  const evs = [...Array.from({ length: 60 }, (_, i) => up(i)), ...Array.from({ length: 20 }, (_, i) => cs(i))];
  const deps = fakeDeps(evs);
  const res = await handle({ account: { sel: 'all' }, views: [{ name: 'summarize' }, { name: 'upgradeByStake' }, { name: 'factor', args: ['hour', { kind: 'upgrade' }] }] }, deps);
  const wire = decode(JSON.parse(JSON.stringify(res.results)));
  assert.ok(wire.every((r) => r.ok));
  assert.deepEqual(wire[0].value, decode(encode(stats.summarize(evs))));
  // The last stake bucket ends at Infinity, which plain JSON would turn into null.
  const byStake = wire[1].value;
  assert.equal(byStake[byStake.length - 1].hi, Infinity);
  assert.deepEqual(wire[2].value, decode(encode(stats.factor(evs, 'hour', { kind: 'upgrade' }))));
});

test('Infinity in arguments survives the trip', async () => {
  const deps = fakeDeps(Array.from({ length: 30 }, (_, i) => up(i)));
  const edges = [0, 50, 200, Infinity];
  const res = await handle({ views: [{ name: 'upgradeByStake', args: encode([edges]) }] }, deps);
  const rows = decode(res.results[0].value);
  assert.deepEqual(rows.map((r) => r.hi), [50, 200, Infinity]);
});

test('a second request with the same version is served from the cache without loading events', async () => {
  const deps = fakeDeps(Array.from({ length: 30 }, (_, i) => up(i)));
  const body = { account: { sel: '1' }, views: [{ name: 'calibration' }, { name: 'meta' }] };
  const a = await handle(body, deps);
  const b = await handle(body, deps);
  assert.equal(deps.db.loads, 1);
  assert.deepEqual(b, a);
  // New data: new version, so the views are computed again.
  deps.db.events.push(up(99));
  deps.db.rev++;
  const c = await handle(body, deps);
  assert.equal(deps.db.loads, 2);
  assert.equal(decode(c.results[1].value).total, 31);
});

test('the account selection filters events, and the picker still sees every account', async () => {
  const evs = [...Array.from({ length: 5 }, (_, i) => up(i, '1')), ...Array.from({ length: 3 }, (_, i) => up(i + 10, '2')), { ...up(50), userId: null }];
  const deps = fakeDeps(evs);
  const res = await handle({ account: { sel: '2', legacy: '1' }, views: [{ name: 'meta' }, { name: 'accounts', args: [{ 2: { name: 'Two' } }, '2'] }] }, deps);
  assert.equal(decode(res.results[0].value).total, 3);
  const list = decode(res.results[1].value);
  assert.deepEqual(list.map((a) => [a.id, a.events, a.current]), [['2', 3, true], ['1', 6, false]]);
  // Legacy events (no userId) count for the legacy owner.
  const own = await handle({ account: { sel: '1', legacy: '1' }, views: [{ name: 'meta' }] }, deps);
  assert.equal(decode(own.results[0].value).total, 6);
});

test('unknown views fail alone; bad requests are refused', async () => {
  const deps = fakeDeps([up(1)]);
  const res = await handle({ views: [{ name: 'constructor' }, { name: 'meta' }] }, deps);
  assert.equal(res.results[0].ok, false);
  assert.equal(res.results[1].ok, true);
  await assert.rejects(handle({ views: [] }, deps));
  await assert.rejects(handle({ views: Array.from({ length: 41 }, () => ({ name: 'meta' })) }, deps));
  assert.ok(VIEW_NAMES.includes('summarize') && !VIEW_NAMES.includes('constructor'));
});

test('twins are marked deleted and left out of the results', async () => {
  const live = { ...cs(1), id: 'live1', source: 'live', matchKey: 'k|S', item: { name: 'S', price: 80 } };
  const imp = { ...cs(1), id: 'imp1', source: 'import', ts: live.ts + 5000, item: { name: 'S', price: 80 } };
  const deps = fakeDeps([live, imp, up(2)]);
  const res = await handle({ views: [{ name: 'meta' }] }, deps);
  assert.deepEqual(deps.db.deleted, ['imp1']);
  assert.equal(decode(res.results[0].value).total, 2);
  assert.equal(res.version, 'v2');
});

test('cumulative keeps first, last, lows and highs within the point cap', () => {
  const evs = Array.from({ length: 5000 }, (_, i) => cs(i));
  const full = cumulative(evs, 1e9);
  const thin = cumulative(evs, 300);
  assert.ok(thin.length <= 302);
  assert.deepEqual(thin[0], full[0]);
  assert.deepEqual(thin[thin.length - 1], full[full.length - 1]);
  assert.equal(Math.min(...thin.map((p) => p.v)), Math.min(...full.map((p) => p.v)));
  assert.equal(Math.max(...thin.map((p) => p.v)), Math.max(...full.map((p) => p.v)));
  for (let i = 1; i < thin.length; i++) assert.ok(thin[i].ts >= thin[i - 1].ts);
});

test('the lite outlook model gives the same outlook as the full one', () => {
  const dep = { id: 'd1', kind: 'deposit', ts: t0 + 30 * 60000, status: 'completed', amount: 1000 };
  const evs = [...Array.from({ length: 80 }, (_, i) => up(i)), dep];
  const full = stats.outlookModel(evs);
  const lite = decode(JSON.parse(JSON.stringify(encode(outlookModelLite(evs)))));
  assert.ok(lite.flows.length < full.flows.length);
  const now = t0 + 90 * 60000;
  const sel = { stake: 100, targetPrice: 300 };
  assert.deepEqual(stats.upgradeOutlook(sel, [], { now, model: lite }), stats.upgradeOutlook(sel, [], { now, model: full }));
});

test('historyBase sends counts and only the events the import matches against', () => {
  const live = { ...cs(1), id: 'l', source: 'live', matchKey: 'k|S' };
  const w = { id: 'w', kind: 'withdrawal', ts: t0, source: 'import', item: { name: 'X', price: 5 }, exactTime: false };
  const b = historyBase([up(1), up(2), cs(3), live, w]);
  assert.deepEqual(b.counts, { upgrade: 2, case: 1, withdrawal: 1 });
  assert.deepEqual(b.events.map((e) => e.id), ['w']);
});
