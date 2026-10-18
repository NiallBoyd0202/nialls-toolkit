// FBA Admin — P&L, cash and dashboard figures. Pure functions over already-loaded arrays.
//
// Sources:
//   sales, fees, COGS, refunds   → SellerToolkit "Orders – Detailed" (its Profit_Loss already = sale − fees − COGS − VAT on fees)
//   overheads                    → bank transactions in operating-expense categories (or SellerToolkit expenses, by setting)
//   returns loss                 → Returns tracker: settled units' net vs cost (cost basis lost, return costs, minus any recovery)
//   cash                         → bank transactions

import { EXCLUDED_FROM_PNL } from './categories.js';
import { pnl as unitPnl, STATUS } from '../returns/model.js';
import { accountLines } from './settlement.js';
import { ebayPnl } from './yearend.js';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const sum = (arr, f) => arr.reduce((a, x) => a + (Number(f(x)) || 0), 0);
const inRange = (d, from, to) => !!d && d >= from && d <= to;
const iso = (dt) => dt.toISOString().slice(0, 10);

// ---- date presets (UTC dates, YYYY-MM-DD) ----
export function presetRange(preset, { today = iso(new Date()), fyStart = '04-06', from, to } = {}) {
  const [y, m] = today.split('-').map(Number);
  const first = (yy, mm) => iso(new Date(Date.UTC(yy, mm - 1, 1)));
  const last = (yy, mm) => iso(new Date(Date.UTC(yy, mm, 0)));
  const label = (a, b) => `${fmt(a)} – ${fmt(b)}`;
  switch (preset) {
    case 'this_month': return { from: first(y, m), to: last(y, m), label: new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }) };
    case 'last_month': { const d = new Date(Date.UTC(y, m - 2, 1)); return { from: iso(d), to: last(d.getUTCFullYear(), d.getUTCMonth() + 1), label: d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }) }; }
    case 'last_3_months': { const d = new Date(Date.UTC(y, m - 3, 1)); return { from: iso(d), to: last(y, m), label: label(iso(d), last(y, m)) }; }
    case 'ytd': return { from: `${y}-01-01`, to: today, label: `Year to date ${y}` };
    case 'this_fy': case 'last_fy': {
      const [fm, fd] = fyStart.split('-').map(Number);
      let startY = today >= `${y}-${String(fm).padStart(2, '0')}-${String(fd).padStart(2, '0')}` ? y : y - 1;
      if (preset === 'last_fy') startY -= 1;
      const s = iso(new Date(Date.UTC(startY, fm - 1, fd)));
      const e = iso(new Date(Date.UTC(startY + 1, fm - 1, fd - 1)));
      return { from: s, to: preset === 'this_fy' && e > today ? today : e, label: `FY ${fmt(s)} – ${fmt(e)}` };
    }
    case 'all': return { from: '2000-01-01', to: '2100-01-01', label: 'All time' };
    default: return { from: from || first(y, m), to: to || today, label: label(from || first(y, m), to || today) };
  }
}
const fmt = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

// The same-length period immediately before, for "vs previous" deltas.
export function previousRange({ from, to }) {
  const a = Date.parse(`${from}T00:00:00Z`), b = Date.parse(`${to}T00:00:00Z`);
  const len = b - a + 864e5;
  return { from: iso(new Date(a - len)), to: iso(new Date(a - 864e5)) };
}

// ---- cash ----
export function cash(txns, from, to) {
  const t = txns.filter((x) => inRange(x.date, from, to));
  const moneyIn = sum(t.filter((x) => x.amount > 0), (x) => x.amount);
  const moneyOut = sum(t.filter((x) => x.amount < 0), (x) => -x.amount);
  const outByCat = {}; const inByCat = {};
  for (const x of t) {
    const bucket = x.amount < 0 ? outByCat : inByCat;
    bucket[x.category] = (bucket[x.category] || 0) + Math.abs(x.amount);
  }
  return {
    count: t.length, moneyIn: r2(moneyIn), moneyOut: r2(moneyOut), net: r2(moneyIn - moneyOut),
    amazonPayouts: r2(inByCat['Amazon Payout'] || 0), ebayPayouts: r2(inByCat['eBay Payout'] || 0),
    outByCat: Object.fromEntries(Object.entries(outByCat).map(([k, v]) => [k, r2(v)]).sort((a, b) => b[1] - a[1])),
    inByCat: Object.fromEntries(Object.entries(inByCat).map(([k, v]) => [k, r2(v)]).sort((a, b) => b[1] - a[1])),
  };
}

