import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as stats from '../src/stats/index.js';
import { caseEvent, depositEvent, generateEvents, upgradeEvent, withdrawalEvent } from './fixtures.js';

const {
  summarize, caseRoi, upgradeByChance, upgradeByStake, factor, sessions, calibration, calibrationCurve, edgeMap,
  upgradeQuote, superDropStats, mysteryStats, moneyFlow, wilson,
} = stats;

// Monday 2026-01-05 12:00 local time, built without timezone assumptions.
const T = new Date(2026, 0, 5, 12).getTime();
const MIN = 60000;
const at = (m) => T + m * MIN;
const close = (actual, expected, tol = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tol, `expected ${actual} to be within ${tol} of ${expected}`);
const closeArr = (actual, expected, tol = 1e-3) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((a, i) => close(a, expected[i], tol));
};
const total = (rows) => rows.reduce((s, r) => s + r.n, 0);

test('v2 functions never throw on empty input', () => {
  for (const input of [[], null, undefined]) {
    assert.ok(calibrationCurve(input).every((r) => r.n === 0 && r.winRate === null && r.significant === false));
    assert.equal(superDropStats(input).shownRate, null);
    assert.equal(superDropStats(input).hits.avgMultiplier, null);
    const ms = mysteryStats(input);
    assert.equal(ms.n, 0);
    assert.equal(ms.hitRate, null);
    assert.equal(ms.test.p, null);
    const mf = moneyFlow(input);
    assert.equal(mf.deposits.n, 0);
    assert.equal(mf.deposits.perDay, null);
    assert.equal(mf.holdings, null);
    assert.equal(mf.net, 0);
    assert.deepEqual(mf.series, []);
    assert.deepEqual(mf.daily, []);
  }
});

test('win tests use normal upgrades without the super-drop card by default', () => {
  const shownCard = { shown: true, won: false, item: null };
  const events = [
    upgradeEvent({ ts: at(0), chanceShown: 50, won: true }),
    upgradeEvent({ ts: at(1), chanceShown: 50, won: false, superDrop: shownCard }),
    upgradeEvent({ ts: at(2), stake: 100, targetPrice: 200, mystery: true, won: true }),
  ];
  assert.equal(events[2].chanceShown, null);
  assert.equal(total(upgradeByChance(events)), 1); // null chance does not fall into the 0% bucket
  assert.equal(total(upgradeByChance(events, undefined, { includeSuperDrop: true })), 2);
  assert.equal(total(upgradeByStake(events)), 1);
  assert.equal(total(calibrationCurve(events)), 1);
  assert.equal(total(edgeMap(events)), 1);
  assert.equal(calibration(events).n, 1);
  assert.equal(calibration(events, { includeSuperDrop: true }).n, 2);
  assert.equal(total(factor(events, 'hour', { kind: 'upgrade' }).rows), 1);
  assert.equal(total(factor(events, 'hour', { kind: 'upgrade', includeSuperDrop: true }).rows), 2);
  assert.equal(upgradeQuote({ stake: 100, targetPrice: 200, chanceShown: 50 }, events).similar.n, 1);
  // money metrics still cover everything
  assert.equal(summarize(events).upgrades.n, 3);
  assert.equal(summarize(events).upgrades.oddsN, 1);
  // 'mode' lists mystery too, 'superDrop' keeps the card rows
  assert.deepEqual(factor(events, 'mode').rows.map((r) => r.n), [1, 1]);
  assert.deepEqual(factor(events, 'superDrop').rows.map((r) => r.n), [1, 1]);
});

test('deposits and withdrawals are ignored by every function that does not use them', () => {
  const opts = { seed: 4, cases: 100, upgrades: 300, mysteryRate: 0.1, superDropRate: 0.2 };
  const base = generateEvents(opts);
  const withMoney = generateEvents({ ...opts, deposits: 20, withdrawals: 10 });
  assert.equal(withMoney.length, base.length + 30);
  assert.deepEqual(withMoney.filter((e) => e.kind === 'case' || e.kind === 'upgrade'), base);
  assert.deepEqual(summarize(withMoney), summarize(base));
  assert.deepEqual(sessions(withMoney), sessions(base));
  assert.deepEqual(caseRoi(withMoney), caseRoi(base));
  assert.deepEqual(upgradeByChance(withMoney), upgradeByChance(base));
  assert.deepEqual(calibration(withMoney), calibration(base));
  assert.deepEqual(calibrationCurve(withMoney), calibrationCurve(base));
  assert.deepEqual(superDropStats(withMoney), superDropStats(base));
  assert.deepEqual(mysteryStats(withMoney), mysteryStats(base));
  for (const key of ['hour', 'sessionPosition', 'afterLossStreak', 'mode', 'superDrop']) {
    assert.deepEqual(factor(withMoney, key), factor(base, key), key);
  }
});

