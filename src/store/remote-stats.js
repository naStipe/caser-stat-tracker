// Statistics computed by the stats server (supabase/functions/stats, code in src/server/views.js).
//
// get(name, ...args) answers at once from what is cached and asks the server for whatever is missing
// or out of date. Every get() made in one render goes out as one request. When answers arrive, the
// subscribers are told, and the next render finds them in the cache.
//
// invalidate() marks every cached answer as old (call it when events were added). An old answer is
// still returned until the new one arrives, so the dashboard does not flash "loading" on each refresh.

import { CLOUD_URL, CLOUD_KEY } from './cloud-config.js';
import { encode, decode } from '../server/codec.js';

const BATCH_DELAY_MS = 20;
const MAX_VIEWS = 40;

/**
 * @param {Object} o
 * @param {(req: {method: string, url: string, headers: Object, body?: string, timeout?: number}) => Promise<{status: number, json: any}>} o.request
 * @param {() => string|null} o.getKey  the sync key
 * @param {() => {sel: string|null, legacy: string|null}} o.getAccount  the account selection to compute for
 * @param {string} [o.url]
 * @param {string} [o.apiKey]
 */
export function createRemoteStats({ request, getKey, getAccount, url = CLOUD_URL, apiKey = CLOUD_KEY }) {
  /** queryKey -> {value?, error?, gen} */
  const cache = new Map();
  /** queryKey -> {name, args, acc} waiting for the next request */
  const queue = new Map();
  /** queryKey -> gen of the request that is out */
  const inFlight = new Map();
  const subs = new Set();
  let gen = 1;
  let timer = null;
  let version = null;
  let lastError = null;

  const accountNow = () => {
    const a = (typeof getAccount === 'function' && getAccount()) || {};
    return { sel: a.sel ?? null, legacy: a.legacy ?? null };
  };
  const keyOf = (acc, name, args) => JSON.stringify([acc.sel, acc.legacy, name, encode(args)]);

  function notify() {
    for (const fn of subs) {
      try {
        fn();
      } catch (err) {
        console.warn('[caser-tracker] stats subscriber failed', err);
      }
    }
  }

  /** One request to the server. Returns its JSON ({version, results}); throws on any failure. */
  async function send(acc, views) {
    const key = getKey();
    if (!key) throw new Error('No sync key yet');
    const res = await request({
      method: 'POST',
      url: `${url}/functions/v1/stats`,
      headers: { apikey: apiKey, 'x-sync-key': key, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ account: acc, views: views.map((v) => ({ name: v.name, args: encode(v.args) })) }),
      timeout: 60000,
    });
    if (res.status < 200 || res.status >= 300 || !Array.isArray(res.json?.results)) {
      const msg = res.json && (res.json.error || res.json.message);
      throw new Error(`Stats server answered ${res.status}${msg ? `: ${msg}` : ''}`);
    }
    version = res.json.version ?? version;
    lastError = null;
    return res.json;
  }

  // One request at a time: parallel requests after new data would each make the server load the
  // whole history. Views asked for while one is out go in the next request.
  let busy = false;
  async function flush() {
    timer = null;
    if (busy) return;
    const batch = [...queue].slice(0, MAX_VIEWS);
    if (!batch.length) return;
    for (const [k] of batch) queue.delete(k);
    busy = true;
    const sentGen = gen;
    for (const [k] of batch) inFlight.set(k, sentGen);

    // One request per account selection (normally there is only one).
    const byAcc = new Map();
    for (const [k, v] of batch) {
      const ak = JSON.stringify(v.acc);
      if (!byAcc.has(ak)) byAcc.set(ak, []);
      byAcc.get(ak).push([k, v]);
    }
    for (const items of byAcc.values()) {
      try {
        const json = await send(items[0][1].acc, items.map(([, v]) => v));
        json.results.forEach((r, i) => {
          const [k] = items[i];
          const entry = r && r.ok ? { value: decode(r.value) } : { error: new Error(r?.error || 'No answer') };
          // An invalidate() while this was out makes the answer old again.
          cache.set(k, { ...entry, gen: sentGen });
        });
      } catch (err) {
        lastError = err;
        for (const [k] of items) {
          const old = cache.get(k);
          // Keep an older answer on screen; the error shows separately (lastError).
          if (old && 'value' in old) cache.set(k, { ...old, gen: sentGen, failed: true });
          else cache.set(k, { error: err, gen: sentGen });
        }
      } finally {
        for (const [k] of items) if (inFlight.get(k) === sentGen) inFlight.delete(k);
      }
    }
    busy = false;
    notify();
    if (queue.size && !timer) timer = setTimeout(flush, 0);
  }

  function want(k, name, args, acc) {
    if (queue.has(k) || inFlight.get(k) === gen) return;
    queue.set(k, { name, args, acc });
    if (!timer) timer = setTimeout(flush, BATCH_DELAY_MS);
  }

  return {
    /**
     * @returns {{value: any, stale?: boolean} | {error: Error} | {loading: true}}
     */
    get(name, ...args) {
      const acc = accountNow();
      const k = keyOf(acc, name, args);
      const entry = cache.get(k);
      if (!entry || entry.gen < gen) want(k, name, args, acc);
      if (!entry) return { loading: true };
      if ('value' in entry) return { value: entry.value, stale: entry.gen < gen };
      return { error: entry.error };
    },

    /**
     * One fresh answer, straight from the server (not batched, not cached). Throws on failure.
     * For code that needs the current value before it goes on, like the site-history import.
     */
    async fetch(name, ...args) {
      const json = await send(accountNow(), [{ name, args }]);
      const r = json.results[0];
      if (!r || !r.ok) throw new Error(r?.error || 'No answer');
      return decode(r.value);
    },

    /** Every cached answer is old from now on: the next get() of each asks the server again. */
    invalidate() {
      gen++;
    },

    /** Calls fn whenever answers arrive. Returns a function that stops it. */
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },

    /** The last network or server error, null after a good answer. */
    lastError: () => lastError,
    version: () => version,
    /** Drop everything (another sync key, or the history was cleared). */
    reset() {
      cache.clear();
      queue.clear();
      gen++;
      version = null;
    },
  };
}
