// FBA Admin — what goes to the FBA Accounting spreadsheet, and pulling category fixes back from it.
import { loadAll, saveSettings, getSettings, store } from './store.js';
import { compute, cash, presetRange } from './pnl.js';
import { ALL_CATEGORIES } from './categories.js';
import { ensureSpreadsheet, writeTabs, readTab } from './google.js';
import { ledgerRows } from '../returns/ledger.js';
import { stockReport } from './stock.js';
import { reconcilePayouts } from './settlement.js';
import { detectSubscriptions, mergeSubscriptions } from './subscriptions.js';
import { dlaStatement } from './yearend.js';
import { buildYearEnd } from './yearpack.js';
import { expectedItems, matchToBank, perYear } from './expenses.js';
import { forecast, ctDueDate } from './cashflow.js';
import { periods as stockPeriods, rates as stockRates, plan as stockPlan } from './stockvalue.js';
import { monthProgress, recentMonths, nextMonths, targetFor } from './targets.js';
import { payoutSetup } from './cashplan.js';
import { outreachTabs } from '../outreach/sheet.js';

const pct = (v) => (v === null || v === undefined ? '' : Math.round(v * 1000) / 10);

// 'auto' is resolved month by month inside pnl.overheads(); kept as a function so callers have one place to ask.
export function overheadSourceFor(_data, _from, _to, setting) {
  return setting || 'auto';
}

