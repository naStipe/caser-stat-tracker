// Turns the database answers (monitor_report, monitor_volume_agg) into what the dashboard shows.
// Pure, so the tests can run it.
//
// Three measures per kind:
//   index  observed against normal: upgrade wins against the wins the last 7 days' real rate predicts for
//          the same chance band and session phase (see supabase/migrations/*_monitor_derive.sql); case hits
//          (an open worth at least the case price) against each case's rate over the last 7 days. Each
//          upgrade or open counts once, whatever its size, so this settles fast. 1 = normal, above 1 =
//          better for players than usual.
//   shown  upgrade wins against the wins the shown chances predict (for cases the same as index).
//   return total value received per 1 staked. What players actually got, but one big win moves it a lot.
//
// Rows arrive late (revisits, history pages), so windows newer than the "settled" time are still filling:
// they are marked provisional and the comparisons end at the settled time.

import { HOUR, ratioOf, compareRatios, indexOf, indexZ, compareIndex } from './stats.js';

const MIN = 60 * 1000;
const DAY = 24 * HOUR;
export const KINDS = ['upgrade', 'case'];

/** Time ranges the page offers, with the bucket size the activity chart and table use. */
export const RANGES = {
  '30m': { label: '30 minutes', span: 30 * MIN, bucket: 5 * MIN },
  '1h': { label: 'hour', span: HOUR, bucket: 5 * MIN },
  '3h': { label: '3 hours', span: 3 * HOUR, bucket: 15 * MIN },
  '6h': { label: '6 hours', span: 6 * HOUR, bucket: 30 * MIN },
  '24h': { label: '24 hours', span: DAY, bucket: HOUR },
  '3d': { label: '3 days', span: 3 * DAY, bucket: 3 * HOUR },
  '7d': { label: '7 days', span: 7 * DAY, bucket: 6 * HOUR },
  '30d': { label: '30 days', span: 30 * DAY, bucket: DAY },
};

/** Window sizes for the two main charts, in minutes. */
export const WINDOWS = [1, 2, 5, 10, 15, 20, 30, 60, 120, 360, 1440];
const MAX_WINDOWS = 800;
const MIN_WINDOWS = 3;
/** The window each range starts with. */
export const DEFAULT_WINDOW = { '30m': 1, '1h': 2, '3h': 5, '6h': 10, '24h': 15, '3d': 30, '7d': 60, '30d': 360 };

/** Step of the comparison report and of the glance lines. */
export const STEP = 5 * MIN;
/** What the glance lines cover. */
export const GLANCE_SPAN = 6 * HOUR;
/** How late rows arrive is measured (report.lag); with too few measured rows this is assumed. */
export const DEFAULT_LAG = 30 * MIN;
export const MAX_LAG = 2 * HOUR;
const MIN_LAG_ROWS = 200;

/** Window sizes that give a range between MIN_WINDOWS and MAX_WINDOWS windows. */
export function windowsFor(key) {
  const span = (RANGES[key] ?? RANGES['24h']).span;
  return WINDOWS.filter((m) => span / (m * MIN) <= MAX_WINDOWS && span / (m * MIN) >= MIN_WINDOWS);
}

/** The window to use: the one asked for if allowed, else the range's default. */
export function pickWindow(key, wanted) {
  const k = RANGES[key] ? key : '24h';
  const ok = windowsFor(k);
  if (ok.includes(Number(wanted))) return Number(wanted);
  return ok.includes(DEFAULT_WINDOW[k]) ? DEFAULT_WINDOW[k] : ok[0];
}

/** Range and windows aligned to the window size, the current (partial) window last. */
export function rangeSpec(key, now, windowMin = 15) {
  const k = RANGES[key] ? key : '24h';
  const r = RANGES[k];
  const win = pickWindow(k, windowMin) * MIN;
  const to = Math.floor(now / win) * win + win;
  const from = to - Math.ceil(r.span / win) * win;
  // The activity chart and table use the range's coarser bucket.
  const cto = Math.floor(now / r.bucket) * r.bucket + r.bucket;
  const cfrom = cto - Math.ceil(r.span / r.bucket) * r.bucket;
  return { key: k, label: r.label, from, to, window: win, coarse: { from: cfrom, to: cto, bucket: r.bucket } };
}

/**
 * The comparison and glance report: 5-minute buckets over the last 7 hours (the glance's 6 hours plus the
 * longest compared part before its first point), so the page can end the comparison at the settled time,
 * whatever the arrival lag turns out to be.
 */
