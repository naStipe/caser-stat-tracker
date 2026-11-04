// Event shapes shared by every module. See docs/CONTRACT.md for the full description.

/** @typedef {{id:string|null, name:string, price:number, rarity:string|null, image:string|null}} Item */

/**
 * @typedef {Object} BaseEvent
 * @property {string} id
 * @property {'case'|'upgrade'} kind
 * @property {number} ts
 * @property {string} site
 * @property {string|null} userId
 * @property {'live'|'import'} source
 * @property {number|null} balanceBefore
 * @property {number|null} balanceAfter
 */

/**
 * @typedef {BaseEvent & {
 *   kind:'case', caseSlug:string, caseId:string|null, caseName:string, casePrice:number,
 *   free:boolean, batchId:string, batchSize:number, gameMode:string, item:Item
 * }} CaseEvent
 */

/**
 * @typedef {BaseEvent & {
 *   kind:'upgrade', stake:number, betItems:Item[], addedBalance:number, target:Item|null,
 *   mystery:boolean, mysteryMultiplier:number|null, gameMode:string,
 *   chanceShown:number|null, chanceServer:number|null,   // null for mystery upgrades (hidden chance)
 *   status:'won'|'lost'|'pending', won:boolean,
 *   superDrop:{shown:boolean, won:boolean, item:Item|null}|null,
 *   compensation:Item[], returned:number, net:number
 * }} UpgradeEvent
 */

/**
 * @typedef {BaseEvent & {kind:'deposit', amount:number, method:string, status:string, completedTs:number|null}} DepositEvent
 * @typedef {BaseEvent & {kind:'withdrawal', item:Item, value:number, exactTime:boolean}} WithdrawalEvent
 */

/** @typedef {CaseEvent|UpgradeEvent|DepositEvent|WithdrawalEvent} Event */

export const SCHEMA_VERSION = 1;

// The site multiplies the fair chance by this factor before showing it (see CONTRACT.md).
export const SHOWN_CHANCE_FACTOR = 1.03;

/** Parse the site's money strings ("79.000") and numbers. Returns 0 for junk. */
export function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Same as num() but keeps "missing" as null. */
export function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = num(v);
  return n === 0 && !(v === 0 || v === '0' || /^0+(\.0+)?$/.test(String(v))) ? null : n;
}

/** Normalize any item-like object from the API into an Item. */
export function toItem(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const inner = o.item && typeof o.item === 'object' ? o.item : {};
  return {
    id: o.id != null ? String(o.id) : inner.id != null ? String(inner.id) : null,
    name: String(o.marketName ?? o.market_name ?? o.name ?? inner.marketName ?? inner.name ?? 'Unknown item'),
    price: num(o.price ?? inner.price),
    rarity: o.rarity ?? inner.rarity ?? null,
    image: o.image ?? inner.image ?? null,
  };
}

/** Shown chance in percent, the way the site computes it on the client. */
export function shownChance(stake, targetPrice) {
  if (!(stake > 0) || !(targetPrice > 0)) return 0;
  return Math.min(Math.max((stake / targetPrice) * 100 * SHOWN_CHANCE_FACTOR, 0), 100);
}

/** Small deterministic string hash (FNV-1a, 32 bit) for ids when the server gives none. */
export function hashId(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
