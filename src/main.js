// Userscript entry. Runs at document-start so the fetch hook is in place before the site's first request.

import { installHook } from './capture/hook.js';
import { Context, parseExchange, withdrawalTwinIds, caseTwinIds } from './capture/parsers.js';
import { importHistory } from './capture/history.js';
import { readUpgradeSelection } from './capture/selection.js';
import { caseSlugFromPath, caseDetailPath, caseInfoFromResponse, fetchCaseInfo } from './capture/caseinfo.js';
import { replacementItemId, candidatesFromResponse } from './capture/replacements.js';
import { createPriceClient } from './prices/csfloat.js';
import { Store, shouldReplace, mergeEvent } from './store/db.js';
import { toJson, toCsv, fromJson } from './store/export.js';
import { createSharedStore, gmStorage } from './store/shared.js';
import { createCloud, isSyncKey, newSyncKey, eventRank, planUpload } from './store/cloud.js';
import { pickLegacyOwner, filterByAccount, resolveSelection, listAccounts, accountName, mergeNames, streamFlag, flagComplete, progressKey, isStreamFlag } from './store/accounts.js';
import { OWNER_LOCK, checkPassword, isGuest } from './store/lock.js';
import * as stats from './stats/index.js';
import { checkForUpdate, compareVersions } from './update.js';
import { createPulse } from './pulse/index.js';
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
// Same account on every domain: events are also kept in the script's own storage, which all
// domains share (see store/shared.js). Null when the manager does not grant GM storage.
const sharedGm = gmStorage();
const shared = sharedGm && createSharedStore(sharedGm);
// Settings that belong to this browser rather than to one domain (the cloud sync key).
const browserPrefs = sharedGm
  ? { get: (k) => sharedGm.get(k, null), set: (k, v) => sharedGm.set(k, v) }
  : { get: (k) => uiStore.get(k, null), set: (k, v) => uiStore.set(k, v) };

let lastAuth = null;
let lastEventTs = null;
let unknownResponses = 0;
let dashboard = null;
let overlay = null;

// ---- In-memory copy of the stored events ----
// Reading ~30k events from IndexedDB costs hundreds of ms on the main thread, so it is read once
// and then kept in step with every save. getEvents() returns a fresh array (cheap) so views
// can tell a change from no change.
let memEvents = null;
let memIndex = null;
let memLoad = null;

function getEvents() {
  if (memEvents) return Promise.resolve(memEvents.slice());
  if (!memLoad) {
    memLoad = store.allEvents().then((list) => {
      memEvents = list;
      memIndex = new Map(list.map((e, i) => [e.id, i]));
      memLoad = null;
      return list;
    }, (err) => {
      memLoad = null;
      throw err;
    });
  }
  return memLoad.then((list) => list.slice());
}

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
 * Owner of events without a userId and of the old flags that had no account. Fixed once the
 * events of this browser are all here (see fixLegacyOwner); until then it is computed.
 */
function legacyOwner() {
  const v = browserPrefs.get('acct:legacy');
  if (typeof v === 'string' && v) return v;
  return memEvents ? pickLegacyOwner(memEvents) : null;
}

