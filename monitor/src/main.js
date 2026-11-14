// Pulse monitor: collects other players' recent upgrades and case drops on the site and writes them
// to Supabase, where the dashboard page (dashboard/) reads them.
//
// Settings come from the environment (see .env.example):
//   CASER_REFRESH_TOKEN   refresh token of the account the monitor uses (from that browser's localStorage)
//   SUPABASE_SECRET_KEY   the project's secret key (sb_secret_…), or the legacy service_role key
//   SUPABASE_URL          default https://hafnhxumrqyaljmciqqq.supabase.co
//   RETENTION_DAYS        rows older than this are deleted, default 30
//   CASER_BASE            site origin, default https://caser.gg
//   PULSE_GAP_MS          pause between requests, default 8000 (about 450 an hour), at least 2000
//   DATA_DIR              state file, default ./data
//   USER_AGENT            default "pulse-collector/<version> node/<version>"
//
// DATA_DIR/state.json holds the latest tokens, the salt for player hashes, and rows not yet in
// Supabase. When CASER_REFRESH_TOKEN changes, the new value replaces the saved tokens.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createCollector } from './collector.js';
import { hashUser } from './parse.js';
import { createSite } from './site.js';
import { createCloud } from './cloud.js';

export const DEFAULT_SUPABASE_URL = 'https://hafnhxumrqyaljmciqqq.supabase.co';
const FLUSH_EVERY_MS = 60 * 1000;
const LOG_EVERY_MS = 5 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
const MAX_PENDING_ROWS = 100_000;
const MAX_PENDING_VOLUME = 10_000;
const DAY = 24 * 60 * 60 * 1000;

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
  const supabaseUrl = (env.SUPABASE_URL || DEFAULT_SUPABASE_URL).trim();
  const retentionDays = Number(env.RETENTION_DAYS) > 0 ? Number(env.RETENTION_DAYS) : 30;
  const base = (env.CASER_BASE || 'https://caser.gg').replace(/\/+$/, '');
  const gapMs = Number(env.PULSE_GAP_MS) > 0 ? Math.max(2000, Number(env.PULSE_GAP_MS)) : 8000;
  const dir = env.DATA_DIR || 'data';
  const userAgent = env.USER_AGENT || `pulse-collector/${version} node/${process.versions.node}`;
  if (!secret) throw new Error('Set SUPABASE_SECRET_KEY (Supabase: Project Settings, API Keys, secret key).');

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

  let saving = Promise.resolve();
  const persist = () => (saving = saving.then(() => saveState(file, state)).catch((e) => log(`Saving state failed: ${e.message}`)));
  await persist();

  const cloud = createCloud({ fetch: fetchFn, url: supabaseUrl, key: secret });
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
    now,
    sleep,
    options: { gapMs, ...options },
  });

  const startedAt = now();
  let pushed = 0;
  let cloudError = null;
  let lastPrune = -Infinity;

  function statusObject() {
    const s = collector.status();
    return { ...s, version, base, gapMs, startedAt, pending: state.pendingRows.length, pushed, cloudError, retentionDays, reportedAt: now() };
  }

  let flushing = null;
  function flush() {
    flushing ??= pushPending().finally(() => (flushing = null));
    return flushing;
  }
  async function pushPending() {
    // Copies: rows saved while the push runs are appended to the live arrays.
    const rows = state.pendingRows.slice();
    const volume = state.pendingVolume.slice();
    try {
      if (rows.length || volume.length) await cloud.push(rows, volume);
      pushed += rows.length;
      state.pendingRows = state.pendingRows.slice(rows.length);
      state.pendingVolume = state.pendingVolume.slice(volume.length);
      if (now() - lastPrune >= PRUNE_EVERY_MS) {
        lastPrune = now();
        await cloud.prune(now() - retentionDays * DAY);
      }
      await cloud.status(statusObject());
      cloudError = null;
    } catch (e) {
      cloudError = String(e?.message ?? e);
      log(`Supabase write failed, keeping ${state.pendingRows.length} rows for the next try: ${cloudError}`);
    }
    await persist();
  }

  function statusLine() {
    const s = collector.status();
    const parts = [
      s.running ? 'running' : 'stopped',
      `following ${s.players}`,
      `waiting ${s.queued}`,
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

  return {
    site,
    collector,
    state,
    flush,
    statusLine,
    config: { base, gapMs, userAgent, dir, supabaseUrl, retentionDays },
    /** Collects until stop() or until the site refuses the account. */
    async run() {
      log(`Pulse monitor ${version}: ${base}, one request per ${gapMs / 1000} s, writing to ${supabaseUrl}`);
      const flushTimer = setInterval(() => flush(), FLUSH_EVERY_MS);
      const logTimer = setInterval(() => log(statusLine()), LOG_EVERY_MS);
      try {
        await collector.start();
      } finally {
        clearInterval(flushTimer);
        clearInterval(logTimer);
        await flush(); // also reports the final status (a stop reason shows on the dashboard)
        await saving;
      }
      log(statusLine());
      return { error: collector.status().error };
    },
    stop: () => collector.stop(),
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
  if (stopping) process.exit(0);
  // The collector stopped by itself: the site refused the account or blocked the monitor.
  // Stay up without sending anything to the site, so a container restart policy does not retry in a loop.
  console.error(`Collector stopped: ${error}`);
  console.error('Not sending any more requests to the site. Set a new CASER_REFRESH_TOKEN and restart.');
  setInterval(() => console.error('Collector still stopped. Set a new CASER_REFRESH_TOKEN and restart.'), 60 * 60 * 1000);
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
