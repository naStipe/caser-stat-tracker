import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as stats from '../src/stats/index.js';
import { binomialPmf } from '../src/stats/math.js';
import { caseEvent, generateEvents, mulberry32, upgradeEvent } from './fixtures.js';

const { summarize, caseRoi, upgradeByChance, upgradeByStake, factor, sessions, calibration, edgeMap, upgradeQuote, wilson, normalCdf, holm } = stats;

// Monday 2026-01-05 12:00 local time, built without timezone assumptions.
const T = new Date(2026, 0, 5, 12).getTime();
const MIN = 60000;
const close = (actual, expected, tol = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tol, `expected ${actual} to be within ${tol} of ${expected}`);
const closeArr = (actual, expected, tol = 1e-3) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((a, i) => close(a, expected[i], tol));
};
const FACTOR_KEYS = [
  'hour', 'weekday', 'daypart', 'sessionPosition', 'sessionMinute', 'afterLossStreak', 'afterWin', 'mode',
  'gameMode', 'site', 'free', 'itemCount', 'addedBalance', 'balanceBand', 'multiplier',
  'sinceDeposit', 'afterDepositOrder', 'sinceWithdrawal', 'superDrop',
];

// ---- empty and degenerate input -------------------------------------------

test('empty input never throws and returns zeroed metrics', () => {
  for (const input of [[], null, undefined]) {
    const s = summarize(input);
    assert.equal(s.total.n, 0);
    assert.equal(s.total.roi, null);
    assert.equal(s.total.roiCI, null);
    assert.equal(s.upgrades.winRate, null);
    assert.equal(s.upgrades.winRateCI, null);
    assert.equal(s.upgrades.z, null);
    assert.equal(s.upgrades.p, null);
    assert.equal(s.upgrades.significant, false);
    assert.equal(s.firstTs, null);
    assert.equal(s.lastTs, null);
    assert.deepEqual(caseRoi(input), []);
    assert.deepEqual(sessions(input), []);
    assert.deepEqual(edgeMap(input), []);
    assert.ok(upgradeByChance(input).every((r) => r.n === 0 && r.winRate === null && r.significant === false));
    assert.equal(upgradeByChance(input).length, 8);
    assert.equal(upgradeByStake(input).length, 6);
    const c = calibration(input);
    assert.equal(c.n, 0);
    assert.equal(c.verdict, 'consistent');
    assert.equal(c.impliedRtp, null);
    for (const key of FACTOR_KEYS) {
      const f = factor(input, key);
      assert.equal(f.key, key);
      assert.ok(f.rows.every((r) => r.n === 0));
      assert.equal(f.test.p, null);
      assert.equal(f.test.significant, false);
    }
    const q = upgradeQuote({ stake: 0, targetPrice: 0 }, input);
    assert.equal(q.longRun.probProfit, null);
    assert.equal(q.realEdge, null);
    assert.equal(q.similar.n, 0);
  }
});

test('factor throws on unknown key', () => {
  assert.throws(() => factor([], 'nope'), /Unknown factor/);
});

test('pending upgrades and other-kind events are ignored', () => {
  const events = [
    caseEvent({ ts: T, price: 10, drop: 20 }),
    upgradeEvent({ ts: T + MIN, won: true }),
    upgradeEvent({ ts: T + 2 * MIN, status: 'pending' }),
  ];
  assert.equal(summarize(events).upgrades.n, 1);
  assert.equal(summarize(events).lastTs, T + MIN);
  assert.equal(upgradeByChance(events).reduce((s, r) => s + r.n, 0), 1);
  assert.equal(calibration(events).n, 1);
  assert.equal(sessions(events)[0].n, 2);
  assert.equal(caseRoi(events).length, 1);
  assert.equal(caseRoi(events)[0].n, 1);
});

// ---- math helpers ----------------------------------------------------------

test('wilson matches known values', () => {
  closeArr(wilson(5, 10), [0.2366, 0.7634], 1e-3);
  closeArr(wilson(50, 100), [0.4038, 0.5962], 1e-3);
  assert.equal(wilson(0, 10)[0], 0);
  assert.equal(wilson(10, 10)[1], 1);
  assert.deepEqual(wilson(0, 0), [0, 1]);
});

