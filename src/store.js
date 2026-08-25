/* ====================================================================
   store.js — IndexedDB blob store for re-downloadable copies.
   --------------------------------------------------------------------
   Copies used to be base64'd into the encrypted history record and pushed
   into localStorage, which caps at roughly 5 MB for the WHOLE origin — so
   "keep the 20 most recent files" could never actually hold 20 real files,
   and base64 inflated every one by a third on the way in.

   IndexedDB stores binary natively and its quota is a share of free disk,
   so copies are limited by the setting rather than by the browser. Blobs are
   still encrypted with the network key before they are written, so the
   "encrypted at rest" promise holds.
   ==================================================================== */
const DB_NAME = "streamlined";
const DB_VERSION = 1;
const STORE = "copies";
const META = "meta";

let _db = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    if (typeof indexedDB === "undefined") return rej(new Error("no indexedDB"));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    req.onsuccess = () => { _db = req.result; res(_db); };
    req.onerror = () => rej(req.error);
  });
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    try { out = fn(s); } catch (e) { rej(e); return; }
    // IDBRequest carries the value on .result — including `undefined` for a
    // miss, which must NOT be reported as the request object itself.
    t.oncomplete = () => res(out && typeof out === "object" && "result" in out ? out.result : out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  }));
}

export const Store = {
  available() { return typeof indexedDB !== "undefined"; },
  put(id, value) { return tx(STORE, "readwrite", (s) => s.put(value, id)); },
  get(id) { return tx(STORE, "readonly", (s) => s.get(id)); },
  del(id) { return tx(STORE, "readwrite", (s) => s.delete(id)); },
  keys() { return tx(STORE, "readonly", (s) => s.getAllKeys()); },
  clear() { return tx(STORE, "readwrite", (s) => s.clear()); },
  putMeta(k, v) { return tx(META, "readwrite", (s) => s.put(v, k)); },
  getMeta(k) { return tx(META, "readonly", (s) => s.get(k)); },

  /* Roughly how much room the browser will give us, when it will say. */
  async quota() {
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const e = await navigator.storage.estimate();
        return { usage: e.usage || 0, quota: e.quota || 0 };
      }
    } catch { /* not supported */ }
    return null;
  }
};
