// Imports the signed-in user's own past upgrades, case drops, withdrawals and deposits from the site's history endpoints.
// Only ever requests the current user's id (from /users/me). The site rate-limits these endpoints
// (HTTP 429 after a few quick pages), so requests are paced and retried after a pause.

import { upgradeFromRecord, upgradeHistoryRows, caseFromInventoryRecord, withdrawalFromInventoryRecord, depositFromPayment, dropLiveTwins } from './parsers.js';

const PAGE = 50;
const MAX_PAGES = 4000;
// History is newest first: after this many pages with nothing new, the rest is already stored.
const KNOWN_PAGES_STOP = 2;
let PAUSE_MS = 500;
/** Tests only: drop the pause between pages. */
export function _setPause(ms) {
  PAUSE_MS = ms;
}
const RETRY_MS = 4000;
const MAX_RETRIES = 6;

/**
 * @param {Object} o
 * @param {typeof fetch} o.fetch      the page's original fetch
 * @param {import('./parsers.js').Context} o.ctx
 * @param {string} o.site
 * @param {() => string|null} o.getAuth  latest Authorization header seen from the site
 * @param {(events: any[]) => Promise<number>} o.save
 * @param {() => Promise<any[]>} [o.getStored]  events already stored, to skip drops captured live
 * @param {(msg: string) => void} [o.onProgress]
 * @param {{load: (name: string) => Promise<any>, save: (name: string, v: any) => Promise<void>}} [o.progressStore]
 *   remembers per stream whether a full walk finished, so an interrupted first sync resumes
 */
export async function importHistory({ fetch, ctx, site, getAuth, save, getStored, onProgress, progressStore }) {
  const get = (path) => getJson(fetch, path, getAuth);
  const progressFor = (name) => progressStore && { load: () => progressStore.load(name), save: (v) => progressStore.save(name, v) };
  const userId = ctx.userId ?? (await fetchMe(get, ctx));
  if (!userId) throw new Error('Sign in first: the tracker does not know your user id yet.');
  const uid = encodeURIComponent(userId);
  // Drops captured live have no inventory id, so they are matched by case, skin and time instead.
  // The counts tell an unfinished walk where older history starts (see paginate).
  const stored = getStored ? await getStored() : [];
  const countOf = (...kinds) => stored.filter((e) => kinds.includes(e.kind) && e.source === 'import').length;

  let upgrades = 0;
  await paginate(get, `/api/game/upgrade/public-history/${uid}`, async (body, page) => {
    onProgress?.(`Upgrades: page ${page}`);
    const events = upgradeHistoryRows(body).map((r) => upgradeFromRecord(r, ctx, site)).filter((e) => e && e.status !== 'pending');
    const added = await save(events);
    upgrades += added;
    return { count: Array.isArray(body?.items) ? body.items.length : 0, added };
  }, progressFor('upgrades'), countOf('upgrade'));

  // Case prices are not in the drop history, so load the case lists first.
  if (!ctx.cases.size) {
    for (const p of ['/api/game/cases', '/api/game/custom-cases']) {
      try {
        ctx.learn({ method: 'GET', path: p.slice(4), status: 200, resBody: await get(p) });
      } catch {}
    }
  }
  const triedSlugs = new Set();
  let cases = 0;
  let withdrawn = 0;
  let skipped = 0;
  await paginate(get, `/api/users/${uid}/inventory/history`, async (body, page) => {
    onProgress?.(`Case drops: page ${page}`);
    const items = Array.isArray(body?.items) ? body.items : [];
    const drops = items.filter((r) => r?.action === 'won_case');
    for (const r of drops) {
      const slug = r?.source?.case?.slug;
      if (!slug || ctx.cases.has(slug) || triedSlugs.has(slug)) continue;
      triedSlugs.add(slug);
      try {
        ctx.learn({ method: 'GET', path: `/game/cases/${slug}`, status: 200, resBody: await get(`/api/game/cases/${encodeURIComponent(slug)}`) });
      } catch {}
      await sleep(PAUSE_MS);
    }
    const parsed = drops.map((r) => caseFromInventoryRecord(r, ctx, site)).filter(Boolean);
    skipped += drops.length - parsed.length;
    const events = dropLiveTwins(parsed, stored);
    const withdrawals = items.map((r) => withdrawalFromInventoryRecord(r, ctx, site)).filter(Boolean);
    const added = await save(events);
    cases += added;
    withdrawn += await save(withdrawals);
    return { count: items.length, added, considered: events.length };
  }, progressFor('inventory'), countOf('case', 'withdrawal'));

  let deposits = 0;
  await paginate(get, '/api/payments/history', async (body, page) => {
    onProgress?.(`Deposits: page ${page}`);
    const items = Array.isArray(body?.items) ? body.items : [];
    const events = items.map((r) => depositFromPayment(r, ctx, site)).filter(Boolean);
    const added = await save(events);
    deposits += added;
    return { count: items.length, added, considered: events.length };
  }, progressFor('payments'), countOf('deposit'));

  return { added: upgrades + cases + withdrawn + deposits, upgrades, cases, withdrawn, deposits, skipped };
}

