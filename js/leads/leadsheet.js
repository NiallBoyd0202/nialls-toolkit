// Lead sheet: your Google Sheet of buy leads, read as it is (nothing is written back, no Keepa tokens),
// tidied up and ranked. Pure apart from read(), which fetches the sheet with your Google sign-in.
import * as db from '../db.js';
import { apiFetch } from '../fbaadmin/google.js';

export const SETTINGS_KEY = 'leadSheet';
// No default: the code is public on GitHub, so your sheet's link is kept in your (synced) settings, not here.
export const DEFAULT_URL = '';
const CACHE_KEY = 'local.leadSheetCache'; // the last copy read on this device, for offline

export async function getLeadSettings() { return { url: DEFAULT_URL, tab: '', ...(await db.kvGet(SETTINGS_KEY, {})) }; }
export async function saveLeadSettings(patch) {
  const cur = await getLeadSettings();
  await db.kvSet(SETTINGS_KEY, { ...cur, ...patch, savedAt: Date.now() }, { fields: db.changedFields(cur, patch) });
}

export function parseSheetUrl(url) {
  const id = (String(url).match(/\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/) || [])[1] || (/^[A-Za-z0-9_-]{30,}$/.test(String(url).trim()) ? String(url).trim() : '');
  const gid = (String(url).match(/[#&?]gid=(\d+)/) || [])[1] || '';
  return { id, gid };
}

// Reads the chosen tab (by name, else the one in the link, else "Buy Sheet", else the first) as rows of cells.
export async function read({ url, tab }) {
  const fa = (await db.kvGet('fbaAdminSettings')) || {};
  if (!fa.googleClientId) throw new Error('Connect Google first (Devices & sync)');
  const { id, gid } = parseSheetUrl(url);
  if (!id) throw new Error("That doesn't look like a Google Sheets link");
  const meta = await (await apiFetch(fa.googleClientId, `https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=properties.title,sheets.properties(sheetId,title)`, {}, { label: 'Google Sheets' })).json();
  const tabs = meta.sheets.map((s) => s.properties);
  const pick = (tab && tabs.find((t) => t.title === tab)) || (gid && tabs.find((t) => String(t.sheetId) === gid)) || tabs.find((t) => /buy sheet/i.test(t.title)) || tabs[0];
  const range = encodeURIComponent(`'${pick.title.replace(/'/g, "''")}'!A1:AZ5000`);
  const v = await (await apiFetch(fa.googleClientId, `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${range}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`, {}, { label: 'Google Sheets' })).json();
  const out = { title: meta.properties.title, tab: pick.title, tabs: tabs.map((t) => t.title), values: v.values || [], at: Date.now(), id };
  await db.kvSet(CACHE_KEY, out);
  return out;
}
export const cached = () => db.kvGet(CACHE_KEY);

// ---------------------------------------------------------------------------
// Turning the rows into leads
// ---------------------------------------------------------------------------
const norm = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const COLS = {
  date: ['date', 'date added', 'date ordered', 'added'], title: ['product name', 'product', 'title', 'name'], asin: ['asin'],
  cost: ['cost price', 'cost', 'buy price', 'buy cost'], sale: ['sale price', 'sell price', 'price', 'selling price'],
  roi: ['potential roi', 'roi'], profit: ['profit per unit', 'profit per unit ', 'profit', 'profit unit'],
  spm: ['spm', 'sales per month', 'monthly sales', 'est sales'], dueUp: ['due to go up', 'price rise', 'going up'],
  notes: ['notes', 'note'], lead: ['lead', 'source', 'lead source'], buyFrom: ['buy from', 'store', 'supplier', 'retailer'],
  url: ['amazon url', 'amazon link', 'url'], priceDrop: ['price drop', 'drop'], qty: ['quantity', 'qty'],
};
const money = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v ?? '').replace(/[£$€,\s]/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
};
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
// "7 Mar 26", "16 March", "2026-03-07", "07/03/2026" -> YYYY-MM-DD (a date without a year takes `yearHint`)
export function toDate(v, yearHint = new Date().getFullYear()) {
  const s = String(v ?? '').trim();
  if (!s || s === '-') return '';
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/); if (m) { const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]); return iso(y, Number(m[2]) - 1, Number(m[1])); }
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3})[a-z]*\.?(?:\s+(\d{2,4}))?$/i);
  if (m && MONTHS[m[2].toLowerCase()] !== undefined) { const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : yearHint; return iso(y, MONTHS[m[2].toLowerCase()], Number(m[1])); }
  return '';
}
const iso = (y, mo, d) => new Date(Date.UTC(y, mo, d)).toISOString().slice(0, 10);

