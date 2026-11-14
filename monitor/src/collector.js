// Collector: samples other players' public history to measure how profitable play on the site is
// right now. Signed in to the account the user set aside for it (see site.js).
//
// One request at a time, at least `gapMs` apart (default 8 s, about 450 requests an hour). Each turn
// does the most urgent thing that is due:
//   1. GET /api/game/cases        every 6 h      case prices
//   2. GET /api/live-drops        every 30 s     finds active players (it shows their big wins)
//   3. GET /api/statistics        every 60 s     site-wide counters of case opens and upgrades
//   4. first look at a found player: the latest page of their upgrades and case drops
//   5. follow: one of the two lists of a followed player at most every 90 s, for new rows
//   6. when nothing above is due:
//      - revisit: a known player who is no longer followed, for new rows. Players who played in the
//        last 30 min are checked every 10 min (and before anything else here), then every 30 min,
//        2 h or 6 h the longer ago they played. So players who play small, and rarely reach the drop
//        board, stay in the sample once the board has shown them.
//      - history: older pages of a player's lists, back to `historyMs` (7 days), at most `deepPages` each
//      (alternating with revisits that are not urgent)
// HTTP 429 pauses everything for 5 minutes, doubling up to 30. HTTP 401 (login refused) and 403 (blocked)
// stop the collector. Other errors are retried; a run of them is reported.
//
// Selection bias: players are found because the feed showed one of their big wins. Those wins
// (the items the feed showed for that player) are left out of their history, or every sampled player
// would start with a big win. History rows are marked `back`. A player is followed for a fixed time
// after being found, the same for winners and losers.
//
// Page size: the site's own pages ask for 50 rows. The collector asks for `tryPageSize` (100) once and
// keeps it if the site sends more than 50 rows, or falls back to 50.

import { CasePrices, upgradeRows, caseRows, feedDrops, volumeSample } from './parse.js';

const HOUR = 60 * 60 * 1000;

export const DEFAULTS = {
  gapMs: 8000,
  feedEveryMs: 30_000,
  statsEveryMs: 60_000,
  casesEveryMs: 6 * HOUR,
  profileEveryMs: 90 * 1000, // one list per turn, so each list about every 3 min
  watchMs: 2 * HOUR, // follow time after a player is found
  idleDropMs: 40 * 60 * 1000, // stop following a player with no new rows for this long
  historyMs: 7 * 24 * HOUR, // history rows kept back to this age
  deepPages: 10, // older pages read per list per player, after the first
  maxDeepJobs: 300,
  // Known players are checked again for new rows, more often the more recently they played:
  revisitHotMs: 10 * 60 * 1000, // played in the last `activeMs`: they are on the site now
  revisitWarmMs: 30 * 60 * 1000, // played in the last 3 hours
  revisitMs: 2 * HOUR, // played in the last day
  revisitColdMs: 6 * HOUR, // longer ago, or not seen playing yet
  activeMs: 30 * 60 * 1000,
  knownMax: 5000, // players remembered for revisits
  knownKeepMs: 14 * 24 * HOUR, // forget players neither in the feed nor seen playing for this long
  maxPlayers: 30, // followed at once
  maxQueue: 40, // found players waiting for their first look (oldest dropped first)
  backfillsPerFollow: 2,
  pageSize: 50,
  tryPageSize: 100,
  maxPages: 3, // per list per follow or revisit, only while every row on a page is new
  backoffMs: 5 * 60 * 1000,
  maxBackoffMs: 30 * 60 * 1000,
  errorStreak: 5, // this many failed turns in a row are reported
};

export class HttpError extends Error {
  constructor(status, path) {
    super(`HTTP ${status} for ${path}`);
    this.status = status;
  }
}

const isHttp = (e, ...codes) => e instanceof HttpError && codes.includes(e.status);

/** Field names of an answer, one level deep (e.g. "user.lastSeen"); never values. */
export function fieldNames(body) {
  const out = [];
  const o = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  for (const [k, v] of Object.entries(o)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) for (const k2 of Object.keys(v)) out.push(`${k}.${k2}`);
    else out.push(k);
  }
  return out.slice(0, 80);
}
const STREAMS = ['upgrade', 'case'];

