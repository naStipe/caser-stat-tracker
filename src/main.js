// Userscript entry. Runs at document-start so the fetch hook is in place before the site's first request.

import { installHook } from './capture/hook.js';
import { Context, parseExchange } from './capture/parsers.js';
import { importHistory } from './capture/history.js';
import { readUpgradeSelection } from './capture/selection.js';
import { caseSlugFromPath, caseDetailPath, caseInfoFromResponse, fetchCaseInfo } from './capture/caseinfo.js';
import { replacementItemId, candidatesFromResponse } from './capture/replacements.js';
import { createPriceClient } from './prices/csfloat.js';
import { Store } from './store/db.js';
import { toJson, toCsv, fromJson } from './store/export.js';
import { gmStorage, dropOldEventCopies } from './store/gm.js';
import { createCloud, isSyncKey, newSyncKey, planUpload } from './store/cloud.js';
import { createRemoteStats } from './store/remote-stats.js';
import { resolveSelection, accountName, mergeNames, streamFlag, flagComplete, progressKey, isStreamFlag } from './store/accounts.js';
import { OWNER_LOCK, checkPassword, isGuest } from './store/lock.js';
import * as stats from './stats/client.js';
import { checkForUpdate, compareVersions } from './update.js';
import { mountDashboard, mountUpgradeOverlay, mountCasePanel, mountExchangePanel } from './ui/index.js';
import { store as uiStore } from './ui/dom.js';

const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : 'dev';
// eslint-disable-next-line no-undef
const UPDATE_URL = typeof __UPDATE_URL__ === 'string' ? __UPDATE_URL__ : null;
// The script runs in Tampermonkey's sandbox (it needs GM_xmlhttpRequest for CSFloat), so the site's own
// fetch / XMLHttpRequest live on unsafeWindow.
// eslint-disable-next-line no-undef
const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
const site = location.hostname.replace(/^www\./, '');
const ctx = new Context();
const store = new Store(indexedDB);
// The script's own value storage, shared by every domain. Only small settings live there (the
// sync key, account names, flags); events go to the server (see "Events" below).
const sharedGm = gmStorage();
// Settings that belong to this browser rather than to one domain (the sync key).
const browserPrefs = sharedGm
  ? { get: (k) => sharedGm.get(k, null), set: (k, v) => sharedGm.set(k, v) }
  : { get: (k) => uiStore.get(k, null), set: (k, v) => uiStore.set(k, v) };

let lastAuth = null;
let lastEventTs = null;
let unknownResponses = 0;
let dashboard = null;
let overlay = null;

// Statistics are computed by the stats server over the history stored there (see store/remote-stats.js).
const remote = createRemoteStats({
  request: (req) => gmRequest(req),
  getKey: () => cloudKey(),
  getAccount: () => ({ sel: selectedAccount(), legacy: legacyOwner() }),
});

// ---- Accounts (see store/accounts.js) ----
// Every event keeps the userId of the account that made it. The panels show the account picked in
// the dashboard. The pick is not stored: every page load, and every switch to another account,
// starts again at "current", which follows whoever is signed in on the page.
let accountSel = 'current';

// The site does not always ask for /users/me itself, so the tracker asks when it does not know who
// is signed in, or when the login token changed (a new login may be another account).
let userAuth = null; // token the current ctx.userId was learned with
let userCheck = null;

/** Who is signed in. Asks the site's /users/me at most once per login token. */
function ensureUser() {
  const auth = getAuth();
  if (!auth || (ctx.userId != null && auth === userAuth)) return Promise.resolve(ctx.userId);
  if (!userCheck) {
    userCheck = (async () => {
      try {
        const res = await origFetch('/api/users/me', { headers: { Accept: 'application/json', Authorization: auth } });
        if (res.ok) {
          const before = ctx.userId;
          const nameBefore = ctx.userName;
          ctx.learn({ method: 'GET', path: '/users/me', status: 200, resBody: await res.json() });
          userAuth = auth;
          if (ctx.userId !== before || ctx.userName !== nameBefore) onAccountSeen(before);
        }
      } catch (err) {
        console.warn('[caser-tracker] could not read the signed-in account', err);
      } finally {
        userCheck = null;
      }
      return ctx.userId;
    })();
  }
  return userCheck;
}

