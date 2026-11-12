// Owner lock. With a password set, the tracker shows only the signed-in site account to whoever
// opens it ("guest view"). Entering the password shows every account again ("unlocked").
//
// The password is never stored: only a salted PBKDF2 hash. The lock hides data in the tracker's UI;
// it does not encrypt the events, which stay readable with the browser's developer tools.

const ITERATIONS = 200_000;

/** The fixed owner password, stored only as its hash (made with makeLock). */
export const OWNER_LOCK = Object.freeze({
  v: 1,
  salt: 'pN1lTa3Gp2pKpFwxD3aHbg==',
  hash: 'OPT/QrrDLKAvx4SJY6e9Kn7633HFamB3FU+tj96T6Wg=',
  iter: 200000,
});
const MIN_LENGTH = 4;

function toB64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

function fromB64(s) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

/** Why a new password is not accepted, or null when it is fine. */
export function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < MIN_LENGTH) return `Use at least ${MIN_LENGTH} characters.`;
  return null;
}

/** A record to store for this password: {v, salt, hash, iter}. */
export async function makeLock(password) {
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hash = await derive(password, salt, ITERATIONS);
  return { v: 1, salt: toB64(salt), hash: toB64(hash), iter: ITERATIONS };
}

export function isLock(rec) {
  return !!rec && rec.v === 1 && typeof rec.salt === 'string' && typeof rec.hash === 'string' && Number.isInteger(rec.iter) && rec.iter > 0;
}

/** Whether the password matches a stored record. */
export async function checkPassword(rec, password) {
  if (!isLock(rec) || typeof password !== 'string') return false;
  const want = fromB64(rec.hash);
  const got = await derive(password, fromB64(rec.salt), rec.iter);
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}

/**
 * Whether the tracker is in guest view.
 * @param {any} rec  the stored lock record (none: never guest)
 * @param {boolean} unlocked  the password was entered on this page
 * @param {string[]} trusted  accounts the owner chose to stay unlocked for
 * @param {string|null} userId  the signed-in account
 */
export function isGuest(rec, unlocked, trusted, userId) {
  if (!isLock(rec) || unlocked) return false;
  return !(userId != null && Array.isArray(trusted) && trusted.includes(userId));
}
