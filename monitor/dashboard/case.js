// One case's results for the case lookup: paste a case link, see what the case pays back.
// The data comes from monitor_case (the running half-hour totals for that case): opens, staked, returned and hits
// per window, and per-player sums over the range so return per 1 gets a range clustered by player.

import { HOUR, ratioOf } from './stats.js';

const DAY = 24 * HOUR;
const SLOT = 30 * 60 * 1000;

/** Ranges the lookup offers, with the window each chart point covers. "all" asks for 400 days (the totals' limit). */
export const CASE_RANGES = {
  '24h': { label: '24 hours', span: DAY, bucket: HOUR },
  '7d': { label: '7 days', span: 7 * DAY, bucket: 6 * HOUR },
  '30d': { label: '30 days', span: 30 * DAY, bucket: DAY },
  all: { label: 'all time', span: 400 * DAY, bucket: DAY },
};

/**
 * Case slug from what was pasted: a case page link (https://caser.gg/en/cases/{slug}, with or without the
 * language part, query or trailing slash) or the slug itself. Null when it is neither.
 */
export function caseSlugFrom(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  let path = s;
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^[\w-]+(\.[\w-]+)+\//.test(s)) path = new URL(/:\/\//.test(s) ? s : `https://${s}`).pathname;
  } catch {
    return null;
  }
  const m = path.match(/(?:^|\/)cases\/([^/?#]+)\/?(?:[?#].*)?$/i);
  let slug = m ? m[1] : path.includes('/') ? null : path;
  if (!slug) return null;
  try {
    slug = decodeURIComponent(slug);
  } catch {
    return null;
  }
  return /^[A-Za-z0-9_-]{1,200}$/.test(slug) ? slug : null;
}

/** Range and window for a lookup, in whole half hours; the current half hour is included. */
export function caseSpec(key, now) {
  const r = CASE_RANGES[key] ?? CASE_RANGES['7d'];
  const to = Math.floor(now / SLOT) * SLOT + SLOT;
  const from = Math.floor((to - r.span) / r.bucket) * r.bucket;
  return { key: CASE_RANGES[key] ? key : '7d', label: r.label, from, to, bucket: r.bucket };
}

/**
 * What the page shows for one case: totals over the range and a running (cumulative) return per window.
 * @param {any} data  monitor_case answer
 * @param {ReturnType<typeof caseSpec>} spec
 */
export function caseReport(data, spec) {
  const t = data?.total ?? {};
  const num = (v) => Number(v) || 0;
  const total = { n: num(t.n), players: num(t.players), sx: num(t.sx), sy: num(t.sy), gxx: num(t.gxx), gyy: num(t.gyy), gxy: num(t.gxy) };
  const money = ratioOf(total);
  const hits = num(t.hits);
  let cx = 0, cy = 0, cn = 0;
  const windows = (data?.windows ?? []).map((w) => {
    const x = num(w.x), y = num(w.y), n = num(w.n);
    cx += x; cy += y; cn += n;
    return { start: num(w.bucket), end: num(w.bucket) + spec.bucket, n, players: num(w.players), hits: num(w.hits), x, y,
      ratio: x > 0 ? y / x : null, cumN: cn, cumRatio: cx > 0 ? cy / cx : null };
  });
  const first = data?.first == null ? null : num(data.first);
  return {
    slug: data?.slug ?? null,
    price: data?.price == null ? null : num(data.price),
    first,
    last: data?.last == null ? null : num(data.last),
    // The chart starts where the case's data starts, not 400 days back.
    chartFrom: Math.max(spec.from, first != null ? Math.floor(first / spec.bucket) * spec.bucket : spec.from),
    n: total.n,
    players: total.players,
    staked: total.sx,
    returned: total.sy,
    houseEdge: total.sx > 0 ? (total.sx - total.sy) / total.sx : null,
    money,
    hits,
    hitRate: total.n > 0 ? hits / total.n : null,
    windows,
    matches: Array.isArray(data?.matches) ? data.matches.map(String) : [],
  };
}
