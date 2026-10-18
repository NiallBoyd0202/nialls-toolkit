// Start Up Loan (and any other personal loan) — repayment schedules. Pure: no storage, no DOM.
//
// Each loan part is repaid monthly over its term at a fixed rate. Interest is worked out day by day on what's
// owed (rate ÷ 365), so a lump sum you pay mid-month saves interest from that day. After a lump sum, either:
//   'shorter' keep paying the same each month and finish sooner (the usual choice, saves the most interest), or
//   'lower'   keep the end date and pay less each month.
// Regular monthly payments are assumed made on their dates; lump sums are the ones you record.

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const D = (s) => new Date(`${s}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
const days = (a, b) => Math.round((D(b) - D(a)) / 864e5);
export function addMonths(s, n) {
  const d = D(s); const day = d.getUTCDate();
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(day, last));
  return iso(t);
}

// The standard repayment for borrowing `principal` at `apr` % over `months`.
export function monthlyPayment(principal, apr, months) {
  const r = (Number(apr) || 0) / 100 / 12;
  if (!months) return 0;
  if (!r) return r2(principal / months);
  return r2((principal * r) / (1 - (1 + r) ** -months));
}

export const firstPaymentFor = (loan) => loan.firstPayment || addMonths(loan.start, 1);
export const paymentFor = (loan) => (Number(loan.monthly) > 0 ? Number(loan.monthly) : monthlyPayment(Number(loan.amount), loan.apr, loan.months));

// Every payment from drawdown to paid off. extras: [{ date, amount }] lump sums for this loan.
// -> { rows: [{ date, kind: 'payment'|'extra', payment, interest, principal, balance }], payoff, totalInterest, totalPaid, payment }
export function schedule(loan, extras = []) {
  const apr = Number(loan.apr) || 0; const daily = apr / 100 / 365;
  let bal = Number(loan.amount) || 0;
  let pay = paymentFor(loan);
  const lumps = [...extras].filter((e) => Number(e.amount) > 0).sort((a, b) => a.date.localeCompare(b.date));
  const rows = [];
  let last = loan.start; let accrued = 0; let li = 0; let k = 0; let totalInterest = 0; let totalPaid = 0;
  const first = firstPaymentFor(loan);
  const accrue = (to) => { if (to > last) { accrued += bal * daily * days(last, to); last = to; } };
  while (bal > 0.005 && k < 600) {
    const due = addMonths(first, k);
    // lump sums before (or on) this payment date: interest up to the day, then they come off the balance
    while (li < lumps.length && lumps[li].date <= due) {
      const e = lumps[li++];
      if (e.date < loan.start) continue;
      accrue(e.date);
      const amt = Math.min(Number(e.amount), bal + accrued);
      // a lump sum clears interest built up so far first, then the loan itself
      const toInt = Math.min(accrued, amt); accrued -= toInt; bal = r2(bal - (amt - toInt));
      totalInterest += toInt; totalPaid += amt;
      rows.push({ date: e.date, kind: 'extra', payment: r2(amt), interest: r2(toInt), principal: r2(amt - toInt), balance: r2(bal), note: e.note || '' });
      if (bal <= 0.005) break;
      // "pay less each month": spread what's left over the payments left, starting with the next one
      if (loan.afterExtra === 'lower') { const left = Number(loan.months) - k; if (left > 0) pay = monthlyPayment(bal, apr, left); }
    }
    if (bal <= 0.005) break;
    accrue(due);
    const interest = r2(accrued); accrued = 0;
    const p = Math.min(pay, r2(bal + interest));
    bal = r2(bal + interest - p);
    totalInterest += interest; totalPaid += p;
    rows.push({ date: due, kind: 'payment', payment: r2(p), interest, principal: r2(p - interest), balance: bal });
    k++;
  }
  return { rows, payoff: rows.at(-1)?.date || loan.start, totalInterest: r2(totalInterest), totalPaid: r2(totalPaid), payment: paymentFor(loan) };
}

// Where a loan stands today, and what the lump sums have saved compared with none.
export function status(loan, extras, today) {
  const s = schedule(loan, extras);
  const base = schedule(loan, []);
  const done = s.rows.filter((r) => r.date <= today);
  const drawn = loan.start <= today;
  const balance = !drawn ? 0 : done.length ? done.at(-1).balance : Number(loan.amount);
  const next = s.rows.find((r) => r.date > today && r.kind === 'payment') || null;
  const monthsLeft = s.rows.filter((r) => r.date > today && r.kind === 'payment').length;
  return {
    drawn, planned: !drawn, balance: r2(balance), owedIfDrawn: Number(loan.amount),
    paidToDate: r2(done.reduce((a, r) => a + r.payment, 0)), interestToDate: r2(done.reduce((a, r) => a + r.interest, 0)),
    interestLeft: r2(s.totalInterest - done.reduce((a, r) => a + r.interest, 0)), extrasPaid: r2(done.filter((r) => r.kind === 'extra').reduce((a, r) => a + r.payment, 0)),
    next, monthsLeft, payoff: s.payoff, totalInterest: s.totalInterest,
    saved: r2(base.totalInterest - s.totalInterest), monthsSaved: base.rows.filter((r) => r.kind === 'payment').length - s.rows.filter((r) => r.kind === 'payment').length,
    basePayoff: base.payoff, schedule: s,
  };
}

// What one lump sum would do, before you record it.
export function previewExtra(loan, extras, extra) {
  const before = schedule(loan, extras); const after = schedule(loan, [...extras, extra]);
  const n = (s) => s.rows.filter((r) => r.kind === 'payment').length;
  return { saved: r2(before.totalInterest - after.totalInterest), monthsSooner: n(before) - n(after), payoff: after.payoff, newPayment: loan.afterExtra === 'lower' ? after.rows.find((r) => r.kind === 'payment' && r.date > extra.date)?.payment ?? null : null };
}

// Total owed across loans on each date (month starts), for the chart.
export function balanceSeries(loans, extrasByLoan, from, to) {
  const out = [];
  const scheds = loans.map((l) => ({ l, s: schedule(l, extrasByLoan.get(l.id) || []) }));
  for (let d = from; d <= to; d = addMonths(d, 1)) {
    let tot = 0;
    for (const { l, s } of scheds) {
      if (l.start > d) continue;
      const done = s.rows.filter((r) => r.date <= d);
      tot += done.length ? done.at(-1).balance : Number(l.amount);
    }
    out.push({ date: d, balance: r2(tot) });
  }
  return out;
}
