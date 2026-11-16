// Stats server for the userscript. POST a list of views; get the computed statistics back.
// The math is src/stats, bundled into ./lib.js by build.mjs (do not edit lib.js by hand).
//
// Auth is the same as cloud sync: the random sync key in the "x-sync-key" header names the history.
// The function reads only rows of that key. It connects as the database owner (SUPABASE_DB_URL),
// so every query below filters by the key itself.
//
// Deploy with verify_jwt off: the userscript sends the publishable key, which is not a JWT.

import postgres from 'npm:postgres@3.4.5';
import { handle } from './lib.js';

const KEY_RE = /^[A-Za-z0-9_-]{32,128}$/;
const MAX_BODY = 64 * 1024;

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { max: 2, prepare: false, idle_timeout: 20 });

// The events of the last key served, while this instance stays warm. One entry only: memory is small.
// When the version changes, only rows changed since `since` are read and applied.
type Warm = { key: string; version: string; since: string; byId: Map<string, unknown>; list: unknown[] | null };
let warm: Warm | null = null;
// Rows committed late can carry an older updated_at than rows already read, so re-read a little.
const OVERLAP = '15 seconds';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'apikey, authorization, content-type, x-sync-key',
  'access-control-allow-methods': 'POST, OPTIONS',
};

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return reply(405, { error: 'POST only' });
  const key = req.headers.get('x-sync-key') ?? '';
  if (!KEY_RE.test(key)) return reply(401, { error: 'missing or bad sync key' });
  const text = await req.text();
  if (text.length > MAX_BODY) return reply(413, { error: 'request too large' });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return reply(400, { error: 'body is not JSON' });
  }

  const started = performance.now();
  try {
    const out = await handle(body, {
      version: async () => (await sql`select public.stats_version(${key}) as v`)[0].v as string,
      cacheGet: async (keys: string[], version: string) => {
        const rows = await sql`
          select query_hash, result from public.stats_cache
          where account = ${key} and version = ${version} and query_hash = any(${keys.map(hash)})`;
        const byHash = new Map(rows.map((r) => [r.query_hash as string, r.result]));
        const out = new Map();
        for (const k of keys) if (byHash.has(hash(k))) out.set(k, byHash.get(hash(k)));
        return out;
      },
      cachePut: async (version: string, entries: { key: string; value: unknown }[]) => {
        await sql.begin(async (tx) => {
          await tx`delete from public.stats_cache where account = ${key} and version <> ${version}`;
          for (const e of entries) {
            await tx`
              insert into public.stats_cache (account, query_hash, version, result)
              values (${key}, ${hash(e.key)}, ${version}, ${tx.json(e.value as never)})
              on conflict (account, query_hash) do update
                set version = excluded.version, result = excluded.result, computed_at = now()`;
          }
        });
      },
      loadEvents: async () => {
        const version = (await sql`select public.stats_version(${key}) as v`)[0].v as string;
        if (warm && warm.key === key) {
          if (warm.version !== version) {
            const rows = await sql`
              select id, deleted, lite, updated_at::text as at from public.sync_events
              where account = ${key} and updated_at > ${warm.since}::timestamptz - ${OVERLAP}::interval`;
            for (const r of rows) {
              if (r.deleted || r.lite == null) warm.byId.delete(r.id as string);
              else warm.byId.set(r.id as string, r.lite);
              if ((r.at as string) > warm.since) warm.since = r.at as string;
            }
            warm.version = version;
            warm.list = null;
          }
        } else {
          warm = null;
          const rows = await sql`
            select id, lite, updated_at::text as at from public.sync_events
            where account = ${key} and not deleted and lite is not null`;
          const byId = new Map<string, unknown>();
          let since = '1970-01-01 00:00:00+00';
          for (const r of rows) {
            byId.set(r.id as string, r.lite);
            if ((r.at as string) > since) since = r.at as string;
          }
          warm = { key, version, since, byId, list: null };
        }
        warm.list ??= [...warm.byId.values()];
        return warm.list;
      },
      markDeleted: async (ids: string[]) => {
        if (warm && warm.key === key) {
          for (const id of ids) warm.byId.delete(id);
          warm.list = null;
        }
        await sql`
          update public.sync_events set deleted = true, data = null, updated_at = clock_timestamp()
          where account = ${key} and id = any(${ids}) and not deleted`;
      },
    });
    return reply(200, { ...out, ms: Math.round(performance.now() - started) });
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    // Request mistakes (from handle) are the client's; anything else is ours.
    const mine = /^Send /.test(msg);
    if (!mine) console.error(err);
    return reply(mine ? 400 : 500, { error: mine ? msg : 'stats server error' });
  }
});

// FNV-1a 64-bit as hex: a short, stable cache key for a query string (not a security boundary).
function hash(s: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}