function fixLegacyOwner() {
  const v = browserPrefs.get('acct:legacy');
  if (typeof v === 'string' && v) return;
  const pick = memEvents ? pickLegacyOwner(memEvents) : null;
  if (pick) browserPrefs.set('acct:legacy', pick);
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
  if (guest()) throw new Error('Locked. Enter the owner password in Data → Owner lock first.');
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

/** Events of the selected account. Sync, export and clear keep working on all events. */
async function getViewEvents() {
  await ensureUser();
  const all = await getEvents();
  return filterByAccount(all, selectedAccount(), legacyOwner());
}

function accountsState() {
  const all = memEvents ?? [];
  if (guest()) {
    const own = filterByAccount(all, selectedAccount(), legacyOwner());
    const list = listAccounts(own, knownAccounts(), legacyOwner(), ctx.userId).filter((a) => a.current);
    return { list, selected: selectedAccount(), total: own.length, guest: true };
  }
  return {
    list: listAccounts(all, knownAccounts(), legacyOwner(), ctx.userId),
    selected: selectedAccount(),
    total: all.length,
    guest: false,
  };
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

/** Mirror of Store.putEvents on the in-memory copy. */
function applyToMemory(events) {
  if (!memEvents) return;
  let unsorted = false;
  for (const ev of events) {
    const i = memIndex.get(ev.id);
    if (i === undefined) {
      const last = memEvents[memEvents.length - 1];
      if (last && ev.ts < last.ts) unsorted = true;
      memIndex.set(ev.id, memEvents.length);
      memEvents.push(ev);
    } else if (shouldReplace(memEvents[i], ev)) {
      const merged = mergeEvent(memEvents[i], ev);
      if (merged.ts !== memEvents[i].ts) unsorted = true;
      memEvents[i] = merged;
    }
  }
  if (unsorted) {
    memEvents.sort((a, b) => a.ts - b.ts);
    memIndex = new Map(memEvents.map((e, i) => [e.id, i]));
  }
}

/**
 * A withdrawal or case drop captured live and the same one imported from the site's history have
 * different ids. Import skips the copy when the live one is already stored, but the live one can
 * arrive later (another browser through the cloud, the other domain, a file), and older versions
 * also stored both. Remove the imported copies; the deletion reaches the other domain and the cloud.
 */
async function removeTwins() {
  const events = await getEvents();
  const twins = [...withdrawalTwinIds(events), ...caseTwinIds(events)];
  if (!twins.length) return 0;
  await deleteEvents(twins);
  return twins.length;
}

/** Delete events here, in the storage shared by the domains and (unless the cloud asked) in the cloud. */
async function deleteEvents(ids, { cloud: toCloud = true } = {}) {
  if (!ids.length) return;
  const drop = new Set(ids);
  await store.deleteEvents(ids);
  try {
    shared?.remove(ids);
  } catch (err) {
    console.warn('[caser-tracker] could not update shared storage', err);
  }
  if (memEvents) {
    memEvents = memEvents.filter((e) => !drop.has(e.id));
    memIndex = new Map(memEvents.map((e, i) => [e.id, i]));
  }
  if (toCloud && cloudKey()) cloud.remove(ids).catch((err) => console.warn('[caser-tracker] could not delete in cloud', err));
}

function dropMemory() {
  memEvents = null;
  memIndex = null;
}

async function saveEvents(events, { share = true, cloud: toCloud = true } = {}) {
  const added = await store.putEvents(events);
  applyToMemory(events);
  // A load that was already running may have read the store before this save; applying twice is harmless.
  if (memLoad) memLoad.then(() => applyToMemory(events), () => {});
  if (share) queueShared(events);
  if (toCloud) queueCloud(events);
  return added;
}

// ---- Shared storage across domains ----
// Writes are batched: a history sync saves page after page, and each shared write rewrites a whole day.
let sharedQueue = [];
let sharedTimer = null;
function queueShared(events) {
  if (!shared || !events.length) return;
  sharedQueue.push(...events);
  if (!sharedTimer) sharedTimer = setTimeout(flushShared, 1500);
}

function flushShared() {
  sharedTimer = null;
  const batch = sharedQueue;
  sharedQueue = [];
  try {
    shared.merge(batch);
  } catch (err) {
    console.warn('[caser-tracker] could not write shared storage', err);
  }
}

/** Clears this domain's copy, for "clear all data" here or on another domain. */
async function clearLocal() {
  const ids = new Set(Object.keys(knownAccounts()));
  for (const e of memEvents ?? (await getEvents())) if (e.userId != null) ids.add(String(e.userId));
  if (ctx.userId != null) ids.add(ctx.userId);
  await store.clearEvents();
  dropMemory();
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
// and the events reach here (shared storage or cloud), later syncs only need the newest pages.
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

/**
 * Pull the other domains' events into this domain, then push this domain's events out.
 * The first run on a domain copies its whole IndexedDB history into the shared storage.
 */
async function syncShared() {
  if (!shared) return;
  const clearedAt = shared.clearedAt();
  if (clearedAt && clearedAt > ((await store.getMeta('sharedClearSeen')) ?? 0)) {
    // Data was cleared on another domain after this domain last looked.
    await clearLocal();
    await store.setMeta('sharedClearSeen', clearedAt);
  }
  // Not queued for the cloud: the first cloud sync on this domain sends everything stored here.
  const remote = shared.readAll();
  if (remote.length) await saveEvents(remote, { share: false, cloud: false });
  await removeTwins();
  shared.merge(await getEvents());
  shared.onRemoteChange(async (rev) => {
    try {
      const cleared = shared.clearedAt();
      if (cleared && cleared > ((await store.getMeta('sharedClearSeen')) ?? 0)) {
        await clearLocal();
        await store.setMeta('sharedClearSeen', cleared);
        dashboard?.refresh();
        return;
      }
      // The tab that wrote these also sends them to the cloud.
      const events = shared.readDays(rev?.days);
      if (events.length && (await saveEvents(events, { share: false, cloud: false }))) {
        await removeTwins();
        refreshAfterLive();
      }
    } catch (err) {
      console.warn('[caser-tracker] could not read shared storage', err);
    }
  });
}

// ---- Cloud sync between browsers (see store/cloud.js) ----
// The sync key lives in this browser's script storage, so both domains use the same one.
// Per domain, IndexedDB meta keeps how far the cloud was read ("cloudCursor") and whether this
// domain's own history was sent once ("cloudPushedKey"). That first upload sends only what the cloud
// lacks ("cloudPushPlan", worked out once) and remembers how far it got ("cloudPushDone"), so a page
// reload in the middle continues instead of starting over.
const CLOUD_PULL_EVERY_MS = 60 * 1000;
const cloud = createCloud({ request: gmRequest, getKey: () => cloudKey() });
let cloudStatus = { state: 'idle', lastPull: null, error: null, progress: null };
const cloudQueue = new Set();
let cloudTimer = null;
let cloudRun = null;

function cloudKey() {
  const k = browserPrefs.get('cloud:key');
  return isSyncKey(k) ? k : null;
}

function queueCloud(events) {
  if (!cloudKey() || !events.length) return;
  for (const e of events) cloudQueue.add(e.id);
  if (!cloudTimer) {
    cloudTimer = setTimeout(() => {
      cloudTimer = null;
      flushCloud().catch(() => {});
    }, 3000);
  }
}

/** Send queued events. The stored (merged) copy is sent, so the cloud gets the best version. */
async function flushCloud() {
  if (!cloudQueue.size || !cloudKey()) return;
  const ids = [...cloudQueue];
  cloudQueue.clear();
  const byId = new Map((await getEvents()).map((e) => [e.id, e]));
  const events = ids.map((id) => byId.get(id)).filter(Boolean);
  try {
    await cloud.push(events);
    if (cloudStatus.state === 'error') cloudStatus = { ...cloudStatus, state: 'idle', error: null };
  } catch (err) {
    for (const id of ids) cloudQueue.add(id);
    cloudStatus = { ...cloudStatus, state: 'error', error: err.message || String(err) };
    throw err;
  }
}

const UPLOAD_BATCH = 500;

async function firstUpload(key) {
  let plan = await store.getMeta('cloudPushPlan');
  if (!plan || plan.key !== key || !Array.isArray(plan.ids)) {
    cloudStatus = { ...cloudStatus, progress: 'Comparing with the cloud' };
    dashboard?.refresh();
    const ranks = await cloud.ranks((n) => {
      cloudStatus = { ...cloudStatus, progress: `Comparing with the cloud (${n})` };
      refreshSoon();
    });
    plan = { key, ids: planUpload(await getEvents(), ranks) };
    await store.setMeta('cloudPushPlan', plan);
    await store.setMeta('cloudPushDone', 0);
  }
  let done = Number(await store.getMeta('cloudPushDone')) || 0;
  // Events can change or go away while an upload waits for the next page load; send the stored copy.
  const byId = new Map((await getEvents()).map((e) => [e.id, e]));
  while (done < plan.ids.length) {
    const batch = plan.ids.slice(done, done + UPLOAD_BATCH).map((id) => byId.get(id)).filter(Boolean);
    if (batch.length) await cloud.push(batch);
    done = Math.min(done + UPLOAD_BATCH, plan.ids.length);
    await store.setMeta('cloudPushDone', done);
    cloudStatus = { ...cloudStatus, progress: `Uploading ${done} / ${plan.ids.length} (one time)` };
    refreshSoon();
  }
  await store.setMeta('cloudPushedKey', key);
  await store.setMeta('cloudPushPlan', null);
  await store.setMeta('cloudPushDone', null);
}

/** Pull what other browsers sent, then send what this domain has that the cloud may lack. */
function cloudSync() {
  const key = cloudKey();
  if (!key) return Promise.resolve(null);
  if (cloudRun) return cloudRun;
  cloudRun = (async () => {
    cloudStatus = { ...cloudStatus, state: 'syncing', progress: 'Checking' };
    dashboard?.refresh();
    try {
      // "Clear all" in another browser: drop the local copy too, unless the clear happened before
      // this browser started using the key.
      const account = await cloud.account();
      const seen = Number(browserPrefs.get('cloud:clearSeen')) || 0;
      if (account.clearedAt && account.clearedAt > seen) {
        browserPrefs.set('cloud:clearSeen', account.clearedAt);
        await clearLocal();
        if (shared) await store.setMeta('sharedClearSeen', shared.clear());
      }

      let cursor = await store.getMeta('cloudCursor');
      if (!cursor || cursor.key !== key) cursor = null;
      cloudStatus = { ...cloudStatus, progress: cursor ? 'Downloading changes' : 'Downloading history' };
      dashboard?.refresh();
      const res = await cloud.pull(cursor);
      if (res.deletedIds.length) await deleteEvents(res.deletedIds, { cloud: false });
      let added = 0;
      for (let i = 0; i < res.events.length; i += 2000) added += await saveEvents(res.events.slice(i, i + 2000), { cloud: false });
      if (res.cursor) await store.setMeta('cloudCursor', { key, ...res.cursor });
      // Where the local copy merged into something better than the cloud's (for example a live
      // event that got its owner from an imported copy), send it back.
      if (res.events.length) {
        const byId = new Map((await getEvents()).map((e) => [e.id, e]));
        const better = res.events.map((e) => byId.get(e.id)).filter((m, i) => m && eventRank(m) > eventRank(res.events[i]));
        queueCloud(better);
      }
      if (added) await removeTwins();

      // First sync of this domain under this key: send what the cloud lacks, once.
      if ((await store.getMeta('cloudPushedKey')) !== key) await firstUpload(key);
      await flushCloud();

      // Exchange "history read to the end" flags, now that the events behind them are here.
      for (const s of account.complete) if (isStreamFlag(s, HISTORY_STREAMS)) markBrowserComplete(s);
      for (const s of browserComplete()) {
        if (account.complete.includes(s)) continue;
        try {
          await cloud.markComplete(s);
        } catch (err) {
          console.warn('[caser-tracker] could not update cloud', err);
        }
      }
      // Every event of this key is here now, so the owner of old account-less data is known.
      fixLegacyOwner();
      const renamed = await syncNames(account.names);

      cloudStatus = { state: 'idle', lastPull: Date.now(), error: null, progress: null };
      if (added || renamed) refreshSoon();
      return { added };
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

function setCloudKey(key) {
  if (key != null && !isSyncKey(key)) throw new Error('That is not a sync key. A key is 32 or more letters, digits, - or _.');
  browserPrefs.set('cloud:key', key);
  // Clears made under this key before now do not apply to this browser's data.
  browserPrefs.set('cloud:clearSeen', key ? Date.now() : null);
  cloudQueue.clear();
  cloudStatus = { state: 'idle', lastPull: null, error: null, progress: null };
  return key ? cloudSync() : null;
}

let cloudTicker = null;
function startCloudTicker() {
  if (cloudTicker) return;
  cloudTicker = setInterval(() => {
    if (document.visibilityState !== 'visible' || !cloudKey()) return;
    cloudSync().catch((err) => console.warn('[caser-tracker] cloud sync failed', err));
  }, CLOUD_PULL_EVERY_MS);
}

// After a live upgrade or case open the site plays its animation. Recomputing stats then makes it
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
      await saveEvents(events);
      lastEventTs = Date.now();
      refreshAfterLive();
    } else if (ex.status < 400) {
      // A game endpoint answered but nothing could be parsed: keep it so the parser can be fixed.
      unknownResponses++;
      await store.addRaw({ path: ex.path, status: ex.status, reqBody: ex.reqBody, resBody: ex.resBody });
    }
  } catch (err) {
    console.warn('[caser-tracker] could not save', err);
  }
});

// ---- Site pulse (see src/pulse/) ----
// Samples other players' public history to show how profitable play on the site is right now.
// Off unless switched on in the Pulse tab, in this browser and on this domain.
const pulse = createPulse({
  fetch: (...a) => origFetch(...a),
  getAuth: () => getAuth(),
  prefs: browserPrefs,
  local: uiStore,
  request: (req) => gmRequest(req),
  cloudKey: () => cloudKey(),
  requireOwner: () => requireOwner(),
  onChange: () => {
    if (uiStore.get('cst.ui.tab', null) === 'pulse') dashboard?.rerender();
  },
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

// The upgrade overlay re-reads the selection every 400 ms and recomputes odds over the whole history,
// so it can be turned off. Off means not mounted at all: no polling, no stats work.
const OVERLAY_ON_KEY = 'cst.ui.upgradeOverlayOn';
function setUpgradeOverlay(on) {
  uiStore.set(OVERLAY_ON_KEY, on);
  if (on && !overlay) {
    overlay = mountUpgradeOverlay({
      getSelection: () => readUpgradeSelection(document),
      getEvents: getViewEvents,
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
    getEvents: getViewEvents,
    getAccounts: accountsState,
    selectAccount,
    stats,
    currency: currencyLabel,
    onExport: async (format) => {
      // A guest exports only the signed-in account.
      const events = guest() ? await getViewEvents() : await getEvents();
      const stamp = new Date().toISOString().slice(0, 10);
      if (format === 'csv') download(`caser-tracker-${stamp}.csv`, toCsv(events), 'text/csv');
      else download(`caser-tracker-${stamp}.json`, toJson(events), 'application/json');
    },
    onImportFile: async (file) => {
      const added = await saveEvents(fromJson(await file.text()));
      if (added) await removeTwins();
      dashboard.refresh();
      return { added };
    },
    onImportHistory: () => sync(),
    onClear: async () => {
      requireOwner();
      sharedQueue = [];
      await clearLocal();
      if (shared) await store.setMeta('sharedClearSeen', shared.clear());
      if (cloudKey()) browserPrefs.set('cloud:clearSeen', await cloud.clear());
      accountSel = 'current';
      dashboard.refresh();
    },
    getStatus: () => ({
      capturing: true,
      lastEventTs,
      unknownResponses,
      version: VERSION,
      lastSync: lastSyncFor(ctx.userId ?? selectedAccount()),
      syncing: syncProgress,
      storagePersisted,
      // The sync key opens every account's history, so a guest does not get it.
      cloud: guest() ? null : { key: cloudKey(), ...cloudStatus },
      update: updateState(),
      lock: lockState(),
    }),
    onCheckUpdate: () => checkUpdate(),
    onOpenUpdate: () => openUpdate(),
    onCloudStart: () => (requireOwner(), setCloudKey(newSyncKey())),
    onCloudJoin: (key) => (requireOwner(), setCloudKey(String(key ?? '').trim())),
    onCloudStop: () => (requireOwner(), setCloudKey(null)),
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
    pulse,
  });
  pulse.boot();
  // Keeps the Pulse tab current while it is open (the tab reloads its data when it is a minute old).
  setInterval(() => {
    if (uiStore.get('cst.ui.tab', null) === 'pulse') dashboard?.rerender();
  }, 30 * 1000);
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
let storagePersisted = null;

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
      // Events still downloading from the cloud would look new to the site sync and make it
      // read far down the history, so let the download finish first.
      if (cloudRun) {
        syncProgress = 'Waiting for cloud download';
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
        // Only the signed-in account's events: they decide where an unfinished walk resumes.
        // Live events stored before the account was known (no userId) are included so the import
        // can give them their owner.
        getStored: async () => (await getEvents()).filter((e) => e.userId == null || String(e.userId) === ctx.userId),
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
    await syncShared().catch((err) => console.warn('[caser-tracker] could not sync shared storage', err));
    await publishLocalComplete().catch(() => {});
    cloudSync().catch((err) => console.warn('[caser-tracker] cloud sync failed', err));
    startCloudTicker();
    // "Last event" covers stored history too, not only events captured since the page loaded.
    await removeTwins().catch((err) => console.warn('[caser-tracker] could not remove duplicates', err));
    const events = await getEvents();
    if (events.length && !lastEventTs) lastEventTs = events[events.length - 1].ts;
    // Without cloud sync every event of this browser is here now (with it, see cloudSync).
    if (!cloudKey()) fixLegacyOwner();
    dashboard?.refresh();
  } catch {}
  // Ask the browser not to evict the stored history under storage pressure.
  try {
    storagePersisted = (await navigator.storage?.persist?.()) ?? null;
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
pageWindow.__caserTracker = { version: VERSION, store, ctx, stats };
