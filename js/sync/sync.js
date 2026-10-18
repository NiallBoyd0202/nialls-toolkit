// Sync between your devices (Chrome extension, Windows app, iPhone) through your own Google Drive.
//
// How it works:
//   - Each device keeps one compressed file in Drive › "Niall's Toolkit Sync": device-<id>.json.gz, holding
//     everything it has (every record, settings, and the list of what was deleted). Only that device writes it,
//     so two devices never fight over one file.
//   - A sync reads the other devices' files (only the ones that changed since last time) and merges them in:
//     for each record the newest change wins (`_mt`, stamped by db.js on every write); a deletion wins over
//     anything older than it; settings merge field by field (`ft`). Then it writes its own file if anything
//     changed here since it last did.
//   - Invoice and receipt files travel separately: once each, as their own Drive file.
//   - API keys and the Google client secret stay on each device unless you tick "Sync my API keys".
// Your data never goes anywhere but your own Google Drive.

import * as db from '../db.js';
import { SECRETS, TOMB_STORE, KV_STORE } from '../features.js';
import { appVersion, defaultDeviceName } from '../platform.js';
import { stamp } from '../backup.js';
import { ensureFolderPath, listFiles, downloadBlob, putFile, getToken } from '../fbaadmin/google.js';

export const SYNC_FOLDER = "Niall's Toolkit Sync";
const FORMAT = 'nt-sync-1';
const STATE_KEY = 'local.sync';
const DEVICE_KEY = 'local.device';
const TOMB_KEEP_DAYS = 180;
const BLOBS_PER_RUN = 12;

// ---------------------------------------------------------------------------
// This device and its sync state (never synced themselves)
// ---------------------------------------------------------------------------
export async function device() {
  let d = await db.kvGet(DEVICE_KEY);
  if (!d?.id) { d = { id: crypto.randomUUID().slice(0, 12), name: defaultDeviceName(), at: Date.now() }; await db.kvSet(DEVICE_KEY, d); }
  return d;
}
export async function renameDevice(name) {
  const d = await device();
  await db.kvSet(DEVICE_KEY, { ...d, name: String(name || '').trim().slice(0, 40) || defaultDeviceName() });
  await db.kvSet('local.dirtyAt', Date.now()); // re-upload so the other devices see the new name
}

const DEFAULT_STATE = { enabled: false, syncSecrets: false, folderId: '', fileId: '', lastUploadAt: 0, lastSyncAt: 0, lastError: '', seen: {}, devices: [], joinedAt: 0 };
export async function syncState() { return { ...DEFAULT_STATE, ...(await db.kvGet(STATE_KEY, {})) }; }
async function saveState(patch) { const s = { ...(await syncState()), ...patch }; await db.kvSet(STATE_KEY, s); return s; }
export async function setSyncOptions(patch) {
  const s = await saveState(patch);
  if ('syncSecrets' in patch) await db.kvSet('local.dirtyAt', Date.now());
  emit({ state: s.enabled ? 'idle' : 'off' });
  return s;
}

// ---------------------------------------------------------------------------
// Status for the UI
// ---------------------------------------------------------------------------
const listeners = new Set();
let lastStatus = { state: 'off' };
export function onSyncStatus(fn) { listeners.add(fn); fn(lastStatus); return () => listeners.delete(fn); }
function emit(s) { lastStatus = s; listeners.forEach((fn) => { try { fn(s); } catch { /* ignore */ } }); }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const mt = (r) => (typeof r?._mt === 'number' ? r._mt : stamp(r));
const keyOf = (name, key) => `${name}|${JSON.stringify(key)}`;