function knownAccounts() {
  const v = browserPrefs.get('accounts');
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

/**
 * Remember the signed-in account's name for the picker (script storage: every domain sees it),
 * and in the cloud, so other browsers show it too.
 */
function rememberAccount() {
  if (ctx.userId == null) return;
  const known = knownAccounts();
  const name = ctx.userName ?? known[ctx.userId]?.name ?? null;
  if (known[ctx.userId] && known[ctx.userId].name === name) return;
  browserPrefs.set('accounts', { ...known, [ctx.userId]: { name } });
  if (name && cloudKey()) {
    cloud.setName(ctx.userId, name).catch((err) => console.warn('[caser-tracker] could not send the account name to the cloud', err));
  }
}

/** Take the cloud's account names, and send the ones it lacks. */
async function syncNames(cloudNames) {
  const res = mergeNames(knownAccounts(), cloudNames, ctx.userId);
  if (res.changed) browserPrefs.set('accounts', res.known);
  for (const [id, name] of res.send) {
    try {
      await cloud.setName(id, name);
    } catch (err) {
      console.warn('[caser-tracker] could not send the account name to the cloud', err);
      break;
    }
  }
  return res.changed;
}

/**
 * Owner of events without a userId and of the old flags that had no account: the account with the
 * most events on the server. Asked once and then kept (see fixLegacyOwner).
 */
function legacyOwner() {
  const v = browserPrefs.get('acct:legacy');
  return typeof v === 'string' && v ? v : null;
}

async function fixLegacyOwner() {
  if (legacyOwner() || !cloudKey()) return;
  const pick = await remote.fetch('legacyOwner');
  if (typeof pick === 'string' && pick && !legacyOwner()) {
    browserPrefs.set('acct:legacy', pick);
    remote.reset();
    dashboard?.refresh();
  }
}

// ---- Owner lock (see store/lock.js) ----
// A guest sees only the signed-in account. The owner password unlocks every account until the page
// reloads or another account signs in. The owner can also trust an account: while it is signed in
// on this browser, the tracker stays unlocked without asking.
// Matches no account, so a guest with no signed-in account sees no events.
const NO_ACCOUNT = '\u0000none';
let unlocked = false;

function lockRecord() {
  return OWNER_LOCK;
}

function trustedAccounts() {
  const v = browserPrefs.get('lock:trusted');
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
}

function guest() {
  return isGuest(lockRecord(), unlocked, trustedAccounts(), ctx.userId);
}

function requireOwner() {
  if (guest()) throw new Error('Locked. Enter the owner password in Stats → Settings → Owner lock first.');
}

function lockState() {
  const rec = lockRecord();
  return {
    set: !!rec,
    guest: guest(),
    trusted: ctx.userId != null && trustedAccounts().includes(ctx.userId),
    accountName: ctx.userId != null ? accountName(ctx.userId, knownAccounts()) : null,
  };
}

function lockChanged() {
  if (guest()) accountSel = 'current';
  dashboard?.refresh();
  overlay?.refresh();
}

async function unlockWith(password, remember) {
  const rec = lockRecord();
  if (!rec) return true;
  if (!(await checkPassword(rec, password))) {
    // Slows down guessing from the panel.
    await new Promise((r) => setTimeout(r, 800));
    throw new Error('Wrong password.');
  }
  unlocked = true;
  if (remember && ctx.userId != null && !trustedAccounts().includes(ctx.userId)) {
    browserPrefs.set('lock:trusted', [...trustedAccounts(), ctx.userId]);
  }
  lockChanged();
  return true;
}

/** Back to guest view now. The signed-in account stops being trusted, or it would unlock again at once. */
function lockNow() {
  unlocked = false;
  if (ctx.userId != null) browserPrefs.set('lock:trusted', trustedAccounts().filter((x) => x !== ctx.userId));
  lockChanged();
}

/** The account the panels show: an id, 'all', or null when no account is known yet. */
function selectedAccount() {
  if (guest()) return ctx.userId ?? NO_ACCOUNT;
  return resolveSelection(accountSel, ctx.userId, legacyOwner());
}

/** The account picker's choices, from the server's "accounts" view (every account of the key). */
function accountsState() {
  const res = remote.get('accounts', knownAccounts(), ctx.userId);
  const all = Array.isArray(res.value) ? res.value : [];
  const total = (list) => list.reduce((n, a) => n + (Number(a.events) || 0), 0);
  if (guest()) {
    const list = all.filter((a) => a.current);
    return { list, selected: selectedAccount(), total: total(list), guest: true };
  }
  return { list: all, selected: selectedAccount(), total: total(all), guest: false };
}

function selectAccount(sel) {
  if (guest()) return;
  accountSel = sel;
  dashboard?.refresh();
  overlay?.refresh();
}

/** The site reported who is signed in (page load, or a switch to another account). */
function onAccountSeen(previous) {
  rememberAccount();
  if (ctx.userId === previous) return;
  accountSel = 'current';
  // Another login may be someone else: the password has to be entered again.
  if (previous != null) unlocked = false;
  dashboard?.refresh();
  overlay?.refresh();
  // A newly signed-in account gets its own history sync when it is due.
  if (mounted && previous != null) setTimeout(maybeAutoSync, 3000);
}

/** Cash balance and skin value are only known for the signed-in account. */
function holdings() {
  const sel = selectedAccount();
  if (sel != null && sel !== ctx.userId) return { balance: null, inventoryValue: null };
  return { balance: ctx.balance, inventoryValue: ctx.inventoryValue };
}

// ---- Events ----
// Every event goes to the server. IndexedDB holds only the outbox: events captured here that the
// server has not confirmed yet (offline, server down, page closed mid-send). They are sent again
// on the next chance and deleted once confirmed.
const OUTBOX_DELAY_MS = 1500;
const OUTBOX_RETRY_MS = 60 * 1000;
let outboxTimer = null;
let outboxRun = null;

/**
 * Store events in the outbox and send them. Resolves to how many the server took as new or better,
 * which the site-history import uses to tell when it reached history that is already stored.
 * When the server cannot be reached the events stay queued and the count is how many were queued.
 */
async function saveEvents(events) {
  if (!events.length) return 0;
  const queued = await store.putEvents(events);
  try {
    return await flushOutbox(events.map((e) => e.id));
  } catch (err) {
    console.warn('[caser-tracker] could not send events, they stay queued', err);
    scheduleOutbox(OUTBOX_RETRY_MS);
    return queued;
  }
}

function scheduleOutbox(ms = OUTBOX_DELAY_MS) {
  if (outboxTimer) return;
  outboxTimer = setTimeout(() => {
    outboxTimer = null;
    flushOutbox().catch(() => scheduleOutbox(OUTBOX_RETRY_MS));
  }, ms);
}

/**
 * Send queued events (all of them, or only `ids`) and delete each one the server confirmed.
 * An event that changed while it was being sent (a pending upgrade that settled) stays queued.
 */
async function flushOutbox(ids = null) {
  // One send at a time, so the same events are not sent twice in parallel.
  while (outboxRun) await outboxRun.catch(() => {});
  outboxRun = (async () => {
    if (!cloudKey()) ensureCloudKey();
    const all = await store.allEvents();
    const want = ids ? new Set(ids) : null;
    const batch = want ? all.filter((e) => want.has(e.id)) : all;
    if (!batch.length) return 0;
    const sent = new Map(batch.map((e) => [e.id, JSON.stringify(e)]));
    const changed = await cloud.push(batch);
    const now = await store.allEvents();
    const done = now.filter((e) => sent.get(e.id) === JSON.stringify(e)).map((e) => e.id);
    await store.deleteEvents(done);
    cloudStatus = { ...cloudStatus, state: cloudStatus.state === 'error' ? 'idle' : cloudStatus.state, error: null, lastPush: Date.now() };
    remote.invalidate();
    refreshAfterLive();
    return changed;
  })();
  try {
    return await outboxRun;
  } catch (err) {
    cloudStatus = { ...cloudStatus, state: 'error', error: err.message || String(err) };
    throw err;
  } finally {
    outboxRun = null;
  }
}

/** Clears this domain's copy, for "clear all data" here or on another domain. */
async function clearLocal() {
  const ids = new Set(Object.keys(knownAccounts()));
  for (const e of await store.allEvents()) if (e.userId != null) ids.add(String(e.userId));
  if (ctx.userId != null) ids.add(ctx.userId);
  await store.clearEvents();
  remote.reset();
  const keys = ['lastSync', 'lastSyncBy', ...HISTORY_STREAMS.map((s) => `sync:${s}`)];
  for (const id of ids) for (const s of HISTORY_STREAMS) keys.push(progressKey(s, id));
  for (const k of keys) await store.setMeta(k, null);
  browserPrefs.set('sync:complete', []);
  browserPrefs.set('acct:legacy', null);
  lastSyncLegacy = null;
  lastSyncBy = {};
}

// ---- "History read to the end" flags ----
// A full read of a site-history stream takes many minutes. Once any domain or browser has done it
// and the events are on the server, later syncs only need the newest pages.
// The flag is kept per domain (IndexedDB meta, with the resume offset), per browser (script
// storage, all domains) and per sync key (cloud), each per site account ("upgrades:<userId>").
const HISTORY_STREAMS = ['upgrades', 'inventory', 'payments'];

function browserComplete() {
  const v = browserPrefs.get('sync:complete');
  return Array.isArray(v) ? v : [];
}

function markBrowserComplete(flag) {
  const v = browserComplete();
  if (!v.includes(flag)) browserPrefs.set('sync:complete', [...v, flag]);
}

function markComplete(flag) {
  markBrowserComplete(flag);
  if (cloudKey()) cloud.markComplete(flag).catch((err) => console.warn('[caser-tracker] could not update cloud', err));
}

/** Domains that finished a full read before flags were shared: publish it to the browser. */
async function publishLocalComplete() {
  for (const s of HISTORY_STREAMS) if ((await store.getMeta(`sync:${s}`))?.complete) markBrowserComplete(s);
}

// Progress of the signed-in account. Before multi-account support it was kept without an account;
// that copy belongs to the legacy owner.
const historyProgress = {
  async load(name) {
    const uid = ctx.userId;
    const legacy = legacyOwner();
    let local = await store.getMeta(progressKey(name, uid));
    if (local == null && uid === legacy) local = await store.getMeta(`sync:${name}`);
    if (local?.complete || !flagComplete(browserComplete(), name, uid, legacy)) return local;
    return { complete: true, offset: 0 };
  },
  async save(name, v) {
    await store.setMeta(progressKey(name, ctx.userId), v);
    if (v?.complete) markComplete(streamFlag(name, ctx.userId));
  },
};

// ---- The server copy (see store/cloud.js) ----
// Every browser has a sync key: a random name for its history on the server, made on first run and
// kept in script storage (so both domains use it). Pasting the same key into another browser gives
// that browser the same history. Older versions kept the history in IndexedDB; it is uploaded once
// (see uploadLocalHistory) and then deleted here.
const CLOUD_CHECK_EVERY_MS = 60 * 1000;
const cloud = createCloud({ request: gmRequest, getKey: () => cloudKey() });
let cloudStatus = { state: 'idle', lastPull: null, lastPush: null, error: null, progress: null };
let cloudRun = null;

function cloudKey() {
  const k = browserPrefs.get('cloud:key');
  return isSyncKey(k) ? k : null;
}

/** A browser without a key gets a new one: the server needs a name for its history. */
function ensureCloudKey() {
  if (cloudKey()) return cloudKey();
  const key = newSyncKey();
  browserPrefs.set('cloud:key', key);
  browserPrefs.set('cloud:clearSeen', Date.now());
  return key;
}

const UPLOAD_BATCH = 500;

/**
 * One time per browser and domain: send the history older versions kept in IndexedDB, only what the
 * server lacks, then delete it here. Remembers how far it got, so a reload in the middle continues.
 */
async function uploadLocalHistory(key) {
  if ((await store.getMeta('outboxSince')) === key) return;
  const local = await store.allEvents();
  if (local.length) {
    let plan = await store.getMeta('cloudPushPlan');
    if (!plan || plan.key !== key || !Array.isArray(plan.ids)) {
      cloudStatus = { ...cloudStatus, progress: 'Comparing with the server' };
      refreshSoon();
      const ranks = await cloud.ranks((n) => {
        cloudStatus = { ...cloudStatus, progress: `Comparing with the server (${n})` };
        refreshSoon();
      });
      plan = { key, ids: planUpload(local, ranks) };
      await store.setMeta('cloudPushPlan', plan);
      await store.setMeta('cloudPushDone', 0);
    }
    let done = Number(await store.getMeta('cloudPushDone')) || 0;
    const byId = new Map(local.map((e) => [e.id, e]));
    while (done < plan.ids.length) {
      const batch = plan.ids.slice(done, done + UPLOAD_BATCH).map((id) => byId.get(id)).filter(Boolean);
      if (batch.length) await cloud.push(batch);
      done = Math.min(done + UPLOAD_BATCH, plan.ids.length);
      await store.setMeta('cloudPushDone', done);
      cloudStatus = { ...cloudStatus, progress: `Uploading ${done} / ${plan.ids.length} (one time)` };
      refreshSoon();
    }
    // Every batch went through: the server has all of it now. Events captured meanwhile stay queued.
    await store.deleteEvents(local.map((e) => e.id));
  }
  await store.setMeta('outboxSince', key);
  await store.setMeta('cloudPushPlan', null);
  await store.setMeta('cloudPushDone', null);
  await store.setMeta('cloudCursor', null);
  remote.invalidate();
}

/** Send what is queued, then exchange account names, "read to the end" flags and clears with the server. */
function cloudSync() {
  const key = ensureCloudKey();
  if (cloudRun) return cloudRun;
  cloudRun = (async () => {
    cloudStatus = { ...cloudStatus, state: 'syncing', progress: 'Checking' };
    dashboard?.refresh();
    try {
      await uploadLocalHistory(key);
      const account = await cloud.account();
      // "Clear all" in another browser: drop what is still queued here too.
      const seen = Number(browserPrefs.get('cloud:clearSeen')) || 0;
      if (account.clearedAt && account.clearedAt > seen) {
        browserPrefs.set('cloud:clearSeen', account.clearedAt);
        await clearLocal();
      }
      await flushOutbox();

      for (const s of account.complete) if (isStreamFlag(s, HISTORY_STREAMS)) markBrowserComplete(s);
      for (const s of browserComplete()) {
        if (account.complete.includes(s)) continue;
        try {
          await cloud.markComplete(s);
        } catch (err) {
          console.warn('[caser-tracker] could not update the server', err);
        }
      }
      const renamed = await syncNames(account.names);
      await fixLegacyOwner().catch((err) => console.warn('[caser-tracker] could not read the legacy owner', err));

      cloudStatus = { ...cloudStatus, state: 'idle', lastPull: Date.now(), error: null, progress: null };
      remote.invalidate();
      if (renamed) refreshSoon();
      return { added: 0 };
    } catch (err) {
      cloudStatus = { ...cloudStatus, state: 'error', error: err.message || String(err), progress: null };
      throw err;
    } finally {
      cloudRun = null;
      dashboard?.refresh();
    }
  })();
  return cloudRun;
}

/** Use another browser's key: from now on this browser shows (and adds to) that history. */
async function setCloudKey(key) {
  if (!isSyncKey(key)) throw new Error('That is not a sync key. A key is 32 or more letters, digits, - or _.');
  // Events still queued under the old key go to the old history first.
  await flushOutbox().catch(() => {});
  browserPrefs.set('cloud:key', key);
  // Clears made under this key before now do not apply to this browser's data.
  browserPrefs.set('cloud:clearSeen', Date.now());
  browserPrefs.set('acct:legacy', null);
  cloudStatus = { state: 'idle', lastPull: null, lastPush: null, error: null, progress: null };
  remote.reset();
  dashboard?.refresh();
  overlay?.refresh();
  return cloudSync();
}

let cloudTicker = null;
function startCloudTicker() {
  if (cloudTicker) return;
  cloudTicker = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    cloudSync().catch((err) => console.warn('[caser-tracker] server sync failed', err));
  }, CLOUD_CHECK_EVERY_MS);
}

