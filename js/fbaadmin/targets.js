// FBA Admin — monthly sales and profit targets. Pure.
import { compute } from './pnl.js';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const lastDay = (month) => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };

// settings.targets = { default: { sales, profit }, months: { 'YYYY-MM': { sales, profit } } }
export function targetFor(settings, month) {
  const t = settings?.targets || {};
  const m = t.months?.[month] || {};
  const d = t.default || {};
  const pick = (k) => (m[k] !== undefined && m[k] !== '' && m[k] !== null ? Number(m[k]) : (d[k] !== undefined && d[k] !== '' && d[k] !== null ? Number(d[k]) : null));
  return { sales: pick('sales'), profit: pick('profit'), own: !!(t.months?.[month] && (t.months[month].sales !== '' || t.months[month].profit !== '')) };
}

// Progress for one month. Sales and profit follow the dashboard's basis (Amazon only, or Amazon + eBay).
// "Up to" is the newest SellerToolkit order in the month, so a late import doesn't look like a slow month.
export function monthProgress(data, month, { today, basis = 'amazon', overheadSource = 'auto', allocate = 'revenue' } = {}) {
  const from = `${month}-01`; const to = `${month}-${String(lastDay(month)).padStart(2, '0')}`;
  const p = compute(data, { from, to, overheadSource, allocate });
  const comb = basis === 'combined';
  const sales = comb ? p.combinedRevenue : p.revenue;
  const profit = comb ? p.combinedNet : p.netProfit;
  const newest = data.orders.filter((o) => o.date >= from && o.date <= to).reduce((m, o) => (o.date > m ? o.date : m), '');
  const days = lastDay(month);
  const isPast = to < today; const isFuture = from > today;
  const upTo = isPast ? to : (newest && newest < today ? newest : today);
  const elapsed = isFuture ? 0 : Math.max(1, Number(upTo.slice(8, 10)));
  const left = Math.max(0, days - elapsed);
  const t = targetFor(data.settings, month);
  const pace = (have, target) => ({
    have: r2(have), target, pct: target ? have / target : null,
    projected: elapsed ? r2((have / elapsed) * days) : null,
    perDayNeeded: target !== null && left ? r2(Math.max(0, target - have) / left) : null,
    perDaySoFar: elapsed ? r2(have / elapsed) : null,
    onTrack: target === null ? null : elapsed ? (have / elapsed) * days >= target : null,
  });
  return { month, from, to, upTo, noOrders: !newest, days, elapsed, left, isPast, isFuture, sales: pace(sales, t.sales), profit: pace(profit, t.profit), hasTarget: t.sales !== null || t.profit !== null };
}

export function recentMonths(today, n = 6) {
  const [y, m] = today.split('-').map(Number);
  return Array.from({ length: n }, (_, i) => { const d = new Date(Date.UTC(y, m - 1 - i, 1)); return d.toISOString().slice(0, 7); });
}
export function nextMonths(today, n = 12) {
  const [y, m] = today.split('-').map(Number);
  return Array.from({ length: n }, (_, i) => { const d = new Date(Date.UTC(y, m - 1 + i, 1)); return d.toISOString().slice(0, 7); });
}
