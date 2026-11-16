// The stats server, run in the page over a local event list. For the preview pages in docs/ and
// for tests: pass the returned function as `request` to createRemoteStats.
import { handle } from './views.js';

/**
 * @param {() => any[] | Promise<any[]>} getEvents  the whole history
 * @returns {(req: {body: string}) => Promise<{status: number, json: any}>}
 */
export function localStatsRequest(getEvents) {
  const cache = new Map();
  let rev = 0;
  let last = null;
  return async (req) => {
    const events = await getEvents();
    // A new list (or a new length) counts as new data, like a new version on the server.
    if (events !== last) {
      last = events;
      rev++;
    }
    try {
      const json = await handle(JSON.parse(req.body), {
        version: async () => `local-${rev}-${events.length}`,
        cacheGet: async (keys, v) => new Map(keys.filter((k) => cache.get(k)?.v === v).map((k) => [k, cache.get(k).value])),
        cachePut: async (v, entries) => entries.forEach((e) => cache.set(e.key, { v, value: e.value })),
        loadEvents: async () => events,
        markDeleted: async () => {},
      });
      return { status: 200, json: JSON.parse(JSON.stringify(json)) };
    } catch (err) {
      return { status: 400, json: { error: String(err?.message || err) } };
    }
  };
}
