// FBA Admin — daily budget: payouts predicted from your sales, "safe to spend today", the weekly stock allowance,
// predicted vs actual payouts, and what-if scenarios. Pure: no storage, no DOM.
//
// How a payout is predicted
//   1. Net proceeds per day from your order data: sale − Amazon fees − VAT on fees, with refunds taken off on the
//      day they happen. Days not imported yet are filled from your recent sales for that weekday.
//   2. Amazon pays an order out once it's cleared the reserve (delivery + 7 days for most sellers), at the next
//      settlement. So each payout = the proceeds of orders placed in the cycle window, shifted back by the hold,
//      plus account-level fees and reimbursements (storage, subscription, ads billed to Amazon) for those days.
//   3. The hold, the settlement rhythm and the days from settlement to your bank are learned from your settlement
//      reports and bank: the hold is whichever length (0–21 days) best explains your past payouts, and what's left
//      of the gap is corrected with a factor (0.75–1.25), so the forecast is checked against reality every time.
import { openingBalance } from './cashflow.js';

const r2= (n) => Math.round((Number(n) || 0) * 100) / 100;
const iso = (d) => d.toISOString().slice(0, 10);
const D = (s) => new Date(`${s}T00:00:00Z`);
export const addDays = (s, n) => iso(new Date(D(s).getTime() + n * 864e5));
const daysBetween = (a, b) => Math.round((D(b) - D(a)) / 864e5);
const dow = (s) => (D(s).getUTCDay() + 6) % 7; // Monday = 0
const median = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ---------------------------------------------------------------------------
// 1. Proceeds per day
// ---------------------------------------------------------------------------
export function dailyProceeds(orders) {
  const days = new Map();
  const at = (d) => { if (!days.has(d)) days.set(d, { sales: 0, proceeds: 0, refunds: 0, units: 0 }); return days.get(d); };
  let first = ''; let last = '';
  for (const o of orders) {
    if (!o.date) continue;
    if (!first || o.date < first) first = o.date;
    if (!last || o.date > last) last = o.date;
    const sale = Number(o.sale) || 0;
    const cut = Math.abs(Number(o.fees) || 0) + Math.abs(Number(o.vat) || 0);
    if (sale < 0) { const x = at(o.refundDate || o.date); x.refunds += -sale; x.proceeds += sale + cut; continue; } // a refund line of its own
    const day = at(o.date);
    day.sales += sale; day.proceeds += sale - cut; day.units += Number(o.qtyShipped) || 0;
    // a refunded order still showing its original sale: the money goes back on the refund date
    const shipped = Math.max(1, Number(o.qtyShipped) || 0); const refunded = Number(o.qtyRefunded) || 0;
    if ((refunded > 0 || o.refund > 0) && o.refundDate && (Number(o.qtyNet) || 0) < shipped) {
      // SellerFuse gives the refund amount; otherwise it's the share of the sale that was refunded
      const amt = o.refund > 0 ? o.refund : sale * Math.min(1, refunded / shipped);
      const x = at(o.refundDate); x.refunds += amt; x.proceeds -= amt;
    }
  }
  return { days, first, last };
}

// Typical proceeds for each weekday, from the 8 weeks to the last imported day (the most recent 4 count double).
export function weekdayPattern(dp) {
  if (!dp.last) return null;
  const span = Math.min(56, daysBetween(dp.first, dp.last) + 1);
  if (span < 7) return null;
  const sum = Array(7).fill(0); const w = Array(7).fill(0);
  for (let i = 0; i < span; i++) {
    const d = addDays(dp.last, -i); const k = i < 28 ? 2 : 1;
    sum[dow(d)] += (dp.days.get(d)?.proceeds || 0) * k; w[dow(d)] += k;
  }
  const byDay = sum.map((s, i) => (w[i] ? s / w[i] : 0));
  const flat = byDay.reduce((a, b) => a + b, 0) / 7;
  // under 3 weeks of data the weekday shape is noise: use the flat average
  return { byDay: span >= 21 ? byDay.map(r2) : Array(7).fill(r2(flat)), perDay: r2(flat), span };
}

