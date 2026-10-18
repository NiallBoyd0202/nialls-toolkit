// FBA Returns tracker — IndexedDB store adapter (the only browser-bound piece of the data path).
import * as db from '../db.js';

export const SETTINGS_KEY = 'returnsSettings';
export const DEFAULT_SETTINGS = { currency: '£', costsIncludeVat: true, staleDays: 30, sheetUrl: '', sheetToken: '', autoSync: false, lastSync: null };

export const store = {
  allUnits: () => db.getAll('rtUnits'),
  allSkuCosts: () => db.getAll('rtSkuCosts'),
  allImports: () => db.getAll('rtImports'),
  allUnmatched: () => db.getAll('rtUnmatched'),
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
export async function saveSettings(patch) {
  const cur = await getSettings();
  const s = { ...cur, ...patch, savedAt: Date.now() };
  await db.kvSet(SETTINGS_KEY, s, { fields: db.changedFields(cur, patch) });
  return s;
}
