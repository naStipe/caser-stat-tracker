// Pulse statistics for the dashboard page (and the tests). Pure: rows or aggregates in, plain objects out.
//
// An aggregate holds sums over the rows of one time bucket and one kind, so the same numbers can
// come from rows (aggregate()) or from the database (monitor_agg in supabase/migrations/*_monitor.sql):
//   {bucket, kind, n, players, sx, sy, sxx, syy, sxy, gxx, gyy, gxy}
//   x = stake, y = returned. g* are the same sums over per-player totals (one term per player),
//   used for a standard error that treats each player's rows as one cluster: rows of one player
//   are not independent (same habits, same stake sizes), so a per-row error would be too small.

export const HOUR = 60 * 60 * 1000;
const Z95 = 1.959964;
/** Fewer players than this and the clustered error is not trusted. */
export const MIN_PLAYERS = 5;

/** Group rows into buckets of `bucketMs` from `from` (inclusive) to `to` (exclusive), per kind. */
export function aggregate(rows, { from, to, bucketMs }) {
  const buckets = new Map();
  for (const r of rows) {
    if (!(r.ts >= from && r.ts < to) || !(r.stake > 0)) continue;
    const bucket = from + Math.floor((r.ts - from) / bucketMs) * bucketMs;
    const key = `${bucket}|${r.kind}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { bucket, kind: r.kind, rows: [], byUser: new Map() }));
    const x = r.stake;
    const y = r.returned || 0;
    b.rows.push([x, y]);
    const g = b.byUser.get(r.u) ?? [0, 0];
    g[0] += x;
    g[1] += y;
    b.byUser.set(r.u, g);
  }
  const out = [];
  for (const b of buckets.values()) {
    const a = { bucket: b.bucket, kind: b.kind, n: b.rows.length, players: b.byUser.size, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0, gxx: 0, gyy: 0, gxy: 0 };
    for (const [x, y] of b.rows) {
      a.sx += x;
      a.sy += y;
      a.sxx += x * x;
      a.syy += y * y;
      a.sxy += x * y;
    }
    for (const [x, y] of b.byUser.values()) {
      a.gxx += x * x;
      a.gyy += y * y;
      a.gxy += x * y;
    }
    out.push(a);
  }
  return out.sort((p, q) => p.bucket - q.bucket || p.kind.localeCompare(q.kind));
}

/** Database rows come back as strings for big numbers; make every field a number. */
export function cleanAggregate(a) {
  const n = (v) => (v == null ? 0 : Number(v) || 0);
  return {
    bucket: n(a.bucket),
    kind: String(a.kind),
    n: n(a.n),
    players: n(a.players),
    sx: n(a.sx),
    sy: n(a.sy),
    sxx: n(a.sxx),
    syy: n(a.syy),
    sxy: n(a.sxy),
    gxx: n(a.gxx),
    gyy: n(a.gyy),
    gxy: n(a.gxy),
  };
}

/**
 * Return per 1 staked (total returned / total staked) with a 95% interval clustered by player.
 * @returns {{n:number, players:number, staked:number, returned:number, ratio:number|null, se:number|null, ci:[number,number]|null}}
 */
export function ratioOf(a) {
  if (!a || !(a.sx > 0)) return { n: a?.n ?? 0, players: a?.players ?? 0, staked: 0, returned: 0, ratio: null, se: null, ci: null };
  const R = a.sy / a.sx;
  const G = a.players;
  let se = null;
  if (G >= MIN_PLAYERS) {
    // Linearised ratio estimator: residual per player = y_g - R x_g.
    const ss = Math.max(0, a.gyy - 2 * R * a.gxy + R * R * a.gxx);
    se = Math.sqrt((G / (G - 1)) * ss) / a.sx;
  }
  return { n: a.n, players: G, staked: a.sx, returned: a.sy, ratio: R, se, ci: se == null ? null : [Math.max(0, R - Z95 * se), R + Z95 * se] };
}

/** Sum several aggregates of one kind (bucket sums add up; players may be counted twice). */
export function combine(aggs, kind) {
  const out = { bucket: 0, kind, n: 0, players: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0, gxx: 0, gyy: 0, gxy: 0 };
  for (const a of aggs) {
    if (a.kind !== kind) continue;
    for (const k of ['n', 'players', 'sx', 'sy', 'sxx', 'syy', 'sxy', 'gxx', 'gyy', 'gxy']) out[k] += a[k];
  }
  return out;
}

const normCdf = (z) => {
  // Abramowitz-Stegun 7.1.26 on erf.
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
};

/**
 * Compare the recent window with the one before it.
 * verdict: 'better' | 'worse' | 'same' (no clear change) | 'few' (not enough data).
 * Both windows can share players, which makes the difference less noisy than assumed here,
 * so the test is on the cautious side.
 */
export function compareRatios(recent, base, { minRows = 30 } = {}) {
  const r = ratioOf(recent);
  const b = ratioOf(base);
  if (r.n < minRows || b.n < minRows || r.se == null || b.se == null) return { recent: r, base: b, diff: r.ratio != null && b.ratio != null ? r.ratio - b.ratio : null, z: null, p: null, verdict: 'few' };
  const diff = r.ratio - b.ratio;
  const se = Math.sqrt(r.se * r.se + b.se * b.se);
  const z = se > 0 ? diff / se : 0;
  const p = 2 * (1 - normCdf(Math.abs(z)));
  return { recent: r, base: b, diff, z, p, verdict: p < 0.05 ? (diff > 0 ? 'better' : 'worse') : 'same' };
}

/**
 * Site-wide activity from /api/statistics samples between from and to:
 * cases and upgrades per minute (counter growth), and average users online.
 */
export function volumeRates(samples, { from, to }) {
  const inWin = samples.filter((s) => s.ts >= from && s.ts < to).sort((a, b) => a.ts - b.ts);
  if (inWin.length < 2) return { samples: inWin.length, casesPerMin: null, upgradesPerMin: null, online: inWin[0]?.online ?? null };
  const first = inWin[0];
  const last = inWin[inWin.length - 1];
  const min = (last.ts - first.ts) / 60000;
  const rate = (k) => (min > 0 && last[k] >= first[k] ? (last[k] - first[k]) / min : null);
  const online = inWin.reduce((s, x) => s + (x.online || 0), 0) / inWin.length;
  return { samples: inWin.length, casesPerMin: rate('cases'), upgradesPerMin: rate('upgrades'), online };
}

/** Windows used by the Pulse tab: the last hour, the 3 hours before it, and the last 24 hours. */
export function pulseWindows(now) {
  return {
    recent: { from: now - HOUR, to: now + 1 },
    base: { from: now - 4 * HOUR, to: now - HOUR },
    day: { from: now - 24 * HOUR, to: now + 1 },
    // Hourly buckets aligned to the clock, the current (partial) hour last.
    hours: { from: Math.floor(now / HOUR) * HOUR - 23 * HOUR, to: Math.floor(now / HOUR) * HOUR + HOUR, bucketMs: HOUR },
  };
}

/**
 * Everything the Pulse tab shows, from aggregates per window plus volume samples.
 * @param {{recent:any[], base:any[], day:any[], hours:any[]}} aggs  aggregates per window (one bucket each, hours: hourly)
 * @param {any[]} samples  volume samples of the last 24 hours (or more)
 */
export function pulseSummary(aggs, samples, now) {
  const w = pulseWindows(now);
  const kinds = ['upgrade', 'case'];
  const compare = {};
  for (const k of kinds) compare[k] = compareRatios(combine(aggs.recent, k), combine(aggs.base, k));
  const day = {};
  for (const k of kinds) day[k] = ratioOf(combine(aggs.day, k));
  const hours = [];
  for (let t = w.hours.from; t < w.hours.to; t += HOUR) {
    const row = { start: t };
    for (const k of kinds) row[k] = ratioOf(aggs.hours.find((a) => a.bucket === t && a.kind === k));
    row.volume = volumeRates(samples, { from: t, to: t + HOUR });
    hours.push(row);
  }
  return {
    now,
    windows: { recent: w.recent, base: w.base },
    compare,
    day,
    hours: hours.reverse(),
    volume: { recent: volumeRates(samples, w.recent), base: volumeRates(samples, w.base) },
  };
}
