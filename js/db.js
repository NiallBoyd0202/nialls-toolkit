// IndexedDB wrapper shared by the dashboard and the background service worker.
// Everything is stored locally in this browser profile (or app), and copied between your devices by sync/.
// Which stores exist (and which feature owns them) is declared in features.js.
//
// For sync, every write stamps the record with `_mt` (when it last changed, ms) and every delete leaves a
// tombstone in `syncTomb`, so a record deleted on one device isn't brought back by another.
// The raw* functions write exactly what they're given (no stamp, no tombstone): only sync uses them.
import { allStores, TOMB_STORE } from './features.js';

const DB_NAME = 'nialls-toolkit';
// v1: storefront tracker + eBay. v2: Returns tracker, Store Scan, FBA Admin stores. v3: FBA Admin sold products.
// v4: FBA Admin SellerToolkit expenses. v5: inventory ledger + listings. v6: Amazon settlements.
// v7: expense tracker + Amazon inventory age (FBA Inventory report). v8: director's loan entries.
// v9: sync tombstones. v10: retailer & wholesaler outreach. v11: cash-flow daily targets and payout predictions.
// v12: spend log. v13: Start Up Loan.
export const DB_VERSION = 13;

const STORES = allStores();

// kv keys starting with this never leave the device (sync state, device id, Google sign-in).
export const LOCAL_PREFIX = 'local.';

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      // Additive only: creates missing stores and indexes, never deletes data.
      const db = req.result;
      for (const [name, def] of Object.entries(STORES)) {
        const os = db.objectStoreNames.contains(name)
          ? req.transaction.objectStore(name)
          : db.createObjectStore(name, { keyPath: def.keyPath, autoIncrement: !!def.autoIncrement });
        for (const [idx, path] of def.indexes || []) {
          if (!os.indexNames.contains(idx)) os.createIndex(idx, path, { unique: false });
        }
      }
    };
    // Another tab opened a newer version: let it upgrade, and reload this one when asked.
    req.onsuccess = () => { const db = req.result; db.onversionchange = () => { db.close(); dbPromise = null; }; resolve(db); };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Close the toolkit\'s other tabs or windows, then reload'));
  });
  return dbPromise;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Write aborted'));
  });
}

async function store(name, mode = 'readonly') {
  const db = await openDB();
  return db.transaction(name, mode).objectStore(name);
}

// ---------------------------------------------------------------------------
// Change tracking (sync uploads when something changed since its last upload)
// ---------------------------------------------------------------------------
const listeners = new Set();
export function onLocalChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
let dirtyTimer = null;
function touched() {
  if (dirtyTimer) return;
  dirtyTimer = setTimeout(async () => {
    dirtyTimer = null;
    try { await rawPut('kv', { k: `${LOCAL_PREFIX}dirtyAt`, v: Date.now() }); } catch { /* best effort */ }
    listeners.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
  }, 400);
}

// Auto-numbered stores get ids that can't clash with a record made on another device at the same time.
let seq = 0;
const uniqueId = () => Date.now() * 1000 + (seq++ % 1000);

function prepare(name, v) {
  const def = STORES[name];
  const out = { ...v, _mt: Date.now() };
  if (def?.autoIncrement && (out[def.keyPath] === undefined || out[def.keyPath] === null)) out[def.keyPath] = uniqueId();
  return out;
}

const tombId = (name, key) => `${name}|${JSON.stringify(key)}`;
const tomb = (name, key, at = Date.now()) => ({ id: tombId(name, key), store: name, key, at });

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
export async function get(name, key) {
  return wrap((await store(name)).get(key));
}

export async function getAll(name) {
  return wrap((await store(name)).getAll());
}

export async function getAllKeys(name) {
  return wrap((await store(name)).getAllKeys());
}

export async function getAllByIndex(name, index, value) {
  return wrap((await store(name)).index(index).getAll(value));
}

export async function count(name) {
  return wrap((await store(name)).count());
}

// ---------------------------------------------------------------------------
// Writes (stamped, tracked)
// ---------------------------------------------------------------------------
export async function put(name, value) {
  const key = await wrap((await store(name, 'readwrite')).put(prepare(name, value)));
  touched();
  return key;
}

