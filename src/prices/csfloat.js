// CSFloat market prices for item names, used to rank the site's item-replacement candidates by the money they
// really sell for. Uses the public sales-history endpoint (no login): GET /api/v1/history/{market_hash_name}/sales
// returns the newest ~40 sales, each with its float and a `reference` block (CSFloat's base price and the number of
// active listings). Prices from CSFloat are in US cents. The cache keeps summaries in US dollars; the client hands
// them out in euros, converted with CSFloat's own exchange rate (GET /api/v1/meta/exchange-rates, USD based).
// Only item names are sent to CSFloat. Nothing about the user is sent.

export const CSFLOAT_ORIGIN = 'https://csfloat.com';
/** CSFloat's seller fee on a completed sale. */
export const CSFLOAT_SELLER_FEE = 0.02;
const DAY = 86_400_000;

/** CSFloat's exchange rates, as units of each currency per US dollar: {data: {eur: 0.91, ...}}. */
export const RATES_URL = `${CSFLOAT_ORIGIN}/api/v1/meta/exchange-rates`;

export function salesUrl(name) {
  return `${CSFLOAT_ORIGIN}/api/v1/history/${encodeURIComponent(name)}/sales`;
}

/** CSFloat search page for an item, cheapest listings first (opened by the user, never fetched). */
export function marketUrl(name) {
  return `${CSFLOAT_ORIGIN}/search?market_hash_name=${encodeURIComponent(name)}&sort_by=lowest_price`;
}

const ok = (v) => typeof v === 'number' && Number.isFinite(v);
const cents = (v) => (ok(Number(v)) && Number(v) > 0 ? Number(v) / 100 : null);

/** Linear-interpolated quantile of a sorted list, q in [0, 1]. */
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
const median = (xs) => quantile([...xs].sort((a, b) => a - b), 0.5);

/**
 * One sale as kept in the cache: [ts in minutes, price in cents, float × 10 000 or null]. Compact because the cache
 * lives in the site's localStorage.
 * @typedef {[number, number, number|null]} SalePoint
 */

/** @param {SalePoint[]} pts @returns {{ts: number, price: number, float: number|null}[]} newest first */
export function expandPoints(pts) {
  return (Array.isArray(pts) ? pts : []).map((p) => ({ ts: p[0] * 60_000, price: p[1] / 100, float: p[2] === null || p[2] === undefined ? null : p[2] / 10_000 }));
}

/**
 * @typedef {Object} PriceSummary
 * Money fields are US dollars in the cache and euros once the client hands a summary out.
 * @property {number|null} value      typical sale price: median of recent sales without outliers
 * @property {number|null} quick      fast-sale price: 25th percentile of the same sales (undercut to sell fast)
 * @property {number|null} net        value after CSFloat's seller fee: what you receive selling at the typical price
 * @property {number|null} quickNet   quick after the fee
 * @property {'sales'|'reference'|'last'|null} source  what `value` is based on
 * @property {number|null} windowDays sales window behind value: 30 or 90 days (null when not from sales)
 * @property {number} used            sales behind value (after outliers are dropped)
 * @property {number|null} low        lowest of those sales
 * @property {number|null} high       highest of those sales
 * @property {number|null} spread     (75th − 25th percentile) / median: how much prices scatter
 * @property {number|null} trend      median of the last 14 days / median of days 14 to 90, minus 1
 * @property {number|null} basePrice  CSFloat reference (base) price
 * @property {number|null} lastPrice  newest sale
 * @property {number|null} lastSaleTs
 * @property {number} sales7d
 * @property {number} sales30d
 * @property {boolean} salesCapped    every returned sale is inside 30 days, so sales30d is a lower bound
 * @property {{cut: number, lowMin: number, lowMax: number, highMin: number, highMax: number, upper: number, lowShare: number}|null} split
 *   two price groups were found; value/quick then come from the lower group
 * @property {number|null} listings   active CSFloat listings
 * @property {number} n               sales returned
 * @property {SalePoint[]} pts        all returned sales, newest first
 */

