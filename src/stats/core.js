// Shared event filters, metric blocks and bucket helpers.
import { num } from '../schema.js';
import { holm, mean, poissonBinomialZ, sampleSd, wilson } from './math.js';

export const ALPHA = 0.05;
/** Rows with fewer events than this are never flagged significant. */
export const MIN_N = 10;
export const DEFAULT_CHANCE_EDGES = [0, 2, 5, 10, 20, 30, 50, 75, 100];
export const DEFAULT_STAKE_EDGES = [0, 100, 500, 1000, 5000, 20000, Infinity];
export const DEFAULT_CURVE_EDGES = [0, 10, 15, 20, 30, 50, 75, 100];

const Z95 = 1.96;

// ---- event selection ------------------------------------------------------

function asList(events) {
  return Array.isArray(events) ? events.filter((e) => e && typeof e === 'object') : [];
}

/** Case events. */
export function caseEvents(events) {
  return asList(events).filter((e) => e.kind === 'case');
}

/** Upgrade events that are settled (pending ones are ignored everywhere). */
export function upgradeEvents(events) {
  return asList(events).filter((e) => e.kind === 'upgrade' && e.status !== 'pending');
}

/** Every event a stat may look at: cases plus settled upgrades. */
export function validEvents(events) {
  return asList(events).filter((e) => e.kind === 'case' || (e.kind === 'upgrade' && e.status !== 'pending'));
}

/** Copy sorted by timestamp (stable for equal timestamps). */
export function sortByTime(events) {
  return [...events].sort((a, b) => num(a.ts) - num(b.ts));
}

// ---- per-event accessors --------------------------------------------------

export const costOf = (e) => (e.kind === 'case' ? num(e.casePrice) : num(e.stake));
export const returnedOf = (e) => (e.kind === 'case' ? num(e.item && e.item.price) : num(e.returned));
export const isWin = (e) => e.status === 'won' || (e.status == null && e.won === true);
/** Shown chance as a probability in [0, 1]. */
export const chanceOf = (e) => Math.min(Math.max(num(e.chanceShown) / 100, 0), 1);
export const targetPriceOf = (e) => num(e.target && e.target.price);
export const isMystery = (e) => e.mystery === true;
export const superShown = (e) => !!(e.superDrop && e.superDrop.shown);
export const hasChance = (e) => typeof e.chanceShown === 'number' && Number.isFinite(e.chanceShown);

/**
 * True for upgrades that can be tested against the shown odds: not mystery (no chance),
 * with a shown chance, and without the super-drop card unless opts.includeSuperDrop.
 */
export function isOdds(e, opts) {
  return !isMystery(e) && hasChance(e) && (!!(opts && opts.includeSuperDrop) || !superShown(e));
}

/** Settled upgrades that pass isOdds(). */
export function oddsEvents(events, opts) {
  return upgradeEvents(events).filter((e) => isOdds(e, opts));
}

// ---- metric blocks --------------------------------------------------------

/**
 * Cost, return and ROI with a 95% interval.
 * The interval is the normal approximation on the per-event return ratio
 * (returned / cost for events with cost > 0): mean ± 1.96·sd/√n, minus 1.
 * @param {object[]} events case or settled upgrade events
 */
export function baseMetrics(events) {
  let cost = 0;
  let returned = 0;
  const ratios = [];
  for (const e of events) {
    const c = costOf(e);
    const r = returnedOf(e);
    cost += c;
    returned += r;
    if (c > 0) ratios.push(r / c);
  }
  return {
    n: events.length,
    cost,
    returned,
    net: returned - cost,
    roi: cost > 0 ? (returned - cost) / cost : null,
    roiCI: cost > 0 ? ratioInterval(ratios) : null,
  };
}

/** [lo, hi] for roi from per-event ratios, null with fewer than 2 samples. */
export function ratioInterval(ratios) {
  if (ratios.length < 2) return null;
  const half = (Z95 * sampleSd(ratios)) / Math.sqrt(ratios.length);
  const m = mean(ratios);
  return [m - half - 1, m + half - 1];
}

