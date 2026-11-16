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

  async function call(method, path, body, prefer, json = false) {
    const res = await fetch(base + path, { method, headers: { ...headers, ...(prefer ? { prefer } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let msg = text.slice(0, 200);
      try {
        msg = JSON.parse(text).message || msg;
      } catch {}
      throw new Error(`Supabase answered ${res.status} for ${method} ${path.split('?')[0]}${msg ? `: ${msg}` : ''}`);
    }
    return json ? res.json() : undefined;
  }

  async function insert(table, conflict, list, resolution) {
    for (let i = 0; i < list.length; i += BATCH) {
      await call('POST', `/rest/v1/${table}?on_conflict=${conflict}`, list.slice(i, i + BATCH), `resolution=${resolution},return=minimal`);
    }
  }

  return {
    /**
     * Adds rows, volume samples and drop-line colour counts. A row read again replaces the stored one (that
     * fills in columns older versions did not send); a volume sample or feed count already there is left as it is.
     */
    async push(rows, volume, feed = [], snaps = [], hits = []) {
      // Rows marked addOnly (the case-list re-read) never replace a stored row; the rest do.
      for (const [list, resolution] of [[rows.filter((r) => !r.addOnly), 'merge-duplicates'], [rows.filter((r) => r.addOnly), 'ignore-duplicates']]) {
        if (!list.length) continue;
        // One request must not hold the same id twice (Postgres refuses to update a row twice).
        const byId = new Map(list.map((r) => [r.id, r]));
        await insert(
          'monitor_rows',
          'id',
          [...byId.values()].map((r) => ({
            id: r.id,
            kind: r.kind,
            ts: Math.round(r.ts),
            u: r.u,
            stake: r.stake,
            returned: r.returned,
            chance: r.chance ?? null,
            back: !!r.back,
            slug: r.slug ?? null,
            tier: r.tier ?? null,
            won: typeof r.won === 'boolean' ? r.won : null,
          })),
          resolution,
        );
      }
      if (volume.length) {
        const byTs = new Map(volume.map((v) => [Math.round(v.ts), v]));
        await insert('monitor_volume', 'ts', [...byTs].map(([ts, v]) => ({ ts, cases: Math.round(v.cases), upgrades: Math.round(v.upgrades), online: Math.round(v.online) || null })), 'ignore-duplicates');
      }
      if (feed.length) {
        const byTs = new Map(feed.map((f) => [Math.round(f.ts), f]));
        await insert('monitor_feed', 'ts', [...byTs].map(([ts, f]) => ({
          ts, seen: f.seen, span: f.span ?? null, elapsed: f.elapsed ?? null,
          gold: f.gold, red: f.red, pink: f.pink, purple: f.purple, blue: f.blue, light: f.light, grey: f.grey,
          up: f.up, value: f.value,
        })), 'ignore-duplicates');
      }
      if (snaps.length) {
        const byKey = new Map(snaps.map((x) => [`${x.slug}/${Math.round(x.ts)}`, x]));
        await insert('monitor_case_snap', 'slug,ts', [...byKey.values()].map((x) => ({
          slug: x.slug, ts: Math.round(x.ts), opens: x.opens ?? null, price: x.price, items: x.items,
        })), 'ignore-duplicates');
      }
      if (hits.length) {
        const byKey = new Map(hits.map((x) => [`${x.slug}/${x.dropId}`, x]));
        await insert('monitor_case_hits', 'slug,drop_id', [...byKey.values()].map((x) => ({
          slug: x.slug, drop_id: x.dropId, ts: Math.round(x.ts), item: String(x.item).slice(0, 200), price: x.price,
        })), 'ignore-duplicates');
      }
    },
    /** Slugs of the cases watched from the dashboard. */
    async watchList() {
      const list = await call('GET', '/rest/v1/monitor_case_watch?select=slug', undefined, undefined, true);
      return Array.isArray(list) ? list.map((r) => r.slug) : [];
    },
    /** Adds events to the log the dashboard shows: [{level, code, message, at?}]. */
    async events(list) {
      if (!list.length) return;
      await call('POST', '/rest/v1/monitor_events', list.map((e) => ({ level: e.level, code: String(e.code).slice(0, 40), message: String(e.message).slice(0, 1000), ...(e.at ? { at: new Date(e.at).toISOString() } : {}) })), 'return=minimal');
    },
    /** A setting only the monitor and the database can read (monitor_private), e.g. the alert URL. */
    async setPrivate(key, value) {
      await call('POST', '/rest/v1/monitor_private?on_conflict=key', { key, value }, 'resolution=merge-duplicates,return=minimal');
    },
    /** What the dashboard shows about the monitor itself. */
    async status(status) {
      await call('POST', '/rest/v1/monitor_status?on_conflict=id', { id: 1, updated_at: new Date().toISOString(), status }, 'resolution=merge-duplicates,return=minimal');
    },
    /**
     * Deletes samples, feed counts and events older than `before` (ms since 1970). Raw rows are not touched: the
     * database keeps them 9 days and their running totals for good (monitor_prune, migration 20261115000007).
     */
    async prune(before) {
      const t = Math.floor(before);
      await call('DELETE', `/rest/v1/monitor_volume?ts=lt.${t}`, undefined, 'return=minimal');
      await call('DELETE', `/rest/v1/monitor_feed?ts=lt.${t}`, undefined, 'return=minimal');
      await call('DELETE', `/rest/v1/monitor_events?at=lt.${encodeURIComponent(new Date(t).toISOString())}`, undefined, 'return=minimal');
    },
  };
}
