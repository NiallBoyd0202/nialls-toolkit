// Start Up Loan: each loan part and the total — balance, monthly repayments, interest paid and to come, the payment
// calendar, and lump sums you've paid off. A personal loan: it isn't counted in the business figures.
import * as db from '../db.js';
import { schedule, status, previewExtra, balanceSeries, addMonths, monthlyPayment, firstPaymentFor, paymentFor } from '../loans/model.js';
import { icon, toast, modal, confirmBox } from '../ui.js';
import { esc, money, num } from '../util.js';

const ui = { month: new Date().toISOString().slice(0, 7) };
const today = () => new Date().toISOString().slice(0, 10);
const dstr = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const mstr = (d) => new Date(`${d.slice(0, 7)}-15T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
const kpi = (label, value, sub = '', cls = '') => `<div class="kpi"><div class="label">${label}</div><div class="value ${cls}">${value}</div><div class="sub">${sub}</div></div>`;
const yrs = (m) => (m % 12 ? `${m} months` : `${m / 12} year${m === 12 ? '' : 's'}`);

// Your three parts as you described them; fixed ids so setting them up on two devices doesn't double them.
const STARTER = [
  { id: 'loan-sul-2026-01', name: 'Start Up Loan · January', lender: 'Start Up Loans', amount: 6000, apr: 6, months: 60, start: '2026-01-01' },
  { id: 'loan-sul-2026-04', name: 'Start Up Loan · April', lender: 'Start Up Loans', amount: 4000, apr: 6, months: 60, start: '2026-04-01' },
  { id: 'loan-sul-2026-11', name: 'Start Up Loan · November', lender: 'Start Up Loans', amount: 10000, apr: 7.5, months: 60, start: '2026-11-01' },
];

async function load() {
  const [loans, extras] = await Promise.all([db.getAll('lnLoans'), db.getAll('lnExtras')]);
  loans.sort((a, b) => a.start.localeCompare(b.start));
  const byLoan = new Map(loans.map((l) => [l.id, extras.filter((e) => e.loanId === l.id)]));
  const t = today();
  return { loans, extras, byLoan, st: new Map(loans.map((l) => [l.id, status(l, byLoan.get(l.id), t)])) };
}

export async function render(root) {
  const d = await load();
  const rerender = () => render(root);
  if (!d.loans.length) {
    root.innerHTML = `<div class="empty-state">${icon('wallet', 34)}<h3>Track your Start Up Loan</h3>
      <p>Add each part you've borrowed (or plan to): the amount, APR and term. You'll see what's left on each and in total, every monthly payment, the interest, and what paying off a lump sum saves.</p>
      <div class="row" style="justify-content:center"><button class="btn primary" id="lnStarter">${icon('plus')} Add my three parts (£6k Jan, £4k Apr, £10k Nov)</button><button class="btn" id="lnAdd">${icon('plus')} Add a loan</button></div>
      <p class="small muted" style="margin-top:12px">A personal loan: it's kept out of your business accounts.</p></div>`;
    root.querySelector('#lnStarter').onclick = async () => {
      await db.putMany('lnLoans', STARTER.map((l) => ({ ...l, firstPayment: addMonths(l.start, 1), monthly: '', afterExtra: 'shorter', notes: '' })));
      ui.checkDates = true; toast('Added: check the dates and monthly payments against your statements', 'success', 7000); rerender();
    };
    root.querySelector('#lnAdd').onclick = () => loanForm(null, rerender);
    return;
  }
  const t = today();
  const sts = d.loans.map((l) => ({ l, s: d.st.get(l.id) }));
  const owed = sts.reduce((a, x) => a + x.s.balance, 0);
  const drawn = sts.filter((x) => x.s.drawn && x.s.balance > 0.005);
  const monthlyNow = drawn.reduce((a, x) => a + (x.s.next?.payment || 0), 0);
  const upcomingPlanned = sts.filter((x) => x.s.planned);
  const monthlyLater = monthlyNow + upcomingPlanned.reduce((a, x) => a + paymentFor(x.l), 0);
  const interestPaid = sts.reduce((a, x) => a + x.s.interestToDate, 0);
  const interestLeft = sts.reduce((a, x) => a + x.s.interestLeft, 0);
  const saved = sts.reduce((a, x) => a + x.s.saved, 0);
  const debtFree = sts.reduce((m, x) => (x.s.payoff > m ? x.s.payoff : m), '');
  const borrowed = sts.filter((x) => x.s.drawn).reduce((a, x) => a + Number(x.l.amount), 0);

  root.innerHTML = `
    ${ui.checkDates ? '<div class="callout section-first">Your three parts are in with the 1st of each month as the drawdown date and the standard monthly payment. <b>Edit</b> each one to match your loan agreement or statements (the exact date the money arrived, your first payment date and the monthly amount), so the balances are exact.</div>' : ''}
    <div class="kpis">
      ${kpi('Owed now', money(owed), `of ${money(borrowed, '£', 0)} borrowed so far${upcomingPlanned.length ? ` · ${money(upcomingPlanned.reduce((a, x) => a + Number(x.l.amount), 0), '£', 0)} planned` : ''}`)}
      ${kpi('Monthly repayments', money(monthlyNow), upcomingPlanned.length ? `${money(monthlyLater)} once ${esc(upcomingPlanned.map((x) => mstr(firstPaymentFor(x.l)).split(' ')[0]).join(', '))}'s part starts` : 'across all parts')}
      ${kpi('Interest paid so far', money(interestPaid))}
      ${kpi('Interest still to pay', money(interestLeft), saved > 0 ? `<span class="pos">${money(saved)} saved by overpaying</span>` : 'if you only pay the monthly amount')}
      ${kpi('Debt-free', debtFree ? mstr(debtFree) : '—', 'last payment, as things stand')}
    </div>
    <div class="row section"><h4 class="grow">Loan parts</h4><button class="btn small primary" id="lnExtra">${icon('plus', 14)} Record a lump sum</button><button class="btn small" id="lnAdd">${icon('plus', 14)} Add a loan</button></div>
    <div class="loan-grid">${sts.map(({ l, s }) => {
      const paidShare = s.drawn ? Math.max(0, Math.min(1, 1 - s.balance / Number(l.amount))) : 0;
      return `<div class="card card-pad stack loan-card" data-id="${esc(l.id)}">
        <div class="row"><b class="grow">${esc(l.name)}</b>${s.planned ? `<span class="tag warn">Planned · ${dstr(l.start)}</span>` : s.balance <= 0.005 ? '<span class="tag new">Paid off</span>' : ''}</div>
        <div class="small muted">${money(Number(l.amount), '£', 0)} at ${num(Number(l.apr), 1)}% APR over ${yrs(Number(l.months))} · ${money(paymentFor(l))} a month${Number(l.monthly) > 0 ? '' : ' (worked out)'}</div>
        <div class="row" style="align-items:baseline"><span class="loan-bal">${money(s.planned ? Number(l.amount) : s.balance)}</span><span class="small muted">${s.planned ? 'to borrow' : 'left to pay'}</span></div>
        <div class="vat-bar"><span style="width:${Math.round(paidShare * 100)}%"></span></div>
        <table class="data small"><tbody>
          <tr><td>Next payment</td><td class="r num">${s.next ? `${money(s.next.payment)} · ${dstr(s.next.date)}` : '—'}</td></tr>
          <tr><td>Paid so far</td><td class="r num">${money(s.paidToDate)}${s.extrasPaid ? ` <span class="muted">(${money(s.extrasPaid)} lump sums)</span>` : ''}</td></tr>
          <tr><td>Interest paid / to come</td><td class="r num">${money(s.interestToDate)} / ${money(s.interestLeft)}</td></tr>
          <tr><td>Last payment</td><td class="r num">${dstr(s.payoff)}${s.monthsSaved > 0 ? ` <span class="pos">${s.monthsSaved} month${s.monthsSaved === 1 ? '' : 's'} sooner</span>` : ''}</td></tr>
          ${s.saved > 0 ? `<tr><td>Saved by overpaying</td><td class="r num pos">${money(s.saved)}</td></tr>` : ''}
        </tbody></table>
        <div class="row"><button class="btn small" data-act="extra">${icon('plus', 14)} Lump sum</button><button class="btn small ghost" data-act="edit">Edit</button><button class="btn small ghost" data-act="sched">${icon('list', 14)} Schedule</button></div>
      </div>`;
    }).join('')}</div>

    <div class="grid2 section">
      <div class="card">${calendar(d)}</div>
      <div class="card"><div class="toolbar"><b>Total owed over time</b><span class="small muted">with your lump sums</span></div><div style="padding:6px 12px 10px">${chart(d)}</div></div>
    </div>
    ${d.extras.length ? `<div class="card section"><div class="toolbar"><b>Lump sums you've paid</b></div><div class="table-wrap"><table class="data small"><thead><tr><th>Date</th><th>Loan</th><th class="r">Amount</th><th>Note</th><th></th></tr></thead><tbody>
      ${[...d.extras].sort((a, b) => b.date.localeCompare(a.date)).map((e) => `<tr data-eid="${esc(e.id)}"><td class="nowrap">${dstr(e.date)}</td><td>${esc(d.loans.find((l) => l.id === e.loanId)?.name || '')}</td><td class="r num">${money(Number(e.amount))}</td><td>${esc(e.note || '')}</td><td class="r"><button class="icon-btn" data-delx title="Remove">${icon('trash', 14)}</button></td></tr>`).join('')}
    </tbody></table></div></div>` : ''}
    <p class="small muted section">A personal loan, kept out of the business accounts and cash flow. Interest is worked out day by day at the APR, and regular payments are assumed made on their dates. Your lender's own figures can differ by a few pence. Use the exact monthly amount from your statement (Edit) to match it closely.</p>`;

  root.querySelector('#lnAdd').onclick = () => loanForm(null, rerender);
  root.querySelector('#lnExtra').onclick = () => extraForm(d, null, rerender);
  root.querySelectorAll('.loan-card').forEach((c) => {
    const l = d.loans.find((x) => x.id === c.dataset.id);
    c.querySelector('[data-act="extra"]').onclick = () => extraForm(d, l.id, rerender);
    c.querySelector('[data-act="edit"]').onclick = () => { ui.checkDates = false; loanForm(l, rerender); };
    c.querySelector('[data-act="sched"]').onclick = () => scheduleModal(l, d.byLoan.get(l.id));
  });
  root.querySelectorAll('[data-delx]').forEach((b) => { b.onclick = async () => { if (!(await confirmBox('Remove this lump sum?', 'The balances are worked out again without it.', { okLabel: 'Remove', danger: true }))) return; await db.del('lnExtras', b.closest('tr').dataset.eid); rerender(); }; });
  root.querySelectorAll('[data-mon]').forEach((b) => { b.onclick = () => { ui.month = addMonths(`${ui.month}-01`, Number(b.dataset.mon)).slice(0, 7); rerender(); }; });
}

