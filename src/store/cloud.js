// Cloud copy of the events in Supabase, so several browsers (Brave, Chrome, another PC) share one history.
// There are no accounts: a random sync key, made in one browser and pasted into the others, names the
// history. Every request sends it as the "x-sync-key" header; the database only shows rows for that key.
// Schema and access rules: supabase/migrations/*_sync_events.sql.

import { CLOUD_URL, CLOUD_KEY } from './cloud-config.js';

const PUSH_BATCH = 500;
const PULL_PAGE = 1000;
// Rows written by a transaction that committed late can carry an older updated_at than rows
// already pulled, so each pull run starts this far before the last cursor (re-reading is harmless).
const PULL_OVERLAP_MS = 15_000;

/**
 * How settled an event is. The database keeps the higher rank, so this must grow with every
 * case where Store.shouldReplace replaces an event: resolved beats pending, live beats imported.
 * A merged event has every flag of its parts, so it ranks above each of them.
 */
export function eventRank(e) {
  let r = 0;
  if (e.source === 'live') r += 1;
  if (e.kind === 'upgrade' && e.status && e.status !== 'pending') r += 2;
  if (e.kind === 'deposit' && e.status === 'completed') r += 2;
  if (e.kind === 'deposit' && e.completedTs != null) r += 4;
  if (e.userId != null) r += 8;
  return r;
}

const KEY_RE = /^[A-Za-z0-9_-]{32,128}$/;

export function isSyncKey(k) {
  return typeof k === 'string' && KEY_RE.test(k);
}

/** 32 random URL-safe characters (192 bits). */
export function newSyncKey() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * @param {Object} o
 * @param {(req: {method: string, url: string, headers: Object, body?: string}) => Promise<{status: number, json: any}>} o.request
 * @param {() => string|null} o.getKey  the sync key, or null when cloud sync is off
 * @param {string} [o.url]
 * @param {string} [o.apiKey]
 */
export function createCloud({ request, getKey, url = CLOUD_URL, apiKey = CLOUD_KEY }) {
  async function call(method, path, body) {
    const key = getKey();
    if (!isSyncKey(key)) throw new Error('Cloud sync is off');
    const res = await request({
      method,
      url: url + path,
      headers: { apikey: apiKey, 'x-sync-key': key, 'content-type': 'application/json', accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status < 200 || res.status >= 300) {
      const msg = res.json && (res.json.message || res.json.error);
      throw new Error(`Cloud answered ${res.status}${msg ? `: ${msg}` : ''}`);
    }
    return res.json;
  }

  return {
    /** Send events; the database keeps whichever copy ranks higher. Returns rows changed. */
    async push(events, onProgress) {
      let changed = 0;
      for (let i = 0; i < events.length; i += PUSH_BATCH) {
        const rows = events.slice(i, i + PUSH_BATCH).map((e) => ({ id: e.id, rank: eventRank(e), data: e }));
        changed += Number(await call('POST', '/rest/v1/rpc/sync_push', { rows })) || 0;
        onProgress?.(Math.min(i + PUSH_BATCH, events.length), events.length);
      }
      return changed;
    },

    /**
     * Everything changed since the cursor ({at, id} or null for all), oldest change first.
     * Returns {events, deletedIds, cursor}; pass the cursor to the next pull.
     */
    async pull(cursor) {
      const events = [];
      const deletedIds = [];
      let at = cursor?.at ? new Date(Date.parse(cursor.at) - PULL_OVERLAP_MS).toISOString() : null;
      let id = '';
      let last = cursor ?? null;
      for (;;) {
        let filter = '';
        if (at) {
          const a = encodeURIComponent(at);
          filter = id
            ? `&or=(updated_at.gt.${a},and(updated_at.eq.${a},id.gt.${encodeURIComponent(JSON.stringify(id))}))`
            : `&updated_at=gte.${a}`;
        }
        const rows = await call('GET', `/rest/v1/sync_events?select=id,deleted,data,updated_at${filter}&order=updated_at.asc,id.asc&limit=${PULL_PAGE}`);
        if (!Array.isArray(rows)) throw new Error('Cloud answered with no rows list');
        for (const r of rows) {
          if (r.deleted) deletedIds.push(r.id);
          else if (r.data && typeof r.data.id === 'string') events.push(r.data);
        }
        if (rows.length) {
          const tail = rows[rows.length - 1];
          at = tail.updated_at;
          id = tail.id;
          last = { at, id };
        }
        if (rows.length < PULL_PAGE) break;
      }
      return { events, deletedIds, cursor: last };
    },

    async remove(ids) {
      if (!ids.length) return 0;
      return Number(await call('POST', '/rest/v1/rpc/sync_delete', { ids })) || 0;
    },

    /** Deletes every event under this key. Returns the clear time (ms). */
    async clear() {
      return Date.parse(await call('POST', '/rest/v1/rpc/sync_clear', {}));
    },

    /**
     * Facts about the whole history under this key: when "clear all" last ran (ms or null) and
     * which site-history streams some browser has read to the end.
     */
    async account() {
      const rows = await call('GET', '/rest/v1/sync_accounts?select=cleared_at,history_complete');
      const row = Array.isArray(rows) && rows[0] ? rows[0] : {};
      const at = row.cleared_at ? Date.parse(row.cleared_at) : NaN;
      return {
        clearedAt: Number.isFinite(at) ? at : null,
        complete: Array.isArray(row.history_complete) ? row.history_complete.filter((s) => typeof s === 'string') : [],
      };
    },

    /** Record that a site-history stream was read to the end. */
    async markComplete(stream) {
      return call('POST', '/rest/v1/rpc/sync_mark_complete', { stream });
    },
  };
}
