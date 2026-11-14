// Collector: samples other players' public history to measure how profitable play on the site is
// right now. Signed in to the account the user set aside for it (see site.js).
//
// One request at a time, at least `gapMs` apart (default 8 s, about 450 requests an hour):
//   GET /api/live-drops          every 30 s   finds active players (it shows their big wins)
//   GET /api/statistics          every 60 s   site-wide counters of case opens and upgrades
//   GET /api/game/cases          once (and every 6 h) case prices
//   GET /api/game/upgrade/public-history/{id}, GET /api/users/{id}/inventory/history
//     backfill: a newly found player's latest page of each (their recent upgrades and case drops),
//     then follow: one of the two per followed player at most every 90 s, for new rows only.
// HTTP 429 pauses everything for 5 minutes, doubling up to 30. HTTP 401/403 stops the collector.
//
// Selection bias: players are found because the feed showed one of their big wins. Those wins
// (the items the feed showed for that player) are left out of the backfill, or every sampled player
// would start with a big win. What remains of their recent history is counted and marked `back`.
// A player is followed for a fixed time after being found, the same for winners and losers.

import { CasePrices, upgradeRows, caseRows, feedDrops, volumeSample } from './parse.js';

export const DEFAULTS = {
  gapMs: 8000,
  feedEveryMs: 30_000,
  statsEveryMs: 60_000,
  casesEveryMs: 6 * 60 * 60 * 1000,
  profileEveryMs: 90 * 1000, // one stream per turn, so each stream about every 3 min
  watchMs: 2 * 60 * 60 * 1000, // follow time after a player is found; no second backfill within it
  idleDropMs: 40 * 60 * 1000, // stop following a player with no new rows for this long
  backfillMs: 24 * 60 * 60 * 1000, // backfill keeps rows this recent
  maxPlayers: 30, // followed at once
  maxQueue: 40, // found players waiting for their backfill (oldest dropped first)
  backfillsPerFollow: 2, // when both are waiting: this many backfills, then one follow poll
  pageSize: 50,
  maxPages: 3, // per stream per follow poll, only when every row on a page is new
  backoffMs: 5 * 60 * 1000,
  maxBackoffMs: 30 * 60 * 1000,
};

export class HttpError extends Error {
  constructor(status, path) {
    super(`HTTP ${status} for ${path}`);
    this.status = status;
  }
}

const fatal = (e) => e instanceof HttpError && (e.status === 429 || e.status === 401 || e.status === 403);

/**
 * @param {Object} o
 * @param {(path: string) => Promise<any>} o.getJson  same-site GET; throws HttpError on a non-2xx answer
 * @param {(id: string) => Promise<string>} o.hashUser
 * @param {(rows: any[]) => Promise<void>} o.saveRows
 * @param {(sample: any) => Promise<void>} o.saveVolume
 * @param {() => number} [o.now]
 * @param {(ms: number) => Promise<void>} [o.sleep]
 * @param {() => void} [o.onChange]  status changed (for the panel)
 * @param {Partial<typeof DEFAULTS>} [o.options]
 */
