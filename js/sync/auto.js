// When to sync while the app is open: shortly after start, a little after you change something, every few minutes,
// when you come back to the app, and as you leave it. Plus the little sync status in the top bar.
import * as db from '../db.js';
import { syncNow, syncState, onSyncStatus } from './sync.js';
import { icon } from '../ui.js';
import { esc } from '../util.js';

const EVERY = 5 * 60e3;   // background pull while open
const AFTER_EDIT = 20e3;  // push this long after the last change
let editTimer = null;
let started = false;

// onApplied(result) runs when another device's changes were merged in, so the page can redraw.
export function startAutoSync({ onApplied = () => {} } = {}) {
  if (started) return;
  started = true;
  const go = async (reason) => {
    try {
      if (!navigator.onLine) return;
      const st = await syncState();
      if (!st.enabled) return;
      const r = await syncNow({ reason });
      if (r && (r.applied || r.deleted || r.settings || r.files)) onApplied(r);
    } catch { /* shown by the status indicator */ }
  };
  setTimeout(() => go('start'), 1200);
  setInterval(() => go('timer'), EVERY);
  db.onLocalChange(() => { clearTimeout(editTimer); editTimer = setTimeout(() => go('edit'), AFTER_EDIT); });
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); clearTimeout(editTimer); go('leave'); } else if (Date.now() - hiddenAt > 30e3) go('return');
  });
  window.addEventListener('online', () => go('online'));
}

const ago = (ms) => {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};

// Top-bar indicator: a cloud with a word. Click goes to Devices & sync.
export function syncIndicator(el) {
  const draw = async (s) => {
    const st = await syncState();
    let cls = ''; let text = ''; let title = '';
    el.hidden = false;
    if (!st.enabled) { cls = 'off'; text = 'Sync off'; title = 'Your devices are not syncing. Click to set up.'; }
    else if (s.state === 'syncing') { cls = 'busy'; text = 'Syncing…'; title = 'Syncing with your other devices'; }
    else if (s.state === 'signed-out') { cls = 'warn'; text = 'Reconnect'; title = s.error || 'Signed out of Google'; }
    else if (s.state === 'error' || st.lastError) { cls = 'warn'; text = 'Sync problem'; title = s.error || st.lastError; }
    else { cls = 'ok'; text = st.lastSyncAt ? `Synced ${ago(st.lastSyncAt)}` : 'Sync on'; title = 'Everything is synced with your other devices'; }
    el.className = `sync-ind ${cls}`;
    el.title = title;
    el.innerHTML = `${icon(cls === 'warn' ? 'cloudAlert' : cls === 'off' ? 'cloudOff' : 'cloud', 15)}<span>${esc(text)}</span>`;
  };
  let last = { state: 'idle' };
  el.onclick = () => { location.hash = 'sync'; };
  onSyncStatus((s) => { last = s; draw(s); });
  setInterval(() => draw(last), 60e3); // keeps "Synced 3 min ago" current
}
