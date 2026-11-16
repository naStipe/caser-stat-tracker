// Turns the site's public history pages into small anonymous rows. Pure: no network, no files.
// A row is one paid case open or one settled upgrade:
//   {id, kind: 'upgrade' | 'case', ts, u, stake, returned, chance, back}
//   upgrades also: won; cases also: slug (the case), tier (the dropped item's rarity code)
// u is a salted hash of the player's site id; no names, items or inventories are kept. (Case watches keep the
// names and prices of catalogue items seen on the public drop line, never who dropped them.)
// Every field read is defensive because the API can change.

import { createHash } from 'node:crypto';

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const arr = (v) => (Array.isArray(v) ? v : []);
// Some endpoints wrap their body in {data: ...}.
const unwrap = (body) => (obj(body)?.data && typeof body.data === 'object' ? body.data : body);

/** The site's money strings ("79.000") and numbers. 0 for junk. */
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

/** Any item-like object -> {name, price, tier}. tier is the site's rarity code, as text. */
function item(raw) {
  const o = obj(raw) ?? {};
  const inner = obj(o.item) ?? {};
  const rarity = o.rarity ?? inner.rarity;
  return {
    name: String(o.marketName ?? o.market_name ?? o.name ?? inner.marketName ?? inner.name ?? ''),
    price: num(o.price ?? inner.price),
    tier: rarity == null || typeof rarity === 'object' ? null : String(rarity).slice(0, 32),
  };
}

/** The site multiplies the fair upgrade chance by this before showing it. */
const SHOWN_CHANCE_FACTOR = 1.03;

/** Case prices by slug, from /api/game/cases and /api/game/cases/{slug}. */
export class CasePrices {
  constructor() {
    this.bySlug = new Map();
    this.listed = new Set(); // slugs from the site's case list (official cases)
  }
  add(c) {
    const o = obj(c);
    if (o?.slug && num(o.price) > 0) this.bySlug.set(String(o.slug), num(o.price));
  }
  /** /api/game/cases answer. */
  learnList(body) {
    const d = unwrap(body);
    for (const c of arr(obj(d)?.cases ?? obj(d)?.items ?? d)) {
      this.add(c);
      if (obj(c)?.slug) this.listed.add(String(c.slug));
    }
  }
  /** /api/game/cases/{slug} answer ({case: {slug, price}}), or /api/game/custom-cases/{slug} ({slug, price}). */
  learnOne(body) {
    const d = unwrap(body);
    this.add(obj(obj(d)?.case) ?? d);
  }
  get(slug) {
    return this.bySlug.get(slug) ?? null;
  }
}

/** The items array of a paginated history answer. */
export function historyRows(body) {
  const d = unwrap(body);
  if (Array.isArray(d)) return d;
  const o = obj(d);
  if (!o) return [];
  for (const k of ['items', 'results', 'upgrades', 'bets', 'history', 'data']) if (Array.isArray(o[k])) return o[k];
  const inner = obj(o.data);
  if (inner) for (const k of ['items', 'results', 'upgrades', 'bets', 'history']) if (Array.isArray(inner[k])) return inner[k];
  return [];
}

/** Upgrade history page: {featured: [...], items: [...]}. Both lists, without repeats. */
export function upgradeHistoryRows(body) {
  const d = unwrap(body);
  const featured = arr(obj(d)?.featured ?? obj(obj(d)?.data)?.featured);
  const seen = new Set();
  const out = [];
  for (const r of [...historyRows(body), ...featured]) {
    const id = obj(r)?.id ?? obj(obj(r)?.bet)?.id;
    if (id != null && seen.has(String(id))) continue;
    if (id != null) seen.add(String(id));
    out.push(r);
  }
  return out;
}

