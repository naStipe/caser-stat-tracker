// Pulse monitor: collects other players' recent upgrades and case drops on the site and writes them
// to Supabase, where the dashboard page (dashboard/) reads them.
//
// Settings come from the environment (see .env.example):
//   CASER_REFRESH_TOKEN   refresh token of the account the monitor uses (from that browser's localStorage)
//   SUPABASE_SECRET_KEY   the project's secret key (sb_secret_…), or the legacy service_role key
//   ALERT_URL             webhook for alerts (Discord, Telegram or ntfy, see notify.js); optional
//   SUPABASE_URL          default https://hafnhxumrqyaljmciqqq.supabase.co
//   RETENTION_DAYS        rows older than this are deleted, default 30
//   HISTORY_DAYS          how far back a found player's history is read, default 7
//   HISTORY_PAGES         older pages read per list per player, default 10
//   REVISIT_HOURS         how often a known player is checked again for new rows, default 3
//   CASER_BASE            site origin, default https://caser.gg
//   PULSE_GAP_MS          pause between requests, default 8000 (about 450 an hour), at least 2000
//   DATA_DIR              state file, default ./data
//   USER_AGENT            default "pulse-collector/<version> node/<version>"
//
// DATA_DIR/state.json holds the latest tokens, the salt for player hashes, rows and events not yet in
// Supabase, and the list of known players (their real site ids, so it stays on this server).
// When CASER_REFRESH_TOKEN changes, the new value replaces the saved tokens.
//
// Problems are logged, written to the event log the dashboard shows, and sent to ALERT_URL:
// the site refusing the login or blocking the monitor, long pauses, runs of failed requests,
// Supabase writes failing, crashes, and a restart after the monitor was killed. The database
// watchdog (pg_cron) alerts when the monitor stops reporting altogether.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createCollector } from './collector.js';
import { hashUser } from './parse.js';
import { createSite } from './site.js';
import { createCloud } from './cloud.js';
import { createNotifier } from './notify.js';

export const DEFAULT_SUPABASE_URL = 'https://hafnhxumrqyaljmciqqq.supabase.co';
const FLUSH_EVERY_MS = 60 * 1000;
const LOG_EVERY_MS = 5 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
const MAX_PENDING_ROWS = 100_000;
const MAX_PENDING_VOLUME = 10_000;
const MAX_PENDING_EVENTS = 500;
const CLOUD_FAILS_ALERT = 5; // failed flushes in a row (about 5 minutes) before an alert
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

export async function loadState(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`Cannot read ${file}: ${e.message}`);
  }
}

export async function saveState(file, state) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(state));
  await rename(tmp, file);
}

const positive = (v, d) => (Number(v) > 0 ? Number(v) : d);

/**
 * Everything the monitor does, with its outside world passed in (for tests).
 * @param {Object} o
 * @param {Record<string, string|undefined>} o.env
 * @param {typeof fetch} o.fetch
 * @param {string} o.version
 * @param {(...a: any[]) => void} [o.log]
 * @param {(ms: number) => Promise<void>} [o.sleep]  passed to the collector
 * @param {() => number} [o.now]
 * @param {Object} [o.options]  collector options on top of the env ones
 */
