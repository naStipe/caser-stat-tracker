// Site pulse wiring: collector, local store, cloud, and the summary the Pulse tab shows.
// The collector runs only where it was switched on (per site domain and browser), in one tab at a time.

import { createCollector, HttpError } from './collector.js';
import { createPulseStore } from './store.js';
import { createPulseCloud } from './cloud.js';
import { hashUser } from './rows.js';
import { aggregate, pulseSummary, pulseWindows, HOUR } from './stats.js';

const ON_KEY = 'cst.pulse.on';
const FLUSH_EVERY_MS = 60 * 1000;
const LOCK_NAME = 'caser-tracker-pulse';

/**
 * @param {Object} o
 * @param {typeof fetch} o.fetch  the page's original fetch
 * @param {() => string|null} o.getAuth
 * @param {{get: (k: string) => any, set: (k: string, v: any) => void}} o.prefs  browser-wide settings
 * @param {{get: (k: string, d: any) => any, set: (k: string, v: any) => void}} o.local  this domain's settings
 * @param {Function} o.request  GM request for the cloud
 * @param {() => string|null} o.cloudKey
 * @param {() => void} o.onChange
 * @param {() => void} [o.requireOwner]
 */
export function createPulse({ fetch, getAuth, prefs, local, request, cloudKey, onChange, requireOwner }) {
  const db = createPulseStore(indexedDB);
  const cloud = createPulseCloud({ request, getKey: cloudKey });
  let collector = null;
  let active = false; // a collector run is in progress (or waiting for the tab lock)
  let restartAfter = false;
  let otherTab = false;
  let summary = null;
  let error = null;
  let loading = false;
  let updatedAt = null;
  let source = 'local';
  let pendingRows = [];
  let pendingVolume = [];
  let flushTimer = null;

  function salt() {
    let s = prefs.get('pulse:salt');
    if (typeof s !== 'string' || s.length < 16) {
      const b = new Uint8Array(16);
      crypto.getRandomValues(b);
      s = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
      prefs.set('pulse:salt', s);
    }
    return s;
  }

  async function getJson(path) {
    const headers = { accept: 'application/json' };
    const auth = getAuth();
    if (auth) headers.Authorization = auth;
    const res = await fetch(path, { headers, credentials: 'include' });
    if (!res.ok) throw new HttpError(res.status, path.split('?')[0]);
    return res.json();
  }

  async function flush() {
    if (!cloud.enabled() || (!pendingRows.length && !pendingVolume.length)) return;
    const rows = pendingRows;
    const volume = pendingVolume;
    pendingRows = [];
    pendingVolume = [];
    try {
      await cloud.push(rows, volume);
    } catch (e) {
      // Keep them for the next try, but do not grow without bound.
      pendingRows = [...rows, ...pendingRows].slice(-20000);
      pendingVolume = [...volume, ...pendingVolume].slice(-2000);
      console.warn('[caser-tracker] pulse cloud push failed', e);
    }
  }

  let lastNotify = 0;
  let notifyTimer = null;
  function notify() {
    // The panel re-renders at most every 5 s for collector progress.
    const wait = 5000 - (Date.now() - lastNotify);
    if (notifyTimer) return;
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      lastNotify = Date.now();
      onChange();
    }, Math.max(0, wait));
  }

  function done() {
    active = false;
    if (restartAfter && local.get(ON_KEY, false) === true) {
      restartAfter = false;
      startCollector();
    }
    notify();
  }

  function startCollector() {
    if (active) {
      // Switched off and on again before the last run finished: start again once it has.
      if (collector && !collector.status().running) restartAfter = true;
      return;
    }
    active = true;
    otherTab = false;
    const s = salt();
    const run = async () => {
      collector = createCollector({
        getJson,
        hashUser: (id) => hashUser(id, s),
        saveRows: async (rows) => {
          await db.putRows(rows);
          pendingRows.push(...rows);
        },
        saveVolume: async (v) => {
          await db.putVolume(v);
          pendingVolume.push(v);
        },
        onChange: notify,
      });
      flushTimer = setInterval(() => flush(), FLUSH_EVERY_MS);
      await collector.start();
      clearInterval(flushTimer);
      await flush();
    };
    // One collecting tab per domain in this browser.
    if (navigator.locks?.request) {
      navigator.locks
        .request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
          if (!lock) {
            otherTab = true;
            notify();
            return;
          }
          otherTab = false;
          await run();
        })
        .catch((e) => console.warn('[caser-tracker] pulse collector failed', e))
        .finally(done);
    } else {
      run()
        .catch((e) => console.warn('[caser-tracker] pulse collector failed', e))
        .finally(done);
    }
  }

  function stopCollector() {
    collector?.stop();
  }

  async function loadSummary() {
    const now = Date.now();
    const w = pulseWindows(now);
    if (cloud.enabled()) {
      source = 'cloud';
      const [recent, base, day, hours, volume] = await Promise.all([
        cloud.agg(w.recent.from, w.recent.to, w.recent.to - w.recent.from),
        cloud.agg(w.base.from, w.base.to, w.base.to - w.base.from),
        cloud.agg(w.day.from, w.day.to, w.day.to - w.day.from),
        cloud.agg(w.hours.from, w.hours.to, HOUR),
        cloud.volume(w.hours.from),
      ]);
      return pulseSummary({ recent, base, day, hours }, volume, now);
    }
    source = 'local';
    const { rows, volume } = await db.since(w.hours.from);
    const one = (win) => aggregate(rows, { from: win.from, to: win.to, bucketMs: win.to - win.from });
    return pulseSummary({ recent: one(w.recent), base: one(w.base), day: one(w.day), hours: aggregate(rows, w.hours) }, volume, now);
  }

  return {
    /** Start the collector if it was left on, and prune old local rows. */
    boot() {
      db.prune().catch(() => {});
      if (local.get(ON_KEY, false) === true) startCollector();
    },
    snapshot() {
      return {
        enabled: local.get(ON_KEY, false) === true,
        otherTab,
        collector: collector ? collector.status() : null,
        source: cloud.enabled() ? 'cloud' : 'local',
        summary,
        error,
        loading,
        updatedAt,
      };
    },
    setEnabled(on) {
      requireOwner?.();
      local.set(ON_KEY, !!on);
      if (on) startCollector();
      else stopCollector();
      notify();
    },
    async refresh() {
      if (loading) return;
      loading = true;
      try {
        if (collector) await flush();
        summary = await loadSummary();
        error = null;
      } catch (e) {
        error = String(e?.message ?? e);
      } finally {
        loading = false;
        updatedAt = Date.now();
        onChange();
      }
    },
  };
}
