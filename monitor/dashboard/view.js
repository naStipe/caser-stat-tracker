// Turns the database answers (monitor_report, monitor_volume_agg) into what the dashboard shows.
// Pure, so the tests can run it.
//
// Two measures per kind:
//   index  observed against expected: upgrade wins against the wins the shown chances predict, case
//          hits (an open worth at least the case price) against the hits the case's normal rate
//          predicts. Each upgrade or open counts once, whatever its size, so this settles fast.
//          1 = as expected, above 1 = better for players.
//   return total value received per 1 staked. What players actually got, but one big win moves it a lot.

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

/** The comparison: the last `minutes` against the 3 times as long before them, as one report of 4 buckets. */
export function compareSpec(now, minutes = 60) {
  const len = minutes * MIN;
  return { from: now - 4 * len, to: now, bucket: len, minutes };
}

const n0 = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? 0 : Number(v));
const numOrNull = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** Numbers of one report row (the database sends some as strings, and nulls for empty sums). */
export function cleanRow(r) {
  const out = {};
  for (const [k, v] of Object.entries(r ?? {})) out[k] = typeof v === 'string' && k !== 'kind' && k !== 'slug' && k !== 'band' ? n0(v) : v ?? 0;
  return out;
}

/** The index of one row for a kind (upgrade: wins, case: hits). */
export function rowIndex(kind, r) {
  return kind === 'upgrade' ? indexOf({ n: n0(r?.nw), obs: n0(r?.w), exp: n0(r?.ew), v: n0(r?.vw) }) : indexOf({ n: n0(r?.nh), obs: n0(r?.h), exp: n0(r?.eh), v: n0(r?.vh) });
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

export function cleanVolume(v) {
  return { bucket: Number(v.bucket), samples: n0(v.samples), casesPerMin: numOrNull(v.cases_per_min), upgradesPerMin: numOrNull(v.upgrades_per_min), online: numOrNull(v.online) };
}
const EMPTY_VOLUME = { bucket: 0, samples: 0, casesPerMin: null, upgradesPerMin: null, online: null };

/**
 * @param {Object} o
 * @param {any} o.report    monitor_report over the range, per window
 * @param {any} o.cmp       monitor_report over compareSpec(now) (hourly)
 * @param {any[]} o.volume  monitor_volume_agg over the range, per coarse bucket
 * @param {any[]} o.volRecent  monitor_volume_agg over the last hour
 * @param {any[]} o.volBase    monitor_volume_agg over the 3 hours before
 * @param {ReturnType<typeof rangeSpec>} o.spec
 * @param {number} o.now
 */
export function buildReport({ report, cmp, heatReport = null, compareMinutes = 60, volume = [], volRecent = [], volBase = [], spec, now }) {
  const series = (report?.series ?? []).map(cleanRow);
  const out = { now, spec, kinds: {}, compare: {}, compareMoney: {}, heat: {}, hours: {}, totals: {} };

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
      windows.push({ start: t, end: Math.min(t + spec.window, now), n: n0(r?.n), players: n0(r?.players), up: n0(r?.up), index, z: indexZ(index, avg.index), money: rowMoney(r), smooth: smooth.index });
    }
    const ranked = windows.filter((w) => w.index.n >= 10 && w.z != null).sort((a, b) => b.z - a.z);
    out.kinds[kind] = {
      windows,
      avg,
      money: ratioOf({ n: total.n ?? 0, players: 0, sx: total.sx ?? 0, sy: total.sy ?? 0 }),
      best: ranked.filter((w) => w.z > 0).slice(0, 5),
      worst: ranked.filter((w) => w.z < 0).reverse().slice(0, 5),
    };

    // Last hour against the 3 hours before.
    const c = (cmp?.series ?? []).map(cleanRow).filter((r) => r.kind === kind);
    const cs = compareSpec(now, compareMinutes);
    const lastStart = cs.from + 3 * cs.bucket;
    const recent = c.filter((r) => Number(r.bucket) >= lastStart);
    const base = c.filter((r) => Number(r.bucket) < lastStart);
    const ri = rowIndex(kind, sumRows(recent));
    const bi = rowIndex(kind, sumRows(base));
    out.compare[kind] = compareIndex({ n: ri.n, obs: ri.obs, exp: ri.exp, v: kind === 'upgrade' ? sumRows(recent).vw ?? 0 : sumRows(recent).vh ?? 0 }, { n: bi.n, obs: bi.obs, exp: bi.exp, v: kind === 'upgrade' ? sumRows(base).vw ?? 0 : sumRows(base).vh ?? 0 });
    const sr = sumRows(recent);
    const sb = sumRows(base);
    out.compareMoney[kind] = compareRatios(
      { n: sr.n ?? 0, players: sr.players ?? 0, sx: sr.sx ?? 0, sy: sr.sy ?? 0, gxx: sr.gxx ?? 0, gyy: sr.gyy ?? 0, gxy: sr.gxy ?? 0 },
      { n: sb.n ?? 0, players: sb.players ?? 0, sx: sb.sx ?? 0, sy: sb.sy ?? 0, gxx: sb.gxx ?? 0, gyy: sb.gyy ?? 0, gxy: sb.gxy ?? 0 },
    );

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
  }

  out.bands = (report?.bands ?? []).map(cleanRow).sort((a, b) => String(a.band).localeCompare(String(b.band))).map((b) => ({
    band: b.band,
    label: { a: 'under 10%', b: '10–30%', c: '30–60%', d: '60% and up' }[b.band] ?? b.band,
    n: b.n,
    players: b.players,
    index: indexOf({ n: b.n, obs: b.w, exp: b.ew, v: b.vw }),
    winRate: b.n ? b.w / b.n : null,
    shownRate: b.n ? b.ew / b.n : null,
    money: ratioOf({ n: b.n, players: 0, sx: b.sx, sy: b.sy }),
  }));
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