// ---------------------------------------------------------------------------
// 2. Amazon's payout rhythm, learned
// ---------------------------------------------------------------------------
// Account-level money per day (negative = costs): storage, subscription, ads billed to Amazon, minus reimbursements.
export function accountPerDay(fees, { to } = {}) {
  const lines = fees.filter((l) => (l.group === 'fee' || l.group === 'income') && l.date && (!to || l.date <= to));
  if (!lines.length) return 0;
  const last = lines.reduce((m, l) => (l.date > m ? l.date : m), '');
  const from = addDays(last, -89);
  const inWin = lines.filter((l) => l.date >= from);
  const firstInWin = inWin.reduce((m, l) => (!m || l.date < m ? l.date : m), '');
  const span = Math.max(14, daysBetween(firstInWin, last) + 1);
  return r2(inWin.reduce((a, l) => a + l.amount, 0) / span);
}

// Past payouts with the day their money was cut off (settlement end) and the day it reached the bank.
export function payoutCycles(settlements, txns, { defaultLag = 3 } = {}) {
  const bank = txns.filter((t) => t.category === 'Amazon Payout' && t.amount > 0).sort((a, b) => a.date.localeCompare(b.date));
  const used = new Set();
  const cyc = [];
  for (const s of [...settlements].filter((x) => x.total > 0 && (x.end || x.depositDate)).sort((a, b) => (a.end || a.depositDate).localeCompare(b.end || b.depositDate))) {
    const cutoff = s.end || s.depositDate;
    const m = bank.find((t) => !used.has(t.id) && Math.abs(t.amount - s.total) < 0.005 && daysBetween(cutoff, t.date) >= 0 && daysBetween(cutoff, t.date) <= 10);
    if (m) used.add(m.id);
    cyc.push({ cutoff, start: s.start || '', bankDate: m?.date || '', depositDate: s.depositDate || '', amount: s.total, source: 'settlement', matched: !!m });
  }
  const lags = cyc.filter((c) => c.bankDate).map((c) => daysBetween(c.cutoff, c.bankDate));
  const lag = lags.length ? Math.round(median(lags)) : defaultLag;
  // bank payouts with no settlement report: their cut-off is the usual gap before they arrived
  const lastStl = cyc.reduce((m, c) => (c.cutoff > m ? c.cutoff : m), '');
  for (const t of bank) {
    if (used.has(t.id)) continue;
    const cutoff = addDays(t.date, -lag);
    if (lastStl && cutoff <= lastStl) continue; // already covered by a settlement we have
    cyc.push({ cutoff, start: '', bankDate: t.date, amount: t.amount, source: 'bank', matched: true });
  }
  cyc.sort((a, b) => a.cutoff.localeCompare(b.cutoff));
  const gaps = cyc.slice(1).map((c, i) => daysBetween(cyc[i].cutoff, c.cutoff)).filter((g) => g > 0).slice(-6);
  const cadence = gaps.length ? Math.max(1, Math.round(median(gaps))) : 14;
  return { cycles: cyc, lag, cadence };
}

// What the model would have paid for one window of order days.
function windowSum(dp, from, to, value) {
  let s = 0;
  for (let d = addDays(from, 1); d <= to; d = addDays(d, 1)) s += value(d);
  return s;
}

