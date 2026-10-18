// FBA Admin — expense tracker. Pure.
// Three kinds of entry, all in faExpenses:
//   manual     a cost already paid outside the imported bank account: your own card or cash (→ director's loan),
//              or company cash / another account
//   recurring  a regular cost (or income): amount + how often, paid from the bank or personally
//   planned    a one-off cost (or income) you expect on a date
// Confirmed subscriptions (Subscriptions tab) show up as recurring automatically.
// Expected payments are ticked off when a matching bank line arrives.

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const iso = (d) => d.toISOString().slice(0, 10);
const D = (s) => new Date(`${s}T00:00:00Z`);
const addDays = (s, n) => iso(new Date(D(s).getTime() + n * 864e5));
const daysBetween = (a, b) => Math.round((D(b) - D(a)) / 864e5);
const todayIso = () => iso(new Date());

export const FREQUENCIES = [
  ['weekly', 'Weekly'], ['fortnightly', 'Every 2 weeks'], ['4weekly', 'Every 4 weeks'], ['monthly', 'Monthly'], ['quarterly', 'Quarterly'], ['annual', 'Yearly'],
];
const PER_YEAR = { weekly: 52, fortnightly: 26, '4weekly': 13, monthly: 12, quarterly: 4, annual: 1 };
const SUB_FREQ = { Monthly: 'monthly', Quarterly: 'quarterly', Annual: 'annual' };

export const perYear = (amount, freq) => r2((Number(amount) || 0) * (PER_YEAR[freq] || 0));

// Same day of the month as the start, clamped to short months (31st → 30th / 28th).
function addMonths(start, n) {
  const d = D(start); const day = d.getUTCDate();
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(day, last));
  return iso(t);
}

// Every date a recurring entry falls on between from and to (inclusive).
export function occurrences(rec, from, to) {
  const out = [];
  if (!rec.start || !rec.freq) return out;
  const end = rec.end && rec.end < to ? rec.end : to;
  const step = { weekly: 7, fortnightly: 14, '4weekly': 28 }[rec.freq];
  const months = { monthly: 1, quarterly: 3, annual: 12 }[rec.freq];
  if (!step && !months) return out;
  // jump close to `from` instead of walking years of history
  let i = 0;
  if (step) i = Math.max(0, Math.floor(daysBetween(rec.start, from) / step) - 1);
  else { const s = D(rec.start); const f = D(from); i = Math.max(0, Math.floor(((f.getUTCFullYear() - s.getUTCFullYear()) * 12 + f.getUTCMonth() - s.getUTCMonth()) / months) - 1); }
  for (let guard = 0; guard < 2000; guard++, i++) {
    const d = step ? addDays(rec.start, i * step) : addMonths(rec.start, i * months);
    if (d > end) break;
    if (d >= from) out.push(d);
  }
  return out;
}

export const vendorSlug = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const keywords = (e) => (e.matchKeyword ? [e.matchKeyword.toLowerCase()] : vendorSlug(e.vendor).split(' ').filter((w) => w.length >= 3 && !['ltd', 'limited', 'the', 'and', 'uk', 'plc', 'com'].includes(w)));

// Everything expected between from and to: recurring + planned + confirmed subscriptions.
// Amounts are signed: money out negative, money in positive.
export function expectedItems(expenses, { from, to, subscriptions = [] } = {}) {
  const items = [];
  const recurring = expenses.filter((e) => e.kind === 'recurring' && e.active !== false);
  for (const e of recurring) {
    const skipped = new Set(e.skipped || []);
    for (const date of occurrences(e, from, to)) {
      items.push({ key: `${e.id}|${date}`, entryId: e.id, date, vendor: e.vendor, amount: r2((e.direction === 'in' ? 1 : -1) * e.amount), category: e.category, source: 'recurring', paidFrom: e.paidFrom || 'bank', freq: e.freq, keywords: keywords(e), skipped: skipped.has(date), note: e.note || '' });
    }
  }
  for (const e of expenses.filter((x) => x.kind === 'planned' && x.status !== 'cancelled')) {
    if (e.date < from || e.date > to) continue;
    items.push({ key: `${e.id}|${e.date}`, entryId: e.id, date: e.date, vendor: e.vendor, amount: r2((e.direction === 'in' ? 1 : -1) * e.amount), category: e.category, source: 'planned', paidFrom: e.paidFrom || 'bank', keywords: keywords(e), markedPaid: e.status === 'paid', note: e.note || '' });
  }
  // confirmed subscriptions, unless you've added the same supplier as your own recurring entry
  const own = new Set(recurring.map((e) => vendorSlug(e.vendor)));
  for (const s of subscriptions) {
    const freq = SUB_FREQ[s.frequency];
    if (!freq || !s.lastSeen || own.has(vendorSlug(s.name)) || own.has(vendorSlug(s.vendor))) continue;
    const rec = { start: s.firstSeen || s.lastSeen, freq };
    for (const date of occurrences(rec, from, to)) {
      items.push({ key: `sub:${s.id}|${date}`, entryId: `sub:${s.id}`, date, vendor: s.name, amount: -s.amount, category: s.category || 'Subscription', source: 'subscription', paidFrom: 'bank', freq, keywords: keywords({ vendor: s.vendor || s.name }), note: s.note || '' });
    }
  }
  return items.sort((a, b) => a.date.localeCompare(b.date) || a.vendor.localeCompare(b.vendor));
}