export async function createMonitor({ env, fetch: fetchFn, version, log = console.log, sleep, now = Date.now, options = {} }) {
  const startToken = (env.CASER_REFRESH_TOKEN || '').trim();
  const secret = (env.SUPABASE_SECRET_KEY || '').trim();
  const alertUrl = (env.ALERT_URL || '').trim() || null;
  const supabaseUrl = (env.SUPABASE_URL || DEFAULT_SUPABASE_URL).trim();
  const retentionDays = positive(env.RETENTION_DAYS, 30);
  const base = (env.CASER_BASE || 'https://caser.gg').replace(/\/+$/, '');
  const gapMs = Number(env.PULSE_GAP_MS) > 0 ? Math.max(2000, Number(env.PULSE_GAP_MS)) : 8000;
  const dir = env.DATA_DIR || 'data';
  const userAgent = env.USER_AGENT || `pulse-collector/${version} node/${process.versions.node}`;
  if (!secret) throw new Error('Set SUPABASE_SECRET_KEY (Supabase: Project Settings, API Keys, secret key).');
  if (alertUrl) {
    try {
      new URL(alertUrl);
    } catch {
      throw new Error('ALERT_URL is not a valid URL.');
    }
  }

  await mkdir(dir, { recursive: true });
  const file = join(dir, 'state.json');
  const state = await loadState(file);
  state.salt ||= randomBytes(16).toString('hex');
  if (startToken && startToken !== state.startToken) {
    // A new token from the environment wins over the saved ones.
    state.startToken = startToken;
    state.tokens = { refresh: startToken, access: null };
  }
  if (!state.tokens?.refresh) throw new Error('Set CASER_REFRESH_TOKEN (see the README).');
  state.pendingRows ||= [];
  state.pendingVolume ||= [];
  state.pendingEvents ||= [];

  let saving = Promise.resolve();
  const persist = () => (saving = saving.then(() => saveState(file, state)).catch((e) => log(`Saving state failed: ${e.message}`)));

  const cloud = createCloud({ fetch: fetchFn, url: supabaseUrl, key: secret });
  const notifier = createNotifier({ fetch: fetchFn, url: alertUrl, log, now });
  const site = createSite({
    fetch: fetchFn,
    base,
    userAgent,
    tokens: state.tokens,
    now,
    saveTokens: async (t) => {
      state.tokens = t;
      await persist();
    },
  });

  let flushSoon = null;
  /** Logs an event, queues it for the dashboard, and alerts on warnings and errors. */
  function report(level, code, message, { alert = level !== 'info', force = false } = {}) {
    log(`[${level}] ${code}: ${message}`);
    state.pendingEvents.push({ level, code, message, at: now() });
    if (state.pendingEvents.length > MAX_PENDING_EVENTS) state.pendingEvents = state.pendingEvents.slice(-MAX_PENDING_EVENTS);
    const sent = alert ? notifier.send(code, `Pulse monitor: ${level === 'error' ? 'problem' : level === 'warn' ? 'warning' : 'note'}`, message, { force }) : Promise.resolve(false);
    // Problems show on the dashboard within seconds, not at the next minute's flush.
    if (level !== 'info') flushSoon ??= setTimeout(() => ((flushSoon = null), flush()), 2000);
    return sent;
  }

  const collector = createCollector({
    getJson: (path) => site.getJson(path),
    hashUser: async (id) => hashUser(id, state.salt),
    saveRows: async (rows) => {
      state.pendingRows.push(...rows);
      if (state.pendingRows.length > MAX_PENDING_ROWS) state.pendingRows = state.pendingRows.slice(-MAX_PENDING_ROWS);
    },
    saveVolume: async (v) => {
      state.pendingVolume.push(v);
      if (state.pendingVolume.length > MAX_PENDING_VOLUME) state.pendingVolume = state.pendingVolume.slice(-MAX_PENDING_VOLUME);
    },
    onEvent: (e) => report(e.level, e.code, e.message, { force: e.code === 'login' || e.code === 'blocked' }),
    initial: state.collector ?? {},
    now,
    sleep,
    options: {
      gapMs,
      historyMs: positive(env.HISTORY_DAYS, 7) * DAY,
      deepPages: Number.isFinite(Number(env.HISTORY_PAGES)) && env.HISTORY_PAGES !== undefined && env.HISTORY_PAGES !== '' ? Math.max(0, Number(env.HISTORY_PAGES)) : 10,
      revisitMs: positive(env.REVISIT_HOURS, 3) * HOUR,
      ...options,
    },
  });

  const startedAt = now();
  let pushed = 0;
  let cloudError = null;
  let cloudFails = 0;
  let lastPrune = -Infinity;

  function statusObject() {
    const s = collector.status();
    return { ...s, version, base, gapMs, startedAt, pending: state.pendingRows.length, pushed, cloudError, retentionDays, alerts: notifier.enabled(), reportedAt: now() };
  }

  let flushing = null;
  function flush() {
    flushing ??= pushPending().finally(() => (flushing = null));
    return flushing;
  }
  async function pushPending() {
    state.collector = collector.exportState();
    // Copies: rows saved while the push runs are appended to the live arrays.
    const rows = state.pendingRows.slice();
    const volume = state.pendingVolume.slice();
    const events = state.pendingEvents.slice();
    try {
      if (rows.length || volume.length) await cloud.push(rows, volume);
      pushed += rows.length;
      state.pendingRows = state.pendingRows.slice(rows.length);
      state.pendingVolume = state.pendingVolume.slice(volume.length);
      if (events.length) await cloud.events(events);
      state.pendingEvents = state.pendingEvents.slice(events.length);
      if (now() - lastPrune >= PRUNE_EVERY_MS) {
        lastPrune = now();
        await cloud.prune(now() - retentionDays * DAY);
      }
      await cloud.status(statusObject());
      if (cloudFails >= CLOUD_FAILS_ALERT) report('info', 'supabase-ok', `Writing to Supabase works again after ${cloudFails} failed tries.`, { alert: true, force: true });
      cloudFails = 0;
      cloudError = null;
    } catch (e) {
      cloudError = String(e?.message ?? e);
      cloudFails++;
      log(`Supabase write failed (${cloudFails} in a row), keeping ${state.pendingRows.length} rows for the next try: ${cloudError}`);
      // The event log is in Supabase too, so this one can only go out as an alert.
      if (cloudFails === CLOUD_FAILS_ALERT) await notifier.send('supabase', 'Pulse monitor: problem', `Writing to Supabase has failed ${cloudFails} times in a row. Rows are kept on the server meanwhile. Last error: ${cloudError}`);
    }
    await persist();
  }

  function statusLine() {
    const s = collector.status();
    const parts = [
      s.running ? 'running' : 'stopped',
      `following ${s.players}`,
      `waiting ${s.queued}`,
      `known ${s.known}`,
      `history pages ${s.historyPages}`,
      `requests/h ${s.requestsLastHour}`,
      `rows/h ${s.rowsLastHour} (${s.backRowsLastHour} from history)`,
      `pending ${state.pendingRows.length}`,
      `sent ${pushed}`,
    ];
    if (s.pausedUntil) parts.push(`paused until ${new Date(s.pausedUntil).toISOString()}`);
    if (s.error) parts.push(`last error: ${s.error}`);
    if (cloudError) parts.push(`supabase: ${cloudError}`);
    return parts.join(' | ');
  }

  /** Startup checks and reports. Separate from run(), so a crash handler can rely on state being loaded. */
  async function begin() {
    // `alive` stays true while running; a start that finds it true means the last run was killed
    // without shutting down (out of memory, power loss, docker kill).
    if (state.alive) report('error', 'unclean', 'The monitor restarted after the last run ended without shutting down (killed, out of memory, or the server restarted).', { force: true });
    if (state.lastCrash) {
      report('warn', 'restarted', `The monitor restarted after a crash: ${state.lastCrash}`, { alert: false });
      delete state.lastCrash;
    }
    state.alive = true;
    report('info', 'start', `Monitor ${version} started: one request per ${gapMs / 1000} s, ${alertUrl ? 'alerts on' : 'alerts off (no ALERT_URL)'}.`);
    try {
      await cloud.setPrivate('alert_url', alertUrl ?? '');
    } catch (e) {
      log(`Saving the alert URL for the database watchdog failed: ${e.message}`);
    }
    if (alertUrl && alertUrl !== state.alertUrl) {
      const ok = await notifier.send('setup', 'Pulse monitor: alerts are set up', 'You will get a message here when the monitor has a problem or stops reporting.', { force: true });
      if (ok) state.alertUrl = alertUrl;
    }
    if (!alertUrl) delete state.alertUrl;
    await persist();
  }

  return {
    site,
    collector,
    state,
    notifier,
    report,
    flush,
    statusLine,
    config: { base, gapMs, userAgent, dir, supabaseUrl, retentionDays },
    /** Collects until stop() or until the site refuses the account. */
    async run() {
      await begin();
      log(`Pulse monitor ${version}: ${base}, one request per ${gapMs / 1000} s, writing to ${supabaseUrl}`);
      const flushTimer = setInterval(() => flush(), FLUSH_EVERY_MS);
      const logTimer = setInterval(() => log(statusLine()), LOG_EVERY_MS);
      try {
        await collector.start();
      } finally {
        clearInterval(flushTimer);
        clearInterval(logTimer);
        clearTimeout(flushSoon);
        await flush(); // also reports the final status (a stop reason shows on the dashboard)
        await saving;
      }
      log(statusLine());
      return { error: collector.status().error, stopReason: collector.status().stopReason };
    },
    stop: () => collector.stop(),
    /** Marks a clean shutdown (or a crash) so the next start knows. */
    async shutdown({ crash = null } = {}) {
      state.alive = false;
      if (crash) state.lastCrash = crash;
      state.collector = collector.exportState();
      await persist();
      await saving;
    },
  };
}