// After a live upgrade or case open the site plays its animation. Redrawing the panel then makes it
// stutter, so live refreshes wait a moment and then for an idle slot.
let liveTimer = null;
function refreshAfterLive() {
  if (liveTimer) return;
  liveTimer = setTimeout(() => {
    const run = () => {
      liveTimer = null;
      dashboard?.refresh();
      overlay?.refresh();
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 2000 });
    else run();
  }, 2500);
}

// ---- Case contents (item prices and, for custom cases, chances) ----
// Filled from the site's own case-page responses; fetched directly only when the site's
// response was not seen (for example when the page came from the site's cache).
const caseInfos = new Map(); // slug -> CaseInfo
const caseInfoLoads = new Map(); // slug -> Promise<CaseInfo|null>

function rememberCaseInfo(ex) {
  if (ex.method !== 'GET' || ex.status >= 400) return;
  const d = caseDetailPath(ex.path);
  if (!d) return;
  const info = caseInfoFromResponse(ex.resBody, d);
  if (info) caseInfos.set(d.slug, info);
}

async function getCaseInfo(slug) {
  const known = caseInfos.get(slug);
  if (known) return known;
  // Give the site's own request a moment to arrive before asking ourselves.
  for (let i = 0; i < 8 && !caseInfos.has(slug); i++) await new Promise((r) => setTimeout(r, 200));
  if (caseInfos.has(slug)) return caseInfos.get(slug);
  if (!caseInfoLoads.has(slug)) {
    const p = fetchCaseInfo(origFetch, slug).then((info) => {
      if (info) caseInfos.set(slug, info);
      return info;
    }).finally(() => caseInfoLoads.delete(slug));
    caseInfoLoads.set(slug, p);
  }
  return caseInfoLoads.get(slug);
}

