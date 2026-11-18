// "Check for updates" in the dashboard. Tampermonkey has no API a script can call to update itself,
// so the tracker reads @version from the published file and, when it is newer, opens that file:
// Tampermonkey then shows its own update page.
// raw.githubusercontent.com caches a branch file for up to 5 minutes and ignores query strings, so a
// just-pushed version stays hidden there. The check asks GitHub's API for the branch's newest commit
// and reads the file at that commit, which is never stale. If the API fails (it allows 60 calls an
// hour per IP), the check falls back to the branch file.

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
 * Splits a raw.githubusercontent.com file URL into its parts, or null for any other URL.
 * @param {string} url
 * @returns {{owner: string, repo: string, ref: string, path: string}|null}
 */
export function parseRawUrl(url) {
  const m = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(String(url));
  return m ? { owner: m[1], repo: m[2], ref: m[3], path: m[4] } : null;
}

/** GitHub API address that answers with the newest commit id of a branch (as plain text). */
export function headCommitUrl({ owner, repo, ref }) {
  return `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`;
}

/**
 * The published file at the branch's newest commit, or null when GitHub's API cannot tell.
 * @param {string} url branch URL of the published file
 * @param {(url: string, headers?: Record<string, string>) => Promise<{status: number, text: string}>} request
 */
async function pinnedUrl(url, request) {
  const p = parseRawUrl(url);
  if (!p) return null;
  try {
    const res = await request(`${headCommitUrl(p)}?t=${Date.now()}`, { accept: 'application/vnd.github.sha' });
    const sha = String(res.text ?? '').trim();
    if (res.status < 200 || res.status >= 300 || !/^[0-9a-f]{40}$/.test(sha)) return null;
    return `https://raw.githubusercontent.com/${p.owner}/${p.repo}/${sha}/${p.path}`;
  } catch {
    return null;
  }
}

/**
 * @param {Object} o
 * @param {string} o.url        the published .user.js (branch URL)
 * @param {string} o.current    the running version
 * @param {(url: string, headers?: Record<string, string>) => Promise<{status: number, text: string}>} o.request
 * @returns {Promise<{latest: string, newer: boolean, checkedAt: number, installUrl: string}>}
 *   installUrl: the file that was read (pinned to a commit when the API answered), for Tampermonkey to install
 */
export async function checkForUpdate({ url, current, request }) {
  const pinned = await pinnedUrl(url, request);
  const res = await request(pinned ?? `${url}?t=${Date.now()}`);
  if (res.status < 200 || res.status >= 300) throw new Error(`Update check answered ${res.status}`);
  const latest = headerVersion(res.text);
  if (!latest) throw new Error('The published script has no @version');
  return { latest, newer: compareVersions(latest, current) > 0, checkedAt: Date.now(), installUrl: pinned ?? url };
}
