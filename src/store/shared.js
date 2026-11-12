// Event storage shared by every domain the script runs on (caser.gg, caser.one, ...).
// IndexedDB belongs to one origin, so each domain has its own copy. The userscript manager's
// value storage (GM_setValue) belongs to the script instead, so it is the meeting point: every
// domain pushes its events here and pulls the others' events from here.
//
// Events are kept in one value per UTC day ("ev:2026-11-12"), so a new event rewrites only that
// day. "ev:rev" changes after every write so open tabs on another domain can pick up new events,
// and "ev:clearedAt" records the last "clear all data" so other domains drop their copies too.

import { shouldReplace, mergeEvent } from './db.js';

const DAY_PREFIX = 'ev:d:';
const REV_KEY = 'ev:rev';
const CLEARED_KEY = 'ev:clearedAt';

export function dayKey(ts) {
  const d = new Date(Number.isFinite(ts) ? ts : 0);
  return DAY_PREFIX + (Number.isNaN(d.getTime()) ? '1970-01-01' : d.toISOString().slice(0, 10));
}

/**
 * @param {{get: (key: string, def?: any) => any, set: (key: string, v: any) => void, del: (key: string) => void,
 *   list: () => string[], listen?: (key: string, cb: (value: any, remote: boolean) => void) => void}} gm
 */
export function createSharedStore(gm) {
  const readDay = (key) => {
    const v = gm.get(key, null);
    return Array.isArray(v) ? v : [];
  };
  const dayKeys = () => gm.list().filter((k) => k.startsWith(DAY_PREFIX));

  function bumpRev(days) {
    gm.set(REV_KEY, { at: Date.now(), days, nonce: Math.random().toString(36).slice(2) });
  }

  return {
    /** Every shared event, oldest first. */
    readAll() {
      const out = [];
      for (const k of dayKeys()) out.push(...readDay(k));
      return out.sort((a, b) => a.ts - b.ts);
    },

    /** Events of the given day keys (as sent in a rev change). */
    readDays(keys) {
      const out = [];
      for (const k of keys ?? []) if (typeof k === 'string' && k.startsWith(DAY_PREFIX)) out.push(...readDay(k));
      return out;
    },

    /**
     * Merge events into the shared copy with the same rules as the local store.
     * Only days that actually change are written. Returns the changed day keys.
     */
    merge(events) {
      const byDay = new Map();
      for (const ev of events) {
        if (!ev || typeof ev.id !== 'string') continue;
        const k = dayKey(ev.ts);
        if (!byDay.has(k)) byDay.set(k, []);
        byDay.get(k).push(ev);
      }
      const changed = [];
      for (const [k, incoming] of byDay) {
        const list = readDay(k);
        const index = new Map(list.map((e, i) => [e.id, i]));
        let dirty = false;
        for (const ev of incoming) {
          const i = index.get(ev.id);
          if (i === undefined) {
            index.set(ev.id, list.length);
            list.push(ev);
            dirty = true;
          } else if (shouldReplace(list[i], ev)) {
            list[i] = mergeEvent(list[i], ev);
            dirty = true;
          }
        }
        if (dirty) {
          gm.set(k, list);
          changed.push(k);
        }
      }
      if (changed.length) bumpRev(changed);
      return changed;
    },

    /** Remove events by id from every day. */
    remove(ids) {
      const drop = new Set(ids);
      if (!drop.size) return;
      const changed = [];
      for (const k of dayKeys()) {
        const list = readDay(k);
        const kept = list.filter((e) => !drop.has(e.id));
        if (kept.length === list.length) continue;
        if (kept.length) gm.set(k, kept);
        else gm.del(k);
        changed.push(k);
      }
      if (changed.length) bumpRev(changed);
    },

    /** Delete every shared event and tell the other domains to drop theirs. Returns the clear time. */
    clear() {
      for (const k of dayKeys()) gm.del(k);
      const at = Date.now();
      gm.set(CLEARED_KEY, at);
      bumpRev([]);
      return at;
    },

    clearedAt() {
      const v = gm.get(CLEARED_KEY, null);
      return Number.isFinite(v) ? v : null;
    },

    /** Calls back with the changed events when another tab (any domain) writes. */
    onRemoteChange(cb) {
      gm.listen?.(REV_KEY, (value, remote) => {
        if (remote) cb(value);
      });
    },
  };
}

/** The userscript manager's storage, or null when the script runs without the GM_* grants. */
export function gmStorage() {
  /* eslint-disable no-undef */
  if (typeof GM_getValue !== 'function' || typeof GM_setValue !== 'function' || typeof GM_listValues !== 'function') return null;
  return {
    get: (k, d) => GM_getValue(k, d),
    set: (k, v) => GM_setValue(k, v),
    del: (k) => (typeof GM_deleteValue === 'function' ? GM_deleteValue(k) : GM_setValue(k, null)),
    list: () => GM_listValues(),
    listen: typeof GM_addValueChangeListener === 'function'
      ? (k, cb) => GM_addValueChangeListener(k, (_name, _old, value, remote) => cb(value, remote))
      : undefined,
  };
  /* eslint-enable no-undef */
}