// Tick off expected bank payments with the bank line that paid them.
// A match: same direction, amount within 10% (min 50p), banked 3 days before to 7 days after, and the supplier's
// name in the description (or the exact amount when the name doesn't appear).
export function matchToBank(items, txns, { today = todayIso() } = {}) {
  const used = new Set();
  const sorted = [...txns].sort((a, b) => a.date.localeCompare(b.date));
  return items.map((it) => {
    if (it.skipped) return { ...it, status: 'skipped' };
    if (it.paidFrom === 'personal') return { ...it, status: it.date <= today ? 'personal' : 'upcoming' };
    let best = null; let bestScore = Infinity;
    for (const t of sorted) {
      if (used.has(t.id) || Math.sign(t.amount) !== Math.sign(it.amount)) continue;
      const gap = daysBetween(it.date, t.date);
      if (gap < -3 || gap > 7) continue;
      const diff = Math.abs(Math.abs(t.amount) - Math.abs(it.amount));
      const exact = diff < 0.005;
      if (diff > Math.max(0.5, Math.abs(it.amount) * 0.1)) continue;
      const desc = `${t.description} ${t.reference || ''}`.toLowerCase();
      const named = it.keywords.some((k) => desc.includes(k));
      if (!named && !exact) continue;
      const score = Math.abs(gap) + (named ? 0 : 5) + diff;
      if (score < bestScore) { best = t; bestScore = score; }
    }
    if (best) { used.add(best.id); return { ...it, status: 'paid', txnId: best.id, paidDate: best.date, paidAmount: best.amount }; }
    if (it.markedPaid) return { ...it, status: 'paid' };
    if (it.date > today) return { ...it, status: 'upcoming' };
    return { ...it, status: daysBetween(it.date, today) > 7 ? 'overdue' : 'due' };
  });
}

// Costs actually paid outside the imported bank account, for the P&L and the director's loan:
// manual entries, plus recurring / planned entries paid personally up to today.
export function nonBankCosts(expenses, { today = todayIso() } = {}) {
  const out = [];
  for (const e of expenses) {
    if (e.kind === 'manual') out.push({ id: e.id, date: e.date, vendor: e.vendor, amount: r2(e.amount), category: e.category, paidBy: e.paidBy || 'personal', note: e.note || '' });
  }
  const personal = expenses.filter((e) => e.paidFrom === 'personal' && e.direction !== 'in');
  for (const it of expectedItems(personal, { from: '2000-01-01', to: today })) {
    if (it.skipped) continue;
    out.push({ id: it.key, date: it.date, vendor: it.vendor, amount: -it.amount, category: it.category, paidBy: 'personal', note: it.source === 'recurring' ? 'recurring, paid personally' : 'paid personally' });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// As bank-style lines: P&L overheads (negative) and director's loan credits (positive: the company owes you).
export const costsAsTxns = (costs) => costs.map((c) => ({ id: `nb:${c.id}`, date: c.date, description: `${c.vendor}${c.paidBy === 'personal' ? ' (paid personally)' : ' (not in the bank)'}`, amount: -c.amount, category: c.category, manual: true }));
export const dlaCredits = (costs) => costs.filter((c) => c.paidBy === 'personal').map((c) => ({ id: `dla:${c.id}`, date: c.date, description: `Paid personally: ${c.vendor}`, amount: c.amount, category: 'Director Loan', manual: true }));

// One month as calendar weeks (Mon–Sun), each day with its items.
export function monthGrid(month, itemsByDate) {
  const [y, m] = month.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7;
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= lastDay; d++) { const date = `${month}-${String(d).padStart(2, '0')}`; cells.push({ date, day: d, items: itemsByDate[date] || [] }); }
  while (cells.length % 7) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export const shiftMonth = (month, n) => addMonths(`${month}-01`, n).slice(0, 7);
