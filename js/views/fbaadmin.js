// FBA Admin: dashboard, bank transactions (categorise + fix-and-learn), sold products, import, rules, settings / Google Sheets.
import { loadAll, store, getSettings, saveSettings, saveRules, migrate, setTick } from '../fbaadmin/store.js';
import { guideStatus, overdueCount } from '../fbaadmin/guide.js';
import { FA_FORMATS } from '../fbaadmin/formats.js';
import { applyImport, sfSkuCosts } from '../fbaadmin/importer.js';
import { compute, cash, presetRange, previousRange, vatGauge, subscriptionsAnnual, stockAtCost } from '../fbaadmin/pnl.js';
import { CATEGORIES, ALL_CATEGORIES, EXCLUDED_FROM_PNL, DEFAULT_RULES, suggestCategory, recategorise, ruleKeyword } from '../fbaadmin/categories.js';
import { syncNow, autoSync, pullCategories, overheadSourceFor } from '../fbaadmin/sync.js';
import { getToken, signOut, isSignedIn, redirectUrl } from '../fbaadmin/google.js';
import { parseRows, remap, FORMATS as RT_FORMATS } from '../returns/parse.js';
import { applyImport as rtApplyImport } from '../returns/importer.js';
import { store as rtStore, getSettings as rtGetSettings, syncRefunds as rtSyncRefunds } from '../returns/store.js';
import { stockReport, salesCrossCheck } from '../fbaadmin/stock.js';
import { reconcilePayouts, accountLines } from '../fbaadmin/settlement.js';
import { detectSubscriptions, mergeSubscriptions, prettyPayee } from '../fbaadmin/subscriptions.js';
import { dlaStatement } from '../fbaadmin/yearend.js';
import { buildYearEnd, dlaOpeningAt } from '../fbaadmin/yearpack.js';
import { invoiceName, uniqueName, suggestLinks, missingReceipts } from '../fbaadmin/invoices.js';
import { uploadInvoice, uploadPendingInvoices } from '../fbaadmin/sync.js';
import { FREQUENCIES, expectedItems, matchToBank, monthGrid, shiftMonth, perYear, vendorSlug } from '../fbaadmin/expenses.js';
import { forecast, ctDueDate, openingBalance } from '../fbaadmin/cashflow.js';
import { payoutSetup, safeToSpend, inAmazon, otherWeekly, dailySpend, addDays, WEEKDAYS, matchSpendLog, spendEvents } from '../fbaadmin/cashplan.js';
import { agedReport } from '../fbaadmin/aged.js';
import { monthProgress, nextMonths, targetFor } from '../fbaadmin/targets.js';
import { buildWeekly } from '../fbaadmin/weekly.js';
import { buildPack } from '../fbaadmin/pack.js';
import { DLA_TYPES, sourceOf, balanceSeries } from '../fbaadmin/dla.js';
import { history, rates, plan, cashEvents, periods } from '../fbaadmin/stockvalue.js';
import { IS_EXT } from '../platform.js';
import { googleSetupSteps } from './sync.js';
import { followUpsDue } from '../outreach/analysis.js';
import { icon, toast, modal, confirmBox, sortable, emptyState, profitClass } from '../ui.js';
import { readTabularFile } from '../xlsx.js';
import { esc, num, pct, money, toCSV, downloadFile } from '../util.js';

const TABS = [['dashboard', 'Dashboard'], ['transactions', 'Transactions'], ['expenses', 'Expenses'], ['cashflow', 'Cash flow'], ['stockvalue', 'Stock value'], ['products', 'Sold products'], ['stock', 'Stock'], ['payouts', 'Payouts & fees'], ['invoices', 'Invoices'], ['subscriptions', 'Subscriptions'], ['dla', "Director's loan"], ['yearend', 'Year end'], ['import', 'Import'], ['guide', 'Reports guide'], ['rules', 'Category rules'], ['settings', 'Settings & Google Sheets']];
const PRESETS = [['this_month', 'This month'], ['last_month', 'Last month'], ['last_3_months', 'Last 3 months'], ['ytd', 'Year to date'], ['this_fy', 'This financial year'], ['last_fy', 'Last financial year'], ['all', 'All time'], ['custom', 'Custom…']];
const ui = { tab: 'dashboard', basis: 'amazon', yePeriod: 'this_fy', invStaged: [], preset: 'last_3_months', from: '', to: '', q: '', cat: '', dir: '', staged: [], tFrom: '', tTo: '' };
const today = () => new Date().toISOString().slice(0, 10);
// SellerToolkit, SellerFuse, or both around the cut-over date (sources.js): used in labels
const SRC = () => ui.src || 'SellerToolkit';
const dstr =(d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—');
const kpi = (label, value, sub = '', cls = '', href = '') => `<${href ? `a href="${href}"` : 'div'} class="kpi${href ? ' kpi-link' : ''}"><div class="label">${label}</div><div class="value ${cls}">${value}</div><div class="sub">${sub}</div></${href ? 'a' : 'div'}>`;
const delta = (cur, prev, { invert = false } = {}) => {
  if (prev === null || prev === undefined || !Number.isFinite(prev) || (prev === 0 && cur === 0)) return '';
  const d = cur - prev;
  if (Math.abs(d) < 0.005) return '<span class="muted">same as before</span>';
  const good = invert ? d < 0 : d > 0;
  return `<span class="${good ? 'pos' : 'neg'}">${d > 0 ? '▲' : '▼'} ${money(Math.abs(d))}</span> vs previous`;
};

function range(settings) {
  return presetRange(ui.preset, { fyStart: settings.fyStart, from: ui.from, to: ui.to });
}

export async function render(root, ctx) {
  if (ctx?.sub) {
    const [tab, extra] = ctx.sub.split('/');
    if (TABS.some(([id]) => id === tab)) ui.tab = tab;
    if (tab === 'transactions' && extra) { ui.cat = extra === 'uncategorized' ? 'Uncategorized' : ''; ui.dir = extra === 'in' ? 'in' : extra === 'out' ? 'out' : ''; }
    // app shortcuts: #fbaadmin/invoices/camera, #fbaadmin/cashflow/log (the address is tidied so a redraw doesn't repeat it)
    if (extra === 'camera') ui.cameraHint = true;
    if (extra === 'log') ui.openSpendLog = true;
    if (extra === 'camera' || extra === 'log') window.history.replaceState(null, '', `#fbaadmin/${tab}`); // (`history` here is stock value's)
  }
  const migrated = await migrate();
  if (migrated) toast(`Updated ${migrated} bank line${migrated === 1 ? '' : 's'} to your latest category rules`, 'info', 6000);
  const data = await loadAll();
  ui.src = data.salesLabel;
  const rerender = async () => { await render(root, { ...ctx, sub: ui.tab }); ctx?.refreshBadges?.(); };
  const unc = data.txns.filter((t) => t.category === 'Uncategorized').length;
  const guide = guideStatus(data, { fyFrom: presetRange('this_fy', { fyStart: data.settings.fyStart }).from });
  data.guide = guide;
  const dueN = overdueCount(guide);
  root.innerHTML = `
    <div class="tabs">${TABS.map(([id, l]) => `<a class="tab ${ui.tab === id ? 'active' : ''}" href="#fbaadmin/${id}">${l}${id === 'transactions' && unc ? `<span class="count">${unc}</span>` : ''}${id === 'guide' && dueN ? `<span class="count">${dueN}</span>` : ''}</a>`).join('')}</div>
    <div id="faBody"></div>`;
  const body = root.querySelector('#faBody');
  const empty = !data.txns.length && !data.orders.length;
  if (empty && !data.ledger.length && ['dashboard', 'transactions', 'products', 'stock'].includes(ui.tab)) {
    ui.tab = ui.tab === 'dashboard' ? 'guide' : ui.tab;
    if (ui.tab === 'guide') { root.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.getAttribute('href') === '#fbaadmin/guide')); await renderGuide(body, data, rerender, { firstRun: true }); return; }
    body.innerHTML = emptyState('chart', 'Nothing imported yet', 'Import a <b>bank statement CSV</b> (Revolut Business → Statement → CSV) and your SellerToolkit <b>Orders – Detailed</b>, <b>Expenses</b> and <b>Cost of Goods</b> exports. Bank lines are categorised automatically, and you can fix any that are wrong.', '<a class="btn primary" href="#fbaadmin/import">Import files</a>');
    return;
  }
  const views = { dashboard: renderDashboard, transactions: renderTransactions, expenses: renderExpenses, cashflow: renderCashflow, stockvalue: renderStockValue, dla: renderDla, products: renderProducts, stock: renderStock, payouts: renderPayouts, invoices: renderInvoices, subscriptions: renderSubscriptions, yearend: renderYearEnd, import: renderImport, guide: renderGuide, rules: renderRules, settings: renderSettings };
  await views[ui.tab](body, data, rerender);
}