export function compareSpec(now, minutes = 60) {
  const to = Math.floor(now / STEP) * STEP + STEP;
  return { from: to - GLANCE_SPAN - HOUR, to, bucket: STEP, minutes };
}

/** How late rows arrive, and the time before which windows are complete enough to judge. */
export function settledAt(lag, now) {
  const p80 = Number(lag?.p80);
  const known = Number(lag?.rows) >= MIN_LAG_ROWS && Number.isFinite(p80);
  const lagMs = known ? Math.min(MAX_LAG, Math.max(STEP, p80)) : DEFAULT_LAG;
  return { lagMs, known, p50: known ? Number(lag.p50) : null, at: Math.floor((now - lagMs) / STEP) * STEP };
}

const n0 = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? 0 : Number(v));
const numOrNull = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** Numbers of one report row (the database sends some as strings, and nulls for empty sums). */
export function cleanRow(r) {
  const out = {};
  for (const [k, v] of Object.entries(r ?? {})) out[k] = typeof v === 'string' && k !== 'kind' && k !== 'slug' && k !== 'band' ? n0(v) : v ?? 0;
  return out;
}

/**
 * The index of one row for a kind (upgrade: wins, case: hits). mode 'normal' compares upgrades with the
 * normal rate (falls back to the shown chance for a report without it), 'shown' with the shown chance.
 */
export function rowIndex(kind, r, mode = 'normal') {
  return indexOf(rowCounts(kind, r, mode));
}
/** The counts behind rowIndex: {n, obs, exp, v}. */
export function rowCounts(kind, r, mode = 'normal') {
  if (kind !== 'upgrade') return { n: n0(r?.nh), obs: n0(r?.h), exp: n0(r?.eh), v: n0(r?.vh) };
  const normal = mode === 'normal' && n0(r?.ea) > 0;
  return { n: n0(r?.nw), obs: n0(r?.w), exp: normal ? n0(r.ea) : n0(r?.ew), v: normal ? n0(r.va) : n0(r?.vw) };
}

/** Return per 1 of one row, with the per-player error when the row has it. */
export function rowMoney(r) {
  return ratioOf({ n: n0(r?.n), players: n0(r?.players), sx: n0(r?.sx), sy: n0(r?.sy), gxx: n0(r?.gxx), gyy: n0(r?.gyy), gxy: n0(r?.gxy) });
}

const sumRows = (rows) => {
  const out = {};
  for (const r of rows) for (const [k, v] of Object.entries(r)) if (typeof v === 'number') out[k] = (out[k] ?? 0) + v;
  return out;
};

/**
 * An index against 1 (normal): verdict 'better' | 'worse' | 'same' | 'few', as compareIndex, and how unusual it
 * is: 'noise' (|z| under 2), 'mild' (2 to 3: checked every 30 minutes, about 2 a day happen by chance) or
 * 'strong' (3 and more: about one a week by chance).
 */
export function againstNormal(ix, { minExp = 5, minN = 30 } = {}) {
  if (!(ix?.n >= minN) || !(ix.exp >= minExp) || !(ix.se > 0)) return { ...ix, z: null, p: null, verdict: 'few', strength: 'few' };
  const z = (ix.index - 1) / ix.se;
  const p = 2 * (1 - normCdf(Math.abs(z)));
  const strength = Math.abs(z) >= 3 ? 'strong' : Math.abs(z) >= 2 ? 'mild' : 'noise';
  return { ...ix, z, p, verdict: p < 0.05 ? (z > 0 ? 'better' : 'worse') : 'same', strength };
}

/**
 * Does "right now" predict the next window? From a 7-day report in 30-minute buckets: each settled window of
 * `minutes` (30 or 60) becomes z = (observed - normal) / its standard error, and consecutive windows are
 * correlated. Pure noise gives a correlation near 0 and a spread of z near 1.
 * verdict: 'few' (under 20 pairs) | 'carry' (a good window tends to be followed by a good one) |
 *          'reverse' (followed by a bad one) | 'none' (no relation found).
 */
