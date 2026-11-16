// The stats server's request handler, shared by the Supabase Edge Function (supabase/functions/stats)
// and the tests. Pure: storage comes in through `deps`, so it runs the same in Deno and Node.
//
// A request names an account selection and a list of views. Each view is one function of
// src/stats (or a small helper below) run over the selected account's events. Results are cached
// per data version: the version changes whenever any event of the sync key changes, so a cached
// result is reused until new events arrive.

import * as stats from '../stats/index.js';
import { filterByAccount, listAccounts, pickLegacyOwner } from '../store/accounts.js';
import { withdrawalTwinIds, caseTwinIds } from '../capture/parsers.js';
import { num } from '../schema.js';
import { encode, decode } from './codec.js';

export { encode, decode };

export const MAX_VIEWS = 40;
// Set by build.mjs from the server's source files: cached answers of an older build are not reused.
// eslint-disable-next-line no-undef
export const BUILD_ID = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';
const MAX_POINTS = 600;

// ---- Views ----

function flow(e) {
  if (!e) return null;
  if (e.kind === 'case') return { cost: num(e.casePrice), ret: num(e.item && e.item.price) };
  if (e.kind === 'upgrade' && e.status !== 'pending') return { cost: num(e.stake), ret: num(e.returned) };
  return null;
}

/**
 * Running net of every case open and settled upgrade, oldest first, thinned to at most maxPoints.
 * Thinning keeps each slice's first point and its lowest and highest points, so dips and peaks stay.
 */
