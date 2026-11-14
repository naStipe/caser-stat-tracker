// Turns the database answers (monitor_agg, monitor_volume_agg) into what the dashboard shows.
// Pure, so the tests can run it.

import { HOUR, ratioOf, compareRatios, combine, cleanAggregate } from './stats.js';

const MIN = 60 * 1000;
const DAY = 24 * HOUR;

/** Time ranges the page offers, with the bucket size each one is drawn in. */
export const RANGES = {
  '6h': { label: '6 hours', span: 6 * HOUR, bucket: 30 * MIN },
  '24h': { label: '24 hours', span: DAY, bucket: HOUR },
  '3d': { label: '3 days', span: 3 * DAY, bucket: 3 * HOUR },
  '7d': { label: '7 days', span: 7 * DAY, bucket: 6 * HOUR },
  '30d': { label: '30 days', span: 30 * DAY, bucket: DAY },
};

/** Buckets aligned to the bucket size, the current (partial) one last. */
export function rangeSpec(key, now) {
  const r = RANGES[key] ?? RANGES['24h'];
  const to = Math.floor(now / r.bucket) * r.bucket + r.bucket;
  const from = to - Math.ceil(r.span / r.bucket) * r.bucket;
  return { key: RANGES[key] ? key : '24h', label: r.label, from, to, bucket: r.bucket };
}

/** The comparison: the last hour against the 3 hours before it. */
export function compareWindows(now) {
  return { recent: { from: now - HOUR, to: now + 1 }, base: { from: now - 4 * HOUR, to: now - HOUR } };
}

const numOrNull = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export function cleanVolume(v) {
  return { bucket: Number(v.bucket), samples: Number(v.samples) || 0, casesPerMin: numOrNull(v.cases_per_min), upgradesPerMin: numOrNull(v.upgrades_per_min), online: numOrNull(v.online) };
}

const EMPTY_VOLUME = { bucket: 0, samples: 0, casesPerMin: null, upgradesPerMin: null, online: null };

/**
 * @param {Object} o
 * @param {any[]} o.recent  monitor_agg over the last hour (one bucket)
 * @param {any[]} o.base    monitor_agg over the 3 hours before (one bucket)
 * @param {any[]} o.series  monitor_agg over the range, per bucket
 * @param {any[]} o.volume  monitor_volume_agg over the range, per bucket
 * @param {any[]} o.volRecent  monitor_volume_agg over the last hour
 * @param {any[]} o.volBase    monitor_volume_agg over the 3 hours before
 * @param {ReturnType<typeof rangeSpec>} o.spec
 * @param {number} o.now
 */
export function buildView({ recent, base, series, volume, volRecent, volBase, spec, now }) {
  const kinds = ['upgrade', 'case'];
  const rec = recent.map(cleanAggregate);
  const bas = base.map(cleanAggregate);
  const ser = series.map(cleanAggregate);
  const vol = volume.map(cleanVolume);
  const compare = {};
  const total = {};
  for (const k of kinds) {
    compare[k] = compareRatios(combine(rec, k), combine(bas, k));
    total[k] = ratioOf(combine(ser, k));
  }
  const buckets = [];
  for (let t = spec.from; t < spec.to; t += spec.bucket) {
    const row = { start: t, end: Math.min(t + spec.bucket, now) };
    for (const k of kinds) row[k] = ratioOf(ser.find((a) => a.bucket === t && a.kind === k));
    row.volume = vol.find((v) => v.bucket === t) ?? { ...EMPTY_VOLUME, bucket: t };
    buckets.push(row);
  }
  return {
    now,
    spec,
    windows: compareWindows(now),
    compare,
    total,
    buckets, // oldest first
    volume: { recent: volRecent[0] ? cleanVolume(volRecent[0]) : EMPTY_VOLUME, base: volBase[0] ? cleanVolume(volBase[0]) : EMPTY_VOLUME },
  };
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
  return { level: 'ok', text: 'Running.', at };
}
