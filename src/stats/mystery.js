// Mystery upgrades: hidden chance, so only the received multiplier (wonItem.price / stake) can be studied.
import { num } from '../schema.js';
import { baseMetrics, groupByBucket, isMystery, makeBuckets, returnedOf, upgradeEvents } from './core.js';
import { mean, median, oneWayAnova, wilson } from './math.js';

const DEFAULT_MYSTERY_STAKE_EDGES = [0, 100, 500, 1000, 3000, Infinity];
const MULTIPLIER_BINS = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, Infinity];

/** Multiplier the site reports, else returned / stake; null when neither exists. */
function multiplierOf(e) {
  if (e.mysteryMultiplier !== null && e.mysteryMultiplier !== undefined && Number.isFinite(num(e.mysteryMultiplier))) {
    return num(e.mysteryMultiplier);
  }
  return num(e.stake) > 0 ? returnedOf(e) / num(e.stake) : null;
}

const multipliersOf = (evs) => evs.map(multiplierOf).filter((m) => m !== null);

function hitFields(mults) {
  const hits = mults.filter((m) => m >= 1).length;
  return {
    hitRate: mults.length ? hits / mults.length : null,
    hitRateCI: mults.length ? wilson(hits, mults.length) : null,
    meanMultiplier: mean(mults),
    medianMultiplier: mults.length ? median(mults) : null,
  };
}

/**
 * Results of settled mystery upgrades: ROI, hit rate (multiplier >= 1) with Wilson interval,
 * multiplier histogram and a by-stake table. `test` is a one-way ANOVA of the per-event multiplier
 * across stake buckets (does the mean multiplier depend on the stake?).
 * @param {object[]} events
 * @param {number[]} [stakeEdges]
 */
export function mysteryStats(events, stakeEdges = DEFAULT_MYSTERY_STAKE_EDGES) {
  const mys = upgradeEvents(events).filter(isMystery);
  const mults = multipliersOf(mys);
  const binned = groupByBucket(mults, MULTIPLIER_BINS, (m) => m);
  const histogram = makeBuckets(MULTIPLIER_BINS).map((b, i) => ({
    label: `x${b.label}`, lo: b.lo, hi: b.hi, n: binned[i].length,
  }));
  const groups = groupByBucket(mys, stakeEdges, (e) => num(e.stake));
  const byStake = makeBuckets(stakeEdges).map((b, i) => {
    const h = hitFields(multipliersOf(groups[i]));
    return { label: b.label, lo: b.lo, hi: b.hi, ...baseMetrics(groups[i]), hitRate: h.hitRate, meanMultiplier: h.meanMultiplier };
  });
  const a = oneWayAnova(groups.map(multipliersOf));
  return {
    ...baseMetrics(mys),
    ...hitFields(mults),
    histogram,
    byStake,
    test: { method: 'anova', statistic: a.statistic, df: a.df, dfWithin: a.dfWithin, p: a.p },
  };
}
