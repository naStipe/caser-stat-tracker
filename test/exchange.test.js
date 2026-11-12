import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeSales, createPriceClient, salesUrl, expandPoints, findSplit, CSFLOAT_SELLER_FEE } from '../src/prices/csfloat.js';
import { replacementItemId, candidatesFromResponse } from '../src/capture/replacements.js';
import { rankCandidates, sellValue } from '../src/stats/exchange.js';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const DAY = 86_400_000;
const sale = (daysAgo, cents, ref) => ({ created_at: new Date(NOW - daysAgo * DAY).toISOString(), price: cents, state: 'sold', reference: ref });

test('salesUrl encodes the market name', () => {
  assert.equal(salesUrl('StatTrak™ M4A4 | Buzz Kill (Battle-Scarred)'), 'https://csfloat.com/api/v1/history/StatTrak%E2%84%A2%20M4A4%20%7C%20Buzz%20Kill%20(Battle-Scarred)/sales');
});

test('summarizeSales uses the median of recent sales when there are 3+', () => {
  const ref = { base_price: 8302, quantity: 20 };
  const s = summarizeSales([sale(1, 7240, ref), sale(3, 7350, ref), sale(9, 7600, ref), sale(10, 7633, ref), sale(40, 9000, ref)], NOW);
  assert.equal(s.source, 'sales');
  assert.equal(s.value, (73.5 + 76) / 2);
  assert.equal(s.basePrice, 83.02);
  assert.equal(s.listings, 20);
  assert.equal(s.sales7d, 2);
  assert.equal(s.sales30d, 4);
  assert.equal(s.lastPrice, 72.4);
  assert.equal(s.n, 5);
});

test('summarizeSales falls back to the reference price, then the last sale', () => {
  const ref = { base_price: 5000, quantity: 3 };
  const a = summarizeSales([sale(2, 4800, ref), sale(60, 4000, ref)], NOW);
  assert.equal(a.source, 'reference');
  assert.equal(a.value, 50);
  const b = summarizeSales([sale(90, 4000)], NOW);
  assert.equal(b.source, 'last');
  assert.equal(b.value, 40);
  const c = summarizeSales(null, NOW);
  assert.equal(c.value, null);
  assert.equal(c.sales30d, 0);
});

test('replacement candidates are parsed from the site response', () => {
  assert.equal(replacementItemId('/inventory/items/123/replacements?limit=50&offset=0'), '123');
  assert.equal(replacementItemId('/inventory/items/123/replace'), null);
  const list = candidatesFromResponse({
    success: true,
    data: [
      { id: 'c1', item: { id: '77', marketName: 'AWP | Wildfire (Battle-Scarred)', price: '8281.340', image: 'https://img/a' }, price: '8281.340', refund: '0' },
      { id: 'c2', item: { id: '78', marketName: 'Sticker | NiKo (Foil) | Boston 2018' }, price: '8260.65', refund: '20.69' },
      { id: 'c3', item: { id: '79' }, price: '1' },
    ],
  });
  assert.equal(list.length, 2);
  assert.deepEqual(list[1], { id: 'c2', itemId: '78', name: 'Sticker | NiKo (Foil) | Boston 2018', price: 8260.65, refund: 20.69, image: null });
  assert.equal(candidatesFromResponse({ data: { items: [{ id: 'x', marketName: 'A', price: 1 }] } }).length, 1);
});

test('rankCandidates puts liquid items first, by value, with delta to the current item', () => {
  const cands = [
    { id: 'a', name: 'A', price: 100 },
    { id: 'b', name: 'B', price: 99 },
    { id: 'c', name: 'C', price: 98 },
    { id: 'd', name: 'D', price: 97 },
  ];
  const m = {
    A: { summary: { net: 1.2, quickNet: 1.0, sales30d: 1 } },
    B: { summary: { net: 0.9, quickNet: 0.88, sales30d: 12 } },
    C: { summary: { net: 1.1, quickNet: 0.8, sales30d: 5 } },
    D: { error: 'CSFloat HTTP 500' },
  };
  const rows = rankCandidates(cands, (n) => m[n], { minSales: 3, currentValue: 1 });
  assert.deepEqual(rows.map((r) => r.id), ['c', 'b', 'a', 'd']);
  assert.deepEqual(rows.map((r) => r.liquid), [true, true, false, false]);
  assert.ok(Math.abs(rows[0].delta - 0.1) < 1e-9);
  assert.equal(rows[3].error, 'CSFloat HTTP 500');
  assert.ok(Math.abs(rows[0].perK - (1.1 / 98) * 1000) < 1e-9);
  const bySales = rankCandidates(cands, (n) => m[n], { minSales: 3, sort: 'sales' });
  assert.deepEqual(bySales.map((r) => r.id), ['b', 'c', 'a', 'd']);
  // Fast-sale basis ranks by the 25th-percentile price after the fee.
  const fast = rankCandidates(cands, (n) => m[n], { minSales: 3, basis: 'fast', currentValue: 0.85 });
  assert.deepEqual(fast.map((r) => r.id), ['b', 'c', 'a', 'd']);
  assert.ok(Math.abs(fast[0].delta - 0.03) < 1e-9);
  assert.equal(sellValue(m.C.summary, 'fast'), 0.8);
  assert.equal(sellValue(null), null);
});

