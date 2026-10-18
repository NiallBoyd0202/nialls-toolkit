// FBA Admin — import engine. Pure logic over a store adapter:
//   store = { getAll(storeName), commit({ storeName: [records] }) }   (commit = one transaction)
// Imports are idempotent: every record's id is a fingerprint of its natural key, so the same rows
// imported twice (or an overlapping date range) never duplicate.

import { parseDate, detectDateOrder } from '../returns/parse.js';
import { healthRecords } from './aged.js';
import { parseMoney } from '../util.js';
import { suggestCategory, DEFAULT_RULES } from './categories.js';
import { fromSettlementV2, fromDateRange } from './settlement.js';

// ---- synchronous SHA-1 (fingerprints, not security) so transforms stay pure and sync ----
function sha1hex(str) {
  const bytes = new TextEncoder().encode(str);
  const ml = bytes.length * 8;
  const withPad = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  withPad.set(bytes); withPad[bytes.length] = 0x80;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 4, ml >>> 0); dv.setUint32(withPad.length - 8, Math.floor(ml / 2 ** 32));
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) { const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; w[i] = (x << 1) | (x >>> 31); }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((x) => x.toString(16).padStart(8, '0')).join('');
}
// sha1 of the lower-cased, pipe-joined parts, first 16 hex chars (matches the Python build's rowKey)
export function rowKey(...parts) {
  return sha1hex(parts.map((p) => String(p ?? '').trim().toLowerCase()).join('|')).slice(0, 16);
}

const money = (v) => { const n = parseMoney(v); return n === null ? 0 : n; };
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const int = (v) => Math.round(money(v));
const now = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Transforms: rows -> records for one store
// ---------------------------------------------------------------------------
export function bankRecords(rows, { account = 'Main', currency = 'GBP', rules = DEFAULT_RULES, sourceFile = '' } = {}) {
  const out = [];
  const skipped = { notCompleted: 0, otherCurrency: 0, zero: 0, noDate: 0 };
  const seen = new Map();
  for (const r of rows) {
    if (r.state && !/^(completed|complete|posted|booked|cleared)$/i.test(r.state)) { skipped.notCompleted++; continue; }
    if (r.currency && currency && r.currency.toUpperCase() !== currency.toUpperCase()) { skipped.otherCurrency++; continue; }
    const date = parseDate(r.date);
    if (!date) { skipped.noDate++; continue; }
    let amount = r.amount !== '' && r.amount !== undefined ? money(r.amount) : money(r.credit) - Math.abs(money(r.debit));
    amount = r2(amount);
    if (!amount) { skipped.zero++; continue; }
    const acct = r.account || account;
    const balance = r.balance !== '' && r.balance !== undefined ? r2(money(r.balance)) : '';
    // Same day + payee + amount happens (four identical card payments in one day), so the running balance
    // is part of the key; without one, the occurrence number within the file is.
    const base = ['bank', acct, date, r.description, amount, balance].join('|');
    const n = (seen.get(base) || 0) + 1; seen.set(base, n);
    const id = rowKey('bank', acct, date, r.description, amount, balance, balance === '' ? n : '');
    const s = suggestCategory(`${r.description} ${r.reference || ''}`, amount, rules);
    out.push({
      id, date, description: r.description || '', reference: r.reference || '', type: r.type || '', amount, balance,
      account: acct, currency: (r.currency || currency || '').toUpperCase(),
      category: s.category, categorySource: s.source, ruleKeyword: s.keyword,
      linkedInvoice: '', reconciled: false, sourceFile, createdAt: now(), updatedAt: now(),
    });
  }
  return { records: out, skipped };
}

export function stkOrderRecords(rows, { sourceFile = '' } = {}) {
  const out = [];
  for (const r of rows) {
    if (!r.orderId || !r.sku) continue;
    const orderDate = parseDate(r.orderDate);
    const refundDate = parseDate(r.refundDate);
    out.push({
      id: rowKey('stk', r.orderId, r.sku, r.status, refundDate, r.qtyNet),
      orderId: r.orderId, date: orderDate, refundDate, sku: r.sku, asin: r.asin, title: r.title, brand: r.brand || '',
      status: r.status || '', orderType: r.orderType || '',
      qtyShipped: int(r.qtyShipped), qtyRefunded: int(r.qtyRefunded), qtyNet: int(r.qtyNet),
      sale: r2(money(r.sale)), cog: r2(money(r.cog)), fees: r2(money(r.fees)), feesFba: r2(money(r.feesFba)), feesReferral: r2(money(r.feesReferral)),
      vat: r2(money(r.vat)), promotion: r2(money(r.promotion)), shippingCharge: r2(money(r.shippingCharge)), shippingCost: r2(money(r.shippingCost)),
      profit: r2(money(r.profit)),
      damaged: int(r.damaged), toInventory: int(r.toInventory), refundReason: r.refundReason || '', customerComment: r.customerComment || '',
      source: 'sellertoolkit', sourceFile, updatedAt: now(),
    });
  }
  return { records: out, skipped: {} };
}

