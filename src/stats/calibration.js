// Calibration of shown odds, edge map by chance bucket, and the single-upgrade quote.
import { num, shownChance } from '../schema.js';
import {
  ALPHA, DEFAULT_CHANCE_EDGES, DEFAULT_CURVE_EDGES, DEFAULT_STAKE_EDGES, baseMetrics, bucketIndex, chanceOf, groupByBucket, isWin,
  makeBuckets, markSignificant, oddsEvents, targetPriceOf, winMetrics,
} from './core.js';
import { binomialPmf, mean, pmfQuantile, wilson } from './math.js';

const MIN_N_FOR_EDGE = 30;
const LONG_RUN_TRIES = 100;

/**
 * Test of all settled upgrades: do wins match the odds the site showed?
 * verdict 'below' / 'above' when the two-sided p < 0.05 (sign of z decides), else 'consistent'.
 * impliedRtp = returned / cost, null when cost is 0.
 * Normal upgrades only; super-drop-shown ones are excluded unless opts.includeSuperDrop.
 * @param {object[]} events
 * @param {{includeSuperDrop?:boolean}} [opts]
 */
export function calibration(events, opts = {}) {
  const ups = oddsEvents(events, opts);
  const w = winMetrics(ups);
  const base = baseMetrics(ups);
  let verdict = 'consistent';
  if (w.p !== null && w.p < ALPHA) verdict = w.z < 0 ? 'below' : 'above';
  return {
    n: ups.length,
    wins: w.wins,
    expectedWins: ups.reduce((s, e) => s + chanceOf(e), 0),
    winRate: w.winRate,
    expectedRate: w.expectedRate,
    z: w.z,
    p: w.p,
    verdict,
    impliedRtp: base.cost > 0 ? base.returned / base.cost : null,
  };
}

function shownRtpOf(ups) {
  const vals = ups
    .filter((e) => targetPriceOf(e) > 0 && num(e.stake) > 0)
    .map((e) => (chanceOf(e) * targetPriceOf(e)) / num(e.stake));
  return mean(vals);
}

/**
 * Promised vs realised return per chance bucket.
 * Empty bucket+mode combinations are left out. realRtpCI is the roi interval + 1.
 * @param {object[]} events
 * Normal upgrades only (mystery has no shown chance), so every row has mode 'normal'.
 * @param {number[]} [edges]
 * @param {{includeSuperDrop?:boolean}} [opts]
 */
export function edgeMap(events, edges = DEFAULT_CHANCE_EDGES, opts = {}) {
  const ups = oddsEvents(events, opts);
  const rows = [];
  const groups = groupByBucket(ups, edges, (e) => num(e.chanceShown));
  for (const [i, b] of makeBuckets(edges, '%').entries()) {
    const inBucket = groups[i];
    for (const mode of ['normal']) {
      const evs = inBucket;
      if (!evs.length) continue;
      const m = baseMetrics(evs);
      rows.push({
        label: b.label,
        lo: b.lo,
        hi: b.hi,
        n: m.n,
        shownRtp: shownRtpOf(evs),
        realRtp: m.cost > 0 ? m.returned / m.cost : null,
        realRtpCI: m.roiCI ? [m.roiCI[0] + 1, m.roiCI[1] + 1] : null,
        mode,
      });
    }
  }
  return rows;
}

/** Exact binomial over identical tries: net(k) = k·targetPrice - tries·stake. */
function longRun(stake, targetPrice, chance) {
  const empty = { tries: LONG_RUN_TRIES, mean: null, p05: null, p95: null, probProfit: null };
  if (!(stake > 0) || !(targetPrice > 0)) return empty;
  const pmf = binomialPmf(LONG_RUN_TRIES, Math.min(Math.max(chance / 100, 0), 1));
  const net = (k) => k * targetPrice - LONG_RUN_TRIES * stake;
  const tol = 1e-9 * Math.max(1, LONG_RUN_TRIES * stake);
  let probProfit = 0;
  pmf.forEach((pk, k) => { if (net(k) > tol) probProfit += pk; });
  const meanNet = pmf.reduce((s, pk, k) => s + pk * net(k), 0);
  return {
    tries: LONG_RUN_TRIES,
    mean: meanNet,
    p05: net(pmfQuantile(pmf, 0.05)),
    p95: net(pmfQuantile(pmf, 0.95)),
    probProfit: Math.min(probProfit, 1),
  };
}

