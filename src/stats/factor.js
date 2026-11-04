// factor(): breakdown of results by one factor (time of day, streaks, bet shape, ...) plus an omnibus test.
import { num } from '../schema.js';
import {
  ALPHA, DEFAULT_STAKE_EDGES, adjustedWinFields, baseMetrics, bucketIndex, caseEvents, costOf, isOdds, isWin,
  makeBuckets, markSignificant, returnedOf, sortByTime, superShown, targetPriceOf, upgradeEvents, upgradeMetrics,
} from './core.js';
import { calibrationCurve, curveLookup } from './calibration.js';
import { chiSquareSf, oneWayAnova } from './math.js';
import { sessionize } from './sessions.js';

const HOUR_MS = 3600000;
const MIN_MS = 60000;

const pad2 = (n) => String(n).padStart(2, '0');
const range = (n) => Array.from({ length: n }, (_, i) => i);
const cat = (value, label = String(value)) => ({ value, label });
const hourOf = (e) => new Date(num(e.ts)).getHours();
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MULTIPLIER_EDGES = [0, 2, 5, 10, Infinity];
const MULTIPLIER_LABELS = ['x<2', 'x2-5', 'x5-10', 'x10+'];

function bucketFactor(edgesOf, labelsOf, valueOf, scope = 'both') {
  return {
    scope,
    cats: (opts) => labelsOf(edgesOf(opts)).map((l) => cat(l)),
    assign: (e, ctx, opts) => {
      const v = valueOf(e);
      if (v === null || v === undefined || Number.isNaN(v)) return undefined;
      const edges = edgesOf(opts);
      const i = bucketIndex(v, edges);
      return i < 0 ? undefined : labelsOf(edges)[i];
    },
  };
}