test('normalCdf matches known values', () => {
  close(normalCdf(0), 0.5, 1e-12);
  close(normalCdf(1), 0.8413447460685429, 1e-9);
  close(normalCdf(1.96), 0.9750021048517795, 1e-9);
  close(normalCdf(-1.96), 0.0249978951482205, 1e-9);
  close(normalCdf(3), 0.9986501019683699, 1e-9);
  close(normalCdf(-8), 6.22096e-16, 1e-20);
  assert.equal(normalCdf(Infinity), 1);
  assert.equal(normalCdf(-Infinity), 0);
  assert.ok(Number.isNaN(normalCdf(NaN)));
});

test('chi-square and F survival functions match critical values', () => {
  close(stats.chiSquareSf(3.841458820694124, 1), 0.05, 1e-9);
  close(stats.chiSquareSf(5.991464547107979, 2), 0.05, 1e-9);
  close(stats.chiSquareSf(2, 2), Math.exp(-1), 1e-12);
  close(stats.chiSquareSf(0, 3), 1, 1e-12);
  close(stats.fSf(4.964602743730711, 1, 10), 0.05, 1e-9);
  close(stats.fSf(0, 3, 7), 1, 1e-12);
});

test('holm correction', () => {
  assert.deepEqual(holm([0.01, 0.04, 0.03]), [true, false, false]);
  assert.deepEqual(holm([0.001, 0.01, 0.02]), [true, true, true]);
  assert.deepEqual(holm([0.04, 0.04]), [false, false]);
  assert.deepEqual(holm([0.03, 0.001, 0.2]), [false, true, false]);
  assert.deepEqual(holm([null, 0.01]), [false, true]);
  assert.deepEqual(holm([]), []);
});

// ---- tables ---------------------------------------------------------------

test('summarize on a hand-computed dataset', () => {
  const events = [
    caseEvent({ ts: T, price: 10, drop: 5 }),
    caseEvent({ ts: T + MIN, price: 10, drop: 30 }),
    upgradeEvent({ ts: T + 2 * MIN, stake: 100, targetPrice: 200, won: true }),
    upgradeEvent({ ts: T + 3 * MIN, stake: 50, targetPrice: 500, won: false }),
    upgradeEvent({ ts: T + 10 * MIN, status: 'pending' }),
  ];
  const s = summarize(events);
  assert.equal(s.cases.n, 2);
  assert.equal(s.cases.cost, 20);
  assert.equal(s.cases.returned, 35);
  assert.equal(s.cases.net, 15);
  close(s.cases.roi, 0.75);
  // ratios 0.5 and 3: mean 1.75, sd 1.7678, half-width 1.96 * 1.25
  closeArr(s.cases.roiCI, [-1.7, 3.2], 1e-9);

  assert.equal(s.upgrades.n, 2);
  assert.equal(s.upgrades.cost, 150);
  assert.equal(s.upgrades.returned, 200);
  assert.equal(s.upgrades.net, 50);
  close(s.upgrades.roi, 1 / 3);
  assert.equal(s.upgrades.wins, 1);
  assert.equal(s.upgrades.winRate, 0.5);
  close(s.upgrades.expectedRate, (0.515 + 0.103) / 2);
  closeArr(s.upgrades.winRateCI, wilson(1, 2), 1e-12);
  // z = (1 - 0.618) / sqrt(0.515*0.485 + 0.103*0.897)
  close(s.upgrades.z, 0.382 / Math.sqrt(0.515 * 0.485 + 0.103 * 0.897), 1e-9);

  assert.equal(s.total.n, 4);
  assert.equal(s.total.cost, 170);
  assert.equal(s.total.returned, 235);
  assert.equal(s.firstTs, T);
  assert.equal(s.lastTs, T + 3 * MIN);
});

