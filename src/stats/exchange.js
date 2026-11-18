// Rank item-replacement candidates by the money they really sell for on CSFloat, liquid items first.

/**
 * @typedef {import('../capture/replacements.js').Candidate} Candidate
 * @typedef {import('../prices/csfloat.js').PriceSummary} PriceSummary
 * @typedef {'typical'|'fast'} Basis
 * @typedef {Candidate & {market: PriceSummary|null, error: string|null, liquid: boolean, sell: number|null, delta: number|null, perK: number|null}} ExchangeRow
 */

/**
 * What you receive selling the item on CSFloat after the seller fee.
 * typical: at the median recent sale price; fast: at the 25th percentile (priced to sell quickly).
 * @param {PriceSummary|null|undefined} m
 * @param {Basis} [basis]
 */
export function sellValue(m, basis = 'typical') {
  if (!m) return null;
  const v = basis === 'fast' ? m.quickNet : m.net;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * @param {Candidate[]} candidates
 * @param {(name: string) => {summary?: PriceSummary|null, error?: string|null}|undefined} lookup
 * @param {{minSales?: number, sort?: 'value'|'sales', basis?: Basis, currentValue?: number|null}} [opts]
 *   minSales: sales in the last 30 days for an item to count as liquid.
 *   basis: which sell price ranks and compares the items.
 *   currentValue: sell value (same basis) of the item being replaced, for the delta column.
 * @returns {ExchangeRow[]} liquid rows first; inside each group sorted by `sort` (default value), then site price.
 */
export function rankCandidates(candidates, lookup, opts = {}) {
  const minSales = opts.minSales ?? 3;
  const sort = opts.sort ?? 'value';
  const basis = opts.basis === 'fast' ? 'fast' : 'typical';
  const cur = typeof opts.currentValue === 'number' && Number.isFinite(opts.currentValue) ? opts.currentValue : null;
  const rows = (Array.isArray(candidates) ? candidates : []).map((c) => {
    const l = lookup(c.name) || {};
    const market = l.summary ?? null;
    const sell = sellValue(market, basis);
    return {
      ...c,
      market,
      error: l.error ?? null,
      sell,
      liquid: !!market && sell !== null && market.sales30d >= minSales,
      delta: sell !== null && cur !== null ? sell - cur : null,
      // Euros received per 1000 site coins: how much real money the site price buys.
      perK: sell !== null && c.price > 0 ? (sell / c.price) * 1000 : null,
    };
  });
  const v = (r) => r.sell ?? -Infinity;
  const sales = (r) => r.market?.sales30d ?? -1;
  rows.sort((a, b) => {
    if (a.liquid !== b.liquid) return a.liquid ? -1 : 1;
    const d = sort === 'sales' ? sales(b) - sales(a) || v(b) - v(a) : v(b) - v(a) || sales(b) - sales(a);
    return d || b.price - a.price;
  });
  return rows;
}

/**
 * @typedef {{
 *   kind: 'replace'|'keep'|'even'|'unknown',
 *   reason: 'value'|'liquidity'|'no-liquid'|'no-current'|'close',
 *   best: ExchangeRow|null,
 *   delta: number|null,
 *   margin: number|null,
 *   currentLiquid: boolean,
 * }} Verdict
 */

/**
 * Whether swapping is worth it: compares the best liquid offer (by sell value) against the item being replaced.
 * Differences inside the margin (2% of the current value, at least €0.10) count as even, since recent sale
 * prices are noisy. When the current item itself does not sell (under minSales), an even or better liquid
 * offer is worth taking for liquidity alone.
 * @param {ExchangeRow[]} rows from rankCandidates (same basis as currentSell)
 * @param {number|null} currentSell
 * @param {{sales30d?: number}|null} currentMarket
 * @param {{minSales?: number}} [opts]
 * @returns {Verdict}
 */
export function replaceVerdict(rows, currentSell, currentMarket, opts = {}) {
  const minSales = opts.minSales ?? 3;
  const liquid = (Array.isArray(rows) ? rows : []).filter((r) => r.liquid && typeof r.sell === 'number');
  const best = liquid.reduce((a, r) => (!a || r.sell > a.sell ? r : a), null);
  const currentLiquid = !!currentMarket && (currentMarket.sales30d ?? 0) >= minSales;
  const out = (kind, reason, delta = null, margin = null) => ({ kind, reason, best, delta, margin, currentLiquid });
  if (typeof currentSell !== 'number' || !Number.isFinite(currentSell)) return out('unknown', 'no-current');
  if (!best) return out('keep', 'no-liquid');
  const delta = best.sell - currentSell;
  const margin = Math.max(0.1, currentSell * 0.02);
  if (delta > margin) return out('replace', 'value', delta, margin);
  if (!currentLiquid && delta >= -margin) return out('replace', 'liquidity', delta, margin);
  if (delta < -margin) return out('keep', 'value', delta, margin);
  return out('even', 'close', delta, margin);
}
