// Upgrade sessions: per-session win rate against the shown odds, and loss streaks against what luck produces.
// A session ends after `gapMinutes` (default 60) with no upgrade, case open or deposit.
import { num } from '../schema.js';
import {
  ALPHA,
  DEFAULT_CHANCE_EDGES,
  MIN_N,
  baseMetrics,
  bucketIndex,
  chanceOf,
  isOdds,
  isWin,
  makeBuckets,
  sortByTime,
  winMetrics,
} from './core.js';
import { chiSquareSf, holm } from './math.js';
import { sessionize } from './sessions.js';

export const UPGRADE_SESSION_GAP_MIN = 60;
/** Loss-run lengths shown in the streak table. */
export const STREAK_LENGTHS = [5, 10, 15, 20, 30];

const isActivity = (e) => e && typeof e === 'object' && (e.kind === 'upgrade' || e.kind === 'case' || e.kind === 'deposit');
const isSettledUpgrade = (e) => e.kind === 'upgrade' && e.status !== 'pending';

/** Longest run of losses in a list of upgrades (in the given order). */
export function longestLossRun(ups) {
  let best = 0;
  let run = 0;
  for (const e of ups) {
    run = isWin(e) ? 0 : run + 1;
    if (run > best) best = run;
  }
  return best;
}

/**
 * Probability that independent trials with win chances ps contain at least one run of
 * `len` or more losses in a row. Exact, O(n·len). 1 for len <= 0, 0 when len > n.
 * @param {number[]} ps win probabilities in [0, 1], in order
 * @param {number} len
 */
export function lossRunProbability(ps, len) {
  if (!(len > 0)) return 1;
  if (len > ps.length) return 0;
  // f[r] = probability that the current trailing loss run is r (r < len) and no run of len has happened yet.
  let f = new Float64Array(len);
  f[0] = 1;
  let hit = 0;
  for (const p0 of ps) {
    const p = Math.min(Math.max(num(p0), 0), 1);
    const q = 1 - p;
    const g = new Float64Array(len);
    let alive = 0;
    for (let r = 0; r < len; r++) alive += f[r];
    g[0] = alive * p;
    for (let r = 0; r + 1 < len; r++) g[r + 1] = f[r] * q;
    hit += f[len - 1] * q;
    f = g;
  }
  return Math.min(Math.max(hit, 0), 1);
}

function bucketRows(odds, edges) {
  const buckets = makeBuckets(edges, '%');
  const groups = buckets.map(() => []);
  for (const e of odds) {
    const i = bucketIndex(num(e.chanceShown), edges);
    if (i >= 0) groups[i].push(e);
  }
  return buckets
    .map((b, i) => {
      const g = groups[i];
      if (!g.length) return null;
      const w = winMetrics(g);
      const longest = longestLossRun(g);
      return {
        label: b.label,
        lo: b.lo,
        hi: b.hi,
        n: g.length,
        wins: w.wins,
        winRate: w.winRate,
        expectedRate: w.expectedRate,
        expectedWins: g.reduce((s, e) => s + chanceOf(e), 0),
        longestLosses: longest,
        longestP: lossRunProbability(g.map(chanceOf), longest),
      };
    })
    .filter(Boolean);
}

/**
 * Loss streaks over all normal upgrades, per shown-chance bucket.
 * For each bucket the upgrades are taken in time order (other buckets are skipped) and every stretch
 * of losses that ends in a win, or runs to the end, counts as one stretch.
 * share[k] = share of stretches with at least k losses before the win; expected[k] = (1 - mean chance)^k,
 * the same share if every upgrade were an independent draw at the shown chance.
 */
function streakTable(odds, edges) {
  const buckets = makeBuckets(edges, '%');
  const groups = buckets.map(() => []);
  for (const e of odds) {
    const i = bucketIndex(num(e.chanceShown), edges);
    if (i >= 0) groups[i].push(e);
  }
  return buckets
    .map((b, i) => {
      const g = groups[i];
      if (!g.length) return null;
      const stretches = [];
      let run = 0;
      for (const e of g) {
        if (isWin(e)) {
          stretches.push(run);
          run = 0;
        } else run++;
      }
      if (run > 0) stretches.push(run);
      const meanP = g.reduce((s, e) => s + chanceOf(e), 0) / g.length;
      const share = {};
      const expected = {};
      for (const k of STREAK_LENGTHS) {
        share[k] = stretches.length ? stretches.filter((x) => x >= k).length / stretches.length : null;
        expected[k] = Math.pow(1 - meanP, k);
      }
      const longest = stretches.length ? Math.max(...stretches) : 0;
      return {
        label: b.label,
        lo: b.lo,
        hi: b.hi,
        n: g.length,
        stretches: stretches.length,
        meanChance: meanP,
        share,
        expected,
        longestLosses: longest,
        longestP: lossRunProbability(g.map(chanceOf), longest),
      };
    })
    .filter(Boolean);
}