test('roiCI is null with a single event or zero cost', () => {
  const one = summarize([caseEvent({ ts: T })]);
  assert.equal(one.cases.roiCI, null);
  assert.notEqual(one.cases.roi, null);
  const free = summarize([caseEvent({ ts: T, free: true }), caseEvent({ ts: T, free: true })]);
  assert.equal(free.cases.cost, 0);
  assert.equal(free.cases.roi, null);
  assert.equal(free.cases.roiCI, null);
});

test('caseRoi groups by slug with best, median and hit rate', () => {
  const events = [
    caseEvent({ ts: T, caseSlug: 'a', caseName: 'Alpha', price: 10, drop: 5 }),
    caseEvent({ ts: T + MIN, caseSlug: 'a', caseName: 'Alpha', price: 10, drop: 10 }),
    caseEvent({ ts: T + 2 * MIN, caseSlug: 'a', caseName: 'Alpha', price: 10, drop: 50 }),
    caseEvent({ ts: T + 3 * MIN, caseSlug: 'b', caseName: 'Beta', price: 100, drop: 20 }),
    upgradeEvent({ ts: T + 4 * MIN }),
  ];
  const rows = caseRoi(events);
  assert.deepEqual(rows.map((r) => r.caseSlug), ['a', 'b']);
  const a = rows[0];
  assert.equal(a.caseName, 'Alpha');
  assert.equal(a.casePrice, 10);
  assert.equal(a.n, 3);
  assert.equal(a.cost, 30);
  assert.equal(a.returned, 65);
  assert.equal(a.best.price, 50);
  assert.equal(a.median, 10);
  close(a.hitRate, 2 / 3);
  assert.equal(rows[1].hitRate, 0);
  assert.equal(rows[1].best.price, 20);
  close(rows[1].roi, -0.8);
});

test('upgradeByChance bucket boundaries: lo inclusive, last bucket includes hi', () => {
  const chances = [0, 1.99, 2, 4.99, 5, 74.99, 75, 100];
  const events = chances.map((c, i) => upgradeEvent({ ts: T + i * MIN, chanceShown: c }));
  const rows = upgradeByChance(events);
  assert.deepEqual(rows.map((r) => r.label), ['0-2%', '2-5%', '5-10%', '10-20%', '20-30%', '30-50%', '50-75%', '75-100%']);
  assert.deepEqual(rows.map((r) => r.n), [2, 2, 1, 0, 0, 0, 1, 2]);
  assert.equal(rows[7].hi, 100);
  assert.equal(rows[0].lo, 0);
  const custom = upgradeByChance(events, [0, 50, 100]);
  assert.deepEqual(custom.map((r) => r.n), [5, 3]);
  // out-of-range chances are dropped
  assert.equal(upgradeByChance([upgradeEvent({ chanceShown: 101 })]).reduce((s, r) => s + r.n, 0), 0);
});

test('upgradeByStake bucket boundaries and open-ended last bucket', () => {
  const stakes = [99.99, 100, 499.99, 500, 20000, 1e9];
  const events = stakes.map((stake, i) => upgradeEvent({ ts: T + i * MIN, stake, targetPrice: stake * 3 }));
  const rows = upgradeByStake(events);
  assert.deepEqual(rows.map((r) => r.n), [1, 2, 1, 0, 0, 2]);
  assert.equal(rows[5].label, '20000+');
  assert.equal(rows[5].hi, Infinity);
});

test('win test: z, p and Holm-corrected significance with the n >= 10 rule', () => {
  // 100 upgrades at 50%, 60 wins: z = 10 / 5 = 2
  const events = Array.from({ length: 100 }, (_, i) => upgradeEvent({ ts: T + i * MIN, chanceShown: 50, won: i < 60 }));
  const row = upgradeByChance(events).find((r) => r.n === 100);
  close(row.z, 2, 1e-9);
  close(row.p, 2 * (1 - normalCdf(2)), 1e-9);
  assert.equal(row.winRate, 0.6);
  assert.equal(row.significant, true); // only eligible row, so Holm leaves alpha at 0.05 and p = 0.0455

  // 40 losses at 50% is far off; 9 losses at 90% is just as off but too small to flag
  const big = Array.from({ length: 40 }, (_, i) => upgradeEvent({ ts: T + i * MIN, chanceShown: 50, won: false }));
  const small = Array.from({ length: 9 }, (_, i) => upgradeEvent({ ts: T + i * MIN, chanceShown: 90, won: false }));
  const rows = upgradeByChance([...big, ...small]);
  const bigRow = rows.find((r) => r.n === 40);
  const smallRow = rows.find((r) => r.n === 9);
  assert.ok(bigRow.p < 1e-6);
  assert.equal(bigRow.significant, true);
  assert.ok(smallRow.p < 0.01);
  assert.equal(smallRow.significant, false);
});