async function gzip(text) {
  return new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
}
async function gunzip(blob) {
  return new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();
}
async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(bin)}`;
}

// Secret fields are left out of the file entirely (not blanked), so they never overwrite another device's.
function withoutSecrets(row) {
  const fields = SECRETS[row.k];
  if (!fields?.length || !db.isPlainObject(row.v)) return row;
  const v = { ...row.v }; const ft = { ...(row.ft || {}) };
  for (const f of fields) { delete v[f]; delete ft[f]; }
  return { ...row, v, ft };
}

// ---------------------------------------------------------------------------
// Building this device's file
// ---------------------------------------------------------------------------
export async function buildSnapshot({ syncSecrets = false } = {}) {
  const defs = db.storeDefs();
  const stores = {};
  for (const name of Object.keys(defs)) {
    if (name === KV_STORE || name === TOMB_STORE) continue;
    let rows = await db.getAll(name);
    // receipt files travel on their own; the record says where to fetch it
    if (name === 'faInvoices') rows = rows.map(({ dataUrl, ...r }) => ({ ...r, hasFile: !!(dataUrl || r.hasFile) }));
    stores[name] = rows;
  }
  const kv = (await db.getAll(KV_STORE)).filter((r) => !String(r.k).startsWith(db.LOCAL_PREFIX)).map((r) => (syncSecrets ? r : withoutSecrets(r)));
  const tombs = await db.getAll(TOMB_STORE);
  const d = await device();
  return { format: FORMAT, app: 'nialls-toolkit', device: { id: d.id, name: d.name }, at: Date.now(), appVersion: appVersion(), dbVersion: db.DB_VERSION, stores, kv, tombs };
}

// ---------------------------------------------------------------------------
// Merging another device's file into this one. Returns { records, settings, deleted, stores: Set }.
// ---------------------------------------------------------------------------
function mergeKvRow(loc, inc) {
  if (!loc) return inc;
  if (db.isPlainObject(loc.v) && db.isPlainObject(inc.v)) {
    const lt = db.fieldTimes(loc); const it = db.fieldTimes(inc);
    const v = {}; const ft = {};
    for (const f of new Set([...Object.keys(loc.v), ...Object.keys(inc.v)])) {
      const a = f in loc.v ? (lt[f] || 0) : -1;
      const b = f in inc.v ? (it[f] || 0) : -1;
      if (b > a) { v[f] = inc.v[f]; if (b > 0) ft[f] = b; } else { if (f in loc.v) v[f] = loc.v[f]; if (a > 0) ft[f] = a; }
    }
    return { k: loc.k, v, ft, _mt: Math.max(loc._mt || 0, inc._mt || 0) };
  }
  return (inc._mt || 0) > (loc._mt || 0) ? inc : loc;
}

export async function applySnapshot(snap) {
  const defs = db.storeDefs();
  const out = { records: 0, settings: 0, deleted: 0, stores: new Set() };
  const changes = {};
  const ch = (n) => (changes[n] ||= { put: [], del: [] });

  // deletions first
  const tombs = new Map((await db.getAll(TOMB_STORE)).map((t) => [t.id, t]));
  const incomingTombs = [];
  for (const t of snap.tombs || []) {
    if (!defs[t.store] || t.store === TOMB_STORE) continue;
    incomingTombs.push(t);
    const mine = tombs.get(t.id);
    if (!mine || mine.at < t.at) { ch(TOMB_STORE).put.push(t); tombs.set(t.id, t); }
  }

  const localCache = new Map();
  const localOf = async (name) => {
    if (!localCache.has(name)) { const kp = defs[name].keyPath; localCache.set(name, new Map((await db.getAll(name)).map((r) => [JSON.stringify(r[kp]), r]))); }
    return localCache.get(name);
  };

  // records: the newest change wins, unless it was deleted after that change
  for (const [name, rows] of Object.entries(snap.stores || {})) {
    const def = defs[name];
    if (!def || name === KV_STORE || name === TOMB_STORE || !Array.isArray(rows)) continue;
    const local = await localOf(name);
    for (const inc of rows) {
      const key = inc?.[def.keyPath];
      if (key === undefined || key === null) continue;
      const ks = JSON.stringify(key);
      const t = tombs.get(keyOf(name, key));
      if (t && t.at >= mt(inc)) continue;
      const loc = local.get(ks);
      if (loc && (mt(inc) < mt(loc) || (mt(inc) === mt(loc) && JSON.stringify(inc) <= JSON.stringify(loc)))) continue;
      let rec = inc;
      if (name === 'faInvoices') { const { hasFile, ...r } = inc; rec = { ...r, ...(loc?.dataUrl ? { dataUrl: loc.dataUrl } : {}), ...(hasFile ? { hasFile } : {}) }; }
      ch(name).put.push(rec); local.set(ks, rec); out.records++; out.stores.add(name);
      if (t) { ch(TOMB_STORE).del.push(t.id); tombs.delete(t.id); } // changed again after it was deleted: it's back
    }
  }

  // records this device still has that another device deleted later
  for (const t of incomingTombs) {
    if (!tombs.has(t.id)) continue; // overruled above
    const local = await localOf(t.store);
    const loc = local.get(JSON.stringify(t.key));
    if (loc && mt(loc) <= t.at) { ch(t.store).del.push(t.key); local.delete(JSON.stringify(t.key)); out.deleted++; out.stores.add(t.store); }
  }

  // settings, field by field
  const localKv = new Map((await db.getAll(KV_STORE)).map((r) => [r.k, r]));
  for (const inc of snap.kv || []) {
    if (!inc || typeof inc.k !== 'string' || inc.k.startsWith(db.LOCAL_PREFIX)) continue;
    const loc = localKv.get(inc.k);
    const merged = mergeKvRow(loc, inc);
    if (loc && JSON.stringify(merged) === JSON.stringify(loc)) continue;
    ch(KV_STORE).put.push(merged); out.settings++;
  }

  await db.rawApply(changes);
  return out;
}

// ---------------------------------------------------------------------------
// Receipt files
// ---------------------------------------------------------------------------
async function pushInvoiceFiles(clientId, folderId) {
  const invs = (await db.getAll('faInvoices')).filter((i) => i.dataUrl && !i.driveId && !i.syncBlobId).slice(0, BLOBS_PER_RUN);
  for (const inv of invs) {
    const blob = await (await fetch(inv.dataUrl)).blob();
    const f = await putFile(clientId, { name: `invoice-${inv.id}`, parentId: folderId, blob, mime: inv.mime || blob.type, appProperties: { app: 'nialls-toolkit', invoice: String(inv.id) } });
    await db.put('faInvoices', { ...inv, syncBlobId: f.id });
  }
  return invs.length;
}

async function pullInvoiceFiles(clientId) {
  const s = (await db.kvGet('fbaAdminSettings')) || {};
  if (s.invoiceStorage === 'drive') return 0; // "Drive only": every device opens them from Drive
  const want = (await db.getAll('faInvoices')).filter((i) => !i.dataUrl && (i.syncBlobId || (i.driveId && i.hasFile))).slice(0, BLOBS_PER_RUN);
  let n = 0;
  for (const inv of want) {
    try {
      const blob = await downloadBlob(clientId, inv.syncBlobId || inv.driveId);
      const cur = await db.get('faInvoices', inv.id);
      if (cur && !cur.dataUrl) { await db.rawPut('faInvoices', { ...cur, dataUrl: await blobToDataUrl(blob.type ? blob : new Blob([blob], { type: inv.mime || '' })) }); n++; }
    } catch (e) { if (e.status !== 404) throw e; }
  }
  return n;
}

// ---------------------------------------------------------------------------
// One sync run
// ---------------------------------------------------------------------------
let running = null;
const withLock = (fn) => (navigator.locks?.request ? navigator.locks.request('nt-sync', { ifAvailable: true }, (lock) => (lock ? fn() : { skipped: 'busy' })) : fn());

// Returns { applied, from: [device names], uploaded, files } or { skipped }.
export function syncNow({ force = false, reason = 'manual' } = {}) {
  if (running) return running;
  running = withLock(() => run({ force, reason })).finally(() => { running = null; });
  return running;
}

async function run({ force }) {
  let st = await syncState();
  if (!st.enabled) { emit({ state: 'off' }); return { skipped: 'off' }; }
  const fa = (await db.kvGet('fbaAdminSettings')) || {};
  const cid = fa.googleClientId;
  emit({ state: 'syncing' });
  try {
    if (!cid) throw Object.assign(new Error('Set up Google in FBA Admin → Settings first'), { signedOut: true });
    try { await getToken(cid); } catch (e) { throw Object.assign(e, { signedOut: true }); }
    const me = await device();
    const { id: folderId } = await ensureFolderPath(cid, [SYNC_FOLDER], st.folderId ? { [SYNC_FOLDER]: st.folderId } : {});
    const files = await listFiles(cid, folderId);
    const deviceFiles = files.filter((f) => /^device-.+\.json\.gz$/.test(f.name));
    const mine = deviceFiles.find((f) => f.appProperties?.deviceId === me.id || f.name === `device-${me.id}.json.gz`);
    const seen = { ...st.seen };

    // 1. bring in what the other devices changed
    const result = { applied: 0, deleted: 0, settings: 0, from: [], uploaded: false, files: 0, stores: new Set() };
    for (const f of deviceFiles) {
      if (f === mine || seen[f.id] === f.modifiedTime) continue;
      const snap = JSON.parse(await gunzip(await downloadBlob(cid, f.id)));
      if (snap?.format !== FORMAT || snap.device?.id === me.id) { seen[f.id] = f.modifiedTime; continue; }
      const r = await applySnapshot(snap);
      seen[f.id] = f.modifiedTime;
      result.applied += r.records; result.deleted += r.deleted; result.settings += r.settings;
      r.stores.forEach((x) => result.stores.add(x));
      if (r.records || r.deleted || r.settings) result.from.push(snap.device?.name || 'another device');
    }
    st = await saveState({ folderId, seen, joinedAt: st.joinedAt || Date.now() });

    // 2. receipt files this device has that the others don't
    const pushedFiles = await pushInvoiceFiles(cid, folderId);

    // 3. this device's own file, if anything changed here since the last upload
    const dirtyAt = (await db.kvGet('local.dirtyAt')) || 0;
    if (force || !mine || pushedFiles || dirtyAt > (st.lastUploadAt || 0)) {
      const t0 = Date.now();
      const snap = await buildSnapshot({ syncSecrets: st.syncSecrets });
      const blob = await gzip(JSON.stringify(snap));
      const f = await putFile(cid, { fileId: mine?.id || null, name: `device-${me.id}.json.gz`, parentId: folderId, blob, mime: 'application/gzip', appProperties: { app: 'nialls-toolkit', deviceId: me.id, deviceName: me.name.slice(0, 60), appVersion: appVersion() } });
      seen[f.id] = f.modifiedTime;
      st = await saveState({ fileId: f.id, lastUploadAt: t0, seen });
      result.uploaded = true;
    }

    // 4. receipt files from the other devices
    result.files = await pullInvoiceFiles(cid);

    // 5. forget deletions old enough that every device has seen them
    const cutoff = Date.now() - TOMB_KEEP_DAYS * 864e5;
    const old = (await db.getAll(TOMB_STORE)).filter((t) => t.at < cutoff).map((t) => t.id);
    if (old.length) await db.rawApply({ [TOMB_STORE]: { del: old } });

    const fresh = await listFiles(cid, folderId, 'id,name,modifiedTime,size,appProperties');
    const devices = fresh.filter((f) => /^device-/.test(f.name)).map((f) => ({ id: f.appProperties?.deviceId || f.name, name: f.appProperties?.deviceName || 'Device', at: Date.parse(f.modifiedTime) || 0, size: Number(f.size) || 0, version: f.appProperties?.appVersion || '', me: f.appProperties?.deviceId === me.id }));
    await saveState({ lastSyncAt: Date.now(), lastError: '', devices });
    emit({ state: 'idle', at: Date.now(), result });
    return result;
  } catch (e) {
    await saveState({ lastError: e.message, lastErrorAt: Date.now() });
    emit({ state: e.signedOut ? 'signed-out' : 'error', error: e.message });
    throw e;
  }
}

// Leaves this device's file in Drive (the other devices keep everything); only stops syncing here.
export async function disableSync() {
  return setSyncOptions({ enabled: false });
}
