// Google sign-in + Sheets / Drive, shared by every feature (and by sync between your devices).
// Uses YOUR OAuth client (FBA Admin → Settings), so it works with any Google account and needs no change to the manifest.
//
// With a client secret saved (the normal set-up since v2.0) sign-in happens once per device: Google gives a refresh
// token, kept on this device only (kv 'local.googleRefresh', never synced or backed up), and fresh access tokens are
// fetched silently from then on. Without one, the extension falls back to the old way (a silent re-check each hour).
// Access tokens live in chrome.storage.session (extension, memory only) or localStorage (web app), never in a backup.
//
// Scopes: spreadsheets + drive.file (drive.file = only files this app created).
import * as db from '../db.js';
import { IS_EXT, session, appUrl } from '../platform.js';

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file'];
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REFRESH_KEY = 'local.googleRefresh';
const PENDING_KEY = 'nt.googlePending'; // web: PKCE verifier + state while the browser is at Google

// Add this exact address to the OAuth client's "Authorised redirect URIs".
export const redirectUrl = () => (IS_EXT ? chrome.identity.getRedirectURL() : appUrl());

async function credentials(clientId) {
  const s = (await db.kvGet('fbaAdminSettings')) || {};
  return { clientId: clientId || s.googleClientId || '', secret: s.googleClientSecret || '' };
}

async function cachedToken() {
  try {
    const { gToken, gExp } = await session.get(['gToken', 'gExp']);
    return gToken && gExp > Date.now() + 60e3 ? gToken : null;
  } catch { return null; }
}
async function cacheToken(token, expiresIn) {
  await session.set({ gToken: token, gExp: Date.now() + (Number(expiresIn) || 3500) * 1000 });
  return token;
}
// Forget the access token only (a refresh token, if any, gets a new one).
async function dropAccessToken() { await session.remove(['gToken', 'gExp']); }

async function tokenRequest(params) {
  const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  let body = {};
  try { body = await res.json(); } catch { /* not JSON */ }
  if (!res.ok || !body.access_token) {
    const err = new Error(body.error_description || body.error || `Google sign-in failed (HTTP ${res.status})`);
    err.code = body.error; throw err;
  }
  return body;
}

async function refreshAccess(c) {
  const saved = await db.kvGet(REFRESH_KEY);
  if (!saved?.token || !c.secret || saved.clientId !== c.clientId) return null;
  try {
    const t = await tokenRequest({ client_id: c.clientId, client_secret: c.secret, refresh_token: saved.token, grant_type: 'refresh_token' });
    return cacheToken(t.access_token, t.expires_in);
  } catch (e) {
    if (e.code === 'invalid_grant') await db.kvSet(REFRESH_KEY, null); // revoked or expired: sign in again
    throw e.code === 'invalid_grant' ? new Error('Google sign-in has expired — click Connect Google') : e;
  }
}

// PKCE: a one-off secret for this sign-in, so the code Google hands back is useless to anyone else.
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge, state: b64url(crypto.getRandomValues(new Uint8Array(16))) };
}
function authUrl(c, p) {
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: c.clientId, response_type: 'code', redirect_uri: redirectUrl(), scope: SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true',
    code_challenge: p.challenge, code_challenge_method: 'S256', state: p.state,
  });
  return url.href;
}
async function exchangeCode(c, code, verifier) {
  const t = await tokenRequest({ client_id: c.clientId, client_secret: c.secret, code, code_verifier: verifier, redirect_uri: redirectUrl(), grant_type: 'authorization_code' });
  if (t.refresh_token) await db.kvSet(REFRESH_KEY, { token: t.refresh_token, clientId: c.clientId, at: Date.now() });
  return cacheToken(t.access_token, t.expires_in);
}