test('win test guards zero variance', () => {
  const events = Array.from({ length: 20 }, (_, i) => upgradeEvent({ ts: T + i * MIN, chanceShown: 100, won: true }));
  const row = upgradeByChance(events).find((r) => r.n === 20);
  assert.equal(row.z, null);
  assert.equal(row.p, null);
  assert.equal(row.significant, false);
});

// ---- sessions and factors -------------------------------------------------

test('sessions split when the gap exceeds the limit', () => {
  const events = [
    upgradeEvent({ ts: T + 71 * MIN, stake: 100, targetPrice: 200, won: true }),
    caseEvent({ ts: T, price: 10, drop: 5 }),
    caseEvent({ ts: T + 10 * MIN, price: 10, drop: 30 }),
    caseEvent({ ts: T + 40 * MIN, price: 10, drop: 0 }), // gap of exactly 30 minutes does not split
  ];
  const s = sessions(events);
  assert.equal(s.length, 2);
  assert.deepEqual([s[0].start, s[0].end, s[0].n], [T, T + 40 * MIN, 3]);
  assert.deepEqual(s[0].kinds, { case: 3, upgrade: 0 });
  assert.equal(s[0].cost, 30);
  assert.equal(s[0].returned, 35);
  assert.equal(s[0].net, 5);
  assert.deepEqual([s[1].start, s[1].n, s[1].net], [T + 71 * MIN, 1, 100]);
  assert.deepEqual(s[1].kinds, { case: 0, upgrade: 1 });
  assert.equal(sessions(events, 5).length, 4);
  assert.equal(sessions(events, 120).length, 1);
});

test('factor afterLossStreak counts consecutive prior losses and skips pending', () => {
  const outcomes = 'LLLWLLLLLL';
  const events = [...outcomes].map((c, i) => upgradeEvent({ ts: T + i * MIN, won: c === 'W', chanceShown: 50 }));
  events.push(upgradeEvent({ ts: T + 4.5 * MIN, status: 'pending' }));
  const f = factor(events, 'afterLossStreak');
  assert.deepEqual(f.rows.map((r) => r.value), [0, 1, 2, '3-4', '5+']);
  assert.deepEqual(f.rows.map((r) => r.n), [2, 2, 2, 3, 1]);
  assert.equal(f.rows[3].wins, 1);
  const w = factor(events, 'afterWin');
  assert.deepEqual(w.rows.map((r) => [r.value, r.n]), [['won', 1], ['lost', 8], ['none', 1]]);
});

test('factor hour, weekday and daypart use local time with Monday = 0', () => {
  const at = (d, h) => new Date(2026, 0, d, h).getTime();
  const events = [
    upgradeEvent({ ts: at(5, 13) }), // Monday
    upgradeEvent({ ts: at(5, 13) + MIN }),
    upgradeEvent({ ts: at(11, 22) }), // Sunday
    caseEvent({ ts: at(7, 3) }), // Wednesday
    caseEvent({ ts: at(7, 7) }),
  ];
  const hour = factor(events, 'hour');
  assert.equal(hour.rows.length, 24);
  assert.equal(hour.rows[13].n, 2);
  assert.equal(hour.rows[22].n, 1);
  assert.equal(hour.rows[3].n, 1);
  assert.equal(hour.rows[13].label, '13:00');
  const wd = factor(events, 'weekday');
  assert.deepEqual(wd.rows.map((r) => r.n), [2, 0, 2, 0, 0, 0, 1]);
  const dp = factor(events, 'daypart');
  assert.deepEqual(dp.rows.map((r) => [r.value, r.n]), [['night', 1], ['morning', 1], ['afternoon', 2], ['evening', 1]]);
  // kind filter: upgrades only
  assert.equal(factor(events, 'hour', { kind: 'upgrade' }).rows.reduce((s, r) => s + r.n, 0), 3);
  assert.equal(factor(events, 'hour', { kind: 'case' }).rows.reduce((s, r) => s + r.n, 0), 2);
});

