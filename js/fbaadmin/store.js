// FBA Admin — storage adapter and settings (IndexedDB via db.js).
import * as db from '../db.js';
import { DEFAULT_RULES, recategorise } from './categories.js';
import { nonBankCosts, dlaCredits } from './expenses.js';
import { entryTxns } from './dla.js';
import { applySources } from './sources.js';

export const SETTINGS_KEY = 'fbaAdminSettings';
export const RULES_KEY = 'fbaCategoryRules';
export const CHECKLIST_KEY = 'fbaChecklist';

export const DEFAULT_SETTINGS = {
  googleClientId: '', spreadsheetId: '', spreadsheetUrl: '', lastSync: null, autoSync: true,
  overheadSource: 'auto', // auto = bank when the period has bank lines, else SellerToolkit expenses
  allocate: 'revenue', // how overheads are shared across products: revenue | units
  fyStart: '02-28', vatThreshold: 90000, vatRegistered: false, costsIncludeVat: true,
  bankAccountName: 'Revolut Business', bankCurrency: 'GBP',
  dlaOpening: 0, dlaDirection: 'company_owes_director', // director's loan at the start of the financial year
  dlaOpeningDate: '', // the date that balance is at (blank = start of whichever year you look at)
  associatedCompanies: 0, // for the corporation tax limits
  companyName: 'NBOYD GROUP LTD',
  invoiceStorage: 'both', // 'both' | 'local' | 'drive'
  driveFolders: {}, // cached Google Drive folder ids by path
  targets: { default: { sales: '', profit: '' }, months: {} }, // monthly sales / profit targets
  cfBuffer: 500, cfPayoutMode: 'sales', cfPayoutAmount: '', cfPayoutEvery: 14, cfPayoutNext: '', cfIncludeCt: true, cfIncludeStock: true, // cash-flow forecast
  cfHorizon: 28, cfReserveDays: 'auto', cfCadence: 'auto', cfLagDays: 'auto', // daily budget: days to spread over; payout timing (auto = learned)
  salesSource: 'sellertoolkit', sfCutover: '', // where sales, fees, COGS and expenses come from (sources.js)
  cfOpeningManual: false, cfOpeningAmount: '', cfOpeningDate: '',
  weeklyDiscord: false, weeklyDay: 1, weeklyHour: 8, weeklyLastSent: '', // Monday summary to Discord
  svTargetValue: '', svTargetBy: '', // stock value goal (at cost) and the date to reach it
  agedWarnDays: 60, // warn this many days before stock reaches Amazon's aged inventory surcharge
};

export const store = {
  getAll: (name) => db.getAll(name),
  commit: (writes) => db.putAcross(writes),
  put: (name, rec) => db.put(name, rec),
  putMany: (name, rows) => db.putMany(name, rows),
  del: (name, id) => db.del(name, id),
  delMany: (name, ids) => db.delMany(name, ids),
  getKv: (k) => db.kvGet(k),
  setKv: (k, v) => db.kvSet(k, v),
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
export async function getRules() {
  const r = await db.kvGet(RULES_KEY);
  return Array.isArray(r?.rules) ? r.rules : DEFAULT_RULES.map((x) => ({ ...x }));
}
export async function saveRules(rules) {
  await db.kvSet(RULES_KEY, { rules, savedAt: Date.now() });
}

export async function loadAll() {
  const [fees, settlements, subsSaved, invoices, ebaySales, ebayProducts, expenses, health, dlaEntries, suppliers, cashDays, payoutPreds, spendLog] = await Promise.all([
    db.getAll('faFees'), db.getAll('faSettlements'), db.getAll('faSubscriptions'), db.getAll('faInvoices'), db.getAll('ebaySales'), db.getAll('ebayProducts'),
    db.getAll('faExpenses'), db.getAll('faInvHealth'), db.getAll('faDlaEntries'), db.getAll('orSuppliers'), db.getAll('faCashDays'), db.getAll('faPayoutPreds'), db.getAll('faSpendLog'),
  ]);
  const [txns, orders, stkExpenses, stock, imports, units, ledger, listings, salesDash, settings, rules, rtImports, checklist] = await Promise.all([
    db.getAll('faTransactions'), db.getAll('faSoldProducts'), db.getAll('faStkExpenses'), db.getAll('faStock'), db.getAll('faImportLog'),
    db.getAll('rtUnits'), db.getAll('faLedger'), db.getAll('faListings'), db.kvGet('fbaSalesDashboard', { months: {} }), getSettings(), getRules(),
    db.getAll('rtImports'), db.kvGet(CHECKLIST_KEY, { months: {} }),
  ]);
  txns.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (Number(b.balance) || 0) - (Number(a.balance) || 0));
  orders.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  imports.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const nonBank = nonBankCosts(expenses);
  // SellerToolkit or SellerFuse (from the cut-over date): everything below sees only the rows that count
  const src = applySources({ orders, stkExpenses, stock, ebaySales }, settings);
  return { txns, orders: src.orders, stkExpenses: src.stkExpenses, stock: src.stock, imports, units, ledger, listings, salesDash: salesDash || { months: {} }, settings, rules, rtImports, checklist: checklist || { months: {} },
    fees, settlements, subsSaved, invoices, ebaySales: src.ebaySales, ebayProducts, expenses, health, dlaEntries, suppliers, cashDays, payoutPreds, spendLog,
    ordersAll: orders, stkExpensesAll: stkExpenses, stockAll: stock, salesLabel: src.label, expensesLabel: src.expensesLabel, sourceInfo: src.info,
    // costs paid outside the imported bank account: in the P&L, and (when paid personally) on the director's loan
    nonBank, dlaTxns: [...txns, ...dlaCredits(nonBank), ...entryTxns(dlaEntries)] };
}

// One-time updates for data saved by an earlier version. Safe to call on every load.
export async function migrate() {
  const s = await getSettings();
  if ((s.schema || 0) >= 15) return false;
  if ((s.schema || 0) === 14) { // v2.0: payouts predicted from sales (falls back to payout history when it can't)
    await saveSettings({ schema: 15, ...(s.cfPayoutMode === 'auto' ? { cfPayoutMode: 'sales' } : {}) });
    return false;
  }
  const patch = { schema: 15, cfPayoutMode: s.cfPayoutMode === 'auto' ? 'sales' : s.cfPayoutMode };
  if (!s.fyStart || s.fyStart === '04-06') patch.fyStart = '02-28'; // NBOYD GROUP LTD's financial year
  const saved = await db.kvGet(RULES_KEY);
  if (Array.isArray(saved?.rules)) {
    const rules = saved.rules.map((r) => (/klarna/i.test(r.keyword) && r.category === 'Stock Purchase' ? { ...r, category: 'Director Loan' } : r));
    await saveRules(rules);
  }
  const changed = recategorise(await db.getAll('faTransactions'), await getRules());
  if (changed.length) await db.putMany('faTransactions', changed);
  await saveSettings(patch);
  return changed.length;
}

// Monthly tick-list: { months: { 'YYYY-MM': { reportId: true } } }. Ticks mean "done / nothing to download".
export async function setTick(month, reportId, on) {
  const c = (await db.kvGet(CHECKLIST_KEY)) || { months: {} };
  const m = { ...(c.months?.[month] || {}) };
  if (on) m[reportId] = true; else delete m[reportId];
  await db.kvSet(CHECKLIST_KEY, { months: { ...(c.months || {}), [month]: m }, savedAt: Date.now() });
}
