// Settings: Keepa key, demo mode, eBay fee estimate, backup/restore.
import * as db from '../db.js';
import { getSettings, saveSettings, isDemo, APP_NAME } from '../services.js';
import { KeepaClient } from '../keepa.js';
import { icon, toast, confirmBox } from '../ui.js';
import { esc, num } from '../util.js';
import { renderBackupCard } from '../backup-ui.js';

const TRACKER_STORES = ['sellers', 'items', 'products', 'refreshLog'];

async function clearTrackerData() {
  for (const s of TRACKER_STORES) await db.clear(s);
  await db.kvSet('demoState', null);
  await db.kvSet('lastFullRefresh', null);
}

export async function render(root) {
  const s = await getSettings();
  const demo = isDemo(s);
  const sellers = await db.count('sellers');

  const field = (id, label, value, { type = 'number', step = '0.01', hint = '' } = {}) =>
    `<label class="field">${label}<input type="${type}" id="${id}" value="${esc(value ?? '')}" ${type === 'number' ? `step="${step}"` : ''}>${hint ? `<span class="hint">${hint}</span>` : ''}</label>`;
  const check = (id, label, on) => `<label class="check"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}> ${label}</label>`;

  root.innerHTML = `
  <div class="grid2">
    <div class="card card-pad stack">
      <h3>${icon('bolt')} Keepa API</h3>
      ${demo ? '<div class="callout warn small"><b>Demo mode is on.</b> The storefront tracker uses made-up data and spends no tokens. Add your key and untick demo mode when you\'re ready.</div>' : ''}
      <label class="field">API key
        <div class="row"><input type="password" id="keepaKey" class="grow mono" value="${esc(s.keepaKey)}" placeholder="Paste your Keepa API access key" autocomplete="off">
        <button class="btn small" id="showKey" type="button">Show</button></div>
        <span class="hint">Stored only in this browser. Get one at keepa.com → Data → API (needs a paid API plan).</span>
      </label>
      ${check('demoMode', 'Demo mode (sample data, no tokens)', s.demoMode)}
      <div class="row"><button class="btn" id="testKey" type="button">${icon('check')} Test key</button><span class="small" id="testOut"></span></div>
      <details><summary class="small">How many tokens things cost</summary>
        <table class="data small" style="margin-top:8px"><tbody>
          <tr><td>Add / import a storefront</td><td class="r">10</td></tr>
          <tr><td>Refresh a storefront</td><td class="r">10 each</td></tr>
          <tr><td>Details for each new product (price, BSR, offers)</td><td class="r">1 each</td></tr>
        </tbody></table>
        <p class="small muted" style="margin-top:8px">So 30 storefronts with 40 new products between them costs about 340 tokens per daily refresh. Product details are cached for ${s.productCacheHours}h. Keepa refills tokens every minute and keeps up to an hour's worth; if you run out, the refresh waits and carries on automatically.</p>
      </details>
      <div class="form-grid">${field('productCacheHours', 'Reuse product details for (hours)', s.productCacheHours, { step: '1' })}</div>
    </div>

    <div class="card card-pad stack">
      <h3>${icon('ebay')} eBay fee estimate</h3>
      <p class="small muted">Only used for the eBay Orders report, which has no fee data. Transaction reports use the real fees.</p>
      <div class="form-grid">
        ${field('ebayFeePct', 'Final value fee %', +(s.ebayFeePct * 100).toFixed(2), { step: '0.1' })}
        ${field('ebayFeeFixed', 'Per-order fixed fee £', s.ebayFeeFixed)}
      </div>
    </div>
  </div>

  <div class="row section" style="justify-content:flex-end"><button class="btn primary" id="save">${icon('check')} Save settings</button></div>

  <div class="card card-pad stack section" id="backupCard"></div>

  <div class="card card-pad stack section">
    <h3>Danger zone</h3>
    <p class="small muted">${num(sellers)} storefront${sellers === 1 ? '' : 's'} tracked. Export a backup first: these can't be undone.</p>
    <div class="row">
      <button class="btn danger" id="clearTracker">Clear storefront tracker data</button>
      <button class="btn danger solid" id="wipe">Delete everything</button>
    </div>
  </div>`;

  const $ = (id) => root.querySelector(`#${id}`);
  $('showKey').onclick = () => { const i = $('keepaKey'); i.type = i.type === 'password' ? 'text' : 'password'; $('showKey').textContent = i.type === 'password' ? 'Show' : 'Hide'; };

  const collect = () => ({
    keepaKey: $('keepaKey').value.trim(),
    demoMode: $('demoMode').checked,
    productCacheHours: Math.max(0, Number($('productCacheHours').value || 24)),
    ebayFeePct: Number($('ebayFeePct').value || 0) / 100,
    ebayFeeFixed: Number($('ebayFeeFixed').value || 0),
  });

  $('save').onclick = async () => {
    const next = collect();
    const wasDemo = isDemo(s);
    if (!next.demoMode && !next.keepaKey) { toast('Add a Keepa key to switch demo mode off', 'error'); next.demoMode = true; }
    await saveSettings(next);
    window.dispatchEvent(new Event('nt:settings'));
    toast('Settings saved', 'success');
    if (wasDemo && !isDemo(next) && (await db.count('sellers'))) {
      if (await confirmBox('Remove demo data?', 'You\'ve switched to your real Keepa key. Remove the sample storefronts and products so they don\'t mix with real data? (eBay data is kept.)', { okLabel: 'Remove demo data' })) {
        await clearTrackerData();
        toast('Demo data removed');
      }
    }
    render(root);
  };

  $('testKey').onclick = async () => {
    const key = $('keepaKey').value.trim();
    if (!key) return toast('Paste a key first', 'error');
    $('testOut').textContent = 'Checking…';
    try {
      const t = await new KeepaClient(key).tokenStatus();
      $('testOut').innerHTML = `<span class="pos">✓ Key works</span> — ${num(t.tokensLeft)} tokens available, refilling ${num(t.refillRate)}/min`;
    } catch (e) { $('testOut').innerHTML = `<span class="neg">${esc(e.message)}</span>`; }
  };

  renderBackupCard($('backupCard'));
  $('clearTracker').onclick = async () => {
    if (!(await confirmBox('Clear storefront tracker data?', 'Removes all tracked storefronts and their product history. eBay data and settings are kept.', { okLabel: 'Clear', danger: true }))) return;
    await clearTrackerData();
    toast('Cleared');
    render(root);
  };
  $('wipe').onclick = async () => {
    if (!(await confirmBox('Delete everything?', `This permanently deletes all ${APP_NAME} data in this browser, including every feature's data and your settings.`, { okLabel: 'Delete everything', danger: true }))) return;
    await db.wipeAll();
    toast('All data deleted');
    setTimeout(() => location.reload(), 600);
  };
}