test('factor sessionPosition and sessionMinute', () => {
  const first = Array.from({ length: 6 }, (_, i) => upgradeEvent({ ts: T + i * 10 * MIN }));
  const second = [upgradeEvent({ ts: T + 500 * MIN })];
  const pos = factor([...first, ...second], 'sessionPosition');
  assert.deepEqual(pos.rows.map((r) => r.n), [6, 1, 0]);
  // minutes since session start: 0, 10, 20, 30, 40, 50 -> 2 in 0-15, 4 in 15-60; new session adds one at 0
  const min = factor([...first, ...second], 'sessionMinute');
  assert.deepEqual(min.rows.map((r) => r.n), [3, 4, 0]);
});

test('factor gameMode runs a chi-square of observed vs expected wins', () => {
  const mk = (gameMode, wins) =>
    Array.from({ length: 100 }, (_, i) => upgradeEvent({ ts: T + i * MIN, chanceShown: 50, won: i < wins, gameMode }));
  const f = factor([...mk('a', 50), ...mk('b', 70)], 'gameMode');
  assert.equal(f.test.method, 'chi-square');
  assert.equal(f.test.df, 1);
  close(f.test.statistic, 16, 1e-9);
  close(f.test.p, stats.chiSquareSf(16, 1), 1e-12);
  assert.equal(f.test.significant, true);
  assert.deepEqual(f.rows.map((r) => r.significant), [false, true]);
  // adjusted expectation = pooled win rate of the bucket (60%): 2 * (100/60 + 100/40)
  close(f.test.statisticAdj, 2 * (100 / 60 + 100 / 40), 1e-9);
  close(f.test.pAdj, stats.chiSquareSf(2 * (100 / 60 + 100 / 40), 1), 1e-12);
  close(f.rows[0].expectedRateAdj, 0.6, 1e-9);
});

test('factor on cases runs one-way ANOVA on return ratio', () => {
  const mk = (mode, drops) => drops.map((d, i) => caseEvent({ ts: T + i * MIN, price: 10, drop: d, gameMode: mode }));
  const f = factor([...mk('a', [10, 20, 30]), ...mk('b', [40, 50, 60])], 'gameMode', { kind: 'case' });
  assert.equal(f.test.method, 'anova');
  assert.deepEqual([f.test.df, f.test.dfWithin], [1, 4]);
  close(f.test.statistic, 13.5, 1e-9);
  close(f.test.p, 0.0213, 1e-3);
  assert.deepEqual(f.rows.map((r) => r.value), ['a', 'b']);
  // a single group cannot be tested
  assert.equal(factor(mk('a', [1, 2, 3]), 'gameMode').test.p, null);
});

test('factor fixed categories: free, itemCount, addedBalance, multiplier, balanceBand', () => {
  const events = [
    caseEvent({ ts: T, free: true }),
    caseEvent({ ts: T + MIN }),
    upgradeEvent({ ts: T + 2 * MIN, stake: 100, targetPrice: 150, addedBalance: 10, balanceBefore: 50, betItems: [{}, {}] }),
    upgradeEvent({ ts: T + 3 * MIN, stake: 100, targetPrice: 1200, balanceBefore: 700, betItems: [{}, {}, {}, {}, {}, {}, {}, {}] }),
  ];
  assert.deepEqual(factor(events, 'free').rows.map((r) => r.n), [1, 1]);
  assert.deepEqual(factor(events, 'itemCount').rows.map((r) => r.n), [0, 1, 0, 0, 0, 1]);
  assert.deepEqual(factor(events, 'addedBalance').rows.map((r) => r.n), [1, 1]);
  assert.deepEqual(factor(events, 'multiplier').rows.map((r) => r.n), [1, 0, 0, 1]);
  const band = factor(events, 'balanceBand');
  assert.deepEqual(band.rows.map((r) => r.n), [1, 0, 1, 0, 0, 0]); // 50 -> [0,100), 700 -> [500,1000)
  assert.deepEqual(factor(events, 'site').rows.map((r) => [r.value, r.n]), [['caser.gg', 4]]);
});

