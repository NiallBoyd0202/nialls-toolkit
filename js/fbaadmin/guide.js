// FBA Admin — Reports guide: what to download, where from, what date range, and what's due. Pure.

const DAY = 864e5;
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const addDays = (d, n) => iso(Date.parse(`${d}T00:00:00Z`) + n * DAY);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const maxDate = (arr, f) => arr.reduce((m, x) => { const d = f(x); return d && d > m ? d : m; }, '');

// how: 'monthly' (due every month) | 'when' (only when something happened, see trigger) | 'optional'
export const REPORTS = [
  {
    id: 'bank', label: 'Bank statement (CSV)', how: 'monthly', feeds: 'Transactions, cash, overheads',
    where: ['Revolut Business app or website', 'Accounts → your GBP account → Statement', 'Format: CSV (not PDF)'],
    settings: 'Choose the date range below, then download as CSV.',
    imports: ['bank', 'revolut'],
  },
  {
    id: 'stk_orders', label: 'SellerToolkit · Orders – Detailed', how: 'monthly', feeds: 'Revenue, fees, COGS, refunds, Sold products',
    where: ['SellerToolkit', 'Reports → Orders – Detailed', 'Marketplace UK'],
    settings: 'Date range below → Export (TXT/CSV).',
    imports: ['stk_orders'],
  },
  {
    id: 'stk_expenses', label: 'SellerToolkit · Expenses', how: 'monthly', feeds: 'Overheads for months without bank lines',
    where: ['SellerToolkit', 'Expenses', 'Export'],
    settings: 'Any range that includes the dates below.',
    imports: ['stk_expenses'],
  },
  {
    id: 'amazon_ledger', label: 'Amazon · Inventory Ledger', how: 'monthly', feeds: 'Stock tab: received, at Amazon now, removals, lost',
    where: ['Seller Central', 'Reports → Fulfilment → Inventory → Inventory Ledger', 'Summary view · Daily · show by Location'],
    settings: 'Date range below → Generate report → Download CSV.',
    imports: ['amazon_ledger'],
  },
  {
    id: 'amazon_settlement', label: 'Amazon · Settlement report (Flat File V2)', how: 'monthly', feeds: 'Payouts & fees: storage, subscription, removals, reimbursements; payout check',
    where: ['Seller Central', 'Reports → Payments → All Statements', 'Each statement in the dates below → Download Flat File V2'],
    settings: 'One file per payout (every 14 days). Or, for the whole month in one file: Reports → Payments → Reports Repository → Date Range Reports → Transaction → the dates below → Download CSV.',
    imports: ['amazon_settlement', 'amazon_date_range'],
  },
  {
    id: 'amazon_returns', label: 'Amazon · FBA customer returns', how: 'monthly', feeds: 'Returns tracker (creates one unit per returned item)',
    where: ['Seller Central', 'Reports → Fulfilment → Customer Concessions → FBA customer returns'],
    settings: 'Date range below → Generate → Download CSV. Overlapping a previous download is safe.',
    imports: ['amazon_returns'], returns: true,
  },
  {
    id: 'stk_cogs', label: 'SellerToolkit · Cost of Goods V4 Detailed', how: 'when', feeds: 'Stock purchases, COGS, Returns tracker costs',
    where: ['SellerToolkit', 'Cost of Goods → Export → V4 Detailed – Full List'],
    settings: 'Full list (no date range needed).',
    imports: ['stk_cogs'], whenText: 'After you buy stock or change a cost in SellerToolkit',
  },
  {
    id: 'amazon_removal_order', label: 'Amazon · Removal Order Detail', how: 'when', feeds: 'Returns tracker: removal requested, removal fees',
    where: ['Seller Central', 'Reports → Fulfilment → Removals → Removal Order Detail'],
    settings: 'Date range below → Download CSV.',
    imports: ['amazon_removal_order'], returns: true, whenText: 'When you\'ve asked Amazon to send back or dispose of stock',
  },
  {
    id: 'amazon_removal_shipment', label: 'Amazon · Removal Shipment Detail', how: 'when', feeds: 'Returns tracker: in transit to you / prep, tracking',
    where: ['Seller Central', 'Reports → Fulfilment → Removals → Removal Shipment Detail'],
    settings: 'Date range below → Download CSV.',
    imports: ['amazon_removal_shipment'], returns: true, whenText: 'After removals have shipped',
  },
  {
    id: 'amazon_reimbursements', label: 'Amazon · Reimbursements', how: 'when', feeds: 'Returns tracker: credits for lost or damaged returns',
    where: ['Seller Central', 'Reports → Fulfilment → Payments → Reimbursements'],
    settings: 'Date range below → Download CSV.',
    imports: ['amazon_reimbursements'], returns: true, whenText: 'When Amazon lost or damaged units, or after a claim',
  },
  {
    id: 'amazon_listings', label: 'Amazon · All Listings Report', how: 'optional', feeds: 'Stock tab: listing status and price',
    where: ['Seller Central', 'Inventory → Inventory Reports', 'Report type: All Listings Report → Request report'],
    settings: 'No date range. Wait for it to generate, then Download.',
    imports: ['amazon_listings'],
  },
  {
    id: 'amazon_inventory_health', label: 'Amazon · FBA Inventory (inventory age)', how: 'optional', feeds: "Stock tab: aged stock, Amazon's own surcharge estimate",
    where: ['Seller Central', 'Inventory → FBA Inventory', 'Download (top right of the table) → CSV'],
    settings: 'No date range: it\'s a snapshot of today. Re-download monthly so the ages stay current.',
    imports: ['amazon_inventory_health'],
  },
  {
    id: 'amazon_sales_dashboard', label: 'Amazon · Sales Dashboard', how: 'optional', feeds: 'Cross-check: Amazon ordered sales vs SellerToolkit',
    where: ['Seller Central', 'Reports → Business Reports → Sales Dashboard', 'Date: Year to date'],
    settings: 'Click Download.',
    imports: ['amazon_sales_dashboard'],
  },
];

