// FBA Returns tracker — import engine. Pure logic over a store adapter:
//   store = { allUnits(), allSkuCosts(), putUnits(array), putSkuCosts(array), putUnmatched(array), putImportLog(record), commit?(writes) }
//
// Allocation of a report line to unit(s) is a three-tier cascade:
//   1. identifier (LPN)   2. reference (removal order, tracking, eBay order/item, Amazon order)   3. FIFO by SKU
// Every applied line stamps an idempotency key on the unit, so re-importing the same report changes nothing.
// A line that can't be placed goes to the Unmatched inbox with a reason — never dropped, never half-applied.

import { emptyUnit, emptySale, transition, normDisposition, num, r2, STAGE, STATUS } from './model.js';
import { parseDate, detectDateOrder } from './parse.js';

const today = () => new Date().toISOString().slice(0, 10);
const lc = (s) => String(s ?? '').trim().toLowerCase();
const int = (v, d = 0) => { const n = Math.round(num(v)); return Number.isFinite(n) && n !== 0 ? n : d; };

export const key = (prefix, ...parts) => `${prefix}:${parts.map((p) => lc(p)).join('|')}`;

// How many units already carry this report line's key.
export function alreadyDone(units, k) {
  let n = 0;
  for (const u of units) if ((u.applied || []).includes(k)) n++;
  return n;
}

// Prep invoice lines map a free-text cost type to a bucket. Order matters: the patterns overlap.
export function bucketFor(costType) {
  const s = lc(costType);
  if (/storage|hold/.test(s)) return 'storageFee';
  if (/inbound|back to amazon|re-?inbound|fba shipment/.test(s)) return 'reInboundShipping';
  if (/postage|shipping|courier|label|despatch|dispatch|delivery/.test(s)) return 'onwardShipping';
  if (/prep|handling|grading|grade|test|photo|listing|clean|repack/.test(s)) return 'prepFee';
  return 'otherCost';
}

function ctxFor(units, skuCosts) {
  const byId = new Map(units.map((u) => [u.id, u]));
  const touched = new Map();
  const ctx = {
    units: byId,
    costsBySku: new Map(skuCosts.map((c) => [lc(c.sku), c])),
    skuCostWrites: new Map(),
    misses: [],
    stats: { rows: 0, created: 0, updated: 0, skipped: 0, unmatched: 0 },
    // committed units + in-flight mutations, so a row can allocate against a unit created earlier in the same file
    index: () => [...byId.values()],
    save(u) { u.updatedAt = new Date().toISOString(); byId.set(u.id, u); touched.set(u.id, u); },
    touched,
  };
  return ctx;
}

function fifo(list) {
  return [...list].sort((a, b) => (a.returnDate || '').localeCompare(b.returnDate || '') || (a.createdAt || '').localeCompare(b.createdAt || ''));
}

// Candidates for a SKU in the given statuses, not already carrying `k`, FIFO, optionally preferred.
function pickUnits(ctx, { sku, statuses, k, n, prefer = null, filter = null }) {
  let list = ctx.index().filter((u) => lc(u.sku) === lc(sku) && statuses.includes(u.status) && !(u.applied || []).includes(k));
  if (filter) list = list.filter(filter);
  list = fifo(list);
  if (prefer) list = [...list.filter(prefer), ...list.filter((u) => !prefer(u))];
  return list.slice(0, n);
}

function miss(ctx, formatId, reason, row) {
  ctx.misses.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, formatId, reason, at: new Date().toISOString(), row: row._raw || row });
  ctx.stats.unmatched++;
}

function stamp(u, k) {
  u.applied = [...(u.applied || []), k];
}

