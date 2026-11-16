// Collector: samples other players' public history to measure how profitable play on the site is
// right now. Signed in to the account the user set aside for it (see site.js).
//
// One request at a time, at least `gapMs` apart (default 8 s, about 450 requests an hour). Each turn
// first does what is due on a clock:
//   GET /api/game/cases        every 6 h      case prices
//   GET /api/live-drops        every 30-90 s  finds active players (it shows their big wins). It holds the
//                                             last 20 big drops and turns most of them over in 30 s, so
//                                             the interval follows what the feed brings: back to 30 s when
//                                             a read adds `feedBusy` or more players to the look queue (new,
//                                             or known and not looked at in the last 2 h), 1.5 times longer
//                                             after a read that adds none, up to `feedMaxMs`.
//                                             Each read also counts the colours of the drops it has not
//                                             seen before (saveFeed), for the drop-line chart.
//   GET /api/statistics        every 60 s     site-wide counters of case opens and upgrades
// Otherwise the turn goes to the next kind of work in `turns`, a fixed rotation, so each kind gets its
// share of the requests even when another always has work (a kind with nothing to do passes its turn on):
//   look     first look at a found player: the latest page of their upgrades and case drops
//   follow   one of the two lists of a followed player at most every 90 s, for new rows
//   hot      revisit a known player who played in the last 30 min (checked every 10 min)
//   revisit  any known player who is due: every 10 min, 30 min, 2 h, 6 h or 24 h the longer ago they
//            played. So players who play small, and rarely reach the drop board, stay in the sample once
//            the board has shown them. The most overdue for their tier go first.
//            A player who is not playing now is first checked through their counters
//            (/api/users/{id}/stats: upgradesMade, casesOpened), one request for both lists; a list is
//            read only when its counter moved. The first counter check of a player only sets the base.
//   history  older pages of a known player's lists, back to `historyMs` (7 days), at most `deepPages`
//            each. Where each player's history stands is kept across restarts.
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

import { CasePrices, upgradeRows, caseRows, feedDrops, feedItems, feedSample, volumeSample, caseSnap, hitItems } from './parse.js';

const HOUR = 60 * 60 * 1000;

