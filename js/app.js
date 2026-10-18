// Dashboard shell: navigation, routing, token meter, pending-seller imports, sync between devices.
// The same page runs as the Chrome extension's dashboard and as the installable web app (platform.js).
import * as db from './db.js';
import { getSettings, onTokens, isDemo, keepa, refreshSellers, forgetCachedSettings } from './services.js';
import { icon, toast } from './ui.js';
import { openBackupModal } from './backup-ui.js';
import { num } from './util.js';
import { IS_WEB, IS_STANDALONE, appUrl, openAppTab, onRuntimeMessage, persistStorage } from './platform.js';
import { completeWebSignIn } from './fbaadmin/google.js';
import { startAutoSync, syncIndicator } from './sync/auto.js';
import { handleSetupLink } from './views/sync.js';
import { maybeBackup } from './sync/drivebackup.js';
import { handleAmazonLink } from './links.js';

// `feature` ties a page to its entry in features.js (used by the Backup button).
const ROUTES = [
  { group: 'Storefront tracker' },
  { id: 'tracker/new', label: 'New products', icon: 'bolt', module: './views/tracker.js', tab: 'new', title: 'Storefront tracker', feature: 'tracker' },
  { id: 'tracker/storefronts', label: 'Storefronts', icon: 'store', module: './views/tracker.js', tab: 'storefronts', title: 'Storefront tracker', feature: 'tracker' },
  { group: 'Sourcing' },
  { id: 'outreach', label: 'Outreach', icon: 'users', module: './views/outreach.js', title: 'Retailer & wholesaler outreach', feature: 'outreach' },
  { id: 'pricelists', label: 'Price lists', icon: 'scan', module: './views/pricelists.js', title: 'Supplier price lists', feature: 'storescan' },
  { id: 'leads', label: 'Lead sheet', icon: 'list', module: './views/leadsheet.js', title: 'Lead sheet' },
  { group: 'Returns' },
  { id: 'returns', label: 'FBA Returns tracker', icon: 'undo', module: './views/returns.js', title: 'FBA Returns tracker', feature: 'returns' },
  { group: 'Accounting' },
  { id: 'fbaadmin', label: 'FBA Admin', icon: 'chart', module: './views/fbaadmin.js', title: 'FBA Admin', feature: 'fbaadmin' },
  // Store Scan (Sourcing) is parked for now: its storage stays in features.js so it can be switched back on later.
  { group: 'eBay' },
  { id: 'ebay', label: 'eBay profit tracker', icon: 'pound', module: './views/ebay.js', title: 'eBay profit tracker', feature: 'ebay' },
  { group: 'Personal' },
  { id: 'loans', label: 'Start Up Loan', icon: 'wallet', module: './views/loans.js', title: 'Start Up Loan', feature: 'loans' },
  { group: '' },
  { id: 'sync', label: 'Devices & sync', icon: 'cloud', module: './views/sync.js', title: 'Devices & sync' },
  { id: 'backup', label: 'Backup & restore', icon: 'shield', module: './views/backup.js', title: 'Backup & restore' },
  { id: 'settings', label: 'Settings', icon: 'gear', module: './views/settings.js', title: 'Settings', feature: 'settings' },
];
const DEFAULT_ROUTE = 'tracker/new';

const view = document.getElementById('view');
const nav = document.getElementById('nav');
let currentCleanup = null;
let currentFeature = null;

// Opened in Chrome's side panel (dashboard.html?panel=1) rather than a full tab.
const IN_PANEL = new URLSearchParams(location.search).has('panel');
if (IN_PANEL) document.body.classList.add('in-panel');

function renderNav(active, counts = {}) {
  nav.innerHTML = ROUTES.map((r) => {
    if (r.group !== undefined) return r.group ? `<div class="nav-group">${r.group}</div>` : '<div style="height:10px"></div>';
    const isActive = active === r.id || active.startsWith(r.id + '/');
    const c = counts[r.id] ? `<span class="count">${counts[r.id]}</span>` : '';
    return `<a class="nav-item ${isActive ? 'active' : ''}" href="#${r.id}" title="${r.label}" aria-label="${r.label}">${icon(r.icon, 18)}<span>${r.label}</span>${c}</a>`;
  }).join('');
}

