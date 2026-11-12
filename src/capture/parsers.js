// Turns API exchanges into tracker events. Shapes come from the site's own JS bundles
// (see docs/CONTRACT.md); every field read is defensive because the API can change.

import { num, numOrNull, toItem, shownChance, hashId } from '../schema.js';

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const arr = (v) => (Array.isArray(v) ? v : []);
// The site's API client returns the raw JSON body; some endpoints wrap it in {data: ...}.
const unwrap = (body) => obj(body)?.data && typeof body.data === 'object' ? body.data : body;

/**
 * Remembers what the page loaded earlier, so events can be filled in:
 * case prices and names, inventory item prices, current user, balance.
 */
export class Context {
  constructor() {
    this.cases = new Map(); // slug -> {id, slug, name, price}
    this.items = new Map(); // inventory item id -> Item
    this.userId = null;
    this.userName = null;
    this.balance = null;
    this.inventoryValue = null;
  }

  /** Feed every exchange here, before parsing events. */
  learn(ex) {
    const body = unwrap(ex.resBody);
    if (!body || ex.status >= 400) return;
    const p = ex.path.split('?')[0];

    if (p === '/game/cases' || p === '/game/custom-cases') {
      for (const c of arr(body.cases ?? body.items ?? body)) this.addCase(c);
    } else if (/^\/game\/cases\/[^/]+$/.test(p)) {
      this.addCase(obj(body.case) ?? body);
    } else if (p === '/users/me') {
      const u = obj(body.user) ?? body;
      if (u.id != null) {
        const id = String(u.id);
        // A different account signed in: the old one's balance and inventory no longer apply.
        if (this.userId != null && this.userId !== id) {
          this.items.clear();
          this.inventoryValue = null;
        }
        this.userId = id;
        const name = u.username ?? u.nickname ?? u.displayName ?? u.name ?? u.steamName ?? u.personaName;
        this.userName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 64) : null;
      }
      this.setBalance(u.balance);
    } else if (p === '/items/inventory/balance') {
      // {amount}: total value of the skins in the inventory, not the cash balance.
      this.inventoryValue = numOrNull(body.amount);
    } else if (p === '/items/inventory' || /^\/users\/[^/]+\/inventory$/.test(p)) {
      for (const it of arr(body.items ?? body.inventory ?? body)) this.addInventoryItem(it);
    }
    // Any response that reports a new balance (case open, upgrade, sell) updates it.
    if (obj(body) && 'balance' in body && p !== '/users/me') this.setBalance(body.balance);
  }

  addCase(c) {
    const o = obj(c);
    if (!o || !o.slug) return;
    this.cases.set(String(o.slug), { id: o.id != null ? String(o.id) : null, slug: String(o.slug), name: String(o.title ?? o.name ?? o.slug), price: num(o.price) });
  }

  addInventoryItem(it) {
    const o = obj(it);
    if (!o || o.id == null) return;
    const item = toItem(o);
    // Inventory rows wrap the skin: {id: inventoryId, price, item: {...}}. Keep the inventory id.
    item.id = String(o.id);
    this.items.set(item.id, item);
  }

  setBalance(v) {
    const b = numOrNull(obj(v)?.balance ?? v);
    if (b !== null) this.balance = b;
  }
}

/**
 * @param {import('./hook.js').ApiExchange} ex
 * @param {Context} ctx
 * @param {string} site
 * @returns {{events: import('../schema.js').Event[], recognized: boolean}}
 */
export function parseExchange(ex, ctx, site) {
  const p = ex.path.split('?')[0];
  if (ex.method === 'POST' && /^\/game\/cases\/[^/]+\/open$/.test(p)) {
    return { events: parseCaseOpen(ex, ctx, site), recognized: true };
  }
  if (ex.method === 'POST' && p === '/game/upgrade/bet') {
    const e = parseUpgradeBet(ex, ctx, site);
    return { events: e ? [e] : [], recognized: true };
  }
  if (ex.method === 'POST' && p === '/withdrawals') {
    return { events: parseWithdrawalRequest(ex, ctx, site), recognized: true };
  }
  // The site polls a payment after a deposit and lists them on the history page.
  if (ex.method === 'GET' && ex.status < 400 && (p === '/payments/history' || /^\/payments\/\d+$/.test(p))) {
    const body = unwrap(ex.resBody);
    const rows = p === '/payments/history' ? historyRows(body) : [obj(body?.payment) ?? body];
    return { events: rows.map((r) => depositFromPayment(r, ctx, site)).filter(Boolean), recognized: false };
  }
  return { events: [], recognized: false };
}

