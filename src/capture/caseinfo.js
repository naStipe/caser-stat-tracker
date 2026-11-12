// Case contents: the items a case can drop, their prices and (custom cases only) their chances.
//
// Two endpoints, both public GETs the site itself calls on a case page:
//   GET /api/game/cases/{slug}         official case: {case: {...}, items: [{id, marketName, price, ...}]}
//                                      No chances: the site does not publish them for official cases.
//   GET /api/game/custom-cases/{slug}  custom case: {id, slug, title, price, items: [{item: {...}, chancePercent}]}
// The case page URL is /{locale}/cases/{slug} for both kinds. The site tries the official endpoint
// first and falls back to the custom one on 404; fetchCaseInfo does the same.

import { num, numOrNull } from '../schema.js';

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const arr = (v) => (Array.isArray(v) ? v : []);
const unwrap = (body) => (obj(body)?.data && typeof body.data === 'object' ? body.data : body);

/**
 * @typedef {{id:string|null, name:string, price:number, image:string|null, rarity:string|null, chance:number|null}} CaseItem
 *   chance is a percent (0-100), null when the site does not publish it.
 * @typedef {{slug:string, title:string, price:number, custom:boolean, items:CaseItem[]}} CaseInfo
 */

/** Case slug from a page path like "/en/cases/magnum" or "/cases/magnum". Null when not a case page. */
export function caseSlugFromPath(pathname) {
  const m = String(pathname || '').match(/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?cases\/([^/?#]+)\/?$/i);
  return m ? decodeURIComponent(m[1]) : null;
}

/** API path (after /api) of a case-contents response -> {slug, custom}, else null. */
export function caseDetailPath(path) {
  const m = String(path || '').split('?')[0].match(/^\/game\/(custom-)?cases\/([^/]+)$/);
  return m ? { slug: decodeURIComponent(m[2]), custom: !!m[1] } : null;
}

function toCaseItem(raw) {
  const o = obj(raw) ?? {};
  // Custom cases wrap the skin: {item: {...}, chancePercent}.
  const it = obj(o.item) ?? o;
  return {
    id: it.id != null ? String(it.id) : null,
    name: String(it.marketName ?? it.market_name ?? it.name ?? 'Unknown item'),
    price: num(it.price),
    image: typeof it.image === 'string' ? it.image : null,
    rarity: it.rarity != null ? String(it.rarity) : null,
    chance: numOrNull(o.chancePercent ?? o.chance ?? it.chance ?? null),
  };
}

/**
 * Normalize either case-contents response. Returns null when the body has no items.
 * @param {any} body
 * @param {{slug?: string, custom?: boolean}} hint
 * @returns {CaseInfo|null}
 */
export function caseInfoFromResponse(body, hint = {}) {
  const d = obj(unwrap(body));
  if (!d) return null;
  const c = obj(d.case) ?? d;
  const items = arr(d.items ?? c.items).map(toCaseItem).filter((i) => i.price > 0 || i.chance !== null);
  if (!items.length) return null;
  const slug = String(c.slug ?? hint.slug ?? '');
  if (!slug) return null;
  return {
    slug,
    title: String(c.title ?? c.name ?? slug),
    price: num(c.price),
    custom: !!hint.custom || !obj(d.case),
    items,
  };
}

/**
 * Fetch a case's contents the way the site does: official endpoint first, custom on 404.
 * @param {typeof fetch} fetchFn  the page's original fetch (not the hooked one)
 * @returns {Promise<CaseInfo|null>}
 */
export async function fetchCaseInfo(fetchFn, slug) {
  const enc = encodeURIComponent(slug);
  for (const [path, custom] of [[`/api/game/cases/${enc}`, false], [`/api/game/custom-cases/${enc}`, true]]) {
    const res = await fetchFn(path, { credentials: 'include', headers: { accept: 'application/json' } });
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`case info: HTTP ${res.status}`);
    const info = caseInfoFromResponse(await res.json(), { slug, custom });
    if (info) return info;
  }
  return null;
}
