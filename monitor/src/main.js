// Pulse monitor: collects other players' recent upgrades and case drops on the site and shows,
// on its own web page, whether play is more profitable now than a few hours ago.
//
// Settings come from the environment (see .env.example):
//   CASER_REFRESH_TOKEN  refresh token of the account the monitor uses (from that browser's localStorage)
//   VIEW_PASSWORD        password for the dashboard; without it the page listens on 127.0.0.1 only
//   PORT                 dashboard port, default 8080
//   HOST                 listen address, default 0.0.0.0 (127.0.0.1 without VIEW_PASSWORD)
//   CASER_BASE           site origin, default https://caser.gg
//   PULSE_GAP_MS         pause between requests, default 8000 (about 450 an hour), at least 2000
//   DATA_DIR             state and collected rows, default ./data
//   USER_AGENT           default "pulse-collector/<version> node/<version>"
//
// DATA_DIR/state.json holds the latest tokens and the salt for player hashes. When
// CASER_REFRESH_TOKEN changes, the new value replaces the saved tokens.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createCollector } from './collector.js';
import { hashUser } from './parse.js';
import { aggregate, pulseSummary, pulseWindows } from './stats.js';
import { createSite } from './site.js';
import { createStore } from './store.js';
import { createServer } from './server.js';

const LOG_EVERY_MS = 5 * 60 * 1000;
const PRUNE_EVERY_MS = 10 * 60 * 1000;
const SUMMARY_TTL_MS = 15 * 1000;

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

/** Dashboard numbers from stored rows (the same windows as pulseWindows). */
export function summarize(store, now) {
  const w = pulseWindows(now);
  const { rows, volume } = store.since(w.hours.from);
  const one = (win) => aggregate(rows, { from: win.from, to: win.to, bucketMs: win.to - win.from });
  return pulseSummary({ recent: one(w.recent), base: one(w.base), day: one(w.day), hours: aggregate(rows, w.hours) }, volume, now);
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
  const base = (env.CASER_BASE || 'https://caser.gg').replace(/\/+$/, '');
  const gapMs = Number(env.PULSE_GAP_MS) > 0 ? Math.max(2000, Number(env.PULSE_GAP_MS)) : 8000;
  const dir = env.DATA_DIR || 'data';
  const userAgent = env.USER_AGENT || `pulse-collector/${version} node/${process.versions.node}`;

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

  let saving = Promise.resolve();
  const persist = () => (saving = saving.then(() => saveState(file, state)).catch((e) => log(`Saving state failed: ${e.message}`)));
  await persist();

  const store = await createStore({ dir: join(dir, 'rows'), now });
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
    saveRows: (rows) => store.putRows(rows),
    saveVolume: (v) => store.putVolume(v),
    now,
    sleep,
    options: { gapMs, ...options },
  });

  const startedAt = now();
  let cached = null;
  function snapshot() {
    const t = now();
    if (!cached || t - cached.at > SUMMARY_TTL_MS) cached = { at: t, summary: summarize(store, t) };
    return { summary: cached.summary, status: collector.status(), info: { version, base, gapMs, startedAt, stored: store.count() } };
  }

  function statusLine() {
    const s = collector.status();
    const parts = [
      s.running ? 'running' : 'stopped',
      `following ${s.players}`,
      `waiting ${s.queued}`,
      `requests/h ${s.requestsLastHour}`,
      `rows/h ${s.rowsLastHour} (${s.backRowsLastHour} from history)`,
      `in memory ${store.count()}`,
    ];
    if (s.pausedUntil) parts.push(`paused until ${new Date(s.pausedUntil).toISOString()}`);
    if (s.error) parts.push(`last error: ${s.error}`);
    return parts.join(' | ');
  }

  return {
    site,
    collector,
    store,
    state,
    snapshot,
    statusLine,
    config: { base, gapMs, userAgent, dir },
    /** Collects until stop() or until the site refuses the account. */
    async run() {
      log(`Pulse monitor ${version}: ${base}, one request per ${gapMs / 1000} s, data in ${dir}`);
      const logTimer = setInterval(() => log(statusLine()), LOG_EVERY_MS);
      const pruneTimer = setInterval(() => store.prune().catch((e) => log(`Prune failed: ${e.message}`)), PRUNE_EVERY_MS);
      try {
        await store.prune();
        await collector.start();
      } finally {
        clearInterval(logTimer);
        clearInterval(pruneTimer);
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
  const html = await readFile(join(root, 'public', 'index.html'), 'utf8');
  const env = process.env;
  let monitor;
  try {
    monitor = await createMonitor({ env, fetch: globalThis.fetch, version: pkg.version });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  const password = env.VIEW_PASSWORD || null;
  const host = env.HOST || (password ? '0.0.0.0' : '127.0.0.1');
  const port = Number(env.PORT) || 8080;
  if (!password && host !== '127.0.0.1' && host !== 'localhost') {
    console.error('Set VIEW_PASSWORD before opening the dashboard to other machines (HOST is not 127.0.0.1).');
    process.exit(1);
  }
  const server = createServer({ snapshot: monitor.snapshot, html, password });
  server.listen(port, host, () => console.log(`Dashboard on http://${host}:${port}/${password ? ' (password protected)' : ' (this machine only: set VIEW_PASSWORD to open it to others)'}`));

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
    server.close();
    process.exit(0);
  }
  // The collector stopped by itself: the site refused the account or blocked the monitor.
  // The dashboard stays up with what was collected; no more requests go to the site, so a
  // container restart policy does not retry in a loop.
  console.error(`Collector stopped: ${error}`);
  console.error('Not sending any more requests to the site. Set a new CASER_REFRESH_TOKEN and restart.');
  setInterval(() => console.error('Collector still stopped. Set a new CASER_REFRESH_TOKEN and restart.'), 60 * 60 * 1000);
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