test('factor hour: test is not significant on fair data in most seeds', () => {
  let clean = 0;
  const seeds = Array.from({ length: 30 }, (_, i) => i + 1);
  for (const seed of seeds) {
    const events = generateEvents({ seed, cases: 300, upgrades: 600, edge: 1 });
    const f = factor(events, 'hour');
    assert.equal(f.rows.length, 24);
    assert.ok(f.test.p === null || (f.test.p >= 0 && f.test.p <= 1));
    if (!f.test.significant) clean++;
  }
  assert.ok(clean >= 26, `only ${clean}/30 seeds were non-significant`);
});

// ---- calibration, edge map, quote ------------------------------------------

test('calibration detects the hidden 0.92 edge', () => {
  const events = generateEvents({ seed: 7, cases: 0, upgrades: 10000, edge: 0.92 });
  const c = calibration(events);
  assert.equal(c.n, 10000);
  assert.equal(c.verdict, 'below');
  assert.ok(c.z < -1.96);
  assert.ok(c.wins < c.expectedWins);
  assert.ok(c.impliedRtp < 1.03 * 0.92 + 0.08 && c.impliedRtp > 0.7, `rtp ${c.impliedRtp}`);
});

test('calibration is consistent on a fair fixture', () => {
  let consistent = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const c = calibration(generateEvents({ seed, cases: 0, upgrades: 3000, edge: 1 }));
    if (c.verdict === 'consistent') consistent++;
  }
  assert.ok(consistent >= 17, `only ${consistent}/20 seeds consistent`);
  const single = calibration(generateEvents({ seed: 3, cases: 0, upgrades: 3000, edge: 1 }));
  close(single.impliedRtp, 1.03, 0.12);
});

test('edgeMap compares promised and realised return per bucket (normal upgrades only)', () => {
  const events = [
    upgradeEvent({ ts: T, stake: 100, targetPrice: 200, won: true }),
    upgradeEvent({ ts: T + MIN, stake: 100, targetPrice: 200, won: false }),
    upgradeEvent({ ts: T + 2 * MIN, stake: 50, targetPrice: 500, won: false, mystery: true }),
    caseEvent({ ts: T + 3 * MIN }),
  ];
  const rows = edgeMap(events);
  assert.equal(rows.length, 1); // the mystery upgrade has no shown chance and is left out
  const normal = rows[0];
  assert.deepEqual([normal.label, normal.mode, normal.n], ['50-75%', 'normal', 2]);
  close(normal.shownRtp, 1.03, 1e-9);
  assert.equal(normal.realRtp, 1);
  closeArr(normal.realRtpCI, [-0.96, 2.96], 1e-9);
});

test('upgradeQuote ev math and history lookup', () => {
  const hist = Array.from({ length: 40 }, (_, i) => upgradeEvent({ ts: T + i * MIN, stake: 100, targetPrice: 200, won: i < 20 }));
  const q = upgradeQuote({ stake: 100, targetPrice: 200 }, hist);
  close(q.chanceShown, 51.5, 1e-9);
  close(q.chanceFair, 50, 1e-9);
  close(q.multiplier, 2, 1e-9);
  close(q.ev, 3, 1e-9);
  close(q.evPct, 0.03, 1e-9);
  close(q.realEdge, 0, 1e-9); // 20 wins * 200 = 4000 returned on 4000 staked
  assert.deepEqual([q.similar.n, q.similar.wins, q.similar.winRate], [40, 20, 0.5]);
  closeArr(q.similar.winRateCI, wilson(20, 40), 1e-12);
  // different stake bucket: same chance bucket still feeds realEdge, but not `similar`
  const q2 = upgradeQuote({ stake: 1000, targetPrice: 2000 }, hist);
  assert.equal(q2.similar.n, 0);
  assert.equal(q2.similar.winRate, null);
  assert.notEqual(q2.realEdge, null);
  // too little history
  assert.equal(upgradeQuote({ stake: 100, targetPrice: 200 }, hist.slice(0, 29)).realEdge, null);
  // explicit chanceShown overrides the site formula
  close(upgradeQuote({ stake: 100, targetPrice: 200, chanceShown: 40 }, []).ev, -20, 1e-9);
});