// The extension's original sign-in (no client secret): a short-lived token, silently re-checked each hour.
async function legacyExtensionToken(c, interactive) {
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: c.clientId, response_type: 'token', redirect_uri: redirectUrl(), scope: SCOPES.join(' '),
    prompt: interactive ? 'consent' : 'none', include_granted_scopes: 'true',
  });
  let redirect;
  try {
    redirect = await chrome.identity.launchWebAuthFlow({ url: url.href, interactive });
  } catch (e) {
    throw new Error(interactive ? `Google sign-in didn't finish: ${e.message}` : 'Signed out of Google — click Connect Google');
  }
  const params = new URLSearchParams(new URL(redirect).hash.slice(1));
  const token = params.get('access_token');
  if (!token) throw new Error(params.get('error') || 'Google sign-in returned no token');
  return cacheToken(token, params.get('expires_in'));
}

export async function getToken(clientId, { interactive = false } = {}) {
  const cached = await cachedToken();
  if (cached) return cached;
  const c = await credentials(clientId);
  if (!c.clientId) throw new Error('Add your Google OAuth client ID in FBA Admin → Settings first');
  const refreshed = await refreshAccess(c);
  if (refreshed) return refreshed;
  if (IS_EXT && !c.secret) return legacyExtensionToken(c, interactive);
  if (!interactive) throw new Error('Signed out of Google — click Connect Google');
  if (!c.secret) throw new Error('Add your Google OAuth client secret in FBA Admin → Settings first');
  const p = await pkce();
  if (IS_EXT) {
    let redirect;
    try { redirect = await chrome.identity.launchWebAuthFlow({ url: authUrl(c, p), interactive: true }); } catch (e) { throw new Error(`Google sign-in didn't finish: ${e.message}`); }
    const q = new URL(redirect).searchParams;
    if (q.get('state') !== p.state || !q.get('code')) throw new Error(q.get('error') || 'Google sign-in was cancelled');
    return exchangeCode(c, q.get('code'), p.verifier);
  }
  // Web app: go to Google; it comes back to this page with ?code=…, finished by completeWebSignIn() on load.
  localStorage.setItem(PENDING_KEY, JSON.stringify({ ...p, clientId: c.clientId, hash: location.hash.slice(1), at: Date.now() }));
  location.assign(authUrl(c, p));
  return new Promise(() => {}); // the page is leaving
}

// Web app start-up: if Google just sent us back here, swap the code for tokens and tidy the address bar.
// Returns null (nothing to do), { ok: true } or { ok: false, error }.
export async function completeWebSignIn() {
  if (IS_EXT) return null;
  const q = new URLSearchParams(location.search);
  if (!q.has('code') && !q.has('error')) return null;
  let pending = null;
  try { pending = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null'); } catch { /* ignore */ }
  localStorage.removeItem(PENDING_KEY);
  history.replaceState(null, '', appUrl(pending?.hash || 'fbaadmin/settings'));
  if (q.get('error')) return { ok: false, error: q.get('error') === 'access_denied' ? 'Google sign-in was cancelled' : `Google: ${q.get('error')}` };
  if (!pending || pending.state !== q.get('state')) return { ok: false, error: 'Google sign-in didn\'t match this app: try Connect Google again' };
  try {
    const c = await credentials(pending.clientId);
    await exchangeCode(c, q.get('code'), pending.verifier);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Forget this device's Google sign-in (access and refresh tokens).
export async function signOut() {
  await dropAccessToken();
  await db.kvSet(REFRESH_KEY, null);
}

export async function isSignedIn() {
  if (await cachedToken()) return true;
  const saved = await db.kvGet(REFRESH_KEY);
  return !!saved?.token;
}

// One wrapper for every call: on 401 gets a fresh access token once; backs off on rate limits. Returns the Response.
export async function apiFetch(clientId, url, opts = {}, { label = 'Google' } = {}) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const token = await getToken(clientId);
    const res = await fetch(url, { ...opts, headers: { ...(opts.body && typeof opts.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}), Authorization: `Bearer ${token}` } });
    if (res.status === 401 && attempt === 0) { await dropAccessToken(); continue; }
    if ((res.status === 429 || res.status === 403) && attempt < 5) {
      const body = await res.clone().text();
      if (res.status === 429 || /rateLimitExceeded|RESOURCE_EXHAUSTED|userRateLimitExceeded/.test(body)) { await new Promise((r) => setTimeout(r, Math.random() * 1000 * 2 ** attempt)); continue; }
    }
    if (!res.ok) {
      let msg = `${res.status}`;
      try { msg = (await res.json()).error?.message || msg; } catch { /* keep status */ }
      const err = new Error(`${label}: ${msg}`); err.status = res.status; throw err;
    }
    return res;
  }
  throw new Error(`${label} is rate-limiting; try again in a minute`);
}