/** Sales CSFloat returns per history request. */
const HISTORY_PAGE = 40;

/**
 * Finds two price groups in a list of sale prices: the widest gap between neighbouring sorted prices, at least 8%
 * of the median, with at least 20% of the sales (and at least 3) on each side.
 * @param {number[]} prices
 * @returns {{cut: number, lowMin: number, lowMax: number, highMin: number, highMax: number, upper: number, lowShare: number}|null}
 */
export function findSplit(prices) {
  const p = [...prices].sort((a, b) => a - b);
  const n = p.length;
  if (n < 8) return null;
  const m = quantile(p, 0.5);
  const side = Math.max(3, Math.ceil(n * 0.2));
  let best = -1;
  let at = -1;
  for (let i = side; i <= n - side; i++) {
    const gap = p[i] - p[i - 1];
    if (gap > best) [best, at] = [gap, i];
  }
  if (at < 0 || best < m * 0.08) return null;
  const high = p.slice(at);
  return { cut: (p[at - 1] + p[at]) / 2, lowMin: p[0], lowMax: p[at - 1], highMin: p[at], highMax: p[n - 1], upper: quantile(high, 0.5), lowShare: at / n };
}

/**
 * Summarize a sales-history response into what the item really sells for.
 * Sales window: the newest 20 sales of the last 30 days; with fewer than 3, the newest 10 of the last 90 days.
 * Sales below half or above 1.5× the window median are dropped (sticker crafts, rare patterns, mistakes).
 * value = median of what is left, quick = its 25th percentile. With fewer than 3 such sales: CSFloat's reference
 * price, else the last sale. net / quickNet subtract CSFloat's seller fee.
 * @param {any} rows
 * @param {number} [now]
 * @returns {PriceSummary}
 */
export function summarizeSales(rows, now = Date.now()) {
  const list = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && typeof r === 'object' && (r.state === undefined || r.state === 'sold'))
    .map((r) => {
      const raw = r.item?.float_value;
      const fv = raw === null || raw === undefined ? NaN : Number(raw);
      return {
        ts: Date.parse(r.sold_at ?? r.created_at ?? ''),
        price: cents(r.price),
        float: ok(fv) ? fv : null,
        ref: r.reference && typeof r.reference === 'object' ? r.reference : null,
      };
    })
    .filter((r) => ok(r.ts) && r.price !== null)
    .sort((a, b) => b.ts - a.ts);
  const within = (ms) => list.filter((r) => now - r.ts <= ms);
  const recent = within(30 * DAY);
  const ref = list.find((r) => r.ref)?.ref ?? null;
  const basePrice = ref ? cents(ref.base_price) : null;
  const listings = ref && ok(Number(ref.quantity)) ? Number(ref.quantity) : null;
  const lastPrice = list.length ? list[0].price : null;

  let windowDays = 30;
  let win = recent.slice(0, 20);
  if (win.length < 3) [windowDays, win] = [90, within(90 * DAY).slice(0, 10)];
  const m0 = median(win.map((r) => r.price));
  const clean = (p) => p >= m0 * 0.5 && p <= m0 * 1.5;
  let kept = win.length >= 3 ? win.map((r) => r.price).filter(clean).sort((a, b) => a - b) : [];
  // Two price groups (Doppler phases, patterns, low floats sell for more): price on the lower group, the one a
  // random item most surely reaches, and report the upper group as upside.
  const split = kept.length >= 3 ? findSplit(within(windowDays * DAY).map((r) => r.price).filter(clean)) : null;
  if (split) {
    const lower = kept.filter((p) => p < split.cut);
    if (lower.length >= 3) kept = lower;
  }

  let value = null;
  let quick = null;
  let source = null;
  let spread = null;
  if (kept.length >= 3) {
    value = quantile(kept, 0.5);
    quick = quantile(kept, 0.25);
    spread = (quantile(kept, 0.75) - quick) / value;
    source = 'sales';
  } else if (basePrice !== null) [value, quick, source] = [basePrice, basePrice, 'reference'];
  else if (lastPrice !== null) [value, quick, source] = [lastPrice, lastPrice, 'last'];
  if (source !== 'sales') windowDays = null;

  const newer = list.filter((r) => now - r.ts <= 14 * DAY).map((r) => r.price);
  const older = list.filter((r) => now - r.ts > 14 * DAY && now - r.ts <= 90 * DAY).map((r) => r.price);
  const trend = newer.length >= 3 && older.length >= 3 ? median(newer) / median(older) - 1 : null;

  const fee = (v) => (v === null ? null : v * (1 - CSFLOAT_SELLER_FEE));
  return {
    value,
    quick,
    net: fee(value),
    quickNet: fee(quick),
    source,
    windowDays,
    used: source === 'sales' ? kept.length : 0,
    low: source === 'sales' ? kept[0] : null,
    high: source === 'sales' ? kept[kept.length - 1] : null,
    spread,
    trend,
    basePrice,
    lastPrice,
    lastSaleTs: list.length ? list[0].ts : null,
    split: source === 'sales' && split && kept[kept.length - 1] < split.cut ? split : null,
    sales7d: within(7 * DAY).length,
    sales30d: recent.length,
    // CSFloat returns at most ~40 sales. When all of them are inside 30 days, the real count is higher.
    salesCapped: list.length >= HISTORY_PAGE && recent.length === list.length,
    listings,
    n: list.length,
    pts: list.map((r) => [Math.round(r.ts / 60_000), Math.round(r.price * 100), r.float === null ? null : Math.round(r.float * 10_000)]),
  };
}

