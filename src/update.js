// "Check for updates" in the dashboard. Tampermonkey has no API a script can call to update itself,
// so the tracker reads @version from the published file and, when it is newer, opens that file:
// Tampermonkey then shows its own update page.

/** @version from a userscript header, or null. */
export function headerVersion(text) {
  const m = /^\/\/\s*@version\s+(\S+)\s*$/m.exec(String(text ?? ''));
  return m ? m[1] : null;
}

/** Compares dotted versions ("0.10.0" > "0.9.2"); missing parts count as 0. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/**
 * @param {Object} o
 * @param {string} o.url        the published .user.js
 * @param {string} o.current    the running version
 * @param {(url: string) => Promise<{status: number, text: string}>} o.request
 * @returns {Promise<{latest: string, newer: boolean, checkedAt: number}>}
 */
export async function checkForUpdate({ url, current, request }) {
  // The query string skips GitHub's few-minute cache, so a just-pushed version shows up.
  const res = await request(`${url}?t=${Date.now()}`);
  if (res.status < 200 || res.status >= 300) throw new Error(`Update check answered ${res.status}`);
  const latest = headerVersion(res.text);
  if (!latest) throw new Error('The published script has no @version');
  return { latest, newer: compareVersions(latest, current) > 0, checkedAt: Date.now() };
}
