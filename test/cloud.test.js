import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventRank, isSyncKey, newSyncKey, createCloud, planUpload, cleanNames } from '../src/store/cloud.js';
import { shouldReplace, mergeEvent } from '../src/store/db.js';

test('rank grows whenever the local store would replace an event', () => {
  const pairs = [
    [{ kind: 'upgrade', status: 'pending', source: 'live' }, { kind: 'upgrade', status: 'won', source: 'import' }],
    [{ kind: 'upgrade', status: 'lost', source: 'import' }, { kind: 'upgrade', status: 'lost', source: 'live' }],
    [{ kind: 'case', source: 'import' }, { kind: 'case', source: 'live' }],
    [{ kind: 'deposit', status: 'pending', source: 'live' }, { kind: 'deposit', status: 'completed', source: 'import', completedTs: 5 }],
  ];
  for (const [a, b] of pairs) {
    const ea = { id: 'x', ts: 1, ...a };
    const eb = { id: 'x', ts: 2, ...b };
    assert.ok(shouldReplace(ea, eb));
    const merged = mergeEvent(ea, eb);
    assert.ok(eventRank(merged) > eventRank(ea), JSON.stringify(a));
    assert.ok(eventRank(merged) >= eventRank(eb), JSON.stringify(b));
  }
});

test('sync keys', () => {
  const k = newSyncKey();
  assert.equal(k.length, 32);
  assert.ok(isSyncKey(k));
  assert.notEqual(k, newSyncKey());
  assert.ok(!isSyncKey('short'));
  assert.ok(!isSyncKey(`${'a'.repeat(31)} `));
  assert.ok(!isSyncKey(null));
});

// Fake PostgREST: keeps rows, answers the calls cloud.js makes.
function fakeServer() {
  const rows = new Map();
  let clock = Date.UTC(2026, 10, 12);
  const calls = [];
  const request = async ({ method, url, headers, body }) => {
    calls.push({ method, url, headers });
    const u = new URL(url);
    if (u.pathname === '/rest/v1/rpc/sync_push') {
      let n = 0;
      for (const r of JSON.parse(body).rows) {
        const old = rows.get(r.id);
        if (!old || (r.rank > old.rank && !old.deleted)) {
          rows.set(r.id, { id: r.id, rank: r.rank, deleted: false, data: r.data, updated_at: new Date(++clock).toISOString() });
          n++;
        }
      }
      return { status: 200, json: n };
    }
    if (u.pathname === '/rest/v1/sync_events' && u.searchParams.get('select') === 'id,rank,deleted') {
      const limit = Number(u.searchParams.get('limit'));
      const gt = u.searchParams.get('id');
      let list = [...rows.values()].sort((a, b) => a.id.localeCompare(b.id));
      if (gt) list = list.filter((r) => r.id > gt.slice(3));
      return { status: 200, json: list.slice(0, limit).map((r) => ({ id: r.id, rank: r.rank, deleted: r.deleted })) };
    }
    if (u.pathname === '/rest/v1/sync_events') {
      const limit = Number(u.searchParams.get('limit'));
      const gte = u.searchParams.get('updated_at');
      const or = u.searchParams.get('or');
      let list = [...rows.values()].sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.id.localeCompare(b.id));
      if (gte) list = list.filter((r) => r.updated_at >= gte.slice(4));
      if (or) {
        const m = /updated_at\.gt\.([^,]+),and\(updated_at\.eq\.[^,]+,id\.gt\."(.*)"\)\)$/.exec(or);
        list = list.filter((r) => r.updated_at > m[1] || (r.updated_at === m[1] && r.id > m[2]));
      }
      return { status: 200, json: list.slice(0, limit) };
    }
    return { status: 404, json: { message: 'no route' } };
  };
  return { rows, request, calls };
}

test('push in batches, pull everything in pages, then only changes', async () => {
  const srv = fakeServer();
  const cloud = createCloud({ request: srv.request, getKey: () => 'k'.repeat(32), url: 'https://x.test', apiKey: 'pk' });
  const events = Array.from({ length: 2300 }, (_, i) => ({ id: `upgrade:${String(i).padStart(5, '0')}`, kind: 'upgrade', ts: i, status: 'won' }));
  assert.equal(await cloud.push(events), 2300);
  assert.equal(srv.calls.length, 5);
  assert.equal(srv.calls[0].headers['x-sync-key'], 'k'.repeat(32));

  const first = await cloud.pull(null);
  assert.equal(first.events.length, 2300);
  assert.equal(new Set(first.events.map((e) => e.id)).size, 2300);

  await cloud.push([{ id: 'case:new', kind: 'case', ts: 9, source: 'live' }]);
  const next = await cloud.pull(first.cursor);
  // The overlap window re-reads recent rows; the new one must be there.
  assert.ok(next.events.some((e) => e.id === 'case:new'));
});

test('without a key nothing is sent', async () => {
  const srv = fakeServer();
  const cloud = createCloud({ request: srv.request, getKey: () => null, url: 'https://x.test', apiKey: 'pk' });
  await assert.rejects(cloud.push([{ id: 'a', ts: 1 }]), /off/);
  assert.equal(srv.calls.length, 0);
});

test('first upload sends only what the cloud lacks or holds a worse copy of', async () => {
  const srv = fakeServer();
  const cloud = createCloud({ request: srv.request, getKey: () => 'k'.repeat(32), url: 'https://x.test', apiKey: 'pk' });
  const events = Array.from({ length: 2300 }, (_, i) => ({ id: `upgrade:${String(i).padStart(5, '0')}`, kind: 'upgrade', ts: i, status: 'won', userId: '1' }));
  await cloud.push(events.slice(0, 2000));
  srv.rows.get('upgrade:00005').deleted = true;
  const ranks = await cloud.ranks();
  assert.equal(ranks.size, 2000);
  assert.equal(ranks.get('upgrade:00005'), Infinity);
  // A local copy that improved (now live) must go up again; deleted rows never do.
  const local = events.map((e, i) => (i === 7 ? { ...e, source: 'live' } : e));
  const ids = planUpload(local, ranks);
  assert.equal(ids.length, 301);
  assert.equal(ids[0], 'upgrade:00007');
  assert.ok(!ids.includes('upgrade:00005'));
});

test('account names from the cloud keep only usable entries', () => {
  assert.deepEqual(cleanNames({ 1: ' naStipe ', 2: '', 3: 5, 'bad id': 'x' }), { 1: 'naStipe' });
  assert.deepEqual(cleanNames(null), {});
  assert.deepEqual(cleanNames(['x']), {});
});