// Month grid: every regular payment and lump sum on its day.
function calendar(d) {
  const m = ui.month; const first = `${m}-01`;
  const start = new Date(`${first}T00:00:00Z`); const offset = (start.getUTCDay() + 6) % 7;
  const daysIn = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
  const events = new Map(); let total = 0;
  for (const l of d.loans) for (const r of schedule(l, d.byLoan.get(l.id)).rows) {
    if (!r.date.startsWith(m)) continue;
    if (!events.has(r.date)) events.set(r.date, []);
    events.get(r.date).push({ l, r }); total += r.payment;
  }
  const t = today(); const cells = [];
  for (let i = 0; i < offset; i++) cells.push('<div class="cal-d empty"></div>');
  for (let day = 1; day <= daysIn; day++) {
    const date = `${m}-${String(day).padStart(2, '0')}`;
    cells.push(`<div class="cal-d ${date === t ? 'today' : ''}"><span class="cal-n">${day}</span>${(events.get(date) || []).map(({ l, r }) => `<span class="cal-chip ${r.kind === 'extra' ? 'paid' : date < t ? 'bank' : 'exp'}" title="${esc(l.name)}: ${money(r.payment)}${r.kind === 'extra' ? ' lump sum' : ` (${money(r.interest)} interest)`}">${money(r.payment, '£', 0)} ${esc(l.name.split('·').pop().trim().slice(0, 3))}</span>`).join('')}</div>`);
  }
  return `<div class="toolbar"><button class="btn small ghost" data-mon="-1">‹</button><b class="grow" style="text-align:center">${mstr(first)}</b><button class="btn small ghost" data-mon="1">›</button></div>
    <div class="cal">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((x) => `<div class="cal-h">${x}</div>`).join('')}${cells.join('')}</div>
    <p class="small muted" style="padding:8px 14px">${total ? `${money(total)} going out to the loans this month.` : 'No loan payments this month.'} Green = lump sums.</p>`;
}

