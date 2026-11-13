// Several site accounts in one tracker. Every event carries the userId of the account that made it;
// the dashboard shows one account at a time (or all of them).
//
// Events stored before multi-account support can lack a userId, and the "history read to the end"
// flags were not per account then. Both belong to the "legacy owner": the account that has the most
// events when this version first looks. It is remembered so the answer does not change later.

/** The account an event belongs to. */
export function accountOf(e, legacy) {
  return e?.userId != null && e.userId !== '' ? String(e.userId) : legacy ?? null;
}

/** The userId with the most events, or null when no event has one. */
export function pickLegacyOwner(events) {
  const counts = new Map();
  for (const e of events) {
    if (e?.userId == null || e.userId === '') continue;
    const id = String(e.userId);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  let best = null;
  let bestN = 0;
  for (const [id, n] of counts) {
    if (n > bestN) {
      best = id;
      bestN = n;
    }
  }
  return best;
}

/** Events of one account; `id` null or 'all' keeps everything. */
export function filterByAccount(events, id, legacy) {
  if (id == null || id === 'all') return events;
  return events.filter((e) => accountOf(e, legacy) === id);
}

/**
 * The selection as stored ('current', 'all' or an account id) turned into an account id, 'all',
 * or null (no account known yet: show everything).
 */
export function resolveSelection(selection, currentId, legacy) {
  if (selection === 'all') return 'all';
  if (selection && selection !== 'current') return String(selection);
  return currentId ?? legacy ?? null;
}

/**
 * Accounts to offer in the picker: every account seen in the events or signed in here.
 * @param {any[]} events
 * @param {Record<string, {name?: string|null}>} known  names remembered from the site's /users/me
 * @param {string|null} legacy
 * @param {string|null} currentId  the account signed in on this page
 * @returns {{id: string, name: string, events: number, current: boolean}[]}  signed-in first, then most events
 */
export function listAccounts(events, known, legacy, currentId) {
  const counts = new Map();
  for (const e of events) {
    const id = accountOf(e, legacy);
    if (id != null) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  if (currentId != null && !counts.has(currentId)) counts.set(currentId, 0);
  const list = [...counts].map(([id, n]) => ({
    id,
    name: accountName(id, known),
    events: n,
    current: id === currentId,
  }));
  return list.sort((a, b) => (b.current - a.current) || (b.events - a.events) || a.id.localeCompare(b.id));
}

export function accountName(id, known) {
  const name = known?.[id]?.name;
  return typeof name === 'string' && name.trim() ? name.trim() : `Account ${id}`;
}

/**
 * Join the nicknames kept in this browser with the ones in the cloud.
 * The cloud name wins, except for the account signed in here: its name was just read from the site.
 * @param {Record<string, {name?: string|null}>} known  this browser's names
 * @param {Record<string, string>} cloudNames  the cloud's names
 * @param {string|null} currentId
 * @returns {{known: Record<string, {name: string|null}>, changed: boolean, send: [string, string][]}}
 *   the joined names, whether they differ from `known`, and the names the cloud lacks or has stale
 */
export function mergeNames(known, cloudNames, currentId) {
  const out = { ...known };
  let changed = false;
  const send = [];
  for (const [id, name] of Object.entries(cloudNames ?? {})) {
    const mine = known?.[id]?.name;
    if (id === currentId && typeof mine === 'string' && mine.trim()) continue;
    if (mine !== name) {
      out[id] = { ...out[id], name };
      changed = true;
    }
  }
  for (const [id, v] of Object.entries(known ?? {})) {
    const name = typeof v?.name === 'string' ? v.name.trim() : '';
    if (!name) continue;
    if (cloudNames?.[id] == null || (id === currentId && cloudNames[id] !== name)) send.push([id, name]);
  }
  return { known: out, changed, send };
}

// ---- "History read to the end" flags ----
// Stored as "<stream>:<userId>" (browser and cloud) and "sync:<userId>:<stream>" (IndexedDB meta).
// The legacy owner also counts the old flags without a userId.

export function streamFlag(stream, userId) {
  return `${stream}:${userId}`;
}

/** Whether a list of flags says this account's stream was read to the end. */
export function flagComplete(flags, stream, userId, legacy) {
  if (!Array.isArray(flags) || userId == null) return false;
  return flags.includes(streamFlag(stream, userId)) || (userId === legacy && flags.includes(stream));
}

/** Meta key for a stream's resume point. */
export function progressKey(stream, userId) {
  return `sync:${userId}:${stream}`;
}

/** Flags look like "upgrades" or "upgrades:<userId>". */
export function isStreamFlag(s, streams) {
  if (typeof s !== 'string') return false;
  const i = s.indexOf(':');
  const stream = i < 0 ? s : s.slice(0, i);
  return streams.includes(stream) && (i < 0 || /^[A-Za-z0-9_-]{1,64}$/.test(s.slice(i + 1)));
}