// ---- Item replacement ----
// The site's replacement modal asks for candidates; the latest answer is kept for the exchange panel.
let replacement = null;

function rememberReplacement(ex) {
  if (ex.method !== 'GET' || ex.status >= 400) return;
  const itemId = replacementItemId(ex.path);
  if (!itemId) return;
  replacement = { itemId, candidates: candidatesFromResponse(ex.resBody), ts: Date.now() };
}

function replacementState() {
  if (!replacement) return null;
  const it = ctx.items.get(replacement.itemId);
  return { itemId: replacement.itemId, current: it ? { name: it.name, price: it.price } : null, candidates: replacement.candidates };
}

// Cross-origin request (CSFloat prices, cloud sync). anonymous: no cookies are sent.
function gmRequest({ method = 'GET', url, headers = { accept: 'application/json' }, body, timeout = 30000 }) {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line no-undef
    const gm = typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest : null;
    const host = new URL(url).hostname;
    if (!gm) {
      reject(new Error('Reinstall the script: it needs the GM_xmlhttpRequest permission'));
      return;
    }
    gm({
      method,
      url,
      headers,
      data: body,
      anonymous: true,
      timeout,
      onload: (r) => {
        let json = null;
        try {
          json = JSON.parse(r.responseText);
        } catch {}
        resolve({ status: r.status, json, text: r.responseText });
      },
      onerror: () => reject(new Error(`Request to ${host} failed`)),
      ontimeout: () => reject(new Error(`Request to ${host} timed out`)),
    });
  });
}