/**
 * A summary with every money field multiplied by `rate` (US dollars to the display currency).
 * @param {PriceSummary} s
 * @param {number} rate
 * @returns {PriceSummary}
 */
export function convertSummary(s, rate) {
  const x = (v) => (typeof v === 'number' && Number.isFinite(v) ? v * rate : v);
  const sp = s.split;
  return {
    ...s,
    value: x(s.value),
    quick: x(s.quick),
    net: x(s.net),
    quickNet: x(s.quickNet),
    low: x(s.low),
    high: x(s.high),
    basePrice: x(s.basePrice),
    lastPrice: x(s.lastPrice),
    split: sp ? { ...sp, cut: x(sp.cut), lowMin: x(sp.lowMin), lowMax: x(sp.lowMax), highMin: x(sp.highMin), highMax: x(sp.highMax), upper: x(sp.upper) } : sp,
    pts: (Array.isArray(s.pts) ? s.pts : []).map((p) => [p[0], Math.round(p[1] * rate), p[2]]),
  };
}

/**
 * Price client with a cache and a request queue (one request at a time, a gap between requests). Summaries come
 * out in euros. The USD to EUR rate is fetched once per ttlMs; when a refresh fails, the last stored rate is used.
 * @param {{
 *   request: (url: string) => Promise<{status: number, json: any}>,
 *   storage?: {get: (k: string, d: any) => any, set: (k: string, v: any) => void},
 *   now?: () => number,
 *   ttlMs?: number,
 *   gapMs?: number,
 *   maxEntries?: number,
 * }} o
 */
