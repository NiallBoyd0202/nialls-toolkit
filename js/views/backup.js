// Backup & restore: export / import each module on its own, or everything in one file.
import { FEATURES } from '../features.js';
import { featureCounts } from '../backup.js';
import { downloadBackup, importFlow, backupLog } from '../backup-ui.js';
import { icon } from '../ui.js';
import { IS_EXT } from '../platform.js';
import { esc, num } from '../util.js';

const ICONS = { settings: 'gear', tracker: 'bolt', ebay: 'pound', returns: 'undo', fbaadmin: 'chart', storescan: 'scan', outreach: 'users' };
const WHAT = {
  outreach: 'Suppliers and where each is in the pipeline, leads, supplier prices, emails and notes, follow-ups, email templates, your outreach settings.',
  settings: 'Keepa key (only if you tick the box above), demo mode, Discord webhook and options, eBay fee estimate.',
  tracker: 'Storefronts you track, their products and history, the product cache, review state.',
  ebay: 'eBay sales and refunds you imported, products and their COGS, import history.',
  returns: 'Every returned unit with its costs, sales and history, SKU costs, unmatched rows, import log, settings.',
  fbaadmin: 'Bank lines and categories, rules, SellerToolkit orders and costs, Amazon reports, payouts and fees, invoices and receipt files, subscriptions, expenses, director\'s loan entries and opening balance, stock value goal, targets, settings.',
};
const when = (iso) => {
  if (!iso) return 'Never exported';
  const d = new Date(iso); const days = Math.floor((Date.now() - d) / 864e5);
  return `Last exported ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}${days === 0 ? ' (today)' : days === 1 ? ' (yesterday)' : ` (${days} days ago)`}`;
};

export async function render(root) {
  const [counts, log] = await Promise.all([featureCounts(), backupLog()]);
  const mods = FEATURES.filter((f) => !f.hidden || counts[f.id]);
  const total = mods.reduce((a, f) => a + (counts[f.id] || 0), 0);
  root.innerHTML = `<div id="bk">
    <div class="backup-hero card">
      <div class="backup-hero-text">
        <div class="eyebrow">${icon('shield', 14)} Everything in one file</div>
        <h2>Back up the whole toolkit</h2>
        <p>${num(total)} records across ${mods.length} modules, plus settings. Your data lives on this device${IS_EXT ? ' (this Chrome profile: removing the extension deletes it)' : ''} and, if sync is on, in your Google Drive. A backup file is still worth keeping: export first, reinstall, then import the file.</p>
        <p class="small">${esc(when(log.all))}</p>
      </div>
      <div class="backup-hero-actions">
        <button class="btn primary big" data-all="export">${icon('download')} Export everything</button>
        <button class="btn big" data-all="import">${icon('upload')} Import everything from a file</button>
        <label class="check small"><input type="checkbox" id="withKeys"> Include API keys and tokens (Keepa key, Google token)</label>
      </div>
    </div>
    <div class="callout warn small section" id="keysWarn" hidden>The file will contain your Keepa key. Anyone with the file could use your Keepa tokens, so keep it somewhere private and don't email it.</div>

    <h4 class="section">Each module on its own</h4>
    <div class="backup-grid">
      ${mods.map((f) => `<div class="card card-pad backup-mod">
        <div class="row"><span class="mod-ic">${icon(ICONS[f.id] || 'list', 18)}</span><div class="grow"><b>${esc(f.label)}</b><div class="small muted">${f.id === 'settings' ? 'app settings' : `${num(counts[f.id] || 0)} records`}</div></div></div>
        <p class="small muted">${esc(WHAT[f.id] || f.description)}</p>
        <div class="small muted">${esc(when(log[f.id]))}</div>
        <div class="row"><button class="btn small primary" data-exp="${f.id}">${icon('download', 14)} Export</button><button class="btn small" data-imp="${f.id}">${icon('upload', 14)} Import</button></div>
      </div>`).join('')}
    </div>

    <div class="grid2 section">
      <div class="card card-pad stack">
        <h3>${icon('refresh')} Reinstalling or moving to another computer</h3>
        <ol class="small" style="margin:0 0 0 18px;line-height:1.7">
          <li>Click <b>Export everything</b> (tick the API keys box if you don't want to type your Keepa key again).</li>
          <li>Remove the extension, or set up Chrome on the new computer, and load the new folder with <i>Load unpacked</i>.</li>
          <li>Open <b>Backup &amp; restore</b> and click <b>Import everything from a file</b>.</li>
          <li>If Google Sheets was connected, add the new redirect address shown in FBA Admin → Settings to your Google OAuth client and click <i>Connect Google</i>.</li>
        </ol>
        <p class="small muted">Updating the extension in the same folder keeps your data: just copy the new files over and click ↻ on <code>chrome://extensions</code>.</p>
      </div>
      <div class="card card-pad stack">
        <h3>${icon('check')} How importing works</h3>
        <p class="small">Importing <b>merges</b>. It adds anything you don't have, keeps the newer copy of anything that's on both sides, and never deletes. Before anything is written you see how many records each module would add or update, and you can untick modules.</p>
        <p class="small muted">So importing an older file, or the same file twice, is safe. A module's own file can only be imported into that module; an "everything" file can go into any of them.</p>
      </div>
    </div></div>`;
  const wk = root.querySelector('#withKeys');
  wk.onchange = () => { root.querySelector('#keysWarn').hidden = !wk.checked; };
  root.querySelector('#bk').addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.all === 'export') { await downloadBackup(FEATURES.map((x) => x.id), { includeSecrets: wk.checked }); render(root); }
    else if (b.dataset.all === 'import') await importFlow();
    else if (b.dataset.exp) { await downloadBackup([b.dataset.exp], { includeSecrets: wk.checked }); render(root); }
    else if (b.dataset.imp) await importFlow(b.dataset.imp);
  });
}