export const DEFAULTS = {
  gapMs: 8000,
  feedEveryMs: 30_000, // shortest feed interval
  feedMaxMs: 90_000, // longest, while the feed shows only players already being looked at
  feedBusy: 2, // a read that adds this many players to the look queue sets the shortest interval
  statsEveryMs: 60_000,
  casesEveryMs: 6 * HOUR,
  watchEveryMs: 5 * 60 * 1000, // watched cases: their page (opens and chances) read this often
  rescanPages: 20, // the one-time re-read of case lists: pages per player at most
  fetchCheckMs: 30_000, // how often the dashboard's player reads are looked for
  fetchPages: 100, // a requested player's case list: pages at most
  fetchKeepMs: 9 * 24 * HOUR, // and rows back to this age (the raw rows' retention)
  profileEveryMs: 90 * 1000, // one list per turn, so each list about every 3 min
  watchMs: 2 * HOUR, // follow time after a player is found
  idleDropMs: 40 * 60 * 1000, // stop following a player with no new rows for this long
  historyMs: 7 * 24 * HOUR, // history rows kept back to this age
  deepPages: 10, // older pages read per list per player, after the first
  // Known players are checked again for new rows, more often the more recently they played:
  revisitHotMs: 10 * 60 * 1000, // played in the last `activeMs`: they are on the site now
  revisitWarmMs: 30 * 60 * 1000, // played in the last 3 hours
  revisitMs: 2 * HOUR, // played in the last day
  revisitColdMs: 6 * HOUR, // played in the last `staleAfterMs`
  revisitStaleMs: 24 * HOUR, // longer ago, or not seen playing yet
  staleAfterMs: 3 * 24 * HOUR,
  activeMs: 30 * 60 * 1000,
  counterChecks: true, // check players who are not playing now through their counters first
  counterSlackMs: 60_000, // rows this close to a counter check are not counted as missed by it
  knownMax: 20000, // players remembered for revisits (players never seen playing are dropped first)
  knownKeepMs: 14 * 24 * HOUR, // forget players neither in the feed nor seen playing for this long
  maxPlayers: 30, // followed at once
  maxQueue: 40, // found players waiting for their first look (oldest dropped first)
  // Rotation of work after the clocked reads: a quarter each for history and first looks, the rest
  // for new rows of players who play now.
  turns: ['look', 'follow', 'hot', 'history', 'look', 'follow', 'revisit', 'history'],
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
// One-time re-read of case lists. Before 16 November 2026 every open of a custom case (made by a player) was dropped,
// because its price was asked only from the official endpoint. Known players who opened cases in the last
// `historyMs` get their case list read again, most recent first, keeping only rows of cases outside the site's
// case list. Their progress is saved, so a restart continues it; a new key would start another one.
const RESCAN_KEY = 'custom-cases-2026-11-16';

const histJob = (j) => (j && Number.isFinite(j.offset) && j.offset >= 0 ? { offset: j.offset, pages: Number(j.pages) || 0 } : j === null ? null : undefined);

/** A known player from a saved state. */
function importKnown(k, t, opt) {
  const newest = { upgrade: k.newest?.upgrade ?? 0, case: k.newest?.case ?? 0 };
  let hist;
  if (k.hist && typeof k.hist === 'object') hist = { upgrade: histJob(k.hist.upgrade), case: histJob(k.hist.case) };
  else if (k.deep || newest.upgrade || newest.case) {
    // Saved before 1.4, when older pages waited in a queue that lived in memory only (and dropped jobs
    // past 300): read the history of players who played in the last 7 days again, after the first page.
    const recent = Math.max(newest.upgrade, newest.case) >= t - opt.historyMs;
    const job = () => (recent ? { offset: opt.pageSize, pages: 0 } : null);
    hist = { upgrade: job(), case: job() };
  } else hist = { upgrade: undefined, case: undefined };
  const ctr = k.ctr && Number.isFinite(k.ctr.upgrade) && Number.isFinite(k.ctr.case) ? { upgrade: k.ctr.upgrade, case: k.ctr.case } : null;
  return { seen: k.seen ?? 0, revisited: k.revisited ?? 0, newest, hist, ctr, quiet: {} };
}

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
 * @param {() => Promise<string[]>} [o.loadWatch]  slugs of the watched cases (the dashboard's case watch)
 * @param {(snap: any) => Promise<void>} [o.saveCaseSnap]  a watched case's page: total opens, price, items and chances
 * @param {(hits: any[]) => Promise<void>} [o.saveCaseHits]  drop-line drops of a watched case's items worth its price
 * @param {() => Promise<{id: number, player: string, slug: string|null}|null>} [o.nextFetch]  the oldest player read asked for from the dashboard
 * @param {(id: number, fields: any) => Promise<void>} [o.updateFetch]  progress of that read
 * @param {Partial<typeof DEFAULTS>} [o.options]
 */
export function createCollector({ getJson, hashUser, saveRows, saveVolume, saveFeed = async () => {}, loadWatch = async () => [], saveCaseSnap = async () => {}, saveCaseHits = async () => {}, nextFetch = async () => null, updateFetch = async () => {}, now = Date.now, sleep, onChange, onEvent, initial = {}, options = {} }) {
  const opt = { ...DEFAULTS, ...options };
  const prices = new CasePrices();
  const players = new Map(); // followed: site id -> {u, added, lastPolled, lastRow, seen: {upgrade, case}, nextStream}
  const queue = []; // found, waiting for their first look: {id, skip: Set<item name>}
  const backfilled = new Map(); // site id -> when their first look ran
  const skips = new Map(); // site id -> names of the feed wins that found them (kept out of their history)
  // Players seen in the feed: site id -> {seen, revisited, newest: {upgrade, case}, hist: {upgrade, case}, ctr, quiet}.
  // hist per list: undefined = not looked at yet, {offset, pages} = older pages still to read, null = done.
  // ctr: {upgrade, case} counters at the last counter check, or null. quiet per list: {at, after} when a
  // counter check found no new play, to catch counters that lag (rows read later from between the two).
  const known = new Map((initial.known ?? []).filter((k) => k && k.id).map((k) => [String(k.id), importKnown(k, now(), opt)]));
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
  // Players whose case list is read again: site id -> {offset, pages}, most recent case play first.
  const rescan = new Map();
  if (initial.rescanKey === RESCAN_KEY) {
    for (const [id, job] of initial.rescan ?? []) if (known.has(String(id)) && job && Number.isFinite(job.offset)) rescan.set(String(id), { offset: job.offset, pages: Number(job.pages) || 0 });
  } else {
    const since = now() - opt.historyMs;
    for (const [id] of [...known].filter(([, k]) => k.newest.case >= since).sort((a, b) => b[1].newest.case - a[1].newest.case)) rescan.set(id, { offset: 0, pages: 0 });
  }
  let turn = 0;
  let profileProbed = !!initial.profileProbed;
  let countersOff = !opt.counterChecks;
  let counterMisses = 0;
  let running = false;
  let wake = null;
  let lastFeed = -Infinity;
  let feedGap = opt.feedEveryMs;
  let lastFeedId = null; // newest drop number seen, for the colour counts of the drop line
  let lastFeedAt = null;
  let lastStats = -Infinity;
  let lastCases = -Infinity;
  // Case watch: slugs to read this round, and item name -> slugs of watched cases where it is worth the price.
  let lastWatch = -Infinity;
  let watched = [];
  const watchQueue = [];
  const watchHits = new Map(); // slug -> Set of item names
  // A player read asked for from the dashboard: {id, player, slug, u, offset, pages, rows, matched, oldest}.
  let fetchJob = null;
  let lastFetchCheck = -Infinity;
  let pausedUntil = 0;
  let backoff = opt.backoffMs;
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
      // Players never seen playing go first: they hold no rows, while dropping a player with rows loses the
      // site id that links those rows to later reads (their lifetime counters, revisits).
      const played = (k) => (k.newest.upgrade > 0 || k.newest.case > 0 ? 1 : 0);
      const oldest = [...known].sort((a, b) => played(a[1]) - played(b[1]) || last(a[1]) - last(b[1])).slice(0, known.size - opt.knownMax);
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
    if (ago <= opt.staleAfterMs) return opt.revisitColdMs;
    return opt.revisitStaleMs;
  }

  function remember(id) {
    let k = known.get(id);
    if (!k) known.set(id, (k = { seen: now(), revisited: now(), newest: { upgrade: 0, case: 0 }, hist: { upgrade: undefined, case: undefined }, ctr: null, quiet: {} }));
    k.seen = now();
    return k;
  }

  function noteNewest(id, stream, rows) {
    const k = known.get(id);
    if (!k) return;
    const q = k.quiet[stream];
    if (q) {
      // A counter check said "no new play", yet the list has rows from before that check.
      const missed = rows.filter((r) => r.ts > q.after && r.ts < q.at - opt.counterSlackMs).length;
      delete k.quiet[stream];
      if (missed && [1, 10, 100, 1000].includes(++counterMisses))
        event('warn', 'counters', `Counter checks missed new play ${counterMisses} time(s) (latest: ${missed} ${stream} row(s)). The counters may lag; set COUNTER_CHECKS=0 if this keeps growing.`);
    }
    for (const r of rows) if (r.ts > k.newest[stream]) k.newest[stream] = r.ts;
  }

  async function readFeed() {
    lastFeed = now();
    let added = 0;
    const body = await get('/api/live-drops');
    const items = feedItems(body);
    if (items.length) {
      await saveFeed(feedSample(items, { ts: lastFeed, lastId: lastFeedId, lastAt: lastFeedAt }));
      lastFeedId = items[0].id; // also when the numbers went backwards: counting starts over from here
      lastFeedAt = lastFeed;
    }
    // Drops of a watched case's valuable items (case drops only: an upgrade has a chance). The drop number keeps
    // a drop seen in two reads from counting twice.
    const hits = [];
    for (const d of items) {
      if (d.up || !d.name) continue;
      for (const [slug, names] of watchHits) if (names.has(d.name)) hits.push({ slug, dropId: d.id, ts: lastFeed, item: d.name, price: d.price });
    }
    if (hits.length) await saveCaseHits(hits);
    for (const [id, skip] of feedDrops(body)) {
      remember(id);
      if (players.has(id) || backfilled.has(id)) continue;
      const waiting = queue.find((q) => q.id === id);
      if (waiting) {
        for (const n of skip) waiting.skip.add(n);
        continue;
      }
      queue.push({ id, skip });
      added++;
      if (queue.length > opt.maxQueue) queue.shift();
    }
    // Requests go to the feed while it brings players, and to their histories while it does not.
    if (added >= opt.feedBusy) feedGap = opt.feedEveryMs;
    else if (!added) feedGap = Math.min(Math.round(feedGap * 1.5), Math.max(opt.feedMaxMs, opt.feedEveryMs));
  }

  /** Starts a round of the case watch: the watched list comes from the database, no site request. */
  async function startWatchRound() {
    lastWatch = now();
    try {
      watched = [...new Set((await loadWatch()).map(String).filter((x) => /^[A-Za-z0-9_-]{1,200}$/.test(x)))];
    } catch (e) {
      event('warn', 'case-watch', `Could not load the watched cases: ${e.message}`);
    }
    for (const slug of watchHits.keys()) if (!watched.includes(slug)) watchHits.delete(slug);
    watchQueue.length = 0;
    watchQueue.push(...watched);
  }

  /** Reads one watched case's page, as the site's case page does: custom first (it has chances), official on 404. */
  async function readWatched(slug) {
    const enc = encodeURIComponent(slug);
    for (const path of [`/api/game/custom-cases/${enc}`, `/api/game/cases/${enc}`]) {
      let body;
      try {
        body = await get(path);
      } catch (e) {
        if (isHttp(e, 404)) continue;
        throw e;
      }
      const snap = caseSnap(body, slug, now());
      if (!snap) return;
      prices.add({ slug, price: snap.price });
      watchHits.set(slug, new Set(hitItems(snap).map((i) => i.name)));
      await saveCaseSnap(snap);
      return;
    }
  }

  /** Picks up the oldest player read the dashboard asked for (a database read, no site request). */
  async function checkFetch() {
    lastFetchCheck = now();
    let j;
    try {
      j = await nextFetch();
    } catch (e) {
      event('warn', 'player-read', `Could not look for player reads: ${e.message}`);
      return;
    }
    if (!j) return;
    if (!/^[0-9]{1,20}$/.test(String(j.player ?? ''))) {
      await updateFetch(j.id, { status: 'failed', player: null, message: 'Not a player id.' }).catch(() => {});
      return;
    }
    const u = await hashUser(String(j.player));
    fetchJob = { id: j.id, player: String(j.player), slug: j.slug ?? null, u, offset: 0, pages: 0, rows: 0, matched: 0, oldest: null };
    await updateFetch(j.id, { status: 'reading', u, pages: 0, rows: 0, matched: 0 });
  }

  async function finishFetch(status, message) {
    const j = fetchJob;
    fetchJob = null;
    await updateFetch(j.id, { status, player: null, pages: j.pages, rows: j.rows, matched: j.matched, oldest: j.oldest, message });
  }

  /**
   * One page of a requested player's case list. Rows go in like the re-read's (only added, as new rows); the list
   * is read back to `fetchKeepMs` or `fetchPages` pages.
   */
  async function readFetchPage() {
    const j = fetchJob;
    const cut = now() - opt.fetchKeepMs;
    let page;
    try {
      page = await readPage(j.player, j.u, 'case', j.offset);
    } catch (e) {
      // One player the site will not show is not a block of the monitor; a real block refuses the next request too.
      if (isHttp(e, 400, 403, 404)) {
        await finishFetch('failed', e.status === 404 || e.status === 400 ? 'The site has no player with this id.' : 'The site refused this player’s history (HTTP 403).');
        return true;
      }
      throw e;
    }
    const all = page.parse({});
    const rows = page.parse({ back: false }).filter((r) => r.ts >= cut).map((r) => ({ ...r, addOnly: true }));
    await save(rows, true);
    j.pages++;
    j.offset += page.len;
    j.rows += rows.length;
    j.matched += rows.filter((r) => r.slug === j.slug).length;
    for (const r of rows) if (j.oldest == null || r.ts < j.oldest) j.oldest = r.ts;
    const oldest = all.reduce((m, r) => Math.min(m, r.ts), Infinity);
    if (page.full && oldest >= cut && j.pages < opt.fetchPages) await updateFetch(j.id, { pages: j.pages, rows: j.rows, matched: j.matched, oldest: j.oldest }).catch(() => {});
    else await finishFetch('done', j.pages >= opt.fetchPages && page.full ? `Stopped after ${j.pages} pages.` : null);
    return true;
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

  /**
   * Loads prices of cases seen in drops but missing from the case list (at most 3 per page). Like the site's own
   * case page: the official endpoint first, the custom-case one (cases players make) on 404.
   */
  async function learnCases(slugs) {
    const missing = [...slugs].filter((s) => !triedSlugs.has(s)).slice(0, 3);
    for (const slug of missing) {
      triedSlugs.add(slug);
      const enc = encodeURIComponent(slug);
      for (const path of [`/api/game/cases/${enc}`, `/api/game/custom-cases/${enc}`]) {
        try {
          prices.learnOne(await get(path));
          break;
        } catch (e) {
          if (isHttp(e, 429, 401, 403)) throw e;
          if (!isHttp(e, 404)) break;
        }
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
    if (skip?.size) skips.set(id, new Set([...(skips.get(id) ?? []), ...skip]));
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
      // Older pages later, on history turns; only once per player.
      if (k.hist[stream] === undefined) k.hist[stream] = moreHistory(all, full, cut, len, 0);
      if (stream === 'upgrade') await doSleep(opt.gapMs);
    }
    backfilled.set(id, now());
    if (players.size < opt.maxPlayers) players.set(id, { u, added: now(), lastPolled: now(), lastRow: now(), seen, nextStream: 'upgrade' });
  }

  /** History still to read after a page: {offset: next, pages} while the pages reach no further back than `cut`, else null. */
  function moreHistory(rows, full, cut, next, pages) {
    const oldest = rows.reduce((m, r) => Math.min(m, r.ts), Infinity);
    return full && oldest >= cut && pages < opt.deepPages ? { offset: next, pages } : null;
  }

  /** A known player whose history still has pages to read (the earliest found first). */
  function nextHistory() {
    for (const [id, k] of known) for (const stream of STREAMS) if (k.hist[stream]) return { id, k, stream };
    return null;
  }

  /** One older page of a player's list. */
  async function readHistory({ id, k, stream }) {
    const job = k.hist[stream];
    const cut = now() - opt.historyMs;
    const u = await hashUser(id);
    const { parse, len, full } = await readPage(id, u, stream, job.offset);
    const all = parse({});
    await save(parse({ skip: skips.get(id), back: true }).filter((r) => r.ts >= cut), true);
    k.hist[stream] = moreHistory(all, full, cut, job.offset + len, job.pages + 1);
    return true;
  }

  /**
   * One page of the one-time case-list re-read (see RESCAN_KEY). Only rows of cases outside the site's case list are
   * kept, as new rows (not history, so they do not move where a player's discovery is placed), and only added: a row
   * already stored stays as it is.
   */
  async function readRescan() {
    const [id, job] = rescan.entries().next().value;
    if (!known.has(id)) {
      rescan.delete(id);
      return false;
    }
    const cut = now() - opt.historyMs;
    const u = await hashUser(id);
    const { parse, len, full } = await readPage(id, u, 'case', job.offset);
    const all = parse({});
    const rows = parse({ skip: skips.get(id), back: false }).filter((r) => r.ts >= cut && r.slug && !prices.listed.has(r.slug)).map((r) => ({ ...r, addOnly: true }));
    await save(rows, true);
    const oldest = all.reduce((m, r) => Math.min(m, r.ts), Infinity);
    if (full && oldest >= cut && job.pages + 1 < opt.rescanPages) rescan.set(id, { offset: job.offset + len, pages: job.pages + 1 });
    else rescan.delete(id);
    return true;
  }

  /** The known player most overdue for a check, with whether they are playing now; null if none is due. */
  function dueRevisit() {
    const t = now();
    let pick = null;
    for (const [id, k] of known) {
      if (players.has(id) || backfilled.has(id)) continue;
      const every = revisitEvery(k, t);
      if (k.revisited + every > t) continue;
      const hot = t - lastPlayed(k) <= opt.activeMs;
      // Players on the site now first, then the most overdue for their tier (time since the last check
      // over the tier's interval), so a backlog delays every tier alike instead of starving the recent ones.
      const late = (t - k.revisited) / every;
      if (!pick || (hot && !pick.hot) || (hot === pick.hot && late > pick.late)) pick = { id, k, late, hot };
    }
    return pick;
  }

  /**
   * Which lists of a player have new play by their counters: [] for none, null when the counters
   * cannot tell (then both lists are read). The first check of a player only sets the base.
   */
  async function checkCounters(id, k) {
    const t = now();
    let body;
    try {
      body = await get(`/api/users/${encodeURIComponent(id)}/stats`);
    } catch (e) {
      // 403 here may be one private profile; a real block shows on the list read that follows.
      if (e instanceof HttpError && !isHttp(e, 429, 401)) return null;
      throw e;
    }
    const ctr = { upgrade: Number(body?.upgradesMade), case: Number(body?.casesOpened) };
    if (body?.upgradesMade == null || body?.casesOpened == null || !Number.isFinite(ctr.upgrade) || !Number.isFinite(ctr.case)) {
      countersOff = true;
      event('warn', 'counters', 'Player stats no longer show upgradesMade and casesOpened. Quiet players are checked by reading their lists again, which costs twice the requests.');
      return null;
    }
    const prev = k.ctr;
    k.ctr = ctr;
    if (!prev) return [];
    const moved = STREAMS.filter((s) => ctr[s] !== prev[s]);
    for (const s of STREAMS) if (!moved.includes(s)) k.quiet[s] = { at: t, after: k.newest[s] };
    return moved;
  }

  /**
   * New rows of a known player who is not followed: this is how players who play small (and never
   * reach the drop board) stay in the sample once they have been seen there.
   */
  async function revisit(pick) {
    const { id, k } = pick;
    const t = now();
    k.revisited = t;
    let streams = STREAMS;
    if (!pick.hot && !countersOff) {
      streams = (await checkCounters(id, k)) ?? STREAMS;
      if (!streams.length) return true;
      await doSleep(opt.gapMs);
    }
    const u = await hashUser(id);
    for (const [i, stream] of streams.entries()) {
      // Rows newer than the last one seen are new play; with nothing seen yet, it is history.
      const since = k.newest[stream] || t - opt.historyMs;
      const back = !k.newest[stream];
      let more = null; // with nothing seen yet: older pages still to read after this revisit
      for (let page = 0, offset = 0; page < opt.maxPages; page++) {
        const { parse, len, full } = await readPage(id, u, stream, offset);
        const rows = parse({ back });
        noteNewest(id, stream, rows);
        const fresh = rows.filter((r) => r.ts > since);
        await save(fresh, back);
        offset += len;
        more = moreHistory(rows, full, t - opt.historyMs, offset, 0);
        if (fresh.length < rows.length || !full) break;
        await doSleep(opt.gapMs);
      }
      if (back && k.hist[stream] === undefined) k.hist[stream] = more;
      if (i < streams.length - 1) await doSleep(opt.gapMs);
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

  /** One kind of work from the rotation; false when it has nothing to do. */
  async function work(kind) {
    if (kind === 'look') return queue.length ? (await backfill(queue.shift()), true) : false;
    if (kind === 'follow') return follow();
    if (kind === 'hot' || kind === 'revisit') {
      // Players on the site now come first: they are what "right now" is made of.
      const due = dueRevisit();
      if (due?.hot) return revisit(due);
      // While the case-list re-read runs, it takes the turn of players who are not on the site now.
      if (kind === 'revisit' && rescan.size && (await readRescan())) return true;
      return due && kind === 'revisit' ? revisit(due) : false;
    }
    if (kind === 'history') {
      if (rescan.size && (await readRescan())) return true;
      const job = nextHistory();
      return job ? readHistory(job) : false;
    }
    return false;
  }

  async function step() {
    const t = now();
    if (t - lastCases >= opt.casesEveryMs) return readCases();
    if (t - lastFeed >= feedGap) return readFeed();
    if (t - lastStats >= opt.statsEveryMs) return readStats();
    if (t - lastWatch >= opt.watchEveryMs) await startWatchRound();
    if (watchQueue.length) return readWatched(watchQueue.shift());
    if (!fetchJob && t - lastFetchCheck >= opt.fetchCheckMs) await checkFetch();
    if (fetchJob) return readFetchPage();
    if (!profileProbed && known.size) return probeProfile();
    const n = opt.turns.length;
    const start = turn++ % n;
    for (let i = 0; i < n; i++) if (await work(opt.turns[(start + i) % n])) return;
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
        known: [...known].map(([id, k]) => ({ id, seen: k.seen, revisited: k.revisited, newest: k.newest, hist: k.hist, ctr: k.ctr })),
        pageSize,
        pageProbe,
        profileProbed,
        rescanKey: RESCAN_KEY,
        rescan: [...rescan],
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
        // Lists with older pages still to read (up to `deepPages` each).
        historyPages: [...known.values()].reduce((s, k) => s + STREAMS.filter((st) => k.hist[st]).length, 0),
        recentPlayers: backfilled.size, // players first looked at in the last watchMs
        feedEveryMs: feedGap, // current feed interval
        watchedCases: watched.length,
        rescanLeft: rescan.size, // players whose case list is still to be read again (custom cases)
        playerRead: fetchJob ? { pages: fetchJob.pages, rows: fetchJob.rows } : null,
        counterChecks: !countersOff,
        counterMisses, // counter checks that said "no new play" when the list later showed some
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