export function createPriceClient(o) {
  const now = o.now ?? (() => Date.now());
  const ttlMs = o.ttlMs ?? 6 * 3600_000;
  const gapMs = o.gapMs ?? 350;
  const maxEntries = o.maxEntries ?? 300;
  // v3: summaries carry sale points, after-fee prices, price groups and the sales cap.
  const KEY = 'cst.csfloat.v3';
  /** @type {Record<string, {ts: number, s: PriceSummary}>} */
  let cache = {};
  try {
    const c = o.storage?.get(KEY, {});
    if (c && typeof c === 'object') cache = c;
  } catch {}
  try {
    for (const old of ['cst.csfloat.v1', 'cst.csfloat.v2']) o.storage?.remove?.(old);
  } catch {}
  const RATE_KEY = 'cst.csfloat.eur';
  /** @type {{ts: number, rate: number}|null} */
  let fx = null;
  try {
    const r = o.storage?.get(RATE_KEY, null);
    if (r && ok(r.rate) && r.rate > 0 && ok(r.ts)) fx = r;
  } catch {}
  let rateBusy = null;
  /** Converted summaries, so repeated reads of one cache entry return one object. */
  const converted = new WeakMap();
  const inflight = new Map();
  let queue = Promise.resolve();
  let pausedUntil = 0;

  function inEur(s) {
    const c = converted.get(s);
    if (c && c.rate === fx.rate) return c.out;
    const out = convertSummary(s, fx.rate);
    converted.set(s, { rate: fx.rate, out });
    return out;
  }

  /** Makes sure a USD to EUR rate is known, fetching it when missing or older than ttlMs. */
  function ensureRate() {
    if (fx && now() - fx.ts < ttlMs) return Promise.resolve();
    if (rateBusy) return rateBusy;
    rateBusy = (async () => {
      try {
        const res = await o.request(RATES_URL);
        const rate = Number(res?.json?.data?.eur);
        if (res.status < 200 || res.status >= 300 || !ok(rate) || rate <= 0) throw new Error(`CSFloat exchange rate HTTP ${res.status}`);
        fx = { ts: now(), rate };
        try {
          o.storage?.set(RATE_KEY, fx);
        } catch {}
      } catch (e) {
        if (!fx) throw new Error(`No USD to EUR rate: ${e?.message || e}`);
      } finally {
        rateBusy = null;
      }
    })();
    return rateBusy;
  }

  function save() {
    const keys = Object.keys(cache);
    if (keys.length > maxEntries) {
      keys.sort((a, b) => cache[a].ts - cache[b].ts);
      for (const k of keys.slice(0, keys.length - maxEntries)) delete cache[k];
    }
    try {
      o.storage?.set(KEY, cache);
    } catch {}
  }

  /** Fresh cached summary in US dollars, or null. */
  function cachedUsd(name) {
    const c = cache[name];
    return c && now() - c.ts < ttlMs ? c.s : null;
  }

  /** Fresh cached summary in euros, or null (also while no exchange rate is known). */
  function cached(name) {
    const s = cachedUsd(name);
    return s && fx ? inEur(s) : null;
  }

  /** @returns {Promise<PriceSummary>} in euros */
  function get(name) {
    const hit = cached(name);
    if (hit && now() - fx.ts < ttlMs) return Promise.resolve(hit);
    if (inflight.has(name)) return inflight.get(name);
    const p = (queue = queue.catch(() => {}).then(async () => {
      await ensureRate();
      const again = cachedUsd(name);
      if (again) return inEur(again);
      const wait = Math.max(0, pausedUntil - now());
      if (wait) await sleep(wait);
      const res = await o.request(salesUrl(name));
      if (res.status === 429) {
        pausedUntil = now() + 30_000;
        throw new Error('CSFloat rate limit, retry in 30 s');
      }
      if (res.status === 404) {
        const s = summarizeSales([], now());
        cache[name] = { ts: now(), s };
        save();
        return inEur(s);
      }
      if (res.status < 200 || res.status >= 300) throw new Error(`CSFloat HTTP ${res.status}`);
      const s = summarizeSales(res.json, now());
      cache[name] = { ts: now(), s };
      save();
      await sleep(gapMs);
      return inEur(s);
    }));
    inflight.set(name, p);
    p.finally(() => inflight.delete(name)).catch(() => {});
    return p;
  }

  return { get, cached };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
