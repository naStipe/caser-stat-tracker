// Alerts to your phone or chat through a webhook URL (ALERT_URL). The format follows the service:
//   Discord   https://discord.com/api/webhooks/<id>/<token>
//   Telegram  https://api.telegram.org/bot<token>/sendMessage?chat_id=<chat id>
//   ntfy      https://ntfy.sh/<topic>   (or a self-hosted ntfy server)
//   other     POST {"title", "text"} as JSON
// The database watchdog (monitor_send_alert in the *_monitor_report migration) sends the same formats.

/** The request for one alert: {url, body} with a JSON body. */
export function alertRequest(url, title, message) {
  const u = new URL(url);
  const text = `${title}\n${message}`;
  if (/^(discord|discordapp)\.com$/.test(u.hostname) && u.pathname.startsWith('/api/webhooks/')) {
    return { url, body: { content: text.slice(0, 1900) } };
  }
  if (u.hostname === 'api.telegram.org') {
    return { url: `${u.origin}${u.pathname}`, body: { chat_id: u.searchParams.get('chat_id'), text } };
  }
  if (u.hostname === 'ntfy.sh' || u.pathname.includes('/ntfy/')) {
    const parts = u.pathname.split('/').filter(Boolean);
    const topic = parts.pop();
    return { url: `${u.origin}/${parts.join('/')}${parts.length ? '/' : ''}`, body: { topic, title, message, priority: 4 } };
  }
  return { url, body: { title, text: message } };
}

/**
 * @param {Object} o
 * @param {typeof fetch} o.fetch
 * @param {string|null} o.url  ALERT_URL; without it, alerts only go to the log
 * @param {(...a: any[]) => void} [o.log]
 * @param {() => number} [o.now]
 * @param {number} [o.quietMs]  the same code is sent at most once per this long
 */
export function createNotifier({ fetch, url, log = console.log, now = Date.now, quietMs = 30 * 60 * 1000 }) {
  const lastSent = new Map();
  return {
    enabled: () => !!url,
    /** Sends unless the same code went out within quietMs (force skips that). Never throws. */
    async send(code, title, message, { force = false } = {}) {
      if (!url) return false;
      const t = now();
      if (!force && t - (lastSent.get(code) ?? -Infinity) < quietMs) return false;
      lastSent.set(code, t);
      try {
        const req = alertRequest(url, title, message);
        const res = await fetch(req.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req.body), signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return true;
      } catch (e) {
        log(`Sending an alert failed: ${e?.message ?? e}`);
        return false;
      }
    },
  };
}
