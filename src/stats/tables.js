// Summary and per-group tables: summarize, caseRoi, upgradeByChance, upgradeByStake.
import { num } from '../schema.js';
import {
  DEFAULT_CHANCE_EDGES, DEFAULT_STAKE_EDGES, baseMetrics, caseEvents, groupByBucket, makeBuckets,
  markSignificant, oddsEvents, sortByTime, upgradeEvents, upgradeMetrics, validEvents,
} from './core.js';
import { median } from './math.js';

/**
 * Overall numbers for cases, upgrades and both together. Money metrics cover every settled upgrade
 * (mystery and super-drop included); the win fields cover only odds-eligible ones (`oddsN`).
 * @param {object[]} events
 * @returns {{cases:object, upgrades:object, total:object, firstTs:number|null, lastTs:number|null}}
 */
export function summarize(events) {
  const all = sortByTime(validEvents(events));
  return {
    cases: baseMetrics(caseEvents(events)),
    upgrades: upgradeMetrics(upgradeEvents(events)),
    total: baseMetrics(all),
    firstTs: all.length ? num(all[0].ts) : null,
    lastTs: all.length ? num(all[all.length - 1].ts) : null,
  };
}

function bestDrop(evs) {
  let best = null;
  for (const e of evs) {
    if (e.item && (best === null || num(e.item.price) > num(best.price))) best = e.item;
  }
  return best;
}

/**
 * One row per case: ROI, best drop, median drop price and hit rate.
 * casePrice and caseName come from the most recent open. hitRate is the share of
 * drops worth at least the price paid for that open. Sorted by n, largest first.
 * @param {object[]} events
 */
export function caseRoi(events) {
  const groups = new Map();
  for (const e of sortByTime(caseEvents(events))) {
    if (!groups.has(e.caseSlug)) groups.set(e.caseSlug, []);
    groups.get(e.caseSlug).push(e);
  }
  const rows = [];
  for (const [caseSlug, evs] of groups) {
    const latest = evs[evs.length - 1];
    const prices = evs.map((e) => num(e.item && e.item.price));
    rows.push({
      ...baseMetrics(evs),
      caseSlug,
      caseName: latest.caseName,
      casePrice: num(latest.casePrice),
      best: bestDrop(evs),
      median: median(prices),
      hitRate: evs.filter((e) => num(e.item && e.item.price) >= num(e.casePrice)).length / evs.length,
    });
  }
  return rows.sort((a, b) => b.n - a.n);
}

function bucketTable(events, edges, valueOf, suffix, opts) {
  const ups = oddsEvents(events, opts);
  const groups = groupByBucket(ups, edges, valueOf);
  const rows = makeBuckets(edges, suffix).map((b, i) => ({ label: b.label, lo: b.lo, hi: b.hi, ...upgradeMetrics(groups[i], opts) }));
  return markSignificant(rows);
}

/**
 * Upgrades bucketed by shown chance (percent): [lo, hi), the last bucket includes hi.
 * Every bucket gets a row, empty ones included. Holm-corrected `significant` per table.
 * @param {object[]} events
 * Normal upgrades only; super-drop-shown ones are excluded unless opts.includeSuperDrop.
 * @param {number[]} [edges]
 * @param {{includeSuperDrop?:boolean}} [opts]
 */
export function upgradeByChance(events, edges = DEFAULT_CHANCE_EDGES, opts = {}) {
  return bucketTable(events, edges, (e) => num(e.chanceShown), '%', opts);
}

/**
 * Upgrades bucketed by stake.
 * @param {object[]} events
 * Same upgrade selection as upgradeByChance.
 * @param {number[]} [edges]
 * @param {{includeSuperDrop?:boolean}} [opts]
 */
export function upgradeByStake(events, edges = DEFAULT_STAKE_EDGES, opts = {}) {
  return bucketTable(events, edges, (e) => num(e.stake), '', opts);
}
