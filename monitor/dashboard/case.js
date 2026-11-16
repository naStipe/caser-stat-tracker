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

/** Player id from a profile link (https://caser.gg/en/profile/824180) or the id itself. Null when it is neither. */
export function playerIdFrom(text) {
  const s = String(text ?? '').trim();
  if (/^[0-9]{1,20}$/.test(s)) return s;
  const m = s.match(/(?:^|\/)(?:profile|users?)\/([0-9]{1,20})(?:[/?#].*)?$/i);
  return m ? m[1] : null;
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

const Z = 1.959964;

/** Published odds of a case page read: the return they promise, and the items a watch counts (worth the price). */
export function publishedOdds(snap) {
  if (!snap || !(Number(snap.price) > 0)) return null;
  const price = Number(snap.price);
  const items = (Array.isArray(snap.items) ? snap.items : []).map((i) => ({ name: String(i.name ?? ''), price: Number(i.price) || 0, chance: i.chance == null ? null : Number(i.chance) }));
  const known = items.length > 0 && items.every((i) => Number.isFinite(i.chance));
  const ev = known ? items.reduce((s, i) => s + (i.chance / 100) * i.price, 0) : null;
  const hit = items.filter((i) => i.price >= price);
  const rest = items.filter((i) => i.price < price);
  const restChance = known ? rest.reduce((s, i) => s + i.chance, 0) : 0;
  const hitChance = known ? hit.reduce((s, i) => s + i.chance, 0) : 0;
  return {
    price,
    items: items.slice().sort((a, b) => b.price - a.price),
    known,
    chanceSum: known ? items.reduce((s, i) => s + i.chance, 0) : null,
    ev,
    ret: ev == null ? null : ev / price,
    hitNames: hit.map((i) => i.name),
    hitChance: known ? hitChance / 100 : null,
    // What a drop that is not a big one is worth on average, and what a big one is, by the published chances.
    restValue: restChance > 0 ? rest.reduce((s, i) => s + i.chance * i.price, 0) / restChance : 0,
    hitValue: hitChance > 0 ? hit.reduce((s, i) => s + i.chance * i.price, 0) / hitChance : null,
  };
}

/**
 * A watched case's real results: opens from the site's counter, big drops from the drop line (scaled up by the share
 * of the line the reads caught in each window), against the published chances.
 * @param {any} data  monitor_case_watch_report answer
 * @param {ReturnType<typeof caseSpec>} spec
 */
export function watchReport(data, spec) {
  const odds = publishedOdds(data?.latest);
  const feed = data?.feed ?? [];
  const cov = new Map(feed.map((f) => [Number(f.bucket), Number(f.span) > 0 ? Math.min(1, Number(f.seen) / Number(f.span)) : null]));
  const allSeen = feed.reduce((s, f) => s + (Number(f.seen) || 0), 0);
  const allSpan = feed.reduce((s, f) => s + (Number(f.span) || 0), 0);
  const avgCov = allSpan > 0 ? Math.min(1, allSeen / allSpan) : 1;
  const hitsBy = new Map();
  for (const x of data?.hits ?? []) {
    const b = Number(x.bucket);
    const o = hitsBy.get(b) ?? { n: 0, value: 0 };
    o.n += Number(x.n) || 0;
    o.value += Number(x.value) || 0;
    hitsBy.set(b, o);
  }
  const valueOf = (hits, value, opens) => (odds?.known && opens > 0 ? (value + Math.max(0, opens - hits) * odds.restValue) / (opens * odds.price) : null);
  let prev = data?.base?.opens != null ? Number(data.base.opens) : null;
  let O = 0, H = 0, Hadj = 0, Vadj = 0;
  const windows = [];
  for (const sn of data?.snaps ?? []) {
    const b = Number(sn.bucket);
    const last = Number(sn.lastOpens);
    const from = prev ?? Number(sn.firstOpens);
    // A counter that went backwards (a reset) counts nothing for the window.
    const opens = Math.max(0, last - from);
    prev = last;
    const h = hitsBy.get(b) ?? { n: 0, value: 0 };
    const c = cov.get(b) || avgCov;
    const scale = c > 0 ? 1 / c : 1;
    O += opens;
    H += h.n;
    Hadj += h.n * scale;
    Vadj += h.value * scale;
    windows.push({ start: b, end: b + spec.bucket, opens, hits: h.n, hitsAdj: h.n * scale, coverage: c, cumOpens: O, cumHitsAdj: Hadj,
      ret: valueOf(h.n * scale, h.value * scale, opens), cumRet: valueOf(Hadj, Vadj, O) });
  }
  const avgHit = Hadj > 0 ? Vadj / Hadj : odds?.hitValue ?? 0;
  const retAt = (hits) => valueOf(hits, hits * avgHit, O);
  // Poisson range on the big drops seen, scaled like the count itself (3.7: the upper end when none were seen).
  const scale = H > 0 ? Hadj / H : 1 / avgCov;
  const lo = H > 0 ? Math.max(0, H - Z * Math.sqrt(H)) * scale : 0;
  const hi = (H > 0 ? H + Z * Math.sqrt(H) : 3.7) * scale;
  const real = retAt(Hadj);
  return {
    watched: !!data?.watched,
    since: data?.since == null ? null : Number(data.since),
    watchCount: Number(data?.watchCount) || 0,
    latest: data?.latest ?? null,
    odds,
    opens: O,
    hits: H,
    hitsAdj: Hadj,
    coverage: avgCov,
    expected: odds?.hitChance != null ? O * odds.hitChance : null,
    rate: O > 0 ? Hadj / O : null,
    rateCi: O > 0 ? [lo / O, hi / O] : null,
    real,
    realCi: real != null ? [retAt(lo), retAt(hi)] : null,
    siteTake: real != null ? O * odds.price * (1 - real) : null,
    windows,
    nearOpens: Number(data?.nearOpens) || 0,
  };
}
