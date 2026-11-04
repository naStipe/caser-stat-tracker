// Wraps the page's fetch and XMLHttpRequest so every /api/ response can be inspected.
// The site's API client looks up the global `fetch` at call time, so wrapping it once is enough.
// The hook never changes requests or responses: it reads a clone and passes the original through.

/**
 * @typedef {Object} ApiExchange
 * @property {string} method
 * @property {string} path      path after /api, e.g. "/game/upgrade/bet"
 * @property {string} url
 * @property {any} reqBody      parsed JSON request body, or null
 * @property {string|null} [auth] Authorization header the site sent (kept in memory only, for history import)
 * @property {number} status
 * @property {any} resBody      parsed JSON response body, or null
 * @property {number} serverTs  server Date header in ms, else Date.now()
 */

/**
 * @param {Window} win
 * @param {(ex: ApiExchange) => void} onExchange
 */
export function installHook(win, onExchange) {
  if (win.__caserTrackerHooked) return { origFetch: win.__caserTrackerHooked.origFetch };

  const emit = (ex) => {
    try {
      onExchange(ex);
    } catch (err) {
      console.warn('[caser-tracker] handler error', err);
    }
  };

  const origFetch = win.fetch.bind(win);
  win.__caserTrackerHooked = { origFetch };
  win.fetch = async function (input, init) {
    const response = await origFetch(input, init);
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
      const path = apiPath(url, win.location.origin);
      if (path) {
        const method = (init?.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase();
        const reqBody = parseJson(init?.body);
        const auth = headerValue(init?.headers, 'authorization');
        const clone = response.clone();
        clone
          .text()
          .then((text) => emit({ method, path, url, reqBody, auth, status: response.status, resBody: parseJson(text), serverTs: dateHeader(response.headers.get('date')) }))
          .catch(() => {});
      }
    } catch {
      // Never break the site.
    }
    return response;
  };

  const XHR = win.XMLHttpRequest;
  if (XHR) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      this.__ct = { method: String(method).toUpperCase(), url: String(url) };
      return open.apply(this, arguments);
    };
    XHR.prototype.send = function (body) {
      const meta = this.__ct;
      const path = meta && apiPath(meta.url, win.location.origin);
      if (path) {
        this.addEventListener('load', () => {
          try {
            const text = this.responseType === '' || this.responseType === 'text' ? this.responseText : null;
            emit({ method: meta.method, path, url: meta.url, reqBody: parseJson(body), status: this.status, resBody: parseJson(text), serverTs: dateHeader(this.getResponseHeader('date')) });
          } catch {}
        });
      }
      return send.apply(this, arguments);
    };
  }
  return { origFetch };
}

/** Returns the path after "/api" for same-origin API calls, else null. */
export function apiPath(url, origin) {
  if (!url) return null;
  try {
    const u = new URL(url, origin);
    if (u.origin !== origin) return null;
    const m = u.pathname.match(/^\/api(\/.*)$/);
    return m ? m[1] + u.search : null;
  } catch {
    return null;
  }
}

function headerValue(headers, name) {
  if (!headers) return null;
  try {
    if (typeof headers.get === 'function') return headers.get(name);
    if (Array.isArray(headers)) return headers.find(([k]) => k.toLowerCase() === name)?.[1] ?? null;
    for (const k of Object.keys(headers)) if (k.toLowerCase() === name) return headers[k];
  } catch {}
  return null;
}

function parseJson(v) {
  if (typeof v !== 'string' || v === '') return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

function dateHeader(h) {
  const t = h ? Date.parse(h) : NaN;
  return Number.isFinite(t) ? t : Date.now();
}
