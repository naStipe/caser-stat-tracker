// Super-drop card analysis: how often it shows, how much it lifts the win rate, how big the hits are.
import {
  baseMetrics, isOdds, returnedOf, superShown, targetPriceOf, upgradeEvents, winMetrics,
} from './core.js';
import { mean } from './math.js';

function part(evs) {
  const w = winMetrics(evs);
  const m = baseMetrics(evs);
  return {
    n: evs.length,
    wins: w.wins,
    winRate: w.winRate,
    expectedRate: w.expectedRate,
    z: w.z,
    p: w.p,
    rtp: m.cost > 0 ? m.returned / m.cost : null,
  };
}

/**
 * Upgrades with and without the super-drop card (normal upgrades only; mystery has no shown chance).
 * Win rates are tested against the shown chances. hits = super-drop wins, with
 * multiplier = received item price / target price.
 * @param {object[]} events
 */
export function superDropStats(events) {
  const ups = upgradeEvents(events).filter((e) => isOdds(e, { includeSuperDrop: true }));
  const shown = ups.filter(superShown);
  const notShown = ups.filter((e) => !superShown(e));
  const mults = shown
    .filter((e) => e.superDrop.won === true && targetPriceOf(e) > 0)
    .map((e) => returnedOf(e) / targetPriceOf(e));
  return {
    n: ups.length,
    shownN: shown.length,
    shownRate: ups.length ? shown.length / ups.length : null,
    shown: part(shown),
    notShown: part(notShown),
    hits: {
      n: mults.length,
      avgMultiplier: mean(mults),
      minMultiplier: mults.length ? Math.min(...mults) : null,
      maxMultiplier: mults.length ? Math.max(...mults) : null,
    },
  };
}