test('calibrationCurve hand dataset', () => {
  const mk = (chance, n, wins, ts0) =>
    Array.from({ length: n }, (_, i) => upgradeEvent({ ts: ts0 + i * MIN, chanceShown: chance, won: i < wins }));
  const rows = calibrationCurve([...mk(5, 20, 15, T), ...mk(30, 20, 5, T + 100 * MIN)]);
  assert.deepEqual(rows.map((r) => r.label), ['0-10%', '10-15%', '15-20%', '20-30%', '30-50%', '50-75%', '75-100%']);
  assert.deepEqual(rows.map((r) => r.n), [20, 0, 0, 0, 20, 0, 0]);
  const low = rows[0];
  assert.equal(low.wins, 15);
  assert.equal(low.winRate, 0.75);
  close(low.expectedRate, 0.05, 1e-12);
  closeArr(low.winRateCI, wilson(15, 20), 1e-12);
  assert.ok(low.z > 10 && low.p < 1e-10);
  assert.equal(low.significant, true);
  assert.equal(rows[1].winRate, null);
  assert.equal(rows[1].significant, false);
  // chance 30 lands in [30, 50); 5 wins * 200 returned on 20 * 100 staked
  assert.equal(rows[4].lo, 30);
  assert.equal(rows[4].wins, 5);
  close(rows[4].realRtp, (5 * 200) / (20 * 100), 1e-12);
  assert.equal(rows[4].significant, false); // 5/20 against 30% is not far enough off
});

test('calibrationCurve flags both ends of a compressed curve and stays quiet on a fair one', () => {
  const squeezed = calibrationCurve(generateEvents({ seed: 3, cases: 0, upgrades: 20000, edge: 1, compress: 0.3 }));
  const first = squeezed[0];
  const last = squeezed[squeezed.length - 1];
  assert.ok(first.winRate > first.expectedRate && first.significant, 'low chances should win more than shown');
  assert.ok(last.winRate < last.expectedRate && last.significant, 'high chances should win less than shown');

  let quiet = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const fair = calibrationCurve(generateEvents({ seed, cases: 0, upgrades: 6000, edge: 1 }));
    if (fair.every((r) => !r.significant)) quiet++;
  }
  assert.ok(quiet >= 8, `only ${quiet}/10 fair seeds had no flagged bucket`);
});

test('adjusted factor test does not flag rows that only differ by chance mix', () => {
  const split = (events) => events.map((e) => (e.kind === 'upgrade' ? { ...e, gameMode: e.chanceShown < 15 ? 'low' : 'high' } : e));
  let shownFlagged = 0;
  let adjClean = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const events = split(generateEvents({ seed, cases: 0, upgrades: 8000, edge: 1, compress: 0.3 }));
    const f = factor(events, 'gameMode');
    assert.deepEqual(f.rows.map((r) => r.value).sort(), ['high', 'low']);
    if (f.test.significant && f.rows.every((r) => r.significant)) shownFlagged++;
    if (!f.test.significantAdj && f.rows.every((r) => !r.significantAdj)) adjClean++;
  }
  assert.equal(shownFlagged, 10, 'against the shown odds the chance mix looks like luck');
  assert.ok(adjClean >= 9, `adjusted test stayed quiet in only ${adjClean}/10 seeds`);
});

test('adjusted factor test still flags a real effect', () => {
  // same chance mix in both rows, but one row wins far more often than the pooled curve says
  const mk = (gameMode, wins) =>
    Array.from({ length: 400 }, (_, i) => upgradeEvent({ ts: T + i * MIN, chanceShown: 25, won: i < wins, gameMode }));
  const f = factor([...mk('a', 100), ...mk('b', 160)], 'gameMode');
  assert.equal(f.test.significantAdj, true);
  assert.ok(f.test.pAdj < 1e-3);
  assert.deepEqual(f.rows.map((r) => r.significantAdj), [true, true]);
});

