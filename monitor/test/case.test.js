import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caseSlugFrom, caseSpec, caseReport, CASE_RANGES } from '../dashboard/case.js';

const HOUR = 3600000;

test('case lookup: the slug from a pasted link or the slug itself', () => {
  for (const s of [
    'https://caser.gg/en/cases/case-e180f124',
    'https://caser.gg/cases/case-e180f124/',
    'caser.gg/en/cases/case-e180f124?ref=x#top',
    '/en/cases/case-e180f124',
    '  case-e180f124  ',
  ]) assert.equal(caseSlugFrom(s), 'case-e180f124', s);
  assert.equal(caseSlugFrom('https://caser.gg/en/upgrade'), null, 'not a case page');
  assert.equal(caseSlugFrom(''), null);
  assert.equal(caseSlugFrom('has spaces'), null);
  assert.equal(caseSlugFrom('https://caser.gg/en/cases/%E0%A4%A'), null, 'broken escape');
});

test('case lookup: ranges in whole windows, the current half hour included', () => {
  const now = Date.parse('2026-11-16T10:40:00Z');
  const s = caseSpec('7d', now);
  assert.equal(s.to, Date.parse('2026-11-16T11:00:00Z'));
  assert.equal(s.bucket, 6 * HOUR);
  assert.equal(s.from % s.bucket, 0);
  assert.ok(s.to - s.from >= 7 * 24 * HOUR);
  assert.equal(caseSpec('nope', now).key, '7d');
  for (const k of Object.keys(CASE_RANGES)) {
    const r = caseSpec(k, now);
    assert.ok((r.to - r.from) / r.bucket <= 3000 && r.to - r.from <= 401 * 24 * HOUR, k);
  }
});

test('case lookup: totals, house edge, hit rate and the running return', () => {
  const spec = caseSpec('24h', Date.parse('2026-11-16T10:40:00Z'));
  const b = spec.from;
  const data = {
    slug: 'case-e180f124', price: 25, first: b + 2 * HOUR, last: b + 5 * HOUR,
    total: { n: '12', players: 6, sx: '300', sy: '240', hits: 3, gxx: '15000', gyy: '12000', gxy: '11000' },
    windows: [{ bucket: b + 2 * HOUR, n: 4, players: 2, x: 100, y: 150, hits: 2 }, { bucket: b + 5 * HOUR, n: 8, players: 5, x: 200, y: 90, hits: 1 }],
  };
  const r = caseReport(data, spec);
  assert.equal(r.n, 12);
  assert.equal(r.money.ratio, 0.8);
  assert.ok(r.money.ci, 'a range once there are 5 or more players');
  assert.equal(r.houseEdge, 0.2);
  assert.equal(r.hitRate, 0.25);
  assert.deepEqual(r.windows.map((w) => [w.ratio, w.cumRatio, w.cumN]), [[1.5, 1.5, 4], [0.45, 0.8, 12]]);
  assert.equal(r.chartFrom, b + 2 * HOUR, 'the chart starts at the first data');
  const none = caseReport({ slug: 'x', total: { n: 0 }, windows: [], matches: ['xa', 'xb'] }, spec);
  assert.equal(none.n, 0);
  assert.equal(none.money.ratio, null);
  assert.deepEqual(none.matches, ['xa', 'xb']);
});
