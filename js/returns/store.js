// FBA Returns tracker — IndexedDB store adapter (the only browser-bound piece of the data path).
import * as db from '../db.js';
import { refundUnits, defaultSince } from './fromorders.js';
import { applySources } from '../fbaadmin/sources.js';

export const SETTINGS_KEY = 'returnsSettings';
export const DEFAULT_SETTINGS = { currency: '£', costsIncludeVat: true, staleDays: 30, sheetUrl: '', sheetToken: '', autoSync: false, lastSync: null,
  autoFromRefunds: true, refundsFrom: '' }; // units from refunds in your order data (fromorders.js), from this date

export const store = {
  allUnits: () => db.getAll('rtUnits'),
  allSkuCosts: () => db.getAll('rtSkuCosts'),
  allImports: () => db.getAll('rtImports'),
  allUnmatched: () => db.getAll('rtUnmatched'),
  allOrders: () => db.getAll('faSoldProducts'), // FBA Admin's order lines, for return rates
  putUnits: (a) => db.putMany('rtUnits', a),
  putSkuCosts: (a) => db.putMany('rtSkuCosts', a),
  putUnmatched: (a) => db.putMany('rtUnmatched', a),
  putImportLog: (r) => db.put('rtImports', r),
  putUnit: (u) => db.put('rtUnits', { ...u, updatedAt: new Date().toISOString() }),
  delUnit: (id) => db.del('rtUnits', id),
  delUnmatched: (ids) => db.delMany('rtUnmatched', ids),
  commit: ({ units, skuCosts, unmatched, log }) => db.putAcross({ rtUnits: units, rtSkuCosts: skuCosts, rtUnmatched: unmatched, rtImports: [log] }),
};

export async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await db.kvGet(SETTINGS_KEY, {})) };
}
// Brings in refunded items from your order data (SellerToolkit, or SellerFuse from its cut-over date) as return units,
// and adds the outbound FBA fee to returned units. Safe to run any time: it never duplicates. Returns the counts.
export async function syncRefunds({ force = false } = {}) {
  const s = await getSettings();
  if (s.autoFromRefunds === false && !force) return null;
  const [units, skuCosts, allOrders, fa] = await Promise.all([db.getAll('rtUnits'), db.getAll('rtSkuCosts'), db.getAll('faSoldProducts'), db.kvGet('fbaAdminSettings', {})]);
  if (!allOrders.length) return { created: 0, relisted: 0, feesAdded: 0 };
  let since = s.refundsFrom;
  if (!since) { since = defaultSince(units, new Date().toISOString().slice(0, 10)); await saveSettings({ refundsFrom: since }); }
  const { orders } = applySources({ orders: allOrders }, fa || {});
  const r = refundUnits(units, orders, skuCosts, { since });
  if (r.units.length) {
    await db.putMany('rtUnits', r.units);
    if (r.stats.created) await db.put('rtImports', { id: `imp-${Date.now()}`, at: new Date().toISOString(), formatId: 'refunds', formatLabel: 'Refunds in your order data', fileName: '(from your orders)', stats: { rows: r.stats.created, created: r.stats.created, updated: r.stats.feesAdded, skipped: 0, unmatched: 0 } });
  }
  return r.stats;
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  const s = { ...cur, ...patch, savedAt: Date.now() };
  await db.kvSet(SETTINGS_KEY, s, { fields: db.changedFields(cur, patch) });
  return s;
}