export function buildTabs(data) {
  const s = data.settings;
  const periods = ['this_month', 'last_month', 'last_3_months', 'ytd', 'this_fy', 'last_fy', 'all'];
  const dash = [['Period', 'From', 'To', 'Revenue', 'Amazon fees', 'VAT on fees', 'COGS', 'SellerToolkit profit', 'Amazon account fees', 'Reimbursements', 'Overheads', 'Overheads from', 'Returns loss', 'Net profit (Amazon)', 'Net margin %', 'eBay profit', 'Net profit (Amazon + eBay)', 'Units sold', 'Return rate %', 'Money in', 'Money out', 'Net cash', 'Amazon payouts']];
  for (const id of periods) {
    const r = presetRange(id, { fyStart: s.fyStart });
    const src = overheadSourceFor(data, r.from, r.to, s.overheadSource);
    const p = compute(data, { from: r.from, to: r.to, overheadSource: src, allocate: s.allocate });
    const c = cash(data.txns, r.from, r.to);
    dash.push([r.label, id === 'all' ? '' : r.from, id === 'all' ? '' : r.to, p.revenue, p.fees, p.vatOnFees, p.cogs, p.stkProfit, p.accountFees, p.reimbursements, p.overheads, p.overheadsFrom, p.returnsLoss, p.netProfit, pct(p.margin), p.ebay.profit, p.combinedNet, p.units, pct(p.returnRate), c.moneyIn, c.moneyOut, c.net, c.amazonPayouts]);
  }

  // month by month
  const months = [...new Set([...data.orders.map((o) => o.date), ...data.txns.map((t) => t.date)].filter(Boolean).map((d) => d.slice(0, 7)))].sort().reverse();
  const monthly = [['Month', 'Revenue', 'SellerToolkit profit', 'Amazon account fees', 'Reimbursements', 'Overheads', 'Returns loss', 'Net profit (Amazon)', 'eBay profit', 'Net profit (Amazon + eBay)', 'Money in', 'Money out', 'Net cash']];
  for (const m of months) {
    const [y, mo] = m.split('-').map(Number);
    const from = `${m}-01`; const to = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
    const p = compute(data, { from, to, overheadSource: overheadSourceFor(data, from, to, s.overheadSource), allocate: s.allocate });
    const c = cash(data.txns, from, to);
    monthly.push([m, p.revenue, p.stkProfit, p.accountFees, p.reimbursements, p.overheads, p.returnsLoss, p.netProfit, p.ebay.profit, p.combinedNet, c.moneyIn, c.moneyOut, c.net]);
  }

  const all = compute(data, { from: '2000-01-01', to: '2100-01-01', overheadSource: s.overheadSource, allocate: s.allocate });
  const products = [['SKU', 'ASIN', 'Title', 'Units', 'Refunded', 'Revenue', 'Amazon fees', 'VAT on fees', 'COGS', 'SellerToolkit profit', 'Returns loss', 'Overhead share', 'Actual net', 'Net per unit', 'Margin %', 'ROI %'],
    ...all.products.map((p) => [p.sku, p.asin, p.title, p.units, p.refunded, p.revenue, p.fees, p.vat, p.cogs, p.stkProfit, p.returnsAdj, p.overhead, p.actualNet, p.perUnit ?? '', pct(p.margin), pct(p.roi)])];

  const txns = [['Id', 'Date', 'Description', 'Reference', 'Type', 'Amount', 'Balance', 'Account', 'Category', 'Set by', 'Rule keyword'],
    ...data.txns.map((t) => [t.id, t.date, t.description, t.reference, t.type, t.amount, t.balance, t.account, t.category, t.categorySource === 'manual' ? 'You' : t.categorySource === 'rule' ? 'Rule' : 'Default', t.ruleKeyword])];
  const orders = [['Order date', 'Refund date', 'Order id', 'SKU', 'ASIN', 'Title', 'Status', 'Shipped', 'Refunded', 'Net qty', 'Sale', 'Amazon fees', 'VAT on fees', 'COGS', 'Profit', 'Refund reason'],
    ...data.orders.map((o) => [o.date, o.refundDate, o.orderId, o.sku, o.asin, o.title, o.status, o.qtyShipped, o.qtyRefunded, o.qtyNet, o.sale, o.fees, o.vat, o.cog, o.profit, o.refundReason])];
  const stock = [['Date purchased', 'Product', 'SKU', 'ASIN', 'Supplier', 'Quantity', 'Unit cost (incl. delivery/prep)', 'Total cost', 'Received', 'Status', 'Shipment', 'Order no.'],
    ...data.stock.sort((a, b) => (b.datePurchased || '').localeCompare(a.datePurchased || '')).map((x) => [x.datePurchased, x.productName, x.sku, x.asin, x.supplier, x.quantity, x.unitCost, x.totalCost, x.qtyReceived, x.status, x.shipmentId, x.orderNumber])];
  const expenses = [['Date', 'Category', 'Description', 'Amount'], ...data.stkExpenses.sort((a, b) => (b.date || '').localeCompare(a.date || '')).map((e) => [e.date, e.category, e.description, e.amount])];
  const rules = [['Keyword', 'Category'], ...data.rules.map((r) => [r.keyword, r.category])];
  const tabs = { Dashboard: dash, Monthly: monthly, 'Sold Products': products, Transactions: txns, 'Amazon Orders': orders, 'Stock Purchases': stock, 'Expenses (SellerToolkit)': expenses, 'Category Rules': rules };
  if (data.units.length) tabs.Returns = ledgerRows(data.units);
  if (data.settlements.length) {
    const rec = reconcilePayouts(data.settlements, data.txns);
    tabs.Payouts = [['Deposit date', 'Settlement', 'Period', 'Amount', 'In bank on', 'Matched'], ...rec.rows.map((x) => [x.depositDate, x.settlementId, x.start ? `${x.start} – ${x.end}` : '', x.total, x.bankDate, x.matched ? 'Yes' : 'NO'])];
  }
  const acct = data.fees.filter((l) => l.group === 'fee' || l.group === 'income');
  if (acct.length) tabs['Amazon Account Fees'] = [['Date', 'Type', 'Description', 'Settlement', 'Cost (+) / income (−)'], ...acct.sort((a, b) => (b.date || '').localeCompare(a.date || '')).map((l) => [l.date, l.feeType, l.description, l.settlementId, -l.amount])];
  const subs = mergeSubscriptions(detectSubscriptions(data.txns), data.subsSaved);
  if (subs.all.length) tabs.Subscriptions = [['Payee', 'Amount', 'Frequency', 'Per year', 'Last paid', 'Next due', 'Status', 'Note'], ...subs.all.map((x) => [x.name, x.amount, x.frequency, x.annual, x.lastSeen, x.nextDue, x.dismissed ? 'Not a subscription' : x.active ? (x.replacedBy ? 'Replaced (price change)' : 'Confirmed') : 'Suggested', x.priceChange ? `Price changed £${x.priceChange.from} → £${x.priceChange.to}` : (x.overdue ? 'Payment overdue: cancelled?' : '')])];
  if (data.invoices.length) tabs.Invoices = [['Invoice date', 'Supplier', 'Amount', 'Type', 'Linked to', 'File', 'Drive link', 'Uploaded'], ...data.invoices.sort((a, b) => (b.invoiceDate || '').localeCompare(a.invoiceDate || '')).map((i) => [i.invoiceDate, i.vendor, i.amount, i.type, i.linkedLabel || '', i.fileName, i.driveLink || '', i.uploadedDate || ''])];
  const fyNow = presetRange('this_fy', { fyStart: s.fyStart });
  const ye = buildYearEnd(data, { from: fyNow.from, to: fyNow.to });
  const from = (r) => (r.source === 'entry' ? 'Added by hand' : String(r.id || '').startsWith('dla:') ? 'Paid personally' : 'Bank');
  tabs["Director's Loan"] = [['Date', 'Description', 'From', 'Amount', 'Balance (what the company owes you)'], [fyNow.from, 'Opening balance', '', '', ye.dla.opening], ...ye.dla.rows.map((r) => [r.date, r.description, from(r), r.amount, r.balance]), [fyNow.to, 'Balance now', '', '', ye.dla.closing]];
  const today = new Date().toISOString().slice(0, 10);

  // Expenses: costs added by hand, recurring and planned (bank lines are in Transactions)
  const ex = data.expenses || [];
  if (ex.length) {
    const kind = { manual: 'Added by hand', recurring: 'Recurring', planned: 'Planned one-off' };
    const fr = { weekly: 'Weekly', fortnightly: 'Every 2 weeks', '4weekly': 'Every 4 weeks', monthly: 'Monthly', quarterly: 'Quarterly', annual: 'Yearly' };
    tabs.Expenses = [['Type', 'Date / first payment', 'Supplier', 'Amount', 'Money in/out', 'How often', 'Per year', 'Category', 'Paid from', 'Ends', 'Status', 'Note'],
      ...ex.slice().sort((a, b) => (a.kind || '').localeCompare(b.kind || '') || String(b.date || b.start || '').localeCompare(String(a.date || a.start || ''))).map((e) => [kind[e.kind] || e.kind, e.date || e.start || '', e.vendor, e.amount, e.direction === 'in' ? 'In' : 'Out', fr[e.freq] || '', e.kind === 'recurring' ? perYear(e.amount, e.freq) : '', e.category,
        e.kind === 'manual' ? (e.paidBy === 'company' ? 'Company, not in the bank' : 'Me personally') : (e.paidFrom === 'personal' ? 'Me personally' : 'Business bank'), e.end || '', e.kind === 'recurring' ? (e.active === false ? 'Paused' : 'Active') : (e.status || ''), e.note || ''])];
    const coming = matchToBank(expectedItems(ex, { from: today, to: new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10), subscriptions: subs.confirmed }), data.txns, { today }).filter((x) => x.status !== 'paid' && x.status !== 'skipped');
    if (coming.length) tabs['Coming Up'] = [['Date', 'What', 'Amount', 'Category', 'From', 'Source'], ...coming.map((x) => [x.date, x.vendor, x.amount, x.category, x.paidFrom === 'personal' ? 'Me personally' : 'Business bank', x.source])];
  }

  // Cash flow: the next 90 days
  let ct = null;
  if (s.cfIncludeCt !== false) {
    const last = presetRange('last_fy', { fyStart: s.fyStart }); const due = ctDueDate(last.to);
    if (due >= today) { const y = buildYearEnd(data, { from: last.from, to: last.to }); if (y.ct.tax > 0) ct = { amount: y.ct.tax, due }; }
  }
  const ps = payoutSetup(data, { today, days: 100 });
  const fc = forecast(data, { today, days: 90, buffer: Number(s.cfBuffer) || 0, payout: ps.payout, extraEvents: ps.extraEvents, includeStock: s.cfIncludeStock !== false, subscriptions: subs.confirmed, ct });
  if (fc.ok) tabs['Cash Flow'] = [['Date', 'What', 'Type', 'Note', 'Amount', 'Balance'], [fc.open.date, 'Starting balance', '', fc.open.source === 'bank' ? 'latest bank line' : 'entered', '', fc.open.amount], ...fc.rows.map((r) => [r.date, r.label, r.kind, r.note, r.amount, r.balance]), [], ['', 'Lowest point', '', fc.low.date, '', fc.low.balance]];

  // Stock value: month, quarter and financial year, plus the goal
  if (data.stock.length || data.orders.length) {
    const row = (x) => [x.label, x.from, x.to, x.bought, x.sold, x.change, x.value];
    const r = stockRates(data, { today });
    const goal = Number(s.svTargetValue) || 0;
    const pl = goal && s.svTargetBy && s.svTargetBy > today ? stockPlan(r, { target: goal, by: s.svTargetBy, today }) : null;
    tabs['Stock Value'] = [['Period', 'From', 'To', 'Bought', 'Sold (at cost)', 'Change', 'Stock at the end'],
      ...stockPeriods(data, { today, by: 'month', fyStart: s.fyStart }).map(row), [],
      ...stockPeriods(data, { today, by: 'quarter', fyStart: s.fyStart }).map(row), [],
      ...stockPeriods(data, { today, by: 'year', fyStart: s.fyStart }).map(row), [],
      ['Stock at cost now', '', today, '', '', '', r.value],
      ...(pl ? [['Goal', '', s.svTargetBy, '', '', '', goal], ['Buy each month to reach it', '', '', pl.buyPerMonth, '', '', '']] : [])];
  }

  // Monthly targets: last 6 months and the next 6
  const tgMonths = [...new Set([...recentMonths(today, 6).reverse(), ...nextMonths(today, 7)])];
  if (tgMonths.some((m) => targetFor(s, m).sales !== null || targetFor(s, m).profit !== null)) {
    tabs.Targets = [['Month', 'Sales target', 'Sales', 'Sales %', 'Net profit target', 'Net profit', 'Profit %'],
      ...tgMonths.map((m) => { const mp = monthProgress(data, m, { today, overheadSource: s.overheadSource, allocate: s.allocate }); return [m, mp.sales.target ?? '', mp.isFuture ? '' : mp.sales.have, mp.sales.pct === null || mp.isFuture ? '' : Math.round(mp.sales.pct * 1000) / 10, mp.profit.target ?? '', mp.isFuture ? '' : mp.profit.have, mp.profit.pct === null || mp.isFuture ? '' : Math.round(mp.profit.pct * 1000) / 10]; })];
  }
  tabs['Year End'] = ye.sheetRows;
  const sr = stockReport(data);
  if (sr.rows.length) {
    tabs.Stock = [['SKU', 'ASIN', 'Title', 'Bought', 'Received (ledger)', 'Sold', 'Refunded', 'Customer returns', 'Removed', 'Lost/damaged', `Sellable${sr.asOf ? ` on ${sr.asOf}` : ''}`, 'Unfulfillable', 'Where', 'Avg cost', 'Value', 'Listing status', 'Price', 'Needs doing'],
      ...sr.rows.map((x) => [x.sku, x.asin, x.title, x.purchased, x.received, x.sold, x.refunded, x.customerReturns, x.removed, x.lostDamaged, x.sellable, x.unfulfillable, x.places.join('; '), x.avgCost ?? '', x.value ?? '', x.listingStatus, x.price ?? '', x.flags.map((f) => f.text).join('; ')])];
  }
  return tabs;
}