/**
 * Walks a newest-first history. Two passes:
 *  1. from the top until KNOWN_PAGES_STOP pages hold nothing new (or the end);
 *  2. if an earlier full walk never reached the end (tab closed mid-sync), continue from where it stopped.
 * `progress` persists {complete, offset} per stream so a long first sync can be resumed.
 * `storedCount` is how many rows of this stream are already stored. An unfinished walk that
 * recorded no deeper offset (for example an import cut off before progress was tracked) resumes
 * there, since stored rows are the newest ones.
 */
export async function paginate(get, path, onPage, progress, storedCount = 0) {
  const saved = { complete: false, offset: 0, ...((await progress?.load()) ?? {}) };
  if (!saved.complete && storedCount > saved.offset) saved.offset = storedCount;
  let newRows = 0;
  let knownStreak = 0;
  let page = 0;
  let reachedEnd = false;
  for (; page < MAX_PAGES; page++) {
    const body = await get(`${path}?limit=${PAGE}&offset=${page * PAGE}`);
    const { count, added, considered = count } = await onPage(body, page + 1);
    newRows += added;
    if (considered > 0) knownStreak = added === 0 ? knownStreak + 1 : 0;
    if (count < PAGE || body?.hasMore === false || body?.data?.hasMore === false) {
      reachedEnd = true;
      break;
    }
    if (knownStreak >= KNOWN_PAGES_STOP) break;
    if (!saved.complete) await progress?.save({ complete: false, offset: Math.max(saved.offset + newRows, (page + 1) * PAGE) });
    await sleep(PAUSE_MS);
  }
  if (!reachedEnd && !saved.complete && saved.offset > (page + 1) * PAGE) {
    // Rows added at the top since the last run push older rows down, so shift the resume point;
    // step back one page as overlap (already stored rows are skipped by id).
    let offset = Math.max(0, saved.offset + newRows - PAGE);
    for (let i = 0; i < MAX_PAGES; i++, offset += PAGE) {
      await sleep(PAUSE_MS);
      const body = await get(`${path}?limit=${PAGE}&offset=${offset}`);
      const { count } = await onPage(body, Math.floor(offset / PAGE) + 1);
      await progress?.save({ complete: false, offset: offset + PAGE });
      if (count < PAGE || body?.hasMore === false || body?.data?.hasMore === false) {
        reachedEnd = true;
        break;
      }
    }
  }
  if (reachedEnd) await progress?.save({ complete: true, offset: 0 });
}

async function fetchMe(get, ctx) {
  const body = await get('/api/users/me');
  const u = body?.user ?? body?.data ?? body;
  if (u?.id != null) ctx.userId = String(u.id);
  return ctx.userId;
}

async function getJson(fetch, path, getAuth) {
  let renewed = false;
  for (let attempt = 0; ; attempt++) {
    const auth = getAuth();
    const res = await fetch(path, { headers: { Accept: 'application/json', ...(auth ? { Authorization: auth } : {}) } });
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const after = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : RETRY_MS);
      continue;
    }
    // The login token is short-lived. The site renews it by itself on its next request, so wait
    // for a new token instead of handling the refresh token here.
    if (res.status === 401 && !renewed) {
      renewed = await waitForNewToken(getAuth, auth);
      if (renewed) continue;
      throw new Error('Your login expired. Reload the page and press Sync again; it continues where it stopped.');
    }
    if (!res.ok) throw new Error(`Site answered ${res.status} for ${path.split('?')[0]}`);
    return res.json();
  }
}

const TOKEN_WAIT_MS = 120_000;

async function waitForNewToken(getAuth, oldAuth) {
  for (let waited = 0; waited < TOKEN_WAIT_MS; waited += 2000) {
    await sleep(2000);
    const now = getAuth();
    if (now && now !== oldAuth) return true;
  }
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
