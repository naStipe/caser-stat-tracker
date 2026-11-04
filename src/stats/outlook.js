// Outlook for one planned upgrade: is it likely to pay on average, given the shown chance AND
// the moment (time since the last completed deposit)? Both matter in real data: low chances
// right after a deposit win far more often than shown, high chances lose everywhere.
import { num, shownChance } from '../schema.js';
import { chanceOf, isWin, oddsEvents, sortByTime } from './core.js';
import { gammaQ } from './math.js';

/** Shown-chance bands (percent), [lo, hi); the last includes 100. */
export const OUTLOOK_CHANCE_EDGES = [0, 15, 30, 50, 75, 100];
/** Time-since-deposit windows (minutes): hot [0, 5), warm [5, 15), cold 15+ or no deposit. */
export const OUTLOOK_WINDOWS = [
  { key: 'hot', label: '0-5 min after deposit', lo: 0, hi: 5 },
  { key: 'warm', label: '5-15 min after deposit', lo: 5, hi: 15 },
  { key: 'cold', label: '15+ min after deposit', lo: 15, hi: Infinity },
];
/** Prior strength in expected wins: how much a cell is pulled toward its band (and a band toward the shown odds). */
const PRIOR = 20;
const MIN_BAND_N = 30;
const LIKELY = 0.8;

function bandOf(chance) {
  const e = OUTLOOK_CHANCE_EDGES;
  if (!(chance >= 0)) return -1;
  for (let i = 0; i < e.length - 1; i++) if (chance < e[i + 1]) return i;
  return chance <= e[e.length - 1] ? e.length - 2 : -1;
}

function windowOf(minutes) {
  if (minutes === null) return 2;
  for (let i = 0; i < OUTLOOK_WINDOWS.length; i++) if (minutes < OUTLOOK_WINDOWS[i].hi) return i;
  return OUTLOOK_WINDOWS.length - 1;
}

const bandLabel = (i) => `${OUTLOOK_CHANCE_EDGES[i]}-${OUTLOOK_CHANCE_EDGES[i + 1]}%`;

/**
 * The part of the outlook that depends only on history: deposit times, per band and window sums of
 * wins and expected wins, and a time-sorted list of money flows. Build it once per change of events
 * and pass it as opts.model to upgradeOutlook, which is then cheap enough to run on every selection.
 * @param {object[]} events
 */
export function outlookModel(events) {
  const list = Array.isArray(events) ? events.filter(Boolean) : [];
  const deposits = list
    .filter((e) => e.kind === 'deposit' && e.status === 'completed')
    .map((e) => num(e.completedTs) || num(e.ts))
    .filter((t) => t > 0)
    .sort((a, b) => a - b);

  // Per-cell sums: wins and expected wins (sum of shown chances).
  const cells = OUTLOOK_CHANCE_EDGES.slice(0, -1).map(() => OUTLOOK_WINDOWS.map(() => ({ n: 0, wins: 0, expected: 0, variance: 0 })));
  let di = 0;
  for (const e of sortByTime(oddsEvents(list))) {
    const ts = num(e.ts);
    while (di < deposits.length && deposits[di] <= ts) di++;
    const b = bandOf(num(e.chanceShown));
    if (b < 0) continue;
    const w = windowOf(di > 0 ? (ts - deposits[di - 1]) / 60000 : null);
    const c = cells[b][w];
    c.n++;
    const pe = chanceOf(e);
    c.expected += pe;
    c.variance += pe * (1 - pe);
    if (isWin(e)) c.wins++;
  }

  const flows = [];
  for (const e of list) {
    if (e.kind === 'upgrade' && e.status !== 'pending') flows.push({ ts: num(e.ts), upgrade: true, net: num(e.returned) - num(e.stake) });
    else if (e.kind === 'case') flows.push({ ts: num(e.ts), upgrade: false, net: num(e.item && e.item.price) - num(e.casePrice) });
  }
  flows.sort((a, b) => a.ts - b.ts);
  return { deposits, cells, flows };
}

/**
 * @param {{stake:number, targetPrice:number, chanceShown?:number|null}} sel
 * @param {object[]} events all stored events (upgrades and deposits are used)
 * @param {{now?:number, model?:ReturnType<typeof outlookModel>}} [opts] now: ms epoch of the planned upgrade
 *   (default Date.now()); model: a prebuilt outlookModel(events), events is then ignored
 * @returns {null | {
 *   chanceShown:number, band:string, window:{key:string,label:string},
 *   context:{minutesSinceDeposit:number|null, upgradesSinceDeposit:number|null, netSinceDeposit:number|null},
 *   ratio:number, realChance:number, ev:number, evPct:number, breakEvenRatio:number,
 *   probProfitable:number|null, verdict:'likely-profit'|'likely-loss'|'unclear'|'unknown',
 *   kelly:{ full:number, half:number }|null,   // stake as a fraction of bankroll; null when the band has < 30 upgrades
 *   cell:{n, wins, expected, variance}, bandStats:{n, wins, expected, variance},
 *   windows: Array<{key:string, label:string, n:number, ratio:number|null, realChance:number}>
 * }}
 * ratio = estimated real/shown win-rate ratio for this band and window (Gamma posterior mean).
 * probProfitable = posterior probability that the real chance beats break-even (EV > 0).
 * Super-drop-shown upgrades are left out of history, and EV ignores super-drop bonuses.
 */