// ---- overheads ----
// SellerToolkit's expense categories, mapped onto the bank categories so both sources add up under one name.
const STK_CATEGORY = {
  subscriptions: 'Subscription', subscription: 'Subscription', 'bank charge': 'Bank Charges', 'bank charges': 'Bank Charges',
  'prepping service': 'Prep Centre', prep: 'Prep Centre', 'insurance costs': 'Insurance', insurance: 'Insurance',
  software: 'Software', shipping: 'Shipping', postage: 'Shipping', packaging: 'Packaging', advertising: 'Ad Spend',
  'professional fees': 'Professional Fees', accountancy: 'Professional Fees', travel: 'Mileage / Travel',
};
export const stkCategory = (c) => STK_CATEGORY[String(c || '').trim().toLowerCase()] || c || 'Other Expense';

// source: 'bank' | 'stk' | 'auto' — auto takes each calendar month from the bank when that month has bank lines,
// otherwise from SellerToolkit expenses, so a statement covering only part of the period never understates it.
export function overheads({ txns, stkExpenses, nonBank = [], expensesLabel = 'SellerToolkit expenses' }, from, to, source = 'auto') {
  const byCat = {};
  const bankMonths = new Set(txns.map((t) => (t.date || '').slice(0, 7)));
  const useBank = (d) => source === 'bank' || (source === 'auto' && bankMonths.has(d.slice(0, 7)));
  const months = { bank: new Set(), stk: new Set() };
  for (const t of txns) {
    if (!inRange(t.date, from, to) || t.amount >= 0 || EXCLUDED_FROM_PNL.has(t.category) || !useBank(t.date)) continue;
    byCat[t.category] = (byCat[t.category] || 0) + -t.amount; months.bank.add(t.date.slice(0, 7));
  }
  // paid personally or outside the imported bank account: always counted (never in the bank, so never double)
  let manualTotal = 0;
  for (const c of nonBank) {
    if (!inRange(c.date, from, to) || EXCLUDED_FROM_PNL.has(c.category)) continue;
    byCat[c.category] = (byCat[c.category] || 0) + c.amount; manualTotal += c.amount;
  }
  if (source !== 'bank') {
    for (const e of stkExpenses) {
      if (!inRange(e.date, from, to) || e.amount >= 0 || useBank(e.date)) continue;
      const cat = stkCategory(e.category);
      byCat[cat] = (byCat[cat] || 0) + -e.amount; months.stk.add(e.date.slice(0, 7));
    }
  }
  const total = sum(Object.values(byCat), (v) => v);
  const span = (set) => { const m = [...set].sort(); return m.length ? (m.length === 1 ? m[0] : `${m[0]} to ${m.at(-1)}`) : ''; };
  const label = [months.bank.size ? `bank (${span(months.bank)})` : '', months.stk.size ? `${expensesLabel} (${span(months.stk)})` : '', manualTotal ? 'costs outside the bank' : ''].filter(Boolean).join(' + ') || (source === 'stk' ? expensesLabel : 'bank');
  return { total: r2(total), label, fromExpenses: months.stk.size > 0, byCat: Object.fromEntries(Object.entries(byCat).map(([k, v]) => [k, r2(v)]).sort((a, b) => b[1] - a[1])) };
}