function chart(d) {
  const from = d.loans.reduce((m, l) => (!m || l.start < m ? l.start : m), '').slice(0, 7) + '-01';
  const to = d.loans.reduce((m, l) => { const p = schedule(l, d.byLoan.get(l.id)).payoff; return p > m ? p : m; }, from);
  const s = balanceSeries(d.loans, d.byLoan, from, addMonths(to, 1));
  if (s.length < 2) return '';
  const W = 600; const H = 200; const L = 52; const B = 22; const T = 10;
  const hi = Math.max(...s.map((p) => p.balance)) * 1.08 || 1;
  const x = (i) => L + (i / (s.length - 1)) * (W - L - 8); const y = (v) => T + (1 - v / hi) * (H - T - B);
  const ti = s.findIndex((p) => p.date > today());
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => hi * f / 1.08);
  return `<div class="sv-chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Total owed from ${from} to ${to}">
    ${ticks.map((v) => `<line x1="${L}" x2="${W - 8}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="ax">${money(v, '£', 0)}</text>`).join('')}
    ${s.filter((p, i) => p.date.endsWith('-01-01') || i === 0).map((p) => `<text x="${x(s.indexOf(p))}" y="${H - 6}" text-anchor="middle" class="ax">${p.date.slice(0, 4)}</text>`).join('')}
    <polyline class="s1" points="${s.map((p, i) => `${x(i)},${y(p.balance)}`).join(' ')}"/>
    ${ti > 0 ? `<line x1="${x(ti)}" x2="${x(ti)}" y1="${T}" y2="${H - B}" class="tgt"/><text x="${x(ti) + 4}" y="${T + 10}" class="ax">today</text>` : ''}
  </svg></div>`;
}

function loanForm(l0, done) {
  const l = l0 || { id: `loan-${Date.now().toString(36)}`, name: '', lender: 'Start Up Loans', amount: '', apr: '', months: 60, start: today(), firstPayment: '', monthly: '', afterExtra: 'shorter', notes: '' };
  const body = document.createElement('div');
  body.innerHTML = `<div class="form-grid">
      <label class="field span2">Name<input id="lf_name" value="${esc(l.name)}" placeholder="e.g. Start Up Loan · January"></label>
      <label class="field">Amount borrowed £<input id="lf_amount" type="number" step="100" min="0" value="${esc(l.amount)}"></label>
      <label class="field">APR %<input id="lf_apr" type="number" step="0.1" min="0" value="${esc(l.apr)}"></label>
      <label class="field">Over (months)<input id="lf_months" type="number" step="1" min="1" value="${esc(l.months)}"><span class="hint">5 years = 60</span></label>
      <label class="field">Money arrived on<input id="lf_start" type="date" value="${esc(l.start)}"><span class="hint">a future date = planned</span></label>
      <label class="field">First payment on<input id="lf_first" type="date" value="${esc(l.firstPayment || '')}"><span class="hint">blank = a month after</span></label>
      <label class="field">Monthly payment £<input id="lf_monthly" type="number" step="0.01" min="0" value="${esc(l.monthly)}"><span class="hint" id="lf_calc"></span></label>
      <label class="field span2">After a lump sum<select id="lf_after"><option value="shorter" ${l.afterExtra !== 'lower' ? 'selected' : ''}>Keep paying the same: finish sooner (saves more interest)</option><option value="lower" ${l.afterExtra === 'lower' ? 'selected' : ''}>Pay less each month: same end date</option></select></label>
      <label class="field span2">Notes<input id="lf_notes" value="${esc(l.notes || '')}" placeholder="e.g. loan reference"></label>
    </div>`;
  const v = (k) => body.querySelector(`#lf_${k}`).value;
  const calc = () => { const p = monthlyPayment(Number(v('amount')) || 0, Number(v('apr')) || 0, Number(v('months')) || 0); body.querySelector('#lf_calc').textContent = p ? `blank = ${money(p)} (worked out); use your statement's figure if it differs` : 'blank = worked out'; };
  ['amount', 'apr', 'months'].forEach((k) => body.querySelector(`#lf_${k}`).addEventListener('input', calc)); calc();
  modal({
    title: l0 ? `Edit ${l.name}` : 'Add a loan', body,
    actions: [
      ...(l0 ? [{ label: 'Delete', kind: 'danger', onClick: async () => {
        if (!(await confirmBox(`Delete ${l.name}?`, 'Removes the loan and its lump sums.', { okLabel: 'Delete', danger: true }))) return false;
        await db.delMany('lnExtras', (await db.getAll('lnExtras')).filter((e) => e.loanId === l.id).map((e) => e.id)); await db.del('lnLoans', l.id); done();
      } }] : []),
      { label: 'Cancel' },
      { label: 'Save', kind: 'primary', onClick: async () => {
        const amount = Number(v('amount')); const apr = Number(v('apr')); const months = Math.round(Number(v('months')));
        if (!(amount > 0) || !(apr >= 0) || !(months > 0) || !v('start')) { toast('Enter the amount, APR, months and the date the money arrived', 'error'); return false; }
        await db.put('lnLoans', { ...l, name: v('name').trim() || `Loan · ${v('start')}`, amount, apr, months, start: v('start'), firstPayment: v('first') || addMonths(v('start'), 1), monthly: v('monthly') === '' ? '' : Number(v('monthly')), afterExtra: v('after'), notes: v('notes').trim() });
        toast('Saved', 'success'); done();
      } },
    ],
  });
}