// Each factor: scope ('case' | 'upgrade' | 'both'), cats(opts) fixed row list (null = rows come from the data),
// assign(event, ctx, opts) -> category value or undefined to skip the event, needs ('session' | 'streak').
const FACTORS = {
  hour: { scope: 'both', cats: () => range(24).map((h) => cat(h, `${pad2(h)}:00`)), assign: hourOf },
  weekday: {
    scope: 'both',
    cats: () => WEEKDAYS.map((d, i) => cat(i, d)),
    assign: (e) => (new Date(num(e.ts)).getDay() + 6) % 7,
  },
  daypart: {
    scope: 'both',
    cats: () => [cat('night', 'Night 00-06'), cat('morning', 'Morning 06-12'), cat('afternoon', 'Afternoon 12-18'), cat('evening', 'Evening 18-24')],
    assign: (e) => { const h = hourOf(e); return h < 6 ? 'night' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening'; },
  },
  sessionPosition: {
    scope: 'both',
    needs: 'session',
    cats: () => [cat('1st-5th'), cat('6th-20th'), cat('21st+')],
    assign: (e, ctx) => { const p = ctx.session.get(e).position; return p <= 5 ? '1st-5th' : p <= 20 ? '6th-20th' : '21st+'; },
  },
  sessionMinute: {
    scope: 'both',
    needs: 'session',
    cats: () => [cat('0-15 min'), cat('15-60 min'), cat('60+ min')],
    assign: (e, ctx) => { const m = ctx.session.get(e).minutes; return m < 15 ? '0-15 min' : m < 60 ? '15-60 min' : '60+ min'; },
  },
  afterLossStreak: {
    scope: 'upgrade',
    needs: 'streak',
    cats: () => [cat(0), cat(1), cat(2), cat('3-4'), cat('5+')],
    assign: (e, ctx) => { const s = ctx.streak.get(e).streak; return s <= 2 ? s : s <= 4 ? '3-4' : '5+'; },
  },
  afterWin: {
    scope: 'upgrade',
    needs: 'streak',
    cats: () => [cat('won', 'Previous won'), cat('lost', 'Previous lost'), cat('none', 'First upgrade')],
    assign: (e, ctx) => ctx.streak.get(e).prev,
  },
  mode: {
    scope: 'upgrade',
    pool: 'anyUpgrade',
    cats: () => [cat('normal'), cat('mystery')],
    assign: (e) => (e.mystery ? 'mystery' : 'normal'),
  },
  gameMode: { scope: 'both', cats: () => null, assign: (e) => String(e.gameMode ?? 'unknown') },
  site: { scope: 'both', cats: () => null, assign: (e) => String(e.site ?? 'unknown') },
  free: {
    scope: 'case',
    cats: () => [cat('paid'), cat('free')],
    assign: (e) => (e.free ? 'free' : 'paid'),
  },
  itemCount: {
    scope: 'upgrade',
    cats: () => [1, 2, 3, 4, 5, 6].map((n) => cat(n, n === 6 ? '6+' : String(n))),
    assign: (e) => Math.min(6, Math.max(1, Array.isArray(e.betItems) ? e.betItems.length : 1)),
  },
  addedBalance: {
    scope: 'upgrade',
    cats: () => [cat('none'), cat('some')],
    assign: (e) => (num(e.addedBalance) > 0 ? 'some' : 'none'),
  },
  balanceBand: bucketFactor(
    (opts) => opts.edges ?? DEFAULT_STAKE_EDGES,
    (edges) => makeBuckets(edges).map((b) => b.label),
    (e) => (e.balanceBefore === null || e.balanceBefore === undefined ? null : num(e.balanceBefore)),
  ),
  sinceDeposit: {
    scope: 'both',
    needs: 'deposit',
    cats: () => ['0-5m', '5-15m', '15-60m', '1-6h', '6h+', 'no deposit yet'].map((l) => cat(l)),
    assign: (e, ctx) => {
      const t = ctx.sinceDeposit.get(e);
      if (t === null) return 'no deposit yet';
      return t < 5 * MIN_MS ? '0-5m' : t < 15 * MIN_MS ? '5-15m' : t < HOUR_MS ? '15-60m' : t < 6 * HOUR_MS ? '1-6h' : '6h+';
    },
  },
  afterDepositOrder: {
    scope: 'upgrade',
    needs: 'deposit',
    cats: () => ['1st', '2nd-5th', '6th-20th', '21st+'].map((l) => cat(l)),
    assign: (e, ctx) => {
      const k = ctx.depositOrder.get(e);
      if (!k) return undefined; // no deposit yet
      return k === 1 ? '1st' : k <= 5 ? '2nd-5th' : k <= 20 ? '6th-20th' : '21st+';
    },
  },
  sinceWithdrawal: {
    scope: 'both',
    needs: 'withdrawal',
    cats: () => ['<1h', '1-24h', '24h+ / none'].map((l) => cat(l)),
    assign: (e, ctx) => {
      const t = ctx.sinceWithdrawal.get(e);
      return t !== null && t < HOUR_MS ? '<1h' : t !== null && t < 24 * HOUR_MS ? '1-24h' : '24h+ / none';
    },
  },
  superDrop: {
    scope: 'upgrade',
    pool: 'super',
    cats: () => [cat('shown'), cat('not shown')],
    assign: (e) => (superShown(e) ? 'shown' : 'not shown'),
  },
  multiplier: bucketFactor(
    () => MULTIPLIER_EDGES,
    () => MULTIPLIER_LABELS,
    (e) => (targetPriceOf(e) > 0 && num(e.stake) > 0 ? targetPriceOf(e) / num(e.stake) : null),
    'upgrade',
  ),
};

/** For each event of `sorted`, the age (ms) of the latest time in `times` at or before it, else null. */
function ageSince(sorted, times) {
  const out = new Map();
  let i = 0;
  for (const e of sorted) {
    const ts = num(e.ts);
    while (i < times.length && times[i] <= ts) i++;
    out.set(e, i > 0 ? ts - times[i - 1] : null);
  }
  return out;
}

const timesOf = (events, pred) => events.filter(pred).map((e) => num(e.ts)).sort((a, b) => a - b);

/**
 * Per-event context some factors need: session position/minute (from the events in scope), the
 * previous-upgrade streak and deposit order (from all settled upgrades), time since deposit/withdrawal.
 */
function buildContext(sorted, needs, gapMinutes, events) {
  const ctx = {};
  if (needs === 'session') {
    ctx.session = new Map();
    for (const s of sessionize(sorted, gapMinutes)) {
      const t0 = num(s[0].ts);
      s.forEach((e, i) => ctx.session.set(e, { position: i + 1, minutes: (num(e.ts) - t0) / 60000 }));
    }
  }
  if (needs === 'streak') {
    ctx.streak = new Map();
    let streak = 0;
    let prev = 'none';
    for (const e of sortByTime(upgradeEvents(events))) {
      ctx.streak.set(e, { streak, prev });
      if (isWin(e)) { streak = 0; prev = 'won'; } else { streak++; prev = 'lost'; }
    }
  }
  if (needs === 'deposit') {
    const deposits = timesOf(events, (e) => e && e.kind === 'deposit' && e.status === 'completed');
    ctx.sinceDeposit = ageSince(sorted, deposits);
    ctx.depositOrder = new Map();
    let i = 0;
    let count = 0;
    let seen = false;
    for (const e of sortByTime(upgradeEvents(events))) {
      const ts = num(e.ts);
      while (i < deposits.length && deposits[i] <= ts) { i++; count = 0; seen = true; }
      count++;
      ctx.depositOrder.set(e, seen ? count : 0);
    }
  }
  if (needs === 'withdrawal') {
    ctx.sinceWithdrawal = ageSince(sorted, timesOf(events, (e) => e && e.kind === 'withdrawal'));
  }
  return ctx;
}

const rowOptsOf = (def, opts) => (def.pool === 'super' ? { includeSuperDrop: true } : opts);

/**
 * Events in scope. Upgrades are limited to ones testable against shown odds (normal, no super-drop card
 * unless opts.includeSuperDrop). Exceptions by factor `pool`: 'anyUpgrade' keeps mystery too,
 * 'super' keeps super-drop-shown ones.
 */
function selectEvents(events, def, opts) {
  const scope = def.scope;
  if (scope !== 'both' && opts.kind && opts.kind !== scope) return { mode: scope, evs: [] };
  const mode = scope === 'both' ? opts.kind ?? 'both' : scope;
  const cases = mode === 'upgrade' ? [] : caseEvents(events);
  let ups = [];
  if (mode !== 'case') {
    ups = upgradeEvents(events);
    if (def.pool === 'anyUpgrade') ups = ups.filter((e) => opts.includeSuperDrop || !superShown(e));
    else ups = ups.filter((e) => isOdds(e, rowOptsOf(def, opts)));
  }
  return { mode, evs: [...cases, ...ups] };
}

function rowMetrics(evs, mode, rowOpts, expectedOf) {
  if (mode === 'case') return baseMetrics(evs);
  const ups = mode === 'upgrade' ? evs : evs.filter((e) => e.kind === 'upgrade');
  const adj = adjustedWinFields(ups.filter((e) => isOdds(e, rowOpts)), expectedOf);
  if (mode === 'upgrade') return { ...upgradeMetrics(evs, rowOpts), ...adj };
  const up = upgradeMetrics(ups, rowOpts);
  return {
    ...baseMetrics(evs), wins: up.wins, winRate: up.winRate, winRateCI: up.winRateCI, expectedRate: up.expectedRate,
    z: up.z, p: up.p, significant: false, oddsN: up.oddsN, upgradeN: ups.length, ...adj,
  };
}

function dynamicCats(groups) {
  return [...groups.keys()]
    .sort((a, b) => groups.get(b).length - groups.get(a).length || String(a).localeCompare(String(b)))
    .map((v) => cat(v));
}

const noTest = (method) => ({ method, statistic: null, df: 0, p: null, significant: false });

/**
 * Chi-square of observed vs expected wins and losses across rows. `expectedOf(row)` gives expected wins.
 * Only rows with expected wins >= 1 and expected losses >= 1 count. df = counted rows - 1 (the contract's
 * choice); p is null when df < 1.
 */
function chiSquare(rows, expectedOf) {
  let statistic = 0;
  let used = 0;
  for (const r of rows) {
    const n = r.oddsN;
    if (!n) continue;
    const expWins = expectedOf(r);
    const expLosses = n - expWins;
    if (!(expWins >= 1) || !(expLosses >= 1)) continue;
    used++;
    statistic += (r.wins - expWins) ** 2 / expWins + (n - r.wins - expLosses) ** 2 / expLosses;
  }
  if (used === 0) return { statistic: null, df: 0, p: null };
  const df = used - 1;
  return { statistic, df, p: df >= 1 ? chiSquareSf(statistic, df) : null };
}

/**
 * Omnibus test for upgrade rows, twice: against the shown chances (statistic, p) and against the
 * expectation from the real calibration curve (statisticAdj, pAdj).
 */
function chiSquareTest(rows) {
  const shown = chiSquare(rows, (r) => r.expectedRate * r.oddsN);
  const adj = chiSquare(rows, (r) => r.expectedRateAdj * r.oddsN);
  return {
    method: 'chi-square',
    statistic: shown.statistic, df: shown.df, p: shown.p, significant: shown.p !== null && shown.p < ALPHA,
    statisticAdj: adj.statistic, dfAdj: adj.df, pAdj: adj.p, significantAdj: adj.p !== null && adj.p < ALPHA,
  };
}

/**
 * One-way ANOVA (F test) on the per-event return ratio (returned / cost) across groups.
 * Used for cases, which have no win/lose outcome to compare with a shown chance. It compares
 * mean return ratios; return ratios are heavy tailed, so treat small-sample p-values loosely.
 * `df` is the between-groups df; `dfWithin` the within-groups df.
 */
function anovaTest(groupEvents) {
  const ratios = groupEvents.map((evs) => evs.filter((e) => costOf(e) > 0).map((e) => returnedOf(e) / costOf(e)));
  const r = oneWayAnova(ratios);
  return { ...noTest('anova'), ...r, significant: r.p !== null && r.p < ALPHA };
}

/**
 * Breakdown of results by one factor, with significance flags and an omnibus test.
 *
 * Keys: hour, weekday (Monday = 0), daypart, sessionPosition, sessionMinute, afterLossStreak, afterWin,
 * mode, gameMode, site, free, itemCount, addedBalance, balanceBand, multiplier, sinceDeposit,
 * afterDepositOrder, sinceWithdrawal, superDrop. Throws on an unknown key.
 * Factors that apply to one kind only (e.g. afterLossStreak = upgrades, free = cases) ignore the other kind.
 * Session factors use sessions built from the events in scope (opts.kind), gap opts.gapMinutes (default 30).
 * Fixed-category factors return a row for every category, empty ones included.
 *
 * Upgrade rows only hold normal upgrades without the super-drop card (opts.includeSuperDrop lifts that).
 * Exceptions: 'mode' also lists mystery upgrades (money metrics only, no win fields) and 'superDrop'
 * keeps the super-drop-shown ones. Cases and mystery upgrades never enter the win tests.
 *
 * Tests: upgrades use chi-square of observed vs expected wins/losses, twice. Row fields z/p/significant and
 * test.statistic/p compare with the SHOWN chances. Row fields expectedRateAdj/zAdj/pAdj/significantAdj and
 * test.statisticAdj/pAdj use as expected rate the real win rate of the event's calibrationCurve bucket
 * (buckets with >= 30 events, else the shown chance), computed on all upgrades in scope. This stops a row that
 * only holds a different chance mix from looking lucky. Cases use one-way ANOVA on return ratio.
 * Without opts.kind on a shared key, rows hold both kinds (n counts both; win fields use the upgrade
 * subset, `upgradeN` / `oddsN` are its sizes) and the chi-square test is used when any upgrade is tested.
 * @param {object[]} events
 * @param {string} key
 * @param {{kind?:'case'|'upgrade', gapMinutes?:number, edges?:number[], includeSuperDrop?:boolean}} [opts]
 */
export function factor(events, key, opts = {}) {
  const def = Object.hasOwn(FACTORS, key) ? FACTORS[key] : null;
  if (!def) throw new Error(`Unknown factor: ${key}`);
  const all = Array.isArray(events) ? events.filter((e) => e && typeof e === 'object') : [];
  const { mode, evs } = selectEvents(all, def, opts);
  const sorted = sortByTime(evs);
  const ctx = buildContext(sorted, def.needs, opts.gapMinutes ?? 30, all);
  const groups = new Map();
  for (const e of sorted) {
    const v = def.assign(e, ctx, opts);
    if (v === undefined) continue;
    if (!groups.has(v)) groups.set(v, []);
    groups.get(v).push(e);
  }
  const rowOpts = rowOptsOf(def, opts);
  const curve = calibrationCurve(all, undefined, { includeSuperDrop: !!opts.includeSuperDrop });
  const expectedOf = curveLookup(curve);
  const cats = def.cats(opts) ?? dynamicCats(groups);
  const rows = cats.map((c) => ({ value: c.value, label: c.label, ...rowMetrics(groups.get(c.value) ?? [], mode, rowOpts, expectedOf) }));
  const tested = mode !== 'case' && rows.some((r) => r.oddsN > 0);
  if (tested) {
    markSignificant(rows);
    markSignificant(rows, ALPHA, 'pAdj', 'significantAdj');
  }
  const test = tested ? chiSquareTest(rows) : anovaTest(cats.map((c) => groups.get(c.value) ?? []));
  return { key, rows, test };
}