// With SellerFuse as the sales source (FBA Admin → Settings), its exports replace SellerToolkit's in the guide.
// Menu names are a first guess until they're checked against your first SellerFuse exports.
const SELLERFUSE = {
  stk_orders: {
    id: 'sf_orders', label: 'SellerFuse · Orders (Amazon and eBay)', how: 'monthly', feeds: 'Revenue, fees, COGS, refunds, Sold products, eBay sales',
    where: ['SellerFuse', 'Orders (or Sales) → Export', 'All marketplaces, including eBay'],
    settings: 'Date range below → Export as CSV.', imports: ['sf_orders'],
  },
  stk_expenses: {
    id: 'sf_expenses', label: 'SellerFuse · Expenses', how: 'monthly', feeds: 'Overheads for months without bank lines',
    where: ['SellerFuse', 'Expenses → Export'], settings: 'Any range that includes the dates below.', imports: ['sf_expenses'],
  },
  stk_cogs: {
    id: 'sf_cogs', label: 'SellerFuse · Cost of goods', how: 'when', feeds: 'Stock purchases, COGS, Returns tracker costs',
    where: ['SellerFuse', 'Cost of goods (or Purchases / Inventory) → Export'], settings: 'Full list (no date range needed).',
    imports: ['sf_cogs'], whenText: 'After you buy stock or change a cost in SellerFuse',
  },
};
export const reportsFor = (settings = {}) => (settings.salesSource === 'sellerfuse' ? REPORTS.map((r) => SELLERFUSE[r.id] || r) : REPORTS);