/**
 * @param {Object} o
 * @param {(path: string) => Promise<any>} o.getJson  same-site GET; throws HttpError on a non-2xx answer
 * @param {(id: string) => Promise<string>} o.hashUser
 * @param {(rows: any[]) => Promise<void>} o.saveRows
 * @param {(sample: any) => Promise<void>} o.saveVolume
 * @param {() => number} [o.now]
 * @param {(ms: number) => Promise<void>} [o.sleep]
 * @param {() => void} [o.onChange]  status changed
 * @param {(e: {level: 'info'|'warn'|'error', code: string, message: string}) => void} [o.onEvent]
 * @param {{known?: any[], pageSize?: number, pageProbe?: string}} [o.initial]  from exportState() of an earlier run
 * @param {Partial<typeof DEFAULTS>} [o.options]
 */
export function createCollector({ getJson, hashUser, saveRows, saveVolume, now = Date.now, sleep, onChange, onEvent, initial = {}, options = {} }) {
  const opt = { ...DEFAULTS, ...options };
  const prices = new CasePrices();
  const players = new Map(); // followed: site id -> {u, added, lastPolled, lastRow, seen: {upgrade, case}, nextStream}
  const queue = []; // found, waiting for their first look: {id, skip: Set<item name>}
  const backfilled = new Map(); // site id -> when their first look ran
  const deep = []; // older history pages to read: {id, u, stream, offset, pages, skip}
  // Players seen in the feed: site id -> {seen, revisited, newest: {upgrade, case}, deep: bool}
  const known = new Map((initial.known ?? []).filter((k) => k && k.id).map((k) => [String(k.id), { seen: k.seen ?? 0, revisited: k.revisited ?? 0, newest: { upgrade: k.newest?.upgrade ?? 0, case: k.newest?.case ?? 0 }, deep: !!k.deep }]));
  // 'unknown' until a page shows what the site allows; then 'ok' (larger pages work), 'capped' or 'refused'.
  let pageSize = opt.tryPageSize;
  let pageProbe = 'unknown';
  if (opt.tryPageSize <= opt.pageSize) {
    pageSize = opt.pageSize;
    pageProbe = 'off';
  } else if (initial.pageProbe === 'ok') {
    pageSize = initial.pageSize > opt.pageSize ? initial.pageSize : opt.tryPageSize;
    pageProbe = 'ok';
  } else if (initial.pageProbe === 'capped' || initial.pageProbe === 'refused') {
    pageSize = opt.pageSize;
    pageProbe = initial.pageProbe;
  }
  const triedSlugs = new Set();
  let profileProbed = !!initial.profileProbed;
  let running = false;
  let wake = null;
  let lastFeed = -Infinity;
  let lastStats = -Infinity;
  let lastCases = -Infinity;
  let pausedUntil = 0;
  let backoff = opt.backoffMs;
  let backfillRun = 0;
  let idleTurn = 0;
  let error = null;
  let stopReason = null;
  let errorStreak = 0;
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
  const event = (level, code, message) => {
    try {
      onEvent?.({ level, code, message });
    } catch {}
  };

  async function get(path) {
    requests.push(now());
    return getJson(path);
  }

  function trim() {
    const t = now();
    const cut = t - HOUR;
    while (requests.length && requests[0] < cut) requests.shift();
    while (counted.length && counted[0][0] < cut) counted.shift();
    for (const [id, p] of players) if (t - p.added > opt.watchMs || t - p.lastRow > opt.idleDropMs) players.delete(id);
    for (const [id, at] of backfilled) if (t - at > opt.watchMs) backfilled.delete(id);
    const last = (k) => Math.max(k.seen, lastPlayed(k));
    for (const [id, k] of known) if (t - last(k) > opt.knownKeepMs) known.delete(id);
    if (known.size > opt.knownMax) {
      const oldest = [...known].sort((a, b) => last(a[1]) - last(b[1])).slice(0, known.size - opt.knownMax);
      for (const [id] of oldest) known.delete(id);
    }
  }

  /** When a known player last played, from the newest row seen in their lists (0: not seen yet). */
  const lastPlayed = (k) => Math.max(k.newest.upgrade, k.newest.case);

  /** How long until a known player is checked again: soon if they are playing now, rarely if not. */
  function revisitEvery(k, t = now()) {
    const ago = t - lastPlayed(k);
    if (ago <= opt.activeMs) return opt.revisitHotMs;
    if (ago <= 3 * HOUR) return opt.revisitWarmMs;
    if (ago <= 24 * HOUR) return opt.revisitMs;
    return opt.revisitColdMs;
  }

  function remember(id) {
    let k = known.get(id);
    if (!k) known.set(id, (k = { seen: now(), revisited: now(), newest: { upgrade: 0, case: 0 }, deep: false }));
    k.seen = now();
    return k;
  }

  function noteNewest(id, stream, rows) {
    const k = known.get(id);
    if (!k) return;
    for (const r of rows) if (r.ts > k.newest[stream]) k.newest[stream] = r.ts;
  }

  async function readFeed() {
    lastFeed = now();
    for (const [id, skip] of feedDrops(await get('/api/live-drops'))) {
      remember(id);
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
        if (isHttp(e, 429, 401, 403)) throw e;
      }
    }
  }

  function settlePageSize(size, probe) {
    pageSize = size;
    pageProbe = probe;
    event('info', 'page-size', probe === 'ok' ? `The site sends up to ${size} rows per page; using ${size}.` : `The site sends at most ${opt.pageSize} rows per page; using ${opt.pageSize}.`);
  }

  /** One page of one list -> {parse(extra) -> rows, len, full}. Learns missing case prices first. */
  async function readPage(id, u, stream, offset) {
    const enc = encodeURIComponent(id);
    const base = stream === 'upgrade' ? `/api/game/upgrade/public-history/${enc}` : `/api/users/${enc}/inventory/history`;
    const size = pageSize;
    let body;
    try {
      body = await get(`${base}?limit=${size}&offset=${offset}`);
    } catch (e) {
      if (isHttp(e, 400, 422) && size > opt.pageSize) {
        settlePageSize(opt.pageSize, 'refused');
        return readPage(id, u, stream, offset);
      }
      throw e;
    }
    const len = Array.isArray(body?.items) ? body.items.length : 0;
    if (pageProbe === 'unknown' && size > opt.pageSize) {
      if (len > opt.pageSize) settlePageSize(size, 'ok');
      else if (len === opt.pageSize) settlePageSize(opt.pageSize, 'capped');
    }
    const full = len >= pageSize && len > 0;
    if (stream === 'upgrade') return { parse: (extra) => upgradeRows(body, u, extra), len, full };
    const unknownSlugs = new Set();
    caseRows(body, prices, u, { unknownSlugs });
    if (unknownSlugs.size) await learnCases(unknownSlugs);
    return { parse: (extra) => caseRows(body, prices, u, extra), len, full };
  }

  function record(rows, back) {
    if (rows.length) counted.push([now(), rows.length, back]);
  }

  async function save(rows, back) {
    if (!rows.length) return;
    record(rows, back);
    await saveRows(rows);
  }

  /** A found player's latest page of each list, minus the feed wins that found them. Then follow them if there is room. */
  async function backfill({ id, skip }) {
    const u = await hashUser(id);
    const k = remember(id);
    const seen = { upgrade: new Set(), case: new Set() };
    const cut = now() - opt.historyMs;
    for (const stream of STREAMS) {
      const { parse, len, full } = await readPage(id, u, stream, 0);
      // Every row on the page is "seen", skipped ones too, so following never counts them later.
      const all = parse({});
      for (const r of all) seen[stream].add(r.id);
      noteNewest(id, stream, all);
      const keep = parse({ skip, back: true }).filter((r) => r.ts >= cut);
      await save(keep, true);
      // Older pages later, when nothing else is due; only once per player.
      const oldest = all.reduce((m, r) => Math.min(m, r.ts), Infinity);
      if (!k.deep && full && oldest >= cut && opt.deepPages > 0) {
        deep.push({ id, u, stream, offset: len, pages: 0, skip });
        if (deep.length > opt.maxDeepJobs) deep.shift();
      }
      if (stream === 'upgrade') await doSleep(opt.gapMs);
    }
    k.deep = true;
    backfilled.set(id, now());
    if (players.size < opt.maxPlayers) players.set(id, { u, added: now(), lastPolled: now(), lastRow: now(), seen, nextStream: 'upgrade' });
  }

  /** One older page of a player's list. */
  async function readDeep() {
    const job = deep.shift();
    const cut = now() - opt.historyMs;
    const { parse, len, full } = await readPage(job.id, job.u, job.stream, job.offset);
    const all = parse({});
    await save(parse({ skip: job.skip, back: true }).filter((r) => r.ts >= cut), true);
    const oldest = all.reduce((m, r) => Math.min(m, r.ts), Infinity);
    if (full && oldest >= cut && job.pages + 1 < opt.deepPages) deep.push({ ...job, offset: job.offset + len, pages: job.pages + 1 });
  }

  /** The known player most overdue for a check, with whether they are playing now; null if none is due. */
  function dueRevisit() {
    const t = now();
    let pick = null;
    for (const [id, k] of known) {
      if (players.has(id) || backfilled.has(id)) continue;
      const due = k.revisited + revisitEvery(k, t);
      if (due > t) continue;
      const hot = t - lastPlayed(k) <= opt.activeMs;
      // Players on the site now first, then the most overdue.
      if (!pick || (hot && !pick.hot) || (hot === pick.hot && due < pick.due)) pick = { id, k, due, hot };
    }
    return pick;
  }

  /**
   * New rows of a known player who is not followed: this is how players who play small (and never
   * reach the drop board) stay in the sample once they have been seen there.
   */
  async function revisit(pick) {
    const { id, k } = pick;
    const t = now();
    k.revisited = t;
    const u = await hashUser(id);
    for (const stream of STREAMS) {
      // Rows newer than the last one seen are new play; with nothing seen yet, it is history.
      const since = k.newest[stream] || t - opt.historyMs;
      const back = !k.newest[stream];
      for (let page = 0, offset = 0; page < opt.maxPages; page++) {
        const { parse, len, full } = await readPage(id, u, stream, offset);
        const rows = parse({ back });
        noteNewest(id, stream, rows);
        const fresh = rows.filter((r) => r.ts > since);
        await save(fresh, back);
        if (fresh.length < rows.length || !full) break;
        offset += len;
        await doSleep(opt.gapMs);
      }
      if (stream === 'upgrade') await doSleep(opt.gapMs);
    }
    return true;
  }

  /**
   * Once per installation: which fields a player's profile has (names only, no values), in case the
   * site shows when a player was last online. Reported as an event; errors are reported, not fatal.
   */
  async function probeProfile() {
    profileProbed = true;
    const id = [...known.keys()][0];
    const fields = [];
    for (const path of [`/api/users/${encodeURIComponent(id)}`, `/api/users/${encodeURIComponent(id)}/stats`]) {
      try {
        const body = await get(path);
        fields.push(`${path.replace(id, '{id}')}: ${fieldNames(body).join(', ') || '(empty)'}`);
      } catch (e) {
        if (isHttp(e, 429, 401)) throw e;
        fields.push(`${path.replace(id, '{id}')}: ${e?.message ?? e}`);
      }
      await doSleep(opt.gapMs);
    }
    event('info', 'profile-fields', `Profile fields (names only): ${fields.join(' | ')}`.slice(0, 1000));
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
    for (let page = 0, offset = 0; page < opt.maxPages; page++) {
      const { parse, len, full } = await readPage(id, p.u, stream, offset);
      const rows = parse({});
      const news = rows.filter((r) => !seen.has(r.id));
      for (const r of rows) seen.add(r.id);
      noteNewest(id, stream, rows);
      fresh.push(...news);
      // Keep reading only while the whole page is new (more than a page since the last read).
      if (news.length < rows.length || !full) break;
      offset += len;
    }
    p.nextStream = stream === 'upgrade' ? 'case' : 'upgrade';
    p.lastPolled = now();
    if (fresh.length) {
      p.lastRow = now();
      await save(fresh, false);
    }
    return true;
  }

  async function idle() {
    if (!profileProbed && known.size) return probeProfile();
    const due = dueRevisit();
    // Players on the site now come first: they are what "right now" is made of.
    if (due?.hot) return revisit(due);
    // Otherwise alternate between older history and revisits, so neither starves the other.
    const order = idleTurn++ % 2 === 0 ? ['deep', 'revisit'] : ['revisit', 'deep'];
    for (const what of order) {
      if (what === 'deep' && deep.length) return readDeep();
      if (what === 'revisit' && due) return revisit(due);
    }
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
    return idle();
  }

  async function loop() {
    while (running) {
      trim();
      const t = now();
      if (pausedUntil > t) {
        await doSleep(Math.min(pausedUntil - t, 60_000));
        continue;
      }
      const before = requests.length;
      try {
        await step();
        // A turn with nothing to do proves nothing: only a turn that made a request ends a run of errors.
        if (requests.length > before) {
          backoff = opt.backoffMs;
          if (errorStreak >= opt.errorStreak) event('info', 'recovered', `Requests work again after ${errorStreak} failed turns in a row.`);
          errorStreak = 0;
          error = null;
        }
      } catch (e) {
        if (isHttp(e, 429)) {
          pausedUntil = now() + backoff;
          error = `The site asked to slow down (HTTP 429). Paused for ${Math.round(backoff / 60000)} min.`;
          event(backoff >= opt.maxBackoffMs ? 'error' : 'warn', 'paused', error);
          backoff = Math.min(backoff * 2, opt.maxBackoffMs);
        } else if (isHttp(e, 401)) {
          error = 'The site refused the account’s login (HTTP 401): the refresh token expired or was revoked. Collector stopped. Put a new CASER_REFRESH_TOKEN in .env and restart.';
          stopReason = 'login';
          running = false;
          event('error', 'login', error);
        } else if (isHttp(e, 403)) {
          error = 'The site refused the request (HTTP 403 or a challenge page): the account or this server may be blocked. Collector stopped. Do not work around it.';
          stopReason = 'blocked';
          running = false;
          event('error', 'blocked', error);
        } else {
          errorStreak++;
          error = String(e?.message ?? e);
          if (errorStreak === opt.errorStreak) event('warn', 'errors', `${errorStreak} failed turns in a row. Last error: ${error}`);
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
      stopReason = null;
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
    /** What a restart should carry over (see `initial`). Holds real site ids: keep it local. */
    exportState() {
      return {
        known: [...known].map(([id, k]) => ({ id, seen: k.seen, revisited: k.revisited, newest: k.newest, deep: k.deep })),
        pageSize,
        pageProbe,
        profileProbed,
      };
    },
    status() {
      trim();
      return {
        running,
        stopReason,
        players: players.size,
        queued: queue.length,
        known: known.size,
        // Known players seen playing in the last `activeMs`, found through the feed or a revisit.
        activeNow: [...known.values()].filter((k) => now() - lastPlayed(k) <= opt.activeMs).length,
        revisitsDue: [...known].filter(([id, k]) => !players.has(id) && !backfilled.has(id) && k.revisited + revisitEvery(k) <= now()).length,
        historyPages: deep.length,
        recentPlayers: backfilled.size, // players first looked at in the last watchMs
        requestsLastHour: requests.length,
        rowsLastHour: counted.reduce((s, [, n]) => s + n, 0),
        backRowsLastHour: counted.reduce((s, [, n, b]) => s + (b ? n : 0), 0),
        pausedUntil: pausedUntil > now() ? pausedUntil : null,
        errorStreak,
        pageSize,
        error,
      };
    },
  };
}
