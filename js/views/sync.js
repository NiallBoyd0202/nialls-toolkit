// Devices & sync: connect Google, switch sync on, see your devices, add another device (QR code / setup code).
import * as db from '../db.js';
import { getSettings as faSettings, saveSettings as faSave } from '../fbaadmin/store.js';
import { getSettings as gsSettings, saveSettings as gsSave } from '../services.js';
import { getToken, signOut, isSignedIn, redirectUrl } from '../fbaadmin/google.js';
import { syncNow, syncState, setSyncOptions, device, renameDevice, SYNC_FOLDER } from '../sync/sync.js';
import { IS_EXT, IS_IOS, IS_STANDALONE, appUrl, appVersion } from '../platform.js';
import { icon, toast, confirmBox } from '../ui.js';
import { esc } from '../util.js';
import qrcode from '../vendor/qrcode.js';

// ---------------------------------------------------------------------------
// Setup codes: carry the Google client ID and secret to a new device (so you don't type them on a phone).
// ---------------------------------------------------------------------------
const PREFIX = 'NT1.';
const b64u = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));

export function makeSetupCode(s) {
  return PREFIX + b64u(JSON.stringify({ c: s.googleClientId, s: s.googleClientSecret || '', w: s.webAppUrl || '' }));
}
export function readSetupCode(text) {
  const m = String(text || '').match(/NT1\.[A-Za-z0-9_-]+/);
  if (!m) throw new Error("That isn't a setup code: it should start with NT1.");
  const o = JSON.parse(unb64u(m[0].slice(PREFIX.length)));
  if (!o.c) throw new Error('That setup code has no Google client ID in it');
  return { googleClientId: o.c, googleClientSecret: o.s || '', webAppUrl: o.w || '' };
}
// Saves the Google client from a setup code and switches sync on. The next step is Connect Google.
export async function applySetupCode(text) {
  const c = readSetupCode(text);
  await faSave({ googleClientId: c.googleClientId, ...(c.googleClientSecret ? { googleClientSecret: c.googleClientSecret } : {}) });
  if (c.webAppUrl) await gsSave({ webAppUrl: c.webAppUrl });
  await setSyncOptions({ enabled: true });
  return c;
}