export function createCollector({ getJson, hashUser, saveRows, saveVolume, now = Date.now, sleep, onChange, options = {} }) {
  const opt = { ...DEFAULTS, ...options };
  const prices = new CasePrices();
  const players = new Map(); // followed: site id -> {u, added, lastPolled, lastRow, seen: {upgrade, case}, nextStream}
  const queue = []; // found, waiting for backfill: {id, skip: Set<item name>}
  const backfilled = new Map(); // site id -> when its backfill ran
  const triedSlugs = new Set();
  let running = false;
  let wake = null;
  let lastFeed = -Infinity;
  let lastStats = -Infinity;
  let lastCases = -Infinity;
  let pausedUntil = 0;
  let backoff = opt.backoffMs;
  let backfillRun = 0;
  let error = null;
  const requests = []; // timestamps, last hour
  const counted = []; // [ts, n, back] rows saved, last hour
  const doSleep =
    sleep ??
    ((ms) =>
      new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        wake = () => {
          clearTimeout(t);
          resolve();
        };
      }));

  const changed = () => {
    try {
      onChange?.();
    } catch {}
  };

  async function get(path) {
    requests.push(now());
    return getJson(path);
  }

  function trim() {
    const t = now();
    const cut = t - 60 * 60 * 1000;
    while (requests.length && requests[0] < cut) requests.shift();
    while (counted.length && counted[0][0] < cut) counted.shift();
    for (const [id, p] of players) if (t - p.added > opt.watchMs || t - p.lastRow > opt.idleDropMs) players.delete(id);
    for (const [id, at] of backfilled) if (t - at > opt.watchMs) backfilled.delete(id);
  }

  async function readFeed() {
    lastFeed = now();
    for (const [id, skip] of feedDrops(await get('/api/live-drops'))) {
      if (players.has(id) || backfilled.has(id)) continue;
      const waiting = queue.find((q) => q.id === id);
      if (waiting) {
        for (const n of skip) waiting.skip.add(n);
        continue;
      }
      queue.push({ id, skip });
      if (queue.length > opt.maxQueue) queue.shift();
    }
  }

  async function readStats() {
    lastStats = now();
    const s = volumeSample(await get('/api/statistics'), now());
    if (s) await saveVolume(s);
  }

  async function readCases() {
    lastCases = now();
    prices.learnList(await get('/api/game/cases'));
  }

  /** Loads prices of cases seen in drops but missing from the case list (at most 3 per page). */
  async function learnCases(slugs) {
    const missing = [...slugs].filter((s) => !triedSlugs.has(s)).slice(0, 3);
    for (const slug of missing) {
      triedSlugs.add(slug);
      try {
        prices.learnOne(await get(`/api/game/cases/${encodeURIComponent(slug)}`));
      } catch (e) {
        if (fatal(e)) throw e;
      }
    }
    return missing.length > 0;
  }

  /** One page of one stream -> {parse(extra) -> rows, pageLen}. Learns missing case prices first. */
  async function readPage(id, u, stream, page) {
    const enc = encodeURIComponent(id);
    const base = stream === 'upgrade' ? `/api/game/upgrade/public-history/${enc}` : `/api/users/${enc}/inventory/history`;
    const body = await get(`${base}?limit=${opt.pageSize}&offset=${page * opt.pageSize}`);
    const pageLen = Array.isArray(body?.items) ? body.items.length : 0;
    if (stream === 'upgrade') return { parse: (extra) => upgradeRows(body, u, extra), pageLen };
    const unknownSlugs = new Set();
    caseRows(body, prices, u, { unknownSlugs });
    if (unknownSlugs.size) await learnCases(unknownSlugs);
    return { parse: (extra) => caseRows(body, prices, u, extra), pageLen };
  }

  function record(rows, back) {
    if (rows.length) counted.push([now(), rows.length, back]);
  }

  /** A found player's recent history, minus the feed wins that found them. Then follow them if there is room. */
  async function backfill({ id, skip }) {
    const u = await hashUser(id);
    const seen = { upgrade: new Set(), case: new Set() };
    const cut = now() - opt.backfillMs;
    const keep = [];
    for (const stream of ['upgrade', 'case']) {
      const { parse } = await readPage(id, u, stream, 0);
      // Every row on the page is "seen", skipped ones too, so following never counts them later.
      for (const r of parse({})) seen[stream].add(r.id);
      keep.push(...parse({ skip, back: true }).filter((r) => r.ts >= cut));
      if (stream === 'upgrade') await doSleep(opt.gapMs);
    }
    backfilled.set(id, now());
    if (keep.length) {
      record(keep, true);
      await saveRows(keep);
    }
    if (players.size < opt.maxPlayers) players.set(id, { u, added: now(), lastPolled: now(), lastRow: now(), seen, nextStream: 'upgrade' });
  }

  async function follow() {
    const t = now();
    let pick = null;
    for (const [id, p] of players) {
      if (t - p.lastPolled < opt.profileEveryMs) continue;
      if (!pick || p.lastPolled < pick[1].lastPolled) pick = [id, p];
    }
    if (!pick) return false;
    const [id, p] = pick;
    const stream = p.nextStream;
    const seen = p.seen[stream];
    const fresh = [];
    for (let page = 0; page < opt.maxPages; page++) {
      const { parse, pageLen } = await readPage(id, p.u, stream, page);
      const rows = parse({});
      const news = rows.filter((r) => !seen.has(r.id));
      for (const r of rows) seen.add(r.id);
      fresh.push(...news);
      // Keep reading only while the whole page is new (more than a page since the last read).
      if (news.length < rows.length || pageLen < opt.pageSize) break;
    }
    p.nextStream = stream === 'upgrade' ? 'case' : 'upgrade';
    p.lastPolled = now();
    if (fresh.length) {
      p.lastRow = now();
      record(fresh, false);
      await saveRows(fresh);
    }
    return true;
  }

  async function step() {
    const t = now();
    if (t - lastCases >= opt.casesEveryMs) return readCases();
    if (t - lastFeed >= opt.feedEveryMs) return readFeed();
    if (t - lastStats >= opt.statsEveryMs) return readStats();
    if (queue.length && backfillRun < opt.backfillsPerFollow) {
      backfillRun++;
      return backfill(queue.shift());
    }
    backfillRun = 0;
    if (await follow()) return;
    if (queue.length) return backfill(queue.shift());
  }

  async function loop() {
    while (running) {
      trim();
      const t = now();
      if (pausedUntil > t) {
        await doSleep(Math.min(pausedUntil - t, 60_000));
        continue;
      }
      try {
        await step();
        backoff = opt.backoffMs;
        error = null;
      } catch (e) {
        if (e instanceof HttpError && e.status === 429) {
          pausedUntil = now() + backoff;
          error = `The site asked to slow down (HTTP 429). Paused for ${Math.round(backoff / 60000)} min.`;
          backoff = Math.min(backoff * 2, opt.maxBackoffMs);
        } else if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
          error = 'The site refused the request (signed out?). Collector stopped.';
          running = false;
        } else {
          error = String(e?.message ?? e);
        }
      }
      changed();
      if (running) await doSleep(opt.gapMs);
    }
    changed();
  }

  let loopPromise = null;
  return {
    start() {
      if (running) return loopPromise;
      running = true;
      error = null;
      loopPromise = loop();
      changed();
      return loopPromise;
    },
    stop() {
      running = false;
      wake?.();
      changed();
      return loopPromise;
    },
    status() {
      trim();
      return {
        running,
        players: players.size,
        queued: queue.length,
        recentPlayers: backfilled.size, // players whose history was read in the last watchMs
        requestsLastHour: requests.length,
        rowsLastHour: counted.reduce((s, [, n]) => s + n, 0),
        backRowsLastHour: counted.reduce((s, [, n, b]) => s + (b ? n : 0), 0),
        pausedUntil: pausedUntil > now() ? pausedUntil : null,
        error,
      };
    },
  };
}
