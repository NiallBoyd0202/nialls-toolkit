// Business logic: settings, Keepa client, product cache, storefront tracking, CSV export/import.
import * as db from './db.js';
import { KeepaClient, DemoKeepa } from './keepa.js';
import {
  summariseProduct, MARKETS, MARKET_IDS, keepaToMs, amazonUrl, storefrontUrl, sellerProfileUrl,
  money, num, sleep, chunk, parseSellerInput, normHeader,
} from './util.js';

export const APP_NAME = "Niall's Toolkit";

export const DEFAULT_SETTINGS = {
  keepaKey: '',
  demoMode: true,
  productCacheHours: 24,
  ebayFeePct: 0.128,
  ebayFeeFixed: 0.30,
};

let settingsCache = null;
let client = null;
const tokenListeners = new Set();

export async function getSettings() {
  if (!settingsCache) settingsCache = { ...DEFAULT_SETTINGS, ...(await db.kvGet('settings', {})) };
  return settingsCache;
}

export async function saveSettings(patch) {
  settingsCache = null; // read fresh: sync may have changed them since
  const cur = await getSettings();
  const s = { ...cur, ...patch, savedAt: Date.now() };
  settingsCache = s;
  await db.kvSet('settings', s, { fields: db.changedFields(cur, patch) });
  client = null; // rebuild with new key / mode
  return s;
}

// After sync brings in changes from another device.
export function forgetCachedSettings() { settingsCache = null; client = null; }

export function isDemo(s = settingsCache) {
  return !s || s.demoMode || !s.keepaKey;
}

export function onTokens(fn) { tokenListeners.add(fn); return () => tokenListeners.delete(fn); }
const emitTokens = (t) => tokenListeners.forEach((fn) => fn(t));

export async function keepa() {
  const s = await getSettings();
  if (!client) client = isDemo(s) ? new DemoKeepa({ onTokens: emitTokens }) : new KeepaClient(s.keepaKey, { onTokens: emitTokens });
  client.resetCancel();
  return client;
}

export function cancelKeepa() { if (client) client.cancel(); }

// ---------------------------------------------------------------------------
// Product cache
// ---------------------------------------------------------------------------
export async function getProducts(domain, asins, { maxAgeHours, force = false, onProgress } = {}) {
  const s = await getSettings();
  const maxAge = (maxAgeHours ?? s.productCacheHours) * 3600e3;
  const out = new Map();
  const missing = [];
  for (const a of [...new Set(asins)]) {
    const cached = await db.get('products', `${domain}:${a}`);
    if (cached && !force && Date.now() - cached.fetchedAt < maxAge) out.set(a, cached);
    else missing.push(a);
  }
  if (missing.length) {
    const k = await keepa();
    let done = 0;
    for (const group of chunk(missing, 100)) {
      const raw = await k.products(domain, group);
      const rows = raw.map((p) => summariseProduct(p, domain)).filter(Boolean);
      await db.putMany('products', rows);
      for (const r of rows) out.set(r.asin, r);
      done += group.length;
      onProgress && onProgress(done, missing.length);
    }
  }
  return out;
}

