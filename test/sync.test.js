import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paginate, _setPause } from '../src/capture/history.js';

_setPause(0);

// A newest-first history of `rows` ids served 50 per page; `stored` plays the IndexedDB.
function harness(rows, { failAfterPages = Infinity } = {}) {
  const stored = new Set();
  const meta = new Map();
  let calls = 0;
  const get = async (url) => {
    if (++calls > failAfterPages) throw new Error('tab closed');
    const offset = Number(new URL(url, 'http://x').searchParams.get('offset'));
    const items = rows.slice(offset, offset + 50);
    return { items, hasMore: offset + 50 < rows.length };
  };
  const onPage = async (body) => {
    let added = 0;
    for (const id of body.items) if (!stored.has(id)) (stored.add(id), added++);
    return { count: body.items.length, added };
  };
  const progress = { load: async () => meta.get('p'), save: async (v) => void meta.set('p', v) };
  return { stored, meta, get, onPage, progress, calls: () => calls, resetCalls: () => (calls = 0) };
}

const ids = (n, from = 0) => Array.from({ length: n }, (_, i) => `r${from + i}`);

test('first sync reads everything and marks the stream complete', async () => {
  const h = harness(ids(520));
  await paginate(h.get, '/h', h.onPage, h.progress);
  assert.equal(h.stored.size, 520);
  assert.equal(h.meta.get('p').complete, true);
});

test('later sync only reads the new top rows plus two known pages', async () => {
  const rows = ids(520);
  const h = harness(rows);
  await paginate(h.get, '/h', h.onPage, h.progress);
  h.resetCalls();
  rows.unshift(...ids(30, 1000)); // 30 new rows at the top
  await paginate(h.get, '/h', h.onPage, h.progress);
  assert.equal(h.stored.size, 550);
  assert.equal(h.calls(), 3);
});

test('interrupted first sync resumes where it stopped, including rows added meanwhile', async () => {
  const rows = ids(1000);
  const h = harness(rows, { failAfterPages: 8 });
  await assert.rejects(paginate(h.get, '/h', h.onPage, h.progress));
  assert.equal(h.stored.size, 400);
  assert.equal(h.meta.get('p').complete, false);

  rows.unshift(...ids(70, 5000));
  // Second run without the failure, on the same stored data and progress.
  const again = harness(rows);
  for (const id of h.stored) again.stored.add(id);
  again.meta.set('p', h.meta.get('p'));
  await paginate(again.get, '/h', again.onPage, again.progress);
  assert.equal(again.stored.size, 1070);
  assert.equal(again.meta.get('p').complete, true);
  assert.ok(again.calls() < 20, `expected a resume, not a full re-read (${again.calls()} pages)`);
});

test('import cut off before progress was tracked: resumes from the stored count', async () => {
  const rows = ids(800);
  const h = harness(rows);
  for (const id of rows.slice(0, 600)) h.stored.add(id); // an older version stored the newest 600
  h.meta.set('p', { complete: false, offset: 100 }); // a later sync only walked the top
  await paginate(h.get, '/h', h.onPage, h.progress, 600);
  assert.equal(h.stored.size, 800);
  assert.equal(h.meta.get('p').complete, true);
  assert.ok(h.calls() < 10, `expected a resume near row 600 (${h.calls()} pages)`);
});