/** Payment row {id, methodName, amount, status, createdAt, completedAt} -> deposit event. */
export function depositFromPayment(row, ctx, site) {
  const r = obj(row);
  if (!r || r.id == null || r.amount == null) return null;
  const ts = Date.parse(r.createdAt ?? '');
  if (!ts) return null;
  const done = Date.parse(r.completedAt ?? '');
  return {
    id: `deposit:${r.id}`,
    kind: 'deposit',
    ts,
    site,
    userId: ctx.userId,
    source: 'import',
    balanceBefore: null,
    balanceAfter: null,
    amount: num(r.amount),
    method: String(r.methodName ?? r.method ?? ''),
    status: String(r.status ?? 'unknown'),
    completedTs: Number.isFinite(done) ? done : null,
  };
}

/** Inventory history row with status "withdrawn" -> withdrawal event (time is when the item arrived). */
export function withdrawalFromInventoryRecord(row, ctx, site) {
  const r = obj(row);
  if (!r || r.status !== 'withdrawn' || r.id == null) return null;
  const ts = Date.parse(r.createdAt ?? '');
  if (!ts) return null;
  const item = toItem({ ...obj(r.item), price: r.price ?? obj(r.item)?.price });
  item.id = String(r.id);
  return { id: `withdrawal:${r.id}`, kind: 'withdrawal', ts, site, userId: ctx.userId, source: 'import', balanceBefore: null, balanceAfter: null, item, value: item.price, exactTime: false };
}

// An imported withdrawal's time is when the item arrived, so it comes before the live capture of the
// same withdrawal. Items held longer than this before withdrawing are not paired.
const WITHDRAWAL_TWIN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const WITHDRAWAL_TWIN_SLACK_MS = 5 * 60 * 1000;

/**
 * Ids of imported withdrawals that repeat a live-captured one. The live event (POST /withdrawals) keys
 * on the inventory item id and the imported one (inventory history) on the history row id, so the two
 * never share an id. They are paired by item name: each live withdrawal takes the latest unpaired
 * imported withdrawal of the same item that arrived before it, within WITHDRAWAL_TWIN_WINDOW_MS.
 * @param {any[]} events any mix of events; only withdrawals are looked at
 * @returns {Set<string>}
 */
export function withdrawalTwinIds(events) {
  const imported = new Map(); // item name -> imported withdrawals, oldest first
  const live = [];
  for (const e of events) {
    if (!e || e.kind !== 'withdrawal') continue;
    if (e.source === 'live') live.push(e);
    else if (e.source === 'import') {
      const name = e.item?.name;
      if (!imported.has(name)) imported.set(name, []);
      imported.get(name).push(e);
    }
  }
  for (const list of imported.values()) list.sort((a, b) => a.ts - b.ts);
  live.sort((a, b) => a.ts - b.ts);
  const twins = new Set();
  for (const l of live) {
    const list = imported.get(l.item?.name);
    if (!list) continue;
    for (let i = list.length - 1; i >= 0; i--) {
      const imp = list[i];
      if (imp.ts > l.ts + WITHDRAWAL_TWIN_SLACK_MS) continue;
      if (l.ts - imp.ts > WITHDRAWAL_TWIN_WINDOW_MS) break;
      twins.add(imp.id);
      list.splice(i, 1);
      break;
    }
  }
  return twins;
}

/** POST /withdrawals: one event per requested inventory item, priced from the learned inventory. */
export function parseWithdrawalRequest(ex, ctx, site) {
  if (ex.status >= 400) return [];
  const req = obj(ex.reqBody) ?? {};
  // The request shape is not known yet; take every id under a key that names items.
  const ids = [];
  for (const [k, v] of Object.entries(req)) {
    if (!/item/i.test(k)) continue;
    for (const x of Array.isArray(v) ? v : [v]) if (typeof x === 'string' || typeof x === 'number') ids.push(x);
  }
  const ts = Date.now();
  return ids
    .map(String)
    .filter((id) => ctx.items.has(id))
    .map((id) => {
      const item = ctx.items.get(id);
      return { id: `withdrawal:${id}`, kind: 'withdrawal', ts, site, userId: ctx.userId, source: 'live', balanceBefore: ctx.balance, balanceAfter: null, item, value: item.price, exactTime: true };
    });
}

export const caseMatchKey = (slug, name) => `${slug}|${name}`;

/**
 * Drops imported from history that were already captured live: same case and skin, within 60 s.
 * Returns the import events that are new.
 */
export function dropLiveTwins(imported, stored) {
  const live = new Map();
  for (const e of stored) {
    if (e.kind !== 'case' || e.source !== 'live' || !e.matchKey) continue;
    if (!live.has(e.matchKey)) live.set(e.matchKey, []);
    live.get(e.matchKey).push(e.ts);
  }
  return imported.filter((e) => {
    const times = live.get(caseMatchKey(e.caseSlug, e.item.name));
    if (!times) return true;
    const i = times.findIndex((t) => Math.abs(t - e.ts) < 60_000);
    if (i < 0) return true;
    times.splice(i, 1); // one live drop matches one imported drop
    return false;
  });
}