// Picks the hold (days between an order and when it can be paid) that best explains past payouts.
export function learnHold(dp, cycles, acctPerDay, { holds = [...Array(22).keys()], fallback = 10 } = {}) {
  const value = (d) => dp.days.get(d)?.proceeds || 0;
  const evalHold = (h) => {
    const rows = [];
    for (let i = 1; i < cycles.length; i++) {
      const a = cycles[i - 1]; const b = cycles[i];
      const from = addDays(a.cutoff, -h); const to = addDays(b.cutoff, -h);
      if (!dp.first || addDays(from, 1) < dp.first || to > dp.last) continue; // order data must cover the window
      const pred = windowSum(dp, from, to, value) + acctPerDay * daysBetween(a.cutoff, b.cutoff);
      rows.push({ cutoff: b.cutoff, prevCutoff: a.cutoff, bankDate: b.bankDate || b.depositDate, actual: b.amount, model: r2(pred) });
    }
    const act = rows.reduce((x, r) => x + r.actual, 0);
    const err = rows.reduce((x, r) => x + Math.abs(r.model - r.actual), 0);
    return { h, rows, err: act ? err / act : Infinity };
  };
  const tried = holds.map(evalHold).filter((x) => x.rows.length >= 2);
  if (!tried.length) return { hold: fallback, learned: false, factor: 1, rows: [] };
  const best = tried.reduce((a, b) => (b.err < a.err - 1e-9 || (Math.abs(b.err - a.err) < 1e-9 && Math.abs(b.h - fallback) < Math.abs(a.h - fallback)) ? b : a));
  const sumA = best.rows.reduce((x, r) => x + r.actual, 0); const sumM = best.rows.reduce((x, r) => x + r.model, 0);
  const factor = best.rows.length >= 3 && sumM > 0 ? Math.max(0.75, Math.min(1.25, sumA / sumM)) : 1;
  return { hold: best.h, learned: true, factor: r2(factor * 1000) / 1000, rows: best.rows.map((r) => ({ ...r, predicted: r2(r.model * factor), diff: r2(r.model * factor - r.actual) })) };
}

// Everything the forecast needs, from your data and settings.
export function payoutModel(data, s = data.settings || {}) {
  const dp = dailyProceeds(data.orders || []);
  if (!dp.last) return { ok: false, reason: 'No order data yet: import SellerToolkit Orders – Detailed (or SellerFuse orders).' };
  const pat = weekdayPattern(dp);
  if (!pat) return { ok: false, reason: 'Need at least a week of order data to predict payouts from sales.' };
  const pc = payoutCycles(data.settlements || [], data.txns || []);
  const lag = s.cfLagDays !== 'auto' && s.cfLagDays !== '' && s.cfLagDays !== undefined && Number.isFinite(Number(s.cfLagDays)) ? Number(s.cfLagDays) : pc.lag;
  const cadence = s.cfCadence && s.cfCadence !== 'auto' ? Number(s.cfCadence) : pc.cadence;
  const acct = accountPerDay(data.fees || []);
  const learned = learnHold(dp, pc.cycles, acct);
  const hold = s.cfReserveDays && s.cfReserveDays !== 'auto' ? Number(s.cfReserveDays) : learned.hold;
  const lastCutoff = pc.cycles.at(-1)?.cutoff || null;
  if (!lastCutoff) return { ok: false, reason: 'No Amazon payouts yet to time the forecast from: import a bank statement with an Amazon payout, or a settlement report.' };
  const errs = learned.rows.map((r) => Math.abs(r.diff) / r.actual).filter(Number.isFinite);
  return {
    ok: true, dp, pattern: pat, cycles: pc.cycles, lag, cadence, hold, holdLearned: learned.learned && !(s.cfReserveDays && s.cfReserveDays !== 'auto'),
    factor: learned.factor, acctPerDay: acct, lastCutoff, lastOrderDate: dp.last, backtest: learned.rows,
    accuracy: errs.length ? { mape: errs.reduce((a, b) => a + b, 0) / errs.length, n: errs.length, bias: learned.rows.reduce((a, r) => a + r.diff, 0) / learned.rows.length } : null,
  };
}

// ---------------------------------------------------------------------------
// 3. Future payouts
// ---------------------------------------------------------------------------
// opts: { today, days, salesChange (−0.2 = 20% less), delayDays, balanceDate }
export function predictPayouts(model, { today, days = 90, salesChange = 0, delayDays = 0, balanceDate = today } = {}) {
  const end = addDays(today, days);
  const value = (d) => (d <= model.lastOrderDate ? model.dp.days.get(d)?.proceeds || 0 : model.pattern.byDay[dow(d)] * (1 + salesChange));
  const out = [];
  let prev = model.lastCutoff;
  for (let c = addDays(prev, model.cadence); addDays(c, model.lag + delayDays) <= end; c = addDays(c, model.cadence)) {
    const bankDate = addDays(c, model.lag + delayDays);
    const gross = windowSum(model.dp, addDays(prev, -model.hold), addDays(c, -model.hold), value);
    const amount = r2((gross + model.acctPerDay * model.cadence) * model.factor);
    const fromData = addDays(c, -model.hold) <= model.lastOrderDate ? 'all' : addDays(prev, -model.hold) < model.lastOrderDate ? 'part' : 'none';
    if (bankDate > balanceDate && amount > 0) out.push({ date: bankDate, cutoff: c, amount, ordersFrom: addDays(prev, 1 - model.hold), ordersTo: addDays(c, -model.hold), fromData });
    prev = c;
  }
  return out;
}

