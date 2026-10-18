// FBA Admin — stock value (COG) tracker. Pure.
// Stock value = units bought (SellerToolkit Cost of Goods lots) − units sold (SellerToolkit orders), at each SKU's
// average cost. "At Amazon" = sellable units in the inventory ledger at that date, at the same average cost.

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const D = (s) => new Date(`${s}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => iso(new Date(D(s).getTime() + n * 864e5));
const monthEnd = (m) => { const [y, mo] = m.split('-').map(Number); return iso(new Date(Date.UTC(y, mo, 0))); };
const nextMonth = (m) => { const [y, mo] = m.split('-').map(Number); return iso(new Date(Date.UTC(y, mo, 1))).slice(0, 7); };
const monthsBetween = (a, b) => { const [y1, m1] = a.split('-').map(Number); const [y2, m2] = b.split('-').map(Number); return (y2 - y1) * 12 + (m2 - m1); };

export function avgCosts(stock) {
  const by = {};
  for (const s of stock) { const a = by[s.sku] ||= { qty: 0, cost: 0 }; a.qty += s.quantity; a.cost += s.totalCost; }
  return Object.fromEntries(Object.entries(by).map(([k, a]) => [k, a.qty ? a.cost / a.qty : 0]));
}

// Stock at cost on a date, kept simple and consistent: everything bought (Cost of Goods lots) less the cost of
// everything sold (SellerToolkit COG), never below zero. So each period's change = bought − sold.
export function valueOn(date, { stock, orders }) {
  let v = 0; let units = 0;
  for (const s of stock) if (s.datePurchased && s.datePurchased <= date) { v += s.totalCost; units += s.quantity; }
  for (const o of orders) if (o.date && o.date <= date) { v -= o.cog; units -= o.qtyNet; }
  return { value: r2(Math.max(0, v)), units: Math.max(0, units) };
}

// Sellable at Amazon on a date (the ledger's last day on or before it), at average cost.
export function amazonValueOn(date, { ledger, avg }) {
  let last = '';
  for (const l of ledger) if (l.date <= date && l.date > last) last = l.date;
  if (!last) return null;
  let value = 0; let units = 0;
  for (const l of ledger) if (l.date === last && l.disposition === 'SELLABLE' && l.ending > 0) { value += l.ending * (avg[l.sku] || 0); units += l.ending; }
  return { value: r2(value), units, asOf: last };
}

// Month by month: stock value at the month end, COG bought, COG sold, sales, profit.
export function history({ stock = [], orders = [], ledger = [] }, { today, months = 12 } = {}) {
  const avg = avgCosts(stock);
  const firstData = [...stock.map((s) => s.datePurchased), ...orders.map((o) => o.date)].filter(Boolean).sort()[0];
  if (!firstData) return { rows: [], avg };
  let m = firstData.slice(0, 7);
  const lastM = today.slice(0, 7);
  if (monthsBetween(m, lastM) >= months) { const d = D(`${lastM}-01`); d.setUTCMonth(d.getUTCMonth() - (months - 1)); m = iso(d).slice(0, 7); }
  const ledgerFrom = ledger.reduce((a, l) => (!a || l.date < a ? l.date : a), '');
  const rows = [];
  for (; m <= lastM; m = nextMonth(m)) {
    const end = m === lastM ? today : monthEnd(m);
    const from = `${m}-01`;
    const v = valueOn(end, { stock, orders, avg });
    const amz = ledgerFrom && end >= ledgerFrom ? amazonValueOn(end, { ledger, avg }) : null;
    const lots = stock.filter((s) => s.datePurchased >= from && s.datePurchased <= end);
    const ords = orders.filter((o) => o.date >= from && o.date <= end);
    rows.push({
      month: m, end, partial: m === lastM, value: v.value, units: v.units, atAmazon: amz ? amz.value : null,
      bought: r2(lots.reduce((a, s) => a + s.totalCost, 0)), boughtUnits: lots.reduce((a, s) => a + s.quantity, 0),
      sold: r2(ords.reduce((a, o) => a + o.cog, 0)), soldUnits: ords.reduce((a, o) => a + o.qtyNet, 0),
      sales: r2(ords.reduce((a, o) => a + o.sale, 0)), profit: r2(ords.reduce((a, o) => a + o.profit, 0)),
    });
  }
  return { rows, avg };
}

// The last 90 days: the rates everything else is based on.
export function rates({ stock = [], orders = [] }, { today, days = 90 } = {}) {
  const from = addDays(today, -days + 1);
  const o = orders.filter((x) => x.date >= from && x.date <= today);
  const per = 30.44 / days;
  const cogsM = o.reduce((a, x) => a + x.cog, 0) * per;
  const salesM = o.reduce((a, x) => a + x.sale, 0) * per;
  const profitM = o.reduce((a, x) => a + x.profit, 0) * per;
  const boughtM = stock.filter((s) => s.datePurchased >= from && s.datePurchased <= today).reduce((a, s) => a + s.totalCost, 0) * per;
  const v = valueOn(today, { stock, orders });
  const sellThrough = v.value ? cogsM / v.value : null; // share of stock (at cost) sold per month
  return {
    days, value: v.value, units: v.units, cogsPerMonth: r2(cogsM), salesPerMonth: r2(salesM), profitPerMonth: r2(profitM), boughtPerMonth: r2(boughtM),
    sellThrough, turnoverPerYear: sellThrough === null ? null : sellThrough * 12, daysOfStock: cogsM ? Math.round(v.value / (cogsM / 30.44)) : null,
    salesPerPound: v.value ? salesM / v.value : null, profitPerPound: v.value ? profitM / v.value : null,
    salesPerCogs: cogsM ? salesM / cogsM : null, profitPerCogs: cogsM ? profitM / cogsM : null,
  };
}

// Per product: what £1 of stock earns. profitPerPound = monthly profit ÷ stock value now.
export function productReturns({ stock = [], orders = [] }, { today, days = 90 } = {}) {
  const from = addDays(today, -days + 1);
  const avg = avgCosts(stock);
  const per = 30.44 / days;
  const qty = {}; const title = {}; const asin = {};
  for (const s of stock) { qty[s.sku] = (qty[s.sku] || 0) + s.quantity; title[s.sku] ||= s.productName; asin[s.sku] ||= s.asin; }
  const recent = {};
  for (const o of orders) {
    qty[o.sku] = (qty[o.sku] || 0) - o.qtyNet; title[o.sku] ||= o.title; asin[o.sku] ||= o.asin;
    if (o.date >= from && o.date <= today) { const r = recent[o.sku] ||= { units: 0, sales: 0, profit: 0, cogs: 0 }; r.units += o.qtyNet; r.sales += o.sale; r.profit += o.profit; r.cogs += o.cog; }
  }
  const rows = Object.keys({ ...qty, ...recent }).filter((sku) => !/^amzn\.gr\./i.test(sku)).map((sku) => {
    const r = recent[sku] || { units: 0, sales: 0, profit: 0, cogs: 0 };
    const units = Math.max(0, qty[sku] || 0); const value = r2(units * (avg[sku] || 0));
    const profitM = r.profit * per; const unitsM = r.units * per;
    const daysOfStock = unitsM > 0 ? Math.round(units / (unitsM / 30.44)) : null;
    const roiOnCost = r.cogs ? r.profit / r.cogs : null; // profit per £1 of stock sold
    let action = '';
    if (r.units > 0 && units === 0) action = roiOnCost > 0 ? 'Sold out: restock' : 'Sold out';
    else if (daysOfStock !== null && daysOfStock < 30 && roiOnCost > 0.15) action = 'Buy more';
    else if (units > 0 && (daysOfStock === null || daysOfStock > 120)) action = 'Slow: hold off';
    else if (roiOnCost !== null && roiOnCost <= 0) action = 'Losing money';
    return {
      sku, asin: asin[sku] || '', title: title[sku] || '', units, value, avgCost: avg[sku] ? r2(avg[sku]) : null,
      soldUnits: r.units, sales: r2(r.sales), profit: r2(r.profit), profitPerMonth: r2(profitM), roiOnCost,
      profitPerPound: value ? profitM / value : null, daysOfStock, action,
    };
  }).filter((x) => x.units || x.soldUnits);
  return rows.sort((a, b) => (b.roiOnCost ?? -9) * Math.min(1, b.soldUnits / 3) - (a.roiOnCost ?? -9) * Math.min(1, a.soldUnits / 3));
}

// Plan to reach a stock value by a date. Each month a share of stock sells (today's sell-through rate),
// and sales grow with stock at today's sales-per-£ — an assumption that holds while there's demand.
// B = monthly buying needed: V_n = V0(1−s)^n + B(1−(1−s)^n)/s = target.
export function plan({ value: V0, sellThrough, salesPerCogs, profitPerCogs, boughtPerMonth }, { target, by, today }) {
  const n = Math.max(1, monthsBetween(today.slice(0, 7), String(by).slice(0, 7)));
  const s = Math.min(0.95, Math.max(0, sellThrough || 0));
  const k = (1 - s) ** n;
  const B = s ? (target - V0 * k) * s / (1 - k) : (target - V0) / n;
  const rows = []; let V = V0;
  const start = D(`${today.slice(0, 7)}-01`);
  for (let i = 1; i <= n; i++) {
    const sold = V * s; const nv = Math.max(0, V - sold + Math.max(0, B));
    const d = new Date(start); d.setUTCMonth(d.getUTCMonth() + i);
    rows.push({ month: iso(d).slice(0, 7), buy: r2(Math.max(0, B)), cogsSold: r2(sold), sales: r2(sold * (salesPerCogs || 0)), profit: r2(sold * (profitPerCogs || 0)), value: r2(nv) });
    V = nv;
  }
  const now = { sales: r2(V0 * s * (salesPerCogs || 0)), profit: r2(V0 * s * (profitPerCogs || 0)) };
  const end = rows.at(-1);
  return {
    months: n, buyPerMonth: r2(Math.max(0, B)), extraBuyPerMonth: r2(Math.max(0, B) - (boughtPerMonth || 0)), rows,
    salesNow: now.sales, salesAtTarget: end ? r2(target * s * (salesPerCogs || 0)) : now.sales, profitNow: now.profit, profitAtTarget: end ? r2(target * s * (profitPerCogs || 0)) : now.profit,
    reachable: B >= 0, alreadyThere: target <= V0, assumption: s ? `your stock keeps selling through in about ${Math.round(30.44 / Math.max(s, (sellThrough || 0)))} days, as it has over the last 90, and each £1 of stock sold brings £${(salesPerCogs || 0).toFixed(2)} of sales` : 'no recent sales to base a selling rate on',
  };
}

// Month-by-month path for a fixed monthly buying amount (used for the cash check).
export function pathFor(B, { value: V0, sellThrough }, months, today) {
  const s = Math.min(0.95, Math.max(0, sellThrough || 0)); let V = V0; const rows = [];
  const start = D(`${today.slice(0, 7)}-01`);
  for (let i = 1; i <= months; i++) { const sold = V * s; V = Math.max(0, V - sold + B); const d = new Date(start); d.setUTCMonth(d.getUTCMonth() + i); rows.push({ month: iso(d).slice(0, 7), cogsSold: sold, value: V }); }
  return rows;
}

// Cash events for buying B a month instead of your usual rate: weekly buying, and the change in payouts as sales follow stock.
// Payout ≈ COGS sold + profit (revenue less Amazon's fees).
export function cashEvents(B, r, { today, days = 90 }) {
  const months = Math.max(1, Math.ceil(days / 30.44));
  const path = pathFor(B, r, months, today);
  const basePayoutM = r.cogsPerMonth + r.profitPerMonth;
  const ev = [];
  for (let d = addDays(today, 7), w = 0; d <= addDays(today, days); d = addDays(d, 7), w++) {
    const mi = Math.min(path.length - 1, Math.floor((w * 7) / 30.44));
    const prevV = mi ? path[mi - 1].value : r.value;
    const payoutM = prevV * Math.min(0.95, Math.max(0, r.sellThrough || 0)) * (1 + (r.profitPerCogs || 0));
    ev.push({ date: d, label: 'Stock buying (plan)', amount: -r2(B * 12 / 52), kind: 'stock', note: 'stock value plan' });
    const extra = r2((payoutM - basePayoutM) * 12 / 52);
    if (Math.abs(extra) >= 0.01) ev.push({ date: d, label: 'Extra payouts from more stock', amount: extra, kind: 'payout', note: 'estimate' });
  }
  return ev;
}

// Previous periods, simply: for each month, quarter or financial year — stock bought, stock sold (COG),
// stock value at the end, and the change. fyStart 'MM-DD'.
export function periods({ stock = [], orders = [] }, { today, by = 'month', fyStart = '02-28', count } = {}) {
  const avg = avgCosts(stock);
  const ranges = [];
  const [ty, tm] = today.split('-').map(Number);
  if (by === 'year') {
    const [fm, fd] = fyStart.split('-').map(Number);
    let sy = today >= `${ty}-${String(fm).padStart(2, '0')}-${String(fd).padStart(2, '0')}` ? ty : ty - 1;
    for (let i = 0; i < (count || 3); i++, sy--) {
      const from = iso(new Date(Date.UTC(sy, fm - 1, fd))); const to = iso(new Date(Date.UTC(sy + 1, fm - 1, fd - 1)));
      ranges.push({ key: `FY${sy}`, label: `FY ${sy}/${String(sy + 1).slice(2)}`, from, to });
    }
  } else if (by === 'quarter') {
    let q = Math.floor((tm - 1) / 3); let y = ty;
    for (let i = 0; i < (count || 8); i++) {
      const from = iso(new Date(Date.UTC(y, q * 3, 1))); const to = iso(new Date(Date.UTC(y, q * 3 + 3, 0)));
      ranges.push({ key: `${y}-Q${q + 1}`, label: `Q${q + 1} ${y}`, from, to });
      if (--q < 0) { q = 3; y--; }
    }
  } else {
    for (let i = 0; i < (count || 12); i++) {
      const d = new Date(Date.UTC(ty, tm - 1 - i, 1)); const m = iso(d).slice(0, 7);
      ranges.push({ key: m, label: d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }), from: `${m}-01`, to: monthEnd(m) });
    }
  }
  const first = [...stock.map((s) => s.datePurchased), ...orders.map((o) => o.date)].filter(Boolean).sort()[0] || today;
  return ranges.filter((r) => r.to >= first.slice(0, 7) + '-01').map((r) => {
    const end = r.to > today ? today : r.to;
    const startVal = valueOn(addDays(r.from, -1), { stock, orders, avg }).value;
    const endVal = valueOn(end, { stock, orders, avg }).value;
    const bought = stock.filter((s) => s.datePurchased >= r.from && s.datePurchased <= end).reduce((a, s) => a + s.totalCost, 0);
    const sold = orders.filter((o) => o.date >= r.from && o.date <= end).reduce((a, o) => a + o.cog, 0);
    return { ...r, partial: r.to > today, bought: r2(bought), sold: r2(sold), value: endVal, change: r2(endVal - startVal) };
  });
}
