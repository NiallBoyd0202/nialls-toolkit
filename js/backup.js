// Per-feature backup: Export all / Import all for each feature, plus "everything".
//
// Import always MERGES, it never deletes:
//   - a record that isn't here yet is added
//   - a record that exists on both sides is replaced only if the incoming copy is newer
//     (by its updatedAt / lastRefresh / fetchedAt / at … timestamps); otherwise yours is kept
//   - auto-numbered records (import logs) that clash with a different local record are renumbered,
//     and the records that point at them are updated to match
//   - secrets (API keys, tokens) are never written to a file, and never overwritten by an import
//
// File format (format 2):
//   { app: 'nialls-toolkit', format: 2, kind: '<featureId>' | 'all', appVersion, dbVersion, exportedAt,
//     features: { <featureId>: { label, kv: { key: value }, stores: { storeName: [records] } } } }
// Also accepted: the old single-file backup (format 1) and the standalone FBA Returns Tracker backup.

import * as db from './db.js';
import { FEATURES, SECRETS, feature, featureOfStore, featureOfKv } from './features.js';
import { appVersion } from './platform.js';

export const BACKUP_APP = 'nialls-toolkit';
export const BACKUP_FORMAT = 2;

function stripSecrets(k, v) {
  const fields = SECRETS[k];
  if (!fields || !fields.length || !v || typeof v !== 'object') return v;
  const out = { ...v };
  for (const f of fields) if (f in out) out[f] = '';
  return out;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
export async function exportFeatures(ids = FEATURES.map((f) => f.id), { includeSecrets = false } = {}) {
  const out = {
    app: BACKUP_APP, format: BACKUP_FORMAT,
    kind: ids.length === 1 ? ids[0] : 'all',
    appVersion: appVersion(), dbVersion: db.DB_VERSION,
    exportedAt: new Date().toISOString(), withKeys: !!includeSecrets,
    features: {},
  };
  for (const id of ids) {
    const f = feature(id);
    if (!f) continue;
    const block = { label: f.label, kv: {}, stores: {} };
    for (const k of f.kv) {
      const v = await db.kvGet(k);
      if (v !== undefined && v !== null) block.kv[k] = includeSecrets ? v : stripSecrets(k, v);
    }
    for (const name of Object.keys(f.stores)) block.stores[name] = await db.getAll(name);
    out.features[id] = block;
  }
  return out;
}

export function backupFileName(kind, { withKeys = false } = {}) {
  return `nialls-toolkit_${kind}${withKeys ? '_WITH-KEYS' : ''}_${new Date().toISOString().slice(0, 10)}.json`;
}

// Record counts per feature, for the backup screens.
export async function featureCounts() {
  const out = {};
  for (const f of FEATURES) {
    let n = 0;
    for (const name of Object.keys(f.stores)) n += await db.count(name);
    out[f.id] = n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading a file -> normalised { features: { id: { kv, stores } }, source, exportedAt, ignored: [] }
// ---------------------------------------------------------------------------
export function normaliseBackup(data) {
  if (!data || typeof data !== 'object') throw new Error('This file is not a backup (not JSON data)');

  // Current format
  if (data.app === BACKUP_APP && data.format === BACKUP_FORMAT && data.features) {
    const features = {};
    const ignored = [];
    for (const [id, block] of Object.entries(data.features)) {
      const f = feature(id);
      if (!f) { ignored.push(id); continue; }
      features[id] = { kv: block.kv || {}, stores: {} };
      for (const [name, rows] of Object.entries(block.stores || {})) {
        if (name in f.stores && Array.isArray(rows)) features[id].stores[name] = rows;
        else ignored.push(name);
      }
    }
    return { features, source: `Niall's Toolkit backup (${data.kind === 'all' ? 'everything' : feature(data.kind)?.label || data.kind})`, exportedAt: data.exportedAt, ignored };
  }

  // Old single-file backup from v1.0: { app, version, exportedAt, stores: { name: rows } }
  if (data.app === BACKUP_APP && data.stores) {
    const features = {};
    const ignored = [];
    const block = (id) => (features[id] ||= { kv: {}, stores: {} });
    for (const [name, rows] of Object.entries(data.stores)) {
      if (!Array.isArray(rows)) continue;
      if (name === 'kv') {
        for (const r of rows) {
          const f = featureOfKv(r.k);
          if (f) block(f.id).kv[r.k] = r.v; else ignored.push(r.k);
        }
        continue;
      }
      const f = featureOfStore(name);
      if (f) block(f.id).stores[name] = rows; else ignored.push(name);
    }
    return { features, source: "Niall's Toolkit backup (v1.0 format)", exportedAt: data.exportedAt, ignored };
  }

  // Standalone FBA Returns Tracker export: { exportedAt, units, skucosts, imports, unmatched, kv }
  if (Array.isArray(data.units) && (Array.isArray(data.skucosts) || Array.isArray(data.imports))) {
    const kvRows = Array.isArray(data.kv) ? data.kv : [];
    const settings = {};
    for (const r of kvRows) if (r && r.key !== undefined) settings[r.key] = r.value;
    return {
      features: {
        returns: {
          kv: Object.keys(settings).length ? { returnsSettings: settings } : {},
          stores: {
            rtUnits: data.units || [],
            rtSkuCosts: data.skucosts || [],
            rtImports: data.imports || [],
            rtUnmatched: data.unmatched || [],
          },
        },
      },
      source: 'FBA Returns Tracker backup (standalone extension)',
      exportedAt: data.exportedAt,
      ignored: [],
    };
  }

  throw new Error("This file isn't a Niall's Toolkit or Returns Tracker backup");
}

// ---------------------------------------------------------------------------
// Merge planning
// ---------------------------------------------------------------------------
// _mt: set by db.js on every write (since v2.0); the rest are older records' own dates.
const STAMP_FIELDS = ['_mt', 'updatedAt', 'savedAt', 'lastRefresh', 'removedAt', 'keepaLastSeen', 'fetchedAt', 'statusDate', 'at', 'addedAt', 'firstSeen', 'createdAt'];

function toMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v) { const t = Date.parse(v); return Number.isFinite(t) ? t : 0; }
  return 0;
}

export function stamp(r) {
  let best = 0;
  for (const f of STAMP_FIELDS) best = Math.max(best, toMs(r?.[f]));
  return best;
}

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
const same = (a, b) => stable(a) === stable(b);

// Merge one store. Returns { writes: [records], add, update, skip, invalid }.
function mergeStore(def, localRows, incomingRows) {
  const kp = def.keyPath;
  const local = new Map(localRows.map((r) => [r[kp], r]));
  const res = { writes: [], add: 0, update: 0, skip: 0, invalid: 0 };
  for (const inc of incomingRows) {
    const key = inc?.[kp];
    if (key === undefined || key === null || key === '') { res.invalid++; continue; }
    const loc = local.get(key);
    if (!loc) { res.writes.push(inc); local.set(key, inc); res.add++; continue; }
    const newer = stamp(inc) > stamp(loc) ? inc : loc;
    const merged = def.merge ? def.merge(loc, inc, newer) : newer;
    if (same(merged, loc)) { res.skip++; continue; }
    res.writes.push(merged); local.set(key, merged); res.update++;
  }
  return res;
}

// Auto-numbered stores: an incoming id that is used locally by a *different* record gets a new id,
// and every record in `refs` that pointed at the old id is pointed at the new one.
function renumber(def, name, localRows, block) {
  const kp = def.keyPath;
  const local = new Map(localRows.map((r) => [r[kp], r]));
  let next = Math.max(0, ...localRows.map((r) => Number(r[kp]) || 0), ...(block.stores[name] || []).map((r) => Number(r[kp]) || 0)) + 1;
  const remap = new Map();
  block.stores[name] = (block.stores[name] || []).map((inc) => {
    const loc = local.get(inc[kp]);
    if (!loc) return inc;
    const sameRecord = (loc.at && loc.at === inc.at) || same(loc, inc);
    if (sameRecord) return inc;
    const id = next++;
    remap.set(inc[kp], id);
    return { ...inc, [kp]: id };
  });
  if (!remap.size) return 0;
  for (const [refStore, field] of def.refs || []) {
    if (!block.stores[refStore]) continue;
    block.stores[refStore] = block.stores[refStore].map((r) => (remap.has(r[field]) ? { ...r, [field]: remap.get(r[field]) } : r));
  }
  return remap.size;
}

function mergeKv(k, local, incoming) {
  const secrets = SECRETS[k] || [];
  const keepSecrets = (v) => {
    if (!local || typeof local !== 'object' || !v || typeof v !== 'object') return v;
    const out = { ...v };
    for (const f of secrets) out[f] = local[f] || v[f] || '';
    return out;
  };
  if (local === undefined || local === null) return { value: incoming, changed: incoming !== undefined && incoming !== null };
  if (typeof local === 'number' && typeof incoming === 'number') return { value: Math.max(local, incoming), changed: incoming > local };
  if (local && typeof local === 'object' && !Array.isArray(local) && incoming && typeof incoming === 'object' && !Array.isArray(incoming)) {
    let value;
    if (toMs(incoming.savedAt) > toMs(local.savedAt)) value = keepSecrets({ ...local, ...incoming });
    else { // yours is newer (or neither is dated): only fill in settings you don't have
      value = { ...local };
      for (const [f, v] of Object.entries(incoming)) if (!(f in value) && !secrets.includes(f)) value[f] = v;
    }
    return { value, changed: !same(value, local) };
  }
  return { value: local, changed: false };
}

// Dry run: works out what an import would do, without writing anything.
export async function planImport(normalised, onlyIds = null) {
  const plan = { features: {}, totals: { add: 0, update: 0, skip: 0, invalid: 0, renumbered: 0 } };
  for (const [id, src] of Object.entries(normalised.features)) {
    if (onlyIds && !onlyIds.includes(id)) continue;
    const f = feature(id);
    const block = { kv: { ...src.kv }, stores: { ...src.stores } };
    const fp = { label: f.label, stores: {}, kv: [], add: 0, update: 0, skip: 0, invalid: 0, renumbered: 0 };

    const names = Object.keys(block.stores).sort((a, b) => Number(!!f.stores[b].autoIncrement) - Number(!!f.stores[a].autoIncrement));
    const localByStore = {};
    for (const name of names) localByStore[name] = await db.getAll(name);
    for (const name of names) {
      if (f.stores[name].autoIncrement) fp.renumbered += renumber(f.stores[name], name, localByStore[name], block);
    }
    for (const name of names) {
      const r = mergeStore(f.stores[name], localByStore[name], block.stores[name]);
      fp.stores[name] = r;
      for (const k of ['add', 'update', 'skip', 'invalid']) fp[k] += r[k];
    }
    for (const [k, v] of Object.entries(block.kv)) {
      const r = mergeKv(k, await db.kvGet(k), v);
      if (r.changed) fp.kv.push({ k, v: r.value });
    }
    plan.features[id] = fp;
    for (const k of ['add', 'update', 'skip', 'invalid', 'renumbered']) plan.totals[k] += fp[k];
  }
  return plan;
}

// Writes a plan from planImport. Each store is written in one transaction.
export async function applyImport(plan) {
  for (const fp of Object.values(plan.features)) {
    for (const [name, r] of Object.entries(fp.stores)) if (r.writes.length) await db.putMany(name, r.writes);
    for (const { k, v } of fp.kv) await db.kvSet(k, v);
  }
  return plan.totals;
}

export async function importBackup(data, { only = null } = {}) {
  return applyImport(await planImport(normaliseBackup(data), only));
}
