// FBA Admin — stock check per SKU. Pure.
//   purchased   ← SellerToolkit Cost of Goods lots
//   received, customer returns, removals, lost/damaged/disposed, found  ← inventory ledger events (within its window)
//   at Amazon now (sellable / unfulfillable, by warehouse)              ← inventory ledger, latest day
//   sold, refunded                                                      ← SellerToolkit orders
//   listing price / status                                              ← All Listings report

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export function ledgerWindow(ledger) {
  if (!ledger.length) return null;
  let from = ledger[0].date; let to = ledger[0].date;
  for (const l of ledger) { if (l.date < from) from = l.date; if (l.date > to) to = l.date; }
  return { from, to };
}

// Balances on the latest day of the ledger, by SKU, split sellable / unfulfillable, with locations.
export function amazonNow(ledger) {
  const win = ledgerWindow(ledger);
  const bySku = {};
  if (!win) return { asOf: null, bySku };
  for (const l of ledger) {
    if (l.date !== win.to || !l.ending) continue;
    const a = bySku[l.sku] ||= { sellable: 0, unfulfillable: 0, places: [] };
    if (l.disposition === 'SELLABLE') a.sellable += l.ending; else a.unfulfillable += l.ending;
    a.places.push(`${l.ending} ${l.disposition.toLowerCase().replace(/_/g, ' ')} at ${l.location}`);
  }
  return { asOf: win.to, bySku };
}

export function stockReport({ stock = [], ledger = [], orders = [], listings = [] }) {
  const win = ledgerWindow(ledger);
  const now = amazonNow(ledger);
  const skus = new Map();
  const row = (sku) => {
    if (!skus.has(sku)) skus.set(sku, { sku, asin: '', title: '', purchased: 0, purchasedInWindow: 0, purchaseCost: 0, lots: 0, firstPurchase: '', received: 0, customerReturns: 0, removed: 0, lostDamaged: 0, found: 0, sold: 0, refunded: 0, sellable: 0, unfulfillable: 0, places: [], listingStatus: '', price: null, flags: [] });
    return skus.get(sku);
  };
  for (const s of stock) {
    const x = row(s.sku);
    x.purchased += s.quantity; x.purchaseCost += s.totalCost; x.lots++;
    if (win && s.datePurchased && s.datePurchased >= win.from) x.purchasedInWindow += s.quantity;
    if (!x.firstPurchase || (s.datePurchased && s.datePurchased < x.firstPurchase)) x.firstPurchase = s.datePurchased;
    x.title ||= s.productName; x.asin ||= s.asin;
  }
  for (const l of ledger) {
    const x = row(l.sku);
    x.received += l.receipts; x.customerReturns += l.customerReturns; x.removed += -l.vendorReturns;
    x.lostDamaged += -(l.lost + l.damaged + l.disposed); x.found += l.found;
    x.title ||= l.title; x.asin ||= l.asin;
  }
  for (const o of orders) {
    const x = row(o.sku);
    x.sold += o.qtyShipped; x.refunded += o.qtyRefunded;
    x.title ||= o.title; x.asin ||= o.asin;
  }
  for (const li of listings) {
    const x = row(li.sku);
    x.listingStatus = li.status; x.price = li.price; x.title ||= li.title; x.asin ||= li.asin;
  }
  for (const [sku, a] of Object.entries(now.bySku)) {
    const x = row(sku);
    x.sellable = a.sellable; x.unfulfillable = a.unfulfillable; x.places = a.places;
  }
  const out = [...skus.values()].map((x) => {
    const avgCost = x.purchased ? x.purchaseCost / x.purchased : null;
    const value = avgCost === null ? null : r2(x.sellable * avgCost);
    const flags = [];
    if (x.unfulfillable) flags.push({ kind: 'unfulfillable', text: `${x.unfulfillable} unfulfillable at Amazon. Create a removal (or Grade & Resell) before storage or disposal fees` });
    if (x.sellable && /inactive/i.test(x.listingStatus)) flags.push({ kind: 'inactive', text: `${x.sellable} sellable but the listing is inactive` });
    // Grade & Resell SKUs (amzn.gr.…) are created by Amazon from returned units, never "received" from you.
    if (win && !/^amzn\.gr\./i.test(x.sku) && x.firstPurchase && x.firstPurchase >= win.from && x.purchasedInWindow > x.received) flags.push({ kind: 'received', text: `${x.purchasedInWindow - x.received} of ${x.purchasedInWindow} bought not received yet` });
    if (x.lostDamaged > 0) flags.push({ kind: 'lost', text: `${x.lostDamaged} lost / damaged / disposed by Amazon. Check for a reimbursement` });
    if (!x.purchased && x.sold && !/^amzn\.gr\./i.test(x.sku)) flags.push({ kind: 'nocost', text: 'Sold but no purchase recorded in SellerToolkit' });
    return { ...x, purchaseCost: r2(x.purchaseCost), avgCost: avgCost === null ? null : r2(avgCost), value, gradeResell: /^amzn\.gr\./i.test(x.sku), flags };
  }).sort((a, b) => (b.flags.length - a.flags.length) || (b.sellable - a.sellable) || a.sku.localeCompare(b.sku));

  const totals = out.reduce((t, x) => ({
    sellable: t.sellable + x.sellable, unfulfillable: t.unfulfillable + x.unfulfillable, value: t.value + (x.value || 0),
    unfulfillableValue: t.unfulfillableValue + (x.avgCost || 0) * x.unfulfillable, flagged: t.flagged + (x.flags.length ? 1 : 0),
  }), { sellable: 0, unfulfillable: 0, value: 0, unfulfillableValue: 0, flagged: 0 });
  totals.value = r2(totals.value); totals.unfulfillableValue = r2(totals.unfulfillableValue);
  return { window: win, asOf: now.asOf, rows: out, totals };
}

// Amazon's own monthly ordered sales vs SellerToolkit revenue, for the months in range.
export function salesCrossCheck(salesDash, orders, from, to) {
  const months = Object.entries(salesDash?.months || {}).filter(([m]) => `${m}-01` <= to && `${m}-31` >= from).sort();
  const stkByMonth = {};
  for (const o of orders) { const m = (o.date || '').slice(0, 7); stkByMonth[m] = (stkByMonth[m] || 0) + o.sale; }
  return months.map(([m, v]) => ({ month: m, amazon: v.sales, amazonUnits: v.units, stk: r2(stkByMonth[m] || 0), diff: r2(v.sales - (stkByMonth[m] || 0)) }));
}