// Money earned at Amazon and not paid out yet: due at the next payout, and still held back for later ones.
// "Due" is what the first payout after the last one you have on record should bring (it may already be on its way);
// "held" is everything earned since that's waiting for later payouts.
export function inAmazon(model, { today }) {
  const value = (d) => (d <= model.lastOrderDate ? model.dp.days.get(d)?.proceeds || 0 : model.pattern.byDay[dow(d)]);
  const paidTo = addDays(model.lastCutoff, -model.hold);
  const next = addDays(model.lastCutoff, model.cadence);
  const nextTo = addDays(next, -model.hold);
  let due = 0; let held = 0;
  for (let d = addDays(paidTo, 1); d <= today; d = addDays(d, 1)) { if (d <= nextTo) due += value(d); else held += value(d); }
  return { due: r2(due * model.factor), held: r2(held * model.factor), nextCutoff: next };
}

// What to give cashflow.forecast(): with "from your sales" on (and enough data), Amazon payouts come from here;
// otherwise the forecast's own payout-history method. Returns { payout, extraEvents, model, preds, fallback }.
export function payoutSetup(data, { today, days = 90, salesChange = 0, delayDays = 0 } = {}) {
  const s = data.settings || {};
  const base = { mode: s.cfPayoutMode || 'auto', amount: s.cfPayoutAmount, every: s.cfPayoutEvery, next: s.cfPayoutNext };
  if (base.mode !== 'sales') return { payout: base, extraEvents: [], model: null, preds: [] };
  const model = payoutModel(data, s);
  if (!model.ok) return { payout: { ...base, mode: 'auto' }, extraEvents: [], model, preds: [], fallback: model.reason };
  const open = openingBalance(data.txns || [], { manual: s.cfOpeningManual ? { amount: s.cfOpeningAmount, date: s.cfOpeningDate } : null });
  const balanceDate = open?.date || today;
  const preds = predictPayouts(model, { today, days, salesChange, delayDays, balanceDate });
  const fmt = (d) => D(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  // settlements already closed, with the amount known, that haven't reached the bank statement yet
  const known = model.cycles.filter((c) => c.source === 'settlement' && !c.matched && addDays(c.cutoff, model.lag + delayDays) > balanceDate)
    .map((c) => ({ date: addDays(c.cutoff, model.lag + delayDays), label: 'Amazon payout', amount: r2(c.amount), kind: 'payout', note: 'settlement report' }));
  const extraEvents = [...known, ...preds.map((p) => ({ date: p.date, label: 'Amazon payout', amount: p.amount, kind: 'payout', note: `predicted from orders ${fmt(p.ordersFrom)}–${fmt(p.ordersTo)}${p.fromData === 'none' ? ' (your usual daily sales)' : p.fromData === 'part' ? ' (part estimated)' : ''}${salesChange ? ` · sales ${salesChange > 0 ? '+' : ''}${Math.round(salesChange * 100)}%` : ''}` }))];
  return { payout: { ...base, mode: 'off' }, extraEvents, model, preds: [...known.map((k) => ({ ...k, known: true })), ...preds] };
}

// ---------------------------------------------------------------------------
// 4. Safe to spend
// ---------------------------------------------------------------------------
// fc: a cash-flow forecast (cashflow.forecast) that includes the predicted payouts and every bill, but NOT the
// "usual stock buying": that's what this budget is for. The most you can spend each day so the balance never
// drops under the buffer on any day in the horizon.
export function safeToSpend(fc, { today, horizon = 28, buffer = 0 }) {
  if (!fc?.ok) return null;
  const bal = (d) => { const s = fc.series.filter((x) => x.date <= d).at(-1); return s ? s.balance : fc.open.amount; };
  const now = bal(today);
  let perDay = Infinity; let limit = null; let low = { date: today, balance: now };
  for (let t = 1; t <= horizon; t++) {
    const d = addDays(today, t); const b = bal(d);
    if (b < low.balance) low = { date: d, balance: b };
    const s = (b - buffer) / t;
    if (s < perDay) { perDay = s; limit = { date: d, balance: b }; }
  }
  const short = now < buffer ? r2(buffer - now) : perDay < 0 ? r2(-perDay * daysBetween(today, limit.date)) : 0;
  perDay = Math.max(0, perDay);
  return { perDay: r2(perDay), weekly: r2(perDay * 7), now: r2(now), horizon, limit, low, short, buffer };
}

// ---------------------------------------------------------------------------
// 5. Spending: what left the bank each day that wasn't a planned bill
// ---------------------------------------------------------------------------
// planned: bank line ids matched to an expected bill, Klarna instalment or subscription.
export function dailySpend(txns, { from, to, planned = new Set() }) {
  const days = new Map();
  for (const t of txns) {
    if (t.amount >= 0 || t.date < from || t.date > to || planned.has(t.id) || t.category === 'Transfer') continue;
    if (!days.has(t.date)) days.set(t.date, { spent: 0, stock: 0, other: 0, lines: [] });
    const x = days.get(t.date); const a = -t.amount;
    x.spent += a; if (t.category === 'Stock Purchase') x.stock += a; else x.other += a;
    x.lines.push(t);
  }
  for (const x of days.values()) { x.spent = r2(x.spent); x.stock = r2(x.stock); x.other = r2(x.other); }
  return days;
}

// ---------------------------------------------------------------------------
// 6. The spend log: spends you note down as you make them, until the bank statement shows them
// ---------------------------------------------------------------------------
// Each logged spend is matched to the bank line that paid it: money out, within 2% (min 50p), dated from the day
// before to 6 days after. Returns the log with { txnId } on the matched ones.
export function matchSpendLog(log, txns) {
  const out = txns.filter((t) => t.amount < 0).sort((a, b) => a.date.localeCompare(b.date));
  const used = new Set();
  return [...log].sort((a, b) => a.date.localeCompare(b.date) || (a.at || 0) - (b.at || 0)).map((l) => {
    let best = null; let bestScore = Infinity;
    for (const t of out) {
      if (used.has(t.id)) continue;
      const gap = daysBetween(l.date, t.date);
      if (gap < -1 || gap > 6) continue;
      const diff = Math.abs(-t.amount - l.amount);
      if (diff > Math.max(0.5, l.amount * 0.02)) continue;
      const score = Math.abs(gap) + diff;
      if (score < bestScore) { best = t; bestScore = score; }
    }
    if (best) { used.add(best.id); return { ...l, txnId: best.id, txnDate: best.date }; }
    return { ...l, txnId: '' };
  });
}

// Logged spends the bank statement doesn't cover yet, as cash-flow events.
export function spendEvents(log, txns, { balanceDate }) {
  return matchSpendLog(log, txns).filter((l) => !l.txnId && l.date > balanceDate)
    .map((l) => ({ date: l.date, label: l.what || (l.kind === 'stock' ? 'Stock (logged)' : 'Spend (logged)'), amount: -r2(l.amount), kind: 'spend', note: 'logged, not in the bank yet' }));
}

// Average weekly unplanned spend that isn't stock (fuel, packaging, one-off bits): kept back from the stock allowance.
export function otherWeekly(txns, { to, planned = new Set(), weeks = 8 }) {
  const from = addDays(to, -weeks * 7 + 1);
  const firstBank = txns.reduce((m, t) => (!m || t.date < m ? t.date : m), '');
  const span = Math.max(7, Math.min(weeks * 7, daysBetween(firstBank > from ? firstBank : from, to) + 1));
  let other = 0;
  for (const x of dailySpend(txns, { from, to, planned }).values()) other += x.other;
  return r2((other / span) * 7);
}