const costFor = (ctx, sku) => ctx.skuCostWrites.get(lc(sku)) || ctx.costsBySku.get(lc(sku)) || null;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
const handlers = {
  // The only creator: one unit per physical item.
  amazon_returns(ctx, row) {
    if (!row.sku) return miss(ctx, 'amazon_returns', 'No SKU on this return', row);
    const qty = Math.max(1, int(row.quantity, 1));
    const disposition = normDisposition(row.disposition);
    for (let n = 1; n <= qty; n++) {
      const all = ctx.index();
      const lpn = row.lpn ? (qty > 1 ? `${row.lpn}#${n}` : row.lpn) : '';
      const dedupeKey = lpn ? '' : key('rt', row.returnDate, row.orderId, row.sku, n);
      const existing = all.find((u) => (lpn && u.lpn === lpn) || (dedupeKey && u.dedupeKey === dedupeKey));
      // A unit made earlier from a refund in your order data: this report confirms it, so fill it in (no duplicate)
      const fromRefund = !existing && row.orderId ? all.find((u) => u.fromRefund && lc(u.orderId) === lc(row.orderId) && lc(u.sku) === lc(row.sku)) : null;
      if (fromRefund) {
        let u = { ...fromRefund, fromRefund: false, lpn, dedupeKey, fnsku: row.fnsku || fromRefund.fnsku, title: fromRefund.title || row.title, asin: fromRefund.asin || row.asin,
          returnDate: row.returnDate || fromRefund.returnDate, disposition, amazonStatus: row.amazonStatus,
          reason: [row.reason, row.comments].filter(Boolean).join(' — ') || fromRefund.reason, notes: '' };
        if (disposition === 'SELLABLE' && /inventory|sellable/i.test(row.amazonStatus || '') && u.status === 'returned_at_amazon') {
          u = transition(u, 'relisted_by_amazon', { date: u.returnDate, note: 'Returned to sellable stock by Amazon' });
        }
        ctx.save(u); ctx.stats.updated++;
        continue;
      }
      if (existing) {
        // Same unit seen again: refresh what Amazon may have updated, nothing else.
        const changed = (row.amazonStatus && existing.amazonStatus !== row.amazonStatus) || (disposition !== 'UNKNOWN' && existing.disposition !== disposition);
        if (changed) {
          const u = { ...existing, amazonStatus: row.amazonStatus || existing.amazonStatus, disposition: disposition !== 'UNKNOWN' ? disposition : existing.disposition };
          ctx.save(u); ctx.stats.updated++;
        } else ctx.stats.skipped++;
        continue;
      }
      const c = costFor(ctx, row.sku);
      const returnDate = row.returnDate || today();
      let u = emptyUnit({
        lpn, dedupeKey, returnDate, orderId: row.orderId, sku: row.sku, asin: row.asin, fnsku: row.fnsku, title: row.title,
        disposition, reason: [row.reason, row.comments].filter(Boolean).join(' — '), amazonStatus: row.amazonStatus,
        refs: { amazonOrderId: row.orderId },
        costs: { cogs: r2(num(c?.cogs)), inboundOriginal: r2(num(c?.inboundPerUnit)) },
        statusDate: returnDate,
      });
      if (disposition === 'SELLABLE' && /inventory|sellable/i.test(row.amazonStatus || '')) {
        u = transition(u, 'relisted_by_amazon', { date: returnDate, note: 'Returned to sellable stock by Amazon' });
      }
      ctx.save(u); ctx.stats.created++;
    }
  },

  amazon_removal_order(ctx, row) {
    if (!row.sku) return miss(ctx, 'amazon_removal_order', 'No SKU', row);
    if (/cancel/i.test(row.orderStatus || '') && !int(row.shippedQty) && !int(row.disposedQty)) { ctx.stats.skipped++; return; }
    const want = int(row.shippedQty) + int(row.disposedQty) || (int(row.requestedQty) - int(row.cancelledQty)) || int(row.requestedQty, 1);
    const k = key('ro', row.removalOrderId, row.sku, row.disposition);
    const done = alreadyDone(ctx.index(), k);
    const need = want - done;
    if (need <= 0) { ctx.stats.skipped++; return; }
    const sellable = /^sellable/i.test(row.disposition || '');
    const compatible = (u) => (sellable ? u.disposition === 'SELLABLE' : u.disposition !== 'SELLABLE');
    // Disposition is a hard filter first; only if nothing compatible exists fall back to any unit still returned at Amazon.
    let picked = pickUnits(ctx, { sku: row.sku, statuses: STAGE.removal, k, n: need, filter: compatible, prefer: (u) => u.refs?.removalOrderId === row.removalOrderId });
    if (!picked.length) picked = pickUnits(ctx, { sku: row.sku, statuses: ['returned_at_amazon'], k, n: need });
    const feeEach = want ? Math.abs(num(row.removalFee)) / want : 0;
    const disposal = /dispos/i.test(row.orderType || '');
    for (let u of picked) {
      u = { ...u, costs: { ...u.costs, removalFee: r2(num(u.costs.removalFee) + feeEach) }, refs: { ...u.refs, removalOrderId: row.removalOrderId || u.refs.removalOrderId } };
      const date = row.requestDate || today();
      u = transition(u, disposal ? 'written_off' : 'removal_requested', { date, note: `Removal order ${row.removalOrderId || ''}${disposal ? ' (disposal)' : ''}`.trim() });
      stamp(u, k); ctx.save(u); ctx.stats.updated++;
    }
    if (picked.length < need) miss(ctx, 'amazon_removal_order', `${need - picked.length} of ${need} unit(s) for ${row.sku} not found at Amazon`, row);
  },

  amazon_removal_shipment(ctx, row) {
    if (!row.sku) return miss(ctx, 'amazon_removal_shipment', 'No SKU', row);
    const want = int(row.shippedQty, 1);
    const k = key('rs', row.removalOrderId, row.tracking, row.sku);
    const need = want - alreadyDone(ctx.index(), k);
    if (need <= 0) { ctx.stats.skipped++; return; }
    const picked = pickUnits(ctx, { sku: row.sku, statuses: STAGE.removalShipment, k, n: need, prefer: (u) => u.refs?.removalOrderId === row.removalOrderId });
    for (let u of picked) {
      u = { ...u, refs: { ...u.refs, tracking: row.tracking || u.refs.tracking, removalOrderId: u.refs.removalOrderId || row.removalOrderId } };
      u = transition(u, 'in_transit_to_prep', { date: row.shipmentDate || today(), note: `Shipped ${row.carrier || ''} ${row.tracking || ''}`.trim() });
      stamp(u, k); ctx.save(u); ctx.stats.updated++;
    }
    if (picked.length < need) miss(ctx, 'amazon_removal_shipment', `${need - picked.length} of ${need} unit(s) for ${row.sku} have no matching removal request`, row);
  },

  amazon_reimbursements(ctx, row) {
    if (!row.sku) return miss(ctx, 'amazon_reimbursements', 'No SKU', row);
    const qty = int(row.quantity, 1);
    const each = num(row.amountPerUnit) || (num(row.amountTotal) / qty);
    if (!each) { ctx.stats.skipped++; return; }
    const k = key('rb', row.reimbursementId, row.sku);
    const need = qty - alreadyDone(ctx.index(), k);
    if (need <= 0) { ctx.stats.skipped++; return; }
    let picked = [];
    if (row.orderId) picked = fifo(ctx.index().filter((u) => lc(u.sku) === lc(row.sku) && (u.orderId === row.orderId || u.refs?.amazonOrderId === row.orderId) && !(u.applied || []).includes(k))).slice(0, need);
    // Without an order id, only returns-related reimbursements are placed by SKU; warehouse losses aren't returns.
    if (!picked.length && /return|customer/i.test(row.reason || '')) picked = pickUnits(ctx, { sku: row.sku, statuses: STAGE.anyOpen, k, n: need });
    for (let u of picked) {
      u = { ...u, reimbursement: r2(num(u.reimbursement) + each) };
      stamp(u, k); ctx.save(u); ctx.stats.updated++;
    }
    if (picked.length < need) miss(ctx, 'amazon_reimbursements', row.orderId ? `No returned unit for order ${row.orderId}` : `Not linked to a return (${row.reason || 'no reason given'})`, row);
  },

  amazon_transactions(ctx, row) {
    if (!/refund|return/i.test(`${row.type} ${row.description}`)) { ctx.stats.skipped++; return; }
    const fee = r2(Math.abs(num(row.fbaFees)) + Math.abs(num(row.otherFees)));
    if (!fee) { ctx.stats.skipped++; return; }
    const k = key('tx', row.date, row.orderId, row.sku, fee);
    const units = ctx.index().filter((u) => row.orderId && (u.orderId === row.orderId || u.refs?.amazonOrderId === row.orderId) && (!row.sku || lc(u.sku) === lc(row.sku)));
    if (!units.length) return miss(ctx, 'amazon_transactions', `No returned unit for order ${row.orderId || '(none)'}`, row);
    if (units.every((u) => (u.applied || []).includes(k))) { ctx.stats.skipped++; return; }
    const each = fee / units.length;
    for (let u of units) {
      if ((u.applied || []).includes(k)) continue;
      u = { ...u, costs: { ...u.costs, returnProcessingFee: r2(num(u.costs.returnProcessingFee) + each) } };
      stamp(u, k); ctx.save(u); ctx.stats.updated++;
    }
  },

  ebay_sales(ctx, row) {
    if (!row.sku && !row.ebayItemId) return miss(ctx, 'ebay_sales', 'No SKU or item number', row);
    const qty = int(row.quantity, 1);
    const k = key('eb', row.ebayOrderId || row.ebayItemId, row.sku);
    const need = qty - alreadyDone(ctx.index(), k);
    if (need <= 0) { ctx.stats.skipped++; return; }
    let picked = [];
    if (row.ebayItemId) picked = fifo(ctx.index().filter((u) => u.refs?.ebayItemId === row.ebayItemId && STAGE.ebaySale.includes(u.status) && !(u.applied || []).includes(k))).slice(0, need);
    if (picked.length < need && row.sku) picked = [...picked, ...pickUnits(ctx, { sku: row.sku, statuses: STAGE.ebaySale, k, n: need - picked.length, prefer: (u) => u.status === 'listed_ebay', filter: (u) => !picked.includes(u) })];
    const per = (v) => r2(num(v) / qty);
    for (let u of picked) {
      const sale = { ...emptySale('ebay'), date: row.saleDate || today(), orderRef: row.ebayOrderId || '', price: per(row.price), shippingCollected: per(row.shippingCollected) };
      sale.fees = { ...sale.fees, finalValueFee: per(Math.abs(num(row.finalValueFee))), adFee: per(Math.abs(num(row.adFee))), otherFee: per(Math.abs(num(row.otherFee))) };
      u = { ...u, sale, refs: { ...u.refs, ebayOrderId: row.ebayOrderId || u.refs.ebayOrderId, ebayItemId: row.ebayItemId || u.refs.ebayItemId } };
      if (num(row.postageCost)) u.costs = { ...u.costs, onwardShipping: r2(num(u.costs.onwardShipping) + per(Math.abs(num(row.postageCost)))) };
      u = transition(u, 'sold_ebay', { date: sale.date, note: `eBay order ${row.ebayOrderId || ''}`.trim() });
      stamp(u, k); ctx.save(u); ctx.stats.updated++;
    }
    if (picked.length < need) miss(ctx, 'ebay_sales', `${need - picked.length} of ${need} sale(s) for ${row.sku || row.ebayItemId} have no unit listed or at prep`, row);
  },

  amazon_used_sales(ctx, row) {
    if (/new/i.test(row.condition || '') && !/used/i.test(row.condition || '')) { ctx.stats.skipped++; return; }
    if (!row.sku) return miss(ctx, 'amazon_used_sales', 'No SKU', row);
    const qty = int(row.quantity, 1);
    const k = key('au', row.amazonOrderId, row.sku);
    const need = qty - alreadyDone(ctx.index(), k);
    if (need <= 0) { ctx.stats.skipped++; return; }
    const picked = pickUnits(ctx, { sku: row.sku, statuses: STAGE.usedSale, k, n: need, prefer: (u) => u.status === 'live_amazon_used' });
    const per = (v) => r2(Math.abs(num(v)) / qty);
    for (let u of picked) {
      const sale = { ...emptySale('amazon-used'), date: row.saleDate || today(), orderRef: row.amazonOrderId || '', price: r2(num(row.price) / qty), shippingCollected: r2(num(row.shippingCollected) / qty) };
      sale.fees = { ...sale.fees, finalValueFee: per(row.referralFee), fulfilmentFee: per(row.fbaFee), otherFee: per(row.otherFee) };
      u = transition({ ...u, sale }, 'sold_amazon_used', { date: sale.date, note: `Amazon order ${row.amazonOrderId || ''}`.trim() });
      stamp(u, k); ctx.save(u); ctx.stats.updated++;
    }
    if (picked.length < need) miss(ctx, 'amazon_used_sales', `${need - picked.length} of ${need} sale(s) for ${row.sku} have no unit live as Used`, row);
  },

  sku_costs(ctx, row) {
    if (!row.sku) return miss(ctx, 'sku_costs', 'No SKU', row);
    upsertSkuCost(ctx, { sku: row.sku, asin: row.asin, title: row.title, cogs: r2(num(row.cogs)), inboundPerUnit: r2(num(row.inboundPerUnit)) });
  },

  inbound_costs(ctx, row) {
    if (!row.sku) return miss(ctx, 'inbound_costs', 'No SKU', row);
    const units = int(row.units, 1);
    const each = r2(num(row.totalCost) / units);
    if (!each) { ctx.stats.skipped++; return; }
    const prev = costFor(ctx, row.sku);
    upsertSkuCost(ctx, { sku: row.sku, asin: prev?.asin, title: prev?.title, cogs: num(prev?.cogs), inboundPerUnit: each }, { inboundOnly: true });
  },

  prep_costs(ctx, row) {
    const amount = r2(Math.abs(num(row.amount)));
    if (!amount) { ctx.stats.skipped++; return; }
    const k = key('pc', row.date, row.lpn || row.reference, row.sku, row.costType, amount);
    const all = ctx.index();
    if (all.some((u) => (u.applied || []).includes(k))) { ctx.stats.skipped++; return; }
    let unit = null;
    if (row.lpn) unit = all.find((u) => u.lpn === row.lpn) || all.find((u) => u.lpn && u.lpn.split('#')[0] === row.lpn && !(u.applied || []).includes(k));
    if (!unit && row.reference) {
      const ref = lc(row.reference);
      unit = all.find((u) => [u.orderId, ...Object.values(u.refs || {})].some((v) => v && lc(v) === ref));
    }
    if (!unit && row.sku) unit = pickUnits(ctx, { sku: row.sku, statuses: STAGE.prep, k, n: 1 })[0] || null;
    if (!unit) return miss(ctx, 'prep_costs', `No unit for ${row.lpn || row.reference || row.sku || 'this line'}`, row);
    const bucket = bucketFor(row.costType);
    const u = { ...unit, costs: { ...unit.costs, [bucket]: r2(num(unit.costs[bucket]) + amount) } };
    stamp(u, k); ctx.save(u); ctx.stats.updated++;
  },
};