export async function syncNow({ interactive = false } = {}) {
  const data = await loadAll();
  const s = data.settings;
  if (!s.googleClientId) throw new Error('Connect Google in FBA Admin → Settings first');
  const tabs = buildTabs(data);
  try { Object.assign(tabs, await outreachTabs({ vatRegistered: !!s.vatRegistered })); } catch { /* outreach tabs are extra: never block the sync */ }
  const sheet = await ensureSpreadsheet(s.googleClientId, { spreadsheetId: s.spreadsheetId, tabs: Object.keys(tabs) });
  const written = await writeTabs(s.googleClientId, sheet.id, tabs);
  await saveSettings({ spreadsheetId: sheet.id, spreadsheetUrl: sheet.url, lastSync: Date.now() });
  return { ...sheet, written, interactive };
}

// After an import or edit: push quietly if connected and auto-sync is on. Never throws.
export async function autoSync() {
  try {
    const s = await getSettings();
    if (!s.autoSync || !s.googleClientId || !s.spreadsheetId) return null;
    return await syncNow();
  } catch (e) { return { error: e.message }; }
}

// Category changes typed into the sheet's Transactions tab become hand fixes here.
export async function pullCategories() {
  const s = await getSettings();
  if (!s.spreadsheetId) throw new Error('No spreadsheet yet — sync once first');
  const rows = await readTab(s.googleClientId, s.spreadsheetId, 'Transactions');
  const local = new Map((await store.getAll('faTransactions')).map((t) => [t.id, t]));
  const changes = [];
  const unknown = new Set();
  for (const r of rows) {
    const t = local.get(String(r.Id));
    const cat = String(r.Category || '').trim();
    if (!t || !cat || cat === t.category) continue;
    if (!ALL_CATEGORIES.includes(cat)) { unknown.add(cat); continue; }
    changes.push({ ...t, category: cat, categorySource: 'manual', updatedAt: new Date().toISOString() });
  }
  if (changes.length) await store.putMany('faTransactions', changes);
  return { changed: changes.length, unknown: [...unknown] };
}

