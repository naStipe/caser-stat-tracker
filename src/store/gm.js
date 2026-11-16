// The userscript manager's value storage (GM_setValue). It belongs to the script, so every domain
// the script runs on (caser.gg, caser.one) sees the same values. Keep it small: Tampermonkey sends
// all of it to every page load and refuses to start the script once that passes 64 MiB.

/** Keys older versions used to copy every event into (see the 0.13 "shared storage"). */
const OLD_EVENT_KEY = /^ev:/;

/** The manager's storage, or null when the script runs without the GM_* grants. */
export function gmStorage() {
  /* eslint-disable no-undef */
  if (typeof GM_getValue !== 'function' || typeof GM_setValue !== 'function' || typeof GM_listValues !== 'function') return null;
  return {
    get: (k, d) => GM_getValue(k, d),
    set: (k, v) => GM_setValue(k, v),
    del: (k) => (typeof GM_deleteValue === 'function' ? GM_deleteValue(k) : GM_setValue(k, null)),
    list: () => GM_listValues(),
  };
  /* eslint-enable no-undef */
}

/** Delete the event copies older versions kept in script storage. Returns how many keys went. */
export function dropOldEventCopies(gm) {
  if (!gm) return 0;
  let n = 0;
  for (const k of gm.list()) {
    if (!OLD_EVENT_KEY.test(k)) continue;
    gm.del(k);
    n++;
  }
  return n;
}
