// FBA Admin — cash-flow forecast. Pure.
// Starts from the latest bank balance and adds what's expected: Amazon (and eBay) payouts at their usual rhythm,
// recurring and planned costs, confirmed subscriptions and the corporation tax bill.

import { expectedItems, matchToBank } from './expenses.js';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const iso = (d) => d.toISOString().slice(0, 10);
const D = (s) => new Date(`${s}T00:00:00Z`);
const addDays = (s, n) => iso(new Date(D(s).getTime() + n * 864e5));
const daysBetween = (a, b) => Math.round((D(b) - D(a)) / 864e5);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

// The latest known bank balance: the newest line that carries a running balance.
export function openingBalance(txns, { manual = null } = {}) {
  if (manual && Number.isFinite(Number(manual.amount)) && manual.date) return { amount: r2(manual.amount), date: manual.date, source: 'entered' };
  const withBal = txns.filter((t) => t.balance !== '' && t.balance !== null && t.balance !== undefined && Number.isFinite(Number(t.balance)));
  if (!withBal.length) return null;
  const latest = withBal.reduce((a, t) => (t.date > a.date ? t : a), withBal[0]);
  const sameDay = withBal.filter((t) => t.date === latest.date);
  return { amount: r2(endOfDayBalance(sameDay) ?? Number(latest.balance)), date: latest.date, source: 'bank' };
}

// With several lines on one day, the end-of-day balance is the one no other line follows from.
function endOfDayBalance(lines) {
  if (lines.length === 1) return Number(lines[0].balance);
  for (const t of lines) {
    const after = Number(t.balance);
    // t is last if no other line's (balance − amount) equals t's balance
    if (!lines.some((o) => o !== t && Math.abs(Number(o.balance) - o.amount - after) < 0.005)) return after;
  }
  return null;
}

// Payout rhythm from history. Amazon can pay out daily or every 14 days, so the amount is a rate: what arrived over
// the last 60 days (or the whole history if shorter), spread into weekly payouts — or at the usual gap if that's longer.
export function payoutPattern(dates, { window = 60 } = {}) {
  const ps = [...dates].sort((a, b) => a.date.localeCompare(b.date));
  if (ps.length < 2) return null;
  const gaps = ps.slice(1).map((p, i) => daysBetween(ps[i].date, p.date)).filter((g) => g > 0);
  const gap = Math.round(median(gaps.slice(-8)) || 14);
  const last = ps.at(-1).date;
  const from = addDays(last, -window);
  const inWin = ps.filter((p) => p.date > from);
  const span = Math.min(window, daysBetween(ps[0].date, last) + gap);
  const rate = inWin.reduce((a, p) => a + p.amount, 0) / span;
  const every = gap <= 7 ? 7 : gap;
  return { every, amount: r2(rate * every), rate: r2(rate), last, count: ps.length, window: span };
}

export function amazonPayoutHistory(settlements, txns) {
  const fromStl = settlements.filter((s) => s.total > 0 && s.depositDate).map((s) => ({ date: s.depositDate, amount: s.total }));
  const fromBank = txns.filter((t) => t.category === 'Amazon Payout' && t.amount > 0).map((t) => ({ date: t.date, amount: t.amount }));
  // the bank is what actually arrived; settlements fill in before your first statement
  const firstBank = fromBank.reduce((m, p) => (!m || p.date < m ? p.date : m), '');
  return [...fromStl.filter((p) => !firstBank || p.date < firstBank), ...fromBank];
}