const csfloatRequest = (url) => gmRequest({ url });

// ---- Update check (see update.js) ----
// Checked on its own at most every 6 hours, and on demand from the dashboard. The last answer is kept
// in script storage, so every domain and tab shows it.
const UPDATE_CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
let updateBusy = null;
let updateError = null;

function updateState() {
  const v = browserPrefs.get('update:last');
  const last = v && typeof v === 'object' && typeof v.latest === 'string' ? v : null;
  return {
    available: !!UPDATE_URL,
    current: VERSION,
    latest: last?.latest ?? null,
    newer: !!last && compareVersions(last.latest, VERSION) > 0,
    checkedAt: last?.checkedAt ?? null,
    checking: !!updateBusy,
    error: updateError,
  };
}

function checkUpdate() {
  if (!UPDATE_URL) return Promise.reject(new Error('This build has no update address'));
  if (updateBusy) return updateBusy;
  updateBusy = (async () => {
    try {
      const r = await checkForUpdate({
        url: UPDATE_URL,
        current: VERSION,
        request: (url) => gmRequest({ url, headers: { accept: 'text/plain' } }),
      });
      browserPrefs.set('update:last', { latest: r.latest, checkedAt: r.checkedAt });
      updateError = null;
      return updateState();
    } catch (err) {
      updateError = err.message || String(err);
      throw err;
    } finally {
      updateBusy = null;
      dashboard?.refresh();
    }
  })();
  return updateBusy;
}

