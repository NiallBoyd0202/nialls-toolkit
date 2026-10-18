// Shared helpers: marketplaces, Keepa conversions, formatting, CSV.

export const MARKETS = {
  2: { id: 2, code: 'UK', host: 'www.amazon.co.uk', currency: 'GBP', symbol: '£', vat: 0.20, amazonSellerId: 'A3P5ROKL5A1OLE', marketplaceId: 'A1F83G8C2ARO7P' },
  3: { id: 3, code: 'DE', host: 'www.amazon.de', currency: 'EUR', symbol: '€', vat: 0.19, amazonSellerId: 'A3JWKAKR8XB7XF', marketplaceId: 'A1PA6795UKMFR9' },
  4: { id: 4, code: 'FR', host: 'www.amazon.fr', currency: 'EUR', symbol: '€', vat: 0.20, amazonSellerId: 'A1X6FK5RDHNB96', marketplaceId: 'A13V1IB3VIYZZH' },
  8: { id: 8, code: 'IT', host: 'www.amazon.it', currency: 'EUR', symbol: '€', vat: 0.22, amazonSellerId: 'A11IL2PNWYJU7H', marketplaceId: 'APJ6JRA9NG5V4' },
  9: { id: 9, code: 'ES', host: 'www.amazon.es', currency: 'EUR', symbol: '€', vat: 0.21, amazonSellerId: 'A1AT7YVPFBWXBL', marketplaceId: 'A1RKKUPIHCS9HS' },
};
export const MARKET_IDS = [2, 3, 4, 8, 9];

export function domainFromHost(host) {
  host = (host || '').toLowerCase();
  if (host.endsWith('amazon.co.uk')) return 2;
  if (host.endsWith('amazon.de')) return 3;
  if (host.endsWith('amazon.fr')) return 4;
  if (host.endsWith('amazon.it')) return 8;
  if (host.endsWith('amazon.es')) return 9;
  return null;
}

// Accepts a raw seller ID or any Amazon URL containing seller=/me=/merchant=.
export function parseSellerInput(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  let domain = null;
  let id = null;
  try {
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s);
      domain = domainFromHost(u.hostname);
      id = u.searchParams.get('seller') || u.searchParams.get('me') || u.searchParams.get('merchant') || u.searchParams.get('smid');
    }
  } catch { /* not a URL */ }
  if (!id) {
    const m = s.match(/\b(A[0-9A-Z]{9,20})\b/);
    if (m) id = m[1];
  }
  if (!id || !/^A[0-9A-Z]{9,20}$/.test(id)) return null;
  return { sellerId: id, domain };
}

// ---- Keepa time ----
export const keepaToMs = (km) => (km + 21564000) * 60000;
export const msToKeepa = (ms) => Math.floor(ms / 60000) - 21564000;

// ---- formatting ----
export function money(v, symbol = '£', dp = 2) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const neg = v < 0;
  const s = Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return `${neg ? '−' : ''}${symbol}${s}`;
}
export function num(v, dp = 0) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return Number(v).toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
export function pct(v, dp = 0) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(dp)}%`;
}
export function ago(ms) {
  if (!ms) return 'never';
  const d = Date.now() - ms;
  if (d < 60e3) return 'just now';
  if (d < 3600e3) return `${Math.floor(d / 60e3)}m ago`;
  if (d < 86400e3) return `${Math.floor(d / 3600e3)}h ago`;
  const days = Math.floor(d / 86400e3);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}
export function dateStr(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
export function dateTimeStr(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- links ----
export const amazonUrl = (domain, asin) => `https://${MARKETS[domain]?.host || MARKETS[2].host}/dp/${asin}`;
export const keepaUrl = (domain, asin) => `https://keepa.com/#!product/${domain}-${asin}`;
export const storefrontUrl = (domain, sellerId) => `https://${MARKETS[domain]?.host || MARKETS[2].host}/s?me=${sellerId}&marketplaceID=${MARKETS[domain]?.marketplaceId || ''}`;
export const sellerProfileUrl = (domain, sellerId) => `https://${MARKETS[domain]?.host || MARKETS[2].host}/sp?seller=${sellerId}`;
export const googleShopUrl = (q) => `https://www.google.co.uk/search?tbm=shop&q=${encodeURIComponent(q)}`;
export const imageUrl = (name, size = 160) => (name ? `https://m.media-amazon.com/images/I/${name.replace(/\.(jpg|jpeg|png|gif)$/i, `._SL${size}_.$1`)}` : '');

// ---- Keepa product -> compact summary used everywhere in the UI ----
const pos = (v) => (typeof v === 'number' && v > 0 ? v : null);