export async function refreshBadges() {
  const items = await db.getAll('items');
  const unreviewed = items.filter((i) => !i.baseline && !i.reviewed && !i.removedAt).length;
  // FBA Admin: reports due or overdue (the monthly reminder)
  let reportsDue = 0;
  try {
    const [{ loadAll }, { guideStatus, overdueCount }, { presetRange }] = await Promise.all([import('./fbaadmin/store.js'), import('./fbaadmin/guide.js'), import('./fbaadmin/pnl.js')]);
    const data = await loadAll();
    reportsDue = overdueCount(guideStatus(data, { fyFrom: presetRange('this_fy', { fyStart: data.settings.fyStart }).from }));
  } catch { /* badge is best-effort */ }
  let followUps = 0;
  try { followUps = await (await import('./views/outreach.js')).dueCount(); } catch { /* best-effort */ }
  renderNav(location.hash.slice(1) || DEFAULT_ROUTE, { 'tracker/new': unreviewed || '', fbaadmin: reportsDue || '', outreach: followUps || '' });
}

async function updateDemoBadge() {
  document.getElementById('demoBadge').hidden = !isDemo(await getSettings());
}

function tokenMeter() {
  const el = document.getElementById('tokens');
  onTokens((t) => {
    if (t.demo) { el.innerHTML = `${icon('bolt', 14)} Demo tokens <b>${num(t.tokensLeft)}</b>`; return; }
    if (t.waiting) {
      el.innerHTML = `<span class="wait">${icon('refresh', 14)} ${t.reason || 'Waiting'} · ${Math.ceil((t.waitLeft || 0) / 1000)}s</span>`;
      return;
    }
    el.innerHTML = `${icon('bolt', 14)} Keepa tokens <b>${t.tokensLeft === null || t.tokensLeft === undefined ? '—' : num(t.tokensLeft)}</b>${t.refillRate ? ` <span>+${t.refillRate}/min</span>` : ''}`;
  });
}