async function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  let monitor;
  try {
    monitor = await createMonitor({ env: process.env, fetch: globalThis.fetch, version: pkg.version });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  // A crash: log it, tell Supabase and the alert URL (best effort, a few seconds at most), then exit
  // so Docker restarts the container.
  let crashing = false;
  const crash = async (kind, err) => {
    if (crashing) return;
    crashing = true;
    const msg = `${kind}: ${err?.stack ?? err?.message ?? err}`.slice(0, 900);
    console.error(`Crashed. ${msg}`);
    const timeout = new Promise((r) => setTimeout(r, 8000));
    await Promise.race([
      (async () => {
        await monitor.report('error', 'crash', `The monitor crashed and will restart. ${msg}`, { force: true });
        await monitor.flush();
        await monitor.shutdown({ crash: msg });
      })().catch(() => {}),
      timeout,
    ]);
    process.exit(1);
  };
  process.on('uncaughtException', (e) => crash('uncaught exception', e));
  process.on('unhandledRejection', (e) => crash('unhandled promise rejection', e));

  let stopping = false;
  const stop = (sig) => {
    if (stopping) return;
    stopping = true;
    console.log(`${sig}: stopping after the current request`);
    monitor.stop();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  const { error } = await monitor.run();
  if (stopping) {
    await monitor.shutdown();
    process.exit(0);
  }
  // The collector stopped by itself: the site refused the account or blocked the monitor. That was
  // reported and alerted. Stay up without sending anything to the site, so a container restart policy
  // does not retry in a loop, and remind every 6 hours.
  console.error(`Collector stopped: ${error}`);
  console.error('Not sending any more requests to the site. Set a new CASER_REFRESH_TOKEN and restart.');
  setInterval(() => {
    console.error('Collector still stopped. Set a new CASER_REFRESH_TOKEN and restart.');
    monitor.notifier.send('still-stopped', 'Pulse monitor: still stopped', `The collector is still stopped: ${error}`, { force: true });
  }, 6 * HOUR);
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
  const exit = async () => {
    await monitor.shutdown();
    process.exit(0);
  };
  process.on('SIGTERM', exit);
  process.on('SIGINT', exit);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
