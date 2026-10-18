// FBA Admin — the year-end pack for your accountant. Pure.
import { compute, stockAtCost } from './pnl.js';
import { stockReport } from './stock.js';
import { reconcilePayouts } from './settlement.js';
import { detectSubscriptions, mergeSubscriptions } from './subscriptions.js';
import { dlaStatement, corporationTax } from './yearend.js';
import { missingReceipts } from './invoices.js';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const gbp = (n) => `£${r2(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dayBefore = (d) => new Date(Date.parse(`${d}T00:00:00Z`) - 864e5).toISOString().slice(0, 10);

// Director's loan at a date, from the opening balance you entered (signed: + company owes you).
export function dlaOpeningAt(data, from) {
  const s = data.settings;
  const base = (Number(s.dlaOpening) || 0) * (s.dlaDirection === 'director_owes_company' ? -1 : 1);
  const since = s.dlaOpeningDate || from;
  if (from < since) return { known: false, opening: 0 };
  if (from === since) return { known: true, opening: r2(base) };
  const moves = (data.dlaTxns || data.txns).filter((t) => t.category === 'Director Loan' && t.date >= since && t.date <= dayBefore(from)).reduce((a, t) => a + t.amount, 0);
  return { known: true, opening: r2(base + moves) };
}

export function buildYearEnd(data, { from, to }) {
  const s = data.settings;
  const p = compute(data, { from, to, overheadSource: s.overheadSource, allocate: s.allocate });
  const op = dlaOpeningAt(data, from);
  const dla = dlaStatement(data.dlaTxns || data.txns, { opening: op.opening, from, to });
  dla.known = op.known;

  // stock at the year end: the ledger's last day on or before the year end, else the purchases − sales estimate
  const ledgerIn = data.ledger.filter((l) => l.date <= to);
  const sr = ledgerIn.length ? stockReport({ ...data, ledger: ledgerIn, orders: data.orders.filter((o) => o.date <= to) }) : null;
  const stock = sr?.asOf ? { value: sr.totals.value, units: sr.totals.sellable, unfulfillable: sr.totals.unfulfillable, unfulfillableValue: sr.totals.unfulfillableValue, asOf: sr.asOf, method: 'Inventory ledger' }
    : { ...stockAtCost(data.stock.filter((x) => !x.datePurchased || x.datePurchased <= to), data.orders.filter((o) => o.date <= to)), asOf: to, method: 'Estimate: bought − sold' };

  const ct = corporationTax(p.combinedNet, { associated: s.associatedCompanies });
  const receipts = missingReceipts(data.txns, data.invoices, { from, to });
  const subs = mergeSubscriptions(detectSubscriptions(data.txns), data.subsSaved);
  const payouts = reconcilePayouts(data.settlements.filter((x) => x.depositDate >= from && x.depositDate <= to), data.txns);
  const uncategorised = data.txns.filter((t) => t.date >= from && t.date <= to && t.category === 'Uncategorized').length;

  const checks = [
    uncategorised ? `${uncategorised} bank transaction${uncategorised === 1 ? '' : 's'} still uncategorised` : '',
    p.noCogsUnits ? `${p.noCogsUnits} units sold with no COGS: profit is overstated` : '',
    receipts.rows.length ? `${receipts.rows.length} costs (${gbp(receipts.total)}) have no invoice or receipt attached` : '',
    payouts.unmatched.length ? `${payouts.unmatched.length} Amazon payout${payouts.unmatched.length === 1 ? '' : 's'} not found in the bank` : '',
    !data.fees.length ? 'No Amazon settlement reports imported: storage, subscription and other account fees are missing' : '',
    !op.known ? "Director's loan opening balance unknown for this period: enter it in Settings" : '',
    dla.overdrawn ? "Director's loan is overdrawn (you owe the company). Unless repaid within 9 months and 1 day of the year end this can trigger s455 tax: talk to your accountant" : '',
    stock.unfulfillable ? `${stock.unfulfillable} unfulfillable units at Amazon (${gbp(stock.unfulfillableValue)} at cost): remove, resell or write off` : '',
  ].filter(Boolean);

  const rows = [['Section', 'Item', 'Amount (£)', 'Note'],
    ['Period', `${from} to ${to}`, '', ''],
    ['Amazon', 'Revenue (SellerToolkit)', p.revenue, `${p.units} units sold`],
    ['Amazon', 'Amazon fees', -p.fees, ''], ['Amazon', 'VAT on Amazon fees', -p.vatOnFees, 'not reclaimable (not VAT registered)'],
    ['Amazon', 'COGS', -p.cogs, ''], ['Amazon', 'SellerToolkit profit', p.stkProfit, 'after fees, COGS, VAT on fees, refunds'],
    ...Object.entries(p.accountFeesByType).map(([k, v]) => ['Amazon account fees', k, -v, 'from settlement reports']),
    ...Object.entries(p.reimbursementsByType).map(([k, v]) => ['Amazon income', k, v, 'from settlement reports']),
    ['Amazon', 'Returns loss (Returns tracker)', p.returnsLoss, 'settled returned units'],
    ...Object.entries(p.overheadsByCat).map(([k, v]) => ['Overheads', k, -v, p.overheadsFrom]),
    ['Result', 'Net profit: Amazon only', p.netProfit, p.margin === null ? '' : `${r2(p.margin * 100)}% margin`],
    ['eBay', 'eBay sales', p.ebay.revenue, `${p.ebay.units} units`], ['eBay', 'eBay profit after COGS', p.ebay.profit, p.ebay.missingCogs ? `${p.ebay.missingCogs} sales with no COGS` : ''],
    ['Result', 'Net profit: Amazon + eBay', p.combinedNet, ''],
    ['Tax', 'Corporation tax estimate', ct.tax, `${ct.band}; on the combined profit; estimate only`],
    ['Tax', 'Profit after tax (estimate)', r2(p.combinedNet - ct.tax), ''],
    ['Balance sheet', `Stock at cost (${stock.asOf || to})`, stock.value, stock.method],
    ["Balance sheet", "Director's loan at year end", dla.closing, dla.closing >= 0 ? 'company owes you' : 'you owe the company'],
    ['Info', 'Subscriptions per year (confirmed)', subs.annual, ''],
    ...checks.map((c) => ['To check', c, '', '']),
  ];
  return { from, to, p, dla, stock, ct, receipts, subs, payouts, checks, uncategorised, sheetRows: rows };
}
