// Session splitting: a gap longer than `gapMinutes` between consecutive events starts a new session.
import { num } from '../schema.js';
import { costOf, returnedOf, sortByTime, validEvents } from './core.js';

/**
 * Split time-sorted events into sessions (arrays of events).
 * A gap exactly equal to the limit does not split.
 * @param {object[]} sorted events sorted by ts
 * @param {number} gapMinutes
 * @returns {object[][]}
 */
export function sessionize(sorted, gapMinutes = 30) {
  const gapMs = gapMinutes * 60000;
  const out = [];
  let prevTs = null;
  for (const e of sorted) {
    const ts = num(e.ts);
    if (prevTs === null || ts - prevTs > gapMs) out.push([]);
    out[out.length - 1].push(e);
    prevTs = ts;
  }
  return out;
}

/**
 * Sessions with their totals.
 * @param {object[]} events
 * @param {number} [gapMinutes]
 * @returns {Array<{start:number,end:number,n:number,cost:number,returned:number,net:number,kinds:{case:number,upgrade:number}}>}
 */
export function sessions(events, gapMinutes = 30) {
  return sessionize(sortByTime(validEvents(events)), gapMinutes).map((evs) => {
    let cost = 0;
    let returned = 0;
    const kinds = { case: 0, upgrade: 0 };
    for (const e of evs) {
      cost += costOf(e);
      returned += returnedOf(e);
      kinds[e.kind]++;
    }
    return { start: num(evs[0].ts), end: num(evs[evs.length - 1].ts), n: evs.length, cost, returned, net: returned - cost, kinds };
  });
}
