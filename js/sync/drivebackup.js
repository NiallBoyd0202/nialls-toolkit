// Automatic backups to your Google Drive: a dated "Export everything" file once a week, kept forever, in
// Drive › "Niall's Toolkit Backups". It's your undo: sync copies mistakes (a deletion) to every device, a backup
// doesn't. Restoring merges, like importing a backup file: it puts back what's missing and never deletes.
//
// Whichever device is open first when a backup is due makes it, after a sync so it knows if another device
// already has. The schedule and "last backup" are shared settings, so every device shows the same.
// API keys are never in it.
import * as db from '../db.js';
import { FEATURES } from '../features.js';
import { exportFeatures } from '../backup.js';
import { appVersion } from '../platform.js';
import { ensureFolderPath, listFiles, putFile, downloadBlob, getToken } from '../fbaadmin/google.js';
import { device, syncNow, syncState, gzip, gunzip } from './sync.js';

export const BACKUP_FOLDER = "Niall's Toolkit Backups";
const KEY = 'driveBackup';
const DEFAULTS = { enabled: true, everyDays: 7, lastAt: 0, lastName: '', lastDevice: '', lastSize: 0, folderId: '' };

export async function backupSettings() { return { ...DEFAULTS, ...(await db.kvGet(KEY, {})) }; }
export async function saveBackupSettings(patch) {
  const cur = await backupSettings();
  await db.kvSet(KEY, { ...cur, ...patch, savedAt: Date.now() }, { fields: db.changedFields(cur, patch) });
}

const clientId = async () => ((await db.kvGet('fbaAdminSettings')) || {}).googleClientId || '';
const stamp = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`; };

async function folder(cid) {
  const s = await backupSettings();
  const { id } = await ensureFolderPath(cid, [BACKUP_FOLDER], s.folderId ? { [BACKUP_FOLDER]: s.folderId } : {});
  if (id !== s.folderId) await saveBackupSettings({ folderId: id });
  return id;
}

export async function backupNow() {
  const cid = await clientId();
  if (!cid) throw new Error('Connect Google first (Devices & sync)');
  await getToken(cid);
  const data = await exportFeatures(FEATURES.map((f) => f.id), { includeSecrets: false });
  const records = Object.values(data.features).reduce((n, f) => n + Object.values(f.stores).reduce((m, rows) => m + rows.length, 0), 0);
  const blob = await gzip(JSON.stringify(data));
  const me = await device();
  const name = `nialls-toolkit_backup_${stamp()}.json.gz`;
  await putFile(cid, { name, parentId: await folder(cid), blob, mime: 'application/gzip', appProperties: { app: 'nialls-toolkit', kind: 'backup', device: me.name.slice(0, 60), records: String(records), appVersion: appVersion() } });
  await saveBackupSettings({ lastAt: Date.now(), lastName: name, lastDevice: me.name, lastSize: blob.size });
  return { name, records, size: blob.size };
}

let busy = false;
// Called every hour while the app (or Chrome with the extension) is open. Never throws.
export async function maybeBackup() {
  if (busy) return { done: false, why: 'busy' };
  busy = true;
  try {
    const due = (s) => s.enabled && Date.now() - (s.lastAt || 0) >= s.everyDays * 864e5;
    if (!due(await backupSettings()) || !(await clientId())) return { done: false, why: 'not due' };
    // another device may have just made it: check with them first
    if ((await syncState()).enabled) { try { await syncNow({ reason: 'backup' }); } catch { /* back up anyway */ } }
    if (!due(await backupSettings())) return { done: false, why: 'done elsewhere' };
    return { done: true, ...(await backupNow()) };
  } catch (e) { return { done: false, why: e.message }; } finally { busy = false; }
}

// Newest first: { id, name, at, size, device, records }
export async function listBackups() {
  const cid = await clientId();
  if (!cid) return [];
  const files = await listFiles(cid, await folder(cid), 'id,name,modifiedTime,size,appProperties');
  return files.filter((f) => /^nialls-toolkit_backup_/.test(f.name))
    .map((f) => ({ id: f.id, name: f.name, at: Date.parse(f.modifiedTime) || 0, size: Number(f.size) || 0, device: f.appProperties?.device || '', records: Number(f.appProperties?.records) || null }))
    .sort((a, b) => b.at - a.at);
}

export async function readBackup(fileId) {
  return JSON.parse(await gunzip(await downloadBlob(await clientId(), fileId)));
}