export function stkExpenseRecords(rows, { sourceFile = '' } = {}) {
  const out = [];
  const seen = new Map();
  for (const r of rows) {
    const date = parseDate(r.date);
    let amount = r.amount !== '' ? money(r.amount) : money(r.credit) - money(r.debit);
    // SellerToolkit's Amount column is a running total on some exports; Credit/Debit are per line.
    if (r.debit !== '' || r.credit !== '') amount = money(r.credit) - money(r.debit);
    amount = r2(amount);
    if (!date || !amount) continue;
    const base = [date, r.category, r.description, amount].join('|');
    const n = (seen.get(base) || 0) + 1; seen.set(base, n);
    out.push({ id: rowKey('stkexp', date, r.category, r.description, amount, n), date, category: r.category || 'Other Expense', description: (r.description || '').trim(), amount, currency: r.currency || 'GBP', sourceFile, updatedAt: now() });
  }
  return { records: out, skipped: {} };
}

export function stkStockRecords(rows, { includeVat = true, sourceFile = '' } = {}) {
  const out = [];
  for (const r of rows) {
    if (!r.sku) continue;
    const pick = (inc, net) => money(includeVat ? (inc || net) : (net || inc));
    const unit = pick(r.unitCostInc, r.unitCostNet);
    const extra = pick(r.deliveryInc, r.deliveryNet) + pick(r.prepInc, r.prepNet);
    const qty = Math.max(1, int(r.purchasedQty) || 1);
    const received = int(r.deliveredQty);
    out.push({
      id: r.uniqueNumber ? `stk-${r.uniqueNumber}` : rowKey('stock', r.sku, r.purchaseDate, r.purchasedQty, r.unitCostInc, r.shipmentId),
      datePurchased: parseDate(r.purchaseDate), productName: r.title, sku: r.sku, asin: r.asin, supplier: r.supplier || '', supplierLink: r.supplierLink || '',
      quantity: qty, unitCost: r2(unit + extra), unitCostGoods: r2(unit), totalCost: r2((unit + extra) * qty), shipmentId: r.shipmentId || '', orderNumber: r.orderNumber || '',
      qtyReceived: received, status: received >= qty ? 'Received' : received > 0 ? 'Discrepancy' : 'In Transit', stkStatus: r.status || '',
      invoiceLink: '', source: 'sellertoolkit', sourceFile, updatedAt: now(),
    });
  }
  return { records: out, skipped: {} };
}

// ---------------------------------------------------------------------------
// SellerFuse: the same records as SellerToolkit's, marked source 'sellerfuse' and channel 'amazon' or 'ebay'.
// Which source counts for which dates is decided when the data is loaded (sources.js), never at import.
// ---------------------------------------------------------------------------
export function sfOrderRecords(rows, { sourceFile = '' } = {}) {
  const out = []; const seen = new Map();
  for (const r of rows) {
    if (!r.orderId) continue;
    const date = parseDate(r.orderDate);
    if (!date) continue;
    const channel = /ebay/i.test(`${r.channel || ''} ${r.orderId}`) && !/amazon/i.test(r.channel || '') ? 'ebay' : 'amazon';
    const qty = int(r.qtyShipped) || 1;
    const sale = r2(money(r.sale));
    const fees = r2(Math.abs(money(r.fees))); const vat = r2(Math.abs(money(r.vat))); const cog = r2(Math.abs(money(r.cog)));
    const refund = r2(Math.abs(money(r.refund)));
    const qtyRefunded = int(r.qtyRefunded) || (refund > 0 ? qty : 0);
    const shippingCost = r2(Math.abs(money(r.shippingCost)));
    const profit = r.profit !== '' && r.profit !== undefined && r.profit !== null ? r2(money(r.profit)) : r2(sale - fees - vat - cog - refund - shippingCost);
    const base = ['sf', channel, r.orderId, r.sku || r.title || '', r.status || '', date].join('|');
    const n = (seen.get(base) || 0) + 1; seen.set(base, n);
    out.push({
      id: rowKey('sf', base, n), orderId: r.orderId, date, refundDate: parseDate(r.refundDate) || (refund > 0 ? date : ''), sku: r.sku || '', asin: r.asin || '', title: r.title || '', brand: '',
      status: r.status || (refund > 0 ? 'Refunded' : ''), orderType: '', channel,
      qtyShipped: qty, qtyRefunded, qtyNet: Math.max(0, qty - qtyRefunded),
      sale, cog, fees, feesFba: 0, feesReferral: 0, vat, promotion: r2(money(r.promotion)), shippingCharge: 0, shippingCost, profit, refund,
      source: 'sellerfuse', sourceFile, updatedAt: now(),
    });
  }
  return { records: out, skipped: {} };
}

