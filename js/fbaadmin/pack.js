// FBA Admin — the accountant pack: one zip for a quarter or a year. Pure apart from makeZip (also pure).
import { buildYearEnd } from './yearpack.js';
import { stockReport } from './stock.js';
import { reconcilePayouts } from './settlement.js';
import { nonBankCosts } from './expenses.js';
import { makeZip, dataUrlBytes } from '../zip.js';
import { toCSV, esc } from '../util.js';

const BOM = '﻿'; // so Excel shows £ correctly
const csv = (rows) => BOM + toCSV(rows);
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const gbp = (n) => `${n < 0 ? '−' : ''}£${Math.abs(Number(n) || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const nice = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const days = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5) + 1;

export function packFiles(data, { from, to, today = new Date().toISOString().slice(0, 10) }) {
  const s = data.settings;
  const y = buildYearEnd(data, { from, to });
  const p = y.p;
  const fullYear = days(from, to) >= 360;
  const inR = (d) => d && d >= from && d <= to;
  const invByTxn = new Map((data.invoices || []).filter((i) => i.linkedTo?.kind === 'txn').map((i) => [i.linkedTo.id, i]));
  const files = [];
  const add = (name, content) => files.push({ name, data: content });

  // invoices in month folders; Drive-only ones are listed with their link
  const invs = (data.invoices || []).filter((i) => inR(i.invoiceDate)).sort((a, b) => a.invoiceDate.localeCompare(b.invoiceDate));
  const invPath = (i) => `Invoices/${i.invoiceDate.slice(0, 7)}/${i.fileName}`;
  for (const i of invs) if (i.dataUrl) add(invPath(i), dataUrlBytes(i.dataUrl));

  const txns = data.txns.filter((t) => inR(t.date)).sort((a, b) => a.date.localeCompare(b.date));
  const nb = nonBankCosts(data.expenses || [], { today }).filter((c) => inR(c.date));
  const rec = reconcilePayouts((data.settlements || []).filter((x) => inR(x.depositDate)), data.txns);
  const fees = (data.fees || []).filter((l) => inR(l.date) && (l.group === 'fee' || l.group === 'income'));
  const sr = stockReport(data);
  const ebay = (data.ebaySales || []).filter((l) => l.date && inR(new Date(l.date).toISOString().slice(0, 10)));

  add('01 Summary (open in a browser, then print or save as PDF).html', summaryHtml({ y, s, from, to, fullYear, today, counts: { txns: txns.length, invoices: invs.length, nb: nb.length } }));
  add('02 Profit and loss.csv', csv(fullYear ? y.sheetRows : y.sheetRows.filter((r) => r[0] !== 'Tax')));
  add('03 Bank transactions.csv', csv([['Date', 'Description', 'Reference', 'Money in', 'Money out', 'Balance', 'Category', 'Receipt'], ...txns.map((t) => [t.date, t.description, t.reference || '', t.amount > 0 ? t.amount : '', t.amount < 0 ? -t.amount : '', t.balance ?? '', t.category, invByTxn.get(t.id) ? (invByTxn.get(t.id).dataUrl ? invPath(invByTxn.get(t.id)) : invByTxn.get(t.id).driveLink || invByTxn.get(t.id).fileName) : ''])]));
  if (nb.length) add('04 Costs not in the bank.csv', csv([['Date', 'Supplier', 'Amount', 'Category', 'Paid by', 'Note'], ...nb.map((c) => [c.date, c.vendor, c.amount, c.category, c.paidBy === 'personal' ? 'Director, personally (director\'s loan)' : 'Company, not in the bank statement', c.note])]));
  add("05 Director's loan.csv", csv([['Date', 'Description', 'Amount', 'Balance'], [from, 'Opening balance', '', y.dla.opening], ...y.dla.rows.map((r) => [r.date, r.description, r.amount, r.balance]), [to, 'Closing balance', '', y.dla.closing]]));
  add('06 Sold products.csv', csv([['SKU', 'ASIN', 'Title', 'Units', 'Refunded', 'Revenue', 'Amazon fees', 'VAT on fees', 'COGS', 'SellerToolkit profit', 'Returns loss', 'Overhead share', 'Actual net'], ...p.products.map((x) => [x.sku, x.asin, x.title, x.units, x.refunded, x.revenue, x.fees, x.vat, x.cogs, x.stkProfit, x.returnsAdj, x.overhead, x.actualNet])]));
  if (rec.rows.length) add('07 Amazon payouts.csv', csv([['Deposit date', 'Settlement ID', 'Period start', 'Period end', 'Amount', 'In the bank on'], ...rec.rows.map((x) => [x.depositDate, x.settlementId, x.start, x.end, x.total, x.bankDate || 'NOT FOUND'])]));
  if (fees.length) add('08 Amazon account fees and reimbursements.csv', csv([['Date', 'Type', 'Description', 'SKU', 'Order ID', 'Amount'], ...fees.map((l) => [l.date, l.feeType, l.description, l.sku, l.orderId, l.amount])]));
  add('09 Stock.csv', csv([['SKU', 'ASIN', 'Title', 'Sellable at Amazon', 'Unfulfillable', 'Average cost', 'Value at cost'], ...sr.rows.filter((x) => x.sellable || x.unfulfillable).map((x) => [x.sku, x.asin, x.title, x.sellable, x.unfulfillable, x.avgCost ?? '', x.value ?? '']), [], [`Stock at cost on ${y.stock.asOf || to}`, '', '', '', '', '', y.stock.value], ['Method', y.stock.method]]));
  if (y.subs.confirmed.length) add('10 Subscriptions.csv', csv([['Supplier', 'Amount', 'Frequency', 'Per year', 'Last paid', 'Category'], ...y.subs.confirmed.map((x) => [x.name, x.amount, x.frequency, x.annual, x.lastSeen, x.category])]));
  add('11 Invoices index.csv', csv([['Invoice date', 'Supplier', 'Amount', 'Type', 'Linked to', 'File in this zip', 'Google Drive link'], ...invs.map((i) => [i.invoiceDate, i.vendor, i.amount, i.type, i.linkedLabel || '', i.dataUrl ? invPath(i) : '', i.driveLink || ''])]));
  if (y.receipts.rows.length) add('12 Costs with no receipt.csv', csv([['Date', 'Description', 'Amount', 'Category'], ...y.receipts.rows.map((t) => [t.date, t.description, -t.amount, t.category])]));
  if (ebay.length) add('13 eBay sales.csv', csv([['Date', 'Type', 'Order', 'Item', 'Qty', 'Gross', 'Fees', 'Net'], ...ebay.map((l) => [new Date(l.date).toISOString().slice(0, 10), l.kind, l.orderNumber || l.orderKey || '', l.title || '', l.qty || '', l.gross ?? '', l.fees ?? '', l.net ?? ''])]));
  add('00 Read me.txt', readme({ s, from, to, today, files, y, invs, fullYear }));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { files, y };
}

export function buildPack(data, opts) {
  const { files, y } = packFiles(data, opts);
  return { bytes: makeZip(files), count: files.length, y };
}

function readme({ s, from, to, today, files, y, invs, fullYear }) {
  return [
    `${s.companyName || 'Company'}: accounts pack`,
    `Period: ${nice(from)} to ${nice(to)}`,
    `Prepared ${nice(today)} with Niall's Toolkit (FBA Admin) from bank statements, SellerToolkit, Amazon reports and the eBay tracker.`,
    '',
    'What is in here',
    ...files.filter((f) => !f.name.startsWith('Invoices/')).map((f) => `  ${f.name}`),
    `  Invoices/ (${invs.filter((i) => i.dataUrl).length} files, by month)`,
    '',
    'Notes',
    '  * Amazon sales, fees and cost of goods come from SellerToolkit (Orders - Detailed).',
    '  * Amazon account fees (storage, subscription, removals, inbound placement, advertising billed to the Amazon balance) and reimbursements come from Amazon settlement reports.',
    '  * Overheads come from the bank statement, plus costs paid personally or outside the bank (04).',
    "  * The director's loan is the opening balance entered by the director plus every bank line categorised Director Loan and costs paid personally. Positive = the company owes the director.",
    `  * Stock at cost: ${y.stock.method}.`,
    fullYear ? '  * The corporation tax figure is an estimate at 2026/27 rates before any adjustments.' : '  * This is not a full year, so no corporation tax estimate is included.',
    ...(y.checks.length ? ['', 'Still to check', ...y.checks.map((c) => `  * ${c}`)] : []),
    '',
    'These are management figures, not statutory accounts.',
  ].join('\r\n');
}