export function persistence(series, kind, settledAt, minutes = 30, { minExp = 10 } = {}) {
  const len = minutes * MIN;
  const byWin = new Map();
  for (const raw of series ?? []) {
    if (raw.kind !== kind) continue;
    const r = cleanRow(raw);
    const start = Math.floor(Number(r.bucket) / len) * len;
    if (start + len > settledAt) continue;
    const c = rowCounts(kind, r);
    const s = byWin.get(start) ?? { n: 0, obs: 0, exp: 0, v: 0 };
    s.n += c.n;
    s.obs += c.obs;
    s.exp += c.exp;
    s.v += c.v;
    byWin.set(start, s);
  }
  const z = new Map();
  for (const [start, s] of byWin) if (s.exp >= minExp && s.v > 0) z.set(start, (s.obs - s.exp) / Math.sqrt(s.v));
  const pairs = [];
  for (const [start, a] of z) if (z.has(start + len)) pairs.push([a, z.get(start + len)]);
  const all = [...z.values()];
  const mean = (xs) => xs.reduce((t, x) => t + x, 0) / (xs.length || 1);
  const spread = all.length > 1 ? Math.sqrt(all.reduce((t, x) => t + (x - mean(all)) ** 2, 0) / (all.length - 1)) : null;
  const n = pairs.length;
  if (n < 20) return { minutes, windows: all.length, pairs: n, r: null, ci: null, spread, verdict: 'few', points: pairs };
  const mx = mean(pairs.map((p) => p[0]));
  const my = mean(pairs.map((p) => p[1]));
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pairs) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  const r = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
  // 95% range through Fisher's z.
  const fz = Math.atanh(Math.max(-0.999999, Math.min(0.999999, r)));
  const half = 1.959964 / Math.sqrt(n - 3);
  const ci = [Math.tanh(fz - half), Math.tanh(fz + half)];
  const verdict = ci[0] > 0 ? 'carry' : ci[1] < 0 ? 'reverse' : 'none';
  return { minutes, windows: all.length, pairs: n, r, ci, spread, verdict, points: pairs };
}
/** Window sizes the "does one window predict the next?" check offers, in minutes. */
export const PREDICT_WINDOWS = [5, 10, 15, 30, 60];
/** Short windows hold few rows; below this many expected wins or hits a window is left out. */
export const PREDICT_MIN_EXP = 3;

/** monitor_window_sums rows ({bucket, kind, n, obs, exp, v}) in the shape persistence() reads. */
export function sumsToSeries(rows) {
  return (rows ?? []).map((r) =>
    r.kind === 'upgrade'
      ? { bucket: Number(r.bucket), kind: 'upgrade', nw: n0(r.n), w: n0(r.obs), ea: n0(r.exp), va: n0(r.v) }
      : { bucket: Number(r.bucket), kind: r.kind, nh: n0(r.n), h: n0(r.obs), eh: n0(r.exp), vh: n0(r.v) });
}

