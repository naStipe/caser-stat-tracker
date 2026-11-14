// Rows and volume samples: the last day and a bit in memory (all the dashboard needs), and every
// row on disk as one JSON line per row in a file per UTC day, kept for KEEP_DAYS.
// Row ids are unique: a player read twice (a second backfill after the follow time) adds nothing.

import { appendFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

const HOUR = 60 * 60 * 1000;
/** In memory: enough for the 24 hourly buckets plus the current hour, and for spotting repeats. */
export const MEMORY_MS = 26 * HOUR;
export const KEEP_DAYS = 14;

const day = (ts) => new Date(ts).toISOString().slice(0, 10);

/**
 * @param {Object} o
 * @param {string} o.dir  folder for the day files
 * @param {() => number} [o.now]
 */
export async function createStore({ dir, now = Date.now }) {
  await mkdir(dir, { recursive: true });
  const rows = new Map(); // id -> row
  let volume = [];

  // Load the newest two days (rows of the last MEMORY_MS can be in either).
  const files = (await readdir(dir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.(rows|volume)\.jsonl$/.test(f)).sort();
  const from = now() - MEMORY_MS;
  for (const f of files.filter((f) => f.slice(0, 10) >= day(from))) {
    const text = await readFile(join(dir, f), 'utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      let x;
      try {
        x = JSON.parse(line);
      } catch {
        continue; // a line cut short by a crash
      }
      if (!(x.ts >= from)) continue;
      if (f.includes('.rows.')) rows.set(x.id, x);
      else volume.push(x);
    }
  }
  volume.sort((a, b) => a.ts - b.ts);

  async function append(kind, list) {
    const byDay = new Map();
    for (const x of list) {
      const k = day(x.ts);
      byDay.set(k, (byDay.get(k) ?? '') + JSON.stringify(x) + '\n');
    }
    for (const [k, text] of byDay) await appendFile(join(dir, `${k}.${kind}.jsonl`), text);
  }

  return {
    /** Adds rows not seen before; returns how many were new. */
    async putRows(list) {
      const fresh = list.filter((r) => r && r.id && !rows.has(r.id));
      for (const r of fresh) rows.set(r.id, r);
      if (fresh.length) await append('rows', fresh);
      return fresh.length;
    },
    async putVolume(sample) {
      volume.push(sample);
      await append('volume', [sample]);
    },
    /** Rows and volume samples with ts >= since (at most MEMORY_MS back). */
    since(since) {
      return { rows: [...rows.values()].filter((r) => r.ts >= since), volume: volume.filter((v) => v.ts >= since) };
    },
    count: () => rows.size,
    /** Drops old rows from memory and old day files from disk. */
    async prune() {
      const cut = now() - MEMORY_MS;
      for (const [id, r] of rows) if (r.ts < cut) rows.delete(id);
      volume = volume.filter((v) => v.ts >= cut);
      const keepFrom = day(now() - KEEP_DAYS * 24 * HOUR);
      for (const f of await readdir(dir)) {
        if (/^\d{4}-\d{2}-\d{2}\./.test(f) && f.slice(0, 10) < keepFrom) await rm(join(dir, f), { force: true });
      }
    },
  };
}