export function sfExpenseRecords(rows, { sourceFile = '' } = {}) {
  const out = []; const seen = new Map();
  const split = rows.some((r) => (r.debit ?? '') !== '' || (r.credit ?? '') !== '');
  // a list of costs written as positive amounts: they're money out
  const allPositive = !split && rows.every((r) => money(r.amount) >= 0);
  for (const r of rows) {
    const date = parseDate(r.date);
    let amount = split ? money(r.credit) - money(r.debit) : money(r.amount);
    if (allPositive) amount = -amount;
    amount = r2(amount);
    if (!date || !amount) continue;
    const base = [date, r.category, r.description, amount].join('|');
    const n = (seen.get(base) || 0) + 1; seen.set(base, n);
    out.push({ id: rowKey('sfexp', date, r.category, r.description, amount, n), date, category: r.category || 'Other Expense', description: (r.description || '').trim(), amount, currency: r.currency || 'GBP', source: 'sellerfuse', sourceFile, updatedAt: now() });
  }
  return { records: out, skipped: {} };
}

export function sfStockRecords(rows, { sourceFile = '' } = {}) {
  const out = []; const seen = new Map();
  for (const r of rows) {
    if (!r.sku) continue;
    const unit = Math.abs(money(r.unitCost)); const extra = Math.abs(money(r.extraCost));
    const qty = Math.max(1, int(r.quantity) || 1);
    const received = r.received === '' || r.received === undefined ? qty : int(r.received);
    const date = parseDate(r.purchaseDate);
    const base = [r.sku, date, qty, unit, r.orderNumber || ''].join('|');
    const n = (seen.get(base) || 0) + 1; seen.set(base, n);
    out.push({
      id: rowKey('sfstock', base, n), datePurchased: date, productName: r.title || '', sku: r.sku, asin: r.asin || '', supplier: r.supplier || '', supplierLink: '',
      quantity: qty, unitCost: r2(unit + extra), unitCostGoods: r2(unit), totalCost: r2((unit + extra) * qty), shipmentId: '', orderNumber: r.orderNumber || '',
      qtyReceived: received, status: received >= qty ? 'Received' : received > 0 ? 'Discrepancy' : 'In Transit', stkStatus: '',
      invoiceLink: '', source: 'sellerfuse', sourceFile, updatedAt: now(),
    });
  }
  return { records: out, skipped: {} };
}

// Average cost per SKU from SellerFuse purchases, in the shape the Returns tracker's SKU costs use.
export function sfSkuCosts(stockRecords) {
  const by = new Map();
  for (const s of stockRecords) {
    const k = s.sku.toLowerCase(); const a = by.get(k) || { sku: s.sku, asin: s.asin, title: s.productName, qty: 0, cost: 0, extra: 0 };
    a.qty += s.quantity; a.cost += s.unitCostGoods * s.quantity; a.extra += (s.unitCost - s.unitCostGoods) * s.quantity; by.set(k, a);
  }
  return [...by.values()].map((a) => ({ sku: a.sku, asin: a.asin, title: a.title, cogs: r2(a.cost / a.qty), inboundPerUnit: r2(a.extra / a.qty) }));
}

// Inventory ledger (daily summary): one record per day × FNSKU × disposition × location.
export function ledgerRecords(rows, { sourceFile = '' } = {}) {
  const out = [];
  for (const r of rows) {
    const date = parseDate(r.date);
    if (!date || !r.sku) continue;
    const n = (v) => int(v);
    out.push({
      id: rowKey('ledger', date, r.fnsku, r.disposition, r.location), date, fnsku: r.fnsku || '', asin: r.asin || '', sku: r.sku, title: r.title || '',
      disposition: (r.disposition || '').toUpperCase(), location: r.location || '',
      starting: n(r.starting), inTransit: n(r.inTransit), receipts: n(r.receipts), shipments: n(r.shipments), customerReturns: n(r.customerReturns),
      vendorReturns: n(r.vendorReturns), transfers: n(r.transfers), found: n(r.found), lost: n(r.lost), damaged: n(r.damaged), disposed: n(r.disposed),
      other: n(r.other), ending: n(r.ending), unknown: n(r.unknown), sourceFile, updatedAt: now(),
    });
  }
  return { records: out, skipped: {} };
}