function maybeCheckUpdate() {
  const last = updateState().checkedAt;
  if (last && Date.now() - last < UPDATE_CHECK_EVERY_MS) return;
  checkUpdate().catch((err) => console.warn('[caser-tracker] update check failed', err));
}

/** Opens the published script; Tampermonkey shows its update page for it. */
function openUpdate() {
  if (!UPDATE_URL) return;
  // eslint-disable-next-line no-undef
  if (typeof GM_openInTab === 'function') GM_openInTab(UPDATE_URL, { active: true });
  else window.open(UPDATE_URL, '_blank', 'noopener');
}

const prices = createPriceClient({ request: csfloatRequest, storage: uiStore });

const { origFetch } = installHook(pageWindow, async (ex) => {
  if (ex.auth) lastAuth = ex.auth;
  try {
    rememberCaseInfo(ex);
    rememberReplacement(ex);
  } catch {}
  // Parse before learning: learn() updates the balance, and events need the balance from before.
  const { events, recognized } = parseExchange(ex, ctx, site);
  const userBefore = ctx.userId;
  const nameBefore = ctx.userName;
  ctx.learn(ex);
  if (ex.path.split('?')[0] === '/users/me' && ex.status < 400 && ctx.userId != null) userAuth = getAuth();
  if (ctx.userId !== userBefore || ctx.userName !== nameBefore) onAccountSeen(userBefore);
  if (!recognized && !events.length) return;

  try {
    if (events.length) {
      // Events belong to whoever is signed in now; parsing may have run before that was known.
      const uid = await ensureUser();
      if (uid != null) for (const e of events) e.userId = uid;
      lastEventTs = Date.now();
      await saveEvents(events);
    } else if (ex.status < 400) {
      // A game endpoint answered but nothing could be parsed: keep it so the parser can be fixed.
      unknownResponses++;
      await store.addRaw({ path: ex.path, status: ex.status, reqBody: ex.reqBody, resBody: ex.resBody });
    }
  } catch (err) {
    console.warn('[caser-tracker] could not save', err);
  }
});

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// The site sends "Authorization: Bearer <auth_token from localStorage>". Used only for the
// user's own history requests to the same site, never stored or sent anywhere else.
// The site writes a renewed token to localStorage, so read it fresh on every request; the last
// header seen is only a fallback.
function getAuth() {
  try {
    const t = localStorage.getItem('auth_token');
    if (t) return `Bearer ${t}`;
  } catch {}
  return lastAuth;
}