export function cumulative(events, maxPoints = MAX_POINTS) {
  const sorted = events.filter((e) => flow(e)).sort((a, b) => num(a.ts) - num(b.ts));
  let net = 0;
  const all = sorted.map((e) => {
    const f = flow(e);
    net += f.ret - f.cost;
    return { ts: num(e.ts), v: net };
  });
  const cap = Math.max(3, Math.floor(num(maxPoints)) || MAX_POINTS);
  if (all.length <= cap) return all;
  const slices = Math.floor(cap / 3);
  const size = all.length / slices;
  const out = [];
  for (let i = 0; i < slices; i++) {
    const part = all.slice(Math.floor(i * size), Math.floor((i + 1) * size));
    if (!part.length) continue;
    let lo = part[0];
    let hi = part[0];
    for (const p of part) {
      if (p.v < lo.v) lo = p;
      if (p.v > hi.v) hi = p;
    }
    const picked = [...new Set([part[0], lo, hi])].sort((a, b) => a.ts - b.ts);
    out.push(...picked);
  }
  const last = all[all.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/**
 * outlookModel without what upgradeOutlook cannot use: it only reads the flows after the latest
 * deposit (a newer deposit changes the data version, so the client fetches a new model then).
 */
export function outlookModelLite(events) {
  const m = stats.outlookModel(events);
  const last = m.deposits.length ? m.deposits[m.deposits.length - 1] : null;
  return { ...m, flows: last == null ? [] : m.flows.filter((f) => f.ts >= last) };
}

/**
 * Counts and time span of the selection: what the dashboard needs to decide which views have data.
 * settled = upgrades that are not pending, split into normal and mystery.
 */
export function meta(events) {
  let firstTs = null;
  let lastTs = null;
  const kinds = {};
  let settled = 0;
  let mystery = 0;
  for (const e of events) {
    const ts = num(e.ts);
    if (ts) {
      if (firstTs == null || ts < firstTs) firstTs = ts;
      if (lastTs == null || ts > lastTs) lastTs = ts;
    }
    kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
    if (e.kind === 'upgrade' && e.status !== 'pending') {
      settled++;
      if (e.mystery) mystery++;
    }
  }
  return { total: events.length, firstTs, lastTs, kinds, settled, settledNormal: settled - mystery, settledMystery: mystery };
}

/**
 * What the site-history import needs instead of every stored event (see capture/history.js):
 * imported counts per kind (where an unfinished walk resumes) and the withdrawals (to skip known
 * ones and their live twins). Live case drops are not sent: the server removes imported twins itself.
 * `events` are the account's own events plus those without an account.
 */
export function historyBase(events) {
  const counts = {};
  const keep = [];
  for (const e of events) {
    if (e.source === 'import') counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    if (e.kind === 'withdrawal') {
      keep.push({ id: e.id, kind: e.kind, source: e.source, ts: e.ts, userId: e.userId ?? null, exactTime: e.exactTime, item: { name: e.item?.name, price: e.item?.price } });
    }
  }
  return { counts, events: keep };
}

// name -> (selected events, all events, account, ...args) => result. Only these can be asked for.
const VIEWS = {
  summarize: (ev) => stats.summarize(ev),
  caseRoi: (ev) => stats.caseRoi(ev),
  upgradeByChance: (ev, _all, _acc, edges) => (edges ? stats.upgradeByChance(ev, edges) : stats.upgradeByChance(ev)),
  upgradeByStake: (ev, _all, _acc, edges) => (edges ? stats.upgradeByStake(ev, edges) : stats.upgradeByStake(ev)),
  factor: (ev, _all, _acc, key, opts) => stats.factor(ev, String(key), opts ?? {}),
  sessions: (ev, _all, _acc, gap) => (gap != null ? stats.sessions(ev, num(gap)) : stats.sessions(ev)),
  upgradeSessions: (ev, _all, _acc, opts) => stats.upgradeSessions(ev, opts ?? {}),
  calibration: (ev) => stats.calibration(ev),
  calibrationCurve: (ev, _all, _acc, edges) => (edges ? stats.calibrationCurve(ev, edges) : stats.calibrationCurve(ev)),
  edgeMap: (ev, _all, _acc, edges) => (edges ? stats.edgeMap(ev, edges) : stats.edgeMap(ev)),
  superDropStats: (ev) => stats.superDropStats(ev),
  mysteryStats: (ev, _all, _acc, edges) => (edges ? stats.mysteryStats(ev, edges) : stats.mysteryStats(ev)),
  moneyFlow: (ev, _all, _acc, opts) => stats.moneyFlow(ev, opts ?? {}),
  outlookModel: (ev) => outlookModelLite(ev),
  quoteBase: (ev) => stats.quoteBase(ev),
  cumulative: (ev, _all, _acc, maxPoints) => cumulative(ev, maxPoints ?? MAX_POINTS),
  meta: (ev) => meta(ev),
  // Over every event of the key, not only the selection: the account picker lists them all.
  accounts: (_ev, all, acc, known, current) => listAccounts(all, known && typeof known === 'object' ? known : {}, acc.legacy, current == null ? null : String(current)),
  // Owner of events without a userId: the account with the most events (see store/accounts.js).
  legacyOwner: (_ev, all) => pickLegacyOwner(all),
  historyBase: (_ev, all, acc, userId) => {
    const uid = userId == null ? null : String(userId);
    return historyBase(all.filter((e) => e.userId == null || e.userId === '' || String(e.userId) === uid));
  },
};
export const VIEW_NAMES = Object.keys(VIEWS);

/** Normalized account part of a request: {sel: id | 'all' | null, legacy: id | null}. */
function accountOfRequest(a) {
  const str = (v) => (v == null || v === '' ? null : String(v).slice(0, 64));
  return { sel: str(a?.sel), legacy: str(a?.legacy) };
}

/** Cache key of one view: same account, view and arguments give the same key. */
export function queryKey(acc, view) {
  return JSON.stringify([BUILD_ID, acc.sel, acc.legacy, view.name, view.args ?? []]);
}

/**
 * @param {{account?: {sel?: string|null, legacy?: string|null}, views: {name: string, args?: any[]}[]}} body
 * @param {Object} deps
 * @param {() => Promise<string>} deps.version  changes whenever any event of the key changes
 * @param {(keys: string[], version: string) => Promise<Map<string, any>>} deps.cacheGet  cached encoded results
 * @param {(version: string, entries: {key: string, value: any}[]) => Promise<void>} deps.cachePut
 * @param {() => Promise<any[]>} deps.loadEvents  every live event of the key
 * @param {(ids: string[]) => Promise<void>} deps.markDeleted
 * @returns {Promise<{version: string, results: ({ok: true, value: any} | {ok: false, error: string})[]}>}
 *   values are encode()d: decode() them on the client
 */
export async function handle(body, deps) {
  const views = Array.isArray(body?.views) ? body.views : null;
  if (!views || !views.length) throw new Error('Send at least one view');
  if (views.length > MAX_VIEWS) throw new Error(`Send at most ${MAX_VIEWS} views`);
  const acc = accountOfRequest(body.account);
  const list = views.map((v) => ({ name: String(v?.name ?? ''), args: Array.isArray(v?.args) ? decode(v.args) : [] }));
  const keys = list.map((v) => queryKey(acc, v));

  let version = await deps.version();
  const results = new Array(list.length);
  const cached = await deps.cacheGet([...new Set(keys)], version);
  const missing = [];
  list.forEach((v, i) => {
    if (!Object.hasOwn(VIEWS, v.name)) results[i] = { ok: false, error: `Unknown view "${v.name}"` };
    else if (cached.has(keys[i])) results[i] = { ok: true, value: cached.get(keys[i]) };
    else missing.push(i);
  });
  if (!missing.length) return { version, results };

  let all = await deps.loadEvents();
  // Duplicates left by imports that arrived after their live copies (or the other way round).
  const twins = new Set([...withdrawalTwinIds(all), ...caseTwinIds(all)]);
  if (twins.size) {
    await deps.markDeleted([...twins]);
    all = all.filter((e) => !twins.has(e.id));
    version = await deps.version();
  }
  const selected = filterByAccount(all, acc.sel, acc.legacy);

  const fresh = new Map();
  for (const i of missing) {
    const v = list[i];
    if (fresh.has(keys[i])) {
      results[i] = { ok: true, value: fresh.get(keys[i]) };
      continue;
    }
    try {
      const value = encode(VIEWS[v.name](selected, all, acc, ...v.args) ?? null);
      fresh.set(keys[i], value);
      results[i] = { ok: true, value };
    } catch (err) {
      results[i] = { ok: false, error: String(err?.message || err) };
    }
  }
  if (fresh.size) await deps.cachePut(version, [...fresh].map(([key, value]) => ({ key, value })));
  return { version, results };
}

