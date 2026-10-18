// FBA Admin — eBay P&L (for the combined view), director's loan statement, corporation tax estimate,
// and the year-end pack. Pure.

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const toMs = (d, end = false) => Date.parse(`${d}T${end ? '23:59:59' : '00:00:00'}`);

// Same maths as the eBay profit tracker: net payout − COGS − prep/postage per unit.
export function ebayPnl(sales, products, from, to) {
  const a = toMs(from); const b = toMs(to, true);
  const prod = products instanceof Map ? products : new Map(products.map((p) => [p.key, p]));
  const t = { lines: 0, units: 0, revenue: 0, fees: 0, refunds: 0, postage: 0, otherFees: 0, other: 0, net: 0, cogs: 0, otherCost: 0, missingCogs: 0 };
  for (const l of sales) {
    if (!l.date || l.date < a || l.date > b) continue;
    t.lines++; t.net += l.net || 0;
    if (l.kind === 'sale') {
      t.units += l.qty || 0; t.revenue += l.gross || 0; t.fees += l.fees || 0;
      // SellerFuse eBay lines carry their own COGS; the eBay tracker's come from its products list
      if (Number.isFinite(l.cog)) { t.cogs += l.cog; if (!l.cog) t.missingCogs++; continue; }
      const p = prod.get(l.productKey);
      const has = p && p.cogs !== null && p.cogs !== undefined && p.cogs !== '';
      t.cogs += (has ? Number(p.cogs) : 0) * (l.qty || 0); t.otherCost += (p?.otherCost ? Number(p.otherCost) : 0) * (l.qty || 0);
      if (!has) t.missingCogs++;
    } else if (l.kind === 'refund') t.refunds += l.net || 0;
    else if (l.kind === 'postage') t.postage += l.net || 0;
    else if (l.kind === 'fee') t.otherFees += l.net || 0;
    else t.other += l.net || 0;
  }
  for (const k of Object.keys(t)) if (typeof t[k] === 'number' && k !== 'lines' && k !== 'units' && k !== 'missingCogs') t[k] = r2(t[k]);
  t.profit = r2(t.net - t.cogs - t.otherCost);
  return t;
}

// Director's loan: positive balance = the company owes you; negative = you owe the company (overdrawn).
// Money out in the Director Loan category (repayments to you, or the company paying personal costs such as
// the Klarna plans) lowers what the company owes you; money in (you lending to the company) raises it.
export function dlaStatement(txns, { opening = 0, from, to }) {
  const moves = txns.filter((t) => t.category === 'Director Loan' && t.date >= from && t.date <= to).sort((a, b) => a.date.localeCompare(b.date) || (Number(a.balance) || 0) - (Number(b.balance) || 0));
  let bal = r2(opening);
  const rows = moves.map((t) => { bal = r2(bal + t.amount); return { date: t.date, description: t.description, amount: t.amount, balance: bal, id: t.id, entryId: t.entryId, source: t.source, note: t.note }; });
  const lowest = rows.reduce((m, r) => Math.min(m, r.balance), r2(opening));
  return { opening: r2(opening), rows, closing: bal, paidOut: r2(-moves.filter((t) => t.amount < 0).reduce((a, t) => a + t.amount, 0)), paidIn: r2(moves.filter((t) => t.amount > 0).reduce((a, t) => a + t.amount, 0)), overdrawn: bal < 0, everOverdrawn: lowest < 0, lowest };
}

// UK corporation tax for a 12-month period (2026/27 rates): 19% up to £50k, 25% from £250k, marginal relief between.
// Limits are shared between associated companies and pro-rated for short periods: an estimate, not advice.
export function corporationTax(profit, { lower = 50000, upper = 250000, small = 0.19, main = 0.25, fraction = 3 / 200, associated = 0 } = {}) {
  const div = 1 + (Number(associated) || 0);
  const lo = lower / div; const hi = upper / div;
  if (profit <= 0) return { tax: 0, rate: 0, band: 'No profit' };
  if (profit <= lo) return { tax: r2(profit * small), rate: small, band: 'Small profits rate (19%)' };
  if (profit >= hi) return { tax: r2(profit * main), rate: main, band: 'Main rate (25%)' };
  const tax = profit * main - fraction * (hi - profit);
  return { tax: r2(tax), rate: tax / profit, band: 'Main rate with marginal relief' };
}