test('summarizeSales drops outliers, gives a fast-sale price, the fee, trend and sale points', () => {
  const ref = { base_price: 10000, quantity: 81 };
  const withFloat = (r, f) => ({ ...r, item: { float_value: f } });
  const rows = [
    withFloat(sale(1, 9500, ref), 0.147),
    sale(2, 9600, ref),
    sale(3, 9700, ref),
    sale(5, 30000, ref), // sticker craft: dropped
    sale(8, 9800, ref),
    sale(20, 10000, ref),
    sale(25, 10100, ref),
    sale(40, 10200, ref),
  ];
  const s = summarizeSales(rows, NOW);
  assert.equal(s.source, 'sales');
  assert.equal(s.windowDays, 30);
  assert.equal(s.used, 6);
  assert.equal(s.sales30d, 7);
  // Kept: 95, 96, 97, 98, 100, 101 -> median 97.5, 25th percentile 96.25.
  assert.equal(s.value, 97.5);
  assert.equal(s.quick, 96.25);
  assert.equal(s.low, 95);
  assert.equal(s.high, 101);
  assert.ok(Math.abs(s.net - 97.5 * (1 - CSFLOAT_SELLER_FEE)) < 1e-9);
  assert.ok(Math.abs(s.quickNet - 96.25 * (1 - CSFLOAT_SELLER_FEE)) < 1e-9);
  // Last 14 days: 95, 96, 97, 300, 98 -> 97; days 14 to 90: 100, 101, 102 -> 101.
  assert.ok(Math.abs(s.trend - (97 / 101 - 1)) < 1e-9);
  assert.equal(s.pts.length, 8);
  const p = expandPoints(s.pts);
  assert.equal(p[0].price, 95);
  assert.equal(p[0].float, 0.147);
  assert.equal(p[1].float, null);
  assert.ok(Math.abs(p[0].ts - (NOW - DAY)) < 60_000);
});

test('summarizeSales widens to 90 days when the last 30 have fewer than 3 sales', () => {
  const s = summarizeSales([sale(5, 5000), sale(45, 5200), sale(60, 5400), sale(120, 9000)], NOW);
  assert.equal(s.source, 'sales');
  assert.equal(s.windowDays, 90);
  assert.equal(s.value, 52);
  assert.equal(s.sales30d, 1);
});

test('two price groups: value comes from the lower group, upper is reported, full lists are marked capped', () => {
  // 40 sales in the last day: 24 around $100, 16 around $135 (a pattern or phase premium).
  const rows = Array.from({ length: 40 }, (_, i) => sale(i / 48, i % 5 < 3 ? 9800 + (i % 7) * 100 : 12800 + (i % 9) * 200));
  const s = summarizeSales(rows, NOW);
  assert.ok(s.split, 'split found');
  assert.equal(s.split.lowMax, 104);
  assert.equal(s.split.highMin, 128);
  assert.ok(Math.abs(s.split.lowShare - 0.6) < 1e-9);
  assert.ok(s.value >= 98 && s.value <= 104, `value ${s.value} in the lower group`);
  assert.ok(s.split.upper >= 128);
  assert.equal(s.salesCapped, true);
  assert.equal(s.sales30d, 40);
  // One price group: no split, not capped.
  const one = summarizeSales(Array.from({ length: 10 }, (_, i) => sale(i, 10000 + i * 50)), NOW);
  assert.equal(one.split, null);
  assert.equal(one.salesCapped, false);
  assert.equal(findSplit([1, 2, 3]), null);
});

test('price client caches, shares in-flight requests and reports rate limits', async () => {
  const calls = [];
  const mem = {};
  const storage = { get: (k, d) => mem[k] ?? d, set: (k, v) => (mem[k] = v) };
  const request = async (url) => {
    calls.push(url);
    if (url.includes('Limited')) return { status: 429, json: null };
    return { status: 200, json: [sale(1, 1000, { base_price: 1000, quantity: 2 })] };
  };
  const client = createPriceClient({ request, storage, now: () => NOW, gapMs: 0 });
  const [a, b] = await Promise.all([client.get('Item'), client.get('Item')]);
  assert.equal(calls.length, 1);
  assert.equal(a, b);
  assert.equal(a.value, 10);
  await client.get('Item');
  assert.equal(calls.length, 1);
  assert.ok(mem['cst.csfloat.v3'].Item);
  // A new client reads the stored cache.
  const again = createPriceClient({ request, storage, now: () => NOW, gapMs: 0 });
  assert.equal(again.cached('Item').value, 10);
  await assert.rejects(client.get('Limited'), /rate limit/);
});
