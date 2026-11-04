// Userscript entry. Runs at document-start so the fetch hook is in place before the site's first request.

import { installHook } from './capture/hook.js';
import { Context, parseExchange } from './capture/parsers.js';
import { importHistory } from './capture/history.js';
import { readUpgradeSelection } from './capture/selection.js';
import { Store, shouldReplace, mergeEvent } from './store/db.js';
import { toJson, toCsv, fromJson } from './store/export.js';
import * as stats from './stats/index.js';
import { mountDashboard, mountUpgradeOverlay } from './ui/index.js';

const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : 'dev';
const site = location.hostname.replace(/^www\./, '');
const ctx = new Context();
const store = new Store(indexedDB);

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

function dropMemory() {
  memEvents = null;
  memIndex = null;
}

async function saveEvents(events) {
  const added = await store.putEvents(events);
  applyToMemory(events);
  // A load that was already running may have read the store before this save; applying twice is harmless.
  if (memLoad) memLoad.then(() => applyToMemory(events), () => {});
  return added;
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

const { origFetch } = installHook(window, async (ex) => {
  if (ex.auth) lastAuth = ex.auth;
  // Parse before learning: learn() updates the balance, and events need the balance from before.
  const { events, recognized } = parseExchange(ex, ctx, site);
  ctx.learn(ex);
  if (!recognized && !events.length) return;

  try {
    if (events.length) {
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

function mount() {
  dashboard = mountDashboard({
    getEvents,
    stats,
    currency: currencyLabel,
    onExport: async (format) => {
      const events = await getEvents();
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
      await store.clearEvents();
      dropMemory();
      for (const k of ['lastSync', 'sync:upgrades', 'sync:inventory', 'sync:payments']) await store.setMeta(k, null);
      lastSync = null;
      dashboard.refresh();
    },
    getStatus: () => ({ capturing: true, lastEventTs, unknownResponses, version: VERSION, lastSync, syncing: syncProgress, storagePersisted }),
    getHoldings: () => ({ balance: ctx.balance, inventoryValue: ctx.inventoryValue }),
  });
  overlay = mountUpgradeOverlay({
    getSelection: () => readUpgradeSelection(document),
    getEvents,
    stats,
    currency: currencyLabel,
    getHoldings: () => ({ balance: ctx.balance, inventoryValue: ctx.inventoryValue }),
  });
  startAutoSync();
}

// ---- Sync with the site's own history ----
// Everything is kept in IndexedDB, so a sync only fetches what is new: the import stops after
// two pages of already-stored events. The first sync on a browser is a full import.
const AUTO_SYNC_AFTER_MS = 15 * 60 * 1000;
let lastSync = null;
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
        getStored: () => getEvents(),
        onProgress: (msg) => {
          syncProgress = msg;
          refreshSoon();
        },
        progressStore: {
          load: (name) => store.getMeta(`sync:${name}`),
          save: (name, v) => store.setMeta(`sync:${name}`, v),
        },
      });
      lastSync = Date.now();
      await store.setMeta('lastSync', lastSync);
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
    lastSync = (await store.getMeta('lastSync')) ?? null;
    // "Last event" covers stored history too, not only events captured since the page loaded.
    const events = await getEvents();
    if (events.length && !lastEventTs) lastEventTs = events[events.length - 1].ts;
    dashboard?.refresh();
  } catch {}
  // Ask the browser not to evict the stored history under storage pressure.
  try {
    storagePersisted = (await navigator.storage?.persist?.()) ?? null;
  } catch {}
  // Wait for the site to sign in and settle, then sync if it is due.
  setTimeout(() => {
    if (!getAuth()) return;
    if (lastSync && Date.now() - lastSync < AUTO_SYNC_AFTER_MS) return;
    sync().catch((err) => console.warn('[caser-tracker] sync failed', err));
  }, 5000);
}

if (document.body) mount();
else document.addEventListener('DOMContentLoaded', mount, { once: true });

// Debug handle for the developer console. Holds no credentials.
window.__caserTracker = { version: VERSION, store, ctx, stats };