function upsertSkuCost(ctx, rec, { inboundOnly = false } = {}) {
  const prev = costFor(ctx, rec.sku);
  const next = { ...(prev || {}), ...rec, sku: rec.sku, updatedAt: new Date().toISOString() };
  if (inboundOnly && prev) next.cogs = prev.cogs;
  ctx.skuCostWrites.set(lc(rec.sku), next);
  // Back-fill units of this SKU that have no cost yet.
  for (const u of ctx.index()) {
    if (lc(u.sku) !== lc(rec.sku)) continue;
    const costs = { ...u.costs };
    let changed = false;
    if (!inboundOnly && !num(costs.cogs) && num(next.cogs)) { costs.cogs = r2(next.cogs); changed = true; }
    if (!num(costs.inboundOriginal) && num(next.inboundPerUnit)) { costs.inboundOriginal = r2(next.inboundPerUnit); changed = true; }
    if (changed) { ctx.save({ ...u, costs }); ctx.stats.updated++; }
  }
}

// SellerToolkit's Cost of Goods export is one row per purchase lot: average them per SKU first.
function stkCogsRows(rows, { includeVat = true } = {}) {
  const bySku = new Map();
  for (const r of rows) {
    if (!r.sku) continue;
    const qty = Math.max(1, int(r.purchasedQty, 1));
    const unit = num(includeVat ? (r.unitCostInc || r.unitCostNet) : (r.unitCostNet || r.unitCostInc));
    const inbound = num(includeVat ? (r.deliveryInc || r.deliveryNet) : (r.deliveryNet || r.deliveryInc)) + num(includeVat ? (r.prepInc || r.prepNet) : (r.prepNet || r.prepInc));
    const a = bySku.get(lc(r.sku)) || { sku: r.sku, asin: r.asin, title: r.title, qty: 0, cost: 0, inbound: 0, _raw: r._raw };
    a.qty += qty; a.cost += unit * qty; a.inbound += inbound * qty;
    bySku.set(lc(r.sku), a);
  }
  return [...bySku.values()].map((a) => ({ sku: a.sku, asin: a.asin, title: a.title, cogs: r2(a.cost / a.qty), inboundPerUnit: r2(a.inbound / a.qty), _raw: a._raw }));
}

