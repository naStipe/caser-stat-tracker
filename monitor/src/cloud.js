// Writes to Supabase (tables from supabase/migrations/*_monitor.sql) through its REST API, with the
// project's secret key. That key bypasses row level security, so it stays on the monitor's server
// and never goes into the dashboard page.

const BATCH = 1000;

/**
 * @param {Object} o
 * @param {typeof fetch} o.fetch
 * @param {string} o.url  project URL, e.g. https://xyz.supabase.co
 * @param {string} o.key  secret key (sb_secret_…) or the legacy service_role key
 */
export function createCloud({ fetch, url, key }) {
  const base = url.replace(/\/+$/, '');
  const headers = { apikey: key, 'content-type': 'application/json' };
  // Legacy keys are JWTs and also go in Authorization; new secret keys only in apikey.
  if (key.startsWith('eyJ')) headers.authorization = `Bearer ${key}`;

  async function call(method, path, body, prefer) {
    const res = await fetch(base + path, { method, headers: { ...headers, ...(prefer ? { prefer } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let msg = text.slice(0, 200);
      try {
        msg = JSON.parse(text).message || msg;
      } catch {}
      throw new Error(`Supabase answered ${res.status} for ${method} ${path.split('?')[0]}${msg ? `: ${msg}` : ''}`);
    }
  }

  async function insert(table, conflict, list) {
    for (let i = 0; i < list.length; i += BATCH) {
      await call('POST', `/rest/v1/${table}?on_conflict=${conflict}`, list.slice(i, i + BATCH), 'resolution=ignore-duplicates,return=minimal');
    }
  }

  return {
    /** Adds rows and volume samples; ones already there are left as they are. */
    async push(rows, volume) {
      if (rows.length) await insert('monitor_rows', 'id', rows.map((r) => ({ id: r.id, kind: r.kind, ts: Math.round(r.ts), u: r.u, stake: r.stake, returned: r.returned, chance: r.chance ?? null, back: !!r.back })));
      if (volume.length) await insert('monitor_volume', 'ts', volume.map((v) => ({ ts: Math.round(v.ts), cases: Math.round(v.cases), upgrades: Math.round(v.upgrades), online: Math.round(v.online) || null })));
    },
    /** What the dashboard shows about the monitor itself. */
    async status(status) {
      await call('POST', '/rest/v1/monitor_status?on_conflict=id', { id: 1, updated_at: new Date().toISOString(), status }, 'resolution=merge-duplicates,return=minimal');
    },
    /** Deletes rows and samples older than `before` (ms since 1970). */
    async prune(before) {
      const t = Math.floor(before);
      await call('DELETE', `/rest/v1/monitor_rows?ts=lt.${t}`, undefined, 'return=minimal');
      await call('DELETE', `/rest/v1/monitor_volume?ts=lt.${t}`, undefined, 'return=minimal');
    },
  };
}
