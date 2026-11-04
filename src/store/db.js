// IndexedDB storage. Data lives in the site's origin, in this browser only.
// Stores: events (keyPath id), raw (unrecognized or failed API payloads for debugging), meta (key/value).

const DB_NAME = 'caser-tracker';
const DB_VERSION = 1;
const RAW_LIMIT = 300;

export class Store {
  /** @param {IDBFactory} idb */
  constructor(idb) {
    this.idb = idb;
    this.dbPromise = null;
  }

  open() {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const req = this.idb.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('events')) {
            const s = db.createObjectStore('events', { keyPath: 'id' });
            s.createIndex('ts', 'ts');
          }
          if (!db.objectStoreNames.contains('raw')) db.createObjectStore('raw', { autoIncrement: true });
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return this.dbPromise;
  }

  async tx(stores, mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode);
      let result;
      Promise.resolve(fn(t)).then((r) => (result = r), reject);
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  /**
   * Insert or merge events. Returns how many were new.
   * A stored event is only replaced when the incoming one is better:
   * a resolved upgrade replaces a pending one, and live data wins over imported data.
   */
  async putEvents(events) {
    if (!events.length) return 0;
    return this.tx(['events'], 'readwrite', async (t) => {
      const s = t.objectStore('events');
      let added = 0;
      for (const ev of events) {
        const old = await req(s.get(ev.id));
        if (!old) {
          s.put(ev);
          added++;
        } else if (shouldReplace(old, ev)) {
          s.put(mergeEvent(old, ev));
        }
      }
      return added;
    });
  }

  async allEvents() {
    const list = await this.tx(['events'], 'readonly', (t) => req(t.objectStore('events').getAll()));
    return list.sort((a, b) => a.ts - b.ts);
  }

  async clearEvents() {
    await this.tx(['events', 'raw'], 'readwrite', (t) => {
      t.objectStore('events').clear();
      t.objectStore('raw').clear();
    });
  }

  async addRaw(entry) {
    await this.tx(['raw'], 'readwrite', async (t) => {
      const s = t.objectStore('raw');
      s.add({ ...entry, savedAt: Date.now() });
      const count = await req(s.count());
      if (count > RAW_LIMIT) {
        const keys = await req(s.getAllKeys(null, count - RAW_LIMIT));
        for (const k of keys) s.delete(k);
      }
    });
  }

  async allRaw() {
    return this.tx(['raw'], 'readonly', (t) => req(t.objectStore('raw').getAll()));
  }

  async getMeta(key) {
    return this.tx(['meta'], 'readonly', (t) => req(t.objectStore('meta').get(key)));
  }

  async setMeta(key, value) {
    await this.tx(['meta'], 'readwrite', (t) => {
      t.objectStore('meta').put(value, key);
    });
  }
}

export function shouldReplace(old, incoming) {
  if (old.kind === 'upgrade' && old.status === 'pending' && incoming.status !== 'pending') return true;
  // A deposit is often seen pending first, then completed; take the later, settled state.
  if (old.kind === 'deposit' && incoming.kind === 'deposit') {
    if (old.status !== 'completed' && incoming.status === 'completed') return true;
    if (old.completedTs == null && incoming.completedTs != null) return true;
  }
  if (old.source === 'import' && incoming.source === 'live') return true;
  return false;
}

/** Keep the live timestamp and balances, take the resolved outcome. */
export function mergeEvent(old, incoming) {
  const live = old.source === 'live' ? old : incoming;
  return {
    ...old,
    ...incoming,
    ts: live.ts,
    source: live.source,
    balanceBefore: live.balanceBefore ?? old.balanceBefore ?? incoming.balanceBefore,
    balanceAfter: live.balanceAfter ?? old.balanceAfter ?? incoming.balanceAfter,
  };
}

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