async function route({ keepScroll = false } = {}) {
  const scrollY = keepScroll ? window.scrollY : 0;
  const hash = location.hash.slice(1) || DEFAULT_ROUTE;
  const r = ROUTES.find((x) => x.id === hash) || ROUTES.find((x) => x.id && hash.startsWith(x.id + '/')) || ROUTES.find((x) => x.id === DEFAULT_ROUTE);
  document.getElementById('pageTitle').textContent = r.title;
  currentFeature = r.feature || null;
  document.title = `${r.title} · Niall's Toolkit`;
  document.querySelector('.sidebar').classList.remove('open');
  if (currentCleanup) { try { currentCleanup(); } catch { /* ignore */ } currentCleanup = null; }
  view.innerHTML = '<div class="muted">Loading…</div>';
  try {
    const mod = await import(r.module);
    const sub = hash.startsWith(r.id + '/') ? hash.slice(r.id.length + 1) : '';
    currentCleanup = await mod.render(view, { tab: r.tab, sub, feature: r.feature, inPanel: IN_PANEL, refreshBadges, navigate: (h) => { location.hash = h; } });
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="callout warn">Something went wrong loading this page: ${e.message}</div>`;
  }
  if (keepScroll) window.scrollTo(0, scrollY);
  await refreshBadges();
  await updateDemoBadge();
}

// Sellers added from Amazon pages arrive as "pending" — import them while the dashboard is open.
let importing = false;
async function importPendingSellers() {
  if (importing) return;
  const pending = (await db.getAll('sellers')).filter((s) => s.status === 'pending');
  if (!pending.length) return;
  importing = true;
  try {
    toast(`Importing ${pending.length} new storefront${pending.length > 1 ? 's' : ''}…`);
    const res = await refreshSellers(pending.map((s) => s.key), { fetchDetails: false });
    toast(`Imported ${res.sellers} storefront${res.sellers === 1 ? '' : 's'}${res.errors.length ? ` · ${res.errors.length} failed` : ''}`, res.errors.length ? 'error' : 'success');
    window.dispatchEvent(new CustomEvent('nt:data'));
  } catch (e) {
    toast(`Import failed: ${e.message}`, 'error');
  } finally {
    importing = false;
  }
}

// Another device's changes were merged in: redraw, unless you're in the middle of typing or a dialog.
let redrawPending = false;
function redrawAfterSync(r) {
  forgetCachedSettings();
  window.dispatchEvent(new Event('nt:settings'));
  const busy = () => document.querySelector('.modal-back') || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if (busy()) { redrawPending = true; return; }
  redrawPending = false;
  route({ keepScroll: true });
  if (r?.from?.length) toast(`Updated from ${[...new Set(r.from)].join(', ')}`, 'info', 3000);
}
document.addEventListener('focusout', () => { if (redrawPending) setTimeout(() => { if (redrawPending) redrawAfterSync(); }, 1500); });
window.addEventListener('nt:synced', (e) => redrawAfterSync(e.detail));

document.getElementById('backupBtn').onclick = () => openBackupModal(currentFeature === 'settings' ? null : currentFeature);
const tabBtn = document.getElementById('tabBtn');
tabBtn.hidden = !IN_PANEL;
tabBtn.onclick = () => openAppTab(location.hash.slice(1));
document.getElementById('menuBtn').onclick = () => document.querySelector('.sidebar').classList.toggle('open');
document.getElementById('scrim')?.addEventListener('click', () => document.querySelector('.sidebar').classList.remove('open'));
window.addEventListener('hashchange', () => route());
window.addEventListener('nt:settings', updateDemoBadge);
window.addEventListener('nt:sellersChanged', () => importPendingSellers());
onRuntimeMessage((msg) => {
  if (msg?.type === 'sellersChanged') importPendingSellers();
  if (msg?.type === 'synced') redrawAfterSync(msg.result);
});

tokenMeter();
(async () => {
  if (IS_WEB) {
    document.body.classList.add('web-app');
    if (IS_STANDALONE) document.body.classList.add('standalone');
    persistStorage();
    registerServiceWorker();
  }
  // Back from Google's sign-in page (web app)
  const back = await completeWebSignIn();
  if (back) toast(back.ok ? 'Google connected' : back.error, back.ok ? 'success' : 'error', back.ok ? 3800 : 9000);
  // Opened from a "set up this device" QR code or link
  if (location.hash.startsWith('#setup=')) {
    const r = await handleSetupLink(location.hash.slice(1));
    history.replaceState(null, '', appUrl('sync'));
    toast(r.ok ? 'Setup code received. Connect Google to finish.' : r.error, r.ok ? 'success' : 'error', 8000);
  }
  // An Amazon link shared to the installed app (share menu on Windows / Android: ?url=… &text=…)
  const q = new URLSearchParams(location.search);
  const shared = [q.get('url'), q.get('text'), q.get('title')].filter(Boolean).join(' ');
  if (shared && !q.has('code')) history.replaceState(null, '', appUrl(location.hash.slice(1)));
  await route();
  if (shared && !q.has('code')) handleAmazonLink(shared).catch((e) => toast(e.message, 'error'));
  syncIndicator(document.getElementById('syncInd'));
  startAutoSync({ onApplied: redrawAfterSync });
  const s = await getSettings();
  if (!isDemo(s)) { try { await (await keepa()).tokenStatus(); } catch { /* shown on use */ } } // free call
  else (await keepa()).onTokens({ tokensLeft: 1200, refillRate: 20, demo: true });
  importPendingSellers();
  // Weekly backup to Google Drive, when it's due (whichever device is open first makes it)
  const backup = () => maybeBackup().then((r) => { if (r.done) toast(`Weekly backup saved to Google Drive (${r.records} records)`, 'success'); }).catch(() => {});
  setTimeout(backup, 30e3);
  setInterval(backup, 60 * 60e3);
})();

// Offline support and "Install app" for the web version. A new version takes over on the next open.
function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
}