test('factor sinceDeposit, afterDepositOrder and sinceWithdrawal', () => {
  const up = (m) => upgradeEvent({ ts: at(m), chanceShown: 50 });
  const events = [
    up(-60), // before any deposit
    depositEvent({ ts: at(0) }),
    depositEvent({ ts: at(20 * 60), status: 'failed' }), // not counted
    up(1), up(10), up(30), up(3 * 60), up(7 * 60),
    withdrawalEvent({ ts: at(8 * 60) }),
    up(8 * 60 + 30), up(14 * 60), up(40 * 60),
  ];
  const since = factor(events, 'sinceDeposit');
  assert.deepEqual(since.rows.map((r) => r.label), ['0-5m', '5-15m', '15-60m', '1-6h', '6h+', 'no deposit yet']);
  assert.deepEqual(since.rows.map((r) => r.n), [1, 1, 1, 1, 4, 1]);
  const order = factor(events, 'afterDepositOrder');
  assert.deepEqual(order.rows.map((r) => r.label), ['1st', '2nd-5th', '6th-20th', '21st+']);
  assert.deepEqual(order.rows.map((r) => r.n), [1, 4, 3, 0]); // 8 upgrades after the deposit; the early one is skipped
  const w = factor(events, 'sinceWithdrawal');
  assert.deepEqual(w.rows.map((r) => [r.label, r.n]), [['<1h', 1], ['1-24h', 1], ['24h+ / none', 7]]);

  const second = [...events, depositEvent({ ts: at(41 * 60) }), up(41 * 60 + 5)];
  assert.deepEqual(factor(second, 'afterDepositOrder').rows.map((r) => r.n), [2, 4, 3, 0]); // a new deposit restarts the count
});

test('superDropStats hand dataset', () => {
  const card = (won) => ({ shown: true, won, item: null });
  const mk = (i, won, superDrop, returned) =>
    upgradeEvent({ ts: at(i), stake: 100, targetPrice: 500, won, superDrop, ...(returned !== undefined ? { returned } : {}) });
  const events = [
    ...Array.from({ length: 10 }, (_, i) => mk(i, i < 2, null)),
    mk(20, true, card(true), 1000), // multiplier 2
    mk(21, true, card(true), 1500), // multiplier 3
    mk(22, true, card(false)),
    mk(23, false, card(false)),
    upgradeEvent({ ts: at(30), mystery: true }),
  ];
  const s = superDropStats(events);
  assert.equal(s.n, 14);
  assert.equal(s.shownN, 4);
  close(s.shownRate, 4 / 14, 1e-12);
  assert.equal(s.shown.n, 4);
  assert.equal(s.shown.wins, 3);
  assert.equal(s.shown.winRate, 0.75);
  close(s.shown.expectedRate, 0.206, 1e-12);
  assert.equal(s.shown.rtp, (1000 + 1500 + 500) / 400);
  assert.equal(s.notShown.wins, 2);
  assert.equal(s.notShown.winRate, 0.2);
  assert.deepEqual(s.hits, { n: 2, avgMultiplier: 2.5, minMultiplier: 2, maxMultiplier: 3 });
});

test('superDropStats on a fixture: the card lifts the win rate', () => {
  const events = generateEvents({ seed: 9, cases: 0, upgrades: 6000, edge: 1, superDropRate: 0.25, superBoost: 1.7 });
  const s = superDropStats(events);
  assert.ok(s.shownRate > 0.2 && s.shownRate < 0.3);
  assert.ok(s.shown.winRate > s.notShown.winRate);
  assert.ok(s.shown.z > 4);
  assert.ok(Math.abs(s.notShown.z) < 4);
  assert.ok(s.hits.n > 0 && s.hits.minMultiplier >= 1.2 && s.hits.maxMultiplier <= 3);
  // excluded by default, so the calibration of the rest stays clean
  assert.notEqual(calibration(events).verdict, 'above');
  assert.ok(calibration(events, { includeSuperDrop: true }).n > calibration(events).n);
});

test('mysteryStats hand dataset', () => {
  const my = (i, stake, mult) =>
    upgradeEvent({ ts: at(i), stake, targetPrice: stake * mult, mystery: true, won: mult >= 1, returned: stake * mult, mysteryMultiplier: mult });
  const events = [
    my(0, 100, 0.5), my(1, 100, 2), my(2, 100, 1), my(3, 1000, 3), my(4, 1000, 0.2),
    upgradeEvent({ ts: at(5), chanceShown: 50, won: true }), // normal upgrade: ignored
    upgradeEvent({ ts: at(6), mystery: true, status: 'pending' }),
  ];
  const m = mysteryStats(events);
  assert.equal(m.n, 5);
  assert.equal(m.cost, 2300);
  close(m.returned, 50 + 200 + 100 + 3000 + 200, 1e-9);
  close(m.hitRate, 3 / 5, 1e-12);
  closeArr(m.hitRateCI, wilson(3, 5), 1e-12);
  close(m.meanMultiplier, (0.5 + 2 + 1 + 3 + 0.2) / 5, 1e-12);
  assert.equal(m.medianMultiplier, 1);
  const bin = (label) => m.histogram.find((b) => b.label === label).n;
  assert.equal(m.histogram.length, 9);
  assert.equal(bin('x0-0.25'), 1);
  assert.equal(bin('x0.5-0.75'), 1);
  assert.equal(bin('x1-1.25'), 1);
  assert.equal(bin('x2-3'), 1);
  assert.equal(bin('x3+'), 1);
  assert.deepEqual(m.byStake.map((r) => r.n), [0, 3, 0, 2, 0]);
  close(m.byStake[1].hitRate, 2 / 3, 1e-12);
  assert.equal(m.test.method, 'anova');
  assert.deepEqual([m.test.df, m.test.dfWithin], [1, 3]);
  assert.ok(m.test.p > 0 && m.test.p < 1);
  // mystery events never reach the win tests
  assert.equal(calibration(events).n, 1);
});

