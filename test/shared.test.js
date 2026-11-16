import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSharedStore, dayKey } from '../src/store/shared.js';

// In-memory stand-in for the userscript manager's storage. Values are cloned like GM storage does.
function fakeGm() {
  const data = new Map();
  const listeners = [];
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  return {
    data,
    get: (k, d) => (data.has(k) ? clone(data.get(k)) : d),
    set: (k, v) => {
      data.set(k, clone(v));
      for (const l of listeners) if (l.k === k) l.cb(clone(v), true);
    },
    del: (k) => data.delete(k),
    list: () => [...data.keys()],
    listen: (k, cb) => listeners.push({ k, cb }),
  };
}

const DAY = 86400000;
const t0 = Date.UTC(2026, 10, 10, 12);
// A fixed clock so the window of kept days does not move under the tests.
const opts = { now: () => t0 + 3 * DAY };
const up = (id, ts, extra = {}) => ({ id, kind: 'upgrade', ts, source: 'import', status: 'won', ...extra });

test('events from two domains end up in one list', () => {
  const gm = fakeGm();
  const gg = createSharedStore(gm, opts);
  const one = createSharedStore(gm, opts);
  gg.merge([up('upgrade:1', t0, { site: 'caser.gg' }), up('upgrade:2', t0 + DAY, { site: 'caser.gg' })]);
  one.merge([up('upgrade:2', t0 + DAY, { site: 'caser.one' }), up('upgrade:3', t0 + 2 * DAY, { site: 'caser.one' })]);
  assert.deepEqual(one.readAll().map((e) => e.id), ['upgrade:1', 'upgrade:2', 'upgrade:3']);
});

test('only changed days are written, and a repeat merge writes nothing', () => {
  const gm = fakeGm();
  const s = createSharedStore(gm, opts);
  assert.deepEqual(s.merge([up('a', t0), up('b', t0 + DAY)]), [dayKey(t0), dayKey(t0 + DAY)]);
  assert.deepEqual(s.merge([up('a', t0), up('b', t0 + DAY)]), []);
  assert.deepEqual(s.merge([up('c', t0 + DAY)]), [dayKey(t0 + DAY)]);
});

test('a resolved upgrade replaces the pending one, live wins over import', () => {
  const s = createSharedStore(fakeGm(), opts);
  s.merge([up('u', t0, { status: 'pending', source: 'live', balanceBefore: 5 })]);
  s.merge([up('u', t0 + 1000, { status: 'won', source: 'import' })]);
  const [e] = s.readAll();
  assert.equal(e.status, 'won');
  assert.equal(e.source, 'live');
  assert.equal(e.ts, t0);
  assert.equal(e.balanceBefore, 5);
});

test('remove and clear', () => {
  const gm = fakeGm();
  const s = createSharedStore(gm, opts);
  s.merge([up('a', t0), up('b', t0), up('c', t0 + DAY)]);
  s.remove(['a', 'c']);
  assert.deepEqual(s.readAll().map((e) => e.id), ['b']);
  assert.equal(s.clearedAt(), null);
  const at = s.clear();
  assert.deepEqual(s.readAll(), []);
  assert.equal(s.clearedAt(), at);
});

test('other tabs hear which days changed', () => {
  const gm = fakeGm();
  const s = createSharedStore(gm, opts);
  const seen = [];
  s.onRemoteChange((rev) => seen.push(...s.readDays(rev.days).map((e) => e.id)));
  s.merge([up('x', t0)]);
  assert.deepEqual(seen, ['x']);
});

test('only the last KEEP_DAYS days are kept', () => {
  const gm = fakeGm();
  let now = t0;
  const s = createSharedStore(gm, { now: () => now, keepDays: 3 });
  // t0 - 3 days is outside a 3-day window (t0 - 2 days .. t0), so it is never written.
  assert.deepEqual(s.merge([up('old', t0 - 3 * DAY), up('edge', t0 - 2 * DAY), up('new', t0)]), [dayKey(t0 - 2 * DAY), dayKey(t0)]);
  assert.deepEqual(s.readAll().map((e) => e.id), ['edge', 'new']);
  // A day later the edge day falls out: hidden from reads, then deleted by the next write.
  now = t0 + DAY;
  assert.deepEqual(s.readAll().map((e) => e.id), ['new']);
  assert.deepEqual(s.readDays([dayKey(t0 - 2 * DAY)]), []);
  s.merge([up('next', t0 + DAY)]);
  assert.equal(gm.data.has(dayKey(t0 - 2 * DAY)), false);
  assert.equal(gm.data.has(dayKey(t0)), true);
});

test('a write prunes days left over from older versions', () => {
  const gm = fakeGm();
  for (let i = 0; i < 400; i++) gm.set(dayKey(t0 - (20 + i) * DAY), [up(`old${i}`, t0 - (20 + i) * DAY)]);
  const s = createSharedStore(gm, { now: () => t0 });
  s.merge([up('n', t0)]);
  assert.deepEqual(gm.list().filter((k) => k.startsWith('ev:d:')), [dayKey(t0)]);
});
