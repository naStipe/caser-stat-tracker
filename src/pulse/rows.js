// Site pulse: turns other players' public history into small anonymous rows.
// A row is one paid case open or one settled upgrade:
//   {id, kind: 'upgrade' | 'case', ts, u, stake, returned, chance, back}
// u is a salted hash of the player's site id; no names, items or inventories are kept.
// Pure: no DOM, no network. Shapes are the same as the signed-in user's own history (see capture/parsers.js).

import { upgradeFromRecord, upgradeHistoryRows, caseFromInventoryRecord, historyRows } from '../capture/parsers.js';
import { num } from '../schema.js';

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const arr = (v) => (Array.isArray(v) ? v : []);

/**
 * Upgrade history page -> rows. Pending upgrades and rows without a stake are skipped, and so are
 * wins of an item named in `skip` (the feed drop that brought the player in, see collector.js).
 * `back` marks rows read from history that was already there when the player was found.
 */
export function upgradeRows(body, ctx, u, { skip, back = false } = {}) {
  const out = [];
  for (const r of upgradeHistoryRows(body)) {
    const e = upgradeFromRecord(r, ctx, '');
    if (!e || e.status === 'pending' || !(e.stake > 0) || !e.ts) continue;
    if (skip?.size && e.won && (skip.has(e.target?.name) || skip.has(e.superDrop?.item?.name))) continue;
    out.push({ id: e.id, kind: 'upgrade', ts: e.ts, u, stake: e.stake, returned: e.returned, chance: e.chanceShown ?? null, back });
  }
  return out;
}

/**
 * Inventory history page -> case rows. Drops from cases whose price is unknown are skipped;
 * `unknownSlugs` collects those case slugs, so the caller can load their prices and read the page again.
 * Drops of an item named in `skip` are skipped too.
 */
export function caseRows(body, ctx, u, { unknownSlugs, skip, back = false } = {}) {
  const out = [];
  for (const r of historyRows(body)) {
    if (obj(r)?.action !== 'won_case') continue;
    const e = caseFromInventoryRecord(r, ctx, '');
    if (!e) {
      const slug = obj(obj(r.source)?.case)?.slug;
      if (slug && unknownSlugs) unknownSlugs.add(String(slug));
      continue;
    }
    if (skip?.size && skip.has(e.item.name)) continue;
    out.push({ id: e.id, kind: 'case', ts: e.ts, u, stake: e.casePrice, returned: e.item.price, chance: null, back });
  }
  return out;
}

/** Drops in a /api/live-drops answer, grouped by player: Map(player id -> Set of item names). */
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

/** Player ids in a /api/live-drops answer ({liveDrops, hotDrops}). */
export function feedUserIds(body) {
  return [...feedDrops(body).keys()];
}

/** /api/statistics answer -> volume sample {ts, cases, upgrades, online}, or null. */
export function volumeSample(body, ts) {
  const o = obj(body);
  if (!o || o.cases_opened == null || o.upgrader_count == null) return null;
  return { ts, cases: num(o.cases_opened), upgrades: num(o.upgrader_count), online: num(o.online) };
}

/** Salted SHA-256 of a player id, first 16 hex characters. */
export async function hashUser(id, salt, subtle = globalThis.crypto?.subtle) {
  const data = new TextEncoder().encode(`${salt}:${id}`);
  const buf = await subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}