function periodBar(data, rerender, extra = '') {
  return `<div class="row" style="margin-bottom:14px">
    <select id="preset">${PRESETS.map(([v, l]) => `<option value="${v}" ${ui.preset === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <span id="customRange" ${ui.preset === 'custom' ? '' : 'hidden'}><input type="date" id="pFrom" value="${ui.from}"> – <input type="date" id="pTo" value="${ui.to}"></span>
    <span class="small muted">${esc(range(data.settings).label)}</span>${extra}</div>`;
}
function wirePeriod(body, rerender) {
  body.querySelector('#preset').onchange = (e) => { ui.preset = e.target.value; if (ui.preset === 'custom' && !ui.from) { ui.from = `${today().slice(0, 8)}01`; ui.to = today(); } rerender(); };
  const f = body.querySelector('#pFrom'); const t = body.querySelector('#pTo');
  if (f) f.onchange = (e) => { ui.from = e.target.value; rerender(); };
  if (t) t.onchange = (e) => { ui.to = e.target.value; rerender(); };
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
function renderDashboard(body, data, rerender) {
  const s = data.settings;
  const r = range(s);
  const prev = previousRange(r);
  const src = overheadSourceFor(data, r.from, r.to, s.overheadSource);
  const p = compute(data, { from: r.from, to: r.to, overheadSource: src, allocate: s.allocate });
  const ppRaw = ui.preset === 'all' ? null : compute(data, { from: prev.from, to: prev.to, overheadSource: overheadSourceFor(data, prev.from, prev.to, s.overheadSource), allocate: s.allocate });
  const c = cash(data.txns, r.from, r.to);
  const pcRaw = ui.preset === 'all' ? null : cash(data.txns, prev.from, prev.to);
  // only compare against a previous period that actually has data
  const pp = ppRaw && ppRaw.orders ? ppRaw : null;
  const pc = pcRaw && pcRaw.count ? pcRaw : null;
  // VAT turnover is the whole business: Amazon (SellerToolkit) + eBay sales
  const ebayTurnover = data.ebaySales.filter((l) => l.kind === 'sale' && l.date).map((l) => ({ date: new Date(l.date).toISOString().slice(0, 10), v: l.gross || 0 }));
  const v = vatGauge(data.orders, { threshold: Number(s.vatThreshold) || 90000, extraTurnover: ebayTurnover });
  const subsM = mergeSubscriptions(detectSubscriptions(data.txns), data.subsSaved);
  const subs = subsM.confirmed.length ? subsM.annual : subscriptionsAnnual(data.txns);
  const dlaNow = dlaStatement(data.dlaTxns || data.txns, { opening: dlaOpeningAt(data, presetRange('this_fy', { fyStart: s.fyStart }).from).opening, from: presetRange('this_fy', { fyStart: s.fyStart }).from, to: today() });
  const payRec = reconcilePayouts(data.settlements, data.txns);
  const comb = ui.basis === 'combined';
  const sr = stockReport(data);
  const sacEst = stockAtCost(data.stock, data.orders);
  const sac = sr.asOf ? { value: sr.totals.value, units: sr.totals.sellable, asOf: sr.asOf } : sacEst;
  const adSpend = c.outByCat['Ad Spend'] || 0;
  const unc = data.txns.filter((t) => t.category === 'Uncategorized');
  const lastBank = data.txns[0]?.date; const lastOrder = data.orders[0]?.date;
  const stale = (d) => d && (Date.parse(today()) - Date.parse(d)) / 864e5 > 10;
  const thisMonth = today().slice(0, 7);
  const importedThisMonth = new Set(data.imports.filter((i) => String(i.at).slice(0, 7) === thisMonth).map((i) => i.reportType === 'revolut' ? 'bank' : i.reportType));
  const missingReports = [['bank', 'Bank statement'], ['stk_orders', 'SellerToolkit orders'], ['stk_expenses', 'SellerToolkit expenses']].filter(([k]) => !importedThisMonth.has(k)).map(([, l]) => l);
  const hasBankInRange = c.count > 0;
  const hasOrdersInRange = p.orders > 0;
  const attention = [
    unc.length ? `<li><a href="#fbaadmin/transactions/uncategorized"><b>${unc.length}</b> bank transaction${unc.length === 1 ? '' : 's'} not categorised</a></li>` : '',
    p.noCogsUnits ? `<li><b>${p.noCogsUnits}</b> unit${p.noCogsUnits === 1 ? '' : 's'} sold with no COGS (${p.noCogsSkus.slice(0, 4).map(esc).join(', ')}${p.noCogsSkus.length > 4 ? '…' : ''}). Add costs in SellerToolkit and re-import, or profit is overstated.</li>` : '',
    stale(lastBank) ? `<li>Latest bank line is from <b>${dstr(lastBank)}</b>. Import a newer statement.</li>` : '',
    stale(lastOrder) ? `<li>Latest ${SRC()} order is from <b>${dstr(lastOrder)}</b>. Import a newer orders export.</li>` : '',
    (() => {
      const due = (data.guide || []).filter((g) => g.status === 'overdue' || g.status === 'due');
      return due.length ? `<li><a href="#fbaadmin/guide"><b>${due.length}</b> report${due.length === 1 ? '' : 's'} to download</a>: ${due.slice(0, 4).map((g) => esc(g.label.replace(/^(Amazon|SellerToolkit|SellerFuse) · /, ''))).join(', ')}${due.length > 4 ? '…' : ''}</li>` : '';
    })(),
    payRec.unmatched.length ? `<li><a href="#fbaadmin/payouts"><b>${payRec.unmatched.length}</b> Amazon payout${payRec.unmatched.length === 1 ? '' : 's'} not found in the bank</a>. Import the bank statement for those dates, or check the account they went to.</li>` : '',
    subsM.candidates.length ? `<li><a href="#fbaadmin/subscriptions"><b>${subsM.candidates.length}</b> possible subscription${subsM.candidates.length === 1 ? '' : 's'} to confirm</a></li>` : '',
    (() => { const due = followUpsDue(data.suppliers || [], today()); return due.length ? `<li><a href="#outreach/overview"><b>${due.length}</b> supplier follow-up${due.length === 1 ? '' : 's'} due</a>: ${due.slice(0, 3).map((x) => esc(x.company)).join(', ')}${due.length > 3 ? '…' : ''}</li>` : ''; })(),
    ...subsM.confirmed.filter((x) => x.priceChange).map((x) => `<li><a href="#fbaadmin/subscriptions">${esc(x.name)} went up from ${money(x.priceChange.from)} to ${money(x.priceChange.to)}</a></li>`),
    (() => {
      if (!data.invoices.length) return '';
      const fy = presetRange('this_fy', { fyStart: s.fyStart });
      const m = missingReceipts(data.txns, data.invoices, { from: fy.from, to: fy.to });
      return m.rows.length ? `<li><a href="#fbaadmin/invoices"><b>${m.rows.length}</b> cost${m.rows.length === 1 ? '' : 's'} this year with no receipt attached</a> (${money(m.total)})</li>` : '';
    })(),
    (() => { const a = agedFor(data); return a.totals.charged || a.totals.soon ? `<li><a href="#fbaadmin/stock">${a.totals.charged ? `<b>${a.totals.charged}</b> unit${a.totals.charged === 1 ? '' : 's'} paying Amazon's aged stock surcharge` : ''}${a.totals.charged && a.totals.soon ? ', ' : ''}${a.totals.soon ? `<b>${a.totals.soon}</b> reach it soon` : ''}</a>: lower the price or remove them</li>` : ''; })(),
    (() => { const f = cashFlowFor(data, 30); return f.ok && (f.belowZero || f.belowBuffer) ? `<li><a href="#fbaadmin/cashflow">Bank balance forecast ${f.belowZero ? `goes <b>below £0</b> on ${dstr(f.belowZero.date)}` : `drops under your ${money(Number(data.settings.cfBuffer) || 0, '£', 0)} buffer on ${dstr(f.belowBuffer.date)}`}</a></li>` : ''; })(),
    dlaNow.closing < 0 ? `<li><a href="#fbaadmin/yearend">Director's loan is overdrawn by <b>${money(-dlaNow.closing)}</b></a>: you owe the company. Talk to your accountant before the year end.</li>` : '',
    ...['unfulfillable', 'inactive', 'lost', 'received'].flatMap((k) => {
      const hit = sr.rows.filter((x) => x.flags.some((f) => f.kind === k));
      if (!hit.length) return [];
      const label = { unfulfillable: 'unfulfillable stock at Amazon', inactive: 'sellable stock on an inactive listing', lost: 'units lost or damaged by Amazon', received: 'purchases not fully received' }[k];
      return [`<li><a href="#fbaadmin/stock"><b>${hit.length}</b> SKU${hit.length === 1 ? '' : 's'} with ${label}</a>: ${hit.slice(0, 3).map((x) => esc(x.sku)).join(', ')}${hit.length > 3 ? '…' : ''}</li>`];
    }),
  ].filter(Boolean);
  const xcheck = salesCrossCheck(data.salesDash, data.orders, r.from, r.to);

  const vatPct = Math.min(1, v.pct);
  const vatCls = v.pct >= 0.9 ? 'neg' : v.pct >= 0.75 ? 'warn-text' : 'pos';
  const outRows = Object.entries(c.outByCat);
  const maxOut = Math.max(1, ...outRows.map(([, x]) => x));
  body.innerHTML = `
    ${periodBar(data, rerender, `<span class="grow"></span>${s.googleClientId ? `<button class="btn small" id="dashSync">${icon('refresh', 14)} Send to Google Sheet</button>${s.spreadsheetUrl ? ` <a class="btn small ghost" href="${esc(s.spreadsheetUrl)}" target="_blank" rel="noopener">${icon('external', 14)} Open sheet</a>` : ''}` : `<a class="btn small" href="#fbaadmin/settings">${icon('globe', 14)} Set up Google Sheets</a>`}`)}
    ${weeklyCard(data)}
    ${!hasOrdersInRange && hasBankInRange ? `<div class="callout warn small" style="margin-bottom:12px">No ${SRC()} orders in this period, so the P&L only shows overheads. Import an orders export covering these dates.</div>` : ''}
    ${hasOrdersInRange && p.overheadsFromExpenses ? `<div class="callout small" style="margin-bottom:12px">Overheads come from ${esc(p.overheadsFrom)}: months without bank lines use your ${esc(data.expensesLabel)}. Import older bank statements to use the bank for every month.</div>` : ''}
    ${attention.length ? `<div class="callout warn" style="margin-bottom:14px"><b>Needs attention</b><ul style="margin:6px 0 0 18px">${attention.join('')}</ul></div>` : ''}

    <div class="row section"><h4 class="grow">Profit &amp; loss</h4>
      <div class="seg" role="group"><button class="btn small ${comb ? '' : 'primary'}" data-basis="amazon">Amazon only</button><button class="btn small ${comb ? 'primary' : ''}" data-basis="combined">Amazon + eBay</button></div></div>
    <div class="kpis" style="margin-top:8px">
      ${comb ? kpi('Revenue (Amazon + eBay)', money(p.combinedRevenue), `Amazon ${money(p.revenue)} · eBay ${money(p.ebay.revenue)}`) : kpi('Revenue', money(p.revenue), pp ? delta(p.revenue, pp.revenue) : `${num(p.orders)} order lines`, '', '#fbaadmin/products')}
      ${kpi('Amazon fees + VAT', money(-(p.fees + p.vatOnFees)), `fees ${money(p.fees)} · VAT ${money(p.vatOnFees)}`)}
      ${kpi('COGS', money(-p.cogs), `${num(p.units)} units sold`)}
      ${kpi(`${SRC()} profit`, money(p.stkProfit), 'after fees, COGS, VAT on fees, refunds', profitClass(p.stkProfit))}
      ${data.fees.length ? kpi('Amazon account fees', money(-p.accountFees), Object.entries(p.accountFeesByType).slice(0, 2).map(([k, x]) => `${esc(k)} ${money(x)}`).join(' · ') || 'storage, subscription, removals…', '', '#fbaadmin/payouts') : kpi('Amazon account fees', '—', 'import a settlement report', 'muted', '#fbaadmin/guide')}
      ${p.reimbursements ? kpi('Reimbursements', money(p.reimbursements), 'paid by Amazon', 'pos', '#fbaadmin/payouts') : ''}
      ${kpi('Overheads', money(-p.overheads), `from ${esc(p.overheadsFrom)}`)}
      ${kpi('Returns loss', money(p.returnsLoss), 'settled units, Returns tracker', profitClass(p.returnsLoss), '#returns/overview')}
      ${comb ? kpi('eBay profit', money(p.ebay.profit), `${num(p.ebay.units)} units · after COGS`, profitClass(p.ebay.profit), '#ebay') : ''}
      ${comb ? kpi('Net profit (Amazon + eBay)', money(p.combinedNet), pp ? delta(p.combinedNet, pp.combinedNet) : '', profitClass(p.combinedNet)) : kpi('Net profit', money(p.netProfit), pp ? delta(p.netProfit, pp.netProfit) : '', profitClass(p.netProfit))}
      ${kpi('Net margin', (comb ? p.combinedMargin : p.margin) === null ? '—' : pct(comb ? p.combinedMargin : p.margin, 1), 'net profit ÷ revenue')}
    </div>

    ${targetCard(data)}
    <h4 class="section">Cash (bank)</h4>
    <div class="kpis" style="margin-top:8px">
      ${kpi('Money in', money(c.moneyIn), pc ? delta(c.moneyIn, pc.moneyIn) : `${num(c.count)} transactions`, '', '#fbaadmin/transactions/in')}
      ${kpi('Money out', money(-c.moneyOut), pc ? delta(c.moneyOut, pc.moneyOut, { invert: true }) : '', '', '#fbaadmin/transactions/out')}
      ${kpi('Net cash flow', money(c.net), '', profitClass(c.net))}
      ${kpi('Amazon payouts', money(c.amazonPayouts), c.ebayPayouts ? `+ eBay ${money(c.ebayPayouts)}` : 'received in the bank')}
      ${(() => { const b = budgetFor(data); return b.ok ? kpi('Safe to spend today', money(b.safe.perDay), `stock allowance ${money(b.stockWeekly, '£', 0)} this week`, b.safe.perDay > 0 ? 'pos' : 'neg', '#fbaadmin/cashflow') : ''; })()}
    </div>

    <h4 class="section">Health</h4>
    <div class="kpis" style="margin-top:8px">
      ${kpi('Return rate', p.returnRate === null ? '—' : pct(p.returnRate, 1), `${num(p.refundedUnits)} of ${num(p.shipped)} units refunded`)}
      ${kpi('Avg net per unit', p.units ? money(p.netProfit / p.units) : '—', 'after overheads and returns')}
      ${kpi('Stock at cost', money(sac.value), sac.asOf ? `${num(sac.units)} sellable at Amazon on ${dstr(sac.asOf)}${sr.totals.unfulfillable ? ` · ${sr.totals.unfulfillable} unfulfillable` : ''}` : `${num(sac.units)} units bought, not yet sold (estimate)`, '', '#fbaadmin/stock')}
      ${kpi('Subscriptions', `${money(subs)}/yr`, subsM.confirmed.length ? `${subsM.confirmed.length} confirmed · ${money(subsM.monthly)}/month` : subsM.candidates.length ? `estimate · confirm ${subsM.candidates.length} found` : 'last 90 days × 4', '', '#fbaadmin/subscriptions')}
      ${kpi("Director's loan", money(Math.abs(dlaNow.closing)), dlaNow.closing >= 0 ? 'the company owes you' : 'you owe the company', dlaNow.closing < 0 ? 'neg' : '', '#fbaadmin/dla')}
      ${kpi('Ad spend (TACoS)', p.revenue ? pct(adSpend / p.revenue, 1) : '—', `${money(adSpend)} from the bank`)}
    </div>

    <div class="grid2 section">
      <div class="card card-pad stack">
        <h3>VAT threshold</h3>
        <div class="row"><b class="${vatCls}" style="font-size:22px">${money(v.rolling, '£', 0)}</b><span class="muted">of ${money(v.threshold, '£', 0)} in the last 12 months (${pct(v.pct, 1)})</span></div>
        <div class="vat-bar"><span style="width:${Math.round(vatPct * 100)}%;${v.pct >= 0.9 ? 'background:var(--neg)' : v.pct >= 0.75 ? 'background:var(--warn)' : ''}"></span></div>
        <p class="small muted">At your last-3-months pace of ${money(v.perMonth)}/month, ${v.crossInMonths === 0 ? '<b class="neg">you are over the threshold</b>' : v.crossInMonths ? `you'd reach it in about <b>${v.crossInMonths} months</b>` : 'there is no recent turnover to project from'}. Turnover counted here is your Amazon sales (${SRC()}) plus eBay sales${s.vatRegistered ? '' : '. You are set as not VAT registered'}.</p>
      </div>
      <div class="card">
        <div class="toolbar"><b>Money out by category</b><span class="small muted">${esc(r.label)}</span></div>
        <table class="data"><tbody>${outRows.map(([k, x]) => `<tr><td><a href="#fbaadmin/transactions" data-cat="${esc(k)}">${esc(k)}</a>${EXCLUDED_FROM_PNL.has(k) ? ' <span class="tag" title="Not an overhead: costed through COGS or not an expense">not P&L</span>' : ''}</td>
          <td style="width:40%"><div class="bar-cell"><div class="bar-track"><span style="width:${Math.round((x / maxOut) * 100)}%"></span></div></div></td><td class="r num">${money(x)}</td></tr>`).join('') || '<tr><td class="empty">No bank lines in this period</td></tr>'}</tbody></table>
      </div>
    </div>

    ${xcheck.length ? `<div class="card section"><div class="toolbar"><b>Amazon vs ${SRC()} sales</b><span class="small muted">Amazon's Sales Dashboard counts orders placed (including cancelled, refunded and not yet shipped); ${SRC()} counts what shipped</span></div>
      <div class="table-wrap"><table class="data"><thead><tr><th>Month</th><th class="r">Amazon ordered sales</th><th class="r">Units ordered</th><th class="r">${SRC()} revenue</th><th class="r">Difference</th></tr></thead><tbody>
      ${xcheck.map((x) => `<tr><td>${esc(new Date(`${x.month}-15T12:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }))}</td><td class="r num">${money(x.amazon)}</td><td class="r num">${num(x.amazonUnits)}</td><td class="r num">${money(x.stk)}</td><td class="r num ${Math.abs(x.diff) > Math.max(50, x.amazon * 0.1) ? 'warn-text' : 'muted'}">${money(x.diff)}</td></tr>`).join('')}
      </tbody></table></div></div>` : ''}
    <div class="grid2 section">
      ${productList('Best 5 products', p.products.slice(0, 5))}
      ${productList('Worst 5 products', [...p.products].reverse().slice(0, 5))}
    </div>
    ${Object.keys(p.overheadsByCat).length ? `<div class="card section"><div class="toolbar"><b>Overheads</b><span class="small muted">from ${esc(p.overheadsFrom)}</span></div>
      <table class="data"><tbody>${Object.entries(p.overheadsByCat).map(([k, x]) => `<tr><td>${esc(k)}</td><td class="r num">${money(x)}</td></tr>`).join('')}<tr><td><b>Total</b></td><td class="r num"><b>${money(p.overheads)}</b></td></tr></tbody></table></div>` : ''}`;
  wirePeriod(body, rerender);
  const wkc = body.querySelector('#wkCard'); if (wkc) wkc.ontoggle = () => { ui.weeklyOpen = wkc.open; };
  body.querySelectorAll('[data-basis]').forEach((b) => { b.onclick = () => { ui.basis = b.dataset.basis; rerender(); }; });
  const ds = body.querySelector('#dashSync');
  if (ds) ds.onclick = async () => {
    ds.disabled = true; ds.textContent = 'Sending…';
    try {
      try { await getToken(s.googleClientId); } catch { await getToken(s.googleClientId, { interactive: true }); }
      const r = await syncNow({ interactive: true });
      toast(`${r.created ? 'Created your FBA Accounting spreadsheet' : 'Google Sheet updated'} · ${Object.keys(r.written).length} tabs`, 'success', 6000);
    } catch (e) { toast(e.message, 'error', 8000); }
    rerender();
  };
  body.querySelectorAll('[data-cat]').forEach((a) => { a.onclick = () => { ui.cat = a.dataset.cat; ui.dir = ''; ui.tFrom = r.from; ui.tTo = r.to; }; });
}

// "Last week": the weekly summary (it used to go to Discord), at the top of the dashboard on every device.
function weeklyCard(data) {
  let e;
  try { e = buildWeekly(data, { today: today(), basis: ui.basis }).embeds[0]; } catch { return ''; }
  const br = (t) => esc(t).replace(/\n/g, '<br>');
  return `<details class="card card-pad weekly" ${ui.weeklyOpen === false ? '' : 'open'} id="wkCard"><summary><b>Last week</b> <span class="small muted">${esc(e.title.replace(/^Weekly summary · /, ''))}</span></summary>
    ${e.description ? `<p class="small muted" style="margin-top:8px">${br(e.description)}</p>` : ''}
    <div class="weekly-grid">${e.fields.map((f) => `<div class="${f.inline ? '' : 'wide'}"><div class="small muted">${esc(f.name)}</div><div class="small">${br(f.value)}</div></div>`).join('')}</div></details>`;
}

function productList(title, list) {
  return `<div class="card"><div class="toolbar"><b>${title}</b><span class="small muted">actual net after overheads and returns</span></div>
    <table class="data"><tbody>${list.map((x) => `<tr><td><div style="max-width:340px"><b class="small">${esc((x.title || x.sku).slice(0, 70))}</b><div class="small muted mono">${esc(x.sku)} · ${num(x.units)} units</div></div></td>
      <td class="r num ${profitClass(x.actualNet)}">${money(x.actualNet)}<div class="small muted">${x.perUnit === null ? '' : `${money(x.perUnit)}/unit`}</div></td></tr>`).join('') || '<tr><td class="empty">No sales in this period</td></tr>'}</tbody></table></div>`;
}

// ---------------------------------------------------------------------------
// Transactions: categorise, fix, learn
// ---------------------------------------------------------------------------
function renderTransactions(body, data, rerender) {
  const catOptions = (dir, selected) => (dir === 'in' ? CATEGORIES.in : CATEGORIES.out).map((c) => `<option ${c === selected ? 'selected' : ''}>${esc(c)}</option>`).join('');
  body.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <input type="search" id="q" placeholder="Search description or reference" value="${esc(ui.q)}" style="width:220px">
        <select id="cat"><option value="">All categories</option>${ALL_CATEGORIES.map((c) => `<option ${ui.cat === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
        <select id="dir"><option value="">In and out</option><option value="in" ${ui.dir === 'in' ? 'selected' : ''}>Money in</option><option value="out" ${ui.dir === 'out' ? 'selected' : ''}>Money out</option></select>
        <input type="date" id="tf" value="${ui.tFrom}" title="From"><input type="date" id="tt" value="${ui.tTo}" title="To">
        <span class="grow"></span><span class="small muted" id="cnt"></span>
        <button class="btn small" id="exp">${icon('download', 14)} CSV</button>
      </div>
      <div class="toolbar" id="bulkBar" hidden>
        <b class="small" id="selN"></b>
        <select id="bulkCat">${ALL_CATEGORIES.map((c) => `<option>${esc(c)}</option>`).join('')}</select>
        <button class="btn small primary" id="bulkGo">Set category</button>
      </div>
      <div class="table-wrap"><table class="data" id="tt2"><thead><tr>
        <th style="width:28px"><input type="checkbox" id="all"></th><th data-sort="date">Date</th><th data-sort="description" data-first="asc">Description</th><th data-sort="amount" class="r">Amount</th><th>Category</th><th>Set by</th><th title="Invoice or receipt">${icon('clip', 14)}</th>
      </tr></thead><tbody></tbody></table></div>
      <input type="file" id="txFile" accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/*" hidden>
    </div>`;
  const invByTxn = new Map(data.invoices.filter((i) => i.linkedTo?.kind === 'txn').map((i) => [i.linkedTo.id, i]));
  const filtered = () => data.txns.filter((t) => (!ui.cat || t.category === ui.cat) && (!ui.dir || (ui.dir === 'in' ? t.amount > 0 : t.amount < 0))
    && (!ui.tFrom || t.date >= ui.tFrom) && (!ui.tTo || t.date <= ui.tTo)
    && (!ui.q || `${t.description} ${t.reference}`.toLowerCase().includes(ui.q.toLowerCase())));
  const by = { manual: '<span class="tag new">You</span>', rule: '<span class="tag">Rule</span>', default: '<span class="tag warn">Guess</span>' };
  const rowHtml = (t) => `<tr data-id="${esc(t.id)}"><td><input type="checkbox" data-sel></td><td class="small nowrap">${dstr(t.date)}</td>
    <td><b class="small">${esc(t.description)}</b>${t.reference ? `<div class="small muted">${esc(t.reference)}</div>` : ''}</td>
    <td class="r num ${t.amount > 0 ? 'pos' : ''}">${money(t.amount)}</td>
    <td><select data-cat class="${t.category === 'Uncategorized' ? 'warn-border' : ''}">${catOptions(t.amount > 0 ? 'in' : 'out', t.category)}</select></td>
    <td title="${t.ruleKeyword ? `rule: ${esc(t.ruleKeyword)}` : ''}">${by[t.categorySource] || ''}</td>
    <td>${invByTxn.has(t.id) ? `<button class="icon-btn pos" data-inv title="${esc(invByTxn.get(t.id).fileName)}">${icon('clip', 15)}</button>` : t.amount < 0 ? `<button class="icon-btn muted" data-attach title="Attach invoice or receipt">${icon('clip', 15)}</button>` : ''}</td></tr>`;
  const table = body.querySelector('#tt2');
  const count = (list) => {
    const inn = list.filter((t) => t.amount > 0).reduce((a, t) => a + t.amount, 0);
    const out = list.filter((t) => t.amount < 0).reduce((a, t) => a - t.amount, 0);
    body.querySelector('#cnt').innerHTML = `${num(list.length)} · in <b>${money(inn)}</b> · out <b>${money(out)}</b>`;
  };
  const sorter = sortable(table, filtered(), rowHtml, { defaultKey: 'date', defaultDir: 'desc', onSort: count });
  const redraw = () => { sorter.redraw(filtered()); updateBulk(); };
  body.querySelector('#q').oninput = (e) => { ui.q = e.target.value; redraw(); };
  body.querySelector('#cat').onchange = (e) => { ui.cat = e.target.value; redraw(); };
  body.querySelector('#dir').onchange = (e) => { ui.dir = e.target.value; redraw(); };
  body.querySelector('#tf').onchange = (e) => { ui.tFrom = e.target.value; redraw(); };
  body.querySelector('#tt').onchange = (e) => { ui.tTo = e.target.value; redraw(); };
  body.querySelector('#exp').onclick = () => downloadFile(`bank-transactions-${today()}.csv`, toCSV([['Date', 'Description', 'Reference', 'Amount', 'Balance', 'Category', 'Set by'], ...filtered().map((t) => [t.date, t.description, t.reference, t.amount, t.balance, t.category, t.categorySource])]));

  const selected = () => [...table.querySelectorAll('[data-sel]:checked')].map((c) => c.closest('tr').dataset.id);
  const updateBulk = () => { const n = selected().length; body.querySelector('#bulkBar').hidden = !n; body.querySelector('#selN').textContent = `${n} selected`; };
  body.querySelector('#all').onchange = (e) => { table.querySelectorAll('[data-sel]').forEach((c) => { c.checked = e.target.checked; }); updateBulk(); };
  table.addEventListener('change', async (e) => {
    if (e.target.matches('[data-sel]')) { updateBulk(); return; }
    if (!e.target.matches('[data-cat]')) return;
    const t = data.txns.find((x) => x.id === e.target.closest('tr').dataset.id);
    await fixCategory([t], e.target.value, data, rerender);
  });
  const txFile = body.querySelector('#txFile'); let attachTo = null;
  table.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]'); if (!tr) return;
    if (e.target.closest('[data-attach]')) { attachTo = tr.dataset.id; txFile.click(); }
    else if (e.target.closest('[data-inv]')) { const inv = invByTxn.get(tr.dataset.id); if (inv.dataUrl) openBlob(inv.dataUrl); else if (inv.driveLink) window.open(inv.driveLink, '_blank', 'noopener'); }
  });
  txFile.onchange = async () => { await stageInvoices([...txFile.files], { kind: 'txn', id: attachTo }, data); txFile.value = ''; location.hash = '#fbaadmin/invoices'; };
  body.querySelector('#bulkGo').onclick = async () => {
    const ids = new Set(selected());
    await fixCategory(data.txns.filter((t) => ids.has(t.id)), body.querySelector('#bulkCat').value, data, rerender);
  };
}

// The fix: change the rows, mark them as yours, then offer to make it a rule for that payee.
async function fixCategory(txns, category, data, rerender) {
  const fixed = txns.map((t) => ({ ...t, category, categorySource: 'manual', updatedAt: new Date().toISOString() }));
  await store.putMany('faTransactions', fixed);
  const kw = ruleKeyword(txns[0].description);
  const samePayee = txns.every((t) => ruleKeyword(t.description) === kw);
  const others = data.txns.filter((t) => !txns.includes(t) && t.categorySource !== 'manual' && t.category !== category && suggestCategory(t.description, t.amount, [{ keyword: kw, category }]).source === 'rule');
  const done = () => { autoSync(); rerender(); };
  if (!samePayee || !kw) { toast(`${fixed.length} set to ${category}`, 'success'); done(); return; }
  modal({
    title: 'Make this a rule?',
    body: `<p>Always put <b>${esc(kw)}</b> in <b>${esc(category)}</b>?</p>
      <label class="field">Match transactions containing<input id="kw" value="${esc(kw)}"></label>
      <p class="small muted">${others.length ? `${others.length} other transaction${others.length === 1 ? '' : 's'} would change too.` : 'Future imports will use it.'} Rows you set by hand are never changed by a rule.</p>`,
    actions: [
      { label: 'Just this', onClick: () => { toast(`Set to ${category}`, 'success'); done(); } },
      {
        label: 'Make rule', kind: 'primary', onClick: async (el) => {
          const keyword = el.querySelector('#kw').value.trim().toLowerCase();
          if (!keyword) return false;
          const rules = [{ keyword, category }, ...data.rules.filter((r) => r.keyword.toLowerCase() !== keyword)];
          await saveRules(rules);
          const changed = recategorise(data.txns.filter((t) => !txns.some((x) => x.id === t.id)), rules);
          if (changed.length) await store.putMany('faTransactions', changed);
          toast(`Rule added${changed.length ? ` · ${changed.length} other transaction${changed.length === 1 ? '' : 's'} updated` : ''}`, 'success');
          done();
          return true;
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Sold products
// ---------------------------------------------------------------------------
function renderProducts(body, data, rerender) {
  const s = data.settings;
  const r = range(s);
  const src = overheadSourceFor(data, r.from, r.to, s.overheadSource);
  const p = compute(data, { from: r.from, to: r.to, overheadSource: src, allocate: s.allocate });
  body.innerHTML = `
    ${periodBar(data, rerender, `<span class="grow"></span><label class="small">Share overheads by <select id="alloc"><option value="revenue" ${s.allocate === 'revenue' ? 'selected' : ''}>revenue</option><option value="units" ${s.allocate === 'units' ? 'selected' : ''}>units sold</option></select></label>`)}
    <div class="kpis">
      ${kpi('Units sold', num(p.units), `${num(p.refundedUnits)} refunded`)}
      ${kpi(`${SRC()} profit`, money(p.stkProfit), 'sale − fees − COGS − VAT on fees', profitClass(p.stkProfit))}
      ${kpi('Overheads shared out', money(-p.overheads), `from ${esc(p.overheadsFrom)}`)}
      ${kpi('Returns loss', money(p.returnsLoss), 'from the Returns tracker', profitClass(p.returnsLoss))}
      ${kpi('Actual net', money(p.netProfit), p.units ? `${money(p.netProfit / p.units)} per unit` : '', profitClass(p.netProfit))}
    </div>
    <div class="card section">
      <div class="toolbar"><b>Per product</b><span class="small muted">${SRC()} profit + returns loss − share of overheads = actual net</span><span class="grow"></span><button class="btn small" id="exp">${icon('download', 14)} CSV</button></div>
      <div class="table-wrap"><table class="data" id="pt"><thead><tr>
        <th data-sort="title" data-first="asc">Product</th><th data-sort="units" class="r">Units</th><th data-sort="revenue" class="r">Revenue</th><th data-sort="feesVat" class="r">Fees + VAT</th><th data-sort="cogs" class="r">COGS</th>
        <th data-sort="stkProfit" class="r">STK profit</th><th data-sort="returnsAdj" class="r">Returns</th><th data-sort="overhead" class="r">Overheads</th><th data-sort="actualNet" class="r">Actual net</th><th data-sort="perUnit" class="r">Per unit</th><th data-sort="margin" class="r">Margin</th>
      </tr></thead><tbody></tbody></table></div>
    </div>`;
  wirePeriod(body, rerender);
  body.querySelector('#alloc').onchange = async (e) => { await saveSettings({ allocate: e.target.value }); rerender(); };
  const rows = p.products.map((x) => ({ ...x, feesVat: x.fees + x.vat, title: x.title || x.sku }));
  const rowHtml = (x) => `<tr><td><div style="max-width:340px"><b class="small">${esc(x.title.slice(0, 80))}</b><div class="small muted mono">${esc(x.sku)}${x.noCogs ? ' · <span class="tag warn">no COGS</span>' : ''}</div></div></td>
    <td class="r num">${num(x.units)}${x.refunded ? `<div class="small muted">${x.refunded} refunded</div>` : ''}</td><td class="r num">${money(x.revenue)}</td><td class="r num muted">${money(-x.feesVat)}</td><td class="r num muted">${money(-x.cogs)}</td>
    <td class="r num">${money(x.stkProfit)}</td><td class="r num ${x.returnsAdj ? profitClass(x.returnsAdj) : 'muted'}">${money(x.returnsAdj)}</td><td class="r num muted">${money(-x.overhead)}</td>
    <td class="r num ${profitClass(x.actualNet)}"><b>${money(x.actualNet)}</b></td><td class="r num">${x.perUnit === null ? '—' : money(x.perUnit)}</td><td class="r num">${x.margin === null ? '—' : pct(x.margin, 1)}</td></tr>`;
  sortable(body.querySelector('#pt'), rows, rowHtml, { defaultKey: 'actualNet', defaultDir: 'desc' });
  body.querySelector('#exp').onclick = () => downloadFile(`sold-products-${r.from}_${r.to}.csv`, toCSV([['SKU', 'ASIN', 'Title', 'Units', 'Refunded', 'Revenue', 'Amazon fees', 'VAT on fees', 'COGS', `${SRC()} profit`, 'Returns loss', 'Overhead share', 'Actual net', 'Per unit', 'Margin %'],
    ...p.products.map((x) => [x.sku, x.asin, x.title, x.units, x.refunded, x.revenue, x.fees, x.vat, x.cogs, x.stkProfit, x.returnsAdj, x.overhead, x.actualNet, x.perUnit ?? '', x.margin === null ? '' : Math.round(x.margin * 1000) / 10])]));
}

// ---------------------------------------------------------------------------
// Stock: what you bought, what Amazon received, sold, holds now, and what needs doing
// ---------------------------------------------------------------------------
function renderStock(body, data) {
  const sr = stockReport(data);
  if (!sr.window && !data.stock.length) {
    body.innerHTML = emptyState('store', 'No stock data yet', 'Import Amazon\'s <b>Inventory Ledger</b> (Reports → Fulfilment → Inventory Ledger → Summary view, by location) and your SellerToolkit <b>Cost of Goods</b> export. Add the <b>All Listings</b> report to see listing status and price.', '<a class="btn primary" href="#fbaadmin/import">Import files</a>');
    return;
  }
  const t = sr.totals;
  body.innerHTML = `
    <div class="kpis">
      ${kpi('Sellable at Amazon', num(t.sellable), sr.asOf ? `on ${dstr(sr.asOf)}` : 'import the inventory ledger')}
      ${kpi('Stock at cost', money(t.value), 'sellable units × average purchase cost')}
      ${kpi('Unfulfillable at Amazon', num(t.unfulfillable), t.unfulfillable ? `${money(t.unfulfillableValue)} at cost. Remove or Grade & Resell` : 'none', t.unfulfillable ? 'neg' : '')}
      ${kpi('SKUs needing action', num(t.flagged), 'see the flags below', t.flagged ? 'warn-text' : '')}
    </div>
    ${agedSection(data)}
    ${sr.window ? `<p class="small muted section">Ledger covers ${dstr(sr.window.from)} – ${dstr(sr.window.to)}. Received, returned, removed and lost are counted in that window; "bought" counts every SellerToolkit purchase lot.${data.listings.length ? '' : ' Import the All Listings report to see listing status and price.'}</p>` : '<div class="callout small section">Import the Inventory Ledger to see what Amazon received and holds now.</div>'}
    <div class="card section">
      <div class="toolbar"><b>Per SKU</b><span class="grow"></span><button class="btn small" id="exp">${icon('download', 14)} CSV</button></div>
      <div class="table-wrap"><table class="data" id="st"><thead><tr>
        <th data-sort="sku" data-first="asc">SKU</th><th data-sort="purchased" class="r">Bought</th><th data-sort="received" class="r">Received</th><th data-sort="sold" class="r">Sold</th><th data-sort="customerReturns" class="r">Returned</th><th data-sort="removed" class="r">Removed</th>
        <th data-sort="sellable" class="r">Sellable now</th><th data-sort="unfulfillable" class="r">Unfulfillable</th><th data-sort="value" class="r">Value</th><th>Listing</th><th>Needs doing</th>
      </tr></thead><tbody></tbody></table></div>
    </div>`;
  const rowHtml = (x) => `<tr><td><div style="max-width:300px"><b class="small">${esc((x.title || '').slice(0, 70))}</b><div class="small muted mono">${esc(x.sku)}${x.gradeResell ? ' · <span class="tag">Grade &amp; Resell</span>' : ''}</div></div></td>
    <td class="r num">${x.purchased || '—'}</td><td class="r num">${sr.window ? x.received : '—'}</td><td class="r num">${x.sold}${x.refunded ? `<div class="small muted">${x.refunded} refunded</div>` : ''}</td>
    <td class="r num">${x.customerReturns || ''}</td><td class="r num">${x.removed || ''}</td>
    <td class="r num ${x.sellable ? 'pos' : 'muted'}">${x.sellable}</td><td class="r num ${x.unfulfillable ? 'neg' : 'muted'}" title="${esc(x.places.join(' · '))}">${x.unfulfillable}</td>
    <td class="r num">${x.value === null ? '—' : money(x.value)}</td>
    <td class="small">${x.listingStatus ? `<span class="tag ${/inactive/i.test(x.listingStatus) ? 'gone' : 'new'}">${esc(x.listingStatus)}</span>` : ''}${x.price ? `<div class="muted">${money(x.price)}</div>` : ''}</td>
    <td class="small">${x.flags.map((f) => `<div class="${f.kind === 'unfulfillable' || f.kind === 'lost' ? 'neg' : 'warn-text'}">${esc(f.text)}</div>`).join('') || '<span class="muted">—</span>'}</td></tr>`;
  sortable(body.querySelector('#st'), sr.rows, rowHtml, {});
  body.querySelector('#exp').onclick = () => downloadFile(`stock-check-${today()}.csv`, toCSV([['SKU', 'ASIN', 'Title', 'Bought', 'Received (ledger)', 'Sold', 'Refunded', 'Customer returns', 'Removed', 'Lost/damaged', 'Sellable now', 'Unfulfillable now', 'Where', 'Avg cost', 'Value', 'Listing status', 'Price', 'Needs doing'],
    ...sr.rows.map((x) => [x.sku, x.asin, x.title, x.purchased, x.received, x.sold, x.refunded, x.customerReturns, x.removed, x.lostDamaged, x.sellable, x.unfulfillable, x.places.join('; '), x.avgCost ?? '', x.value ?? '', x.listingStatus, x.price ?? '', x.flags.map((f) => f.text).join('; ')])]));
}

// ---------------------------------------------------------------------------
// Reports guide: where each report lives, what dates to download, what's due
// ---------------------------------------------------------------------------
async function renderGuide(body, data, rerender, { firstRun = false } = {}) {
  const rows = data.guide || guideStatus(data, { fyFrom: presetRange('this_fy', { fyStart: data.settings.fyStart }).from });
  const month = today().slice(0, 7);
  const monthName = new Date(`${month}-15T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const monthly = rows.filter((r) => r.how === 'monthly');
  const done = monthly.filter((r) => r.ticked).length;
  const pill = { overdue: '<span class="tag gone">Overdue</span>', due: '<span class="tag warn">Due</span>', ok: '<span class="tag new">Done</span>', optional: '<span class="tag">Optional</span>' };
  const okLabel = (r) => (r.how === 'when' && !r.ticked ? '<span class="tag">Not needed</span>' : pill.ok);
  const card = (r) => `<div class="card card-pad guide-item status-${r.status}" data-id="${r.id}">
    <div class="row"><b class="grow">${esc(r.label)}</b>${r.status === 'ok' ? okLabel(r) : pill[r.status]}</div>
    <div class="small muted">${esc(r.feeds)}${r.whenText ? ` · <i>${esc(r.whenText)}</i>` : ''}</div>
    <div class="crumbs">${r.where.map((w) => `<span>${esc(w)}</span>`).join('<span class="sep">›</span>')}</div>
    ${r.range ? `<div class="small">Download dates: <b>${dstr(r.range.from)}</b> to <b>${dstr(r.range.to)}</b> <span class="muted">(overlapping what you already have is safe)</span></div>` : ''}
    <div class="small muted">${esc(r.settings)}</div>
    <div class="row small">
      <span class="muted">${r.imported ? `Last imported ${dstr(r.imported)}` : 'Never imported'}${r.covered ? ` · data up to ${dstr(r.covered)}` : ''}</span>
      ${r.why && r.status !== 'ok' ? `<span class="${r.status === 'overdue' ? 'neg' : 'warn-text'}">${esc(r.why)}</span>` : ''}
      <span class="grow"></span>
      ${r.importedThisMonth ? `<span class="pos">✓ imported in ${esc(monthName.split(' ')[0])}</span>` : (r.how !== 'optional' ? `<label class="check"><input type="checkbox" data-tick ${r.manualTick ? 'checked' : ''}> Done / nothing to download this month</label>` : '')}
    </div>
  </div>`;
  body.innerHTML = `
    ${firstRun ? '<div class="callout section" style="margin-top:0">Start here: download the reports below, then drop them all into <b>Import</b> in one go. The extension works out what each file is.</div>' : ''}
    <div class="card card-pad">
      <div class="row"><h3 class="grow">${esc(monthName)}: ${done} of ${monthly.length} monthly reports done</h3><a class="btn primary" href="#fbaadmin/import">${icon('upload')} Go to Import</a></div>
      <div class="vat-bar" style="margin-top:8px"><span style="width:${Math.round((done / Math.max(1, monthly.length)) * 100)}%"></span></div>
      <p class="small muted" style="margin-top:8px">Seller Central moves its menus around. If a path below doesn't match, type the report's name into the search box at the top of Seller Central. Download everything, then import all the files together: returns, removal and reimbursement reports go to the Returns tracker automatically.</p>
    </div>
    <h4 class="section">Every month</h4><div class="guide-list">${monthly.map(card).join('')}</div>
    <h4 class="section">When something happens</h4><div class="guide-list">${rows.filter((r) => r.how === 'when').map(card).join('')}</div>
    <h4 class="section">Optional</h4><div class="guide-list">${rows.filter((r) => r.how === 'optional').map(card).join('')}</div>`;
  body.querySelectorAll('[data-tick]').forEach((c) => {
    c.onchange = async () => { await setTick(month, c.closest('[data-id]').dataset.id, c.checked); rerender(); };
  });
}

// ---------------------------------------------------------------------------
// Payouts & fees: every Amazon payout matched to the bank; the account fees and reimbursements SellerToolkit leaves out
// ---------------------------------------------------------------------------
function renderPayouts(body, data, rerender) {
  if (!data.settlements.length && !data.fees.length) {
    body.innerHTML = emptyState('pound', 'No settlement reports yet', 'Import Amazon\'s <b>Settlement report (V2)</b> for each payout, or one <b>Date Range report</b> (Transaction, CSV) for the whole month. They add the storage, subscription, removal and advertising fees SellerToolkit leaves out, plus reimbursements, and check that every payout reached your bank.', '<a class="btn primary" href="#fbaadmin/import">Import files</a> <a class="btn" href="#fbaadmin/guide">Where to find them</a>');
    return;
  }
  const r = range(data.settings);
  const inR = (d) => d && d >= r.from && d <= r.to;
  const rec = reconcilePayouts(data.settlements.filter((x) => inR(x.depositDate)), data.txns);
  const charged = data.settlements.filter((x) => inR(x.depositDate) && x.total < 0);
  const acct = accountLines(data.fees, r.from, r.to);
  const lines = data.fees.filter((l) => inR(l.date) && (l.group === 'fee' || l.group === 'income'));
  const paid = rec.rows.reduce((a, x) => a + x.total, 0);
  const typeRows = [...Object.entries(acct.byType).map(([k, v]) => [k, -v]), ...Object.entries(acct.incomeByType).map(([k, v]) => [k, v])];
  body.innerHTML = `
    ${periodBar(data, rerender)}
    <div class="kpis">
      ${kpi('Payouts', money(paid), `${num(rec.rows.length)} from Amazon`)}
      ${kpi('Found in the bank', `${num(rec.rows.length - rec.unmatched.length)} of ${num(rec.rows.length)}`, rec.unmatched.length ? `${rec.unmatched.length} missing: see below` : rec.rows.length ? 'all matched' : '', rec.unmatched.length ? 'neg' : rec.rows.length ? 'pos' : '')}
      ${kpi('Amazon account fees', money(-acct.feesTotal), 'not in SellerToolkit', acct.feesTotal ? 'neg' : '')}
      ${kpi('Reimbursements', money(acct.incomeTotal), 'paid to you by Amazon', acct.incomeTotal ? 'pos' : '')}
    </div>
    ${charged.length ? `<div class="callout small section">Amazon charged your card ${charged.length === 1 ? 'once' : `${charged.length} times`} in this period (${charged.map((x) => `${dstr(x.depositDate)} ${money(-x.total)}`).join(', ')}): the balance was negative, so there was no payout.</div>` : ''}
    <div class="card section">
      <div class="toolbar"><b>Payouts</b><span class="small muted">matched to bank lines categorised Amazon Payout: same amount, banked within a week</span></div>
      <div class="table-wrap"><table class="data"><thead><tr><th>Deposit date</th><th>Settlement period</th><th>From</th><th class="r">Amount</th><th>In the bank</th></tr></thead><tbody>
      ${rec.rows.slice().reverse().map((x) => `<tr><td class="nowrap">${dstr(x.depositDate)}</td><td class="small nowrap">${x.start ? `${dstr(x.start)} – ${dstr(x.end)}` : '<span class="muted">—</span>'}</td><td class="small muted">${esc(x.source || '')}${x.settlementId ? ` · <span class="mono">${esc(x.settlementId)}</span>` : ''}</td>
        <td class="r num">${money(x.total)}</td><td>${x.matched ? `<span class="tag new">✓ ${dstr(x.bankDate)}</span>` : '<span class="tag gone">Not found</span>'}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">No payouts in this period</td></tr>'}
      </tbody></table></div>
      ${rec.unmatched.length ? '<p class="small muted" style="padding:0 14px 12px">Not found usually means the bank statement for those dates isn\'t imported yet, the bank line is in another category (fix it in Transactions), or the money went to a different account.</p>' : ''}
    </div>
    ${rec.unexplained.length ? `<div class="card section"><div class="toolbar"><b>Bank payouts with no settlement report</b><span class="small muted">import the settlement report for these dates</span></div>
      <table class="data"><tbody>${rec.unexplained.map((t) => `<tr><td class="nowrap">${dstr(t.date)}</td><td class="small">${esc(t.description)}</td><td class="r num">${money(t.amount)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    <div class="grid2 section">
      <div class="card"><div class="toolbar"><b>By type</b><span class="small muted">${esc(r.label)}</span></div>
        <table class="data"><tbody>${typeRows.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="r num ${v > 0 ? 'pos' : ''}">${money(v)}</td></tr>`).join('') || '<tr><td class="empty">No account fees in this period</td></tr>'}
        ${typeRows.length ? `<tr><td><b>Net</b></td><td class="r num"><b>${money(acct.incomeTotal - acct.feesTotal)}</b></td></tr>` : ''}</tbody></table></div>
      <div class="card card-pad small stack"><b>What's counted here</b>
        <p class="muted">Only lines that aren't tied to an order: storage, long-term storage, the Pro subscription, removals and disposals, inbound placement, advertising billed to your Amazon balance, and reimbursements for lost or damaged stock.</p>
        <p class="muted">Order fees, refunds and FBA fees are already in your SellerToolkit profit, so they're left out to avoid counting them twice. Advertising paid by card shows in the bank as Ad Spend instead.</p></div>
    </div>
    <div class="card section">
      <div class="toolbar"><b>${num(lines.length)} fee and reimbursement lines</b><span class="grow"></span><button class="btn small" id="exp">${icon('download', 14)} CSV</button></div>
      <div class="table-wrap"><table class="data" id="fl"><thead><tr><th data-sort="date">Date</th><th data-sort="feeType" data-first="asc">Type</th><th data-sort="description" data-first="asc">Description</th><th>SKU / order</th><th data-sort="amount" class="r">Amount</th></tr></thead><tbody></tbody></table></div>
    </div>`;
  wirePeriod(body, rerender);
  sortable(body.querySelector('#fl'), lines, (l) => `<tr><td class="small nowrap">${dstr(l.date)}</td><td class="small">${esc(l.feeType)}</td><td class="small">${esc(l.description)}</td><td class="small mono muted">${esc(l.sku || l.orderId || '')}</td><td class="r num ${l.amount > 0 ? 'pos' : ''}">${money(l.amount)}</td></tr>`, { defaultKey: 'date', defaultDir: 'desc' });
  body.querySelector('#exp').onclick = () => downloadFile(`amazon-account-fees-${r.from}_${r.to}.csv`, toCSV([['Date', 'Type', 'Description', 'Transaction type', 'SKU', 'Order ID', 'Settlement ID', 'Amount'], ...lines.map((l) => [l.date, l.feeType, l.description, l.txType, l.sku, l.orderId, l.settlementId, l.amount])]));
}

// ---------------------------------------------------------------------------
// Invoices & receipts: kept in the extension (travels in backups) and/or in Google Drive
// ---------------------------------------------------------------------------
const INV_TYPES = ['Stock', 'Subscription', 'Software', 'Expense', 'Equipment', 'Shipping', 'Professional', 'Other'];
const INV_MAX_MB = 8;
const typeForCategory = (c) => ({ 'Stock Purchase': 'Stock', Subscription: 'Subscription', Software: 'Software', Shipping: 'Shipping', Packaging: 'Expense', 'Professional Fees': 'Professional', 'Prep Centre': 'Expense' }[c] || 'Expense');
const readDataUrl = (f) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(fr.error); fr.readAsDataURL(f); });
const extOf = (name, mime) => (String(name).match(/\.([a-z0-9]{2,5})$/i)?.[1] || String(mime).split('/')[1] || 'pdf').toLowerCase().replace('jpeg', 'jpg');
const vendorOf = (t) => prettyPayee(t.description) || t.description;

// Phone photos are several MB: shrink them to a sharp, readable JPEG (longest side 1800px) before keeping them,
// so they sync and back up quickly. PDFs and anything the browser can't read are kept as they are.
async function shrinkImage(f, { max = 1800, quality = 0.82 } = {}) {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(f.type) || f.size < 350 * 1024) return f;
  try {
    const bmp = await createImageBitmap(f);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
    if (!blob || blob.size >= f.size) return f;
    return new File([blob], f.name.replace(/\.(png|webp|heic|heif|jpe?g)$/i, '') + '.jpg', { type: 'image/jpeg' });
  } catch { return f; }
}

// Stage files for the invoice form. `link` pre-fills from a bank line (the paperclip in Transactions or Missing receipts).
async function stageInvoices(files, link = null, data = null) {
  for (const f0 of files) {
    if (!/^(application\/pdf|image\/)/.test(f0.type) && !/\.(pdf|jpe?g|png|webp|heic)$/i.test(f0.name)) { toast(`${f0.name}: use a PDF or an image`, 'error'); continue; }
    const f = await shrinkImage(f0);
    if (f.size > INV_MAX_MB * 1048576) { toast(`${f.name} is over ${INV_MAX_MB} MB. Compress it or save a smaller PDF first.`, 'error', 7000); continue; }
    const t = link?.kind === 'txn' ? data?.txns.find((x) => x.id === link.id) : null;
    const ex = link?.kind === 'expense' ? data?.expenses.find((x) => x.id === link.id) : null;
    if (ex) {
      ui.invStaged.push({ key: crypto.randomUUID(), fileName: f.name, mime: f.type || 'application/pdf', size: f.size, dataUrl: await readDataUrl(f), date: ex.date || '', vendor: ex.vendor, amount: ex.amount, type: typeForCategory(ex.category), link: { kind: 'expense', id: ex.id, label: `${dstr(ex.date)} · ${ex.vendor} · ${money(ex.amount)} (added by hand)` } });
      continue;
    }
    // a photo just taken is today's receipt unless it's linked to a bank line
    const snapped = /^image\//.test(f.type) && Date.now() - (f0.lastModified || 0) < 10 * 60e3;
    ui.invStaged.push({
      key: crypto.randomUUID(), fileName: f.name, mime: f.type || 'application/pdf', size: f.size, dataUrl: await readDataUrl(f),
      date: t?.date || (snapped ? today() : ''), vendor: t ? vendorOf(t) : '', amount: t ? Math.abs(t.amount) : '', type: t ? typeForCategory(t.category) : 'Expense',
      link: t ? { kind: 'txn', id: t.id, label: `${dstr(t.date)} · ${t.description} · ${money(-t.amount)}` } : null,
    });
  }
}

async function openBlob(dataUrl) {
  const url = URL.createObjectURL(await (await fetch(dataUrl)).blob());
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60e3);
}

async function renderInvoices(body, data, rerender) {
  const s = data.settings;
  const storage = s.invoiceStorage || 'both';
  const signedIn = storage !== 'local' && s.googleClientId ? await isSignedIn().catch(() => false) : false;
  const fy = presetRange('this_fy', { fyStart: s.fyStart });
  const missing = missingReceipts(data.txns, data.invoices, { from: fy.from, to: fy.to });
  const pending = data.invoices.filter((i) => i.status !== 'uploaded' && i.dataUrl);
  const localMb = data.invoices.reduce((a, i) => a + (i.dataUrl ? i.dataUrl.length * 0.75 : 0), 0) / 1048576;
  const linkLabel = (i) => i.linkedLabel || (i.linkedTo ? 'linked' : '');
  const stLabel = { both: 'in the extension and Google Drive', local: 'in the extension only', drive: 'in Google Drive (the extension keeps the link)' }[storage];
  body.innerHTML = `
    <div class="card card-pad stack">
      <div class="dropzone" id="idz">${icon('file', 28)}
        <div style="margin-top:8px"><b>Drop invoices or receipts here</b> or click to choose (PDF, JPG or PNG, several at once)</div>
        <div class="small">Saved ${esc(stLabel)} as <span class="mono">2026-09-14_SellerToolkit_£32.99_Subscription.pdf</span>${storage !== 'local' ? ', filed in Drive under FBA Accounting › Invoices › year › month' : ''}. Change this in Settings.</div>
        <input type="file" id="ifile" accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/*" multiple hidden>
      </div>
      <div class="row ${ui.cameraHint ? 'callout' : ''}"><button class="btn ${ui.cameraHint ? 'primary big' : ''}" id="icamBtn" type="button">📷 Take a photo of a receipt</button>
        <span class="small muted grow">On a phone this opens the camera. Photos are shrunk to a few hundred KB, and you can link each one to its bank line or stock purchase.</span>
        <input type="file" id="icam" accept="image/*" capture="environment" hidden></div>
      ${storage !== 'local' && !s.googleClientId ? '<div class="callout warn small">Google isn\'t set up yet, so invoices are kept in the extension and marked "waiting for Drive". Connect Google in <a href="#fbaadmin/settings">Settings</a>, then click Upload waiting.</div>' : ''}
      <div id="istaged"></div>
    </div>

    <div class="card section">
      <div class="toolbar"><b>${num(data.invoices.length)} invoice${data.invoices.length === 1 ? '' : 's'}</b>
        <span class="small muted">${localMb ? `${localMb.toFixed(1)} MB kept in the extension` : ''}</span><span class="grow"></span>
        ${pending.length && storage !== 'local' ? `<button class="btn small primary" id="upPend">${icon('upload', 14)} Upload ${pending.length} waiting to Drive</button>` : ''}
        <button class="btn small" id="iexp">${icon('download', 14)} CSV</button></div>
      <div class="table-wrap"><table class="data" id="itab"><thead><tr><th data-sort="invoiceDate">Date</th><th data-sort="vendor" data-first="asc">Supplier</th><th data-sort="amount" class="r">Amount</th><th data-sort="type" data-first="asc">Type</th><th>Linked to</th><th>Kept</th><th></th></tr></thead><tbody></tbody></table></div>
    </div>

    <div class="card section">
      <div class="toolbar"><b>Missing receipts</b><span class="small muted">money out over £10 this financial year with nothing attached (not payouts, transfers, director's loan or bank charges)</span><span class="grow"></span><b class="small">${num(missing.rows.length)} · ${money(missing.total)}</b></div>
      <div class="table-wrap"><table class="data"><tbody>
        ${missing.rows.slice(0, 150).map((t) => `<tr data-tid="${esc(t.id)}"><td class="small nowrap">${dstr(t.date)}</td><td class="small"><b>${esc(t.description)}</b><div class="muted">${esc(t.category)}</div></td><td class="r num">${money(t.amount)}</td>
          <td class="r"><button class="btn small" data-attach>${icon('clip', 14)} Attach</button></td></tr>`).join('') || '<tr><td class="empty">Every cost has paperwork. Nice.</td></tr>'}
        ${missing.rows.length > 150 ? `<tr><td colspan="4" class="small muted">…and ${missing.rows.length - 150} more</td></tr>` : ''}
      </tbody></table></div>
      <input type="file" id="afile" accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/*" hidden>
    </div>`;

  // ---- staging + save ----
  const host = body.querySelector('#istaged');
  const drawStaged = () => {
    host.innerHTML = ui.invStaged.map((x, i) => {
      const sugg = x.link ? [] : suggestLinks({ date: x.date, amount: x.amount }, data.txns, data.stock);
      const preview = invoiceName({ date: x.date, vendor: x.vendor, amount: Number(x.amount) || 0, type: x.type, ext: extOf(x.fileName, x.mime) });
      return `<div class="card card-pad stack" data-k="${i}">
        <div class="row"><b class="grow">${icon('file', 14)} ${esc(x.fileName)}</b><span class="small muted">${(x.size / 1024).toFixed(0)} KB</span>
          <button class="btn small ghost" data-view>${icon('eye', 14)} View</button><button class="btn small ghost" data-drop>${icon('x', 14)}</button></div>
        <div class="form-grid">
          <label class="field">Invoice date<input type="date" data-f="date" value="${esc(x.date)}"></label>
          <label class="field">Supplier<input data-f="vendor" value="${esc(x.vendor)}" placeholder="e.g. SellerToolkit"></label>
          <label class="field">Amount £<input type="number" step="0.01" data-f="amount" value="${esc(x.amount)}"></label>
          <label class="field">Type<select data-f="type">${INV_TYPES.map((t) => `<option ${t === x.type ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        </div>
        <div class="small">${x.link ? `Linked to <b>${esc(x.link.label)}</b> <button class="btn small ghost" data-unlink>Unlink</button>`
          : sugg.length ? `Link to: ${sugg.map((g, j) => `<label class="check"><input type="radio" name="lk${i}" data-sugg="${j}"> ${esc(dstr(g.date))} · ${esc(g.label)} <span class="tag">${g.kind === 'txn' ? 'bank' : 'stock lot'}</span></label>`).join(' ')}`
            : '<span class="muted">Enter the date and amount to see matching bank lines or stock purchases.</span>'}</div>
        <div class="row"><span class="small muted mono grow">${esc(preview)}</span><button class="btn primary" data-save>${icon('check')} Save</button></div>
      </div>`;
    }).join('');
    host.querySelectorAll('[data-k]').forEach((card) => {
      const x = ui.invStaged[Number(card.dataset.k)];
      const sugg = () => suggestLinks({ date: x.date, amount: x.amount }, data.txns, data.stock);
      card.querySelectorAll('[data-f]').forEach((el) => {
        el.onchange = () => { x[el.dataset.f] = el.dataset.f === 'amount' ? (el.value === '' ? '' : Number(el.value)) : el.value; drawStaged(); };
      });
      card.querySelectorAll('[data-sugg]').forEach((el) => {
        el.onchange = () => {
          const g = sugg()[Number(el.dataset.sugg)]; if (!g) return;
          x.link = { kind: g.kind, id: g.id, label: `${dstr(g.date)} · ${g.label}` };
          if (!x.vendor && g.kind === 'txn') x.vendor = vendorOf(data.txns.find((t) => t.id === g.id));
          if (g.kind === 'stock') x.type = 'Stock';
          drawStaged();
        };
      });
      const un = card.querySelector('[data-unlink]'); if (un) un.onclick = () => { x.link = null; drawStaged(); };
      card.querySelector('[data-view]').onclick = () => openBlob(x.dataUrl);
      card.querySelector('[data-drop]').onclick = () => { ui.invStaged.splice(ui.invStaged.indexOf(x), 1); drawStaged(); };
      card.querySelector('[data-save]').onclick = async (e) => {
        if (!x.date || !(Number(x.amount) > 0)) return toast('Add the invoice date and amount', 'error');
        e.target.disabled = true;
        const taken = new Set(data.invoices.map((i) => i.fileName));
        const now = new Date().toISOString();
        const inv = {
          id: crypto.randomUUID(), invoiceDate: x.date, vendor: x.vendor.trim() || 'Unknown', amount: Math.round(Number(x.amount) * 100) / 100, type: x.type,
          fileName: uniqueName(invoiceName({ date: x.date, vendor: x.vendor, amount: Number(x.amount), type: x.type, ext: extOf(x.fileName, x.mime) }), taken),
          originalName: x.fileName, mime: x.mime, size: x.size, dataUrl: x.dataUrl, linkedTo: x.link ? { kind: x.link.kind, id: x.link.id } : null, linkedLabel: x.link?.label || '',
          status: storage === 'local' ? 'local' : 'pending', createdAt: now, updatedAt: now,
        };
        await store.put('faInvoices', inv);
        ui.invStaged.splice(ui.invStaged.indexOf(x), 1);
        let msg = `Saved ${inv.fileName}`;
        if (storage !== 'local' && s.googleClientId) {
          try { await uploadInvoice(inv); msg += ' and uploaded to Drive'; } catch (err) { msg += `. Drive upload waiting: ${err.message}`; }
        }
        toast(msg, 'success', 6000);
        autoSync(); rerender();
      };
    });
  };
  drawStaged();
  const dz = body.querySelector('#idz'); const fin = body.querySelector('#ifile');
  dz.onclick = () => fin.click();
  dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('over'); };
  dz.ondragleave = () => dz.classList.remove('over');
  dz.ondrop = async (e) => { e.preventDefault(); dz.classList.remove('over'); await stageInvoices([...e.dataTransfer.files], null, data); drawStaged(); };
  fin.onchange = async () => { await stageInvoices([...fin.files], null, data); fin.value = ''; drawStaged(); };
  const cam = body.querySelector('#icam');
  body.querySelector('#icamBtn').onclick = () => cam.click();
  cam.onchange = async () => { ui.cameraHint = false; await stageInvoices([...cam.files], null, data); cam.value = ''; drawStaged(); host.scrollIntoView({ behavior: 'smooth', block: 'start' }); };

  // attach from the missing-receipts list
  const afile = body.querySelector('#afile'); let attachTo = null;
  body.querySelectorAll('[data-attach]').forEach((b) => { b.onclick = () => { attachTo = b.closest('tr').dataset.tid; afile.click(); }; });
  afile.onchange = async () => { await stageInvoices([...afile.files], { kind: 'txn', id: attachTo }, data); afile.value = ''; drawStaged(); host.scrollIntoView({ behavior: 'smooth', block: 'start' }); };

  // ---- saved list ----
  const kept = (i) => [i.dataUrl ? '<span class="tag">Extension</span>' : '', i.driveLink ? `<a class="tag new" href="${esc(i.driveLink)}" target="_blank" rel="noopener">Drive ↗</a>` : '', i.status === 'pending' && storage !== 'local' ? '<span class="tag warn">Waiting for Drive</span>' : ''].join(' ');
  const rowHtml = (i) => `<tr data-id="${esc(i.id)}"><td class="small nowrap">${dstr(i.invoiceDate)}</td><td><b class="small">${esc(i.vendor)}</b><div class="small muted mono">${esc(i.fileName)}</div></td>
    <td class="r num">${money(i.amount)}</td><td class="small">${esc(i.type)}</td><td class="small">${i.linkedTo ? esc(linkLabel(i)) : '<span class="muted">—</span>'}</td><td class="small nowrap">${kept(i)}</td>
    <td class="r nowrap">${i.dataUrl ? `<button class="icon-btn" data-open title="View">${icon('eye', 15)}</button><button class="icon-btn" data-dl title="Download">${icon('download', 15)}</button>` : ''}
      <button class="icon-btn" data-relink title="Change link">${icon('clip', 15)}</button><button class="icon-btn" data-del title="Delete">${icon('trash', 15)}</button></td></tr>`;
  const tab = body.querySelector('#itab');
  sortable(tab, data.invoices, rowHtml, { defaultKey: 'invoiceDate', defaultDir: 'desc' });
  if (!data.invoices.length) tab.querySelector('tbody').innerHTML = '<tr><td colspan="7" class="empty">No invoices saved yet</td></tr>';
  tab.addEventListener('click', async (e) => {
    const tr = e.target.closest('tr[data-id]'); if (!tr) return;
    const inv = data.invoices.find((i) => i.id === tr.dataset.id);
    if (e.target.closest('[data-open]')) openBlob(inv.dataUrl);
    else if (e.target.closest('[data-dl]')) { const a = document.createElement('a'); a.href = inv.dataUrl; a.download = inv.fileName; a.click(); }
    else if (e.target.closest('[data-del]')) {
      if (!(await confirmBox('Delete this invoice?', `${inv.fileName} is removed from the extension.${inv.driveLink ? ' The copy in Google Drive stays: delete it there if you want it gone.' : ''}`, { okLabel: 'Delete', danger: true }))) return;
      await store.del('faInvoices', inv.id); autoSync(); rerender();
    } else if (e.target.closest('[data-relink]')) relinkInvoice(inv, data, rerender);
  });
  const up = body.querySelector('#upPend');
  if (up) up.onclick = async () => {
    up.disabled = true; up.textContent = 'Uploading…';
    try { if (!signedIn) await getToken(s.googleClientId, { interactive: true }); } catch (err) { toast(err.message, 'error', 7000); rerender(); return; }
    const r = await uploadPendingInvoices();
    toast(`${r.done} uploaded to Drive${r.left ? ` · ${r.left} still waiting${r.errors[0] ? `: ${r.errors[0]}` : ''}` : ''}`, r.left ? 'error' : 'success', 7000);
    autoSync(); rerender();
  };
  body.querySelector('#iexp').onclick = () => downloadFile(`invoices-${today()}.csv`, toCSV([['Invoice date', 'Supplier', 'Amount', 'Type', 'Linked to', 'File name', 'Drive link'], ...data.invoices.map((i) => [i.invoiceDate, i.vendor, i.amount, i.type, i.linkedLabel || '', i.fileName, i.driveLink || ''])]));
}

function relinkInvoice(inv, data, rerender) {
  const sugg = suggestLinks({ date: inv.invoiceDate, amount: inv.amount }, data.txns, data.stock);
  const d0 = Date.parse(`${inv.invoiceDate}T00:00:00Z`);
  const near = data.txns.filter((t) => t.amount < 0 && Math.abs(Date.parse(`${t.date}T00:00:00Z`) - d0) <= 45 * 864e5)
    .sort((a, b) => Math.abs(-a.amount - inv.amount) - Math.abs(-b.amount - inv.amount)).slice(0, 60);
  const opt = (kind, id, label) => `<option value="${kind}:${esc(id)}" ${inv.linkedTo?.kind === kind && inv.linkedTo?.id === id ? 'selected' : ''}>${esc(label)}</option>`;
  modal({
    title: 'Link invoice',
    body: `<p class="small">${esc(inv.fileName)}</p>
      <label class="field">Link to<select id="lk"><option value="">Not linked</option>
        ${sugg.length ? `<optgroup label="Best matches">${sugg.map((g) => opt(g.kind, g.id, `${dstr(g.date)} · ${g.label}`)).join('')}</optgroup>` : ''}
        <optgroup label="Bank lines within 45 days, closest amount first">${near.map((t) => opt('txn', t.id, `${dstr(t.date)} · ${t.description} · ${money(-t.amount)}`)).join('')}</optgroup></select></label>`,
    actions: [{ label: 'Cancel' }, {
      label: 'Save', kind: 'primary', onClick: async (el) => {
        const v = el.querySelector('#lk').value;
        const [kind, ...rest] = v.split(':'); const id = rest.join(':');
        const label = v ? el.querySelector('#lk').selectedOptions[0].textContent : '';
        await store.put('faInvoices', { ...inv, linkedTo: v ? { kind, id } : null, linkedLabel: label, updatedAt: new Date().toISOString() });
        toast(v ? 'Linked' : 'Unlinked', 'success'); autoSync(); rerender();
      },
    }],
  });
}

// ---------------------------------------------------------------------------
// Subscriptions: recurring costs found in the bank; you confirm which are real
// ---------------------------------------------------------------------------
function renderSubscriptions(body, data, rerender) {
  const m = mergeSubscriptions(detectSubscriptions(data.txns), data.subsSaved);
  const save = async (x, patch) => {
    await store.put('faSubscriptions', { id: x.id, name: x.name, vendor: x.vendor, amount: x.amount, frequency: x.frequency, annual: x.annual, lastSeen: x.lastSeen, nextDue: x.nextDue, category: x.category, note: x.note || '', active: x.active, dismissed: !!x.dismissed, ...patch, updatedAt: new Date().toISOString() });
    autoSync(); rerender();
  };
  const ended = m.all.filter((x) => x.active === false || x.dismissed);
  const freqTag = (f) => `<span class="tag">${esc(f)}</span>`;
  if (!data.txns.length) {
    body.innerHTML = emptyState('refresh', 'No bank data yet', 'Import a bank statement and repeating payments to the same supplier for the same amount (monthly, quarterly or yearly) show up here to confirm.', '<a class="btn primary" href="#fbaadmin/import">Import files</a>');
    return;
  }
  body.innerHTML = `
    <div class="kpis">
      ${kpi('Confirmed', num(m.confirmed.length), 'subscriptions you pay')}
      ${kpi('Per month', money(m.monthly), 'confirmed, averaged')}
      ${kpi('Per year', money(m.annual), 'confirmed')}
      ${kpi('To review', num(m.candidates.length), m.candidates.length ? 'found in the bank' : 'nothing new', m.candidates.length ? 'warn-text' : '')}
    </div>
    ${m.candidates.length ? `<div class="card section"><div class="toolbar"><b>Found in the bank: are these subscriptions?</b><span class="small muted">same supplier and amount, paid at a regular interval</span></div>
      <div class="table-wrap"><table class="data"><thead><tr><th>Supplier</th><th class="r">Amount</th><th>How often</th><th class="r">Payments</th><th>Last paid</th><th class="r">Per year</th><th></th></tr></thead><tbody>
      ${m.candidates.map((x) => `<tr data-id="${esc(x.id)}"><td><b class="small">${esc(x.name)}</b><div class="small muted">${esc(x.category)}</div></td><td class="r num">${money(x.amount)}</td><td>${freqTag(x.frequency)}</td><td class="r num">${x.occurrences}</td><td class="small nowrap">${dstr(x.lastSeen)}</td><td class="r num">${money(x.annual)}</td>
        <td class="r nowrap"><button class="btn small primary" data-yes>${icon('check', 14)} Subscription</button> <button class="btn small ghost" data-no>Not one</button></td></tr>`).join('')}
      </tbody></table></div></div>` : ''}
    <div class="card section"><div class="toolbar"><b>Your subscriptions</b><span class="grow"></span><button class="btn small" id="sexp">${icon('download', 14)} CSV</button></div>
      <div class="table-wrap"><table class="data"><thead><tr><th>Supplier</th><th class="r">Amount</th><th>How often</th><th class="r">Per year</th><th>Last paid</th><th>Next due</th><th>Note</th><th></th></tr></thead><tbody>
      ${m.confirmed.map((x) => `<tr data-id="${esc(x.id)}"><td><b class="small">${esc(x.name)}</b>${x.priceChange ? `<div class="small warn-text">Up from ${money(x.priceChange.from)} since ${dstr(x.priceChange.since)}</div>` : ''}${x.stale ? '<div class="small muted">not in the imported bank data</div>' : ''}</td>
        <td class="r num">${money(x.amount)}</td><td>${freqTag(x.frequency)}</td><td class="r num">${money(x.annual)}</td><td class="small nowrap">${dstr(x.lastSeen)}</td>
        <td class="small nowrap ${x.overdue ? 'warn-text' : ''}">${dstr(x.nextDue)}${x.overdue ? '<div>no payment seen: cancelled?</div>' : ''}</td>
        <td><input data-note value="${esc(x.note || '')}" placeholder="e.g. cancel before renewal" style="min-width:140px"></td>
        <td class="r nowrap"><button class="btn small ghost" data-stop title="You've cancelled it">Cancelled</button></td></tr>`).join('') || '<tr><td colspan="8" class="empty">None confirmed yet</td></tr>'}
      ${m.confirmed.length ? `<tr><td colspan="3"><b>Total</b></td><td class="r num"><b>${money(m.annual)}</b></td><td colspan="4" class="small muted">${money(m.monthly)} a month</td></tr>` : ''}
      </tbody></table></div></div>
    ${ended.length ? `<details class="section"><summary class="small">${ended.length} cancelled or not a subscription</summary><div class="card" style="margin-top:8px"><table class="data"><tbody>
      ${ended.map((x) => `<tr data-id="${esc(x.id)}"><td class="small"><b>${esc(x.name || x.vendor)}</b> · ${money(x.amount)} ${esc(x.frequency || '')}</td><td class="small muted">${x.dismissed ? 'Not a subscription' : 'Cancelled'}</td><td class="r"><button class="btn small ghost" data-undo>Undo</button></td></tr>`).join('')}
      </tbody></table></div></details>` : ''}
    <p class="small muted section">Payments to the same supplier for a different amount count separately, so a price rise shows as a new line until you confirm it. Stock purchases, transfers, payouts and director's loan payments are never suggested.</p>`;
  const find = (el) => m.all.find((x) => x.id === el.closest('tr').dataset.id);
  body.querySelectorAll('[data-yes]').forEach((b) => { b.onclick = () => save(find(b), { active: true, dismissed: false }); });
  body.querySelectorAll('[data-no]').forEach((b) => { b.onclick = () => save(find(b), { active: false, dismissed: true }); });
  body.querySelectorAll('[data-stop]').forEach((b) => { b.onclick = () => save(find(b), { active: false, dismissed: false }); });
  body.querySelectorAll('[data-undo]').forEach((b) => { b.onclick = async () => { await store.del('faSubscriptions', find(b).id); autoSync(); rerender(); }; });
  body.querySelectorAll('[data-note]').forEach((el) => { el.onchange = async () => { const x = find(el); await store.put('faSubscriptions', { ...(data.subsSaved.find((y) => y.id === x.id) || { id: x.id, active: true }), name: x.name, vendor: x.vendor, amount: x.amount, frequency: x.frequency, annual: x.annual, lastSeen: x.lastSeen, note: el.value, updatedAt: new Date().toISOString() }); toast('Note saved'); }; });
  body.querySelector('#sexp').onclick = () => downloadFile(`subscriptions-${today()}.csv`, toCSV([['Supplier', 'Amount', 'Frequency', 'Per year', 'First paid', 'Last paid', 'Next due', 'Category', 'Note'], ...m.confirmed.map((x) => [x.name, x.amount, x.frequency, x.annual, x.firstSeen || '', x.lastSeen, x.nextDue, x.category, x.note || ''])]));
}

// ---------------------------------------------------------------------------
// Year end: the pack for your accountant
// ---------------------------------------------------------------------------
function yearRange(id, fyStart) {
  if (id === 'prev_fy') {
    const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - 1);
    return presetRange('last_fy', { fyStart, today: d.toISOString().slice(0, 10) });
  }
  return presetRange(id, { fyStart });
}

function renderYearEnd(body, data, rerender) {
  const s = data.settings;
  const r = yearRange(ui.yePeriod, s.fyStart);
  const yearEnd = (() => { const d = new Date(`${r.from}T12:00:00Z`); d.setUTCFullYear(d.getUTCFullYear() + 1); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
  const y = buildYearEnd(data, { from: r.from, to: r.to });
  const p = y.p;
  const soFar = ui.yePeriod === 'this_fy' && r.to === today();
  const line = (label, v, { cls = '', note = '', bold = false } = {}) => `<tr class="${bold ? 'total' : ''}"><td>${bold ? `<b>${label}</b>` : label}${note ? `<div class="small muted">${note}</div>` : ''}</td><td class="r num ${cls}">${bold ? `<b>${money(v)}</b>` : money(v)}</td></tr>`;
  const ohRows = Object.entries(p.overheadsByCat);
  body.innerHTML = `
    <div class="row no-print" style="margin-bottom:14px">
      <select id="yeP">${[['this_fy', 'This financial year'], ['last_fy', 'Last financial year'], ['prev_fy', 'The year before']].map(([v, l]) => `<option value="${v}" ${ui.yePeriod === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <span class="small muted">${esc(r.label)}</span><span class="grow"></span>
      <button class="btn" id="yeCsv">${icon('download')} CSV</button>
      <button class="btn primary" id="yePrint">${icon('print')} Print / Save as PDF</button>
    </div>
    <div class="print-only"><h2>${esc(s.companyName || 'Year-end pack')}${s.companyName ? ' · Year-end pack' : ''}</h2><p>${esc(r.label)}${soFar ? ' (year so far)' : ''} · printed ${dstr(today())}</p></div>
    ${soFar ? `<div class="callout small no-print" style="margin-bottom:12px">This year isn't finished: figures are to ${dstr(r.to)}. The year ends ${dstr(yearEnd)}.</div>` : ''}
    ${y.checks.length ? `<div class="callout warn" style="margin-bottom:14px"><b>Before you send this</b><ul style="margin:6px 0 0 18px">${y.checks.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>` : '<div class="callout small" style="margin-bottom:14px">✓ Nothing left to check: categories, COGS, receipts and payouts are all in order.</div>'}

    <div class="kpis">
      ${kpi('Net profit: Amazon', money(p.netProfit), p.margin === null ? '' : `${pct(p.margin, 1)} margin`, profitClass(p.netProfit))}
      ${kpi('Net profit: Amazon + eBay', money(p.combinedNet), `eBay ${money(p.ebay.profit)}`, profitClass(p.combinedNet))}
      ${kpi('Corporation tax (estimate)', money(y.ct.tax), esc(y.ct.band))}
      ${kpi('Stock at cost', money(y.stock.value), `${esc(y.stock.method)}${y.stock.asOf ? ` · ${dstr(y.stock.asOf)}` : ''}`)}
      ${kpi("Director's loan at the end", money(Math.abs(y.dla.closing)), y.dla.closing >= 0 ? 'the company owes you' : 'you owe the company', y.dla.closing < 0 ? 'neg' : '')}
    </div>

    <div class="grid2 section ye-grid">
      <div class="card"><div class="toolbar"><b>Profit &amp; loss: Amazon only</b></div>
        <table class="data ye"><tbody>
          ${line('Sales', p.revenue, { note: `${num(p.units)} units · ${SRC()}` })}
          ${line('Amazon selling and FBA fees', -p.fees)}
          ${line('VAT on Amazon fees', -p.vatOnFees, { note: s.vatRegistered ? '' : 'not reclaimable: not VAT registered' })}
          ${line('Cost of goods sold', -p.cogs)}
          ${line(`Gross profit (${SRC()})`, p.stkProfit, { bold: true, cls: profitClass(p.stkProfit) })}
          ${Object.entries(p.accountFeesByType).map(([k, v]) => line(`Amazon ${k.toLowerCase()}`, -v, { note: 'settlement reports' })).join('')}
          ${Object.entries(p.reimbursementsByType).map(([k, v]) => line(k, v, { cls: 'pos', note: 'paid by Amazon' })).join('')}
          ${line('Returns loss', p.returnsLoss, { note: 'settled returns, Returns tracker' })}
          ${ohRows.map(([k, v]) => line(esc(k), -v)).join('')}
          ${ohRows.length ? '' : line('Overheads', 0, { note: 'none recorded' })}
          ${line('Net profit: Amazon', p.netProfit, { bold: true, cls: profitClass(p.netProfit) })}
        </tbody></table>
        <p class="small muted" style="padding:0 14px 12px">Overheads from ${esc(p.overheadsFrom)}.</p></div>

      <div class="stack">
        <div class="card"><div class="toolbar"><b>Amazon + eBay</b></div>
          <table class="data ye"><tbody>
            ${line('Net profit: Amazon', p.netProfit)}
            ${line('eBay sales', p.ebay.revenue, { note: `${num(p.ebay.units)} units` })}
            ${line('eBay fees, postage and costs', -(p.ebay.revenue - p.ebay.profit), { note: p.ebay.missingCogs ? `${p.ebay.missingCogs} sales with no cost: profit overstated` : 'including COGS' })}
            ${line('eBay profit', p.ebay.profit, { cls: profitClass(p.ebay.profit) })}
            ${line('Net profit before tax', p.combinedNet, { bold: true, cls: profitClass(p.combinedNet) })}
            ${line(`Corporation tax (${esc(y.ct.band.toLowerCase())})`, -y.ct.tax)}
            ${line('Profit after tax (estimate)', p.combinedNet - y.ct.tax, { bold: true })}
          </tbody></table>
          <p class="small muted" style="padding:0 14px 12px">Tax uses 2026/27 rates: 19% up to £50,000, 25% from £250,000, marginal relief between${Number(s.associatedCompanies) ? `, limits shared with ${s.associatedCompanies} associated compan${Number(s.associatedCompanies) === 1 ? 'y' : 'ies'}` : ''}. It's an estimate on the figures here: your accountant adds capital allowances, disallowable costs and adjustments.</p></div>
        <div class="card"><div class="toolbar"><b>Balance sheet items</b></div>
          <table class="data ye"><tbody>
            ${line(`Stock at cost on ${dstr(y.stock.asOf || r.to)}`, y.stock.value, { note: `${esc(y.stock.method)}${y.stock.unfulfillable ? ` · excludes ${y.stock.unfulfillable} unfulfillable units (${money(y.stock.unfulfillableValue)} at cost)` : ''}` })}
            ${line("Director's loan", y.dla.closing, { note: y.dla.closing >= 0 ? 'owed to you by the company (a liability)' : 'owed by you to the company (an asset)', cls: y.dla.closing < 0 ? 'neg' : '' })}
            ${line('Confirmed subscriptions', y.subs.annual, { note: 'per year, for information' })}
          </tbody></table></div>
      </div>
    </div>

    <div class="card section"><div class="toolbar"><b>Director's loan account</b><span class="small muted">bank lines categorised Director Loan · + paid in by you · − paid out to you or for you</span></div>
      ${y.dla.known ? '' : `<div class="callout warn small" style="margin:0 14px 10px">The opening balance for this period isn't known. Enter what the director's loan stood at in <a href="#fbaadmin/settings">Settings</a> (your last accounts show it).</div>`}
      <div class="table-wrap"><table class="data"><thead><tr><th>Date</th><th>Description</th><th class="r">Amount</th><th class="r">Balance</th></tr></thead><tbody>
        <tr><td class="nowrap">${dstr(r.from)}</td><td><b>Opening balance</b></td><td></td><td class="r num"><b>${money(y.dla.opening)}</b></td></tr>
        ${y.dla.rows.map((x) => `<tr><td class="small nowrap">${dstr(x.date)}</td><td class="small">${esc(x.description)}</td><td class="r num ${x.amount > 0 ? 'pos' : ''}">${money(x.amount)}</td><td class="r num ${x.balance < 0 ? 'neg' : ''}">${money(x.balance)}</td></tr>`).join('')}
        <tr><td class="nowrap">${dstr(r.to)}</td><td><b>Closing balance</b><div class="small muted">paid out ${money(y.dla.paidOut)} · paid in ${money(y.dla.paidIn)}</div></td><td></td><td class="r num ${y.dla.closing < 0 ? 'neg' : ''}"><b>${money(y.dla.closing)}</b></td></tr>
      </tbody></table></div>
      ${y.dla.everOverdrawn && !y.dla.overdrawn ? `<p class="small warn-text" style="padding:0 14px 12px">It went overdrawn during the year (lowest ${money(y.dla.lowest)}). Mention this to your accountant: an overdrawn loan over £10,000 at any point can be a taxable benefit.</p>` : ''}
    </div>

    <div class="grid2 section">
      <div class="card card-pad small stack"><b>Payouts</b>
        <p>${y.payouts.rows.length ? `${y.payouts.rows.length - y.payouts.unmatched.length} of ${y.payouts.rows.length} Amazon payouts found in the bank.` : 'No settlement reports for this year.'} <a class="no-print" href="#fbaadmin/payouts">Details</a></p></div>
      <div class="card card-pad small stack"><b>Receipts</b>
        <p>${data.invoices.filter((i) => i.invoiceDate >= r.from && i.invoiceDate <= r.to).length} invoices saved for the year. ${y.receipts.rows.length ? `${y.receipts.rows.length} costs (${money(y.receipts.total)}) have none attached.` : 'Every cost over £10 has one.'} <a class="no-print" href="#fbaadmin/invoices">Invoices</a></p></div>
    </div>
    ${packCard(data)}
    <p class="small muted section">Prepared by Niall's Toolkit from your bank statements, ${SRC()}, Amazon reports and the eBay tracker. Management figures, not statutory accounts.</p>`;
  wirePack(body, data);
  body.querySelector('#yeP').onchange = (e) => { ui.yePeriod = e.target.value; rerender(); };
  body.querySelector('#yePrint').onclick = () => window.print();
  body.querySelector('#yeCsv').onclick = () => downloadFile(`year-end-${r.from}_${r.to}.csv`, toCSV(y.sheetRows));
}

// ---------------------------------------------------------------------------
// Expenses & calendar: bank lines, costs paid personally or outside the bank, recurring and planned costs
// ---------------------------------------------------------------------------
const EXP_VIEWS = [['calendar', 'Calendar'], ['upcoming', 'Coming up'], ['recurring', 'Recurring'], ['manual', 'Added by hand']];
const STATUS_TAG = {
  paid: '<span class="tag new">✓ paid</span>', upcoming: '<span class="tag">due</span>', due: '<span class="tag warn">due now</span>', overdue: '<span class="tag gone">not seen in bank</span>',
  personal: '<span class="tag pers">paid personally</span>', skipped: '<span class="tag">skipped</span>',
};
const freqLabel = (f) => (FREQUENCIES.find(([k]) => k === f) || [, f])[1];

function expenseModel(data) {
  const subsM = mergeSubscriptions(detectSubscriptions(data.txns), data.subsSaved);
  return { subsM, subs: subsM.confirmed };
}

function renderExpenses(body, data, rerender) {
  const s = data.settings;
  const { subs } = expenseModel(data);
  const t0 = today();
  const month = ui.expMonth || t0.slice(0, 7);
  const monthFrom = `${month}-01`; const monthTo = `${shiftMonth(month, 1)}-01`;
  const mEnd = new Date(Date.parse(`${monthTo}T00:00:00Z`) - 864e5).toISOString().slice(0, 10);
  const horizon = new Date(Date.parse(`${t0}T00:00:00Z`) + 60 * 864e5).toISOString().slice(0, 10);
  const lookback = new Date(Date.parse(`${t0}T00:00:00Z`) - 45 * 864e5).toISOString().slice(0, 10);
  const span = { from: monthFrom < lookback ? monthFrom : lookback, to: mEnd > horizon ? mEnd : horizon };
  const items = matchToBank(expectedItems(data.expenses, { from: span.from, to: span.to, subscriptions: subs }), data.txns, { today: t0 });
  const next30 = new Date(Date.parse(`${t0}T00:00:00Z`) + 30 * 864e5).toISOString().slice(0, 10);
  const upcoming = items.filter((x) => x.date >= t0 && x.date <= next30 && x.status !== 'paid' && x.status !== 'skipped');
  const overdue = items.filter((x) => x.status === 'overdue');
  const recurring = data.expenses.filter((e) => e.kind === 'recurring');
  const perMonth = Math.round((recurring.filter((e) => e.active !== false && e.direction !== 'in').reduce((a, e) => a + perYear(e.amount, e.freq), 0) + subs.filter((x) => !recurring.some((e) => vendorSlug(e.vendor) === vendorSlug(x.name))).reduce((a, x) => a + x.annual, 0)) / 12 * 100) / 100;
  const fy = presetRange('this_fy', { fyStart: s.fyStart });
  const personalFy = data.nonBank.filter((c) => c.paidBy === 'personal' && c.date >= fy.from && c.date <= fy.to).reduce((a, c) => a + c.amount, 0);
  const view = ui.expView || 'calendar';

  body.innerHTML = `
    <div class="row" style="margin-bottom:12px">
      <div class="seg" role="group">${EXP_VIEWS.map(([k, l]) => `<button class="btn small ${view === k ? 'primary' : ''}" data-ev="${k}">${l}</button>`).join('')}</div>
      <span class="grow"></span>
      <button class="btn small" data-new="manual">${icon('plus', 14)} Cost paid personally / not in the bank</button>
      <button class="btn small" data-new="recurring">${icon('plus', 14)} Recurring</button>
      <button class="btn small" data-new="planned">${icon('plus', 14)} Planned one-off</button>
    </div>
    <div class="kpis">
      ${kpi('Due in the next 30 days', money(-upcoming.filter((x) => x.amount < 0).reduce((a, x) => a + x.amount, 0)), `${upcoming.length} payment${upcoming.length === 1 ? '' : 's'}${upcoming.some((x) => x.amount > 0) ? ` · ${money(upcoming.filter((x) => x.amount > 0).reduce((a, x) => a + x.amount, 0))} coming in` : ''}`)}
      ${kpi('Recurring costs', `${money(perMonth)}/month`, `${recurring.length} of yours + ${subs.length} confirmed subscriptions`)}
      ${kpi('Not seen in the bank', num(overdue.length), overdue.length ? 'expected but no matching bank line' : 'everything expected has been paid', overdue.length ? 'warn-text' : '')}
      ${kpi('Paid personally this year', money(personalFy), "added to your director's loan", '', '#fbaadmin/yearend')}
    </div>
    <div id="expView" class="section"></div>`;
  const host = body.querySelector('#expView');
  body.querySelectorAll('[data-ev]').forEach((b) => { b.onclick = () => { ui.expView = b.dataset.ev; rerender(); }; });
  body.querySelectorAll('[data-new]').forEach((b) => { b.onclick = () => expenseForm({ kind: b.dataset.new }, data, rerender); });

  const itemRow = (x, { showDate = true } = {}) => `<tr data-key="${esc(x.key)}"><td class="small nowrap">${showDate ? dstr(x.date) : ''}</td>
    <td><b class="small">${esc(x.vendor)}</b><div class="small muted">${esc(x.category || '')} · ${x.source === 'subscription' ? 'subscription' : x.source === 'planned' ? 'one-off' : freqLabel(x.freq)}${x.note ? ` · ${esc(x.note)}` : ''}</div></td>
    <td class="r num ${x.amount > 0 ? 'pos' : ''}">${money(x.amount)}</td><td>${STATUS_TAG[x.status] || ''}${x.paidDate && x.paidDate !== x.date ? `<div class="small muted">banked ${dstr(x.paidDate)}</div>` : ''}</td>
    <td class="r nowrap">${x.source === 'subscription' ? '<a class="btn small ghost" href="#fbaadmin/subscriptions">Subscriptions</a>'
      : `${x.source === 'recurring' && x.status !== 'paid' ? `<button class="btn small ghost" data-skip="${esc(x.key)}">${x.status === 'skipped' ? 'Un-skip' : 'Skip this one'}</button>` : ''}${x.source === 'planned' && x.status !== 'paid' ? `<button class="btn small ghost" data-paid="${esc(x.entryId)}">Mark paid</button>` : ''}<button class="icon-btn" data-edit="${esc(x.entryId)}" title="Edit">${icon('gear', 15)}</button>`}</td></tr>`;

  if (view === 'calendar') {
    const byDate = {};
    for (const x of items) if (x.date >= monthFrom && x.date <= mEnd) (byDate[x.date] ||= []).push({ ...x, type: 'expected' });
    const matched = new Set(items.map((x) => x.txnId).filter(Boolean));
    if (ui.expBank !== false) for (const t of data.txns) if (t.date >= monthFrom && t.date <= mEnd && t.amount < 0 && !matched.has(t.id)) (byDate[t.date] ||= []).push({ type: 'bank', vendor: t.description, amount: t.amount, category: t.category, id: t.id });
    for (const c of data.expenses.filter((e) => e.kind === 'manual' && e.date >= monthFrom && e.date <= mEnd)) (byDate[c.date] ||= []).push({ type: 'manual', vendor: c.vendor, amount: -c.amount, category: c.category, id: c.id, paidBy: c.paidBy });
    const weeks = monthGrid(month, byDate);
    const chip = (x) => {
      const cls = x.type === 'bank' ? 'bank' : x.type === 'manual' ? (x.paidBy === 'personal' ? 'pers' : 'man') : x.status === 'paid' ? 'paid' : x.status === 'overdue' ? 'over' : x.status === 'personal' ? 'pers' : x.status === 'skipped' ? 'skip' : x.amount > 0 ? 'in' : 'exp';
      return `<div class="cal-chip ${cls}" title="${esc(`${x.vendor} ${money(x.amount)}${x.status ? ` · ${x.status}` : ''}`)}">${x.status === 'paid' ? '✓ ' : ''}${esc(String(x.vendor).slice(0, 18))} <b>${money(Math.abs(x.amount), '£', 0)}</b></div>`;
    };
    const sel = ui.expDay && ui.expDay.startsWith(month) ? ui.expDay : null;
    host.innerHTML = `<div class="card">
      <div class="toolbar"><button class="btn small" data-m="-1">‹</button><b style="min-width:140px;text-align:center">${esc(new Date(`${month}-15T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }))}</b><button class="btn small" data-m="1">›</button>
        <button class="btn small ghost" data-m="0">Today</button><span class="grow"></span>
        <label class="check small"><input type="checkbox" id="calBank" ${ui.expBank !== false ? 'checked' : ''}> Show other bank payments</label></div>
      <div class="cal-legend small muted"><span class="cal-chip exp">expected</span><span class="cal-chip paid">✓ paid</span><span class="cal-chip over">not seen in bank</span><span class="cal-chip pers">paid personally</span><span class="cal-chip man">not in the bank</span><span class="cal-chip in">money in</span>${ui.expBank !== false ? '<span class="cal-chip bank">bank payment</span>' : ''}</div>
      <div class="cal"><div class="cal-h">Mon</div><div class="cal-h">Tue</div><div class="cal-h">Wed</div><div class="cal-h">Thu</div><div class="cal-h">Fri</div><div class="cal-h">Sat</div><div class="cal-h">Sun</div>
        ${weeks.flat().map((c) => (c ? `<div class="cal-d ${c.date === t0 ? 'today' : ''} ${c.date === sel ? 'sel' : ''}" data-day="${c.date}"><div class="cal-n">${c.day}</div>${c.items.slice(0, 4).map(chip).join('')}${c.items.length > 4 ? `<div class="small muted">+${c.items.length - 4} more</div>` : ''}</div>` : '<div class="cal-d empty"></div>')).join('')}</div>
      </div>
      ${sel ? `<div class="card section"><div class="toolbar"><b>${dstr(sel)}</b><span class="grow"></span><button class="btn small" data-new-on="${sel}">${icon('plus', 14)} Add on this day</button></div>
        <table class="data"><tbody>${(byDate[sel] || []).map((x) => (x.type === 'expected' ? itemRow(x, { showDate: false })
          : `<tr><td></td><td><b class="small">${esc(x.vendor)}</b><div class="small muted">${esc(x.category || '')} · ${x.type === 'bank' ? 'bank payment' : x.paidBy === 'personal' ? 'paid personally' : 'not in the bank'}</div></td><td class="r num">${money(x.amount)}</td><td></td><td class="r">${x.type === 'manual' ? `<button class="icon-btn" data-edit="${esc(x.id)}" title="Edit">${icon('gear', 15)}</button>` : ''}</td></tr>`)).join('') || '<tr><td class="empty">Nothing on this day</td></tr>'}</tbody></table></div>` : '<p class="small muted section">Click a day to see everything on it.</p>'}`;
    host.querySelectorAll('[data-m]').forEach((b) => { b.onclick = () => { ui.expMonth = b.dataset.m === '0' ? t0.slice(0, 7) : shiftMonth(month, Number(b.dataset.m)); rerender(); }; });
    host.querySelectorAll('[data-day]').forEach((d) => { d.onclick = () => { ui.expDay = d.dataset.day; rerender(); }; });
    host.querySelector('#calBank').onchange = (e) => { ui.expBank = e.target.checked; rerender(); };
    const no = host.querySelector('[data-new-on]'); if (no) no.onclick = () => expenseForm({ kind: no.dataset.newOn <= t0 ? 'manual' : 'planned', date: no.dataset.newOn, start: no.dataset.newOn }, data, rerender);
  } else if (view === 'upcoming') {
    const list = items.filter((x) => (x.date >= t0 && x.date <= horizon) || x.status === 'overdue' || x.status === 'due');
    host.innerHTML = `<div class="card"><div class="toolbar"><b>Coming up: the next 60 days</b><span class="small muted">plus anything expected recently that hasn't shown in the bank</span></div>
      <div class="table-wrap"><table class="data"><thead><tr><th>Date</th><th>What</th><th class="r">Amount</th><th>Status</th><th></th></tr></thead><tbody>
      ${list.map((x) => itemRow(x)).join('') || `<tr><td colspan="5" class="empty">Nothing set up yet. Add your recurring costs (rent, phone, insurance, Klarna instalments…) and one-off bills you know are coming.</td></tr>`}</tbody></table></div></div>`;
  } else if (view === 'recurring') {
    const nextOf = (e) => matchToBank(expectedItems([e], { from: t0, to: '2100-01-01' }).slice(0, 1), [], { today: t0 })[0]?.date;
    const lastPaid = (id) => items.filter((x) => x.entryId === id && x.status === 'paid').at(-1);
    host.innerHTML = `<div class="card"><div class="toolbar"><b>Recurring</b><span class="small muted">yours, then confirmed subscriptions (manage those in Subscriptions)</span><span class="grow"></span><button class="btn small" id="expCsv">${icon('download', 14)} CSV</button></div>
      <div class="table-wrap"><table class="data"><thead><tr><th>What</th><th class="r">Amount</th><th>How often</th><th class="r">Per year</th><th>Paid from</th><th>Next</th><th>Last paid</th><th></th></tr></thead><tbody>
      ${recurring.map((e) => { const lp = lastPaid(e.id); return `<tr class="${e.active === false ? 'muted' : ''}"><td><b class="small">${esc(e.vendor)}</b><div class="small muted">${esc(e.category)}${e.note ? ` · ${esc(e.note)}` : ''}${e.active === false ? ' · paused' : ''}</div></td>
        <td class="r num ${e.direction === 'in' ? 'pos' : ''}">${money((e.direction === 'in' ? 1 : -1) * e.amount)}</td><td class="small">${esc(freqLabel(e.freq))}</td><td class="r num">${money(perYear(e.amount, e.freq))}</td>
        <td class="small">${e.paidFrom === 'personal' ? 'You, personally' : 'Bank'}</td><td class="small nowrap">${e.active === false ? '—' : dstr(nextOf(e))}</td><td class="small nowrap">${lp ? dstr(lp.paidDate || lp.date) : '—'}</td>
        <td class="r nowrap"><button class="icon-btn" data-edit="${esc(e.id)}" title="Edit">${icon('gear', 15)}</button></td></tr>`; }).join('')}
      ${subs.map((x) => `<tr><td><b class="small">${esc(x.name)}</b><div class="small muted">subscription · ${esc(x.category)}</div></td><td class="r num">${money(-x.amount)}</td><td class="small">${esc(x.frequency)}</td><td class="r num">${money(x.annual)}</td><td class="small">Bank</td><td class="small nowrap">${dstr(x.nextDue)}</td><td class="small nowrap">${dstr(x.lastSeen)}</td><td class="r"><a class="btn small ghost" href="#fbaadmin/subscriptions">Manage</a></td></tr>`).join('')}
      ${!recurring.length && !subs.length ? '<tr><td colspan="8" class="empty">No recurring costs yet</td></tr>' : ''}</tbody></table></div></div>`;
    host.querySelector('#expCsv').onclick = () => downloadFile(`recurring-costs-${t0}.csv`, toCSV([['What', 'Amount', 'Money in/out', 'How often', 'Per year', 'Paid from', 'Category', 'Starts', 'Ends', 'Note'], ...recurring.map((e) => [e.vendor, e.amount, e.direction === 'in' ? 'in' : 'out', freqLabel(e.freq), perYear(e.amount, e.freq), e.paidFrom === 'personal' ? 'personally' : 'bank', e.category, e.start, e.end || '', e.note || '']), ...subs.map((x) => [x.name, x.amount, 'out', x.frequency, x.annual, 'bank', x.category, x.firstSeen || '', '', 'subscription'])]));
  } else {
    const manual = data.expenses.filter((e) => e.kind === 'manual').sort((a, b) => b.date.localeCompare(a.date));
    const invByExp = new Map(data.invoices.filter((i) => i.linkedTo?.kind === 'expense').map((i) => [i.linkedTo.id, i]));
    host.innerHTML = `<div class="card"><div class="toolbar"><b>Added by hand</b><span class="small muted">costs paid with your own card or cash (they go on your director's loan), or from company cash / another account. They count as overheads.</span><span class="grow"></span><button class="btn small" id="manCsv">${icon('download', 14)} CSV</button></div>
      <div class="table-wrap"><table class="data"><thead><tr><th>Date</th><th>Supplier</th><th class="r">Amount</th><th>Category</th><th>Paid by</th><th></th></tr></thead><tbody>
      ${manual.map((e) => `<tr data-id="${esc(e.id)}"><td class="small nowrap">${dstr(e.date)}</td><td><b class="small">${esc(e.vendor)}</b>${e.note ? `<div class="small muted">${esc(e.note)}</div>` : ''}</td><td class="r num">${money(-e.amount)}</td><td class="small">${esc(e.category)}</td>
        <td class="small">${e.paidBy === 'personal' ? "You (director's loan)" : 'Company, not in the bank'}</td>
        <td class="r nowrap">${invByExp.has(e.id) ? `<button class="icon-btn pos" data-inv="${esc(e.id)}" title="${esc(invByExp.get(e.id).fileName)}">${icon('clip', 15)}</button>` : `<button class="icon-btn muted" data-attach-exp="${esc(e.id)}" title="Attach receipt">${icon('clip', 15)}</button>`}<button class="icon-btn" data-edit="${esc(e.id)}" title="Edit">${icon('gear', 15)}</button></td></tr>`).join('') || '<tr><td colspan="6" class="empty">Nothing added by hand yet</td></tr>'}
      </tbody></table></div><input type="file" id="expFile" accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/*" hidden></div>
      <p class="small muted section">Mileage: add it as a cost paid personally, category Mileage / Travel, at HMRC's 45p a mile for the first 10,000 business miles in the tax year (25p after). Don't add anything here that's already in SellerToolkit's expenses for a month without bank lines, or it counts twice.</p>`;
    host.querySelector('#manCsv').onclick = () => downloadFile(`costs-added-by-hand-${t0}.csv`, toCSV([['Date', 'Supplier', 'Amount', 'Category', 'Paid by', 'Note'], ...manual.map((e) => [e.date, e.vendor, e.amount, e.category, e.paidBy === 'personal' ? 'director personally' : 'company, not in bank', e.note || ''])]));
    const ef = host.querySelector('#expFile'); let to = null;
    host.querySelectorAll('[data-attach-exp]').forEach((b) => { b.onclick = () => { to = b.dataset.attachExp; ef.click(); }; });
    ef.onchange = async () => { await stageInvoices([...ef.files], { kind: 'expense', id: to }, data); ef.value = ''; location.hash = '#fbaadmin/invoices'; };
    host.querySelectorAll('[data-inv]').forEach((b) => { b.onclick = () => { const i = invByExp.get(b.dataset.inv); if (i.dataUrl) openBlob(i.dataUrl); else if (i.driveLink) window.open(i.driveLink, '_blank', 'noopener'); }; });
  }

  host.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = (ev) => { ev.stopPropagation(); const e = data.expenses.find((x) => x.id === b.dataset.edit); if (e) expenseForm(e, data, rerender); }; });
  host.querySelectorAll('[data-skip]').forEach((b) => {
    b.onclick = async (ev) => {
      ev.stopPropagation();
      const [id, date] = b.dataset.skip.split('|'); const e = data.expenses.find((x) => x.id === id); if (!e) return;
      const sk = new Set(e.skipped || []); if (sk.has(date)) sk.delete(date); else sk.add(date);
      await store.put('faExpenses', { ...e, skipped: [...sk], updatedAt: new Date().toISOString() }); rerender();
    };
  });
  host.querySelectorAll('[data-paid]').forEach((b) => {
    b.onclick = async (ev) => { ev.stopPropagation(); const e = data.expenses.find((x) => x.id === b.dataset.paid); await store.put('faExpenses', { ...e, status: 'paid', updatedAt: new Date().toISOString() }); toast('Marked paid', 'success'); rerender(); };
  });
}

function expenseForm(e0, data, rerender) {
  const isNew = !e0.id;
  const e = { direction: 'out', paidFrom: 'bank', paidBy: 'personal', category: 'Other Expense', freq: 'monthly', date: today(), start: today(), ...e0 };
  const kindLabel = { manual: 'Cost paid personally or not in the bank', recurring: 'Recurring cost or income', planned: 'Planned one-off' }[e.kind];
  const cats = (dir) => (dir === 'in' ? CATEGORIES.in : CATEGORIES.out).filter((c) => c !== 'Uncategorized' && c !== 'Transfer');
  modal({
    title: `${isNew ? 'Add' : 'Edit'}: ${kindLabel}`,
    body: `<div class="form-grid">
      <label class="field">Supplier / what<input id="xV" value="${esc(e.vendor || '')}" placeholder="e.g. Vodafone, Klarna instalment, Accountant"></label>
      <label class="field">Amount £<input id="xA" type="number" step="0.01" min="0" value="${esc(e.amount ?? '')}"></label>
      ${e.kind !== 'manual' ? `<label class="field">Money<select id="xDir"><option value="out" ${e.direction !== 'in' ? 'selected' : ''}>Going out</option><option value="in" ${e.direction === 'in' ? 'selected' : ''}>Coming in</option></select></label>` : ''}
      <label class="field">Category<select id="xC">${cats(e.direction).map((c) => `<option ${c === e.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
      ${e.kind === 'recurring' ? `<label class="field">How often<select id="xF">${FREQUENCIES.map(([k, l]) => `<option value="${k}" ${k === e.freq ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="field">First payment<input id="xS" type="date" value="${esc(e.start || '')}"></label>
        <label class="field">Last payment (optional)<input id="xE" type="date" value="${esc(e.end || '')}"></label>` : `<label class="field">Date<input id="xD" type="date" value="${esc(e.date || '')}"></label>`}
      ${e.kind === 'manual' ? `<label class="field">Paid by<select id="xP"><option value="personal" ${e.paidBy !== 'company' ? 'selected' : ''}>Me, personally (company owes me)</option><option value="company" ${e.paidBy === 'company' ? 'selected' : ''}>Company cash / another account</option></select></label>`
        : `<label class="field">Paid from<select id="xP"><option value="bank" ${e.paidFrom !== 'personal' ? 'selected' : ''}>The business bank account</option><option value="personal" ${e.paidFrom === 'personal' ? 'selected' : ''}>Me, personally (company owes me)</option></select></label>`}
    </div>
    <label class="field">Note<input id="xN" value="${esc(e.note || '')}"></label>
    ${e.kind !== 'manual' ? `<details class="small"><summary>Matching to the bank</summary><label class="field" style="margin-top:6px">Word to find it in bank descriptions<input id="xK" value="${esc(e.matchKeyword || '')}" placeholder="worked out from the supplier name"></label>
      <p class="muted">A payment counts as paid when a bank line with this word (or the exact amount) arrives up to 3 days before or 7 days after the date, within 10% of the amount.</p></details>` : ''}
    ${e.kind === 'recurring' && !isNew ? `<label class="check small"><input type="checkbox" id="xAct" ${e.active !== false ? 'checked' : ''}> Active (untick to pause without deleting)</label>` : ''}`,
    actions: [
      ...(isNew ? [] : [{ label: 'Delete', kind: 'danger', onClick: async () => { if (!(await confirmBox('Delete this?', `${e.vendor} is removed${e.kind === 'manual' ? ' from your costs and director\'s loan' : ''}.`, { okLabel: 'Delete', danger: true }))) return false; await store.del('faExpenses', e.id); autoSync(); rerender(); return true; } }]),
      { label: 'Cancel' },
      {
        label: 'Save', kind: 'primary', onClick: async (el) => {
          const $ = (id) => el.querySelector(`#${id}`);
          const amount = Math.round(Number($('xA').value) * 100) / 100;
          const vendor = $('xV').value.trim();
          if (!vendor || !(amount > 0)) { toast('Add what it is and the amount', 'error'); return false; }
          const rec = { ...e, id: e.id || crypto.randomUUID(), vendor, amount, category: $('xC').value, note: $('xN').value.trim(), updatedAt: new Date().toISOString(), createdAt: e.createdAt || new Date().toISOString() };
          if ($('xDir')) rec.direction = $('xDir').value;
          if (e.kind === 'recurring') { rec.freq = $('xF').value; rec.start = $('xS').value; rec.end = $('xE').value; if (!rec.start) { toast('Pick the first payment date', 'error'); return false; } if ($('xAct')) rec.active = $('xAct').checked; delete rec.date; }
          else { rec.date = $('xD').value; if (!rec.date) { toast('Pick the date', 'error'); return false; } delete rec.start; delete rec.freq; }
          if (e.kind === 'manual') { rec.paidBy = $('xP').value; delete rec.paidFrom; } else { rec.paidFrom = $('xP').value; rec.matchKeyword = ($('xK')?.value || '').trim(); delete rec.paidBy; }
          if (e.kind === 'planned' && !rec.status) rec.status = 'expected';
          await store.put('faExpenses', rec);
          toast(isNew ? 'Added' : 'Saved', 'success'); autoSync(); rerender();
          return true;
        },
      },
    ],
  });
  const dir = document.querySelector('.modal #xDir');
  if (dir) dir.onchange = () => { document.querySelector('.modal #xC').innerHTML = cats(dir.value).map((c) => `<option>${esc(c)}</option>`).join(''); };
}

// ---------------------------------------------------------------------------
// Cash flow: the bank balance over the next 30 / 60 / 90 days
// ---------------------------------------------------------------------------
// opts.scenario: { salesChange, delayDays, oneOff } for "what if"; opts.includeStock: false for the daily budget.
function cashFlowFor(data, days, { scenario = {}, includeStock = data.settings.cfIncludeStock !== false } = {}) {
  const s = data.settings;
  const { subs } = expenseModel(data);
  let ct = null;
  if (s.cfIncludeCt !== false) {
    const last = presetRange('last_fy', { fyStart: s.fyStart });
    const due = ctDueDate(last.to);
    if (due >= today()) {
      const y = buildYearEnd(data, { from: last.from, to: last.to });
      if (y.ct.tax > 0) ct = { amount: y.ct.tax, due, note: `estimate for the year to ${dstr(last.to)}` };
    }
  }
  const ps = payoutSetup(data, { today: today(), days: days + 14, salesChange: scenario.salesChange || 0, delayDays: scenario.delayDays || 0 });
  const open = openingBalance(data.txns, { manual: s.cfOpeningManual ? { amount: s.cfOpeningAmount, date: s.cfOpeningDate } : null });
  const extra = [...ps.extraEvents, ...(open ? spendEvents(data.spendLog || [], data.txns, { balanceDate: open.date }) : [])];
  if (scenario.oneOff > 0) extra.push({ date: addDays(today(), 1), label: 'One-off purchase (what if)', amount: -scenario.oneOff, kind: 'planned', note: 'scenario' });
  const fc = forecast(data, { today: today(), days, buffer: Number(s.cfBuffer) || 0, payout: ps.payout, extraEvents: extra, includeStock, subscriptions: subs, ct });
  return Object.assign(fc, { setup: ps });
}

// Daily budget: safe to spend today, weekly stock allowance, payouts from sales.
function budgetFor(data, scenario = {}) {
  const s = data.settings;
  const horizon = Number(s.cfHorizon) || 28;
  const fc = cashFlowFor(data, Math.max(horizon, 35), { scenario, includeStock: false });
  if (!fc.ok) return { ok: false, reason: fc.reason };
  const safe = safeToSpend(fc, { today: today(), horizon, buffer: Number(s.cfBuffer) || 0 });
  const planned = plannedTxnIds(data);
  const lastBank = data.txns[0]?.date || today();
  const other = otherWeekly(data.txns, { to: lastBank, planned });
  const model = fc.setup.model?.ok ? fc.setup.model : null;
  return { ok: true, fc, safe, other, stockWeekly: Math.max(0, Math.round((safe.weekly - other) * 100) / 100), model, preds: fc.setup.preds || [], fallback: fc.setup.fallback, amz: model ? inAmazon(model, { today: today() }) : null, planned };
}

// Bank lines that paid an expected bill, Klarna instalment or subscription (so they don't count as spending).
function plannedTxnIds(data) {
  const { subs } = expenseModel(data);
  const from = addDays(today(), -60);
  const m = matchToBank(expectedItems(data.expenses || [], { from, to: today(), subscriptions: subs }), data.txns, { today: today() });
  return new Set(m.filter((x) => x.txnId).map((x) => x.txnId));
}

// Writes today's target and the next payouts' predictions once a day, to check later.
async function recordBudget(data, b) {
  if (!b?.ok) return;
  const t = today();
  if (!data.cashDays.some((x) => x.id === t)) {
    const rec = { id: t, target: b.safe.perDay, weekly: b.safe.weekly, stockWeekly: b.stockWeekly, balance: b.safe.now, buffer: b.safe.buffer, horizon: b.safe.horizon };
    await store.put('faCashDays', rec);
    data.cashDays.push(rec);
  }
  for (const p of b.preds.filter((x) => !x.known && x.cutoff).slice(0, 2)) {
    const cur = data.payoutPreds.find((x) => x.id === p.cutoff);
    if (cur && cur.lastMadeOn === t) continue;
    await store.put('faPayoutPreds', { ...(cur || { id: p.cutoff, firstAmount: p.amount, firstMadeOn: t, firstDate: p.date }), date: p.date, lastAmount: p.amount, lastMadeOn: t });
  }
}

function balanceChart(fc, buffer) {
  const W = 900; const H = 240; const L = 64; const R = 12; const T = 14; const B = 28;
  const xs = fc.series; if (xs.length < 2) return '';
  const vals = xs.map((p) => p.balance);
  let lo = Math.min(0, ...vals, buffer || 0); let hi = Math.max(...vals, buffer || 0);
  const pad = (hi - lo) * 0.08 || 100; lo -= pad; hi += pad;
  const x = (i) => L + (i / (xs.length - 1)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const step = (hi - lo) / 4; const mag = 10 ** Math.floor(Math.log10(step)); const nice = Math.ceil(step / mag) * mag;
  const ticks = []; for (let v = Math.ceil(lo / nice) * nice; v <= hi; v += nice) ticks.push(v);
  // stepped line: the balance changes on the day a payment lands
  let d = `M${x(0)},${y(vals[0])}`; for (let i = 1; i < xs.length; i++) d += `H${x(i)}V${y(vals[i])}`;
  const months = xs.map((p, i) => ({ p, i })).filter(({ p }) => p.date.endsWith('-01'));
  return `<div class="cf-chart" data-n="${xs.length}"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Forecast bank balance from ${fc.start} to ${fc.end}, lowest ${money(fc.low.balance)} on ${fc.low.date}">
    ${ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" class="ax">${money(v, '£', 0)}</text>`).join('')}
    ${lo < 0 ? `<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" class="zero"/>` : ''}
    ${buffer ? `<line x1="${L}" x2="${W - R}" y1="${y(buffer)}" y2="${y(buffer)}" class="buf"/><text x="${W - R}" y="${y(buffer) - 5}" text-anchor="end" class="ax">buffer ${money(buffer, '£', 0)}</text>` : ''}
    ${months.map(({ p, i }) => `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" class="ax">${new Date(`${p.date}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })}</text>`).join('')}
    <path d="${d}" class="line"/>
    <circle cx="${x(xs.findIndex((p) => p.date >= fc.low.date))}" cy="${y(fc.low.balance)}" r="4" class="low"/>
    <line class="xh" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/><circle class="xd" r="4" visibility="hidden"/>
    <rect class="hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}"/>
  </svg><div class="cf-tip" hidden></div></div>`;
}

function wireChart(host, fc) {
  const box = host.querySelector('.cf-chart'); if (!box) return;
  const svg = box.querySelector('svg'); const tip = box.querySelector('.cf-tip');
  const hit = svg.querySelector('.hit'); const xh = svg.querySelector('.xh'); const dot = svg.querySelector('.xd');
  const W = 900; const L = 64; const R = 12; const n = fc.series.length;
  hit.addEventListener('mousemove', (ev) => {
    const pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
    const loc = pt.matrixTransform(svg.getScreenCTM().inverse());
    const i = Math.max(0, Math.min(n - 1, Math.round(((loc.x - L) / (W - L - R)) * (n - 1))));
    const p = fc.series[i];
    const px = L + (i / (n - 1)) * (W - L - R);
    const path = svg.querySelector('.line'); const len = path.getTotalLength();
    // find the y on the stepped path at px by sampling
    let a = 0; let b = len; for (let k = 0; k < 24; k++) { const m = (a + b) / 2; if (path.getPointAtLength(m).x < px) a = m; else b = m; }
    const py = path.getPointAtLength(b).y;
    xh.setAttribute('x1', px); xh.setAttribute('x2', px); xh.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', px); dot.setAttribute('cy', py); dot.setAttribute('visibility', 'visible');
    const evs = fc.rows.filter((r) => r.date === p.date);
    tip.innerHTML = `<b>${dstr(p.date)}</b> · ${money(p.balance)}${evs.map((r) => `<div class="small">${esc(r.label)} <span class="${r.amount > 0 ? 'pos' : ''}">${money(r.amount)}</span></div>`).join('')}`;
    tip.hidden = false;
    const rect = box.getBoundingClientRect();
    const left = ((px / W) * rect.width);
    tip.style.left = `${Math.min(rect.width - 190, Math.max(0, left + 12))}px`;
  });
  hit.addEventListener('mouseleave', () => { tip.hidden = true; xh.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); });
}

// "Log a spend": quick to do on a phone at the till.
function openSpendLog(data, rerender) {
  const recentWhat = [...new Set([...(data.spendLog || [])].sort((a, b) => (b.at || 0) - (a.at || 0)).map((l) => l.what).filter(Boolean))].slice(0, 15);
  let kind = 'stock';
  const body = document.createElement('div');
  body.innerHTML = `<div class="form-grid">
      <label class="field">Amount £<input id="slAmt" type="number" inputmode="decimal" step="0.01" min="0" placeholder="0.00"></label>
      <label class="field">What<input id="slWhat" list="slList" placeholder="e.g. Currys, 6 kettles"><datalist id="slList">${recentWhat.map((w) => `<option value="${esc(w)}">`).join('')}</datalist></label>
      <label class="field">Date<input id="slDate" type="date" value="${today()}"></label>
    </div>
    <div class="row" style="margin-top:12px"><span class="small muted">It's</span><div class="seg" role="group"><button class="btn small primary" type="button" data-k="stock">Stock</button><button class="btn small" type="button" data-k="other">Something else</button></div></div>
    <p class="small muted" style="margin-top:10px">Counts against today's budget straight away. When you import the bank statement it's matched to the payment (same amount, within a few days) and stops counting separately.</p>`;
  body.querySelectorAll('[data-k]').forEach((b) => { b.onclick = () => { kind = b.dataset.k; body.querySelectorAll('[data-k]').forEach((x) => x.classList.toggle('primary', x === b)); }; });
  const save = async () => {
    const amount = Math.round((Number(body.querySelector('#slAmt').value) || 0) * 100) / 100;
    if (!(amount > 0)) { toast('Enter how much you spent', 'error'); return false; }
    const date = body.querySelector('#slDate').value || today();
    await store.put('faSpendLog', { id: `spend-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, date, amount, what: body.querySelector('#slWhat').value.trim(), kind, at: Date.now() });
    toast(`Logged ${money(amount)}`, 'success');
    rerender();
  };
  body.querySelector('#slAmt').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); body.querySelector('#slWhat').focus(); } };
  modal({ title: 'Log a spend', body, actions: [{ label: 'Cancel' }, { label: 'Log it', kind: 'primary', onClick: save }] });
  setTimeout(() => body.querySelector('#slAmt').focus(), 60);
}

// The daily budget card at the top of Cash flow.
function budgetSection(data) {
  const s = data.settings;
  const sc = ui.cfScenario || { salesChange: 0, delayDays: 0, oneOff: 0 };
  const scOn = !!(sc.salesChange || sc.delayDays || sc.oneOff);
  const b = budgetFor(data);
  if (!b.ok) return { html: '', b };
  const bs = scOn ? budgetFor(data, sc) : null;
  const buffer = Number(s.cfBuffer) || 0;
  const next = b.preds[0];
  const m = b.model;
  const sel = (id, opts, v) => `<select id="${id}">${opts.map(([val, l]) => `<option value="${val}" ${String(v) === String(val) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const cmp = (label, base, alt, fmt = (x) => money(x), better = 'up') => {
    const d = alt - base; const good = better === 'up' ? d >= 0 : d <= 0;
    return `<tr><td>${label}</td><td class="r num">${fmt(base)}</td><td class="r num"><b>${fmt(alt)}</b></td><td class="r num ${Math.abs(d) < 0.005 ? 'muted' : good ? 'pos' : 'neg'}">${Math.abs(d) < 0.005 ? 'same' : `${d > 0 ? '+' : '−'}${fmt(Math.abs(d))}`}</td></tr>`;
  };
  // today: the target set this morning, what's gone out (bank lines that aren't planned bills, plus spends you've logged)
  const t0 = today();
  const logs = matchSpendLog(data.spendLog || [], data.txns);
  const spentToday = (dailySpend(data.txns, { from: t0, to: t0, planned: b.planned }).get(t0)?.spent || 0) + logs.filter((l) => l.date === t0 && !l.txnId).reduce((a, l) => a + l.amount, 0);
  const target = data.cashDays.find((x) => x.id === t0)?.target ?? b.safe.perDay;
  const left = Math.round((target - spentToday) * 100) / 100;
  const recent = logs.filter((l) => l.date >= addDays(t0, -13)).sort((a, c) => c.date.localeCompare(a.date) || (c.at || 0) - (a.at || 0)).slice(0, 6);
  const html = `<div class="card card-pad stack budget">
    <div class="row"><h3 class="grow">${icon('wallet')} Daily budget</h3><span class="small muted">spread over the next ${b.safe.horizon} days, never going under your ${money(buffer, '£', 0)} buffer</span></div>
    <div class="kpis">
      ${kpi('Safe to spend today', money(target), spentToday ? `<span class="${left < 0 ? 'neg' : 'pos'}">${left < 0 ? `${money(-left)} over` : `${money(left)} left`}</span> · ${money(spentToday)} spent so far` : b.safe.perDay <= 0 ? 'nothing spare until the next payout' : b.safe.limit.date === addDays(today(), b.safe.horizon) ? `a day, every day for ${b.safe.horizon} days` : `a day · money is tightest on ${dstr(b.safe.limit.date)}`, target > 0 ? 'pos' : 'neg')}
      ${kpi('Stock allowance this week', money(b.stockWeekly, '£', 0), `${money(b.safe.weekly, '£', 0)} a week, less about ${money(b.other, '£', 0)} of other spending`)}
      ${next ? kpi('Next Amazon payout', money(next.amount, '£', 0), `${dstr(next.date)} · ${next.known ? 'settlement report' : 'predicted from your sales'}`) : kpi('Next Amazon payout', '—', b.fallback ? esc(b.fallback) : 'none in the forecast')}
      ${b.amz ? kpi('Waiting at Amazon', money(b.amz.due + b.amz.held, '£', 0), `${money(b.amz.due, '£', 0)} in the next payout · ${money(b.amz.held, '£', 0)} held for later`) : ''}
    </div>
    ${b.safe.short ? `<div class="callout warn small">You're about <b>${money(b.safe.short)}</b> short of staying above your buffer before ${dstr(b.safe.limit.date)}. Hold off stock buying, move a payment, or lower the buffer.</div>` : ''}
    <div class="spend-log">
      <div class="row"><button class="btn primary" id="logSpend" type="button">${icon('plus', 14)} Log a spend</button><span class="small muted grow">Note what you buy as you buy it, and today's figures update straight away. It matches itself to the bank line when you import the statement.</span></div>
      ${recent.length ? `<table class="data small"><tbody>${recent.map((l) => `<tr data-lid="${esc(l.id)}"><td class="nowrap">${dstr(l.date)}</td><td>${esc(l.what || (l.kind === 'stock' ? 'Stock' : 'Spend'))}${l.kind === 'stock' ? ' <span class="tag">stock</span>' : ''}</td><td class="r num">${money(l.amount)}</td>
        <td class="small">${l.txnId ? `<span class="pos">✓ in the bank ${dstr(l.txnDate)}</span>` : '<span class="muted">waiting for the bank</span>'}</td><td class="r"><button class="icon-btn" data-dellog title="Remove">${icon('trash', 14)}</button></td></tr>`).join('')}</tbody></table>` : ''}
    </div>
    <p class="small muted">Today's balance (${money(b.safe.now)}, from your latest bank line plus anything due since), plus Amazon ${m ? 'payouts predicted from your sales' : 'payouts from your payout history'} and eBay payouts, minus every bill, Klarna instalment, subscription and tax payment due in the next ${b.safe.horizon} days, minus your buffer, spread so the balance never dips under the buffer on any day. Stock is left out: the allowance is what's free for it.</p>
    <details ${scOn ? 'open' : ''}><summary class="small">What if…</summary>
      <div class="row" style="margin-top:10px">
        <label class="field">Sales${sel('scSales', [[-0.5, '50% lower'], [-0.3, '30% lower'], [-0.2, '20% lower'], [-0.1, '10% lower'], [0, 'as usual'], [0.1, '10% higher'], [0.2, '20% higher'], [0.3, '30% higher']], sc.salesChange)}</label>
        <label class="field">Payouts arrive${sel('scDelay', [[0, 'on time'], [2, '2 days late'], [5, '5 days late'], [14, 'a cycle late']], sc.delayDays)}</label>
        <label class="field">One-off buy tomorrow £<input id="scOne" type="number" step="50" min="0" value="${esc(sc.oneOff || '')}" style="width:110px"></label>
        <button class="btn small" id="scGo">Show</button>${scOn ? '<button class="btn small ghost" id="scReset">Back to normal</button>' : ''}
      </div>
      ${bs?.ok ? `<div class="table-wrap" style="margin-top:10px"><table class="data small"><thead><tr><th></th><th class="r">Normal</th><th class="r">What if</th><th class="r">Change</th></tr></thead><tbody>
        ${cmp('Safe to spend a day', b.safe.perDay, bs.safe.perDay)}
        ${cmp('Stock allowance a week', b.stockWeekly, bs.stockWeekly)}
        ${cmp('Lowest balance', b.safe.low.balance, bs.safe.low.balance)}
        ${cmp(`Amazon payouts, next ${b.safe.horizon} days`, b.preds.filter((p) => p.date <= addDays(today(), b.safe.horizon)).reduce((a, p) => a + p.amount, 0), bs.preds.filter((p) => p.date <= addDays(today(), b.safe.horizon)).reduce((a, p) => a + p.amount, 0))}
      </tbody></table></div>${bs.safe.short ? `<div class="callout warn small" style="margin-top:8px">In this case you'd be about <b>${money(bs.safe.short)}</b> short of your buffer before ${dstr(bs.safe.limit.date)}.</div>` : ''}` : ''}
    </details>
  </div>`;
  return { html, b };
}

function spendSection(data, b) {
  const lastBank = data.txns[0]?.date || '';
  const from = addDays(today(), -13);
  const spent = dailySpend(data.txns, { from, to: today(), planned: b.planned });
  const targets = new Map(data.cashDays.map((x) => [x.id, x]));
  // spends you logged that the bank doesn't show yet count on their day
  const logged = new Map();
  for (const l of matchSpendLog(data.spendLog || [], data.txns)) if (!l.txnId) logged.set(l.date, (logged.get(l.date) || 0) + l.amount);
  const rows = []; let ahead = 0; let n = 0;
  for (let d = today(); d >= from; d = addDays(d, -1)) {
    const t = targets.get(d)?.target ?? null; const b0 = spent.get(d); const lg = logged.get(d) || 0;
    const sp = b0 || lg ? { spent: Math.round(((b0?.spent || 0) + lg) * 100) / 100, stock: b0?.stock || 0, logged: lg } : null;
    const covered = (lastBank && d <= lastBank) || lg > 0;
    if (t !== null && covered) { ahead += t - (sp?.spent || 0); n++; }
    rows.push({ d, t, sp, covered });
  }
  const max = Math.max(1, ...rows.map((r) => Math.max(r.t || 0, r.sp?.spent || 0)));
  return `<div class="card"><div class="toolbar"><b>Spending against target</b><span class="small muted">last 14 days · bank lines that weren't a planned bill</span></div>
    ${n ? `<p class="small" style="padding:10px 14px 0">${ahead >= 0 ? `<span class="pos">${money(ahead)} under</span>` : `<span class="neg">${money(-ahead)} over</span>`} target across ${n} day${n === 1 ? '' : 's'} with bank data or logged spends.</p>` : '<p class="small muted" style="padding:10px 14px 0">Targets are recorded each day from today. Spending shows once that day\'s bank lines are imported, or straight away for spends you log.</p>'}
    <div class="table-wrap"><table class="data small"><thead><tr><th>Day</th><th class="r">Target</th><th class="r">Spent</th><th style="width:38%"></th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td class="nowrap">${dstr(r.d)}${r.d === today() ? ' <span class="tag">today</span>' : ''}</td><td class="r num">${r.t === null ? '<span class="muted">—</span>' : money(r.t)}</td>
      <td class="r num">${!r.covered ? '<span class="muted">not imported</span>' : r.sp ? `<span class="${r.t !== null && r.sp.spent > r.t ? 'neg' : ''}">${money(r.sp.spent)}</span>${r.sp.stock ? `<div class="muted">stock ${money(r.sp.stock, '£', 0)}</div>` : ''}${r.sp.logged ? `<div class="muted">${money(r.sp.logged, '£', 0)} logged</div>` : ''}` : money(0)}</td>
      <td><div class="bar-cell"><div class="bar-track"><span class="${r.t !== null && (r.sp?.spent || 0) > r.t ? 'neg' : ''}" style="width:${Math.round(((r.sp?.spent || 0) / max) * 100)}%"></span></div></div></td></tr>`).join('')}
    </tbody></table></div></div>`;
}

function accuracySection(data, b) {
  const m = b.model;
  if (!m) return `<div class="card card-pad"><b>Predicted vs actual payouts</b><p class="small muted">${esc(b.fallback || 'Switch Amazon payouts to "From your sales" in the forecast settings below.')}</p></div>`;
  const near = (cut) => m.cycles.find((c) => Math.abs((Date.parse(c.cutoff) - Date.parse(cut)) / 864e5) <= 2);
  const logged = [...data.payoutPreds].sort((a, b2) => b2.id.localeCompare(a.id)).slice(0, 8).map((p) => ({ ...p, actual: near(p.id) }));
  const err = (pred, act) => (act ? `${pred >= act ? '+' : '−'}${Math.round((Math.abs(pred - act) / act) * 100)}%` : '');
  const bars = m.pattern.byDay; const bmax = Math.max(1, ...bars.map((x) => Math.abs(x)));
  return `<div class="card"><div class="toolbar"><b>Predicted vs actual payouts</b><span class="small muted">${m.accuracy ? `typically within ±${Math.round(m.accuracy.mape * 100)}% (${m.accuracy.n} past payouts)` : 'needs a few more payouts with order data to check'}</span></div>
    <p class="small muted" style="padding:10px 14px 0">Learned from your data: Amazon pays an order out about <b>${m.hold} days</b> after it's placed${m.holdLearned ? '' : ' (set by you)'}, settles every <b>${m.cadence === 1 ? 'day' : `${m.cadence} days`}</b>, and the money reaches your bank <b>${m.lag} day${m.lag === 1 ? '' : 's'}</b> later. Account fees net ${money(m.acctPerDay)} a day.${m.factor !== 1 ? ` Payouts run ${Math.round(Math.abs(1 - m.factor) * 100)}% ${m.factor > 1 ? 'above' : 'below'} what the orders alone suggest, so forecasts are adjusted by that.` : ''} Orders imported up to ${dstr(m.lastOrderDate)}.</p>
    ${logged.length ? `<div class="table-wrap"><table class="data small"><thead><tr><th>Payout</th><th class="r">First forecast</th><th class="r">Latest</th><th class="r">Arrived</th><th class="r">Out by</th></tr></thead><tbody>
      ${logged.map((p) => `<tr><td class="nowrap">${dstr(p.date)}</td><td class="r num">${money(p.firstAmount, '£', 0)}<div class="muted">${dstr(p.firstMadeOn)}</div></td><td class="r num">${money(p.lastAmount, '£', 0)}</td><td class="r num">${p.actual ? money(p.actual.amount, '£', 0) : '<span class="muted">not yet</span>'}</td><td class="r num">${p.actual ? err(p.lastAmount, p.actual.amount) : ''}</td></tr>`).join('')}
    </tbody></table></div>` : ''}
    ${m.backtest.length ? `<details style="padding:8px 14px"><summary class="small">Checked against your past payouts (${m.backtest.length})</summary><div class="table-wrap"><table class="data small"><thead><tr><th>Payout</th><th class="r">Model</th><th class="r">Actual</th><th class="r">Out by</th></tr></thead><tbody>
      ${[...m.backtest].reverse().slice(0, 12).map((r) => `<tr><td class="nowrap">${dstr(r.bankDate || r.cutoff)}</td><td class="r num">${money(r.predicted, '£', 0)}</td><td class="r num">${money(r.actual, '£', 0)}</td><td class="r num ${Math.abs(r.diff) / r.actual > 0.15 ? 'warn-text' : 'muted'}">${err(r.predicted, r.actual)}</td></tr>`).join('')}
    </tbody></table></div></details>` : ''}
    <div style="padding:6px 14px 12px"><div class="small muted" style="margin-bottom:6px">Your usual takings after Amazon fees, by weekday</div>
      <div class="wk-bars">${bars.map((x, i) => `<div><span style="height:${Math.round((Math.max(0, x) / bmax) * 60) + 2}px"></span><b>${money(x, '£', 0)}</b><i>${WEEKDAYS[i]}</i></div>`).join('')}</div></div>
  </div>`;
}

async function renderCashflow(body, data, rerender) {
  const s = data.settings;
  const days = ui.cfDays || 90;
  const fc = cashFlowFor(data, days);
  if (!fc.ok) {
    body.innerHTML = emptyState('pound', 'No bank balance yet', esc(fc.reason), '<a class="btn primary" href="#fbaadmin/import">Import a bank statement</a>');
    return;
  }
  const buffer = Number(s.cfBuffer) || 0;
  const bud = budgetSection(data);
  await recordBudget(data, bud.b);
  const warn = fc.belowZero ? `<div class="callout warn" style="margin-bottom:12px"><b>The balance goes below £0 on ${dstr(fc.belowZero.date)}</b> (${esc(fc.belowZero.label)}, ${money(fc.belowZero.amount)}). Move a payment, slow stock buying or put money in.</div>`
    : fc.belowBuffer ? `<div class="callout warn" style="margin-bottom:12px">The balance drops under your ${money(buffer)} buffer on <b>${dstr(fc.belowBuffer.date)}</b>, lowest ${money(fc.low.balance)} on ${dstr(fc.low.date)}.</div>` : '';
  body.innerHTML = `
    ${bud.html}
    ${bud.b.ok ? `<div class="grid2 section">${spendSection(data, bud.b)}${accuracySection(data, bud.b)}</div>` : ''}
    <h4 class="section">Bank balance forecast</h4>
    <div class="row" style="margin:8px 0 12px"><div class="seg" role="group">${[30, 60, 90].map((d) => `<button class="btn small ${days === d ? 'primary' : ''}" data-cfd="${d}">${d} days</button>`).join('')}</div>
      <span class="small muted">from ${dstr(fc.start)} to ${dstr(fc.end)}</span><span class="grow"></span>
      <a class="btn small" href="#fbaadmin/expenses">${icon('plus', 14)} Add costs or income</a></div>
    ${warn}
    <div class="kpis">
      ${kpi('Bank balance', money(fc.open.amount), `${fc.open.source === 'bank' ? 'latest bank line' : 'entered'}, ${dstr(fc.open.date)}`)}
      ${kpi('In 30 days', money(fc.in30), '', fc.in30 < 0 ? 'neg' : '')}
      ${days >= 60 ? kpi('In 60 days', money(fc.in60), '', fc.in60 < 0 ? 'neg' : '') : ''}
      ${days >= 90 ? kpi('In 90 days', money(fc.in90), '', fc.in90 < 0 ? 'neg' : '') : ''}
      ${kpi('Lowest point', money(fc.low.balance), dstr(fc.low.date), fc.low.balance < 0 ? 'neg' : fc.low.balance < buffer ? 'warn-text' : '')}
      ${kpi('Coming in', money(fc.moneyIn, '£', 0), `going out ${money(fc.moneyOut, '£', 0)}`)}
    </div>
    <div class="card section"><div class="toolbar"><b>Forecast bank balance</b><span class="small muted">hover for the day's payments</span></div><div style="padding:6px 12px 10px">${balanceChart(fc, buffer)}</div></div>
    <p class="small muted section">${[fc.setup?.model?.ok ? 'Amazon payouts: predicted from your sales (see Predicted vs actual above).' : fc.payout ? `Amazon payouts: ${esc(fc.payout.source)}.${fc.setup?.fallback ? ` (Not from sales yet: ${esc(fc.setup.fallback)})` : ''}` : 'No Amazon payouts forecast.', fc.stock ? `Stock buying: ${money(fc.stock.weekly, '£', 0)} a week, what you spent on stock from the bank in the last ${fc.stock.span} days.` : '', ...fc.notes.map(esc)].filter(Boolean).join(' ')}</p>
    <div class="grid2 section">
      <div class="card"><div class="toolbar"><b>${fc.rows.length} expected payments</b><span class="grow"></span><button class="btn small" id="cfCsv">${icon('download', 14)} CSV</button></div>
        <div class="table-wrap" style="max-height:520px;overflow:auto"><table class="data"><thead><tr><th>Date</th><th>What</th><th class="r">Amount</th><th class="r">Balance</th></tr></thead><tbody>
        <tr><td class="small nowrap">${dstr(fc.open.date)}</td><td class="small"><b>Starting balance</b></td><td></td><td class="r num"><b>${money(fc.open.amount)}</b></td></tr>
        ${fc.rows.map((r) => `<tr><td class="small nowrap">${dstr(r.date)}</td><td class="small"><b>${esc(r.label)}</b><div class="muted">${esc([r.kind === 'payout' ? 'payout' : r.kind === 'stock' ? 'stock' : r.kind === 'tax' ? 'tax' : r.kind === 'subscription' ? 'subscription' : r.kind === 'planned' ? 'one-off' : 'recurring', r.note].filter(Boolean).join(' · '))}</div></td>
          <td class="r num ${r.amount > 0 ? 'pos' : ''}">${money(r.amount)}</td><td class="r num ${r.balance < 0 ? 'neg' : r.balance < buffer ? 'warn-text' : ''}">${money(r.balance)}</td></tr>`).join('')}
        </tbody></table></div></div>
      <div class="card card-pad stack">
        <h3>${icon('gear')} Forecast settings</h3>
        <div class="form-grid">
          <label class="field">Buffer: keep at least £<input id="cfBuf" type="number" step="50" min="0" value="${esc(s.cfBuffer ?? 500)}"></label>
          <label class="field">Amazon payouts<select id="cfMode"><option value="sales" ${s.cfPayoutMode === 'sales' ? 'selected' : ''}>From your sales (recommended)</option><option value="auto" ${s.cfPayoutMode === 'auto' ? 'selected' : ''}>From your payout history</option><option value="manual" ${s.cfPayoutMode === 'manual' ? 'selected' : ''}>I'll set them</option><option value="off" ${s.cfPayoutMode === 'off' ? 'selected' : ''}>Leave them out</option></select></label>
          <label class="field">Spread the daily budget over<select id="cfHz">${[[14, '14 days'], [28, '28 days'], [42, '6 weeks']].map(([v, l]) => `<option value="${v}" ${Number(s.cfHorizon || 28) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        </div>
        <details id="cfTiming" ${s.cfPayoutMode === 'sales' ? '' : 'hidden'}><summary class="small">Amazon's payout timing (learned automatically)</summary>
          <div class="form-grid" style="margin-top:8px">
            <label class="field">Days an order is held<select id="cfHold"><option value="auto">Learn from my payouts</option>${[...Array(22).keys()].map((n) => `<option value="${n}" ${String(s.cfReserveDays) === String(n) ? 'selected' : ''}>${n}</option>`).join('')}</select><span class="hint">delivery + 7 days is usual (Amazon's reserve)</span></label>
            <label class="field">Settlement every<select id="cfCad"><option value="auto">Learn from my payouts</option>${[[1, 'day (daily payouts)'], [7, '7 days'], [14, '14 days']].map(([v, l]) => `<option value="${v}" ${String(s.cfCadence) === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
            <label class="field">Days from settlement to bank<select id="cfLag"><option value="auto">Learn from my payouts</option>${[0, 1, 2, 3, 4, 5, 6, 7].map((n) => `<option value="${n}" ${String(s.cfLagDays) === String(n) ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          </div>
        </details>
        <div class="form-grid" id="cfMan" ${s.cfPayoutMode === 'manual' ? '' : 'hidden'}>
          <label class="field">Typical payout £<input id="cfAmt" type="number" step="10" min="0" value="${esc(s.cfPayoutAmount ?? '')}"></label>
          <label class="field">Every (days)<input id="cfEvery" type="number" step="1" min="1" value="${esc(s.cfPayoutEvery ?? 14)}"></label>
          <label class="field">Next payout<input id="cfNext" type="date" value="${esc(s.cfPayoutNext || '')}"></label>
        </div>
 <label class="check"><input type="checkbox" id="cfStock" ${s.cfIncludeStock !== false ? 'checked' : ''}> Include stock buying at your usual weekly rate (untick if you add planned stock buys yourself)</label>
        <label class="check"><input type="checkbox" id="cfCt" ${s.cfIncludeCt !== false ? 'checked' : ''}> Include last year's corporation tax when it's due (9 months and 1 day after the year end)</label>
        <label class="check"><input type="checkbox" id="cfOpen" ${s.cfOpeningManual ? 'checked' : ''}> Use a starting balance I enter (instead of the latest bank line)</label>
        <div class="form-grid" id="cfOpenF" ${s.cfOpeningManual ? '' : 'hidden'}>
          <label class="field">Balance £<input id="cfOA" type="number" step="0.01" value="${esc(s.cfOpeningAmount ?? '')}"></label>
          <label class="field">On<input id="cfOD" type="date" value="${esc(s.cfOpeningDate || today())}"></label>
        </div>
        <div class="row"><button class="btn primary" id="cfSave">${icon('check')} Save</button></div>
        <p class="small muted">What's in the forecast: your recurring and planned costs and income (Expenses tab), confirmed subscriptions, Amazon and eBay payouts at their usual rhythm, and corporation tax. Costs you pay personally aren't included because they don't leave the business account. Stock buying is included at the weekly rate you've spent on it recently; untick it and add planned buys as one-offs if you'd rather.</p>
      </div>
    </div>`;
  wireChart(body, fc);
  body.querySelectorAll('[data-cfd]').forEach((b) => { b.onclick = () => { ui.cfDays = Number(b.dataset.cfd); rerender(); }; });
  const $ = (id) => body.querySelector(`#${id}`);
  $('cfMode').onchange = () => { $('cfMan').hidden = $('cfMode').value !== 'manual'; $('cfTiming').hidden = $('cfMode').value !== 'sales'; };
  $('cfOpen').onchange = () => { $('cfOpenF').hidden = !$('cfOpen').checked; };
  // spend log
  const ls = $('logSpend'); if (ls) ls.onclick = () => openSpendLog(data, rerender);
  body.querySelectorAll('[data-dellog]').forEach((b) => { b.onclick = async () => { await store.del('faSpendLog', b.closest('tr').dataset.lid); toast('Removed'); rerender(); }; });
  if (ui.openSpendLog) { ui.openSpendLog = false; if (ls) openSpendLog(data, rerender); }
  $('cfSave').onclick = async () => {
    if ($('cfMode').value === 'manual' && (!(Number($('cfAmt').value) > 0) || !$('cfNext').value)) return toast('Enter the typical payout and the next payout date', 'error');
    await saveSettings({ cfBuffer: Math.max(0, Number($('cfBuf').value) || 0), cfPayoutMode: $('cfMode').value, cfPayoutAmount: $('cfAmt').value, cfPayoutEvery: Math.max(1, Number($('cfEvery').value) || 14), cfPayoutNext: $('cfNext').value, cfIncludeCt: $('cfCt').checked, cfIncludeStock: $('cfStock').checked, cfOpeningManual: $('cfOpen').checked, cfOpeningAmount: $('cfOA').value, cfOpeningDate: $('cfOD').value,
      cfHorizon: Number($('cfHz').value) || 28, cfReserveDays: $('cfHold').value, cfCadence: $('cfCad').value, cfLagDays: $('cfLag').value });
    toast('Saved', 'success'); rerender();
  };
  // what-if scenarios (not saved: just for looking)
  const sg = $('scGo');
  if (sg) {
    sg.onclick = () => { ui.cfScenario = { salesChange: Number($('scSales').value) || 0, delayDays: Number($('scDelay').value) || 0, oneOff: Math.max(0, Number($('scOne').value) || 0) }; rerender(); };
    const sr = $('scReset'); if (sr) sr.onclick = () => { ui.cfScenario = null; rerender(); };
  }
  $('cfCsv').onclick = () => downloadFile(`cash-flow-forecast-${today()}.csv`, toCSV([['Date', 'What', 'Type', 'Note', 'Amount', 'Balance'], [fc.open.date, 'Starting balance', '', '', '', fc.open.amount], ...fc.rows.map((r) => [r.date, r.label, r.kind, r.note, r.amount, r.balance])]));
}

// ---------------------------------------------------------------------------
// Monthly targets (dashboard card) and aged stock (Stock tab)
// ---------------------------------------------------------------------------
function targetCard(data) {
  const t0 = today(); const month = t0.slice(0, 7);
  const mp = monthProgress(data, month, { today: t0, basis: ui.basis, overheadSource: data.settings.overheadSource, allocate: data.settings.allocate });
  const name = new Date(`${month}-15T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });
  if (!mp.hasTarget) return `<div class="card card-pad section small row"><span class="grow">${icon('chart')} Set a monthly sales and profit target to see your progress and the pace you need.</span><a class="btn small" href="#fbaadmin/settings">Set targets</a></div>`;
  const bar = (label, x) => (x.target === null ? '' : `<div class="stack" style="flex:1;min-width:220px">
    <div class="row"><b class="grow">${label}</b><span class="num"><b>${money(x.have, '£', 0)}</b> <span class="muted">of ${money(x.target, '£', 0)}</span></span></div>
    <div class="vat-bar"><span style="width:${Math.max(0, Math.min(100, Math.round((x.pct || 0) * 100)))}%;${x.onTrack === false ? 'background:var(--warn)' : ''}"></span></div>
    <div class="small muted">${pct(x.pct || 0)} · ${mp.left ? `on course for ${money(x.projected, '£', 0)}${x.perDayNeeded ? ` · need ${money(x.perDayNeeded)}/day for the last ${mp.left} days` : ' · target reached'}` : x.have >= x.target ? 'target reached' : `missed by ${money(x.target - x.have, '£', 0)}`}</div></div>`);
  return `<div class="card card-pad section"><div class="row" style="margin-bottom:8px"><h3 class="grow">${esc(name)} target</h3><span class="small muted">${ui.basis === 'combined' ? 'Amazon + eBay' : 'Amazon only'} · ${mp.noOrders ? `no ${SRC()} orders imported for this month yet` : `orders up to ${dstr(mp.upTo)}`}</span><a class="btn small ghost" href="#fbaadmin/settings">Edit</a></div>
    <div class="row" style="gap:24px;align-items:flex-start">${bar('Sales', mp.sales)}${bar('Net profit', mp.profit)}</div></div>`;
}

function agedFor(data) {
  const sr = stockReport(data);
  const sellable = Object.fromEntries(sr.rows.filter((x) => x.sellable).map((x) => [x.sku, x.sellable]));
  const titles = Object.fromEntries(sr.rows.map((x) => [x.sku, x.title]));
  const avgCost = Object.fromEntries(sr.rows.filter((x) => x.avgCost).map((x) => [x.sku, x.avgCost]));
  return agedReport({ asOf: sr.asOf || today(), health: data.health, sellableBySku: sellable, ledger: data.ledger, stock: data.stock, titles, avgCost, warnDays: Number(data.settings.agedWarnDays) || 60 });
}

function agedSection(data) {
  const a = agedFor(data);
  if (!a.rows.length) return '';
  const warnDays = Number(data.settings.agedWarnDays) || 60;
  const band = (r, k) => (r.bands[k] ? `<span class="${k === '365+' || k === '271-365' ? 'neg' : k === '181-270' ? 'warn-text' : ''}">${r.bands[k]}</span>` : '<span class="muted">·</span>');
  const show = a.rows.filter((r) => r.charged || r.soon || r.bands['181-270'] || r.bands['91-180']).slice(0, 60);
  return `<div class="card section"><div class="toolbar"><b>Aged stock</b><span class="small muted">${a.method === 'estimate' ? 'estimated from ledger receipts and purchase dates (import the FBA Inventory report for Amazon\'s own ages and fee estimate)' : `Amazon's FBA Inventory report, ${dstr(a.asOf)}`}</span></div>
    <div class="kpis" style="padding:0 14px 12px">
      ${kpi('Paying the surcharge', num(a.totals.charged), 'units over 240 days at Amazon', a.totals.charged ? 'neg' : '')}
      ${kpi(a.method === 'estimate' ? `Reach it within ${warnDays} days` : 'Getting close', num(a.totals.soon), a.method === 'estimate' ? 'lower the price or remove them' : 'units aged 181–270 days', a.totals.soon ? 'warn-text' : '')}
      ${kpi('Surcharge per month', a.totals.estMonthlyFee ? money(a.totals.estMonthlyFee) : '—', a.totals.estMonthlyFee ? 'estimate' : 'needs unit volumes (FBA Inventory report)')}
      ${kpi('Stock at cost involved', money(a.totals.costAtRisk), 'aged or nearly aged units')}
    </div>
    ${show.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>SKU</th><th class="r">0–90</th><th class="r">91–180</th><th class="r">181–270</th><th class="r">271–365</th><th class="r">365+</th><th>Surcharge</th><th class="r">Per month</th></tr></thead><tbody>
      ${show.map((r) => `<tr><td><div style="max-width:300px"><b class="small">${esc((r.title || '').slice(0, 60))}</b><div class="small muted mono">${esc(r.sku)}</div></div></td>
        ${['0-90', '91-180', '181-270', '271-365', '365+'].map((k) => `<td class="r num">${band(r, k)}</td>`).join('')}
        <td class="small">${r.feeStarts === 'now' ? `<span class="neg">${r.charged} paying now</span>` : r.feeStarts === 'within 90 days' ? `<span class="warn-text">${r.soon} near</span>` : r.feeStarts ? `<span class="${r.soon ? 'warn-text' : 'muted'}">from ${dstr(r.feeStarts)}</span>` : '<span class="muted">—</span>'}${r.unknown ? `<div class="muted">${r.unknown} older than your data</div>` : ''}${r.action ? `<div class="muted">${esc(r.action)}</div>` : ''}</td>
        <td class="r num">${r.estMonthlyFee ? money(r.estMonthlyFee) : '—'}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="small muted" style="padding:0 14px 12px">Nothing older than 90 days at Amazon. 👍</p>'}
    <p class="small muted" style="padding:0 14px 12px">Amazon adds an aged inventory surcharge from day 241 (UK rate card, Feb 2026): £1.18 per cubic foot a month at 241–270 days, about £3.14–£3.41 at 271–365, then £5.71–£6.14 (minimum 20p–25p a unit). Clothing, footwear, bags, luggage and jewellery are exempt. To avoid it, lower the price, run a promotion, or create a removal order before the date.</p>
  </div>`;
}

// ---------------------------------------------------------------------------
// Accountant pack (zip) — from the Year end tab
// ---------------------------------------------------------------------------
function packPeriods(fyStart) {
  const out = [];
  for (const id of ['this_fy', 'last_fy']) {
    const r = presetRange(id, { fyStart });
    const fyFrom = r.from; const fyTo = id === 'this_fy' ? (() => { const d = new Date(`${fyFrom}T00:00:00Z`); d.setUTCFullYear(d.getUTCFullYear() + 1); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })() : r.to;
    out.push({ id: `${id}`, label: `${id === 'this_fy' ? 'This' : 'Last'} financial year (${dstr(fyFrom)} – ${dstr(fyTo)})`, from: fyFrom, to: id === 'this_fy' && fyTo > today() ? today() : fyTo });
    for (let q = 0; q < 4; q++) {
      const s = new Date(`${fyFrom}T00:00:00Z`); s.setUTCMonth(s.getUTCMonth() + q * 3);
      const e = new Date(`${fyFrom}T00:00:00Z`); e.setUTCMonth(e.getUTCMonth() + (q + 1) * 3); e.setUTCDate(e.getUTCDate() - 1);
      const from = s.toISOString().slice(0, 10); const to = e.toISOString().slice(0, 10);
      if (from > today()) continue;
      out.push({ id: `${id}_q${q + 1}`, label: `  Q${q + 1}: ${dstr(from)} – ${dstr(to)}`, from, to: to > today() ? today() : to });
    }
  }
  return out;
}

function packCard(data) {
  const ps = packPeriods(data.settings.fyStart);
  return `<div class="card card-pad stack section no-print"><div class="row"><h3 class="grow">${icon('download')} Accountant pack</h3></div>
    <p class="small muted">One zip with everything for a year or a quarter: a printable summary, the P&L, bank transactions (with which receipt goes with each), costs outside the bank, the director's loan, sold products, payouts and Amazon fees, stock, subscriptions, and every invoice you've saved, in month folders.</p>
    <div class="row"><select id="packP">${ps.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('')}</select>
      <button class="btn primary" id="packGo">${icon('download')} Download zip</button></div></div>`;
}

function wirePack(body, data) {
  const go = body.querySelector('#packGo'); if (!go) return;
  go.onclick = async () => {
    const p = packPeriods(data.settings.fyStart).find((x) => x.id === body.querySelector('#packP').value);
    go.disabled = true; go.textContent = 'Building…';
    try {
      const { bytes, count } = buildPack(data, { from: p.from, to: p.to, today: today() });
      const name = `${(data.settings.companyName || 'accounts').replace(/[^A-Za-z0-9]+/g, '-')}_${p.from}_to_${p.to}.zip`;
      downloadFile(name, new Blob([bytes], { type: 'application/zip' }));
      toast(`Downloaded ${name} (${count} files, ${(bytes.length / 1048576).toFixed(1)} MB)`, 'success', 6000);
    } catch (e) { toast(`Couldn't build the pack: ${e.message}`, 'error', 7000); }
    go.disabled = false; go.innerHTML = `${icon('download')} Download zip`;
  };
}

// ---------------------------------------------------------------------------
// Director's loan: the balance the company owes you, every movement, and entries you add here
// ---------------------------------------------------------------------------
const SRC_TAG = { bank: '<span class="tag">Bank</span>', personal: '<span class="tag pers">Paid personally</span>', entry: '<span class="tag new">Added here</span>' };

function dlaPeriod(data) {
  const s = data.settings;
  const id = ui.dlaPeriod || 'this_fy';
  if (id === 'all') {
    const first = (data.dlaTxns || []).filter((t) => t.category === 'Director Loan').reduce((m, t) => (!m || t.date < m ? t.date : m), '');
    const from = s.dlaOpeningDate || first || today();
    return { id, from, to: today(), label: `Since ${dstr(from)}` };
  }
  const r = presetRange(id, { fyStart: s.fyStart });
  return { id, from: r.from, to: r.to, label: r.label };
}

function renderDla(body, data, rerender) {
  const s = data.settings;
  const p = dlaPeriod(data);
  const op = p.id === 'all' ? { known: !!s.dlaOpeningDate, opening: (Number(s.dlaOpening) || 0) * (s.dlaDirection === 'director_owes_company' ? -1 : 1) } : dlaOpeningAt(data, p.from);
  const st = dlaStatement(data.dlaTxns, { opening: op.opening, from: p.from, to: p.to });
  const fy = presetRange('this_fy', { fyStart: s.fyStart });
  const now = dlaStatement(data.dlaTxns, { opening: dlaOpeningAt(data, fy.from).opening, from: fy.from, to: today() });
  const series = balanceSeries(st.rows, st.opening, p.from, p.to);
  const low = series.reduce((m, x) => (x.balance < m.balance ? x : m), series[0] || { date: p.from, balance: st.opening });
  const chartData = { series, start: p.from, end: p.to, low, rows: st.rows.map((r) => ({ date: r.date, label: r.description, amount: r.amount })) };
  body.innerHTML = `
    <div class="row" style="margin-bottom:12px">
      <select id="dlaP">${[['this_fy', 'This financial year'], ['last_fy', 'Last financial year'], ['all', 'Since the opening balance']].map(([v, l]) => `<option value="${v}" ${p.id === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <span class="small muted">${esc(p.label)}</span><span class="grow"></span>
      <button class="btn small" id="dlaOpen">${icon('gear', 14)} Opening balance</button>
      <button class="btn small" id="dlaCsv">${icon('download', 14)} CSV</button>
      <button class="btn small primary" id="dlaAdd">${icon('plus', 14)} Add entry</button>
    </div>
    ${op.known ? '' : `<div class="callout warn small" style="margin-bottom:12px">No opening balance for this period yet. Click <b>Opening balance</b> and enter what the company owed you on a date (your last accounts show it, or 0 if there wasn't one).</div>`}
    <div class="kpis">
      ${kpi('The company owes you', money(now.closing), `now · ${dstr(today())}`, now.closing < 0 ? 'neg' : 'pos')}
      ${kpi('Put in', money(st.paidIn), esc(p.label))}
      ${kpi('Repaid to you / spent personally', money(st.paidOut), 'Klarna, money back to you')}
      ${kpi('Opening balance', money(st.opening), `on ${dstr(p.from)}`)}
      ${kpi('Closing balance', money(st.closing), `on ${dstr(p.to > today() ? today() : p.to)}`)}
    </div>
    <div class="card section"><div class="toolbar"><b>Balance over time</b><span class="small muted">hover for the movements on a day</span></div><div style="padding:6px 12px 10px">${balanceChart(chartData, 0)}</div></div>
    <div class="grid2 section">
      <div class="card"><div class="toolbar"><b>Statement</b><span class="small muted">+ the company owes you more · − repaid to you or spent personally</span></div>
        <div class="table-wrap" style="max-height:560px;overflow:auto"><table class="data"><thead><tr><th>Date</th><th>What</th><th>From</th><th class="r">Amount</th><th class="r">Balance</th><th></th></tr></thead><tbody>
          <tr><td class="small nowrap">${dstr(p.from)}</td><td colspan="2"><b class="small">Opening balance</b></td><td></td><td class="r num"><b>${money(st.opening)}</b></td><td></td></tr>
          ${st.rows.map((r) => { const t = r; const src = sourceOf(t); return `<tr><td class="small nowrap">${dstr(r.date)}</td><td class="small"><b>${esc(r.description)}</b>${t.note ? `<div class="muted">${esc(t.note)}</div>` : ''}</td><td>${SRC_TAG[src]}</td>
            <td class="r num ${r.amount > 0 ? 'pos' : ''}">${money(r.amount)}</td><td class="r num">${money(r.balance)}</td>
            <td class="r nowrap">${src === 'entry' ? `<button class="icon-btn" data-dla-edit="${esc(t.entryId)}" title="Edit">${icon('gear', 15)}</button>` : src === 'bank' ? `<a class="icon-btn" href="#fbaadmin/transactions" title="In Transactions">${icon('external', 15)}</a>` : `<a class="icon-btn" href="#fbaadmin/expenses" title="In Expenses">${icon('external', 15)}</a>`}</td></tr>`; }).join('') || '<tr><td colspan="6" class="empty">No movements in this period</td></tr>'}
          <tr><td class="small nowrap">${dstr(p.to > today() ? today() : p.to)}</td><td colspan="2"><b class="small">Closing balance</b></td><td></td><td class="r num"><b>${money(st.closing)}</b></td><td></td></tr>
        </tbody></table></div></div>
      <div class="card card-pad stack">
        <h3>${icon('pound')} What moves the balance</h3>
        <ul class="small" style="margin:0 0 0 18px;line-height:1.7">
          <li><b>Bank lines categorised Director Loan</b>: money you pay into the business account (+) and money out to you or for you, like the Klarna payments (−). Change a line's category in Transactions.</li>
          <li><b>Costs you paid personally</b> (Expenses → Added by hand, or a recurring cost paid by you): the company owes you for them (+).</li>
          <li><b>Entries added here</b>: money you put in or got back outside the business account, for example cash, or paying a supplier straight from your own account.</li>
        </ul>
        <p class="small muted">Entries are saved in FBA Admin, so they're in its backup and in Export everything. The year-end pack and the Google Sheet's Director's Loan tab use the same figures.</p>
      </div>
    </div>`;
  wireChart(body, chartData);
  body.querySelector('#dlaP').onchange = (e) => { ui.dlaPeriod = e.target.value; rerender(); };
  body.querySelector('#dlaAdd').onclick = () => dlaForm({}, rerender);
  body.querySelectorAll('[data-dla-edit]').forEach((b) => { b.onclick = () => dlaForm(data.dlaEntries.find((x) => x.id === b.dataset.dlaEdit) || {}, rerender); });
  body.querySelector('#dlaCsv').onclick = () => downloadFile(`directors-loan_${p.from}_${p.to}.csv`, toCSV([['Date', 'What', 'From', 'Amount', 'Balance'], [p.from, 'Opening balance', '', '', st.opening], ...st.rows.map((r) => { const t = r; return [r.date, r.description, { bank: 'Bank', personal: 'Paid personally', entry: 'Added by hand' }[sourceOf(t)], r.amount, r.balance]; }), [p.to, 'Closing balance', '', '', st.closing]]));
  body.querySelector('#dlaOpen').onclick = () => modal({
    title: "Director's loan opening balance",
    body: `<p class="small muted">What the company owed you on a date, from your last accounts (0 if there wasn't a loan). Everything after that date moves it.</p>
      <div class="form-grid"><label class="field">The company owed me £<input id="oA" type="number" step="0.01" min="0" value="${esc(Math.abs(Number(s.dlaOpening) || 0))}"></label>
      <label class="field">On<input id="oD" type="date" value="${esc(s.dlaOpeningDate || fy.from)}"></label></div>`,
    actions: [{ label: 'Cancel' }, {
      label: 'Save', kind: 'primary', onClick: async (el) => {
        const a = Number(el.querySelector('#oA').value); const d = el.querySelector('#oD').value;
        if (!Number.isFinite(a) || a < 0 || !d) { toast('Enter the amount and the date', 'error'); return false; }
        await saveSettings({ dlaOpening: Math.round(a * 100) / 100, dlaOpeningDate: d, dlaDirection: 'company_owes_director' });
        toast('Saved', 'success'); autoSync(); rerender(); return true;
      },
    }],
  });
}

function dlaForm(e0, rerender) {
  const isNew = !e0.id;
  const e = { type: 'in', date: today(), ...e0 };
  modal({
    title: isNew ? "Add a director's loan entry" : "Edit director's loan entry",
    body: `<div class="form-grid">
      <label class="field">Type<select id="dT">${DLA_TYPES.map(([k, l]) => `<option value="${k}" ${k === e.type ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="field">Amount £<input id="dA" type="number" step="0.01" min="0" value="${esc(e.amount ?? '')}"></label>
      <label class="field">Date<input id="dD" type="date" value="${esc(e.date)}"></label></div>
      <label class="field">What for<input id="dW" value="${esc(e.description || '')}" placeholder="e.g. Paid Sharkninja from my own account"></label>
      <label class="field">Note<input id="dN" value="${esc(e.note || '')}"></label>
      <p class="small muted">Only for money outside the business bank account: anything that went through the bank is already counted from its Director Loan category.</p>`,
    actions: [
      ...(isNew ? [] : [{ label: 'Delete', kind: 'danger', onClick: async () => { if (!(await confirmBox('Delete this entry?', 'It comes off the director\'s loan balance.', { okLabel: 'Delete', danger: true }))) return false; await store.del('faDlaEntries', e.id); autoSync(); rerender(); return true; } }]),
      { label: 'Cancel' },
      {
        label: 'Save', kind: 'primary', onClick: async (el) => {
          const amount = Math.round(Number(el.querySelector('#dA').value) * 100) / 100; const date = el.querySelector('#dD').value;
          if (!(amount > 0) || !date) { toast('Enter the amount and the date', 'error'); return false; }
          const now = new Date().toISOString();
          await store.put('faDlaEntries', { ...e, id: e.id || crypto.randomUUID(), type: el.querySelector('#dT').value, amount, date, description: el.querySelector('#dW').value.trim(), note: el.querySelector('#dN').value.trim(), createdAt: e.createdAt || now, updatedAt: now });
          toast(isNew ? 'Added' : 'Saved', 'success'); autoSync(); rerender(); return true;
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Stock value: how much stock you hold at cost, bought vs sold, turnover, and a plan to grow it
// ---------------------------------------------------------------------------
function svChart(hist, planRows, target) {
  const pts = [...hist.map((h) => ({ m: h.month, v: h.value, a: h.atAmazon, kind: 'hist' })), ...(planRows || []).map((r) => ({ m: r.month, v: r.value, kind: 'plan' }))];
  if (pts.length < 2) return '';
  const W = 900; const H = 250; const L = 64; const R = 14; const T = 14; const B = 30;
  const vals = pts.flatMap((p) => [p.v, p.a ?? 0]).concat(target ? [target] : []);
  const hi = Math.max(...vals) * 1.1 || 100; const lo = 0;
  const x = (i) => L + (i / (pts.length - 1)) * (W - L - R); const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const step = hi / 4; const mag = 10 ** Math.floor(Math.log10(step)); const nice = Math.ceil(step / mag) * mag;
  const ticks = []; for (let v = 0; v <= hi; v += nice) ticks.push(v);
  const histN = hist.length;
  const line = (arr, key) => arr.map((p, i) => (p[key] === null || p[key] === undefined ? null : `${x(i)},${y(p[key])}`)).filter(Boolean).join(' ');
  const histPts = pts.slice(0, histN); const planPts = pts.slice(histN - 1);
  const amzStart = histPts.findIndex((p) => p.a !== null && p.a !== undefined);
  return `<div class="sv-chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Stock value at cost by month">
    ${ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" class="ax">${money(v, '£', 0)}</text>`).join('')}
    ${target ? `<line x1="${L}" x2="${W - R}" y1="${y(target)}" y2="${y(target)}" class="tgt"/><text x="${W - R}" y="${y(target) - 6}" text-anchor="end" class="ax">target ${money(target, '£', 0)}</text>` : ''}
    ${pts.map((p, i) => (i % Math.ceil(pts.length / 12) === 0 || i === pts.length - 1 ? `<text x="${x(i)}" y="${H - 9}" text-anchor="${i === pts.length - 1 ? 'end' : i === 0 ? 'start' : 'middle'}" class="ax">${new Date(`${p.m}-15T12:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' })}</text>` : '')).join('')}
    ${amzStart >= 0 ? `<polyline points="${histPts.map((p, i) => (i >= amzStart && p.a !== null ? `${x(i)},${y(p.a)}` : null)).filter(Boolean).join(' ')}" class="s2"/>` : ''}
    <polyline points="${line(histPts, 'v')}" class="s1"/>
    ${planRows?.length ? `<polyline points="${planPts.map((p, i) => `${x(histN - 1 + i)},${y(p.v)}`).join(' ')}" class="s1 dash"/>` : ''}
    ${pts.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.v)}" r="4" class="${p.kind === 'plan' ? 'pt plan' : 'pt'}"><title>${esc(new Date(`${p.m}-15T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }))}: ${p.kind === 'plan' ? 'plan ' : ''}${money(p.v)}${p.a !== null && p.a !== undefined ? ` · at Amazon ${money(p.a)}` : ''}</title></circle>`).join('')}
  </svg>
  <div class="legend small"><span><i class="sw s1"></i>Stock at cost</span>${amzStart >= 0 ? '<span><i class="sw s2"></i>Sellable at Amazon</span>' : ''}${planRows?.length ? '<span><i class="sw s1 dash"></i>Plan</span>' : ''}</div></div>`;
}

function boughtSoldChart(hist) {
  if (!hist.length) return '';
  const W = 900; const H = 220; const L = 64; const R = 14; const T = 12; const B = 30;
  const hi = Math.max(1, ...hist.flatMap((h) => [h.bought, h.sold])) * 1.12;
  const y = (v) => T + (1 - v / hi) * (H - T - B);
  const slot = (W - L - R) / hist.length; const bw = Math.min(26, slot * 0.34);
  const step = hi / 4; const mag = 10 ** Math.floor(Math.log10(step)); const nice = Math.ceil(step / mag) * mag;
  const ticks = []; for (let v = 0; v <= hi; v += nice) ticks.push(v);
  const bar = (cx, v, cls, tip) => (v > 0 ? `<path d="M${cx - bw / 2},${y(0)} V${y(v) + 4} q0,-4 4,-4 h${bw - 8} q4,0 4,4 V${y(0)} Z" class="${cls}"><title>${esc(tip)}</title></path>` : '');
  return `<div class="sv-chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Stock bought and cost of stock sold by month">
    ${ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" class="ax">${money(v, '£', 0)}</text>`).join('')}
    ${hist.map((h, i) => { const cx = L + slot * i + slot / 2; const m = h.label ? h.label : new Date(`${h.month}-15T12:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' }); return `${bar(cx - bw / 2 - 1, h.bought, 'b1', `${m}: bought ${money(h.bought)}`)}${bar(cx + bw / 2 + 1, h.sold, 'b2', `${m}: sold ${money(h.sold)} at cost`)}<text x="${cx}" y="${H - 9}" text-anchor="middle" class="ax">${m}</text>`; }).join('')}
  </svg><div class="legend small"><span><i class="sw b1"></i>Bought</span><span><i class="sw b2"></i>Sold (at cost)</span></div></div>`;
}

function renderStockValue(body, data, rerender) {
  const s = data.settings; const t0 = today();
  const hist = history(data, { today: t0, months: 12 });
  if (!hist.rows.length) {
    body.innerHTML = emptyState('store', 'No stock data yet', 'Import your SellerToolkit <b>Cost of Goods</b> export (what you bought) and <b>Orders – Detailed</b> (what sold).', '<a class="btn primary" href="#fbaadmin/import">Import files</a>');
    return;
  }
  const by = ui.svBy || 'month';
  const per = periods(data, { today: t0, by, fyStart: s.fyStart });
  const months = periods(data, { today: t0, by: 'month', count: 2 });
  const r = rates(data, { today: t0 });
  const year = periods(data, { today: t0, by: 'month', count: 12 });
  const yearChange = year.reduce((a, x) => a + x.change, 0);
  const target = Number(s.svTargetValue) || 0; const goalBy = s.svTargetBy || '';
  const pl = target && goalBy && goalBy > t0 ? plan(r, { target, by: goalBy, today: t0 }) : null;
  let cash = null;
  if (pl && !pl.alreadyThere) {
    const ps = payoutSetup(data, { today: t0, days: 100 });
    const f = forecast(data, { today: t0, days: 90, buffer: Number(s.cfBuffer) || 0, payout: ps.payout, includeStock: false, subscriptions: expenseModel(data).subs, extraEvents: [...ps.extraEvents, ...cashEvents(pl.buyPerMonth, r, { today: t0, days: 90 })] });
    if (f.ok) cash = { ok: f.low.balance >= (Number(s.cfBuffer) || 0), low: f.low };
  }
  const pctVal = target ? Math.min(100, Math.round((r.value / target) * 100)) : 0;
  body.innerHTML = `
    <div class="kpis">
      ${kpi('Stock at cost now', money(r.value), 'everything bought, less what sold')}
      ${kpi('Bought this month', money(months[0]?.bought || 0), months[0] ? esc(months[0].label) : '')}
      ${kpi('Bought last month', money(months[1]?.bought || 0), months[1] ? `sold ${money(months[1].sold, '£', 0)} at cost` : '')}
      ${kpi('Change over 12 months', money(yearChange), yearChange >= 0 ? 'stock has grown' : 'stock has shrunk', yearChange >= 0 ? 'pos' : 'neg')}
    </div>

    <div class="card card-pad section stack">
      <div class="row"><h3 class="grow">${icon('chart')} Goal</h3>
        <label class="field" style="flex-direction:row;align-items:center;gap:8px">Stock worth £<input id="svT" type="number" step="500" min="0" value="${esc(s.svTargetValue || '')}" style="width:120px"></label>
        <label class="field" style="flex-direction:row;align-items:center;gap:8px">by<input id="svB" type="date" value="${esc(goalBy)}"></label>
        <button class="btn primary small" id="svSave">${icon('check', 14)} Save</button></div>
      ${!target || !goalBy ? '<p class="small muted">Set how much stock (at cost) you want to hold and by when, to see how much to buy each month.</p>'
        : goalBy <= t0 ? '<p class="small warn-text">That date has passed: pick a new one.</p>'
          : pl.alreadyThere ? `<p class="small pos">You're there: ${money(r.value)} of stock against a goal of ${money(target)}.</p>` : `
      <div class="row"><b class="num">${money(r.value, '£', 0)}</b><div class="vat-bar grow"><span style="width:${pctVal}%"></span></div><b class="num">${money(target, '£', 0)}</b><span class="small muted">${pctVal}% · ${pl.months} month${pl.months === 1 ? '' : 's'} to go</span></div>
      <div class="kpis">
        ${kpi('Buy each month', money(pl.buyPerMonth, '£', 0), `you've averaged ${money(r.boughtPerMonth, '£', 0)} lately`)}
        ${kpi('Months to go', num(pl.months), `goal date ${dstr(goalBy)}`)}
        ${cash ? kpi('Can the bank carry it?', cash.ok ? 'Yes' : 'Not quite', cash.ok ? `lowest balance ${money(cash.low.balance, '£', 0)} in 90 days` : `drops to ${money(cash.low.balance, '£', 0)} on ${dstr(cash.low.date)}`, cash.ok ? 'pos' : 'neg', '#fbaadmin/cashflow') : ''}
      </div>
      <p class="small muted">Takes into account that stock keeps selling while you build it up, at your recent rate.</p>`}
    </div>

    <div class="card section"><div class="toolbar"><b>Stock value by month</b><span class="small muted">hover a point for the figure</span></div><div style="padding:6px 12px 10px">${svChart(hist.rows.map((h) => ({ ...h, atAmazon: null })), pl && !pl.alreadyThere ? pl.rows : null, target || null)}</div></div>

    <div class="card section"><div class="toolbar"><b>Previous periods</b><span class="grow"></span>
      <div class="seg" role="group">${[['month', 'Months'], ['quarter', 'Quarters'], ['year', 'Financial years']].map(([k, l]) => `<button class="btn small ${by === k ? 'primary' : ''}" data-svby="${k}">${l}</button>`).join('')}</div>
      <button class="btn small" id="svCsv">${icon('download', 14)} CSV</button></div>
      <div style="padding:6px 12px 4px">${boughtSoldChart(per.slice().reverse().map((x) => ({ ...x, month: x.from.slice(0, 7), label: by === 'month' ? '' : x.label })))}</div>
      <div class="table-wrap"><table class="data"><thead><tr><th>Period</th><th class="r">Bought</th><th class="r">Sold (at cost)</th><th class="r">Change</th><th class="r">Stock at the end</th></tr></thead><tbody>
      ${per.map((x) => `<tr><td class="nowrap">${esc(x.label)}${x.partial ? ' <span class="tag">so far</span>' : ''}</td><td class="r num">${money(x.bought)}</td><td class="r num">${money(x.sold)}</td><td class="r num ${x.change >= 0 ? 'pos' : 'neg'}">${money(x.change)}</td><td class="r num"><b>${money(x.value)}</b></td></tr>`).join('')}
      </tbody></table></div></div>`;
  body.querySelectorAll('[data-svby]').forEach((b) => { b.onclick = () => { ui.svBy = b.dataset.svby; rerender(); }; });
  body.querySelector('#svCsv').onclick = () => downloadFile(`stock-value-by-${by}-${t0}.csv`, toCSV([['Period', 'From', 'To', 'Bought', 'Sold (at cost)', 'Change', 'Stock at the end'], ...per.map((x) => [x.label, x.from, x.to, x.bought, x.sold, x.change, x.value])]));
  body.querySelector('#svSave').onclick = async () => {
    const v = Number(body.querySelector('#svT').value); const d = body.querySelector('#svB').value;
    if (v && !d) return toast('Pick the date to reach it by', 'error');
    await saveSettings({ svTargetValue: v ? String(v) : '', svTargetBy: v ? d : '' }); toast('Saved', 'success'); rerender();
  };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------
function renderImport(body, data, rerender) {
  body.innerHTML = `
    <div class="card card-pad stack">
      <div class="dropzone" id="dz">${icon('upload', 28)}
        <div style="margin-top:8px"><b>Drop files here</b> or click to choose (CSV, TXT or XLSX, several at once)</div>
        <div class="small">Bank statement CSV · SellerToolkit Orders – Detailed, Expenses, Cost of Goods · SellerFuse orders, expenses, cost of goods · Amazon Settlement (V2) or Date Range report, Inventory Ledger, All Listings, Sales Dashboard. Returns, removal and reimbursement reports go to the Returns tracker automatically. Re-importing overlapping dates is safe.</div>
        <input type="file" id="file" accept=".csv,.txt,.tsv,.xlsx" multiple hidden>
      </div>
      <details><summary>Where do I get each file?</summary>
        <table class="data small" style="margin-top:8px"><tbody>${FA_FORMATS.map((f) => `<tr><td><b>${esc(f.label)}</b></td><td>${esc(f.source)}</td></tr>`).join('')}</tbody></table>
        <p class="small muted" style="margin-top:6px">Revolut's PDF statement can't be read here, so download the CSV version instead: in Revolut Business choose <i>Statement</i>, then <i>CSV</i> (or Excel) as the format.</p>
      </details>
      <div id="staged"></div>
    </div>
    <div class="card section">
      <div class="toolbar"><b>Import history</b></div>
      <div class="table-wrap"><table class="data"><thead><tr><th>When</th><th>File</th><th>Type</th><th>Dates</th><th class="r">Added</th><th class="r">Updated</th><th class="r">Already had</th></tr></thead><tbody>
        ${data.imports.slice(0, 200).map((i) => `<tr><td class="small nowrap">${esc(new Date(i.at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }))}</td><td class="small"><b>${esc(i.fileName)}</b></td><td class="small">${esc(i.label)}</td>
          <td class="small nowrap">${i.from ? `${dstr(i.from)} – ${dstr(i.to)}` : ''}</td><td class="r num">${num(i.rowsAdded)}</td><td class="r num">${num(i.rowsUpdated)}</td><td class="r num">${num(i.rowsSkipped)}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">Nothing imported yet</td></tr>'}
      </tbody></table></div>
    </div>`;
  const dz = body.querySelector('#dz'); const fileIn = body.querySelector('#file');
  dz.onclick = () => fileIn.click();
  dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('over'); };
  dz.ondragleave = () => dz.classList.remove('over');
  dz.ondrop = (e) => { e.preventDefault(); dz.classList.remove('over'); stage([...e.dataTransfer.files]); };
  fileIn.onchange = () => stage([...fileIn.files]);
  const host = body.querySelector('#staged');

  async function stage(files) {
    for (const f of files) {
      if (/\.pdf$/i.test(f.name)) { ui.staged.push({ name: f.name, error: "PDF statements can't be read here. In Revolut Business, download the statement as CSV and drop that instead." }); continue; }
      try {
        const grid = await readTabularFile(f);
        let parsed = parseRows(grid, null, FA_FORMATS);
        // "SellerFuse" in the file name: pick the best-matching SellerFuse format (its columns are checked below)
        if (/seller\s*fuse/i.test(f.name) && !parsed.format.sellerfuse) parsed = parseRows(grid, parseRows(grid, null, FA_FORMATS.filter((x) => x.sellerfuse)).formatId, FA_FORMATS);
        // Amazon returns / removal / reimbursement reports belong to the Returns tracker: send them there.
        const rt = parseRows(grid, null, RT_FORMATS);
        const rtOnly = ['amazon_returns', 'amazon_removal_order', 'amazon_removal_shipment', 'amazon_reimbursements', 'ebay_sales', 'amazon_used_sales', 'prep_costs'];
        if (rtOnly.includes(rt.formatId) && rt.confidence >= 0.75 && rt.confidence > parsed.confidence) ui.staged.push({ name: f.name, parsed: rt, target: 'returns' });
        else ui.staged.push({ name: f.name, parsed, grid, account: data.settings.bankAccountName });
      } catch (e) { ui.staged.push({ name: f.name, error: e.message }); }
    }
    draw();
  }
  function draw() {
    host.innerHTML = ui.staged.map((s, i) => {
      if (s.error) return `<div class="card card-pad"><b>${esc(s.name)}</b> <span class="neg small">${esc(s.error)}</span> <button class="btn small ghost" data-drop="${i}">${icon('x', 14)}</button></div>`;
      const p = s.parsed; const low = p.confidence < 0.6;
      if (s.target === 'returns') {
        return `<div class="card card-pad stack" data-i="${i}" data-rt>
          <div class="row"><b class="grow">${esc(s.name)}</b><span class="small muted">${num(p.rows.length)} rows</span><button class="btn small ghost" data-drop="${i}">${icon('x', 14)}</button></div>
          <div class="callout small">This is an <b>${esc(p.format.label)}</b> report, so it goes to the <a href="#returns/overview">FBA Returns tracker</a>.</div>
          <div class="row"><button class="btn primary" data-go="${i}">${icon('upload')} Import into Returns tracker</button></div></div>`;
      }
      return `<div class="card card-pad stack" data-i="${i}">
        <div class="row"><b class="grow">${esc(s.name)}</b><span class="small muted">${num(p.rows.length)} rows</span><button class="btn small ghost" data-drop="${i}">${icon('x', 14)}</button></div>
        <div class="row">
          <label class="field">File type<select data-fmt>${FA_FORMATS.map((f) => `<option value="${f.id}" ${f.id === p.formatId ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}</select></label>
          ${p.format.kind === 'bank' ? `<label class="field">Account name<input data-acct value="${esc(s.account || '')}"></label>` : ''}
          <span class="badge ${low ? 'err' : 'new'}">${Math.round(p.confidence * 100)}% match</span>
        </div>
        ${low ? '<div class="callout warn small">Not sure what this file is. Check the type and columns before importing.</div>' : ''}
        ${p.missing.length ? `<div class="callout warn small">Pick a column for: <b>${p.missing.map(esc).join(', ')}</b></div>` : ''}
        <details ${low || p.missing.length ? 'open' : ''}><summary class="small">Columns</summary><div class="form-grid" style="margin-top:8px">${Object.entries(p.map).map(([field, h]) => `<label class="field">${esc(field)}${p.format.required.includes(field) ? ' *' : ''}
          <select data-col="${esc(field)}"><option value="">—</option>${p.header.filter(Boolean).map((x) => `<option ${x === h ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>`).join('')}</div></details>
        <div class="row"><button class="btn primary" data-go="${i}" ${p.missing.length ? 'disabled' : ''}>${icon('upload')} Import</button></div>
      </div>`;
    }).join('');
    host.querySelectorAll('[data-drop]').forEach((b) => { b.onclick = () => { ui.staged.splice(Number(b.dataset.drop), 1); draw(); }; });
    host.querySelectorAll('[data-i]:not([data-rt])').forEach((card) => {
      const s = ui.staged[Number(card.dataset.i)];
      card.querySelector('[data-fmt]').onchange = (e) => { s.parsed = remap(s.parsed, { formatId: e.target.value }); draw(); };
      card.querySelectorAll('[data-col]').forEach((sel) => { sel.onchange = () => { s.parsed = remap(s.parsed, { map: { ...s.parsed.map, [sel.dataset.col]: sel.value } }); draw(); }; });
      const a = card.querySelector('[data-acct]'); if (a) a.oninput = () => { s.account = a.value; };
    });
    host.querySelectorAll('[data-go]').forEach((b) => {
      b.onclick = async () => {
        const i = Number(b.dataset.go); const s = ui.staged[i];
        b.disabled = true;
        if (s.target === 'returns') {
          try {
            const res = await rtApplyImport(s.parsed, { fileName: s.name, store: rtStore, settings: await rtGetSettings() });
            toast(`Returns tracker · ${s.parsed.format.label}: ${res.created} units created, ${res.updated} updated, ${res.skipped} already had${res.unmatched ? `, ${res.unmatched} unmatched` : ''}`, 'success', 6000);
            ui.staged.splice(i, 1); autoSync(); rerender();
          } catch (e) { toast(`Nothing was imported: ${e.message}`, 'error', 7000); b.disabled = false; }
          return;
        }
        try {
          const res = await applyImport(s.parsed, { store, settings: data.settings, rules: data.rules, fileName: s.name, account: s.account });
          const sk = Object.entries(res.skipped || {}).filter(([, n]) => n).map(([k, n]) => `${n} ${{ notCompleted: 'not completed', otherCurrency: 'other currency', zero: 'zero', noDate: 'no date' }[k] || k}`).join(', ');
          toast(`${s.parsed.format.label}: ${res.added} added, ${res.updated} updated, ${res.dupes} already had${sk ? ` · skipped ${sk}` : ''}`, 'success', 6000);
          if (s.parsed.format.kind === 'bank' && s.account) await saveSettings({ bankAccountName: s.account });
          // The same SellerToolkit cost file also sets the Returns tracker's SKU costs (and fills units with no cost).
          if (s.parsed.formatId === 'stk_cogs' && s.grid) {
            try { await rtApplyImport(parseRows(s.grid, 'stk_cogs', RT_FORMATS), { fileName: s.name, store: rtStore, settings: await rtGetSettings() }); } catch { /* the FBA Admin import already succeeded */ }
          }
          // SellerFuse's cost file does the same, from its purchase lots averaged per SKU.
          if (s.parsed.formatId === 'sf_cogs' && res.records?.length && (data.settings.salesSource === 'sellerfuse')) {
            try { await rtApplyImport({ formatId: 'sku_costs', format: { label: 'SellerFuse cost of goods' }, rows: sfSkuCosts(res.records) }, { fileName: s.name, store: rtStore, settings: await rtGetSettings() }); } catch { /* the FBA Admin import already succeeded */ }
          }
          if (s.parsed.format.sellerfuse) {
            const eb = s.parsed.formatId === 'sf_orders' ? (res.records || []).filter((x) => x.channel === 'ebay').length : 0;
            if (eb) toast(`${eb} of those order lines are eBay: they count in the Amazon + eBay figures`, 'info', 6000);
            if (data.settings.salesSource !== 'sellerfuse') toast('Saved. To count SellerFuse instead of SellerToolkit, switch it on in Settings & Google Sheets → Accounting settings.', 'info', 9000);
          }
          // The date range report is also the Returns tracker's payments view (refunds and fees per returned order).
          if (s.parsed.formatId === 'amazon_date_range' && s.grid) {
            try { await rtApplyImport(parseRows(s.grid, 'amazon_transactions', RT_FORMATS), { fileName: s.name, store: rtStore, settings: await rtGetSettings() }); } catch { /* the FBA Admin import already succeeded */ }
          }
          // refunded items in these orders start their Returns tracker units now (and returns get their outbound fee)
          if (s.parsed.format.kind === 'sales') {
            try { const r = await rtSyncRefunds(); if (r?.created) toast(`Returns tracker: ${r.created} return${r.created === 1 ? '' : 's'} added from refunds in these orders`, 'info', 6000); } catch { /* the orders import already succeeded */ }
          }
          if (s.parsed.format.kind === 'settlement') {
            const rec = reconcilePayouts(await store.getAll('faSettlements'), await store.getAll('faTransactions'));
            if (rec.rows.length) toast(`Payouts: ${rec.rows.length - rec.unmatched.length} of ${rec.rows.length} found in the bank${rec.unmatched.length ? '. See Payouts & fees' : ''}`, rec.unmatched.length ? 'info' : 'success', 7000);
          }
          ui.staged.splice(i, 1);
          autoSync();
          rerender();
        } catch (e) { toast(`Nothing was imported: ${e.message}`, 'error', 7000); b.disabled = false; }
      };
    });
  }
  draw();
}

// ---------------------------------------------------------------------------
// Category rules
// ---------------------------------------------------------------------------
function renderRules(body, data, rerender) {
  let rules = data.rules.map((r) => ({ ...r }));
  body.innerHTML = `
    <div class="card card-pad stack">
      <p class="small muted">Each bank line is matched against these keywords from the top, and the first match wins, so put specific ones above general ones. Money-in categories only apply to money in, and money-out categories to money out. Rows you set by hand are never changed.</p>
      <div class="row"><input id="test" placeholder="Test a description, e.g. Klarna*lw Enterprise" style="flex:1;min-width:220px"><span id="testOut" class="small"></span></div>
    </div>
    <div class="card section">
      <div class="toolbar"><b>${rules.length} rules</b><span class="grow"></span>
        <button class="btn small" id="add">${icon('plus', 14)} Add rule</button>
        <button class="btn small" id="reapply">Re-apply to automatic categories</button>
        <button class="btn small danger" id="reset">Reset to defaults</button></div>
      <div class="table-wrap"><table class="data"><thead><tr><th></th><th>Keyword</th><th>Category</th><th class="r">Matches</th><th></th></tr></thead><tbody id="rb"></tbody></table></div>
    </div>`;
  const tb = body.querySelector('#rb');
  const matches = (r) => data.txns.filter((t) => suggestCategory(t.description + ' ' + (t.reference || ''), t.amount, [r]).source === 'rule').length;
  const draw = () => {
    tb.innerHTML = rules.map((r, i) => `<tr data-i="${i}"><td class="nowrap"><button class="icon-btn" data-up ${i ? '' : 'disabled'}>▲</button><button class="icon-btn" data-down ${i < rules.length - 1 ? '' : 'disabled'}>▼</button></td>
      <td><input data-k value="${esc(r.keyword)}"></td><td><select data-c>${ALL_CATEGORIES.map((c) => `<option ${c === r.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></td>
      <td class="r num">${matches(r)}</td><td><button class="icon-btn" data-del title="Delete">${icon('trash', 15)}</button></td></tr>`).join('');
  };
  const persist = async () => { await saveRules(rules); };
  draw();
  tb.addEventListener('click', async (e) => {
    const tr = e.target.closest('tr'); if (!tr) return; const i = Number(tr.dataset.i);
    if (e.target.closest('[data-up]')) [rules[i - 1], rules[i]] = [rules[i], rules[i - 1]];
    else if (e.target.closest('[data-down]')) [rules[i + 1], rules[i]] = [rules[i], rules[i + 1]];
    else if (e.target.closest('[data-del]')) rules.splice(i, 1);
    else return;
    await persist(); draw();
  });
  tb.addEventListener('change', async (e) => {
    const tr = e.target.closest('tr'); const i = Number(tr.dataset.i);
    if (e.target.matches('[data-k]')) rules[i].keyword = e.target.value.trim().toLowerCase();
    if (e.target.matches('[data-c]')) rules[i].category = e.target.value;
    await persist(); draw();
  });
  body.querySelector('#test').oninput = (e) => {
    const v = e.target.value; if (!v) { body.querySelector('#testOut').textContent = ''; return; }
    const outS = suggestCategory(v, -1, rules); const inS = suggestCategory(v, 1, rules);
    body.querySelector('#testOut').innerHTML = `money out → <b>${esc(outS.category)}</b>${outS.keyword ? ` (rule “${esc(outS.keyword)}”)` : ''} · money in → <b>${esc(inS.category)}</b>`;
  };
  body.querySelector('#add').onclick = async () => { rules.unshift({ keyword: '', category: 'Other Expense' }); await persist(); draw(); tb.querySelector('[data-k]').focus(); };
  body.querySelector('#reapply').onclick = async () => {
    const changed = recategorise(data.txns, rules.filter((r) => r.keyword));
    if (changed.length) await store.putMany('faTransactions', changed);
    toast(`${changed.length} transaction${changed.length === 1 ? '' : 's'} re-categorised (hand-set ones left alone)`, 'success');
    autoSync(); rerender();
  };
  body.querySelector('#reset').onclick = async () => {
    if (!(await confirmBox('Reset rules?', 'Replaces your rules with the defaults. Categories already on transactions stay until you re-apply.', { okLabel: 'Reset', danger: true }))) return;
    rules = DEFAULT_RULES.map((r) => ({ ...r })); await persist(); rerender();
  };
}

// ---------------------------------------------------------------------------
// Settings & Google Sheets
// ---------------------------------------------------------------------------
async function renderSettings(body, data, rerender) {
  const s = data.settings;
  let redirect = '';
  try { redirect = redirectUrl(); } catch { redirect = 'https://<extension-id>.chromiumapp.org/'; }
  const signedIn = await isSignedIn().catch(() => false);
  body.innerHTML = `
    <div class="grid2">
      <div class="card card-pad stack">
        <h3>${icon('globe')} Google Sheets</h3>
        <p class="small muted">Your data stays in the extension. The sheet is a mirror you can open anywhere or share with an accountant: Dashboard (profit and net profit for each period), Monthly, Transactions (every bank line and its category), Director's Loan, Expenses, Coming Up, Cash Flow, Stock Value, Targets, Sold Products, Payouts, Amazon Account Fees, Subscriptions, Invoices, Year End, Stock and Returns tabs. Tabs you add yourself are never touched.</p>
        <div class="form-grid">
          <label class="field">Google OAuth client ID<input id="cid" class="mono" value="${esc(s.googleClientId)}" placeholder="1234…apps.googleusercontent.com" autocomplete="off"></label>
          <label class="field">Client secret<input id="csec" class="mono" type="password" value="${esc(s.googleClientSecret || '')}" placeholder="GOCSPX-…" autocomplete="off"><span class="hint">${IS_EXT ? 'Optional in the extension, but with it you stay signed in.' : 'Needed in the app, so you stay signed in.'} Stays on this device.</span></label>
        </div>
        <details ${s.googleClientId ? '' : 'open'}><summary class="small"><b>One-time set-up (about 10 minutes)</b></summary>
          ${googleSetupSteps(redirect)}
          <p class="small muted" style="margin-top:6px">${IS_EXT ? 'The redirect address contains this extension\'s ID, which comes from the folder Chrome loads it from. Keep the folder where it is, or add the new address if you move it.' : 'Each copy of the toolkit (the extension, this app) has its own redirect address: add each one to the same OAuth client.'} The same Google project also syncs your devices: see <a href="#sync">Devices &amp; sync</a>.</p>
        </details>
        <div class="row">
          <button class="btn" id="saveCid">${icon('check')} Save</button>
          <button class="btn ${signedIn ? '' : 'primary'}" id="connect">${signedIn ? 'Reconnect' : 'Connect Google'}</button>
          <button class="btn primary" id="sync" ${s.googleClientId ? '' : 'disabled'}>${icon('refresh')} Sync now</button>
          ${s.spreadsheetUrl ? `<a class="btn" href="${esc(s.spreadsheetUrl)}" target="_blank" rel="noopener">${icon('external')} Open spreadsheet</a>` : ''}
        </div>
        <div class="row">
          <label class="check"><input type="checkbox" id="auto" ${s.autoSync ? 'checked' : ''}> Sync automatically after imports and edits</label>
          <span class="grow"></span>
          <button class="btn small" id="pull" ${s.spreadsheetId ? '' : 'disabled'}>Pull category changes from sheet</button>
          ${signedIn ? '<button class="btn small ghost" id="signout">Sign out</button>' : ''}
        </div>
        <p class="small muted">${s.lastSync ? `Last synced ${esc(new Date(s.lastSync).toLocaleString('en-GB'))}.` : 'Not synced yet.'} ${signedIn ? 'Signed in.' : 'Not signed in.'} In the sheet's Transactions tab you can change the Category column, then click <i>Pull category changes</i>. Any other edits in the sheet are overwritten at the next sync.</p>
      </div>

      <div class="card card-pad stack">
        <h3>${icon('gear')} Accounting settings</h3>
        <div class="form-grid">
          <label class="field">Sales, fees, COGS and expenses come from<select id="salesSrc">
            <option value="sellertoolkit" ${s.salesSource !== 'sellerfuse' ? 'selected' : ''}>SellerToolkit</option>
            <option value="sellerfuse" ${s.salesSource === 'sellerfuse' ? 'selected' : ''}>SellerFuse (SellerToolkit before the cut-over date)</option></select></label>
          <label class="field" id="sfCutF" ${s.salesSource === 'sellerfuse' ? '' : 'hidden'}>Cut-over date<input id="sfCut" type="date" value="${esc(s.sfCutover || '')}"><span class="hint">${data.sourceInfo?.cutoverAuto && data.sourceInfo?.cutover ? `Blank: using ${dstr(data.sourceInfo.cutover)}, your first SellerFuse order` : 'Blank = the day of your first SellerFuse order'}</span></label>
        </div>
        <p class="small muted" id="srcInfo">${(() => { const i = data.sourceInfo || {}; return `Imported: ${num(i.stkOrders || 0)} SellerToolkit order lines${i.stkLast ? ` (to ${dstr(i.stkLast)})` : ''} · ${num(i.sfOrders || 0)} SellerFuse Amazon${i.sfFirst ? ` (from ${dstr(i.sfFirst)})` : ''} and ${num(i.sfEbayOrders || 0)} eBay order lines · ${num(i.sfExpenses || 0)} SellerFuse expenses · ${num(i.sfStock || 0)} SellerFuse purchases. ${s.salesSource === 'sellerfuse' ? 'Each kind switches to SellerFuse from the cut-over date once you\'ve imported it from SellerFuse, so nothing is counted twice. SellerFuse eBay orders replace the eBay tracker in the Amazon + eBay figures from that date.' : 'SellerFuse files you import are kept, but not counted until you switch.'}`; })()}</p>
        <div class="form-grid">
          <label class="field">Overheads come from<select id="ohs">
            <option value="auto" ${s.overheadSource === 'auto' ? 'selected' : ''}>Bank when available, else ${esc(data.expensesLabel || 'SellerToolkit expenses')}</option>
            <option value="bank" ${s.overheadSource === 'bank' ? 'selected' : ''}>Bank transactions only</option>
            <option value="stk" ${s.overheadSource === 'stk' ? 'selected' : ''}>${esc(data.expensesLabel || 'SellerToolkit expenses')} only</option></select></label>
          <label class="field">Share overheads across products by<select id="alloc"><option value="revenue" ${s.allocate === 'revenue' ? 'selected' : ''}>Revenue</option><option value="units" ${s.allocate === 'units' ? 'selected' : ''}>Units sold</option></select></label>
          <label class="field">Financial year starts (MM-DD)<input id="fy" value="${esc(s.fyStart)}" placeholder="04-06"></label>
          <label class="field">VAT threshold £<input id="vt" type="number" step="1000" value="${esc(s.vatThreshold)}"></label>
          <label class="field">Bank account name<input id="ban" value="${esc(s.bankAccountName)}"></label>
          <label class="field">Bank currency to import<input id="bcur" value="${esc(s.bankCurrency)}" maxlength="3"></label>
        </div>
        <label class="check"><input type="checkbox" id="vatReg" ${s.vatRegistered ? 'checked' : ''}> VAT registered</label>
        <label class="check"><input type="checkbox" id="incVat" ${s.costsIncludeVat ? 'checked' : ''}> Stock costs include VAT (leave ticked if not VAT registered)</label>
        <p class="small muted">Not counted as overheads: ${[...EXCLUDED_FROM_PNL].map(esc).join(', ')}. Stock is costed through COGS, and payouts are already in your Amazon / eBay figures.</p>
        <div class="row"><button class="btn primary" id="saveAcc">${icon('check')} Save</button></div>
      </div>
    </div>
    <div class="grid2 section">
      <div class="card card-pad stack">
        <h3>${icon('pound')} Director's loan &amp; year end</h3>
        <p class="small muted">Enter the director's loan balance from your last accounts (or 0 if there wasn't one). Every bank line categorised <b>Director Loan</b> after that date moves it: Klarna payments for personal spending reduce it, money you put in increases it.</p>
        <div class="form-grid">
          <label class="field">Balance £<input id="dlaAmt" type="number" step="0.01" min="0" value="${esc(Math.abs(Number(s.dlaOpening) || 0))}"></label>
          <label class="field">Which way<select id="dlaDir"><option value="company_owes_director" ${s.dlaDirection !== 'director_owes_company' ? 'selected' : ''}>The company owes me</option><option value="director_owes_company" ${s.dlaDirection === 'director_owes_company' ? 'selected' : ''}>I owe the company</option></select></label>
          <label class="field">Balance on date<input id="dlaDate" type="date" value="${esc(s.dlaOpeningDate || presetRange('this_fy', { fyStart: s.fyStart }).from)}"></label>
          <label class="field">Associated companies<input id="assoc" type="number" min="0" step="1" value="${esc(s.associatedCompanies || 0)}" title="Other companies you control: they share the corporation tax limits"></label>
          <label class="field">Company name<input id="coName" value="${esc(s.companyName || '')}"></label>
        </div>
        <div class="row"><button class="btn primary" id="saveYe">${icon('check')} Save</button></div>
      </div>
      <div class="card card-pad stack">
        <h3>${icon('file')} Invoices &amp; receipts</h3>
        <label class="field">Keep invoice files<select id="invSt">
          <option value="both" ${(s.invoiceStorage || 'both') === 'both' ? 'selected' : ''}>In the extension and Google Drive</option>
          <option value="local" ${s.invoiceStorage === 'local' ? 'selected' : ''}>In the extension only</option>
          <option value="drive" ${s.invoiceStorage === 'drive' ? 'selected' : ''}>In Google Drive only (the extension keeps the link)</option></select></label>
        <p class="small muted">Files kept in the extension are included in FBA Admin's Export all backup, so a reinstall doesn't lose them (a big backup if you keep hundreds of PDFs). Drive copies go to <b>FBA Accounting › Invoices › year › month</b> in the Google account you connect above. The extension can only see files it put there.</p>
        <div class="row"><button class="btn primary" id="saveInv">${icon('check')} Save</button></div>
      </div>
    </div>
    <div class="grid2 section">
      <div class="card card-pad stack">
        <h3>${icon('chart')} Monthly targets</h3>
        <p class="small muted">Sales and net profit for each month, shown on the dashboard and in the Monday summary. Leave a month blank to use the default.</p>
        <div class="form-grid"><label class="field">Default sales £<input id="tgDS" type="number" step="100" min="0" value="${esc(s.targets?.default?.sales ?? '')}"></label>
          <label class="field">Default net profit £<input id="tgDP" type="number" step="50" value="${esc(s.targets?.default?.profit ?? '')}"></label></div>
        <table class="data small"><thead><tr><th>Month</th><th>Sales £</th><th>Net profit £</th></tr></thead><tbody>
          ${nextMonths(today(), 12).map((m) => `<tr><td class="nowrap">${esc(new Date(`${m}-15T12:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }))}</td>
            <td><input data-tg="${m}" data-k="sales" type="number" step="100" min="0" value="${esc(s.targets?.months?.[m]?.sales ?? '')}" placeholder="${esc(s.targets?.default?.sales ?? '')}" style="width:110px"></td>
            <td><input data-tg="${m}" data-k="profit" type="number" step="50" value="${esc(s.targets?.months?.[m]?.profit ?? '')}" placeholder="${esc(s.targets?.default?.profit ?? '')}" style="width:110px"></td></tr>`).join('')}
        </tbody></table>
        <div class="row"><button class="btn primary" id="saveTg">${icon('check')} Save targets</button></div>
      </div>
      <div class="card card-pad stack">
        <h3>${icon('bell')} Weekly summary &amp; warnings</h3>
        <p class="small muted">Last week's sales, profit and payouts, this month's target, your budget and bank forecast, bills coming up and anything that needs doing are on the <a href="#fbaadmin/dashboard">Dashboard</a>, at the top under <b>Last week</b>, on every device.</p>
        <div class="form-grid">
          <label class="field">Warn about aged stock (days before)<input id="agWarn" type="number" min="7" max="180" step="1" value="${esc(s.agedWarnDays ?? 60)}"></label>
        </div>
        <div class="row"><button class="btn primary" id="saveWk">${icon('check')} Save</button></div>
      </div>
    </div>`;
  const $ = (id) => body.querySelector(`#${id}`);
  body.querySelectorAll('[data-copy]').forEach((b) => { b.onclick = () => navigator.clipboard.writeText(b.dataset.copy).then(() => toast('Copied')); });
  $('salesSrc').onchange = () => { $('sfCutF').hidden = $('salesSrc').value !== 'sellerfuse'; };
  $('saveCid').onclick = async () => { await saveSettings({ googleClientId: $('cid').value.trim(), googleClientSecret: $('csec').value.trim() }); toast('Saved', 'success'); rerender(); };
  $('connect').onclick = async () => {
    const cid = $('cid').value.trim();
    if (!cid) return toast('Paste your OAuth client ID first', 'error');
    await saveSettings({ googleClientId: cid, googleClientSecret: $('csec').value.trim() });
    try { await signOut(); await getToken(cid, { interactive: true }); toast('Google connected', 'success'); } catch (e) { toast(e.message, 'error', 8000); }
    rerender();
  };
  $('sync').onclick = async () => {
    $('sync').disabled = true; $('sync').textContent = 'Syncing…';
    try {
      try { await getToken(s.googleClientId); } catch { await getToken(s.googleClientId, { interactive: true }); }
      const r = await syncNow({ interactive: true });
      toast(`${r.created ? 'Created your FBA Accounting spreadsheet and synced' : 'Synced'} · ${Object.values(r.written).reduce((a, n) => a + n, 0)} rows across ${Object.keys(r.written).length} tabs`, 'success', 6000);
    } catch (e) { toast(e.message, 'error', 8000); }
    rerender();
  };
  $('auto').onchange = async (e) => { await saveSettings({ autoSync: e.target.checked }); };
  $('pull').onclick = async () => {
    try {
      const r = await pullCategories();
      toast(`${r.changed} categor${r.changed === 1 ? 'y' : 'ies'} updated from the sheet${r.unknown.length ? ` · ignored unknown: ${r.unknown.join(', ')}` : ''}`, 'success', 6000);
      if (r.changed) autoSync();
    } catch (e) { toast(e.message, 'error', 7000); }
    rerender();
  };
  const so = $('signout'); if (so) so.onclick = async () => { await signOut(); toast('Signed out of Google'); rerender(); };
  $('saveYe').onclick = async () => {
    const amt = Number($('dlaAmt').value);
    if (!Number.isFinite(amt) || amt < 0) return toast("Enter the director's loan as a positive amount and pick which way it goes", 'error');
    if (!$('dlaDate').value) return toast('Pick the date that balance is at', 'error');
    await saveSettings({ dlaOpening: Math.round(amt * 100) / 100, dlaDirection: $('dlaDir').value, dlaOpeningDate: $('dlaDate').value, associatedCompanies: Math.max(0, Math.floor(Number($('assoc').value) || 0)), companyName: $('coName').value.trim() });
    toast('Saved', 'success'); autoSync(); rerender();
  };
  $('saveTg').onclick = async () => {
    const months = { ...(s.targets?.months || {}) };
    body.querySelectorAll('[data-tg]').forEach((el) => { const m = el.dataset.tg; months[m] = { ...(months[m] || {}), [el.dataset.k]: el.value }; if (!months[m].sales && !months[m].profit) delete months[m]; });
    await saveSettings({ targets: { default: { sales: $('tgDS').value, profit: $('tgDP').value }, months } });
    toast('Targets saved', 'success'); rerender();
  };
  $('saveWk').onclick = async () => {
    await saveSettings({ agedWarnDays: Math.max(7, Math.min(180, Number($('agWarn').value) || 60)) });
    toast('Saved', 'success'); rerender();
  };
  $('saveInv').onclick = async () => { await saveSettings({ invoiceStorage: $('invSt').value }); toast('Saved', 'success'); rerender(); };
  $('saveAcc').onclick = async () => {
    const fy = $('fy').value.trim();
    if (!/^\d{2}-\d{2}$/.test(fy)) return toast('Financial year start must look like 04-06', 'error');
    await saveSettings({ salesSource: $('salesSrc').value, sfCutover: $('sfCut').value, overheadSource: $('ohs').value, allocate: $('alloc').value, fyStart: fy, vatThreshold: Number($('vt').value) || 90000, bankAccountName: $('ban').value.trim() || 'Main', bankCurrency: ($('bcur').value.trim() || 'GBP').toUpperCase(), vatRegistered: $('vatReg').checked, costsIncludeVat: $('incVat').checked });
    toast('Saved', 'success'); autoSync(); rerender();
  };
}
