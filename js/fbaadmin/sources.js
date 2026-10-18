// FBA Admin — which order, expense and purchase data counts: SellerToolkit, or SellerFuse from a cut-over date. Pure.
//
// Both sources can be imported side by side. Settings → "Sales data comes from":
//   SellerToolkit: SellerFuse rows are ignored.
//   SellerFuse:    for each kind of data (orders, expenses, purchases) that you've imported from SellerFuse,
//                  SellerToolkit counts before the cut-over date and SellerFuse from it, so nothing is counted twice.
//                  A kind you haven't imported from SellerFuse yet keeps using SellerToolkit for every date.
//                  Blank cut-over date = the date of your first SellerFuse Amazon order.
//   SellerFuse's eBay orders replace the eBay tracker's sales from the cut-over date in the Amazon + eBay view.

export const SOURCE_LABEL = { sellertoolkit: 'SellerToolkit', sellerfuse: 'SellerFuse' };
const isSf = (x) => x.source === 'sellerfuse';
const firstDate = (rows, f) => rows.reduce((m, x) => (f(x) && (!m || f(x) < m) ? f(x) : m), '');
const lastDate = (rows, f) => rows.reduce((m, x) => (f(x) && f(x) > m ? f(x) : m), '');

export function applySources({ orders = [], stkExpenses = [], stock = [], ebaySales = [] }, s = {}) {
  const mode = s.salesSource === 'sellerfuse' ? 'sellerfuse' : 'sellertoolkit';
  const amazonAll = orders.filter((o) => (o.channel || 'amazon') !== 'ebay');
  const sfAmazon = amazonAll.filter(isSf);
  const sfEbay = orders.filter((o) => isSf(o) && o.channel === 'ebay');
  const info = {
    mode, stkOrders: amazonAll.length - sfAmazon.length, sfOrders: sfAmazon.length, sfEbayOrders: sfEbay.length,
    stkLast: lastDate(amazonAll.filter((o) => !isSf(o)), (o) => o.date), sfFirst: firstDate(sfAmazon, (o) => o.date),
    sfExpenses: stkExpenses.filter(isSf).length, sfStock: stock.filter(isSf).length,
  };
  if (mode === 'sellertoolkit') {
    return {
      orders: amazonAll.filter((o) => !isSf(o)), stkExpenses: stkExpenses.filter((e) => !isSf(e)), stock: stock.filter((x) => !isSf(x)), ebaySales,
      label: 'SellerToolkit', expensesLabel: 'SellerToolkit expenses', cutover: '', info,
    };
  }
  const cut = s.sfCutover || info.sfFirst || firstDate(sfEbay, (o) => o.date) || '';
  info.cutover = cut; info.cutoverAuto = !s.sfCutover;
  // per kind: only switch over once there's SellerFuse data of that kind
  const pick = (rows, dateOf) => {
    if (!cut || !rows.some(isSf)) return rows.filter((x) => !isSf(x));
    return rows.filter((x) => (isSf(x) ? (dateOf(x) || '') >= cut : (dateOf(x) || '') < cut));
  };
  const ordersOut = pick(amazonAll, (o) => o.date);
  const expOut = pick(stkExpenses, (e) => e.date);
  const stockOut = pick(stock, (x) => x.datePurchased);
  // eBay: SellerFuse's eBay orders from the cut-over date, the eBay tracker before it
  let ebayOut = ebaySales;
  const sfEbayIn = cut ? sfEbay.filter((o) => o.date >= cut) : [];
  if (sfEbayIn.length) {
    const cutMs = Date.parse(`${cut}T00:00:00Z`);
    ebayOut = [...ebaySales.filter((l) => (l.date || 0) < cutMs), ...sfEbayLines(sfEbayIn)];
  }
  const mixed = cut && ordersOut.some((o) => !isSf(o)) && ordersOut.some(isSf);
  return {
    orders: ordersOut, stkExpenses: expOut, stock: stockOut, ebaySales: ebayOut,
    label: mixed ? 'SellerToolkit / SellerFuse' : ordersOut.some(isSf) || !ordersOut.length ? 'SellerFuse' : 'SellerToolkit',
    expensesLabel: expOut.some(isSf) ? (expOut.some((e) => !isSf(e)) ? 'SellerToolkit / SellerFuse expenses' : 'SellerFuse expenses') : 'SellerToolkit expenses',
    cutover: cut, info,
  };
}

// SellerFuse eBay orders as eBay-tracker lines (what the P&L's eBay figures and the VAT gauge read).
export function sfEbayLines(orders) {
  const out = [];
  const ms = (d) => Date.parse(`${d}T12:00:00Z`);
  for (const o of orders) {
    const cut = (o.fees || 0) + (o.vat || 0);
    out.push({ key: `sf:${o.id}`, kind: 'sale', date: ms(o.date), qty: o.qtyShipped || 1, gross: o.sale, fees: -cut, net: Math.round((o.sale - cut - (o.shippingCost || 0)) * 100) / 100, cog: o.cog || 0, productKey: `sf:${o.sku}`, source: 'sellerfuse' });
    const refund = o.refund || (o.qtyRefunded > 0 ? o.sale * Math.min(1, o.qtyRefunded / Math.max(1, o.qtyShipped)) : 0);
    if (refund > 0) out.push({ key: `sf:${o.id}:r`, kind: 'refund', date: ms(o.refundDate || o.date), net: -Math.round(refund * 100) / 100, source: 'sellerfuse' });
  }
  return out;
}