// Bulk write in a single transaction (much faster for thousands of rows).
export async function putMany(name, values) {
  if (!values.length) return;
  const db = await openDB();
  const tx = db.transaction(name, 'readwrite');
  const os = tx.objectStore(name);
  for (const v of values) os.put(prepare(name, v));
  await done(tx);
  touched();
}

// Several stores in ONE transaction: either every write lands or none do.
// writes = { storeName: [records] }
export async function putAcross(writes) {
  const names = Object.keys(writes).filter((n) => writes[n] && writes[n].length);
  if (!names.length) return;
  const db = await openDB();
  const tx = db.transaction(names, 'readwrite');
  for (const n of names) { const os = tx.objectStore(n); for (const v of writes[n]) os.put(prepare(n, v)); }
  await done(tx);
  touched();
}

export async function del(name, key) {
  return delMany(name, [key]);
}

export async function delMany(name, keys) {
  if (!keys.length) return;
  const db = await openDB();
  const tx = db.transaction([name, TOMB_STORE], 'readwrite');
  const os = tx.objectStore(name); const ts = tx.objectStore(TOMB_STORE);
  const at = Date.now();
  for (const k of keys) { os.delete(k); ts.put(tomb(name, k, at)); }
  await done(tx);
  touched();
}

export async function clear(name) {
  return delMany(name, await getAllKeys(name));
}

// ---- key/value settings ----
// Settings objects remember when each field last changed (`ft`), so sync merges them field by field:
// a new phone saving one setting doesn't overwrite everything else you set on the computer.
export const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// When each field of a kv row last changed. Rows saved before v2.0 count every field as changed when they were saved.
export function fieldTimes(row) {
  if (!row || !isPlainObject(row.v)) return {};
  if (row.ft) return row.ft;
  const t = Number(row.v.savedAt) || row._mt || 0;
  return t ? Object.fromEntries(Object.keys(row.v).map((f) => [f, t])) : {};
}

export async function kvGet(k, fallback = undefined) {
  const row = await get('kv', k);
  return row ? row.v : fallback;
}
// The fields of a settings patch that really change something (plus savedAt), for kvSet's `fields`.
export const changedFields = (cur, patch) => [...Object.keys(patch).filter((f) => JSON.stringify(cur?.[f]) !== JSON.stringify(patch[f])), 'savedAt'];

// fields: the fields this save changes (a settings patch). Without it, fields whose value differs from before count as changed.
export async function kvSet(k, v, { fields = null } = {}) {
  if (String(k).startsWith(LOCAL_PREFIX)) return rawPut('kv', { k, v });
  const now = Date.now();
  const row = { k, v, _mt: now };
  if (isPlainObject(v)) {
    const prev = await get('kv', k);
    const before = fieldTimes(prev);
    const ft = {};
    for (const f of Object.keys(v)) {
      const changed = fields ? fields.includes(f) : !!prev && JSON.stringify(prev.v?.[f]) !== JSON.stringify(v[f]);
      if (changed) ft[f] = now; else if (before[f]) ft[f] = before[f];
    }
    row.ft = ft;
  }
  await rawPut('kv', row);
  touched();
}

export const STORE_NAMES = Object.keys(STORES).filter((n) => n !== TOMB_STORE);

// Backup / restore lives in backup.js (per feature, merge on import).

// Clears this device only: no tombstones, so your other devices keep their copy.
export async function wipeAll() {
  const db = await openDB();
  const names = Object.keys(STORES);
  const tx = db.transaction(names, 'readwrite');
  for (const n of names) tx.objectStore(n).clear();
  await done(tx);
}

// ---------------------------------------------------------------------------
// Raw access for sync: exactly what's given, no stamp, no tombstone, no change event.
// ---------------------------------------------------------------------------
export async function rawPut(name, value) {
  return wrap((await store(name, 'readwrite')).put(value));
}

// { store: { put: [records], del: [keys] } } in one transaction.
export async function rawApply(changes) {
  const names = Object.keys(changes).filter((n) => STORES[n] && ((changes[n].put || []).length || (changes[n].del || []).length));
  if (!names.length) return;
  const db = await openDB();
  const tx = db.transaction(names, 'readwrite');
  for (const n of names) {
    const os = tx.objectStore(n);
    for (const v of changes[n].put || []) os.put(v);
    for (const k of changes[n].del || []) os.delete(k);
  }
  await done(tx);
}

export const storeDefs = () => STORES;