/**
 * Imported case drops that duplicate a stored live drop. Import normally skips these (dropLiveTwins),
 * but when a browser imports from the site first and gets the live copies later (from another
 * browser through the cloud, or a file), both end up stored. Returns the ids of the imported copies.
 */
export function caseTwinIds(events) {
  const imported = events.filter((e) => e && e.kind === 'case' && e.source === 'import' && e.item);
  if (!imported.length) return new Set();
  const kept = new Set(dropLiveTwins(imported, events));
  return new Set(imported.filter((e) => !kept.has(e)).map((e) => e.id));
}

/** POST /game/cases/{slug}/open  ->  one CaseEvent per dropped item. */
export function parseCaseOpen(ex, ctx, site) {
  if (ex.status >= 400) return [];
  const body = unwrap(ex.resBody);
  const items = arr(body?.items ?? body?.drops ?? body?.results);
  if (!items.length) return [];

  const slug = decodeURIComponent(ex.path.split('?')[0].split('/')[3]);
  const known = ctx.cases.get(slug);
  const resCase = obj(body.case);
  const count = Math.max(1, num(ex.reqBody?.count) || items.length);
  const listPrice = num(resCase?.price) || known?.price || 0;
  // Real response: {items: [{id (catalog skin id), price, is_free, price_paid}], user_balance, free_opens}.
  const balanceAfter = numOrNull(body.user_balance ?? body.balance ?? body.user?.balance);
  const balanceBefore = ctx.balance;
  if (balanceAfter !== null) ctx.balance = balanceAfter;

  const ts = Date.now();
  const batchSeed = items.map((i) => obj(i)?.id ?? '').join(',');
  const batchId = String(body.id ?? body.openId ?? body.open_id ?? hashId(`${slug}|${ts}|${batchSeed}`));

  return items.map((raw, i) => {
    const r = obj(raw) ?? {};
    const item = toItem(raw);
    const free = !!(r.is_free ?? r.isFree ?? body.is_free ?? body.free ?? false);
    const paid = numOrNull(r.price_paid ?? r.pricePaid);
    const casePrice = free ? 0 : paid ?? listPrice;
    return {
      // The item id in this response is the catalog skin id, shared by every drop of that skin,
      // so the event id is built from the open itself.
      id: `case:live:${batchId}:${i}`,
      kind: 'case',
      ts,
      site,
      userId: ctx.userId,
      source: 'live',
      balanceBefore,
      balanceAfter,
      caseSlug: slug,
      caseId: resCase?.id != null ? String(resCase.id) : known?.id ?? null,
      caseName: String(resCase?.title ?? resCase?.name ?? known?.name ?? slug),
      casePrice,
      free,
      batchId,
      // Lets the history import recognise this drop later (it has its own inventory id there).
      matchKey: caseMatchKey(slug, item.name),
      batchSize: count,
      gameMode: String(ex.reqBody?.gameMode ?? 'normal'),
      item,
    };
  });
}

/** POST /game/upgrade/bet  ->  one UpgradeEvent. */
export function parseUpgradeBet(ex, ctx, site) {
  if (ex.status >= 400) return null;
  const body = unwrap(ex.resBody);
  if (!obj(body)) return null;
  const req = obj(ex.reqBody) ?? {};
  const ev = upgradeFromRecord(body, ctx, site, {
    betItemIds: arr(req.betInventoryItemIds).map(String),
    addedBalance: req.addedBalance,
    targetItemId: req.targetItemId,
    mystery: req.isMystery,
    gameMode: req.gameMode,
  });
  if (!ev) return null;
  ev.ts = Date.now();
  ev.source = 'live';
  ev.balanceBefore = ctx.balance;
  const after = numOrNull(body.balance ?? obj(body.user)?.balance);
  if (after !== null) {
    ev.balanceAfter = after;
    ctx.balance = after;
  }
  return ev;
}

/**
 * Shared by live bets and history import. Mirrors the site's own history normalizer:
 * the record is either {bet: {...}, superDrop, compensationItems} or the bet itself.
 */
