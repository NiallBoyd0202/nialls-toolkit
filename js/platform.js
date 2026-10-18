// Where the toolkit is running: the Chrome extension, or the installable web app (Windows / iPhone).
// Everything Chrome-only goes through here, so the rest of the code runs the same in both.

// Keep in step with "version" in manifest.json.
export const VERSION = '2.2.0';

export const IS_EXT = typeof chrome !== 'undefined' && !!chrome.runtime?.id;
export const IS_WEB = !IS_EXT;
export const IS_IOS = typeof navigator !== 'undefined' && (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
// Opened from the Home Screen / Start menu rather than a browser tab.
export const IS_STANDALONE = typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true);

export function appVersion() {
  try { if (IS_EXT) return chrome.runtime.getManifest().version; } catch { /* fall through */ }
  return VERSION;
}

// A short name for this copy of the toolkit, shown in the device list.
export function defaultDeviceName() {
  if (IS_EXT) return 'Chrome extension';
  if (typeof navigator === 'undefined') return 'Web app';
  const ua = navigator.userAgent;
  if (IS_IOS) return /iPhone/.test(ua) ? 'iPhone' : 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'Windows app';
  if (/Mac OS X/.test(ua)) return 'Mac app';
  return 'Web app';
}

// The page the app lives on (dashboard.html in both cases).
export function appUrl(hash = '') {
  const base = IS_EXT ? chrome.runtime.getURL('dashboard.html') : new URL('dashboard.html', location.href).href.split('#')[0].split('?')[0];
  return `${base}${hash ? `#${hash}` : ''}`;
}

export function openAppTab(hash = '') {
  if (IS_EXT && chrome.tabs?.create) return chrome.tabs.create({ url: appUrl(hash) });
  return window.open(appUrl(hash), '_blank', 'noopener');
}

// Short-lived values (Google access tokens): chrome.storage.session in the extension (memory only), localStorage on the web.
export const session = {
  async get(keys) {
    if (IS_EXT && chrome.storage?.session) return chrome.storage.session.get(keys);
    const out = {};
    for (const k of keys) { try { const v = localStorage.getItem(`nt.${k}`); if (v !== null) out[k] = JSON.parse(v); } catch { /* storage blocked */ } }
    return out;
  },
  async set(obj) {
    if (IS_EXT && chrome.storage?.session) return chrome.storage.session.set(obj);
    for (const [k, v] of Object.entries(obj)) { try { localStorage.setItem(`nt.${k}`, JSON.stringify(v)); } catch { /* storage blocked */ } }
  },
  async remove(keys) {
    if (IS_EXT && chrome.storage?.session) return chrome.storage.session.remove(keys);
    for (const k of keys) { try { localStorage.removeItem(`nt.${k}`); } catch { /* storage blocked */ } }
  },
};

// Messages to the other parts of the extension (background worker, open dashboards). No-ops on the web.
export function sendRuntimeMessage(msg) {
  if (!IS_EXT) return Promise.resolve();
  try { return chrome.runtime.sendMessage(msg).catch(() => {}); } catch { return Promise.resolve(); }
}
export function onRuntimeMessage(fn) {
  if (IS_EXT && chrome.runtime?.onMessage) chrome.runtime.onMessage.addListener((msg) => { fn(msg); return false; });
}

// Ask the browser not to clear our storage when space is short (Safari clears unused sites' data otherwise).
export async function persistStorage() {
  try { if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch { /* not supported */ }
}