// -> { leads: [...], header, problems: { roiFixed, missing } }
export function toLeads(values) {
  const headerIdx = values.findIndex((r) => r.some((c) => norm(c) === 'asin'));
  const header = (values[headerIdx >= 0 ? headerIdx : 0] || []).map(norm);
  const col = {}; for (const [k, names] of Object.entries(COLS)) col[k] = header.findIndex((h) => names.includes(h));
  const leads = []; let roiFixed = 0;
  for (const r of values.slice((headerIdx >= 0 ? headerIdx : 0) + 1)) {
    const g = (k) => (col[k] >= 0 ? r[col[k]] : '');
    const asin = String(g('asin') || '').trim().toUpperCase() || (String(g('url')).match(/\/dp\/([A-Z0-9]{10})/i) || [])[1]?.toUpperCase() || '';
    const title = String(g('title') || '').trim();
    if (!asin && !title) continue;
    const date = toDate(g('date'));
    const cost = money(g('cost')); const sale = money(g('sale')); const profit = money(g('profit'));
    // ROI: worked out from profit ÷ cost, because the sheet's ROI column mixes %, decimals and £ amounts
    const roiRaw = g('roi');
    const roi = cost && profit !== null ? profit / cost : (typeof roiRaw === 'number' && roiRaw < 10 ? roiRaw : null);
    if (roiRaw !== '' && roiRaw !== undefined && (typeof roiRaw !== 'number' || roiRaw >= 10 || (roi !== null && Math.abs(roiRaw - roi) > 0.02))) roiFixed++;
    const spmText = String(g('spm') ?? '').trim();
    const spm = money(spmText.replace(/[^0-9.]/g, '')) ?? null;
    const dueUp = toDate(g('dueUp'), date ? Number(date.slice(0, 4)) : undefined);
    leads.push({
      date, title, asin, cost, sale, profit, roi, spm, spmText, dueUp, dueUpText: String(g('dueUp') ?? '').trim(),
      notes: String(g('notes') || ''), lead: String(g('lead') || ''), buyFrom: String(g('buyFrom') || ''), qty: money(g('qty')),
      url: String(g('url') || '') || (asin ? `https://www.amazon.co.uk/dp/${asin}` : ''), priceDrop: String(g('priceDrop') || ''),
    });
  }
  const missing = ['asin', 'cost', 'profit'].filter((k) => col[k] < 0);
  return { leads, header, problems: { roiFixed, missing } };
}

// 0–100: what's worth buying. 40% ROI (60%+ scores full), 30% profit per unit (£15+), 30% demand (1,000+/month),
// with a nudge for a price rise coming soon, and below-the-line leads (under 20% ROI or £2 profit) marked down.
export function score(l, today) {
  const roi = Math.max(0, Math.min(1, (l.roi ?? 0) / 0.6));
  const prof = Math.max(0, Math.min(1, (l.profit ?? 0) / 15));
  const dem = l.spm ? Math.max(0, Math.min(1, Math.log10(Math.max(1, l.spm)) / 3)) : 0.3;
  let s = 40 * roi + 30 * prof + 30 * dem;
  const daysToRise = l.dueUp ? (Date.parse(l.dueUp) - Date.parse(today)) / 864e5 : null;
  if (daysToRise !== null && daysToRise >= 0 && daysToRise <= 14) s += 8;
  if ((l.roi ?? 0) < 0.2 || (l.profit ?? 0) < 2) s -= 20;
  return Math.round(Math.max(0, Math.min(100, s)));
}

// The same ASIN listed more than once: the newest row counts, the rest are noted.
export function dedupe(leads) {
  const by = new Map();
  for (const l of leads) {
    const k = l.asin || l.title;
    const cur = by.get(k);
    if (!cur || (l.date || '') >= (cur.date || '')) by.set(k, { ...l, times: (cur?.times || 0) + 1 });
    else cur.times++;
  }
  return [...by.values()];
}