function qrSvg(text, px = 220) {
  const q = qrcode(0, 'L'); q.addData(text); q.make();
  const n = q.getModuleCount(); const cell = px / (n + 8);
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${(c + 4) * cell},${(r + 4) * cell}h${cell}v${cell}h-${cell}z`;
  return `<svg class="qr" viewBox="0 0 ${px} ${px}" width="${px}" height="${px}" role="img" aria-label="QR code"><rect width="${px}" height="${px}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

const ago = (ms) => {
  if (!ms) return 'never';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// One-time Google set-up, shared with FBA Admin → Settings.
export function googleSetupSteps(redirect) {
  return `<ol class="small steps">
    <li>Go to <b>console.cloud.google.com</b> and create a project (for example "FBA Toolkit").</li>
    <li><i>APIs &amp; Services → Library</i>: enable <b>Google Sheets API</b> and <b>Google Drive API</b>.</li>
    <li><i>OAuth consent screen</i>: user type <b>External</b>, any app name, your email as support and developer contact. Add yourself under <i>Test users</i>, then <b>Publish app</b> so sign-in doesn't expire every 7 days. You'll see "Google hasn't verified this app" once: choose <i>Advanced → Continue</i>.</li>
    <li><i>Credentials → Create credentials → OAuth client ID</i>, type <b>Web application</b>. Under <i>Authorised redirect URIs</i> add this address (and the one shown on each of your other copies of the toolkit):<br><code class="mono" data-copytext="${esc(redirect)}">${esc(redirect)}</code> <button class="btn small" type="button" data-copy="${esc(redirect)}">Copy</button></li>
    <li>Copy the <b>Client ID</b> and <b>Client secret</b> into the boxes below and click <b>Save</b>, then <b>Connect Google</b>.</li>
  </ol>`;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
const ui = { showCode: false, editClient: false };

export async function render(root) {
  const [fa, gs, st, me, signedIn] = await Promise.all([faSettings(), gsSettings(), syncState(), device(), isSignedIn().catch(() => false)]);
  const hasClient = !!fa.googleClientId && (IS_EXT || !!fa.googleClientSecret);
  const redirect = (() => { try { return redirectUrl(); } catch { return ''; } })();
  // The web app records where it lives, so the extension can show a QR code that opens it.
  if (!IS_EXT && gs.webAppUrl !== appUrl() && st.enabled) await gsSave({ webAppUrl: appUrl() });
  const webUrl = IS_EXT ? gs.webAppUrl : appUrl();
  const code = hasClient ? makeSetupCode({ ...fa, webAppUrl: webUrl }) : '';
  const setupLink = code && webUrl ? `${webUrl}#setup=${code}` : '';
  const iosBrowser = IS_IOS && !IS_STANDALONE && !IS_EXT;

  const step = !hasClient || ui.editClient ? 1 : !signedIn ? 2 : !st.enabled ? 3 : 4;
  const stepper = `<div class="stepper">${['Google project', 'Connect Google', 'Turn on sync'].map((l, i) => `<div class="st ${step > i + 1 ? 'done' : step === i + 1 ? 'now' : ''}"><span>${step > i + 1 ? '✓' : i + 1}</span>${l}</div>`).join('')}</div>`;

  const others = (st.devices || []).filter((d) => !d.me);
  root.innerHTML = `
    ${iosBrowser ? `<div class="callout section-first"><b>${icon('phone', 15)} Install it on your iPhone</b><br>In Safari tap <b>Share</b> <span class="muted">(the square with an arrow)</span> → <b>Add to Home Screen</b>, then open <i>Niall's Toolkit</i> from your Home Screen. ${code ? 'It will ask for your setup code: tap <b>Copy setup code</b> below first.' : ''}${code ? `<div class="row" style="margin-top:8px"><button class="btn primary small" data-copy="${esc(code)}">Copy setup code</button></div>` : ''}</div>` : ''}

    <div class="sync-hero card">
      <div class="grow">
        <div class="eyebrow">${icon('cloud', 14)} Devices &amp; sync</div>
        <h2>${st.enabled ? (st.lastError ? 'Sync needs attention' : 'Your devices are in sync') : 'Keep your devices in sync'}</h2>
        <p class="small">${st.enabled
          ? `${st.lastSyncAt ? `Last synced ${esc(ago(st.lastSyncAt))}.` : 'Not synced yet.'} ${others.length ? `Syncing with ${others.map((d) => esc(d.name)).join(', ')}.` : 'No other devices yet: add one below.'}`
          : 'Use the toolkit on this computer, in Chrome and on your iPhone with the same data. Everything is copied through your own Google Drive (a folder called <b>' + esc(SYNC_FOLDER) + '</b>); nothing goes anywhere else.'}</p>
        ${st.lastError ? `<div class="callout warn small">${esc(st.lastError)}</div>` : ''}
      </div>
      <div class="sync-hero-actions">
        ${st.enabled && signedIn ? `<button class="btn primary" id="syncNow">${icon('refresh')} Sync now</button>` : ''}
        ${st.enabled && !signedIn && hasClient ? `<button class="btn primary" id="connect2">Connect Google</button>` : ''}
      </div>
    </div>

    ${step < 4 ? `<div class="card card-pad stack section">${stepper}
      ${step === 1 ? `
        <div class="grid2">
          <div class="stack">
            <h3>${icon('phone')} Already set up on another device?</h3>
            <p class="small muted">On that device open <b>Devices &amp; sync → Add another device</b>, then scan the QR code with this phone's camera, or paste the setup code here.</p>
            <div class="row"><input id="codeIn" class="grow mono" placeholder="NT1.…" autocomplete="off" autocapitalize="off" spellcheck="false">
              ${navigator.clipboard?.readText ? '<button class="btn" id="pasteCode" type="button">Paste</button>' : ''}<button class="btn primary" id="useCode" type="button">Use code</button></div>
          </div>
          <div class="stack">
            <h3>${icon('globe')} First device: set up Google (one time, about 10 minutes)</h3>
            ${googleSetupSteps(redirect)}
            <div class="form-grid">
              <label class="field">Client ID<input id="cid" class="mono" value="${esc(fa.googleClientId)}" placeholder="1234…apps.googleusercontent.com" autocomplete="off"></label>
              <label class="field">Client secret<input id="csec" class="mono" type="password" value="${esc(fa.googleClientSecret || '')}" placeholder="GOCSPX-…" autocomplete="off"></label>
            </div>
            <div class="row"><button class="btn primary" id="saveClient">${icon('check')} Save</button></div>
          </div>
        </div>` : ''}
      ${step === 2 ? `<p>Sign in with the Google account whose Drive should hold the sync copy. You only do this once on each device.</p>
        <div class="row"><button class="btn primary" id="connect">${icon('globe')} Connect Google</button><button class="btn ghost small" id="editClient">Change Google client</button></div>
        ${IS_IOS ? '<p class="small muted">Google will open, then bring you back here.</p>' : ''}` : ''}
      ${step === 3 ? `<p>Google is connected. Switch on sync to copy this device's data to your Drive and bring in your other devices' data. Nothing is deleted: records from both sides are kept, and where the same record was changed on two devices the newer change wins.</p>
        <div class="row"><button class="btn primary" id="enable">${icon('cloud')} Turn on sync</button></div>` : ''}
    </div>` : ''}

    ${st.enabled ? `<div class="grid2 section">
      <div class="card">
        <div class="toolbar"><b>Your devices</b><span class="grow"></span><span class="small muted">${esc(SYNC_FOLDER)} in Google Drive</span></div>
        <table class="data"><tbody>
          <tr><td>${icon(/iPhone|iPad/.test(me.name) ? 'phone' : 'store', 16)} <b>${esc(me.name)}</b> <span class="tag new">this device</span><div class="small muted">version ${esc(appVersion())}</div></td>
            <td class="r small muted">${st.lastUploadAt ? `sent ${esc(ago(st.lastUploadAt))}` : ''}</td><td class="r"><button class="btn small ghost" id="rename">Rename</button></td></tr>
          ${others.map((d) => `<tr><td>${icon(/iPhone|iPad/.test(d.name) ? 'phone' : 'store', 16)} <b>${esc(d.name)}</b><div class="small muted">${d.version ? `version ${esc(d.version)} · ` : ''}${kb(d.size)}</div></td><td class="r small muted">updated ${esc(ago(d.at))}</td><td></td></tr>`).join('')}
        </tbody></table>
        ${others.length ? '' : '<p class="small muted" style="padding:0 14px 12px">Your other devices appear here once they\'ve synced.</p>'}
      </div>
      <div class="card card-pad stack">
        <h3>${icon('gear')} Options</h3>
        <label class="check"><input type="checkbox" id="secrets" ${st.syncSecrets ? 'checked' : ''}> Sync my API keys too (Keepa key, Google client secret)</label>
        <p class="small muted">Off: each device keeps its own keys, and you type your Keepa key once on each. On: they're copied through your Drive like everything else, so a new device is ready straight away. Your Drive is private to you either way.</p>
        <p class="small muted">Sync runs when the app opens, about 20 seconds after you change something, every 5 minutes while it's open, and when you switch away.${IS_EXT ? ' The extension also syncs every 15 minutes while Chrome is open.' : ''}</p>
        <div class="row"><button class="btn small" id="resend">Send everything again</button><button class="btn small danger" id="off">Turn off sync on this device</button>${signedIn ? '<button class="btn small ghost" id="gout">Sign out of Google</button>' : ''}</div>
      </div>
    </div>

    <div class="card card-pad stack section" id="addDev">
      <h3>${icon('phone')} Add another device</h3>
      ${!code ? '<p class="small muted">Set up Google first.</p>' : `
      <div class="add-dev">
        ${setupLink ? `<div class="qr-box">${qrSvg(setupLink)}<div class="small muted">Scan with your iPhone camera</div></div>` : ''}
        <div class="stack grow">
          <p class="small"><b>iPhone:</b> ${setupLink ? 'point the Camera app at the QR code and tap the link. Safari opens the toolkit: tap <b>Share → Add to Home Screen</b>, open it from your Home Screen, paste the setup code when it asks (it is copied for you), then <b>Connect Google</b>.' : 'open the web app address in Safari, tap <b>Share → Add to Home Screen</b>, open it from your Home Screen and paste the setup code below, then <b>Connect Google</b>.'}</p>
          <p class="small"><b>Windows app:</b> open ${webUrl ? `<a href="${esc(webUrl)}" target="_blank" rel="noopener">${esc(webUrl.replace(/^https?:\/\//, ''))}</a>` : 'the web app address'} in Edge or Chrome and click <b>Install</b> in the address bar${IS_EXT ? '' : ' (or ⋯ → Apps → Install)'}. Then paste the setup code.</p>
          <p class="small"><b>Chrome extension:</b> load v${esc(appVersion())} or newer, open <b>Devices &amp; sync</b>, paste the setup code. Add its redirect address (shown there) to your Google OAuth client.</p>
          <div class="row"><button class="btn small" id="showCode">${ui.showCode ? 'Hide' : 'Show'} setup code</button><button class="btn small primary" data-copy="${esc(code)}">Copy setup code</button>${setupLink ? `<button class="btn small" data-copy="${esc(setupLink)}">Copy link</button>` : ''}</div>
          ${ui.showCode ? `<textarea class="mono small" rows="3" readonly>${esc(code)}</textarea>` : ''}
          <p class="small muted">The code holds your Google client ID and secret, so treat it like a password: it lets a device sign in to <i>your</i> Google project. It can't read your data without your Google sign-in.</p>
          ${!webUrl && IS_EXT ? '<p class="small muted">The QR code appears here once the web app has synced once (it tells the extension its address).</p>' : ''}
        </div>
      </div>`}
    </div>` : ''}`;

  const $ = (id) => root.querySelector(`#${id}`);
  root.querySelectorAll('[data-copy]').forEach((b) => { b.onclick = () => navigator.clipboard.writeText(b.dataset.copy).then(() => toast('Copied'), () => toast('Copy failed: select and copy it by hand', 'error')); });

  const connect = async () => {
    try {
      await signOut();
      await getToken(fa.googleClientId, { interactive: true });
      toast('Google connected', 'success');
      if ((await syncState()).enabled) await syncNow({ force: true }).catch((e) => toast(e.message, 'error', 8000));
    } catch (e) { toast(e.message, 'error', 8000); }
    render(root);
  };
  if ($('connect')) $('connect').onclick = connect;
  if ($('connect2')) $('connect2').onclick = connect;
  if ($('editClient')) $('editClient').onclick = () => { ui.editClient = true; render(root); };

  if ($('saveClient')) $('saveClient').onclick = async () => {
    const cid = $('cid').value.trim(); const sec = $('csec').value.trim();
    if (!/\.apps\.googleusercontent\.com$/.test(cid)) return toast('The client ID ends in .apps.googleusercontent.com', 'error');
    if (!sec && !IS_EXT) return toast('Paste the client secret too (it starts GOCSPX-)', 'error');
    await faSave({ googleClientId: cid, googleClientSecret: sec });
    ui.editClient = false;
    toast('Saved', 'success'); render(root);
  };
  const useCode = async (text) => {
    try { await applySetupCode(text); toast('Setup code accepted. Now connect Google.', 'success', 6000); render(root); } catch (e) { toast(e.message, 'error', 7000); }
  };
  if ($('useCode')) $('useCode').onclick = () => useCode($('codeIn').value);
  if ($('pasteCode')) $('pasteCode').onclick = async () => { try { const t = await navigator.clipboard.readText(); $('codeIn').value = t; useCode(t); } catch { toast('Couldn\'t read the clipboard: long-press the box and choose Paste', 'error', 6000); } };

  if ($('enable')) $('enable').onclick = async () => {
    await setSyncOptions({ enabled: true });
    if (!IS_EXT) await gsSave({ webAppUrl: appUrl() });
    $('enable').disabled = true; $('enable').textContent = 'Syncing…';
    try {
      const r = await syncNow({ force: true });
      toast(r.from?.length ? `Sync is on. Brought in ${r.applied} records from ${r.from.join(', ')}.` : 'Sync is on. This device\'s data is now in your Drive.', 'success', 7000);
      window.dispatchEvent(new CustomEvent('nt:synced', { detail: r }));
    } catch (e) { toast(e.message, 'error', 8000); }
    render(root);
  };
  if ($('syncNow')) $('syncNow').onclick = async () => {
    $('syncNow').disabled = true;
    try {
      const r = await syncNow({ force: false });
      if (r.skipped === 'busy') toast('A sync is already running');
      else toast(r.applied || r.deleted || r.settings ? `Synced: ${[r.applied ? `${r.applied} records` : '', r.deleted ? `${r.deleted} deletions` : '', r.settings ? `${r.settings} settings` : ''].filter(Boolean).join(', ')} from ${r.from.join(', ')}` : 'Everything is up to date', 'success', 6000);
      if (r.applied || r.deleted || r.settings) window.dispatchEvent(new CustomEvent('nt:synced', { detail: r }));
    } catch (e) { toast(e.message, 'error', 8000); }
    render(root);
  };
  if ($('resend')) $('resend').onclick = async () => { try { await syncNow({ force: true }); toast('Sent', 'success'); } catch (e) { toast(e.message, 'error', 8000); } render(root); };
  if ($('secrets')) $('secrets').onchange = async (e) => { await setSyncOptions({ syncSecrets: e.target.checked }); toast(e.target.checked ? 'Keys will sync from the next sync' : 'Keys stay on each device'); };
  if ($('off')) $('off').onclick = async () => {
    if (!(await confirmBox('Turn off sync here?', 'This device stops sending and receiving changes. Its data stays here, and your other devices keep theirs. You can turn it back on any time.', { okLabel: 'Turn off' }))) return;
    await setSyncOptions({ enabled: false }); render(root);
  };
  if ($('gout')) $('gout').onclick = async () => { await signOut(); toast('Signed out of Google on this device'); render(root); };
  if ($('rename')) $('rename').onclick = async () => {
    const n = prompt('Name for this device', me.name);
    if (n !== null) { await renameDevice(n); render(root); }
  };
  if ($('showCode')) $('showCode').onclick = () => { ui.showCode = !ui.showCode; render(root); };
}

// The QR code / setup link lands here: #setup=NT1.…
export async function handleSetupLink(hash) {
  const code = hash.slice('setup='.length);
  try {
    await applySetupCode(code);
    // On an iPhone in Safari the Home Screen app keeps its own storage, so keep the code handy to paste there.
    try { await navigator.clipboard.writeText(code); } catch { /* needs a tap; the page has a Copy button */ }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}