function summaryHtml({ y, s, from, to, fullYear, today, counts }) {
  const p = y.p;
  const row = (l, v, cls = '') => `<tr class="${cls}"><td>${l}</td><td class="r">${gbp(v)}</td></tr>`;
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>${esc(s.companyName || 'Accounts')} ${from} to ${to}</title>
<style>body{font:13px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;max-width:860px;margin:24px auto;padding:0 16px}h1{font-size:20px;margin:0}h2{font-size:14px;margin:22px 0 6px;border-bottom:2px solid #222;padding-bottom:3px}
table{width:100%;border-collapse:collapse}td{padding:4px 6px;border-bottom:1px solid #e3e3e3}td.r{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}tr.t td{font-weight:700;border-top:2px solid #222}
.muted{color:#666}.warn{background:#fff6e0;border:1px solid #f0c36d;padding:8px 12px;border-radius:6px}@media print{body{margin:0}}</style></head><body>
<h1>${esc(s.companyName || 'Accounts pack')}</h1><p class="muted">${nice(from)} to ${nice(to)} · prepared ${nice(today)} · ${counts.txns} bank lines, ${counts.nb} costs outside the bank, ${counts.invoices} invoices</p>
${y.checks.length ? `<div class="warn"><b>Still to check</b><ul>${y.checks.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>` : ''}
<h2>Profit and loss: Amazon</h2><table>
${row(`Sales (${p.units} units)`, p.revenue)}${row('Amazon selling and FBA fees', -p.fees)}${row('VAT on Amazon fees', -p.vatOnFees)}${row('Cost of goods sold', -p.cogs)}${row('Gross profit', p.stkProfit, 't')}
${Object.entries(p.accountFeesByType).map(([k, v]) => row(`Amazon ${esc(k.toLowerCase())}`, -v)).join('')}${Object.entries(p.reimbursementsByType).map(([k, v]) => row(esc(k), v)).join('')}
${row('Returns loss', p.returnsLoss)}${Object.entries(p.overheadsByCat).map(([k, v]) => row(esc(k), -v)).join('')}${row('Net profit: Amazon', p.netProfit, 't')}</table>
<h2>Amazon + eBay</h2><table>${row('Net profit: Amazon', p.netProfit)}${row(`eBay sales (${p.ebay.units} units)`, p.ebay.revenue)}${row('eBay profit after fees and COGS', p.ebay.profit)}${row('Net profit before tax', p.combinedNet, 't')}
${fullYear ? `${row(`Corporation tax estimate (${esc(y.ct.band)})`, -y.ct.tax)}${row('Profit after tax (estimate)', r2(p.combinedNet - y.ct.tax), 't')}` : ''}</table>
<h2>Balance sheet items</h2><table>${row(`Stock at cost (${esc(y.stock.method)}, ${nice(y.stock.asOf || to)})`, y.stock.value)}${row(`Director's loan at ${nice(to)} (${y.dla.closing >= 0 ? 'owed to the director' : 'owed by the director'})`, y.dla.closing)}</table>
<h2>Director's loan account</h2><table>${row(`${nice(from)} opening balance`, y.dla.opening)}${y.dla.rows.map((r) => `<tr><td>${nice(r.date)} · ${esc(r.description)}</td><td class="r">${gbp(r.amount)} → ${gbp(r.balance)}</td></tr>`).join('')}${row(`${nice(to)} closing balance`, y.dla.closing, 't')}</table>
<p class="muted" style="margin-top:24px">Management figures from Niall's Toolkit, not statutory accounts.</p></body></html>`;
}