export function upgradeOutlook(sel, events, opts = {}) {
  const stake = num(sel && sel.stake);
  const targetPrice = num(sel && sel.targetPrice);
  if (!(stake > 0) || !(targetPrice > 0)) return null;
  const given = sel && sel.chanceShown != null ? num(sel.chanceShown) : null;
  const chanceShown = given !== null && given > 0 ? given : shownChance(stake, targetPrice);
  const p = Math.min(Math.max(chanceShown / 100, 0), 1);
  const band = bandOf(chanceShown);
  if (band < 0 || !(p > 0)) return null;
  const now = opts.now != null ? num(opts.now) : Date.now();
  const model = opts.model || outlookModel(events);
  const { deposits, cells, flows } = model;

  // Context of the planned upgrade: flows are sorted by time, so scan only the part since the deposit.
  let last = null;
  for (let i = deposits.length - 1; i >= 0; i--) if (deposits[i] <= now) { last = deposits[i]; break; }
  const minutesSinceDeposit = last === null ? null : (now - last) / 60000;
  let upgradesSinceDeposit = null;
  let netSinceDeposit = null;
  if (last !== null) {
    upgradesSinceDeposit = 0;
    netSinceDeposit = 0;
    let lo = 0;
    let hi = flows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (flows[mid].ts < last) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < flows.length && flows[i].ts <= now; i++) {
      if (flows[i].upgrade) upgradesSinceDeposit++;
      netSinceDeposit += flows[i].net;
    }
  }

  const bandSum = cells[band].reduce((s, c) => ({ n: s.n + c.n, wins: s.wins + c.wins, expected: s.expected + c.expected, variance: s.variance + c.variance }), { n: 0, wins: 0, expected: 0, variance: 0 });
  const bandRatio = (bandSum.wins + PRIOR) / (bandSum.expected + PRIOR);
  // Gamma posterior on the real/shown ratio. Wins vary less than Poisson at high chances
  // (binomial variance sum p(1-p) < sum p), so both parameters are scaled by expected/variance.
  const posterior = (c) => {
    const f = c.variance > 0 ? c.expected / c.variance : 1 / (1 - p);
    return { a: (c.wins + PRIOR * bandRatio) * f, b: (c.expected + PRIOR) * f };
  };
  const win = windowOf(minutesSinceDeposit);
  const cell = cells[band][win];
  const { a, b } = posterior(cell);
  const ratio = a / b;
  const realChance = Math.min(1, p * ratio);
  const ev = realChance * targetPrice - stake;
  const breakEvenRatio = stake / (p * targetPrice);
  const known = bandSum.n >= MIN_BAND_N;
  const probProfitable = known ? gammaQ(a, b * breakEvenRatio) : null;
  let verdict = 'unknown';
  if (probProfitable !== null) verdict = probProfitable >= LIKELY ? 'likely-profit' : probProfitable <= 1 - LIKELY ? 'likely-loss' : 'unclear';

  // Kelly stake as a fraction of bankroll. Net odds b = multiplier - 1 (profit per 1 staked on a win).
  // f = p - (1 - p) / b, clamped to 0. Zero or negative edge -> 0. Half Kelly is the practical default:
  // the real chance is only an estimate, so half gives almost the same growth with much less swing.
  const mult = stake > 0 ? targetPrice / stake : 0;
  const b2 = mult - 1;
  const kellyFull = known && b2 > 0 ? Math.max(0, Math.min(1, realChance - (1 - realChance) / b2)) : 0;
  const kelly = known ? { full: kellyFull, half: kellyFull / 2 } : null;

  return {
    chanceShown,
    band: bandLabel(band),
    window: { key: OUTLOOK_WINDOWS[win].key, label: OUTLOOK_WINDOWS[win].label },
    context: { minutesSinceDeposit, upgradesSinceDeposit, netSinceDeposit },
    ratio,
    realChance,
    ev,
    evPct: ev / stake,
    breakEvenRatio,
    probProfitable,
    verdict,
    kelly,
    cell: { ...cell },
    bandStats: bandSum,
    windows: OUTLOOK_WINDOWS.map((w, i) => {
      const c = cells[band][i];
      const q = posterior(c);
      return { key: w.key, label: w.label, n: c.n, ratio: c.n ? q.a / q.b : null, realChance: Math.min(1, p * (q.a / q.b)) };
    }),
  };
}
