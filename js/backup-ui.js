// Backup screens: the per-feature Backup button (top bar) and the Backup & data card in Settings.
import { FEATURES, feature } from './features.js';
import { exportFeatures, backupFileName, featureCounts, normaliseBackup, planImport, applyImport } from './backup.js';
import { icon, toast, modal } from './ui.js';
import { esc, num, downloadFile, dateTimeStr } from './util.js';
import * as db from './db.js';

// When each feature (and everything) was last exported, for the Backup & restore page. Kept in this browser only.
export const BACKUP_LOG = 'backupLog';
export async function backupLog() { return (await db.kvGet(BACKUP_LOG)) || {}; }

export async function downloadBackup(ids, { includeSecrets = false } = {}) {
  const data = await exportFeatures(ids, { includeSecrets });
  const kind = data.kind;
  const records = Object.values(data.features).reduce((n, f) => n + Object.values(f.stores).reduce((m, rows) => m + rows.length, 0), 0);
  downloadFile(backupFileName(kind, { withKeys: includeSecrets }), JSON.stringify(data), 'application/json');
  const log = await backupLog(); const at = new Date().toISOString();
  for (const id of ids) log[id] = at;
  if (kind === 'all') log.all = at;
  await db.kvSet(BACKUP_LOG, log);
  toast(`Backup downloaded · ${num(records)} records${ids.includes('settings') ? (includeSecrets ? ' · includes your API keys: keep the file private' : ' (your API keys are not included)') : ''}`, 'success', 6000);
}

function pickFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = () => resolve(input.files[0] || null);
    input.click();
  });
}

// Read a file, show what merging it would do, then import the features the user keeps ticked.
export async function importFlow(onlyFeatureId = null) {
  const file = await pickFile();
  if (!file) return;
  let norm;
  try { norm = normaliseBackup(JSON.parse(await file.text())); } catch (e) { toast(e.message || 'Could not read that file', 'error'); return; }

  const inFile = Object.keys(norm.features);
  if (onlyFeatureId && !inFile.includes(onlyFeatureId)) {
    toast(`That file has no ${feature(onlyFeatureId).label} data in it`, 'error');
    return;
  }
  const ids = onlyFeatureId ? [onlyFeatureId] : inFile;
  const plan = await planImport(norm, ids);

  const rows = ids.map((id) => {
    const p = plan.features[id];
    const notes = [];
    if (p.kv.length) notes.push(`${p.kv.length} setting${p.kv.length === 1 ? '' : 's'}`);
    if (p.renumbered) notes.push(`${p.renumbered} renumbered`);
    if (p.invalid) notes.push(`${p.invalid} unreadable`);
    return `<tr>
      <td><label class="check"><input type="checkbox" data-feat="${id}" ${p.add + p.update + p.kv.length ? 'checked' : ''}> ${esc(p.label)}</label></td>
      <td class="r pos">${num(p.add)}</td><td class="r">${num(p.update)}</td><td class="r muted">${num(p.skip)}</td>
      <td class="small muted">${esc(notes.join(' · '))}</td></tr>`;
  }).join('');

  modal({
    title: 'Import backup',
    wide: true,
    body: `<p class="small muted">${esc(norm.source)}${norm.exportedAt ? ` · exported ${esc(dateTimeStr(Date.parse(norm.exportedAt)))}` : ''} · ${esc(file.name)}</p>
      <div class="callout small" style="margin:10px 0">Importing <b>merges</b>: new records are added, and a record you already have is only replaced if the copy in the file is newer. Nothing is deleted.</div>
      <table class="data"><thead><tr><th>Feature</th><th class="r">New</th><th class="r">Newer in file</th><th class="r">Already up to date</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      ${norm.ignored.length ? `<p class="small muted" style="margin-top:8px">Skipped (not part of this version): ${esc(norm.ignored.join(', '))}</p>` : ''}`,
    actions: [
      { label: 'Cancel' },
      {
        label: 'Import', kind: 'primary',
        onClick: async (el) => {
          const keep = [...el.querySelectorAll('[data-feat]')].filter((c) => c.checked).map((c) => c.dataset.feat);
          if (!keep.length) { toast('Nothing ticked to import'); return false; }
          const chosen = { ...plan, features: Object.fromEntries(keep.map((id) => [id, plan.features[id]])) };
          try {
            await applyImport(chosen);
          } catch (e) { toast(`Import failed: ${e.message}`, 'error'); return false; }
          const t = keep.reduce((acc, id) => ({ add: acc.add + chosen.features[id].add, update: acc.update + chosen.features[id].update }), { add: 0, update: 0 });
          toast(`Imported · ${num(t.add)} added, ${num(t.update)} updated`, 'success');
          setTimeout(() => location.reload(), 700);
          return true;
        },
      },
    ],
  });
}

// Top-bar Backup button: export / import for the feature on screen, plus everything.
export async function openBackupModal(featureId) {
  const f = feature(featureId);
  const counts = await featureCounts();
  const m = modal({
    title: f ? `Backup · ${f.label}` : 'Backup',
    body: `<div class="stack">
      ${f ? `<p class="small muted">${esc(f.description)}</p>
      <p><b>${num(counts[featureId] || 0)}</b> records in ${esc(f.label)}.</p>
      <div class="row">
        <button class="btn primary" data-act="export">${icon('download')} Export all ${esc(f.label)} data</button>
        <button class="btn" data-act="import">${icon('upload')} Import ${esc(f.label)} data</button>
      </div><hr class="sep">` : ''}
      <div class="row">
        <button class="btn" data-act="export-all">${icon('download')} Export everything</button>
        <button class="btn" data-act="import-all">${icon('upload')} Import a backup file</button>
      </div>
      <p class="small muted">Your data lives only in this Chrome profile, and removing the extension deletes it. Export before reinstalling, then import afterwards. Imports merge and never delete anything.</p>
    </div>`,
  });
  m.body.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'export') await downloadBackup([featureId]);
    if (act === 'export-all') await downloadBackup(FEATURES.map((x) => x.id));
    if (act === 'import') { m.close(); await importFlow(featureId); }
    if (act === 'import-all') { m.close(); await importFlow(); }
  });
}

// Settings → Backup & data: one row per feature.
export async function renderBackupCard(container) {
  container.innerHTML = `
    <div class="row"><h3 class="grow">${icon('download')} Backup & data</h3><a class="btn small" href="#backup">Open Backup &amp; restore</a></div>
    <p class="small muted">Everything lives in this Chrome profile, and removing the extension deletes it. Export before you reinstall or update, then import afterwards. Importing <b>merges</b>: it adds what's missing, keeps the newer copy of anything on both sides, and never deletes. API keys and tokens are left out unless you choose to include them on Backup &amp; restore.</p>
    <div class="row">
      <button class="btn primary" data-all="export">${icon('download')} Export everything</button>
      <button class="btn" data-all="import">${icon('upload')} Import a backup file</button>
    </div>
    <p class="small muted">To export or import a single module, open <a href="#backup">Backup &amp; restore</a>, or use the <b>Backup</b> button at the top of any page.</p>`;
  container.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.all === 'export') await downloadBackup(FEATURES.map((x) => x.id));
    else if (b.dataset.all === 'import') await importFlow();
    else if (b.dataset.exp) await downloadBackup([b.dataset.exp]);
    else if (b.dataset.imp) await importFlow(b.dataset.imp);
  };
}