// Single entry point.
export async function applyImport(parsed, { fileName = '', store, settings = {} } = {}) {
  const [units, skuCosts] = await Promise.all([store.allUnits(), store.allSkuCosts()]);
  const ctx = ctxFor(units, skuCosts);
  let formatId = parsed.formatId;
  let rows = parsed.rows;
  if (formatId === 'stk_cogs') { rows = stkCogsRows(rows, { includeVat: settings.costsIncludeVat !== false }); formatId = 'sku_costs'; }
  const handler = handlers[formatId];
  if (!handler) throw new Error(`No importer for ${parsed.formatId}`);
  // Every date field becomes YYYY-MM-DD (ISO timestamps, dd/mm/yyyy, mm/dd/yyyy, "25 April 2026", "20-Aug-26"),
  // with day-first vs month-first worked out per column.
  const dateFields = rows.length ? Object.keys(rows[0]).filter((f) => f !== '_raw' && (/date$/i.test(f) || f === 'date')) : [];
  const orders = Object.fromEntries(dateFields.map((f) => [f, detectDateOrder(rows.map((r) => r[f]))]));
  for (const raw of rows) {
    ctx.stats.rows++;
    const row = { ...raw };
    for (const f of dateFields) row[f] = parseDate(row[f], orders[f]);
    handler(ctx, row);
  }
  ctx.stats.skuCosts = ctx.skuCostWrites.size;
  const touched = [...ctx.touched.values()];
  const log = { id: `imp-${Date.now()}`, at: new Date().toISOString(), formatId: parsed.formatId, formatLabel: parsed.format?.label || parsed.formatId, fileName, stats: { ...ctx.stats } };
  const writes = { units: touched, skuCosts: [...ctx.skuCostWrites.values()], unmatched: ctx.misses, log };
  if (store.commit) await store.commit(writes); // one transaction: all or nothing
  else {
    await store.putUnits(writes.units);
    if (writes.skuCosts.length) await store.putSkuCosts(writes.skuCosts);
    if (writes.unmatched.length) await store.putUnmatched(writes.unmatched);
    await store.putImportLog(log);
  }
  return { ...ctx.stats, log };
}

export { handlers, stkCogsRows, STATUS };
