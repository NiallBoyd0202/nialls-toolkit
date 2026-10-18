// FBA Admin — the weekly summary, shown as "Last week" at the top of the dashboard. Pure: built from loadAll() data.
// (Its shape, title + fields, is what used to be posted to Discord before 2.2.)
import { compute, cash, presetRange } from './pnl.js';
import { guideStatus } from './guide.js';
import { stockReport } from './stock.js';
import { reconcilePayouts } from './settlement.js';
import { detectSubscriptions, mergeSubscriptions } from './subscriptions.js';
import { expectedItems, matchToBank } from './expenses.js';
import { forecast, openingBalance } from './cashflow.js';
import { payoutSetup, safeToSpend, otherWeekly, spendEvents } from './cashplan.js';
import { agedReport } from './aged.js';
import { monthProgress } from './targets.js';
import { missingReceipts } from './invoices.js';
import { followUpsDue } from '../outreach/analysis.js';

const D = (s) => new Date(`${s}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => iso(new Date(D(s).getTime() + n * 864e5));
const gbp = (n) => `${n < 0 ? '−' : ''}£${Math.abs(Number(n) || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (d) => D(d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const pct = (x) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`);

// The Monday–Sunday week before `today`.
export function lastWeek(today) {
  const dow = (D(today).getUTCDay() + 6) % 7; // Monday = 0
  const from = addDays(today, -dow - 7);
  return { from, to: addDays(from, 6) };
}

// Monday of the week containing `date`: used to send once a week.
export const weekKey = (date) => addDays(date, -((D(date).getUTCDay() + 6) % 7));

export function buildWeekly(data, { today, basis = 'amazon' } = {}) {
  const s = data.settings;
  const w = lastWeek(today);
  const p = compute(data, { from: w.from, to: w.to, overheadSource: s.overheadSource, allocate: s.allocate });
  const c = cash(data.txns, w.from, w.to);
  const newestOrder = data.orders.reduce((m, o) => (o.date > m ? o.date : m), '');
  const newestBank = data.txns.reduce((m, t) => (t.date > m ? t.date : m), '');
  const comb = basis === 'combined';

  const lines = [];
  const month = today.slice(0, 7);
  const mp = monthProgress(data, month, { today, basis, overheadSource: s.overheadSource, allocate: s.allocate });

  const subs = mergeSubscriptions(detectSubscriptions(data.txns), data.subsSaved || []);
  const coming = matchToBank(expectedItems(data.expenses || [], { from: today, to: addDays(today, 7), subscriptions: subs.confirmed }), data.txns, { today })
    .filter((x) => x.status !== 'paid' && x.status !== 'skipped');
  const overdue = matchToBank(expectedItems(data.expenses || [], { from: addDays(today, -30), to: addDays(today, -1), subscriptions: subs.confirmed }), data.txns, { today })
    .filter((x) => x.status === 'overdue');

  const fyFrom = presetRange('this_fy', { fyStart: s.fyStart, today }).from;
  const due = guideStatus(data, { today, fyFrom }).filter((g) => g.status === 'overdue' || g.status === 'due');
  const sr = stockReport(data);
  const sellable = Object.fromEntries(sr.rows.filter((r) => r.sellable).map((r) => [r.sku, r.sellable]));
  const aged = agedReport({ asOf: sr.asOf || today, health: data.health || [], sellableBySku: sellable, ledger: data.ledger, stock: data.stock, warnDays: 30 });
  const pay = reconcilePayouts(data.settlements || [], data.txns);
  const unc = data.txns.filter((t) => t.category === 'Uncategorized').length;
  const rec = (data.invoices || []).length ? missingReceipts(data.txns, data.invoices, { from: fyFrom, to: today }) : { rows: [] };
  const ps = payoutSetup(data, { today, days: 45 });
  const open = openingBalance(data.txns, { manual: s.cfOpeningManual ? { amount: s.cfOpeningAmount, date: s.cfOpeningDate } : null });
  const events = [...ps.extraEvents, ...(open ? spendEvents(data.spendLog || [], data.txns, { balanceDate: open.date }) : [])];
  const fc = forecast(data, { today, days: 30, buffer: Number(s.cfBuffer) || 0, payout: ps.payout, extraEvents: events, includeStock: s.cfIncludeStock !== false, subscriptions: subs.confirmed });
  const fcBudget = forecast(data, { today, days: Number(s.cfHorizon) || 28, buffer: Number(s.cfBuffer) || 0, payout: ps.payout, extraEvents: events, includeStock: false, subscriptions: subs.confirmed });
  const safe = safeToSpend(fcBudget, { today, horizon: Number(s.cfHorizon) || 28, buffer: Number(s.cfBuffer) || 0 });

  const attention = [
    due.length ? `📥 ${due.length} report${due.length === 1 ? '' : 's'} to download: ${due.slice(0, 4).map((g) => g.label.replace(/^(Amazon|SellerToolkit|SellerFuse) · /, '')).join(', ')}` : '',
    unc ? `🏷️ ${unc} bank line${unc === 1 ? '' : 's'} not categorised` : '',
    aged.totals.charged ? `📦 ${aged.totals.charged} unit${aged.totals.charged === 1 ? '' : 's'} already paying Amazon's aged stock surcharge` : '',
    aged.totals.soon ? `⏳ ${aged.totals.soon} unit${aged.totals.soon === 1 ? '' : 's'} reach the aged stock surcharge within a month` : '',
    sr.totals.unfulfillable ? `🚫 ${sr.totals.unfulfillable} unfulfillable unit${sr.totals.unfulfillable === 1 ? '' : 's'} at Amazon` : '',
    pay.unmatched.length ? `💷 ${pay.unmatched.length} Amazon payout${pay.unmatched.length === 1 ? '' : 's'} not found in the bank` : '',
    overdue.length ? `⚠️ ${overdue.length} expected payment${overdue.length === 1 ? '' : 's'} not seen in the bank: ${overdue.slice(0, 3).map((x) => x.vendor).join(', ')}` : '',
    rec.rows.length ? `🧾 ${rec.rows.length} cost${rec.rows.length === 1 ? '' : 's'} with no receipt` : '',
    (() => { const d = followUpsDue(data.suppliers || [], today); return d.length ? `📧 ${d.length} supplier follow-up${d.length === 1 ? '' : 's'} due: ${d.slice(0, 3).map((x) => x.company).join(', ')}` : ''; })(),
    fc.ok && fc.belowZero && fc.belowZero.date <= addDays(today, 30) ? `🔴 Bank forecast goes below £0 on ${day(fc.belowZero.date)}` : '',
    fc.ok && !fc.belowZero && fc.belowBuffer ? `🟠 Bank forecast drops under your ${gbp(s.cfBuffer)} buffer on ${day(fc.belowBuffer.date)}` : '',
  ].filter(Boolean);

  const fields = [
    { name: comb ? 'Sales (Amazon + eBay)' : 'Sales', value: `${gbp(comb ? p.combinedRevenue : p.revenue)}\n${p.units} units`, inline: true },
    { name: 'Net profit', value: `${gbp(comb ? p.combinedNet : p.netProfit)}\n${pct(comb ? p.combinedMargin : p.margin)} margin`, inline: true },
    { name: 'Payouts banked', value: `${gbp(c.amazonPayouts + c.ebayPayouts)}\nmoney out ${gbp(c.moneyOut)}`, inline: true },
  ];
  if (mp.hasTarget) {
    const t = (x, label) => (x.target === null ? '' : `${label}: ${gbp(x.have)} of ${gbp(x.target)} (${pct(x.pct)})${x.perDayNeeded !== null && mp.left ? ` · need ${gbp(x.perDayNeeded)}/day` : ''}`);
    fields.push({ name: `${D(`${month}-15`).toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' })} target`, value: [t(mp.sales, 'Sales'), t(mp.profit, 'Profit')].filter(Boolean).join('\n') || '—', inline: false });
  }
  if (fc.ok) fields.push({ name: 'Bank balance', value: `${gbp(fc.open.amount)} on ${day(fc.open.date)}\nforecast in 30 days: ${gbp(fc.in30)} · lowest ${gbp(fc.low.balance)} (${day(fc.low.date)})`, inline: false });
  if (safe) {
    const next = ps.preds?.[0];
    const planned = new Set(matchToBank(expectedItems(data.expenses || [], { from: addDays(today, -60), to: today, subscriptions: subs.confirmed }), data.txns, { today }).filter((x) => x.txnId).map((x) => x.txnId));
    fields.push({ name: 'This week\'s budget', value: `Safe to spend ${gbp(safe.perDay)} a day · stock allowance ${gbp(Math.max(0, safe.weekly - otherWeekly(data.txns, { to: newestBank || today, planned })))} this week${next ? `\nNext Amazon payout about ${gbp(next.amount)} on ${day(next.date)}` : ''}`, inline: false });
  }
  fields.push({ name: 'Coming up this week', value: coming.length ? coming.slice(0, 8).map((x) => `${day(x.date)} · ${x.vendor} ${gbp(x.amount)}${x.paidFrom === 'personal' ? ' (personal)' : ''}`).join('\n') : 'Nothing scheduled', inline: false });
  fields.push({ name: 'Needs attention', value: attention.length ? attention.join('\n') : '✅ Nothing, all in order', inline: false });
  for (const f of fields) if (f.value.length > 1000) f.value = `${f.value.slice(0, 997)}…`;

  const stale = [newestOrder && newestOrder < w.to ? `${data.salesLabel || 'SellerToolkit'} orders up to ${day(newestOrder)}` : '', newestBank && newestBank < w.to ? `bank up to ${day(newestBank)}` : ''].filter(Boolean);
  lines.push(stale.length ? `Data: ${stale.join(', ')}. Import newer files for the full week.` : '');
  return {
    username: "Niall's Toolkit",
    embeds: [{
      title: `Weekly summary · ${day(w.from)} – ${day(w.to)}`, color: (comb ? p.combinedNet : p.netProfit) >= 0 ? 0x2e9e5b : 0xd04545,
      description: lines.filter(Boolean).join('\n') || undefined, fields, footer: { text: "Niall's Toolkit · FBA Admin" }, timestamp: new Date(`${today}T08:00:00Z`).toISOString(),
    }],
    _week: w,
  };
}

export function payoutOpts(s) {
  return { mode: s.cfPayoutMode || 'auto', amount: s.cfPayoutAmount, every: s.cfPayoutEvery, next: s.cfPayoutNext };
}