export function upgradeFromRecord(record, ctx, site, hint = {}) {
  const r = obj(record);
  if (!r) return null;
  const b = obj(r.bet) ?? r;

  let betItems = arr(b.betItems ?? b.fromItems ?? b.items).map(toItem);
  if (!betItems.length && hint.betItemIds?.length) {
    betItems = hint.betItemIds.map((id) => ctx.items.get(id) ?? { id, name: 'Unknown item', price: 0, rarity: null, image: null });
  }
  const addedBalance = num(b.addedBalance ?? b.added_balance ?? b.balanceAdded ?? hint.addedBalance);
  const stake = num(b.stake ?? b.betAmount ?? b.amount) || betItems.reduce((s, i) => s + i.price, 0) + addedBalance;

  const targetRaw = obj(b.targetItem ?? b.desiredItem ?? b.toItem);
  const target = targetRaw ? toItem(targetRaw) : null;
  const wonRaw = obj(b.wonItem ?? b.resultItem);

  const statusRaw = String(b.status ?? r.status ?? 'pending').toLowerCase();
  const status = statusRaw === 'won' || statusRaw === 'win' ? 'won' : statusRaw === 'lost' || statusRaw === 'lose' || statusRaw === 'loss' ? 'lost' : 'pending';
  const won = status === 'won';

  const mystery = !!(b.isMystery ?? r.isMystery ?? hint.mystery);
  // Mystery upgrades hide the chance (the history sends probability "0").
  const chanceRaw = mystery ? null : numOrNull(b.chance ?? b.winChance ?? b.probability);
  const chanceServer = chanceRaw === null || chanceRaw === 0 ? null : chanceRaw <= 1 ? chanceRaw * 100 : chanceRaw;
  const chanceShown = mystery ? null : chanceServer ?? (target ? shownChance(stake, target.price) : 0);

  const sd = obj(b.superDrop ?? r.superDrop);
  const superDrop = sd ? { shown: !!(sd.shown ?? sd.display ?? sd.active ?? sd.visible ?? true), won: !!(sd.won ?? sd.win ?? sd.isWon ?? sd.success), item: obj(sd.item) ? toItem(sd.item) : null } : null;
  const compensation = arr(r.compensationItems ?? b.compensationItems).map(toItem);

  // wonItem is what the user received: the target, a super-drop item (already multiplied),
  // or for mystery upgrades always some item, "lost" only meaning it is worth less than the stake.
  let returned = 0;
  if (wonRaw) returned += toItem(wonRaw).price;
  else if (won) returned += (superDrop?.won && superDrop.item ? superDrop.item.price : 0) || target?.price || 0;
  returned += compensation.reduce((s, i) => s + i.price, 0);
  const mm = numOrNull(b.mysteryMultiplier ?? r.mysteryMultiplier);

  const id = b.id ?? r.id;
  return {
    id: `upgrade:${id ?? hashId(JSON.stringify([betItems.map((i) => i.id), target?.id, stake, b.createdAt]))}`,
    kind: 'upgrade',
    ts: Date.parse(b.createdAt ?? r.createdAt ?? '') || Date.now(),
    site,
    userId: ctx.userId,
    source: 'import',
    balanceBefore: null,
    balanceAfter: null,
    stake,
    betItems,
    addedBalance,
    target: target ?? (won && wonRaw ? toItem(wonRaw) : null),
    mystery,
    mysteryMultiplier: mystery ? mm ?? (stake > 0 ? returned / stake : null) : null,
    gameMode: String(b.gameMode ?? hint.gameMode ?? 'normal'),
    chanceShown,
    chanceServer,
    status,
    won,
    superDrop,
    compensation,
    returned,
    net: returned - stake,
  };
}

/**
 * Upgrade history page: {featured: [...], items: [...], hasMore}. The site shows its "featured"
 * best upgrades apart from the list, so both are needed or the biggest wins go missing.
 */
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

/**
 * Inventory history row -> CaseEvent, for rows with action "won_case".
 * Row: {id, item: {...}, action, source: {type: 'case', case: {slug, title}}, price, createdAt}.
 * Returns null when the case price cannot be found (it would make ROI wrong).
 */
export function caseFromInventoryRecord(row, ctx, site) {
  const r = obj(row);
  if (!r || r.action !== 'won_case' || obj(r.source)?.type !== 'case') return null;
  const c = obj(r.source.case) ?? obj(r.caseInfo);
  const slug = c?.slug ? String(c.slug) : null;
  if (!slug) return null;
  const known = ctx.cases.get(slug);
  if (!known || !(known.price > 0)) return null;
  const item = toItem({ ...obj(r.item), price: r.price ?? obj(r.item)?.price });
  item.id = r.id != null ? String(r.id) : item.id;
  const ts = Date.parse(r.createdAt ?? '') || 0;
  if (!ts) return null;
  return {
    id: `case:${r.id ?? hashId(`${slug}|${ts}|${item.name}`)}`,
    kind: 'case',
    ts,
    site,
    userId: ctx.userId,
    source: 'import',
    balanceBefore: null,
    balanceAfter: null,
    caseSlug: slug,
    caseId: known.id,
    caseName: String(c.title ?? known.name),
    casePrice: known.price,
    free: false,
    // Drops of one multi-open share a timestamp to the second.
    batchId: `${slug}|${ts}`,
    batchSize: 1,
    gameMode: 'normal',
    item,
  };
}

/** Pulls the items array out of a paginated history response. Mirrors the site's own logic. */
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