// All Listings report: one record per SKU (your current price, status and ASIN).
export function listingRecords(rows, { sourceFile = '' } = {}) {
  const out = [];
  for (const r of rows) {
    if (!r.sku) continue;
    out.push({
      id: r.sku, sku: r.sku, asin: r.asin || '', title: r.title || '', price: r2(money(r.price)), quantity: r.quantity === '' ? null : int(r.quantity),
      status: r.status || '', channel: r.channel || '', fba: /amazon/i.test(r.channel || ''), openDate: parseDate(r.openDate), listingId: r.listingId || '', sourceFile, updatedAt: now(),
    });
  }
  return { records: out, skipped: {} };
}

const MONTH_NO = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// Sales Dashboard: ordered product sales and units per month. The year comes from the report's banner rows.
export function salesDashboardMonths(parsed, fileName = '') {
  const banner = (parsed.preamble || []).flat().join(' ');
  const year = Number((banner.match(/(20\d{2})/) || fileName.match(/(20\d{2})/) || [])[1]) || new Date().getFullYear();
  const months = {};
  for (const r of parsed.rows) {
    const m = MONTH_NO[String(r.month || '').trim().slice(0, 3).toLowerCase()];
    if (!m || r.sales === '') continue;
    const key = `${year}-${String(m).padStart(2, '0')}`;
    months[key] = { sales: r2(money(r.sales)), units: int(r.units) };
    if (r.lastYearSales !== '' && r.lastYearSales !== undefined) months[`${year - 1}-${String(m).padStart(2, '0')}`] = { sales: r2(money(r.lastYearSales)), units: int(r.lastYearUnits) };
  }
  return { year, months };
}

const STORE_FOR = { bank: 'faTransactions', sales: 'faSoldProducts', expenses: 'faStkExpenses', stock: 'faStock', ledger: 'faLedger', listings: 'faListings' };

// Rewrites every date-like field to YYYY-MM-DD, working out day-first vs month-first per column.
function normaliseDates(rows, fallback) {
  if (!rows.length) return rows;
  const dateFields = Object.keys(rows[0]).filter((f) => f !== '_raw' && (/date$/i.test(f) || f === 'date'));
  const orders = Object.fromEntries(dateFields.map((f) => [f, detectDateOrder(rows.map((r) => r[f]), fallback)]));
  return rows.map((r) => {
    const o = { ...r };
    for (const f of dateFields) o[f] = parseDate(r[f], orders[f]);
    return o;
  });
}