export function summariseProduct(p, domain) {
  if (!p) return null;
  const s = p.stats || {};
  const cur = s.current || [];
  const avg90 = s.avg90 || [];
  const avg30 = s.avg30 || [];
  const avg180 = s.avg180 || [];
  const cents = (v) => (pos(v) ? v / 100 : null);
  // lowest / highest in the stats window (90 days): Keepa gives [time, value] pairs per price type
  const inWin = (arr, i) => (Array.isArray(arr?.[i]) ? cents(arr[i][1]) : null);

  let image = null;
  if (Array.isArray(p.images) && p.images.length) image = p.images[0].l || p.images[0].m || null;
  if (!image && p.imagesCSV) image = String(p.imagesCSV).split(',')[0] || null;

  const tree = Array.isArray(p.categoryTree) ? p.categoryTree : [];
  const buyBox = cents(s.buyBoxPrice) ?? cents(cur[18]);
  const newFba = cents(cur[10]);
  const newLow = cents(cur[1]);
  const amazon = cents(cur[0]);
  const price = buyBox ?? newFba ?? newLow ?? amazon;

  let referralPct = p.referralFeePercentage ?? p.referralFeePercent ?? null;
  if (referralPct !== null && referralPct > 1) referralPct = referralPct / 100;

  const offerCount =
    (Number.isFinite(s.offerCountFBA) || Number.isFinite(s.offerCountFBM))
      ? (s.offerCountFBA || 0) + (s.offerCountFBM || 0)
      : (pos(cur[11]) ?? (cur[11] === 0 ? 0 : null));

  const codes = [...(p.eanList || []), ...(p.upcList || [])].map(String);

  return {
    key: `${domain}:${p.asin}`,
    asin: p.asin,
    domain,
    title: p.title || '(no title)',
    brand: p.brand || '',
    image,
    category: tree.length ? tree[0].name : '',
    subCategory: tree.length ? tree[tree.length - 1].name : '',
    price,
    buyBox,
    newFba,
    newLow,
    amazonPrice: amazon,
    amazonOnListing: !!amazon || s.buyBoxIsAmazon === true,
    avg90: cents(avg90[18]) ?? cents(avg90[1]),
    avg30: cents(avg30[18]) ?? cents(avg30[1]),
    avg180: cents(avg180[18]) ?? cents(avg180[1]),
    min90: inWin(s.minInInterval, 18) ?? inWin(s.minInInterval, 1),
    max90: inWin(s.maxInInterval, 18) ?? inWin(s.maxInInterval, 1),
    bsr: pos(cur[3]),
    bsrAvg30: pos(avg30[3]),
    bsrAvg90: pos(avg90[3]),
    bsrAvg180: pos(avg180[3]),
    drops30: Number.isFinite(s.salesRankDrops30) ? s.salesRankDrops30 : null,
    monthlySold: pos(p.monthlySold),
    offerCount,
    fbaOffers: Number.isFinite(s.offerCountFBA) ? s.offerCountFBA : null,
    fbaFee: p.fbaFees && pos(p.fbaFees.pickAndPackFee) ? p.fbaFees.pickAndPackFee / 100 : null,
    referralPct,
    codes,
    listedSince: pos(p.listedSince) ? keepaToMs(p.listedSince) : null,
    fetchedAt: Date.now(),
  };
}

// ---- CSV ----
export function parseCSV(text) {
  // RFC4180-ish parser with auto delimiter (comma / semicolon / tab).
  text = String(text || '').replace(/^﻿/, '');
  const firstLines = text.split(/\r?\n/).slice(0, 10).join('\n');
  const counts = { ',': 0, ';': 0, '\t': 0 };
  for (const ch of firstLines) if (ch in counts) counts[ch]++;
  const delim = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

export function toCSV(rows) {
  return rows.map((r) => r.map((v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\r\n');
}

export function downloadFile(name, content, type = 'text/csv') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// Parse a money-ish cell: "£1,234.50", "-12.30", "1.234,50 €", "--" -> number|null
export function parseMoney(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  let s = String(v).trim();
  if (!s || s === '--' || s === '-' || s.toLowerCase() === 'n/a') return null;
  const neg = /^\(.*\)$/.test(s) || /^[-−–]/.test(s) || /[-−–]$/.test(s);
  s = s.replace(/[^0-9.,]/g, '');
  if (!s) return null;
  if (s.includes(',') && s.includes('.')) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (s.includes(',')) {
    const parts = s.split(',');
    s = parts[parts.length - 1].length === 2 ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  }
  const n = parseFloat(s);
  if (Number.isNaN(n)) return null;
  return neg ? -n : n;
}

export function normHeader(h) {
  return String(h || '').toLowerCase().replace(/[‘’“”"']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

export function debounce(fn, ms = 250) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export function startOfDay(ms = Date.now()) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
