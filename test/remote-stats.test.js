import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteStats } from '../src/store/remote-stats.js';
import { handle } from '../src/server/views.js';

const t0 = Date.UTC(2026, 9, 1, 12);
const up = (i, extra = {}) => ({ id: `u${i}`, kind: 'upgrade', ts: t0 + i * 60000, userId: '1', source: 'import', stake: 100, chanceShown: 30, target: { price: 343 }, status: i % 3 ? 'lost' : 'won', won: !(i % 3), returned: i % 3 ? 0 : 343, mystery: false, ...extra });

// A server made of the real handler over an in-memory event list.
function fakeServer(events) {
  const srv = { events, rev: 1, requests: [], fail: false };
  const cache = new Map();
  srv.request = async (req) => {
    srv.requests.push(JSON.parse(req.body));
    if (srv.fail) return { status: 503, json: { error: 'down' } };
    const json = await handle(JSON.parse(req.body), {
      version: async () => `v${srv.rev}`,
      cacheGet: async (keys, v) => new Map(keys.filter((k) => cache.get(k)?.v === v).map((k) => [k, cache.get(k).value])),
      cachePut: async (v, entries) => entries.forEach((e) => cache.set(e.key, { v, value: e.value })),
      loadEvents: async () => srv.events,
      markDeleted: async () => {},
    });
    return { status: 200, json: JSON.parse(JSON.stringify(json)) };
  };
  return srv;
}

const settle = () => new Promise((r) => setTimeout(r, 60));

function client(srv, acc = { sel: 'all', legacy: null }) {
  return createRemoteStats({ request: srv.request, getKey: () => 'k'.repeat(32), getAccount: () => acc });
}

test('views asked for in one render go out as one request', async () => {
  const srv = fakeServer([up(1), up(2), up(3)]);
  const rs = client(srv);
  let updates = 0;
  rs.subscribe(() => updates++);
  assert.deepEqual(rs.get('meta'), { loading: true });
  assert.deepEqual(rs.get('summarize'), { loading: true });
  rs.get('meta'); // asked twice, sent once
  await settle();
  assert.equal(srv.requests.length, 1);
  assert.deepEqual(srv.requests[0].views.map((v) => v.name), ['meta', 'summarize']);
  assert.equal(updates, 1);
  assert.equal(rs.get('meta').value.total, 3);
  assert.equal(rs.version(), 'v1');
});

test('answers stay cached until invalidate, then the old answer shows while the new one loads', async () => {
  const srv = fakeServer([up(1)]);
  const rs = client(srv);
  rs.get('meta');
  await settle();
  rs.get('meta');
  await settle();
  assert.equal(srv.requests.length, 1);
  srv.events = [up(1), up(2)];
  srv.rev++;
  rs.invalidate();
  const old = rs.get('meta');
  assert.equal(old.value.total, 1);
  assert.equal(old.stale, true);
  await settle();
  assert.equal(srv.requests.length, 2);
  assert.deepEqual(rs.get('meta'), { value: rs.get('meta').value, stale: false });
  assert.equal(rs.get('meta').value.total, 2);
});

test('Infinity goes both ways: edges in, bucket bounds out', async () => {
  const srv = fakeServer(Array.from({ length: 20 }, (_, i) => up(i)));
  const rs = client(srv);
  rs.get('upgradeByStake', [0, 50, Infinity]);
  await settle();
  assert.deepEqual(srv.requests[0].views[0].args, [[0, 50, '__inf__']]);
  const rows = rs.get('upgradeByStake', [0, 50, Infinity]).value;
  assert.equal(rows[rows.length - 1].hi, Infinity);
});

test('a server error is reported, and an older answer stays on screen', async () => {
  const srv = fakeServer([up(1)]);
  const rs = client(srv);
  rs.get('meta');
  rs.get('summarize');
  await settle();
  srv.fail = true;
  rs.invalidate();
  rs.get('meta');
  rs.get('calibration');
  await settle();
  assert.equal(rs.get('meta').value.total, 1);
  assert.match(String(rs.get('calibration').error), /503/);
  assert.match(String(rs.lastError()), /down/);
  // Failed answers are not retried on every render, only after the next invalidate.
  const before = srv.requests.length;
  rs.get('calibration');
  await settle();
  assert.equal(srv.requests.length, before);
  srv.fail = false;
  rs.invalidate();
  rs.get('calibration');
  await settle();
  assert.equal(rs.get('calibration').value.n, 1);
  assert.equal(rs.lastError(), null);
});

test('each account selection has its own answers', async () => {
  const srv = fakeServer([up(1), { ...up(2), userId: '2' }]);
  const acc = { sel: '1', legacy: null };
  const rs = client(srv, acc);
  rs.get('meta');
  await settle();
  assert.equal(rs.get('meta').value.total, 1);
  acc.sel = 'all';
  assert.deepEqual(rs.get('meta'), { loading: true });
  await settle();
  assert.equal(rs.get('meta').value.total, 2);
});

test('an unknown view fails on its own', async () => {
  const srv = fakeServer([up(1)]);
  const rs = client(srv);
  rs.get('nope');
  rs.get('meta');
  await settle();
  assert.match(String(rs.get('nope').error), /Unknown view/);
  assert.equal(rs.get('meta').value.total, 1);
});