function currencyLabel() {
  return '';
}

// The upgrade overlay re-reads the selection every 400 ms (the history part comes from the server
// once per change), and can be turned off. Off means not mounted at all: no polling.
const OVERLAY_ON_KEY = 'cst.ui.upgradeOverlayOn';
function setUpgradeOverlay(on) {
  uiStore.set(OVERLAY_ON_KEY, on);
  if (on && !overlay) {
    overlay = mountUpgradeOverlay({
      getSelection: () => readUpgradeSelection(document),
      remote,
      stats,
      currency: currencyLabel,
      getHoldings: holdings,
      onTurnOff: () => {
        setUpgradeOverlay(false);
        dashboard?.refresh();
      },
    });
  } else if (!on && overlay) {
    overlay.destroy();
    overlay = null;
  }
}

function mount() {
  dashboard = mountDashboard({
    remote,
    getAccounts: accountsState,
    selectAccount,
    stats,
    currency: currencyLabel,
    onExport: async (format) => {
      // Everything on the server plus what is still queued here. A guest exports only the signed-in account.
      await flushOutbox().catch(() => {});
      const { events: fromServer } = await cloud.pull(null);
      const byId = new Map(fromServer.map((e) => [e.id, e]));
      for (const e of await store.allEvents()) byId.set(e.id, e);
      let events = [...byId.values()].sort((a, b) => a.ts - b.ts);
      if (guest()) events = events.filter((e) => (e.userId != null ? String(e.userId) : legacyOwner()) === selectedAccount());
      const stamp = new Date().toISOString().slice(0, 10);
      if (format === 'csv') download(`caser-tracker-${stamp}.csv`, toCsv(events), 'text/csv');
      else download(`caser-tracker-${stamp}.json`, toJson(events), 'application/json');
    },
    onImportFile: async (file) => {
      const added = await saveEvents(fromJson(await file.text()));
      dashboard.refresh();
      return { added };
    },
    onImportHistory: () => sync(),
    onClear: async () => {
      requireOwner();
      await clearLocal();
      browserPrefs.set('cloud:clearSeen', await cloud.clear());
      accountSel = 'current';
      dashboard.refresh();
    },
    getStatus: () => ({
      capturing: true,
      lastEventTs: lastEventTs ?? remote.get('meta').value?.lastTs ?? null,
      unknownResponses,
      version: VERSION,
      lastSync: lastSyncFor(ctx.userId ?? selectedAccount()),
      syncing: syncProgress,
      // The sync key opens every account's history, so a guest does not get it.
      cloud: guest() ? null : { key: cloudKey(), ...cloudStatus, version: remote.version() },
      update: updateState(),
      lock: lockState(),
    }),
    onCheckUpdate: () => checkUpdate(),
    onOpenUpdate: () => openUpdate(),
    onCloudJoin: (key) => (requireOwner(), setCloudKey(String(key ?? '').trim())),
    onCloudSync: () => (requireOwner(), cloudSync()),
    onUnlock: (password, remember) => unlockWith(password, remember),
    onLock: () => lockNow(),
    copyText: (text) => {
      // eslint-disable-next-line no-undef
      if (typeof GM_setClipboard !== 'function') return false;
      // eslint-disable-next-line no-undef
      GM_setClipboard(text, 'text');
      return true;
    },
    getHoldings: holdings,
    getSettings: () => ({ upgradeOverlay: !!overlay }),
    setSetting: (key, value) => {
      if (key === 'upgradeOverlay') setUpgradeOverlay(!!value);
    },
  });
  setUpgradeOverlay(uiStore.get(OVERLAY_ON_KEY, true) !== false);
  mountCasePanel({
    getSlug: () => caseSlugFromPath(location.pathname),
    getInfo: getCaseInfo,
    stats,
    currency: currencyLabel,
  });
  mountExchangePanel({
    isOpen: () => !!document.querySelector('[data-testid="replace-item-modal"]'),
    getState: replacementState,
    prices,
    stats,
    currency: currencyLabel,
    // Selects the item in the site's own list (same as clicking its card). Never confirms the replacement.
    selectCandidate: (id) => {
      const card = document.querySelector(`[data-testid="replace-item-modal-candidate-${CSS.escape(id)}"]`);
      if (!card) return false;
      card.scrollIntoView({ block: 'nearest' });
      card.click();
      return true;
    },
  });
  mounted = true;
  startAutoSync();
}

