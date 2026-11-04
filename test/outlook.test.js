import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upgradeOutlook } from '../src/stats/index.js';
import { caseEvent, depositEvent, upgradeEvent } from './fixtures.js';

const T = new Date(2026, 0, 5, 12).getTime();
const MIN = 60000;

// One deposit per "cycle". 10% upgrades win 2 of 10 in the first 5 minutes, 1 of 20 later.
// 50% upgrades win 4 of 10 at any time.
function history(cycles = 40) {
  const ev = [];
  for (let c = 0; c < cycles; c++) {
    const t0 = T + c * 300 * MIN;
    ev.push(depositEvent({ ts: t0 }));
    for (let i = 0; i < 10; i++) {
      ev.push(upgradeEvent({ ts: t0 + 90 * 1000 + i * 15 * 1000, stake: 10, targetPrice: 103, chanceShown: 10, won: i < 2 }));
      ev.push(upgradeEvent({ ts: t0 + 30 * MIN + i * MIN, stake: 10, targetPrice: 103, chanceShown: 10, won: i < 1 && c % 2 === 0 }));
      ev.push(upgradeEvent({ ts: t0 + 60 * MIN + i * MIN, stake: 100, targetPrice: 206, chanceShown: 50, won: i < 4 }));
    }
  }
  return ev;
}

test('upgradeOutlook: null without a valid selection', () => {
  assert.equal(upgradeOutlook({ stake: 0, targetPrice: 100 }, []), null);
  assert.equal(upgradeOutlook({ stake: 10, targetPrice: 0 }, []), null);
  assert.equal(upgradeOutlook(null, null), null);
});

test('upgradeOutlook: unknown verdict without history', () => {
  const o = upgradeOutlook({ stake: 10, targetPrice: 103 }, [], { now: T });
  assert.equal(o.verdict, 'unknown');
  assert.equal(o.probProfitable, null);
  assert.equal(o.window.key, 'cold');
  assert.equal(o.context.minutesSinceDeposit, null);
  assert.ok(Math.abs(o.ratio - 1) < 1e-9);
});

test('upgradeOutlook: low chance right after a deposit is likely profitable, later not', () => {
  const ev = history();
  const lastDep = T + 39 * 300 * MIN;
  const hot = upgradeOutlook({ stake: 10, targetPrice: 103, chanceShown: 10 }, ev, { now: lastDep + 2 * MIN });
  assert.equal(hot.window.key, 'hot');
  assert.equal(hot.band, '0-15%');
  assert.equal(hot.verdict, 'likely-profit');
  assert.ok(hot.ratio > 1.5 && hot.ratio < 2);
  assert.ok(hot.ev > 0);
  assert.equal(hot.cell.n, 400);
  const cold = upgradeOutlook({ stake: 10, targetPrice: 103, chanceShown: 10 }, ev, { now: lastDep + 200 * MIN });
  assert.equal(cold.window.key, 'cold');
  assert.ok(cold.ratio < hot.ratio);
  assert.notEqual(cold.verdict, 'likely-profit');
});

test('upgradeOutlook: Kelly stake is positive with an edge, zero without, null without history', () => {
  const ev = history();
  const lastDep = T + 39 * 300 * MIN;
  const hot = upgradeOutlook({ stake: 10, targetPrice: 103, chanceShown: 10 }, ev, { now: lastDep + 2 * MIN });
  // b = 103/10 - 1 = 9.3; f = p - (1-p)/b with p = realChance; half = f/2.
  const b = 103 / 10 - 1;
  const f = hot.realChance - (1 - hot.realChance) / b;
  assert.ok(hot.kelly.full > 0);
  assert.ok(Math.abs(hot.kelly.full - f) < 1e-9);
  assert.ok(Math.abs(hot.kelly.half - f / 2) < 1e-9);

  const bad = upgradeOutlook({ stake: 100, targetPrice: 206 }, ev, { now: lastDep + 90 * MIN });
  assert.equal(bad.kelly.full, 0);
  assert.equal(bad.kelly.half, 0);

  assert.equal(upgradeOutlook({ stake: 10, targetPrice: 103, chanceShown: 10 }, [], { now: T }).kelly, null);
});

test('upgradeOutlook: high chance that wins below shown is likely losing', () => {
  const o = upgradeOutlook({ stake: 100, targetPrice: 206 }, history(), { now: T + 39 * 300 * MIN + 90 * MIN });
  assert.equal(o.band, '50-75%');
  assert.equal(o.verdict, 'likely-loss');
  assert.ok(o.realChance < 0.45);
  assert.ok(o.ev < 0);
});

test('upgradeOutlook: context counts upgrades and net since the last completed deposit', () => {
  const ev = [
    depositEvent({ ts: T }),
    depositEvent({ ts: T + 10 * MIN, status: 'failed' }),
    upgradeEvent({ ts: T + MIN, stake: 10, targetPrice: 100, chanceShown: 10.3, won: true }),
    upgradeEvent({ ts: T + 2 * MIN, stake: 10, targetPrice: 100, chanceShown: 10.3, won: false }),
    caseEvent({ ts: T + 3 * MIN, price: 10, drop: 4 }),
  ];
  const o = upgradeOutlook({ stake: 10, targetPrice: 100 }, ev, { now: T + 4 * MIN });
  assert.equal(o.context.upgradesSinceDeposit, 2);
  assert.ok(Math.abs(o.context.minutesSinceDeposit - 3) < 1e-9); // from completedTs (ts + 1 min in fixtures)
  assert.ok(Math.abs(o.context.netSinceDeposit - (90 - 10 - 6)) < 1e-9);
  assert.equal(o.window.key, 'hot');
});