/**
 * Quote for one planned upgrade: shown vs fair odds, expected value, what history says
 * about similar bets, and a 100-try long-run distribution.
 * realEdge needs >= 30 past upgrades in the same chance bucket; `similar` also matches the stake bucket.
 * @param {{stake:number, targetPrice:number, chanceShown?:number|null}} sel
 * History uses normal upgrades; super-drop-shown ones are excluded unless opts.includeSuperDrop.
 * @param {object[]} events
 * @param {{includeSuperDrop?:boolean}} [opts]
 */
export function upgradeQuote(sel, events, opts = {}) {
  const stake = num(sel && sel.stake);
  const targetPrice = num(sel && sel.targetPrice);
  const given = sel && sel.chanceShown != null ? num(sel.chanceShown) : null;
  const chanceShown = given !== null ? given : shownChance(stake, targetPrice);
  const ev = (chanceShown / 100) * targetPrice - stake;

  const ups = oddsEvents(events, opts);
  const chanceBucket = bucketIndex(chanceShown, DEFAULT_CHANCE_EDGES);
  const sameChance = chanceBucket < 0 ? [] : ups.filter((e) => bucketIndex(num(e.chanceShown), DEFAULT_CHANCE_EDGES) === chanceBucket);
  const stakeBucket = bucketIndex(stake, DEFAULT_STAKE_EDGES);
  const similar = stakeBucket < 0 ? [] : sameChance.filter((e) => bucketIndex(num(e.stake), DEFAULT_STAKE_EDGES) === stakeBucket);

  const edgeBase = baseMetrics(sameChance);
  const wins = similar.filter(isWin).length;
  const realEdge = sameChance.length >= MIN_N_FOR_EDGE && edgeBase.cost > 0 ? edgeBase.returned / edgeBase.cost - 1 : null;
  // With enough history, project the long run from the return actually achieved at these odds
  // (the shown odds always promise about +3%, so projecting from them would mislead).
  const longRunChance = realEdge !== null && targetPrice > 0 ? (1 + realEdge) * (stake / targetPrice) * 100 : chanceShown;
  return {
    chanceShown,
    chanceFair: stake > 0 && targetPrice > 0 ? (stake / targetPrice) * 100 : 0,
    multiplier: stake > 0 ? targetPrice / stake : 0,
    ev,
    evPct: stake > 0 ? ev / stake : null,
    realEdge,
    similar: {
      n: similar.length,
      wins,
      winRate: similar.length ? wins / similar.length : null,
      winRateCI: similar.length ? wilson(wins, similar.length) : null,
    },
    longRun: { ...longRun(stake, targetPrice, longRunChance), basis: realEdge !== null ? 'history' : 'shown' },
  };
}

/**
 * Shown chance vs real win rate per chance bucket: the key calibration table.
 * Normal upgrades only; super-drop-shown ones are excluded unless opts.includeSuperDrop.
 * Every bucket gets a row (empty ones have n = 0 and null stats); `significant` is Holm-corrected
 * across the rows, rows with n < 10 never significant. realRtp = returned / cost, null at cost 0.
 * @param {object[]} events
 * @param {number[]} [edges]
 * @param {{includeSuperDrop?:boolean}} [opts]
 */
export function calibrationCurve(events, edges = DEFAULT_CURVE_EDGES, opts = {}) {
  const groups = groupByBucket(oddsEvents(events, opts), edges, (e) => num(e.chanceShown));
  const rows = makeBuckets(edges, '%').map((b, i) => {
    const evs = groups[i];
    const m = baseMetrics(evs);
    const w = winMetrics(evs);
    return {
      label: b.label, lo: b.lo, hi: b.hi, n: evs.length,
      wins: w.wins, expectedRate: w.expectedRate, winRate: w.winRate, winRateCI: w.winRateCI,
      z: w.z, p: w.p, significant: false,
      realRtp: m.cost > 0 ? m.returned / m.cost : null,
    };
  });
  return markSignificant(rows);
}

const MIN_CURVE_N = 30;

/**
 * Expected win probability per event from a calibration curve: the real win rate of the event's
 * bucket when that bucket has at least 30 events, else the shown chance.
 * @param {ReturnType<typeof calibrationCurve>} curve
 * @param {number[]} [edges] the edges the curve was built with
 * @returns {(e:object) => number}
 */
export function curveLookup(curve, edges = DEFAULT_CURVE_EDGES) {
  return (e) => {
    const i = bucketIndex(num(e.chanceShown), edges);
    const row = i >= 0 ? curve[i] : null;
    return row && row.n >= MIN_CURVE_N && row.winRate !== null ? row.winRate : chanceOf(e);
  };
}
