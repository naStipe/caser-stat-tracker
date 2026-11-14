// Local storage of the site pulse: its own IndexedDB database, apart from the user's events.
// Stores: rows (keyPath id, index ts) and volume (keyPath ts). Kept for KEEP_MS, then pruned.

const DB_NAME = 'caser-pulse';
const DB_VERSION = 1;
export const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

const req = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

export function createPulseStore(idb) {
  let dbp = null;
  const open = () =>
    (dbp ??= new Promise((resolve, reject) => {
      const r = idb.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('rows')) db.createObjectStore('rows', { keyPath: 'id' }).createIndex('ts', 'ts');
        if (!db.objectStoreNames.contains('volume')) db.createObjectStore('volume', { keyPath: 'ts' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }));

  async function tx(stores, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode);
      let out;
      Promise.resolve(fn(t)).then((v) => (out = v), reject);
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  return {
    /** Adds rows not stored yet. Returns how many were new. */
    putRows(rows) {
      return tx(['rows'], 'readwrite', async (t) => {
        const s = t.objectStore('rows');
        let added = 0;
        for (const r of rows) {
          if (await req(s.getKey(r.id))) continue;
          s.put(r);
          added++;
        }
        return added;
      });
    },
    putVolume(sample) {
      return tx(['volume'], 'readwrite', (t) => void t.objectStore('volume').put(sample));
    },
    /** Rows and volume samples with ts >= since. */
    async since(since) {
      return tx(['rows', 'volume'], 'readonly', async (t) => ({
        rows: await req(t.objectStore('rows').index('ts').getAll(IDBKeyRange.lowerBound(since))),
        volume: await req(t.objectStore('volume').getAll(IDBKeyRange.lowerBound(since))),
      }));
    },
    /** Deletes everything older than KEEP_MS. */
    prune(now = Date.now()) {
      const range = IDBKeyRange.upperBound(now - KEEP_MS, true);
      return tx(['rows', 'volume'], 'readwrite', (t) => {
        t.objectStore('volume').delete(range);
        const c = t.objectStore('rows').index('ts').openCursor(range);
        c.onsuccess = () => {
          const cur = c.result;
          if (cur) {
            cur.delete();
            cur.continue();
          }
        };
      });
    },
    clear() {
      return tx(['rows', 'volume'], 'readwrite', (t) => {
        t.objectStore('rows').clear();
        t.objectStore('volume').clear();
      });
    },
  };
}
