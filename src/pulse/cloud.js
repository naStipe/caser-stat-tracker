// Site pulse in the cloud: the collecting browser pushes rows and volume samples, every browser
// with the same sync key reads sums per hour. Tables and functions: supabase/migrations/*_pulse.sql.

import { CLOUD_URL, CLOUD_KEY } from '../store/cloud-config.js';
import { isSyncKey } from '../store/cloud.js';
import { cleanAggregate } from './stats.js';

const PUSH_BATCH = 2000;
const PAGE = 1000;

/**
 * @param {Object} o
 * @param {(req: {method: string, url: string, headers: Object, body?: string}) => Promise<{status: number, json: any}>} o.request
 * @param {() => string|null} o.getKey
 */
export function createPulseCloud({ request, getKey, url = CLOUD_URL, apiKey = CLOUD_KEY }) {
  async function call(method, path, body) {
    const key = getKey();
    if (!isSyncKey(key)) throw new Error('Cloud sync is off');
    const res = await request({
      method,
      url: url + path,
      headers: { apikey: apiKey, 'x-sync-key': key, 'content-type': 'application/json', accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status < 200 || res.status >= 300) {
      const msg = res.json && (res.json.message || res.json.error);
      throw new Error(`Cloud answered ${res.status}${msg ? `: ${msg}` : ''}`);
    }
    return res.json;
  }

  return {
    enabled: () => isSyncKey(getKey()),

    async push(rows, volume) {
      let added = 0;
      for (let i = 0; i < Math.max(rows.length, 1); i += PUSH_BATCH) {
        added += Number(await call('POST', '/rest/v1/rpc/pulse_push', { rows: rows.slice(i, i + PUSH_BATCH), volume: i === 0 ? volume : [] })) || 0;
      }
      return added;
    },

    async agg(from, to, bucketMs) {
      const rows = await call('POST', '/rest/v1/rpc/pulse_agg', { from_ms: Math.floor(from), to_ms: Math.ceil(to), bucket_ms: Math.round(bucketMs) });
      return Array.isArray(rows) ? rows.map(cleanAggregate) : [];
    },

    async volume(since) {
      const out = [];
      let after = Math.floor(since) - 1;
      for (;;) {
        const rows = await call('GET', `/rest/v1/pulse_volume?select=ts,cases,upgrades,online&ts=gt.${after}&order=ts.asc&limit=${PAGE}`);
        if (!Array.isArray(rows)) break;
        for (const r of rows) out.push({ ts: Number(r.ts), cases: Number(r.cases), upgrades: Number(r.upgrades), online: Number(r.online) || 0 });
        if (rows.length < PAGE) break;
        after = Number(rows[rows.length - 1].ts);
      }
      return out;
    },
  };
}