// ---- Sync with the site's own history ----
// Everything is kept in IndexedDB, so a sync only fetches what is new: the import stops after
// two pages of already-stored events. The first sync on a browser is a full import.
const AUTO_SYNC_AFTER_MS = 15 * 60 * 1000;
// Last site-history sync per account. "lastSync" from before multi-account support belongs to the legacy owner.
let lastSyncBy = {};
let lastSyncLegacy = null;
let mounted = false;

function lastSyncFor(uid) {
  if (uid == null || uid === 'all') return Math.max(0, lastSyncLegacy ?? 0, ...Object.values(lastSyncBy)) || null;
  return lastSyncBy[uid] ?? (uid === legacyOwner() ? lastSyncLegacy : null);
}
let syncProgress = null;
let syncPromise = null;

// Recomputing every stat over tens of thousands of events after each history page is wasteful;
// during a sync the panel refreshes at most every few seconds.
let refreshTimer = null;
function refreshSoon() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    dashboard?.refresh();
  }, 3000);
}

function sync() {
  if (syncPromise) return syncPromise;
  syncPromise = (async () => {
    try {
      // The import compares with what the server has, so the old local history must be there first.
      if (cloudRun) {
        syncProgress = 'Waiting for the upload';
        dashboard?.refresh();
        await cloudRun.catch(() => {});
      }
      const res = await importHistory({
        fetch: origFetch,
        ctx,
        site,
        getAuth,
        save: async (evs) => {
          const added = await saveEvents(evs);
          if (added) refreshSoon();
          return added;
        },
        // Counts of the signed-in account's imported events (they decide where an unfinished walk
        // resumes) and its withdrawals, from the server.
        getStored: async () => {
          await flushOutbox().catch(() => {});
          return remote.fetch('historyBase', ctx.userId);
        },
        onProgress: (msg) => {
          syncProgress = msg;
          refreshSoon();
        },
        progressStore: historyProgress,
      });
      if (ctx.userId != null) {
        lastSyncBy = { ...lastSyncBy, [ctx.userId]: Date.now() };
        await store.setMeta('lastSyncBy', lastSyncBy);
      }
      return res;
    } finally {
      syncProgress = null;
      syncPromise = null;
      dashboard?.refresh();
    }
  })();
  return syncPromise;
}

async function startAutoSync() {
  try {
    lastSyncLegacy = (await store.getMeta('lastSync')) ?? null;
    const by = await store.getMeta('lastSyncBy');
    lastSyncBy = by && typeof by === 'object' ? by : {};
    // Older versions copied every event into script storage; that copy is no longer used.
    const dropped = dropOldEventCopies(sharedGm);
    if (dropped) console.info(`[caser-tracker] removed ${dropped} old event copies from script storage`);
    await publishLocalComplete().catch(() => {});
    cloudSync().catch((err) => console.warn('[caser-tracker] server sync failed', err));
    startCloudTicker();
    dashboard?.refresh();
  } catch {}
  // Wait for the site to sign in and settle, then sync if it is due.
  setTimeout(maybeAutoSync, 5000);
  setTimeout(maybeCheckUpdate, 15000);
}

/** Sync the signed-in account's site history unless that ran in the last 15 minutes. */
async function maybeAutoSync() {
  if (!getAuth()) return;
  await ensureUser();
  const last = lastSyncFor(ctx.userId);
  if (last && Date.now() - last < AUTO_SYNC_AFTER_MS) return;
  sync().catch((err) => console.warn('[caser-tracker] sync failed', err));
}

if (document.body) mount();
else document.addEventListener('DOMContentLoaded', mount, { once: true });

// Debug handle for the developer console. Holds no credentials.
pageWindow.__caserTracker = { version: VERSION, store, ctx, remote };