function normCdf(z) {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

export function cleanVolume(v) {
  return { bucket: Number(v.bucket), samples: n0(v.samples), casesPerMin: numOrNull(v.cases_per_min), upgradesPerMin: numOrNull(v.upgrades_per_min), online: numOrNull(v.online) };
}
const EMPTY_VOLUME = { bucket: 0, samples: 0, casesPerMin: null, upgradesPerMin: null, online: null };

export const PHASES = [
  [1, 'First 5 minutes'],
  [2, '5–15 minutes'],
  [3, '15–60 minutes'],
  [4, 'After an hour'],
  [0, 'Start not seen'],
];
export const CHANCE_GROUPS = [
  [1, 'under 15%'],
  [2, '15–35%'],
  [3, '35% and up'],
];
export const BANDS = [
  ['a', 'under 10%'],
  ['b', '10–15%'],
  ['c', '15–25%'],
  ['d', '25–35%'],
  ['e', '35–55%'],
  ['f', '55–70%'],
  ['g', '70% and up'],
];

/**
 * The last 7 days for one shown-chance band and session phase: wins against the shown chance, and return
 * per 1 with a range clustered by player. From the "situations" of a 7-day report.
 */
export function situation(week, band, phase) {
  const r = cleanRow((week?.situations ?? []).find((s) => s.band === band && Number(s.phase) === Number(phase)));
  return {
    n: n0(r.n),
    players: n0(r.players),
    shown: indexOf({ n: n0(r.n), obs: n0(r.w), exp: n0(r.ew), v: n0(r.vw) }),
    winRate: r.n ? n0(r.w) / n0(r.n) : null,
    shownRate: r.n ? n0(r.ew) / n0(r.n) : null,
    money: ratioOf({ n: n0(r.n), players: n0(r.players), sx: n0(r.sx), sy: n0(r.sy), gxx: n0(r.gxx), gyy: n0(r.gyy), gxy: n0(r.gxy) }),
  };
}

/**
 * Day by day over the 7-day report: low chances (under 15%) in the first 5 minutes of a session, and high
 * chances (35% and up) at any time, against the shown chance. Shows whether the pattern holds or changes.
 */
export function dailyPattern(week) {
  const days = new Map();
  for (const raw of week?.daily ?? []) {
    const r = cleanRow(raw);
    const d = days.get(r.day) ?? { day: r.day, fresh: { n: 0, obs: 0, exp: 0, v: 0 }, high: { n: 0, obs: 0, exp: 0, v: 0 } };
    const add = (t) => { t.n += r.n; t.obs += r.w; t.exp += r.ew; t.v += r.vw; };
    if (Number(r.phase) === 1 && Number(r.cg) === 1) add(d.fresh);
    if (Number(r.cg) === 3) add(d.high);
    days.set(r.day, d);
  }
  return [...days.values()].sort((a, b) => a.day - b.day).map((d) => ({ day: d.day, fresh: indexOf(d.fresh), high: indexOf(d.high) }));
}

/**
 * @param {Object} o
 * @param {any} o.report    monitor_report over the range, per window
 * @param {any} o.cmp       monitor_report over compareSpec(now) (5-minute buckets)
 * @param {any} [o.week]    monitor_report over the last 7 days in 30-minute buckets (self-check, lookup, day by day)
 * @param {{minutes: number, rows: any[]}} [o.predict]  monitor_window_sums over the last 7 days in windows of `minutes`
 * @param {any[]} o.volume  monitor_volume_agg over the range, per coarse bucket
 * @param {any[]} o.volRecent  monitor_volume_agg over the compared recent part
 * @param {any[]} o.volBase    monitor_volume_agg over the part before it
 * @param {ReturnType<typeof rangeSpec>} o.spec
 * @param {number} o.now
 */
export function buildReport({ report, cmp, week = null, predict = null, heatReport = null, compareMinutes = 60, volume = [], volRecent = [], volBase = [], spec, now }) {
  const series = (report?.series ?? []).map(cleanRow);
  const settled = settledAt(report?.lag ?? cmp?.lag, now);
  const out = { now, spec, settled, kinds: {}, compare: {}, compareMoney: {}, glance: {}, heat: {}, hours: {}, totals: {}, excluded: {} };
  const len = compareMinutes * MIN;
  const cmpRows = (cmp?.series ?? []).map(cleanRow);
  const cs = compareSpec(now, compareMinutes);

  for (const kind of KINDS) {
    const rows = series.filter((r) => r.kind === kind);
    const total = sumRows(rows);
    const avg = rowIndex(kind, total);
    const byStart = new Map(rows.map((r) => [Number(r.bucket), r]));
    const windows = [];
    // Smoothing: the last hour of windows (a quarter of the range for short ranges).
    const steps = Math.max(1, Math.round(Math.min(HOUR, (spec.to - spec.from) / 4) / spec.window));
    const roll = [];
    for (let t = spec.from; t < spec.to; t += spec.window) {
      const r = byStart.get(t) ?? null;
      const index = rowIndex(kind, r);
      roll.push(r ?? {});
      if (roll.length > steps) roll.shift();
      const smooth = rowIndex(kind, sumRows(roll.map((x) => cleanRow(x))));
      windows.push({
        start: t,
        end: Math.min(t + spec.window, now),
        provisional: t + spec.window > settled.at,
        n: n0(r?.n),
        players: n0(r?.players),
        up: n0(r?.up),
        index,
        shown: rowIndex(kind, r, 'shown'),
        z: indexZ(index, avg.index),
        money: rowMoney(r),
        smooth: smooth.index,
      });
    }
    const ranked = windows.filter((w) => !w.provisional && w.index.n >= 10 && w.z != null).sort((a, b) => b.z - a.z);
    out.kinds[kind] = {
      windows,
      avg,
      shownAvg: rowIndex(kind, total, 'shown'),
      money: ratioOf({ n: total.n ?? 0, players: 0, sx: total.sx ?? 0, sy: total.sy ?? 0 }),
      best: ranked.filter((w) => w.z > 0).slice(0, 5),
      worst: ranked.filter((w) => w.z < 0).reverse().slice(0, 5),
    };

    // The last `compareMinutes` before the settled time, against normal and against the 3 times as long before.
    const c = cmpRows.filter((r) => r.kind === kind);
    const inPart = (from, to) => c.filter((r) => Number(r.bucket) >= from && Number(r.bucket) < to);
    const sr = sumRows(inPart(settled.at - len, settled.at));
    const sb = sumRows(inPart(settled.at - 4 * len, settled.at - len));
    const ri = rowIndex(kind, sr);
    const bi = rowIndex(kind, sb);
    out.compare[kind] = { ...againstNormal(ri), from: settled.at - len, to: settled.at, before: compareIndex(rowCounts(kind, sr), rowCounts(kind, sb)), base: bi };
    out.compareMoney[kind] = compareRatios(
      { n: sr.n ?? 0, players: sr.players ?? 0, sx: sr.sx ?? 0, sy: sr.sy ?? 0, gxx: sr.gxx ?? 0, gyy: sr.gyy ?? 0, gxy: sr.gxy ?? 0 },
      { n: sb.n ?? 0, players: sb.players ?? 0, sx: sb.sx ?? 0, sy: sb.sy ?? 0, gxx: sb.gxx ?? 0, gyy: sb.gyy ?? 0, gxy: sb.gxy ?? 0 },
    );

    // Glance line: the index over the `compareMinutes` before each 5-minute step of the last 6 hours.
    const points = [];
    for (let t = cs.to - GLANCE_SPAN; t <= cs.to; t += STEP) {
      const end = Math.min(t, now);
      const ix = rowIndex(kind, sumRows(inPart(t - len, t)));
      points.push({ t: end, index: ix.n >= 20 ? ix.index : null, ci: ix.n >= 20 ? ix.ci : null, n: ix.n, provisional: t > settled.at });
    }
    out.glance[kind] = { points, from: cs.to - GLANCE_SPAN, to: now };

    // Weekday x hour, and hour of day over all days.
    const heat = ((heatReport ?? report)?.heat ?? []).map(cleanRow).filter((r) => r.kind === kind);
    const cells = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => null));
    for (const r of heat) {
      const d = Number(r.dow) - 1;
      const h = Number(r.hour);
      if (d >= 0 && d < 7 && h >= 0 && h < 24) cells[d][h] = { index: rowIndex(kind, r), money: rowMoney(r), n: n0(r.n) };
    }
    out.heat[kind] = cells;
    out.hours[kind] = Array.from({ length: 24 }, (_, h) => {
      const rs = heat.filter((r) => Number(r.hour) === h);
      const s = sumRows(rs);
      return { hour: h, index: rowIndex(kind, s), money: rowMoney(s), n: s.n ?? 0 };
    });
    const tot = (report?.totals ?? []).find((x) => x.kind === kind);
    out.totals[kind] = { players: n0(tot?.players), up: n0(tot?.up) };
    out.excluded[kind] = n0((report?.excluded ?? []).find((x) => x.kind === kind)?.n);
  }

  out.bands = (report?.bands ?? []).map(cleanRow).sort((a, b) => String(a.band).localeCompare(String(b.band))).map((b) => ({
    band: b.band,
    label: { a: 'under 10%', b: '10–15%', c: '15–25%', d: '25–35%', e: '35–55%', f: '55–70%', g: '70% and up' }[b.band] ?? b.band,
    n: b.n,
    players: b.players,
    index: indexOf({ n: b.n, obs: b.w, exp: b.ew, v: b.vw }),
    normal: b.ea > 0 ? indexOf({ n: b.n, obs: b.w, exp: b.ea, v: b.va }) : null,
    winRate: b.n ? b.w / b.n : null,
    shownRate: b.n ? b.ew / b.n : null,
    money: ratioOf({ n: b.n, players: 0, sx: b.sx, sy: b.sy }),
  }));

  // Session phase x chance group: in the range (against the shown chance and against normal) and the 7-day normal.
  const ph = (report?.phases ?? []).map(cleanRow);
  const norm = (report?.phases_norm ?? []).map(cleanRow);
  const cell = (list, p, g) => list.find((r) => Number(r.phase) === p && Number(r.cg) === g);
  out.phases = PHASES.map(([p, label]) => ({
    phase: p,
    label,
    cells: CHANCE_GROUPS.map(([g]) => {
      const r = cell(ph, p, g);
      const nr = cell(norm, p, g);
      return {
        n: n0(r?.n),
        players: n0(r?.players),
        shown: indexOf({ n: n0(r?.n), obs: n0(r?.w), exp: n0(r?.ew), v: n0(r?.vw) }),
        normal: indexOf({ n: n0(r?.n), obs: n0(r?.w), exp: n0(r?.ea), v: n0(r?.va) }),
        usual: indexOf({ n: n0(nr?.n), obs: n0(nr?.w), exp: n0(nr?.ew), v: 0 }),
        money: ratioOf({ n: n0(r?.n), players: 0, sx: n0(r?.sx), sy: n0(r?.sy) }),
      };
    }),
  }));
  // The headline of the phase effect: low chances in the first 5 minutes of a session, over the glance span.
  const fresh = cell((cmp?.phases ?? []).map(cleanRow), 1, 1);
  const freshNorm = cell(norm.length ? norm : (cmp?.phases_norm ?? []).map(cleanRow), 1, 1);
  out.fresh = {
    now: indexOf({ n: n0(fresh?.n), obs: n0(fresh?.w), exp: n0(fresh?.ew), v: n0(fresh?.vw) }),
    vsNormal: indexOf({ n: n0(fresh?.n), obs: n0(fresh?.w), exp: n0(fresh?.ea), v: n0(fresh?.va) }),
    usual: indexOf({ n: n0(freshNorm?.n), obs: n0(freshNorm?.w), exp: n0(freshNorm?.ew), v: 0 }),
  };

  out.cases = (report?.cases ?? []).map(cleanRow).map((c) => ({
    slug: c.slug,
    n: c.n,
    players: c.players,
    price: c.price,
    hitRate: c.n ? c.h / c.n : null,
    normalRate: c.n ? c.eh / c.n : null,
    index: indexOf({ n: c.n, obs: c.h, exp: c.eh, v: c.vh }),
    money: ratioOf({ n: c.n, players: 0, sx: c.sx, sy: c.sy }),
  }));
  const STAKES = { 1: 'under 100', 2: '100–1,000', 3: '1,000–10,000', 4: '10,000 and up' };
  out.stakes = (report?.stakes ?? []).map(cleanRow).map((s) => ({
    kind: s.kind,
    label: STAKES[s.sb] ?? String(s.sb),
    n: s.n,
    players: s.players,
    index: rowIndex(s.kind, s),
    money: ratioOf({ n: s.n, players: 0, sx: s.sx, sy: s.sy }),
  }));

  const vol = volume.map(cleanVolume);
  out.volume = {
    buckets: [],
    recent: volRecent[0] ? cleanVolume(volRecent[0]) : EMPTY_VOLUME,
    base: volBase[0] ? cleanVolume(volBase[0]) : EMPTY_VOLUME,
  };
  for (let t = spec.coarse.from; t < spec.coarse.to; t += spec.coarse.bucket) out.volume.buckets.push(vol.find((v) => v.bucket === t) ?? { ...EMPTY_VOLUME, bucket: t });
  out.compareMinutes = compareMinutes;

  // Does a window predict the next one? And the 7-day lookup and day-by-day pattern.
  out.persistence = {};
  for (const kind of KINDS) out.persistence[kind] = { 30: persistence(week?.series, kind, settled.at, 30), 60: persistence(week?.series, kind, settled.at, 60) };
  // The same check at the window size picked on the page, from monitor_window_sums.
  if (predict) {
    const rows = sumsToSeries(predict.rows);
    out.predict = { minutes: predict.minutes };
    for (const kind of KINDS) out.predict[kind] = persistence(rows, kind, settled.at, predict.minutes, { minExp: PREDICT_MIN_EXP });
  }
  out.week = week;
  out.daily = dailyPattern(week);
  return out;
}

/** How the monitor is doing, from its last report (monitor_status). */
export function monitorHealth(row, now) {
  if (!row) return { level: 'warn', text: 'The monitor has not reported yet.' };
  const s = row.status ?? {};
  const at = Date.parse(row.updated_at) || 0;
  const ago = now - at;
  if (!s.running) return { level: 'bad', text: `The collector stopped: ${s.error || 'no reason given'}`, at };
  if (ago > 5 * MIN) return { level: 'bad', text: `No report from the monitor for ${Math.round(ago / MIN)} minutes. Is the container running?`, at };
  if (s.pausedUntil && s.pausedUntil > now) return { level: 'warn', text: `Paused by the site (HTTP 429) until ${new Date(s.pausedUntil).toLocaleTimeString()}.`, at };
  if (s.cloudError) return { level: 'warn', text: `Running, but writing to Supabase failed: ${s.cloudError}`, at };
  if (s.errorStreak >= 5) return { level: 'warn', text: `Running, but requests keep failing (${s.errorStreak} in a row): ${s.error}`, at };
  return { level: 'ok', text: 'Running.', at };
}