export async function cachedProducts(domain, asins) {
  const out = new Map();
  for (const a of asins) {
    const p = await db.get('products', `${domain}:${a}`);
    if (p) out.set(a, p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sellers / storefronts
// ---------------------------------------------------------------------------
export const sellerKey = (domain, id) => `${domain}:${id}`;

export async function addSeller(sellerId, domain = 2, { source = 'manual', name = '', note = '' } = {}) {
  const key = sellerKey(domain, sellerId);
  const existing = await db.get('sellers', key);
  if (existing) return { seller: existing, existed: true };
  const seller = {
    key, sellerId, domain, name: name || '', source, note,
    addedAt: Date.now(), lastRefresh: null, status: 'pending', asinCount: 0,
    lastNew: 0, lastRemoved: 0, totalNew: 0, rating: null, ratingCount: null,
  };
  await db.put('sellers', seller);
  return { seller, existed: false };
}

export async function removeSeller(key) {
  const items = await db.getAllByIndex('items', 'bySeller', key);
  await db.delMany('items', items.map((i) => i.key));
  await db.del('sellers', key);
}

function sellerMeta(s) {
  const rc = Array.isArray(s.ratingCount) ? s.ratingCount : [];
  const pr = Array.isArray(s.positiveRating) ? s.positiveRating : [];
  return {
    name: s.sellerName || s.businessName || '',
    ratingCount: rc.length ? rc[rc.length - 1] : null,
    rating: pr.length ? (pr[2] ?? pr[pr.length - 1]) : null,
    hasFBA: s.hasFBA ?? null,
  };
}

// Refresh one or more storefronts and diff against what we saw last time.
export async function refreshSellers(keys, { onProgress = () => {}, fetchDetails = true, full = false } = {}) {
  const k = await keepa();
  const s = await getSettings();
  const now = Date.now();
  const summary = { sellers: 0, newItems: [], removed: 0, errors: [], startTokens: k.used };
  const total = keys.length;
  const steps = total + (fetchDetails ? 1 : 0);

  for (let i = 0; i < keys.length; i++) {
    const seller = await db.get('sellers', keys[i]);
    if (!seller) continue;
    onProgress(i / steps, `Refreshing ${seller.name || seller.sellerId} (${i + 1}/${total})`);
    try {
      const data = await k.seller(seller.domain, seller.sellerId);
      if (!data) throw new Error('Seller not found on Keepa for this marketplace');
      const asins = data.asinList || [];
      const lastSeen = data.asinListLastSeen || [];
      const existing = await db.getAllByIndex('items', 'bySeller', seller.key);
      const exMap = new Map(existing.map((it) => [it.asin, it]));
      const isFirst = !seller.lastRefresh;
      const writes = [];
      const current = new Set(asins);
      let newCount = 0;
      asins.forEach((asin, idx) => {
        const ex = exMap.get(asin);
        const ls = lastSeen[idx] ? keepaToMs(lastSeen[idx]) : null;
        if (!ex) {
          const item = {
            key: `${seller.key}:${asin}`, sellerKey: seller.key, pkey: `${seller.domain}:${asin}`,
            asin, domain: seller.domain, firstSeen: now, keepaLastSeen: ls,
            baseline: isFirst, reviewed: isFirst, removedAt: null,
          };
          writes.push(item);
          if (!isFirst) { newCount++; summary.newItems.push(item); }
        } else if (ex.removedAt) {
          // re-listed after dropping off -> treat as new again
          const item = { ...ex, removedAt: null, firstSeen: now, baseline: false, reviewed: false, relisted: true, keepaLastSeen: ls };
          writes.push(item); newCount++; summary.newItems.push(item);
        } else if (ls && ls !== ex.keepaLastSeen) {
          writes.push({ ...ex, keepaLastSeen: ls });
        }
      });
      let removed = 0;
      for (const ex of existing) {
        if (!current.has(ex.asin) && !ex.removedAt) { writes.push({ ...ex, removedAt: now }); removed++; }
      }
      await db.putMany('items', writes);
      const meta = sellerMeta(data);
      await db.put('sellers', {
        ...seller, ...meta, name: meta.name || seller.name,
        status: 'ok', error: null, lastRefresh: now, asinCount: asins.length,
        lastNew: newCount, lastRemoved: removed, totalNew: (seller.totalNew || 0) + newCount,
      });
      summary.sellers++;
      summary.removed += removed;
    } catch (e) {
      if (e.message === 'Cancelled') throw e;
      summary.errors.push({ seller: seller.name || seller.sellerId, error: e.message });
      await db.put('sellers', { ...seller, status: 'error', error: e.message });
    }
  }

  // Product details for the new items so the feed shows titles, prices and BSR.
  if (fetchDetails && summary.newItems.length) {
    const byDomain = {};
    for (const it of summary.newItems) (byDomain[it.domain] ||= []).push(it.asin);
    for (const [domain, asins] of Object.entries(byDomain)) {
      await getProducts(Number(domain), asins, {
        onProgress: (d, t) => onProgress((total + d / t) / steps, `Loading details for ${t} new products (${d}/${t})`),
      });
    }
  }
  onProgress(1, 'Done');
  summary.tokensUsed = k.used - summary.startTokens;
  await db.put('refreshLog', { at: now, sellers: summary.sellers, newCount: summary.newItems.length, removed: summary.removed, tokensUsed: summary.tokensUsed, errors: summary.errors.length });
  if (full) await db.kvSet('lastFullRefresh', now);
  return summary;
}

// ---------------------------------------------------------------------------
// Storefront CSV export / import
// ---------------------------------------------------------------------------
export const STOREFRONT_CSV_HEADER = [
  'Name', 'Seller ID', 'Marketplace', 'Storefront link', 'Seller profile link', 'Products listed',
  'New (last 7 days)', 'Dropped (last 7 days)', 'New since tracking', 'New at last refresh',
  'Rating % (12m)', 'Ratings', 'Last refresh', 'Added', 'Note',
];

export async function storefrontRows() {
  const sellers = await db.getAll('sellers');
  const items = await db.getAll('items');
  const wk = Date.now() - 7 * 86400e3;
  const stats = new Map();
  for (const it of items) {
    if (!stats.has(it.sellerKey)) stats.set(it.sellerKey, { new7: 0, dropped7: 0 });
    const c = stats.get(it.sellerKey);
    if (!it.baseline && !it.removedAt && it.firstSeen > wk) c.new7++;
    if (it.removedAt && it.removedAt > wk) c.dropped7++;
  }
  const iso = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) : '');
  return sellers
    .sort((a, b) => (a.name || a.sellerId).localeCompare(b.name || b.sellerId))
    .map((s) => {
      const c = stats.get(s.key) || { new7: 0, dropped7: 0 };
      return [
        s.name || '', s.sellerId, MARKETS[s.domain]?.code || s.domain, storefrontUrl(s.domain, s.sellerId), sellerProfileUrl(s.domain, s.sellerId),
        s.asinCount ?? '', c.new7, c.dropped7, s.totalNew ?? 0, s.lastNew ?? 0,
        s.rating ?? '', s.ratingCount ?? '', iso(s.lastRefresh), iso(s.addedAt), s.note || '',
      ];
    });
}

const CODE_TO_DOMAIN = Object.fromEntries(MARKET_IDS.map((d) => [MARKETS[d].code, d]));

// rows: array of arrays (from CSV/XLSX). Returns [{sellerId, domain, name, note}] (deduped).
export function parseStorefrontImport(rows, defaultDomain = 2) {
  if (!rows.length) return [];
  const hdr = rows[0].map(normHeader);
  const col = (...names) => hdr.findIndex((h) => names.includes(h));
  const iId = col('seller id', 'sellerid', 'seller', 'merchant id', 'merchant token', 'id');
  const iLink = col('storefront link', 'storefront', 'link', 'url', 'storefront url', 'seller profile link');
  const iName = col('name', 'seller name', 'storefront name');
  const iMkt = col('marketplace', 'market', 'country', 'domain');
  const iNote = col('note', 'notes');
  const hasHeader = [iId, iLink, iName, iMkt, iNote].some((i) => i >= 0);
  const body = hasHeader ? rows.slice(1) : rows;
  const out = new Map();
  for (const r of body) {
    let parsed = null;
    if (hasHeader) {
      if (iId >= 0) parsed = parseSellerInput(r[iId]);
      if (!parsed && iLink >= 0) parsed = parseSellerInput(r[iLink]);
    }
    if (!parsed) for (const cell of r) { parsed = parseSellerInput(cell); if (parsed) break; }
    if (!parsed) continue;
    let domain = parsed.domain;
    if (!domain && iMkt >= 0) {
      const v = String(r[iMkt] || '').trim().toUpperCase();
      domain = CODE_TO_DOMAIN[v === 'GB' ? 'UK' : v] || (Number(v) && MARKETS[Number(v)] ? Number(v) : null);
    }
    if (!domain && iLink >= 0) domain = parseSellerInput(r[iLink])?.domain || null;
    domain = domain || defaultDomain;
    const key = sellerKey(domain, parsed.sellerId);
    if (out.has(key)) continue;
    out.set(key, {
      key, sellerId: parsed.sellerId, domain,
      name: iName >= 0 ? String(r[iName] || '').trim() : '',
      note: iNote >= 0 ? String(r[iNote] || '').trim() : '',
    });
  }
  return [...out.values()];
}