// opts: { today, days, buffer, payout: { mode: 'auto'|'manual'|'off', amount, every, next }, ebay: true, ct: { amount, due } }
export function forecast(data, { today, days = 90, buffer = 0, payout = { mode: 'auto' }, includeEbay = true, includeStock = true, ct = null, subscriptions = [], extraEvents = [] } = {}) {
  const open = openingBalance(data.txns, { manual: data.settings?.cfOpeningManual ? { amount: data.settings.cfOpeningAmount, date: data.settings.cfOpeningDate } : null });
  if (!open) return { ok: false, reason: 'No bank balance yet: import a bank statement (Revolut includes the balance on every line) or enter a starting balance.' };
  const start = open.date;
  const end = addDays(today, days);
  const events = [];
  const notes = [];

  // costs and income you've set up, plus subscriptions; anything already matched to a bank line is in the balance
  const exp = matchToBank(expectedItems(data.expenses || [], { from: addDays(start, -14), to: end, subscriptions }), data.txns, { today });
  for (const it of exp) {
    if (it.paidFrom === 'personal' || it.status === 'skipped' || it.status === 'paid') continue;
    if (it.date <= start) { // before the balance date and never seen in the bank
      if (daysBetween(it.date, start) > 14) continue;
      events.push({ date: addDays(start, 1), label: it.vendor, amount: it.amount, kind: it.source, note: `due ${it.date}, not seen in the bank`, category: it.category });
      continue;
    }
    events.push({ date: it.date, label: it.vendor, amount: it.amount, kind: it.source, note: it.status === 'overdue' ? 'overdue' : '', category: it.category });
  }

  // Amazon payouts
  const hist = payoutPattern(amazonPayoutHistory(data.settlements || [], data.txns));
  let pat = null;
  if (payout.mode === 'manual' && Number(payout.amount) > 0 && Number(payout.every) > 0 && payout.next) pat = { every: Number(payout.every), amount: Number(payout.amount), next: payout.next, source: 'your settings' };
  else if (payout.mode !== 'off' && hist) {
    let next = addDays(hist.last, hist.every);
    while (next <= start) next = addDays(next, hist.every);
    if (daysBetween(hist.last, today) > hist.every * 3) notes.push(`No Amazon payout seen since ${hist.last}, so none are forecast. Set the payout in the forecast settings if they're still coming.`);
    else pat = { every: hist.every, amount: hist.amount, next, source: `about ${hist.every === 7 ? `£${Math.round(hist.amount)} a week` : `£${Math.round(hist.amount)} every ${hist.every} days`}, from what Amazon paid in the last ${hist.window} days` };
  } else if (payout.mode !== 'off') notes.push('Not enough Amazon payout history to forecast payouts: import more bank statements or settlement reports, or set them in the forecast settings.');
  if (pat) for (let d = pat.next; d <= end; d = addDays(d, pat.every)) events.push({ date: d, label: 'Amazon payout', amount: r2(pat.amount), kind: 'payout', note: 'estimate' });

  // eBay payouts from the bank, same idea
  if (includeEbay) {
    const eh = payoutPattern(data.txns.filter((t) => t.category === 'eBay Payout' && t.amount > 0).map((t) => ({ date: t.date, amount: t.amount })));
    if (eh && daysBetween(eh.last, today) <= eh.every * 3) {
      let d = addDays(eh.last, eh.every); while (d <= start) d = addDays(d, eh.every);
      for (; d <= end; d = addDays(d, eh.every)) events.push({ date: d, label: 'eBay payout', amount: eh.amount, kind: 'payout', note: 'estimate' });
    }
  }

  // stock buying: the weekly rate you've spent from the bank over the last 60 days, unless you've planned it yourself
  let stock = null;
  if (includeStock) {
    const from60 = addDays(start, -60);
    const spent = data.txns.filter((t) => t.category === 'Stock Purchase' && t.amount < 0 && t.date > from60 && t.date <= start).reduce((a, t) => a - t.amount, 0);
    const firstBank = data.txns.reduce((m, t) => (!m || t.date < m ? t.date : m), '');
    const span = Math.min(60, Math.max(7, daysBetween(firstBank, start) + 1));
    if (spent > 0) {
      stock = { weekly: r2((spent / span) * 7), span };
      for (let d = addDays(start, 7); d <= end; d = addDays(d, 7)) events.push({ date: d, label: 'Stock buying', amount: -stock.weekly, kind: 'stock', note: 'your usual weekly rate' });
    }
  }

  if (ct && ct.amount > 0 && ct.due > start && ct.due <= end) events.push({ date: ct.due, label: 'Corporation tax', amount: -r2(ct.amount), kind: 'tax', note: ct.note || 'estimate' });

  for (const e of extraEvents) if (e.date > start && e.date <= end) events.push(e);
  events.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
  let bal = open.amount; let low = { date: start, balance: bal };
  const rows = events.map((e) => { bal = r2(bal + e.amount); if (bal < low.balance) low = { date: e.date, balance: bal }; return { ...e, balance: bal }; });
  // daily series for the chart
  const series = []; let i = 0; let b = open.amount;
  for (let d = start; d <= end; d = addDays(d, 1)) { while (i < rows.length && rows[i].date <= d) b = rows[i++].balance; series.push({ date: d, balance: b }); }
  const sumIf = (f) => r2(rows.filter(f).reduce((a, e) => a + e.amount, 0));
  const at = (n) => { const d = addDays(today, n); const s = series.filter((x) => x.date <= d).at(-1); return s ? s.balance : open.amount; };
  return {
    ok: true, open, start, end, rows, series, low, endBalance: bal, moneyIn: sumIf((e) => e.amount > 0), moneyOut: -sumIf((e) => e.amount < 0),
    in30: at(30), in60: at(60), in90: at(90), payout: pat, stock, notes,
    belowZero: rows.find((e) => e.balance < 0) || null, belowBuffer: buffer > 0 ? rows.find((e) => e.balance < buffer) || null : null,
  };
}

// Corporation tax is due 9 months and 1 day after the year end.
export function ctDueDate(yearEnd) {
  const d = D(yearEnd);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 9, d.getUTCDate()));
  return addDays(iso(t), 1);
}
