// FBA Returns tracker — return units from the refunds in your order data (SellerToolkit or SellerFuse), and the
// outbound FBA fee each return costs. Pure: takes arrays, returns the units to write.
//
//   - Each refunded item (qty refunded on an Amazon order line) gets a unit, unless one already exists for that
//     order and SKU (from Amazon's returns report, or an earlier run). So it never duplicates, whichever comes first.
//   - When Amazon's returns report arrives, it fills in the unit made here (LPN, condition, reason): importer.js.
//   - Items your order data says went back into sellable stock are marked "Auto-relisted by Amazon".
//   - Every returned unit gets the FBA fulfilment fee from its order (Amazon keeps it on a return), if not set.
// Refunds before `since` are ignored, so switching this on doesn't flood the tracker with old history.
import { emptyUnit, transition, num, r2 } from './model.js';

const lc = (s) => String(s ?? '').trim().toLowerCase();
const k2 = (orderId, sku) => `${lc(orderId)}|${lc(sku)}`;

export function refundUnits(units, orders, skuCosts, { since = '' } = {}) {
  const costs = new Map(skuCosts.map((c) => [lc(c.sku), c]));
  const byOrder = new Map();
  for (const u of units) {
    const id = u.orderId || u.refs?.amazonOrderId;
    if (!id) continue;
    const k = k2(id, u.sku);
    if (!byOrder.has(k)) byOrder.set(k, []);
    byOrder.get(k).push(u);
  }
  const writes = new Map();
  const stats = { created: 0, relisted: 0, feesAdded: 0 };
  // the same order line can appear more than once (a refund row and the sale row): use the largest refund per order + SKU
  const lines = new Map();
  for (const o of orders) {
    if ((o.channel || 'amazon') === 'ebay' || !o.orderId || !o.sku) continue;
    const k = k2(o.orderId, o.sku);
    const cur = lines.get(k);
    if (!cur) { lines.set(k, o); continue; }
    const main = (o.qtyRefunded || 0) > (cur.qtyRefunded || 0) ? o : cur;
    lines.set(k, { ...main, qtyRefunded: Math.max(cur.qtyRefunded || 0, o.qtyRefunded || 0), qtyShipped: Math.max(cur.qtyShipped || 0, o.qtyShipped || 0), feesFba: cur.feesFba || o.feesFba });
  }
  for (const [k, o] of lines) {
    const shipped = Math.max(1, Number(o.qtyShipped) || 1);
    const feeEach = r2(Math.abs(num(o.feesFba)) / shipped);
    const have = byOrder.get(k) || [];
    // the outbound fee on units already tracked for this order
    for (const u of have) {
      if (feeEach && !num(u.costs?.outboundFee)) { writes.set(u.id, { ...(writes.get(u.id) || u), costs: { ...u.costs, outboundFee: feeEach }, updatedAt: new Date().toISOString() }); stats.feesAdded++; }
    }
    const refunded = Math.max(0, Number(o.qtyRefunded) || 0);
    const day = o.refundDate || o.date;
    if (!refunded || (since && day < since)) continue;
    const need = refunded - have.length;
    if (need <= 0) continue;
    const c = costs.get(lc(o.sku));
    const cogs = num(c?.cogs) || r2(Math.abs(num(o.cog)) / shipped);
    let backToStock = Math.max(0, Math.min(need, (Number(o.toInventory) || 0) - have.filter((u) => u.status === 'relisted_by_amazon').length));
    for (let i = 0; i < need; i++) {
      let u = emptyUnit({
        returnDate: day, statusDate: day, orderId: o.orderId, sku: o.sku, asin: o.asin || '', title: o.title || '',
        reason: [o.refundReason, o.customerComment].filter(Boolean).join(' — '), refs: { amazonOrderId: o.orderId },
        disposition: backToStock > 0 ? 'SELLABLE' : (Number(o.damaged) > i ? 'CUSTOMER_DAMAGED' : 'UNKNOWN'),
        costs: { cogs: r2(cogs), inboundOriginal: r2(num(c?.inboundPerUnit)), outboundFee: feeEach },
        // the same id on every device, so two devices making this unit sync into one
        id: `rf:${lc(o.orderId)}|${lc(o.sku)}|${have.length + i + 1}`,
        fromRefund: true, dedupeKey: `rf:${lc(o.orderId)}|${lc(o.sku)}|${have.length + i + 1}`,
        notes: 'Created from a refund in your order data. Amazon\'s returns report fills in the LPN and condition when you import it.',
      });
      if (backToStock > 0) { u = transition(u, 'relisted_by_amazon', { date: day, note: 'Returned to sellable stock (from your order data)' }); backToStock--; stats.relisted++; }
      writes.set(u.id, u); stats.created++;
    }
  }
  return { units: [...writes.values()], stats };
}

// Where to start from the first time: the earliest return already tracked, or 60 days ago.
export function defaultSince(units, today) {
  const first = units.filter((u) => !u.fromRefund && u.returnDate).reduce((m, u) => (!m || u.returnDate < m ? u.returnDate : m), '');
  return first || new Date(Date.parse(`${today}T00:00:00Z`) - 60 * 864e5).toISOString().slice(0, 10);
}
