// Dashboard web server: the page, and the numbers it shows as JSON.
//   GET /              dashboard (public/index.html)
//   GET /api/summary   {summary, status, info}
//   GET /healthz       "ok" (no password, for container health checks)
// With a password, every other path needs HTTP Basic auth (any user name).

import { createServer as httpServer } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';

const sameText = (a, b) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

/** True when the Authorization header carries the password. */
export function authorized(header, password) {
  if (!password) return true;
  const m = /^Basic\s+(.+)$/i.exec(header || '');
  if (!m) return false;
  const text = Buffer.from(m[1], 'base64').toString('utf8');
  const i = text.indexOf(':');
  return i >= 0 && sameText(text.slice(i + 1), password);
}

/**
 * @param {Object} o
 * @param {() => any} o.snapshot  what /api/summary returns
 * @param {string} o.html  the dashboard page
 * @param {string|null} o.password
 */
export function createServer({ snapshot, html, password }) {
  return httpServer((req, res) => {
    const path = (req.url || '/').split('?')[0];
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, headers).end();
      return;
    }
    if (path === '/healthz') {
      res.writeHead(200, { ...headers, 'content-type': 'text/plain' }).end('ok');
      return;
    }
    if (!authorized(req.headers.authorization, password)) {
      res.writeHead(401, { ...headers, 'www-authenticate': 'Basic realm="Pulse monitor", charset="UTF-8"' }).end('Password needed');
      return;
    }
    if (path === '/') {
      res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'" }).end(html);
      return;
    }
    if (path === '/api/summary') {
      let body;
      try {
        body = JSON.stringify(snapshot());
      } catch (e) {
        res.writeHead(500, { ...headers, 'content-type': 'application/json' }).end(JSON.stringify({ error: String(e?.message ?? e) }));
        return;
      }
      res.writeHead(200, { ...headers, 'content-type': 'application/json' }).end(body);
      return;
    }
    res.writeHead(404, headers).end('Not found');
  });
}
