// Site access for the Node runner: login token upkeep and JSON GETs.
//
// The site keeps two tokens: a short-lived access token (a JWT, sent as "Authorization: Bearer …")
// and a refresh token. Its own web app renews the access token with
//   POST /api/users/auth/refresh  {"refreshToken": "…"}  ->  {"token": "…", "refreshToken"?: "…"}
// and stores a new refresh token when the answer has one. The runner does the same, and saves the
// refresh token it holds after every renewal, so a restart continues with the latest one.
//
// Requests say plainly that they come from a script (see USER_AGENT in pulse-runner.js). Nothing
// here hides that or works around a block: a Cloudflare challenge page or HTTP 403 stops the runner.

import { HttpError } from './collector.js';

/** Seconds since 1970 when a JWT expires, or null when it is not a readable JWT. */
export function jwtExpiry(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return null;
    const json = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return typeof json.exp === 'number' ? json.exp : null;
  } catch {
    return null;
  }
}

/** Renew this long before the access token runs out. */
const EARLY_MS = 60 * 1000;
/** Without a readable expiry, renew after this long. */
const BLIND_MS = 10 * 60 * 1000;

/**
 * @param {Object} o
 * @param {typeof fetch} o.fetch
 * @param {string} o.base  site origin, e.g. https://caser.gg
 * @param {string} o.userAgent
 * @param {{refresh: string, access?: string|null}} o.tokens  starting tokens
 * @param {(t: {refresh: string, access: string|null}) => Promise<void>|void} o.saveTokens
 * @param {() => number} [o.now]
 */
export function createSite({ fetch, base, userAgent, tokens, saveTokens, now = Date.now }) {
  let refresh = tokens.refresh;
  let access = tokens.access ?? null;
  let renewAt = access ? expiryMs(access) : 0;
  let renewing = null;

  function expiryMs(token) {
    const exp = jwtExpiry(token);
    return exp == null ? now() + BLIND_MS : exp * 1000 - EARLY_MS;
  }

  async function renew() {
    renewing ??= (async () => {
      const res = await fetch(`${base}/api/users/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': userAgent },
        body: JSON.stringify({ refreshToken: refresh }),
      });
      const body = await readJson(res);
      if (!res.ok || !body.ok) throw new HttpError(res.ok ? 403 : res.status === 400 ? 401 : res.status, '/api/users/auth/refresh');
      const j = body.json ?? {};
      const next = j.token || j.accessToken || j.access_token;
      if (typeof next !== 'string' || !next) throw new HttpError(401, '/api/users/auth/refresh');
      access = next;
      const r = j.refreshToken || j.refresh_token;
      if (typeof r === 'string' && r) refresh = r;
      renewAt = expiryMs(access);
      await saveTokens({ refresh, access });
    })();
    try {
      await renewing;
    } finally {
      renewing = null;
    }
  }

  async function send(path) {
    return fetch(base + path, { headers: { accept: 'application/json', authorization: `Bearer ${access}`, 'user-agent': userAgent } });
  }

  return {
    renew,
    tokens: () => ({ refresh, access }),

    /** GET a site path ("/api/…"). Throws HttpError on a non-2xx answer or a non-JSON page. */
    async getJson(path) {
      if (!access || now() >= renewAt) await renew();
      let res = await send(path);
      if (res.status === 401) {
        // The access token ran out early or was revoked: renew once and try again.
        await renew();
        res = await send(path);
      }
      const body = await readJson(res);
      if (!res.ok) throw new HttpError(res.status, path.split('?')[0]);
      // A 200 with an HTML page is a challenge or block page, not data.
      if (!body.ok) throw new HttpError(403, path.split('?')[0]);
      return body.json;
    },
  };
}

async function readJson(res) {
  const type = res.headers.get('content-type') || '';
  if (!type.includes('json')) {
    await res.text().catch(() => '');
    return { ok: false, json: null };
  }
  try {
    return { ok: true, json: await res.json() };
  } catch {
    return { ok: false, json: null };
  }
}