async function api(clientId, url, opts = {}) {
  const res = await apiFetch(clientId, url, opts, { label: 'Google Sheets' });
  return res.status === 204 ? null : res.json();
}

const q = (tab) => `'${String(tab).replace(/'/g, "''")}'`;

// Strings that Sheets would treat as a formula are written as text.
function cell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? v : '';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  const s = String(v);
  return /^[=+@]/.test(s) ? `'${s}` : s;
}

// Creates the spreadsheet on first use, or re-creates it if it was deleted. Returns { id, url }.
export async function ensureSpreadsheet(clientId, { spreadsheetId, title = 'FBA Accounting', tabs = [] }) {
  if (spreadsheetId) {
    try {
      const s = await api(clientId, `${SHEETS}/${spreadsheetId}?fields=spreadsheetId,spreadsheetUrl`);
      return { id: s.spreadsheetId, url: s.spreadsheetUrl, created: false };
    } catch (e) { if (e.status !== 404 && e.status !== 403) throw e; }
  }
  const s = await api(clientId, SHEETS, {
    method: 'POST',
    body: JSON.stringify({ properties: { title }, sheets: tabs.map((t) => ({ properties: { title: t, gridProperties: { frozenRowCount: 1 } } })) }),
  });
  return { id: s.spreadsheetId, url: s.spreadsheetUrl, created: true };
}