/** One upgrade history record -> {id, ts, stake, returned, chance, won, names} or null. */
export function parseUpgrade(record) {
  const r = obj(record);
  if (!r) return null;
  const b = obj(r.bet) ?? r;
  const id = b.id ?? r.id;
  const ts = Date.parse(b.createdAt ?? r.createdAt ?? '') || 0;
  if (id == null || !ts) return null;

  const statusRaw = String(b.status ?? r.status ?? 'pending').toLowerCase();
  const status = statusRaw === 'won' || statusRaw === 'win' ? 'won' : statusRaw === 'lost' || statusRaw === 'lose' || statusRaw === 'loss' ? 'lost' : 'pending';
  if (status === 'pending') return null;
  const won = status === 'won';

  const betItems = arr(b.betItems ?? b.fromItems ?? b.items).map(item);
  const addedBalance = num(b.addedBalance ?? b.added_balance ?? b.balanceAdded);
  const stake = num(b.stake ?? b.betAmount ?? b.amount) || betItems.reduce((s, i) => s + i.price, 0) + addedBalance;
  if (!(stake > 0)) return null;

  const target = obj(b.targetItem ?? b.desiredItem ?? b.toItem) ? item(b.targetItem ?? b.desiredItem ?? b.toItem) : null;
  const wonRaw = obj(b.wonItem ?? b.resultItem);
  const sd = obj(b.superDrop ?? r.superDrop);
  const superItem = sd && obj(sd.item) ? item(sd.item) : null;
  const superWon = !!(sd && (sd.won ?? sd.win ?? sd.isWon ?? sd.success));
  const compensation = arr(r.compensationItems ?? b.compensationItems).map(item);

  // wonItem is what the player received: the target, a super-drop item, or a mystery item.
  let returned = 0;
  if (wonRaw) returned += item(wonRaw).price;
  else if (won) returned += (superWon && superItem ? superItem.price : 0) || target?.price || 0;
  returned += compensation.reduce((s, i) => s + i.price, 0);

  const mystery = !!(b.isMystery ?? r.isMystery);
  // Mystery upgrades hide the chance.
  const chanceRaw = mystery ? null : numOrNull(b.chance ?? b.winChance ?? b.probability);
  const chanceServer = chanceRaw === null || chanceRaw === 0 ? null : chanceRaw <= 1 ? chanceRaw * 100 : chanceRaw;
  const chance = mystery ? null : chanceServer ?? (target?.price > 0 ? Math.min((stake / target.price) * 100 * SHOWN_CHANCE_FACTOR, 100) : null);

  const names = [target?.name, superItem?.name].filter(Boolean);
  return { id: `upgrade:${id}`, ts, stake, returned, chance, won, names };
}

/**
 * Upgrade history page -> rows. Wins of an item named in `skip` are left out (the feed drop that
 * brought the player in, see collector.js). `back` marks rows read from history the player
 * already had when found.
 */
export function upgradeRows(body, u, { skip, back = false } = {}) {
  const out = [];
  for (const rec of upgradeHistoryRows(body)) {
    const e = parseUpgrade(rec);
    if (!e) continue;
    if (skip?.size && e.won && e.names.some((n) => skip.has(n))) continue;
    out.push({ id: e.id, kind: 'upgrade', ts: e.ts, u, stake: e.stake, returned: e.returned, chance: e.chance, won: e.won, back });
  }
  return out;
}

/**
 * Inventory history page -> case rows (action "won_case"). Drops from cases with an unknown price
 * are left out, and their slugs go into `unknownSlugs` so the caller can load the price.
 */
export function caseRows(body, prices, u, { unknownSlugs, skip, back = false } = {}) {
  const out = [];
  for (const rec of historyRows(body)) {
    const r = obj(rec);
    if (!r || r.action !== 'won_case' || obj(r.source)?.type !== 'case') continue;
    const c = obj(r.source.case) ?? obj(r.caseInfo);
    const slug = c?.slug ? String(c.slug) : null;
    const ts = Date.parse(r.createdAt ?? '') || 0;
    if (!slug || !ts || r.id == null) continue;
    const price = prices.get(slug);
    if (!(price > 0)) {
      unknownSlugs?.add(slug);
      continue;
    }
    const drop = item({ ...obj(r.item), price: r.price ?? obj(r.item)?.price });
    if (skip?.size && skip.has(drop.name)) continue;
    out.push({ id: `case:${r.id}`, kind: 'case', ts, u, stake: price, returned: drop.price, chance: null, slug, tier: drop.tier, back });
  }
  return out;
}

/** Drops in a /api/live-drops answer, by player: Map(player id -> Set of item names). */
export function feedDrops(body) {
  const o = obj(body) ?? {};
  const out = new Map();
  for (const d of [...arr(o.liveDrops), ...arr(o.hotDrops), ...arr(o.items)]) {
    const id = obj(obj(d)?.user)?.id;
    if (id == null || !/^[A-Za-z0-9_-]{1,64}$/.test(String(id))) continue;
    const name = obj(d.item)?.marketName ?? obj(d.item)?.name;
    if (!out.has(String(id))) out.set(String(id), new Set());
    if (typeof name === 'string') out.get(String(id)).add(name);
  }
  return out;
}

/**
 * Colour groups of the drop line, best first, as the site draws the bar under each item:
 * gold (knives, gloves, Howl), red, pink, purple (and every sticker), blue, light blue, grey.
 */
export const FEED_TIERS = ['gold', 'red', 'pink', 'purple', 'blue', 'light', 'grey'];
// The site's rarity codes and names -> colour group (its own table, read from its page code on 2026-11-15).
const RARITY_CODE = { 1: 'grey', 2: 'blue', 3: 'purple', 4: 'red', 5: 'pink', 6: 'pink', 7: 'red', 8: 'blue', 9: 'purple', 10: 'red', 11: 'gold', 12: 'pink', 13: 'grey', 14: 'light', 15: 'blue', 16: 'purple' };
const RARITY_NAME = { common: 'grey', uncommon: 'light', rare: 'blue', mythical: 'purple', legendary: 'pink', ancient: 'red', immortal: 'gold' };