/**
 * Upgrade-only fields: win rate with Wilson interval and the test of wins
 * against the sum of per-event shown chances (Poisson-binomial normal approximation).
 * `significant` starts false; markSignificant() sets it per table.
 * @param {object[]} ups settled upgrade events
 */
export function winMetrics(ups) {
  const n = ups.length;
  let wins = 0;
  let sumP = 0;
  let sumVar = 0;
  for (const e of ups) {
    const p = chanceOf(e);
    if (isWin(e)) wins++;
    sumP += p;
    sumVar += p * (1 - p);
  }
  const { z, p } = poissonBinomialZ(wins, sumP, sumVar);
  return {
    wins,
    winRate: n ? wins / n : null,
    winRateCI: n ? wilson(wins, n) : null,
    expectedRate: n ? sumP / n : null,
    z,
    p,
    significant: false,
  };
}

/** winMetrics over the odds-eligible part of ups, plus oddsN (how many events that was). */
export function winFields(ups, opts) {
  const odds = ups.filter((e) => isOdds(e, opts));
  return { ...winMetrics(odds), oddsN: odds.length };
}

/**
 * Same test as winMetrics but the expected win probability of each event is expectedOf(e),
 * e.g. the real win rate of its calibration bucket. Returns expectedRateAdj, zAdj, pAdj.
 */
export function adjustedWinFields(odds, expectedOf) {
  let wins = 0;
  let sumP = 0;
  let sumVar = 0;
  for (const e of odds) {
    const p = Math.min(Math.max(expectedOf(e), 0), 1);
    if (isWin(e)) wins++;
    sumP += p;
    sumVar += p * (1 - p);
  }
  const { z, p } = poissonBinomialZ(wins, sumP, sumVar);
  return { expectedRateAdj: odds.length ? sumP / odds.length : null, zAdj: z, pAdj: p, significantAdj: false };
}

/** Metrics block for upgrades: base fields over all given upgrades, win fields over the odds-eligible ones. */
export function upgradeMetrics(ups, opts) {
  return { ...baseMetrics(ups), ...winFields(ups, opts) };
}

/**
 * Set `significant` on the rows of one table using Holm correction.
 * Only rows with n >= MIN_N and a finite p enter the family; the rest stay false.
 * Eligibility uses `oddsN` when a row has it (rows may hold more than odds-eligible upgrades).
 * pKey / flagKey pick the p-value and flag to use (default p / significant).
 */
export function markSignificant(rows, alpha = ALPHA, pKey = 'p', flagKey = 'significant') {
  const eligible = rows.filter((r) => (r.oddsN ?? r.n) >= MIN_N && Number.isFinite(r[pKey]));
  const flags = holm(eligible.map((r) => r[pKey]), alpha);
  rows.forEach((r) => { if (flagKey in r) r[flagKey] = false; });
  eligible.forEach((r, i) => { r[flagKey] = flags[i]; });
  return rows;
}

// ---- buckets --------------------------------------------------------------

/** Index of the bucket for x: [edge_i, edge_i+1), last bucket includes its upper edge. -1 if outside. */
export function bucketIndex(x, edges) {
  const last = edges.length - 1;
  if (!(x >= edges[0]) || x > edges[last]) return -1;
  for (let i = 0; i < last; i++) {
    if (x < edges[i + 1]) return i;
  }
  return last - 1;
}

function edgeText(v) {
  return Number.isFinite(v) ? String(v) : '∞';
}

/** Bucket list with labels like "5-10%" or "20000+". */
export function makeBuckets(edges, suffix = '') {
  const out = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const lo = edges[i];
    const hi = edges[i + 1];
    const label = Number.isFinite(hi) ? `${edgeText(lo)}-${edgeText(hi)}${suffix}` : `${edgeText(lo)}+${suffix}`;
    out.push({ label, lo, hi });
  }
  return out;
}

/** Group items into per-bucket arrays; values outside the edges are dropped. */
export function groupByBucket(items, edges, valueOf) {
  const groups = makeBuckets(edges).map(() => []);
  for (const item of items) {
    const i = bucketIndex(valueOf(item), edges);
    if (i >= 0) groups[i].push(item);
  }
  return groups;
}
