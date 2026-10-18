// Service worker: side panel + full-tab dashboard, handles "Track seller" from Amazon pages and the context menu.
import { addSeller } from './js/services.js';
import { parseSellerInput, domainFromHost } from './js/util.js';
import { maybeBackup } from './js/sync/drivebackup.js';
import { syncNow, syncState } from './js/sync/sync.js';

const DASHBOARD = chrome.runtime.getURL('dashboard.html');

async function openDashboard(hash = '') {
  const tabs = await chrome.tabs.query({ url: `${DASHBOARD}*` });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true, ...(hash ? { url: `${DASHBOARD}#${hash}` } : {}) });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: `${DASHBOARD}${hash ? '#' + hash : ''}` });
  }
}

// Clicking the toolbar icon opens the side panel; right-click the icon for the full-tab dashboard.
function usePanel() {
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}
usePanel();
chrome.runtime.onStartup.addListener(usePanel);
// Fallback for Chrome builds without the side panel: action click opens the tab.
chrome.action.onClicked.addListener(() => openDashboard());

const AMAZON_PATTERNS = ['co.uk', 'de', 'fr', 'it', 'es'].flatMap((tld) => [
  `https://www.amazon.${tld}/*seller=*`,
  `https://www.amazon.${tld}/*me=*`,
]);

chrome.runtime.onInstalled.addListener(() => {
  usePanel();
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'nt-open-tab', title: "Open Niall's Toolkit in a full tab", contexts: ['action'] });
    chrome.contextMenus.create({
      id: 'nt-track-link',
      title: "Track this seller in Niall's Toolkit",
      contexts: ['link'],
      targetUrlPatterns: AMAZON_PATTERNS,
    });
    chrome.contextMenus.create({
      id: 'nt-track-page',
      title: "Track this seller in Niall's Toolkit",
      contexts: ['page'],
      documentUrlPatterns: AMAZON_PATTERNS,
    });
  });
});

async function trackFromUrl(url, name = '') {
  const parsed = parseSellerInput(url);
  if (!parsed) return { ok: false, error: 'No seller ID found on this page' };
  let domain = parsed.domain;
  if (!domain) { try { domain = domainFromHost(new URL(url).hostname); } catch { domain = 2; } }
  const { seller, existed } = await addSeller(parsed.sellerId, domain || 2, { source: 'manual', name });
  // Let any open dashboard know so it can import straight away.
  chrome.runtime.sendMessage({ type: 'sellersChanged' }).catch(() => {});
  return { ok: true, existed, sellerId: seller.sellerId, domain: seller.domain };
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'nt-open-tab') { openDashboard(); return; }
  const url = info.menuItemId === 'nt-track-link' ? info.linkUrl : (info.pageUrl || tab?.url);
  const res = await trackFromUrl(url);
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'ntToast', ...res }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'trackSeller') {
    trackFromUrl(msg.url, msg.name).then(sendResponse);
    return true;
  }
  if (msg?.type === 'openDashboard') {
    openDashboard(msg.hash || '').then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

// ---------------------------------------------------------------------------
// While Chrome is open, even with the dashboard closed: sync every 15 minutes, and check every hour whether the
// weekly Google Drive backup is due (sync/drivebackup.js).
// ---------------------------------------------------------------------------
const BACKUP = 'ntBackup';
const SYNC = 'ntSync';

function scheduleAlarms() {
  chrome.alarms?.clear('fbaWeeklySummary'); // the old Monday Discord summary (removed in 2.2)
  chrome.alarms?.get(BACKUP, (a) => { if (!a) chrome.alarms.create(BACKUP, { delayInMinutes: 3, periodInMinutes: 60 }); });
  chrome.alarms?.get(SYNC, (a) => { if (!a) chrome.alarms.create(SYNC, { delayInMinutes: 2, periodInMinutes: 15 }); });
}

async function backgroundSync() {
  if (!(await syncState()).enabled) return;
  const r = await syncNow({ reason: 'alarm' });
  // tell any open dashboard to redraw with the other devices' changes
  if (r && (r.applied || r.deleted || r.settings)) chrome.runtime.sendMessage({ type: 'synced', result: { ...r, stores: [...(r.stores || [])] } }).catch(() => {});
}

// Unpacked extension: when the files in its folder are a newer version than the one Chrome is running (an update
// was copied in), reload itself, so there's no need to click ↻ on chrome://extensions.
async function reloadIfUpdated() {
  try {
    const onDisk = await (await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' })).json();
    if (onDisk.version && onDisk.version !== chrome.runtime.getManifest().version) chrome.runtime.reload();
  } catch { /* keep running the current version */ }
}

chrome.alarms?.onAlarm.addListener((a) => {
  if (a.name === BACKUP) maybeBackup().catch(() => {});
  if (a.name === SYNC) { reloadIfUpdated(); backgroundSync().catch(() => {}); }
});
chrome.runtime.onInstalled.addListener(scheduleAlarms);
chrome.runtime.onStartup.addListener(() => { scheduleAlarms(); reloadIfUpdated(); });
scheduleAlarms();
