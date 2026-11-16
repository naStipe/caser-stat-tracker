import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upgradeSessions, lossRunProbability, longestLossRun } from '../src/stats/index.js';
import { caseEvent, depositEvent, mulberry32, upgradeEvent } from './fixtures.js';

const T = new Date(2026, 0, 5, 12).getTime();
const MIN = 60000;
const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `expected ${a} to be within ${tol} of ${b}`);

test('upgradeSessions is safe on empty input', () => {
  for (const input of [[], null, undefined]) {
    const r = upgradeSessions(input);
    assert.equal(r.gapMinutes, 60);
    assert.deepEqual(r.sessions, []);
    assert.equal(r.summary.sessions, 0);
    assert.equal(r.summary.spreadP, null);
    assert.deepEqual(r.streaks, []);
  }
});

test('a deposit or case open inside the hour keeps the session going', () => {
  const events = [
    upgradeEvent({ ts: T, chanceShown: 10 }),
    depositEvent({ ts: T + 50 * MIN }),
    upgradeEvent({ ts: T + 100 * MIN, chanceShown: 10, won: true }),
    caseEvent({ ts: T + 160 * MIN }), // exactly 60 minutes: no split
    upgradeEvent({ ts: T + 300 * MIN, chanceShown: 20 }), // 140 minutes later: new session
    caseEvent({ ts: T + 500 * MIN }), // session with no upgrades is dropped
  ];
  const r = upgradeSessions(events);
  assert.equal(r.sessions.length, 2);
  const [late, early] = r.sessions; // newest first
  assert.equal(early.upgrades, 2);
  assert.equal(early.deposits, 1);
  assert.equal(early.deposited, 1000);
  assert.equal(early.cases, 1);
  assert.equal(early.wins, 1);
  close(early.expectedWins, 0.2);
  assert.equal(early.end, T + 160 * MIN);
  assert.equal(late.upgrades, 1);
  assert.equal(upgradeSessions(events, { gapMinutes: 30 }).sessions.length, 3);
});

test('mystery, super-drop and pending upgrades stay out of the odds test', () => {
  const events = [
    upgradeEvent({ ts: T, chanceShown: 10 }),
    upgradeEvent({ ts: T + MIN, mystery: true, won: true }),
    upgradeEvent({ ts: T + 2 * MIN, chanceShown: 10, won: true, superDrop: { shown: true, won: true, item: null } }),
    upgradeEvent({ ts: T + 3 * MIN, chanceShown: 10, status: 'pending' }),
  ];
  const [s] = upgradeSessions(events).sessions;
  assert.equal(s.upgrades, 3);
  assert.equal(s.oddsN, 1);
  assert.equal(s.wins, 0);
});

test('longestLossRun and lossRunProbability', () => {
  const ups = [...'LLWLLLWL'].map((c, i) => upgradeEvent({ ts: i, chanceShown: 50, won: c === 'W' }));
  assert.equal(longestLossRun(ups), 3);
  assert.equal(lossRunProbability([0.5, 0.5], 0), 1);
  assert.equal(lossRunProbability([0.5, 0.5], 3), 0);
  close(lossRunProbability([0.1, 0.1, 0.1], 3), 0.9 ** 3);
  // Two trials at p=0.5, at least one loss: 1 - 0.25.
  close(lossRunProbability([0.5, 0.5], 1), 0.75);
  // Three fair trials, a run of 2 losses or more: LLx, WLL -> 0.25 + 0.125.
  close(lossRunProbability([0.5, 0.5, 0.5], 2), 0.375);
  // Matches simulation for a longer mixed sequence.
  const ps = Array.from({ length: 60 }, (_, i) => (i % 2 ? 0.1 : 0.2));
  const rnd = mulberry32(7);
  let hits = 0;
  const N = 20000;
  for (let t = 0; t < N; t++) {
    let run = 0;
    let hit = false;
    for (const p of ps) {
      run = rnd() < p ? 0 : run + 1;
      if (run >= 12) hit = true;
    }
    if (hit) hits++;
  }
  close(lossRunProbability(ps, 12), hits / N, 0.015);
});

test('fair random upgrades look like luck: streak shares match the geometric rate', () => {
  const rnd = mulberry32(42);
  const events = [];
  let ts = T;
  for (let s = 0; s < 40; s++) {
    for (let i = 0; i < 150; i++) {
      const c = i % 3 ? 10 : 20;
      events.push(upgradeEvent({ ts, chanceShown: c, won: rnd() < c / 100 }));
      ts += MIN;
    }
    ts += 3 * 60 * MIN;
  }
  const r = upgradeSessions(events);
  assert.equal(r.sessions.length, 40);
  assert.equal(r.summary.tested, 40);
  assert.ok(r.summary.spreadP > 0.01, `spread p ${r.summary.spreadP}`);
  assert.ok(r.summary.significantBelow + r.summary.significantAbove <= 1);
  const ten = r.streaks.find((x) => x.lo === 10);
  assert.ok(ten.stretches > 300);
  assert.ok(Math.abs(ten.share[10] - ten.expected[10]) < 0.06, `${ten.share[10]} vs ${ten.expected[10]}`);
});

test('a session rigged against the player is flagged below odds', () => {
  const events = [];
  for (let i = 0; i < 200; i++) events.push(upgradeEvent({ ts: T + i * MIN, chanceShown: 20, won: i % 25 === 0 })); // 4% real
  const [s] = upgradeSessions(events).sessions;
  assert.equal(s.significant, true);
  assert.ok(s.z < 0);
  assert.equal(s.longestLosses, 24);
  assert.ok(s.longestP > 0 && s.longestP < 1);
  assert.equal(s.byChance.length, 1);
  assert.equal(s.byChance[0].label, '20-30%');
});