// ---- returns loss per SKU from the Returns tracker (settled units whose last move is in the period) ----
export function returnsLoss(units, from, to) {
  const bySku = {};
  let total = 0; let atRisk = 0;
  for (const u of units) {
    const st = STATUS[u.status];
    if (!st) continue;
    if (!st.terminal) { if (inRange(u.returnDate, '2000-01-01', to)) atRisk += unitPnl(u).costBasis; continue; }
    if (u.status === 'relisted_by_amazon' || !inRange(u.statusDate, from, to)) continue;
    const n = unitPnl(u).netVsCost;
    bySku[u.sku] = (bySku[u.sku] || 0) + n;
    total += n;
  }
  return { total: r2(total), atRisk: r2(atRisk), bySku };
}

// ---- the P&L and Sold products ----
export function compute({ orders, txns, stkExpenses, nonBank = [], units: rtUnits = [], fees: settlementLines = [], ebaySales = [], ebayProducts = [], expensesLabel }, { from, to, overheadSource = 'auto', allocate = 'revenue' } = {}) {
  const o = orders.filter((x) => inRange(x.date, from, to));
  const revenue = sum(o, (x) => x.sale);
  const fees = sum(o, (x) => x.fees);
  const vat = sum(o, (x) => x.vat);
  const cogs = sum(o, (x) => x.cog);
  const promo = sum(o, (x) => x.promotion);
  const stkProfit = sum(o, (x) => x.profit);
  const refundRows = o.filter((x) => x.qtyRefunded > 0 || /refund/i.test(x.status));
  const refundCost = -sum(refundRows, (x) => Math.min(0, x.profit));
  const unitsSold = sum(o, (x) => x.qtyNet);
  const shipped = sum(o, (x) => x.qtyShipped);
  const refundedUnits = sum(o, (x) => x.qtyRefunded);
  const oh = overheads({ txns, stkExpenses, nonBank, expensesLabel }, from, to, overheadSource);
  const rl = returnsLoss(rtUnits, from, to);
  const acct = accountLines(settlementLines, from, to); // settlement: storage, subscription, ads, removals… and reimbursements
  const netProfit = stkProfit - oh.total + rl.total - acct.feesTotal + acct.incomeTotal;
  const eb = ebayPnl(ebaySales, ebayProducts, from, to);
  const pool = oh.total + acct.feesTotal - acct.incomeTotal; // shared out across products

  // per product
  const bySku = new Map();
  for (const x of o) {
    const p = bySku.get(x.sku) || { sku: x.sku, asin: x.asin, title: x.title, orders: 0, units: 0, refunded: 0, revenue: 0, fees: 0, vat: 0, cogs: 0, stkProfit: 0, noCogs: 0 };
    p.orders++; p.units += x.qtyNet; p.refunded += x.qtyRefunded; p.revenue += x.sale; p.fees += x.fees; p.vat += x.vat; p.cogs += x.cog; p.stkProfit += x.profit;
    if (x.qtyNet > 0 && !x.cog) p.noCogs += x.qtyNet;
    if (!p.title && x.title) p.title = x.title;
    bySku.set(x.sku, p);
  }
  for (const [sku, loss] of Object.entries(rl.bySku)) if (!bySku.has(sku)) bySku.set(sku, { sku, asin: '', title: '', orders: 0, units: 0, refunded: 0, revenue: 0, fees: 0, vat: 0, cogs: 0, stkProfit: 0, noCogs: 0 });
  const products = [...bySku.values()].map((p) => {
    const share = allocate === 'units' ? (unitsSold ? p.units / unitsSold : 0) : (revenue ? p.revenue / revenue : 0);
    const returnsAdj = rl.bySku[p.sku] || 0;
    const overhead = pool * share;
    const actualNet = p.stkProfit + returnsAdj - overhead;
    return {
      ...p, revenue: r2(p.revenue), fees: r2(p.fees), vat: r2(p.vat), cogs: r2(p.cogs), stkProfit: r2(p.stkProfit),
      returnsAdj: r2(returnsAdj), overhead: r2(overhead), actualNet: r2(actualNet),
      perUnit: p.units ? r2(actualNet / p.units) : null, margin: p.revenue ? actualNet / p.revenue : null, roi: p.cogs ? actualNet / p.cogs : null,
    };
  }).sort((a, b) => b.actualNet - a.actualNet);

  return {
    from, to, orders: o.length, units: unitsSold, shipped, refundedUnits,
    revenue: r2(revenue), fees: r2(fees), vatOnFees: r2(vat), cogs: r2(cogs), promotions: r2(promo), refundCost: r2(refundCost),
    stkProfit: r2(stkProfit), overheads: oh.total, overheadsByCat: oh.byCat, overheadsFrom: oh.label, overheadsFromExpenses: oh.fromExpenses, returnsLoss: rl.total, stockAtRisk: rl.atRisk,
    accountFees: acct.feesTotal, accountFeesByType: acct.byType, reimbursements: acct.incomeTotal, reimbursementsByType: acct.incomeByType,
    netProfit: r2(netProfit), margin: revenue ? netProfit / revenue : null,
    ebay: eb, combinedRevenue: r2(revenue + eb.revenue), combinedNet: r2(netProfit + eb.profit),
    combinedMargin: revenue + eb.revenue ? (netProfit + eb.profit) / (revenue + eb.revenue) : null,
    returnRate: shipped ? refundedUnits / shipped : null,
    products,
    noCogsUnits: products.reduce((a, p) => a + p.noCogs, 0),
    noCogsSkus: products.filter((p) => p.noCogs).map((p) => p.sku),
  };
}