test('upgradeQuote longRun: exact binomial over 100 tries', () => {
  const fair = upgradeQuote({ stake: 10, targetPrice: 20, chanceShown: 50 }, []).longRun;
  assert.equal(fair.tries, 100);
  close(fair.mean, 0, 1e-9);
  assert.equal(fair.p05, -160); // k = 42
  assert.equal(fair.p95, 160); // k = 58
  const pmf = binomialPmf(100, 0.5);
  close(pmf.reduce((s, x) => s + x, 0), 1, 1e-12);
  close(fair.probProfit, (1 - pmf[50]) / 2, 1e-12);
  close(fair.probProfit, 0.4602, 1e-4);

  const q = upgradeQuote({ stake: 100, targetPrice: 200 }, []);
  close(q.longRun.mean, 300, 1e-6); // 100 * ev
  const pmf2 = binomialPmf(100, 0.515);
  close(pmf2.reduce((s, x) => s + x, 0), 1, 1e-12);
  const profit = pmf2.slice(51).reduce((s, x) => s + x, 0);
  const noProfit = pmf2.slice(0, 51).reduce((s, x) => s + x, 0);
  close(q.longRun.probProfit, profit, 1e-12);
  close(q.longRun.probProfit + noProfit, 1, 1e-12);
  assert.ok(q.longRun.p05 < q.longRun.mean && q.longRun.mean < q.longRun.p95);
});

// ---- fixtures -------------------------------------------------------------

test('fixture generator is deterministic, schema-shaped and sorted', () => {
  assert.deepEqual(generateEvents({ seed: 5 }), generateEvents({ seed: 5 }));
  assert.notDeepEqual(generateEvents({ seed: 5 }), generateEvents({ seed: 6 }));
  const rand = mulberry32(1);
  assert.ok([rand(), rand(), rand()].every((x) => x >= 0 && x < 1));

  const start = new Date(2026, 0, 1).getTime();
  const events = generateEvents({ seed: 2, cases: 300, upgrades: 200, start });
  assert.equal(events.filter((e) => e.kind === 'case').length, 300);
  assert.equal(events.filter((e) => e.kind === 'upgrade').length, 200);
  assert.equal(new Set(events.map((e) => e.id)).size, events.length);
  for (let i = 1; i < events.length; i++) assert.ok(events[i].ts >= events[i - 1].ts);
  assert.ok(events[events.length - 1].ts - start < 31 * 24 * 60 * MIN);
  assert.ok(sessions(events).length > 5);
  for (const e of events) {
    assert.ok(['live', 'import'].includes(e.source));
    if (e.kind === 'case') {
      assert.ok(e.casePrice >= 10 && e.casePrice <= 5000);
      assert.ok(e.item.price > 0 && e.batchId && e.batchSize >= 1);
    } else {
      assert.ok(e.chanceShown >= 1 && e.chanceShown <= 90);
      assert.equal(e.won, e.status === 'won');
      assert.equal(e.net, e.returned - e.stake);
      assert.equal(e.returned, e.won ? e.target.price : 0);
    }
  }
});

test('Holm correction withholds significance from two borderline rows', () => {
  const mk = (chance, wins) =>
    Array.from({ length: 100 }, (_, i) => upgradeEvent({ ts: T + i * MIN, chanceShown: chance, won: i < wins }));
  const rows = upgradeByChance([...mk(50, 61), ...mk(20, 28)]).filter((r) => r.n === 100);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.p < 0.05)); // each would pass an uncorrected test
  assert.ok(rows.every((r) => r.significant === false)); // smallest p 0.028 > 0.05 / 2
});