// data = loadAll() result plus rtImports and checklist; today = 'YYYY-MM-DD'
export function guideStatus(data, { today = iso(Date.now()), fyFrom = '' } = {}) {
  const month = today.slice(0, 7);
  const lastImport = (ids, inReturns) => {
    const logs = inReturns ? (data.rtImports || []).filter((l) => ids.includes(l.formatId)) : (data.imports || []).filter((l) => ids.includes(l.reportType));
    // the SellerToolkit cost file can come in through either feature
    const extra = ids.includes('stk_cogs') ? (data.rtImports || []).filter((l) => l.formatId === 'stk_cogs') : [];
    return maxDate([...logs, ...extra], (l) => String(l.at || '').slice(0, 10));
  };
  const ledgerTo = maxDate(data.ledger || [], (l) => l.date);
  const allOrders = data.ordersAll || data.orders || []; const allExp = data.stkExpensesAll || data.stkExpenses || [];
  const sf = (x) => x.source === 'sellerfuse';
  const coverage = {
    bank: maxDate(data.txns || [], (t) => t.date),
    stk_orders: maxDate(allOrders.filter((o) => !sf(o)), (o) => o.date),
    stk_expenses: maxDate(allExp.filter((e) => !sf(e)), (e) => e.date),
    sf_orders: maxDate(allOrders.filter(sf), (o) => o.date),
    sf_expenses: maxDate(allExp.filter(sf), (e) => e.date),
    amazon_ledger: ledgerTo,
    amazon_settlement: maxDate([...(data.fees || []), ...(data.settlements || []).map((x) => ({ date: x.end || x.depositDate }))], (l) => l.date),
    // returns: no new returns doesn't mean stale data, so only the import date counts
  };
  const start = fyFrom || `${today.slice(0, 4)}-01-01`;
  const sinceLedger = (field) => (data.ledger || []).filter((l) => l[field]).map((l) => l.date);
  const manual = data.checklist?.months?.[month] || {};

  const hasBank = (data.txns || []).length > 0;
  return reportsFor(data.settings).map((r0) => {
    // With bank statements imported, the expenses export is only a fallback for months the bank doesn't cover.
    const r = (r0.id === 'stk_expenses' || r0.id === 'sf_expenses') && hasBank ? { ...r0, how: 'when', whenText: "Only for months your bank statements don't cover" } : r0;
    const imported = lastImport(r.imports, r.returns);
    const covered = coverage[r.id] || '';
    const importedThisMonth = imported.slice(0, 7) === month;
    let status = 'ok'; let why = '';
    if (r.how === 'monthly') {
      if (!imported) { status = 'overdue'; why = 'Never imported'; }
      else if (covered && daysBetween(covered, today) > 35) { status = 'overdue'; why = `Data stops at ${covered}`; }
      else if (daysBetween(imported, today) > 40) { status = 'overdue'; why = `Last imported ${imported}`; }
      else if (!importedThisMonth) { status = 'due'; why = 'Not imported this month yet'; }
    } else if (r.how === 'when') {
      // only due when something in your other data says so
      if (r.id === 'stk_cogs' || r.id === 'sf_cogs') {
        const lastBuy = maxDate((data.txns || []).filter((t) => t.category === 'Stock Purchase' && t.amount < 0), (t) => t.date);
        if (!imported) { status = 'overdue'; why = 'Never imported'; }
        else if (lastBuy && lastBuy > imported) { status = 'due'; why = `Stock bought on ${lastBuy}, after your last import`; }
      } else if (r.id === 'amazon_removal_order' || r.id === 'amazon_removal_shipment') {
        const removals = sinceLedger('vendorReturns').filter((d) => !imported || d > imported);
        if (removals.length) { status = 'due'; why = `Inventory ledger shows units removed${imported ? ' since your last import' : ''}`; }
      } else if (r.id === 'amazon_reimbursements') {
        const lost = (data.ledger || []).filter((l) => (l.lost || l.damaged) && (!imported || l.date > imported));
        if (lost.length) { status = 'due'; why = 'Inventory ledger shows units lost or damaged by Amazon'; }
      }
      if (status === 'ok') why = imported ? '' : 'Nothing needs it yet';
    } else if (!imported) { status = 'optional'; why = 'Optional'; }
    else if (r.id === 'amazon_listings' && daysBetween(imported, today) > 30) { status = 'optional'; why = 'Over a month old: worth refreshing'; }

    // date range to download: from just before what you have (overlap is safe), to today
    let from = start;
    if (covered) from = addDays(covered, -7);
    else if (imported) from = addDays(imported, -35);
    if (from < start) from = start;
    const range = ['stk_cogs', 'sf_cogs', 'amazon_listings', 'amazon_sales_dashboard', 'amazon_inventory_health'].includes(r.id) ? null : { from, to: today };

    // Returns: the inventory ledger counts every customer return, so a tracker with fewer units is missing some.
    let gap = false;
    if (r.id === 'amazon_returns' && (data.ledger || []).length) {
      const ledgerFrom = (data.ledger || []).reduce((m, l) => (!m || l.date < m ? l.date : m), '');
      const ledgerReturns = (data.ledger || []).reduce((n, l) => n + Math.max(0, l.customerReturns || 0), 0);
      const tracked = (data.units || []).filter((u) => u.returnDate >= ledgerFrom).length;
      if (ledgerReturns > tracked) {
        gap = true; status = 'due';
        why = `Inventory ledger shows ${ledgerReturns} returns since ${ledgerFrom}, the Returns tracker has ${tracked}. Download from ${ledgerFrom}`;
        range.from = ledgerFrom;
      }
    }
    const ticked = importedThisMonth || !!manual[r.id];
    // A manual tick means "done / nothing to download this month" and clears the reminder.
    if (manual[r.id] && status !== 'optional') { status = 'ok'; why = 'Ticked off for this month'; }
    else if (importedThisMonth && status === 'due' && !gap) { status = 'ok'; why = ''; }
    return { ...r, imported, covered, importedThisMonth, status, why, range, ticked: ticked && !gap, manualTick: !!manual[r.id] };
  });
}

export const overdueCount = (rows) => rows.filter((r) => r.status === 'overdue' || r.status === 'due').length;