// ---- VAT threshold: rolling 12 months of turnover, and when you'd cross it at the recent pace ----
export function vatGauge(orders, { today = iso(new Date()), threshold = 90000, extraTurnover = [] } = {}) {
  const t = Date.parse(`${today}T00:00:00Z`);
  const from12 = iso(new Date(t - 365 * 864e5));
  const from3 = iso(new Date(t - 91 * 864e5));
  const rows = [...orders.map((o) => ({ date: o.date, v: o.sale })), ...extraTurnover];
  const rolling = sum(rows.filter((x) => inRange(x.date, from12, today)), (x) => x.v);
  const last3 = sum(rows.filter((x) => inRange(x.date, from3, today)), (x) => x.v);
  const perMonth = last3 / 3;
  const remaining = threshold - rolling;
  let crossIn = null;
  if (remaining <= 0) crossIn = 0;
  else if (perMonth > 0) crossIn = Math.ceil(remaining / perMonth);
  return { rolling: r2(rolling), threshold, pct: rolling / threshold, perMonth: r2(perMonth), crossInMonths: crossIn };
}

// ---- annualised subscription + software spend (monthly average over the last 90 days × 12) ----
export function subscriptionsAnnual(txns, today = iso(new Date())) {
  const t = Date.parse(`${today}T00:00:00Z`);
  const from = iso(new Date(t - 90 * 864e5));
  const s = sum(txns.filter((x) => inRange(x.date, from, today) && x.amount < 0 && ['Subscription', 'Software'].includes(x.category)), (x) => -x.amount);
  return r2((s / 3) * 12);
}

// ---- stock bought but not yet sold, at cost (from purchases − units sold, per SKU, at average cost) ----
export function stockAtCost(stock, orders) {
  const bySku = {};
  for (const s of stock) {
    const k = s.sku; const a = bySku[k] || { qty: 0, cost: 0 };
    a.qty += s.quantity; a.cost += s.totalCost; bySku[k] = a;
  }
  const sold = {};
  for (const o of orders) sold[o.sku] = (sold[o.sku] || 0) + o.qtyNet;
  let value = 0; let unitsLeft = 0;
  for (const [sku, a] of Object.entries(bySku)) {
    const left = Math.max(0, a.qty - (sold[sku] || 0));
    unitsLeft += left; value += left * (a.qty ? a.cost / a.qty : 0);
  }
  return { value: r2(value), units: unitsLeft };
}