// Single entry point. Bank rows are add-only (a category you set is never overwritten);
// SellerToolkit rows are upserted, because SellerToolkit recalculates profit when you change a COGS.
export async function applyImport(parsed, { store, settings = {}, rules, fileName = '', account } = {}) {
  const kind = parsed.format.kind;
  if (kind === 'summary') throw new Error('Summary exports only add totals. Import "Orders – Detailed" instead, which has every order line.');
  if (kind === 'salesdash') {
    const { year, months } = salesDashboardMonths(parsed, fileName);
    const prev = (await store.getKv?.('fbaSalesDashboard')) || { months: {} };
    const merged = { months: { ...(prev.months || {}), ...months }, savedAt: Date.now() };
    const log = { id: `fa-imp-${Date.now()}`, at: now(), reportType: parsed.formatId, label: parsed.format.label, fileName, rowsAdded: Object.keys(months).length, rowsUpdated: 0, rowsSkipped: 0, from: `${year - 1}-01-01`, to: `${year}-12-31`, skipped: {} };
    await store.setKv('fbaSalesDashboard', merged);
    await store.commit({ faImportLog: [log] });
    return { added: Object.keys(months).length, updated: 0, dupes: 0, skipped: {}, log, storeName: 'kv' };
  }
  if (kind === 'settlement') {
    const norm = normaliseDates(parsed.rows, 'dmy');
    const helpers = { rowKey, parseDate: (v) => parseDate(v), money };
    const { lines, settlements } = parsed.formatId === 'amazon_settlement' ? fromSettlementV2(norm, helpers) : fromDateRange(norm, helpers);
    const [exL, exS] = await Promise.all([store.getAll('faFees'), store.getAll('faSettlements')]);
    const haveL = new Set(exL.map((x) => x.id)); const haveS = new Set(exS.map((x) => x.id));
    const newL = lines.filter((l) => !haveL.has(l.id)).map((l) => ({ ...l, sourceFile: fileName, updatedAt: now() }));
    const newS = settlements.filter((x) => !haveS.has(x.id)).map((x) => ({ ...x, sourceFile: fileName, updatedAt: now() }));
    const dates = lines.map((l) => l.date).filter(Boolean).sort();
    const counts = lines.reduce((c, l) => { c[l.group] = (c[l.group] || 0) + 1; return c; }, {});
    const log = { id: `fa-imp-${Date.now()}`, at: now(), reportType: parsed.formatId, label: parsed.format.label, fileName, rowsAdded: newL.length + newS.length, rowsUpdated: 0, rowsSkipped: lines.length + settlements.length - newL.length - newS.length, from: dates[0] || '', to: dates.at(-1) || '', skipped: {}, counts };
    await store.commit({ faFees: newL, faSettlements: newS, faImportLog: [log] });
    return { added: newL.length + newS.length, updated: 0, dupes: log.rowsSkipped, skipped: {}, log, storeName: 'faFees', counts, payouts: settlements.length };
  }
  if (kind === 'health') {
    // a snapshot: the newest report replaces the previous one completely
    const norm = normaliseDates(parsed.rows, 'mdy');
    const recs = healthRecords(norm).map((r) => ({ ...r, sourceFile: fileName, updatedAt: now() }));
    if (!recs.length) throw new Error('No SKUs found in this report');
    const old = await store.getAll('faInvHealth');
    if (store.delMany) await store.delMany('faInvHealth', old.map((x) => x.id));
    const snap = recs.map((r) => r.snapshotDate).filter(Boolean).sort().at(-1) || '';
    const log = { id: `fa-imp-${Date.now()}`, at: now(), reportType: parsed.formatId, label: parsed.format.label, fileName, rowsAdded: recs.length, rowsUpdated: 0, rowsSkipped: 0, from: snap, to: snap, skipped: {} };
    await store.commit({ faInvHealth: recs, faImportLog: [log] });
    return { added: recs.length, updated: 0, dupes: 0, skipped: {}, log, storeName: 'faInvHealth' };
  }
  // Amazon's ledger CSV is month-first (09/30/2026); everything else here defaults to UK day-first.
  parsed = { ...parsed, rows: normaliseDates(parsed.rows, kind === 'ledger' ? 'mdy' : 'dmy') };
  const opts = { sourceFile: fileName, account: account || settings.bankAccountName || 'Main', currency: settings.bankCurrency || 'GBP', rules: rules || DEFAULT_RULES, includeVat: settings.costsIncludeVat !== false };
  const sf = !!parsed.format.sellerfuse;
  const { records, skipped } = kind === 'bank' ? bankRecords(parsed.rows, opts)
    : kind === 'sales' ? (sf ? sfOrderRecords : stkOrderRecords)(parsed.rows, opts)
      : kind === 'expenses' ? (sf ? sfExpenseRecords : stkExpenseRecords)(parsed.rows, opts)
        : kind === 'ledger' ? ledgerRecords(parsed.rows, opts)
          : kind === 'listings' ? listingRecords(parsed.rows, opts)
            : kind === 'stock' ? (sf ? sfStockRecords : stkStockRecords)(parsed.rows, opts)
              : (() => { throw new Error(`No importer for ${parsed.format.label}`); })();
  const storeName = STORE_FOR[kind];
  const existing = new Map((await store.getAll(storeName)).map((r) => [r.id, r]));
  const batch = new Set();
  const writes = [];
  let added = 0, updated = 0, dupes = 0;
  for (const rec of records) {
    if (batch.has(rec.id)) { dupes++; continue; }
    batch.add(rec.id);
    const ex = existing.get(rec.id);
    if (!ex) { writes.push(rec); added++; continue; }
    if (kind === 'bank') { dupes++; continue; }
    // _mt is when it last changed on this device (for sync), not part of the data
    const { updatedAt: a, sourceFile: b, _mt: m1, ...x } = ex; const { updatedAt: c, sourceFile: d, _mt: m2, ...y } = rec;
    if (JSON.stringify(x) === JSON.stringify(y)) { dupes++; continue; }
    writes.push({ ...ex, ...rec }); updated++;
  }
  const dates = records.map((r) => r.date || r.datePurchased).filter(Boolean).sort();
  const log = { id: `fa-imp-${Date.now()}`, at: now(), reportType: parsed.formatId, label: parsed.format.label, fileName, rowsAdded: added, rowsUpdated: updated, rowsSkipped: dupes, from: dates[0] || '', to: dates.at(-1) || '', skipped };
  await store.commit({ [storeName]: writes, faImportLog: [log] });
  return { added, updated, dupes, skipped, log, storeName, records };
}