// ---------------------------------------------------------------------------
// Invoices to Google Drive (when storage is "both" or "drive")
// ---------------------------------------------------------------------------
import { ensureFolderPath, listNames, uploadFile } from './google.js';
import { drivePath, uniqueName } from './invoices.js';

export async function dataUrlToBlob(dataUrl) {
  return (await fetch(dataUrl)).blob();
}

export async function uploadInvoice(inv) {
  const s = await getSettings();
  if (!s.googleClientId) throw new Error('Connect Google in FBA Admin → Settings to upload to Drive');
  const { id: folderId, cache } = await ensureFolderPath(s.googleClientId, drivePath(inv.invoiceDate), s.driveFolders || {});
  await saveSettings({ driveFolders: cache });
  const name = uniqueName(inv.fileName, await listNames(s.googleClientId, folderId));
  const f = await uploadFile(s.googleClientId, { blob: await dataUrlToBlob(inv.dataUrl), name, parentId: folderId, mime: inv.mime });
  const next = { ...inv, driveId: f.id, driveLink: f.webViewLink, driveName: f.name, uploadedDate: new Date().toISOString().slice(0, 10), status: 'uploaded', updatedAt: new Date().toISOString() };
  // "Drive only" keeps the link but drops the local copy once it's safely uploaded
  if (s.invoiceStorage === 'drive') next.dataUrl = '';
  await store.put('faInvoices', next);
  return next;
}

export async function uploadPendingInvoices() {
  const pending = (await store.getAll('faInvoices')).filter((i) => i.status !== 'uploaded' && i.dataUrl);
  let done = 0; const errors = [];
  for (const inv of pending) { try { await uploadInvoice(inv); done++; } catch (e) { errors.push(e.message); break; } }
  return { done, left: pending.length - done, errors };
}