/** The colour group the site shows for a feed item. */
export function feedTier(rawItem) {
  const o = obj(rawItem) ?? {};
  const name = String(o.marketName ?? o.name ?? '').trim();
  const skin = String(o.skin ?? '').trim().toLowerCase();
  if (name.includes('★') || name.includes('M4A4 | Howl') || (name.includes('M4A4') && skin === 'howl')) return 'gold';
  if (Number(o.type) === 13 || name.startsWith('Sticker')) return 'purple';
  const r = o.rarity;
  if (r == null) return 'grey';
  const t = String(r).trim();
  return (/^\d+$/.test(t) ? RARITY_CODE[Number(t)] : RARITY_NAME[t.toLowerCase()]) ?? 'grey';
}

/**
 * The drops in a /api/live-drops answer: [{id, tier, up, price}], newest first, each once.
 * id is the drop's number; the site numbers drops one after another, so gaps between reads count the
 * drops that were missed. up: the drop came from an upgrade (it has a chance), not a case.
 */
export function feedItems(body) {
  const o = obj(body) ?? {};
  const seen = new Set();
  const out = [];
  for (const d of [...arr(o.liveDrops), ...arr(o.hotDrops), ...arr(o.items)]) {
    const id = Number(obj(d)?.id);
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    const name = obj(d.item)?.marketName ?? obj(d.item)?.name;
    out.push({ id, tier: feedTier(d.item), up: num(d.probability) > 0, price: num(obj(d.item)?.price), name: typeof name === 'string' ? name : '' });
  }
  return out.sort((a, b) => b.id - a.id);
}

/**
 * A watched case's public page data -> {slug, ts, opens, price, items: [{name, price, chance}]}, or null.
 * Custom cases (/api/game/custom-cases/{slug}) publish each item's chance (percent) and the case's total opens;
 * official ones (/api/game/cases/{slug}) publish neither, so their chance and opens are null.
 */
export function caseSnap(body, slug, ts) {
  const d = obj(unwrap(body));
  if (!d) return null;
  const c = obj(d.case) ?? d;
  const price = num(c.price);
  if (!(price > 0)) return null;
  const items = [];
  for (const raw of arr(d.items ?? c.items)) {
    const r = obj(raw);
    if (!r) continue;
    const it = item(r);
    if (!it.name) continue;
    items.push({ name: it.name, price: it.price, chance: numOrNull(r.chancePercent ?? r.chance) });
  }
  const opens = numOrNull(c.totalOpens ?? c.total_opens);
  return { slug: String(c.slug ?? slug), ts, opens: opens == null ? null : Math.round(opens), price, items };
}

/** Items of a case worth at least its price: the drops a case watch counts on the drop line. */
export function hitItems(snap) {
  return (snap?.items ?? []).filter((i) => i.price >= snap.price);
}

/**
 * One feed read -> what it adds to the colour counts: {ts, seen, span, elapsed, gold, red, ..., up, value}.
 * Only drops newer than `lastId` count. span: drops the site showed since the last read (from the numbers,
 * so it is exact even when the read missed some); elapsed: ms since that read. Both are null for the first
 * read, or when the numbers went backwards.
 */
export function feedSample(items, { ts, lastId = null, lastAt = null }) {
  const fresh = lastId == null ? items : items.filter((d) => d.id > lastId);
  const top = items.length ? items[0].id : null;
  const known = lastId != null && lastAt != null && top != null && top >= lastId;
  const out = { ts, seen: fresh.length, span: known ? top - lastId : null, elapsed: known ? Math.max(0, ts - lastAt) : null, up: 0, value: 0 };
  for (const t of FEED_TIERS) out[t] = 0;
  for (const d of fresh) {
    out[d.tier]++;
    if (d.up) out.up++;
    out.value += d.price;
  }
  out.value = Math.round(out.value * 100) / 100;
  return out;
}

/** /api/statistics answer -> {ts, cases, upgrades, online}, or null. */
export function volumeSample(body, ts) {
  const o = obj(body);
  if (!o || o.cases_opened == null || o.upgrader_count == null) return null;
  return { ts, cases: num(o.cases_opened), upgrades: num(o.upgrader_count), online: num(o.online) };
}

/** Salted SHA-256 of a player id, first 16 hex characters. */
export function hashUser(id, salt) {
  return createHash('sha256').update(`${salt}:${id}`).digest('hex').slice(0, 16);
}