function extraForm(d, loanId, done) {
  const drawn = d.loans.filter((l) => l.start <= today());
  if (!drawn.length) return toast('None of your loans has started yet', 'error');
  const body = document.createElement('div');
  body.innerHTML = `<div class="form-grid">
      <label class="field">Loan<select id="xf_loan">${drawn.map((l) => `<option value="${esc(l.id)}" ${l.id === loanId ? 'selected' : ''}>${esc(l.name)} (${money(d.st.get(l.id).balance)} left)</option>`).join('')}</select></label>
      <label class="field">Paid on<input id="xf_date" type="date" value="${today()}"></label>
      <label class="field">Amount £<input id="xf_amount" type="number" step="10" min="0" inputmode="decimal"></label>
      <label class="field span2">Note<input id="xf_note" placeholder="optional"></label></div>
    <div class="callout small" id="xf_prev" style="margin-top:10px">Enter an amount to see what it saves.</div>`;
  const get = () => ({ loan: d.loans.find((l) => l.id === body.querySelector('#xf_loan').value), date: body.querySelector('#xf_date').value, amount: Number(body.querySelector('#xf_amount').value) });
  const prev = () => {
    const g = get(); const el = body.querySelector('#xf_prev');
    if (!(g.amount > 0) || !g.loan) { el.textContent = 'Enter an amount to see what it saves.'; return; }
    const p = previewExtra(g.loan, d.byLoan.get(g.loan.id), { date: g.date, amount: g.amount });
    el.innerHTML = `Saves about <b>${money(p.saved)}</b> in interest${g.loan.afterExtra === 'lower' ? `, and the monthly payment drops to <b>${money(p.newPayment)}</b>` : `, and you finish <b>${p.monthsSooner} month${p.monthsSooner === 1 ? '' : 's'} sooner</b> (${dstr(p.payoff)})`}.`;
  };
  body.addEventListener('input', prev); body.addEventListener('change', prev);
  modal({ title: 'Record a lump sum', body, actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: async () => {
    const g = get();
    if (!(g.amount > 0) || !g.date) { toast('Enter the amount and date', 'error'); return false; }
    if (g.date < g.loan.start) { toast('That\'s before the loan started', 'error'); return false; }
    await db.put('lnExtras', { id: `lnx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, loanId: g.loan.id, date: g.date, amount: Math.round(g.amount * 100) / 100, note: body.querySelector('#xf_note').value.trim(), at: Date.now() });
    toast(`Lump sum of ${money(g.amount)} recorded`, 'success'); done();
  } }] });
  setTimeout(() => body.querySelector('#xf_amount').focus(), 60);
}

function scheduleModal(l, extras) {
  const s = schedule(l, extras); const t = today();
  modal({ title: `${l.name}: every payment`, wide: true, body: `<p class="small muted">${money(Number(l.amount))} at ${num(Number(l.apr), 1)}% over ${yrs(Number(l.months))}. Total interest ${money(s.totalInterest)}, total repaid ${money(s.totalPaid)}.</p>
    <div class="table-wrap" style="max-height:60vh;overflow:auto"><table class="data small"><thead><tr><th>Date</th><th class="r">Payment</th><th class="r">Interest</th><th class="r">Off the loan</th><th class="r">Left</th></tr></thead><tbody>
    ${s.rows.map((r) => `<tr class="${r.kind === 'extra' ? 'hit' : r.date <= t ? 'reviewed' : ''}"><td class="nowrap">${dstr(r.date)}${r.kind === 'extra' ? ' <span class="tag new">lump sum</span>' : ''}</td><td class="r num">${money(r.payment)}</td><td class="r num">${money(r.interest)}</td><td class="r num">${money(r.principal)}</td><td class="r num">${money(r.balance)}</td></tr>`).join('')}
    </tbody></table></div>` });
}