// Rewrites each given tab completely: { tabName: [[header…], [row…], …] }. Tabs not listed are never touched,
// so your own tabs in the same spreadsheet are safe. Three API calls in total, whatever the size.
export async function writeTabs(clientId, spreadsheetId, tabs) {
  const meta = await api(clientId, `${SHEETS}/${spreadsheetId}?fields=sheets.properties`);
  const existing = new Map(meta.sheets.map((s) => [s.properties.title, s.properties.sheetId]));
  const missing = Object.keys(tabs).filter((t) => !existing.has(t));
  const requests = missing.map((t) => ({ addSheet: { properties: { title: t, gridProperties: { frozenRowCount: 1 } } } }));
  if (requests.length) {
    const r = await api(clientId, `${SHEETS}/${spreadsheetId}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests }) });
    r.replies.forEach((rep, i) => existing.set(missing[i], rep.addSheet.properties.sheetId));
  }
  await api(clientId, `${SHEETS}/${spreadsheetId}/values:batchClear`, { method: 'POST', body: JSON.stringify({ ranges: Object.keys(tabs).map((t) => `${q(t)}!A:ZZ`) }) });
  await api(clientId, `${SHEETS}/${spreadsheetId}/values:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: Object.entries(tabs).map(([t, rows]) => ({ range: `${q(t)}!A1`, values: rows.map((r) => r.map(cell)) })) }),
  });
  // bold header row on every tab we wrote
  const fmt = Object.keys(tabs).map((t) => ({ repeatCell: { range: { sheetId: existing.get(t), startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } }));
  await api(clientId, `${SHEETS}/${spreadsheetId}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests: fmt }) });
  return Object.fromEntries(Object.entries(tabs).map(([t, rows]) => [t, rows.length - 1]));
}

// Reads one tab back as objects keyed by header.
export async function readTab(clientId, spreadsheetId, tab) {
  const r = await api(clientId, `${SHEETS}/${spreadsheetId}/values/${encodeURIComponent(`${q(tab)}!A:ZZ`)}?valueRenderOption=UNFORMATTED_VALUE`);
  const [header = [], ...rows] = r.values || [];
  return rows.filter((row) => row.some((c) => c !== '')).map((row) => Object.fromEntries(header.map((h, i) => [h, row[i] ?? ''])));
}

// ---------------------------------------------------------------------------
// Google Drive (drive.file: the extension only sees files and folders it created)
// ---------------------------------------------------------------------------
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER = 'application/vnd.google-apps.folder';
const dq = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

// Finds or creates FBA Accounting/Invoices/2026/09 September… Cached ids are checked; a deleted folder is recreated.
export async function ensureFolderPath(clientId, parts, cache = {}) {
  let parent = 'root'; let path = '';
  const next = { ...cache };
  for (const name of parts) {
    path = path ? `${path}/${name}` : name;
    let id = next[path];
    if (id) {
      try { const f = await api(clientId, `${DRIVE}/${id}?fields=id,trashed`); if (f.trashed) id = null; } catch (e) { if (e.status === 404) id = null; else throw e; }
    }
    if (!id) {
      const q = `name='${dq(name)}' and mimeType='${FOLDER}' and '${parent}' in parents and trashed=false`;
      const found = await api(clientId, `${DRIVE}?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive`);
      id = found.files?.[0]?.id;
      if (!id) id = (await api(clientId, `${DRIVE}?fields=id`, { method: 'POST', body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }) })).id;
    }
    next[path] = id; parent = id;
  }
  return { id: parent, cache: next };
}

export async function listNames(clientId, folderId) {
  const q = `'${folderId}' in parents and trashed=false`;
  const r = await api(clientId, `${DRIVE}?q=${encodeURIComponent(q)}&fields=files(name)&pageSize=1000`);
  return new Set((r.files || []).map((f) => f.name));
}

function multipart(meta, blob, mime) {
  const boundary = `fba${crypto.randomUUID()}`;
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
    `--${boundary}\r\nContent-Type: ${mime || 'application/octet-stream'}\r\n\r\n`, blob, `\r\n--${boundary}--`,
  ]);
  return { body, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` } };
}

// Multipart upload (invoices are small). Returns { id, name, webViewLink }.
export async function uploadFile(clientId, { blob, name, parentId, mime }) {
  const { body, headers } = multipart({ name, parents: [parentId] }, blob, mime);
  return api(clientId, `${UPLOAD}?uploadType=multipart&fields=id,name,webViewLink`, { method: 'POST', headers, body });
}

// Creates a file, or replaces the contents of `fileId`. Returns { id, modifiedTime }.
export async function putFile(clientId, { fileId = null, name, parentId, blob, mime, appProperties }) {
  const meta = { name, ...(fileId ? {} : { parents: [parentId] }), ...(appProperties ? { appProperties } : {}) };
  const { body, headers } = multipart(meta, blob, mime);
  const url = `${UPLOAD}${fileId ? `/${encodeURIComponent(fileId)}` : ''}?uploadType=multipart&fields=id,modifiedTime`;
  return (await apiFetch(clientId, url, { method: fileId ? 'PATCH' : 'POST', headers, body }, { label: 'Google Drive' })).json();
}

// Every file in a folder, with the fields asked for.
export async function listFiles(clientId, folderId, fields = 'id,name,modifiedTime,size,appProperties') {
  const out = []; let pageToken = '';
  const q = `'${folderId}' in parents and trashed=false`;
  do {
    const r = await api(clientId, `${DRIVE}?q=${encodeURIComponent(q)}&fields=nextPageToken,files(${fields})&pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
    out.push(...(r.files || [])); pageToken = r.nextPageToken || '';
  } while (pageToken);
  return out;
}

export async function downloadBlob(clientId, fileId) {
  return (await apiFetch(clientId, `${DRIVE}/${encodeURIComponent(fileId)}?alt=media`, {}, { label: 'Google Drive' })).blob();
}