/**
 * Upgrade sessions with per-session odds tests, plus a summary of whether sessions vary more than luck.
 * Win rates use normal upgrades without the super-drop card (isOdds), like the rest of the tracker.
 * @param {object[]} events every event (upgrades, cases, deposits; others are ignored)
 * @param {{gapMinutes?:number, chanceEdges?:number[]}} [opts]
 */
export function upgradeSessions(events, opts = {}) {
  const gapMinutes = num(opts.gapMinutes) > 0 ? num(opts.gapMinutes) : UPGRADE_SESSION_GAP_MIN;
  const edges = Array.isArray(opts.chanceEdges) && opts.chanceEdges.length >= 2 ? opts.chanceEdges : DEFAULT_CHANCE_EDGES;
  const list = Array.isArray(events) ? events.filter(isActivity) : [];
  const sorted = sortByTime(list);
  const allOdds = [];

  const rows = [];
  for (const evs of sessionize(sorted, gapMinutes)) {
    const ups = evs.filter(isSettledUpgrade);
    if (!ups.length) continue;
    const odds = ups.filter((e) => isOdds(e));
    allOdds.push(...odds);
    const base = baseMetrics(ups);
    const win = winMetrics(odds);
    const deposits = evs.filter((e) => e.kind === 'deposit' && e.status === 'completed');
    const longest = longestLossRun(odds);
    rows.push({
      start: num(evs[0].ts),
      end: num(evs[evs.length - 1].ts),
      upgrades: ups.length,
      cases: evs.filter((e) => e.kind === 'case').length,
      deposits: deposits.length,
      deposited: deposits.reduce((s, e) => s + num(e.amount), 0),
      cost: base.cost,
      returned: base.returned,
      net: base.net,
      rtp: base.cost > 0 ? base.returned / base.cost : null,
      oddsN: odds.length,
      n: odds.length,
      wins: win.wins,
      winRate: win.winRate,
      winRateCI: win.winRateCI,
      expectedRate: win.expectedRate,
      expectedWins: odds.reduce((s, e) => s + chanceOf(e), 0),
      z: win.z,
      p: win.p,
      significant: false,
      longestLosses: longest,
      longestP: lossRunProbability(odds.map(chanceOf), longest),
      byChance: bucketRows(odds, edges),
    });
  }

  // Holm across sessions with enough upgrades.
  const eligible = rows.filter((r) => r.oddsN >= MIN_N && Number.isFinite(r.p));
  const flags = holm(eligible.map((r) => r.p), ALPHA);
  eligible.forEach((r, i) => { r.significant = flags[i]; });

  // How often sessions look unlucky / lucky at p < 0.05 without correction; luck alone gives about 2.5% each.
  const below = eligible.filter((r) => r.p < ALPHA && r.z < 0).length;
  const above = eligible.filter((r) => r.p < ALPHA && r.z > 0).length;
  const zs = eligible.map((r) => r.z).filter(Number.isFinite);
  const chi = zs.reduce((s, z) => s + z * z, 0);
  const all = winMetrics(allOdds);
  const summary = {
    sessions: rows.length,
    tested: eligible.length,
    below,
    above,
    expectedEachSide: eligible.length * (ALPHA / 2),
    significantBelow: eligible.filter((r) => r.significant && r.z < 0).length,
    significantAbove: eligible.filter((r) => r.significant && r.z > 0).length,
    unluckyShare: zs.length ? zs.filter((z) => z < 0).length / zs.length : null,
    // Sum of z² over sessions ~ chi-square(k) if every session is luck around the shown odds.
    // A small p means sessions swing more than luck allows (some rigged against you, some for).
    spreadChi: zs.length ? chi : null,
    spreadDf: zs.length,
    spreadP: zs.length ? chiSquareSf(chi, zs.length) : null,
    n: allOdds.length,
    wins: all.wins,
    winRate: all.winRate,
    expectedRate: all.expectedRate,
    expectedWins: allOdds.reduce((s, e) => s + chanceOf(e), 0),
    z: all.z,
    p: all.p,
  };

  rows.sort((a, b) => b.start - a.start);
  return { gapMinutes, summary, sessions: rows, streaks: streakTable(sortByTime(allOdds), edges) };
}