test('mysteryStats on a fixture: mean multiplier does not depend on stake', () => {
  const events = generateEvents({ seed: 11, cases: 0, upgrades: 3000, mysteryRate: 1 });
  const m = mysteryStats(events);
  assert.equal(m.n, 3000);
  assert.ok(m.hitRate > 0.2 && m.hitRate < 0.5);
  assert.ok(m.roi < 0);
  assert.ok(m.test.p > 0.001);
});

test('moneyFlow hand dataset', () => {
  const events = [
    depositEvent({ ts: at(0), amount: 1000 }),
    depositEvent({ ts: at(1), amount: 200, status: 'failed' }),
    depositEvent({ ts: at(2), amount: 300, status: 'expired' }),
    withdrawalEvent({ ts: at(120), value: 300, exactTime: true }),
    withdrawalEvent({ ts: at(180), value: 100, exactTime: false }),
    depositEvent({ ts: at(24 * 60), amount: 500 }),
    upgradeEvent({ ts: at(5) }),
  ];
  const f = moneyFlow(events, { balance: 50, inventoryValue: 150 });
  assert.deepEqual([f.deposits.n, f.deposits.sum, f.deposits.failedN, f.deposits.failedSum], [2, 1500, 2, 500]);
  assert.deepEqual([f.deposits.firstTs, f.deposits.lastTs], [at(0), at(24 * 60)]);
  close(f.deposits.perDay, 1500, 1e-9);
  assert.deepEqual(f.withdrawals, { n: 2, value: 400, exactTimeN: 1 });
  assert.equal(f.holdings, 200);
  assert.equal(f.net, 400 + 200 - 1500);
  assert.deepEqual(f.series.map((r) => [r.kind, r.amount, r.cumulativeNet]), [
    ['deposit', 1000, -1000], ['withdrawal', 300, -700], ['withdrawal', 100, -600], ['deposit', 500, -1100],
  ]);
  assert.deepEqual(f.daily, [
    { day: '2026-01-05', deposited: 1000, withdrawn: 400 },
    { day: '2026-01-06', deposited: 500, withdrawn: 0 },
  ]);
  assert.equal(moneyFlow(events).holdings, null);
  assert.equal(moneyFlow(events).net, 400 - 1500);
  assert.equal(moneyFlow(events, { balance: 20 }).holdings, 20);
});

test('fixture generator v2 options', () => {
  const events = generateEvents({ seed: 8, cases: 50, upgrades: 2000, mysteryRate: 0.2, superDropRate: 0.3, deposits: 12, withdrawals: 6 });
  const ups = events.filter((e) => e.kind === 'upgrade');
  const mys = ups.filter((e) => e.mystery);
  assert.ok(mys.length > 300 && mys.length < 500);
  assert.ok(mys.every((e) => e.chanceShown === null && e.chanceServer === null && e.mysteryMultiplier > 0));
  assert.ok(mys.every((e) => e.won === e.mysteryMultiplier >= 1 && e.status === (e.won ? 'won' : 'lost')));
  assert.ok(mys.every((e) => e.superDrop === null));
  const cards = ups.filter((e) => e.superDrop && e.superDrop.shown);
  assert.ok(cards.length > 300);
  assert.ok(cards.every((e) => !e.mystery));
  assert.ok(cards.some((e) => e.superDrop.won && e.superDrop.item && e.returned > e.target.price));
  assert.equal(events.filter((e) => e.kind === 'deposit').length, 12);
  assert.equal(events.filter((e) => e.kind === 'withdrawal').length, 6);
  const dep = events.find((e) => e.kind === 'deposit');
  assert.ok(dep.amount > 0 && typeof dep.method === 'string' && 'completedTs' in dep);
  const wd = events.find((e) => e.kind === 'withdrawal');
  assert.ok(wd.value > 0 && wd.item.price === wd.value && typeof wd.exactTime === 'boolean');
  for (let i = 1; i < events.length; i++) assert.ok(events[i].ts >= events[i - 1].ts);
  // cases still present
  assert.ok(events.some((e) => e.kind === 'case'));
  assert.ok(caseEvent({ ts: 0 }).kind === 'case');
});
