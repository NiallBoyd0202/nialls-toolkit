// FBA Returns tracker: overview, units (with the unit drawer), import, costs, unmatched inbox, settings.
import { store, getSettings, saveSettings } from '../returns/store.js';
import {
  STATUSES, STATUS, NEXT_STATUS, COST_BUCKETS, SALE_FEES, CHANNELS, DISPOSITIONS,
  pnl, rollup, outcome, daysOpen, transition, emptyUnit, emptySale, num, r2,
} from '../returns/model.js';
import { FORMATS, FORMAT, parseRows, remap } from '../returns/parse.js';
import { applyImport } from '../returns/importer.js';
import { icon, toast, modal, confirmBox, sortable, emptyState, profitClass } from '../ui.js';
import { readTabularFile } from '../xlsx.js';
import { esc, num as fmtNum, pct, toCSV, downloadFile } from '../util.js';

const ui = { tab: 'overview', q: '', status: '', outcome: '', staged: [] };
const TABS = [['overview', 'Overview'], ['units', 'Units'], ['import', 'Import'], ['costs', 'Costs'], ['unmatched', 'Unmatched'], ['settings', 'Settings']];
const GROUP_TAG = { 'At Amazon': 'warn', 'In transit': '', 'At prep': '', 'For sale': 'new', Sold: 'new', Closed: 'gone' };
import { OUTCOMES, ledgerRows } from '../returns/ledger.js';

let sym = '£';
const money = (v) => {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const s = Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${v < 0 ? '−' : ''}${sym}${s}`;
};
const statusTag = (id) => `<span class="tag ${GROUP_TAG[STATUS[id]?.group] || ''}">${esc(STATUS[id]?.label || id)}</span>`;
const today = () => new Date().toISOString().slice(0, 10);
const dstr = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—');

async function loadAll() {
  const [units, skuCosts, imports, unmatched, settings] = await Promise.all([store.allUnits(), store.allSkuCosts(), store.allImports(), store.allUnmatched(), getSettings()]);
  sym = settings.currency || '£';
  return { units, skuCosts, imports: imports.sort((a, b) => String(b.at).localeCompare(String(a.at))), unmatched, settings };
}

export async function render(root, ctx) {
  if (ctx?.sub) {
    const [tab, ...rest] = ctx.sub.split('/');
    ui.tab = TABS.some(([id]) => id === tab) ? tab : 'overview';
    if (tab === 'units' && rest[0]) { ui.status = rest[0] === 'all' ? '' : rest[0]; }
  }
  const data = await loadAll();
  const rerender = () => render(root, { ...ctx, sub: ui.tab });
  root.innerHTML = `
    <div class="tabs">${TABS.map(([id, l]) => `<a class="tab ${ui.tab === id ? 'active' : ''}" href="#returns/${id}">${l}${id === 'unmatched' && data.unmatched.length ? `<span class="count">${data.unmatched.length}</span>` : ''}</a>`).join('')}</div>
    <div id="rtBody"></div>`;
  const body = root.querySelector('#rtBody');
  if (!data.units.length && !['import', 'settings', 'costs', 'unmatched'].includes(ui.tab)) {
    body.innerHTML = emptyState('undo', 'No returned units yet', 'Import your <b>FBA customer returns</b> report (Seller Central → Reports → Fulfilment → Customer returns). Each returned item becomes one unit you can follow to resale. Add SKU costs first if you can, for example your SellerToolkit Cost of Goods export, so units start with their cost.', '<a class="btn primary" href="#returns/import">Import reports</a>');
    return;
  }
  const views = { overview: renderOverview, units: renderUnits, import: renderImport, costs: renderCosts, unmatched: renderUnmatched, settings: renderSettings };
  await views[ui.tab](body, data, rerender, ctx);
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
function renderOverview(body, data, rerender) {
  const t = rollup(data.units);
  const open = data.units.filter((u) => !STATUS[u.status].terminal);
  const atRisk = rollup(open).costBasis;
  // Relisted units went back into Amazon stock and sell as normal inventory, so their cost isn't a returns loss.
  const settled = rollup(data.units.filter((u) => STATUS[u.status].terminal && u.status !== 'relisted_by_amazon'));
  const kpi = (label, value, sub = '', cls = '') => `<div class="kpi"><div class="label">${label}</div><div class="value ${cls}">${value}</div><div class="sub">${sub}</div></div>`;
  const stale = open.filter((u) => (Date.parse(today()) - Date.parse(u.statusDate || u.returnDate)) / 864e5 > data.settings.staleDays);
  const awaiting = data.units.filter((u) => u.status === 'sold_ebay');
  const attention = [
    t.noCogs ? `<li><a href="#returns/units/all" data-filter="nocogs"><b>${t.noCogs}</b> unit${t.noCogs === 1 ? '' : 's'} with no COGS</a>: their loss is understated. Add SKU costs on the Costs tab.</li>` : '',
    awaiting.length ? `<li><a href="#returns/units/sold_ebay"><b>${awaiting.length}</b> sold on eBay, awaiting despatch</a></li>` : '',
    stale.length ? `<li><a href="#returns/units/all" data-filter="stale"><b>${stale.length}</b> unit${stale.length === 1 ? '' : 's'} not moved in ${data.settings.staleDays}+ days</a></li>` : '',
    data.unmatched.length ? `<li><a href="#returns/unmatched"><b>${data.unmatched.length}</b> report line${data.unmatched.length === 1 ? '' : 's'} couldn't be matched to a unit</a></li>` : '',
  ].filter(Boolean);
  const groups = ['At Amazon', 'In transit', 'At prep', 'For sale', 'Sold', 'Closed'];
  const worst = [...data.units].map((u) => ({ u, p: pnl(u) })).sort((a, b) => a.p.netVsCost - b.p.netVsCost).slice(0, 10);

  body.innerHTML = `
    <div class="kpis">
      ${kpi('Units tracked', fmtNum(t.units), `${fmtNum(t.open)} open · ${fmtNum(t.settled)} settled`)}
      ${kpi('Stock at risk', money(atRisk), 'cost basis of open units')}
      ${kpi('Return costs', money(t.returnCosts), 'fees, removal, prep, postage')}
      ${kpi('Net recovery', money(t.netRecovery), 'resale + reimbursements − return costs')}
      ${kpi('Net vs cost (settled)', settled.units ? money(settled.netVsCost) : '—', settled.units ? `loss on ${fmtNum(settled.units)} finished unit${settled.units === 1 ? '' : 's'}, excl. relisted` : 'no units resold or written off yet', profitClass(settled.netVsCost))}
      ${kpi('Recovery rate (settled)', settled.recoveryRate === null ? '—' : pct(settled.recoveryRate, 0), 'of original cost won back')}
    </div>
    ${attention.length ? `<div class="callout warn section"><b>Needs attention</b><ul style="margin:6px 0 0 18px">${attention.join('')}</ul></div>` : ''}
    <div class="grid2 section">
      <div class="card">
        <div class="toolbar"><b>Where your returns are</b></div>
        <table class="data"><tbody>
          ${groups.map((g) => {
            const sts = STATUSES.filter((s) => s.group === g);
            const n = sts.reduce((a, s) => a + (t.byStatus[s.id] || 0), 0);
            return `<tr><td colspan="2" class="small muted" style="padding-top:10px"><b>${esc(g)}</b> · ${n}</td></tr>${sts.map((s) => `<tr><td><a href="#returns/units/${s.id}">${esc(s.label)}</a></td><td class="r num">${fmtNum(t.byStatus[s.id] || 0)}</td></tr>`).join('')}`;
          }).join('')}
        </tbody></table>
      </div>
      <div class="card">
        <div class="toolbar"><b>Outcomes</b></div>
        <table class="data"><tbody>
          ${Object.entries(OUTCOMES).map(([k, l]) => `<tr><td>${l}</td><td class="r num">${fmtNum(t.byOutcome[k] || 0)}</td></tr>`).join('')}
          <tr><td colspan="2" class="small muted" style="padding-top:10px"><b>By disposition</b></td></tr>
          ${Object.entries(t.byDisposition).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<tr><td class="small">${esc(k)}</td><td class="r num">${n}</td></tr>`).join('')}
          ${Object.keys(t.byChannel).length ? `<tr><td colspan="2" class="small muted" style="padding-top:10px"><b>Resold on</b></td></tr>${Object.entries(t.byChannel).map(([k, n]) => `<tr><td class="small">${esc(CHANNELS[k] || k)}</td><td class="r num">${n}</td></tr>`).join('')}` : ''}
        </tbody></table>
      </div>
    </div>
    <div class="card section">
      <div class="toolbar"><b>Worst 10 units</b><span class="small muted">by net vs cost</span></div>
      <div class="table-wrap"><table class="data"><thead><tr><th>Unit</th><th>Status</th><th class="r">Cost basis</th><th class="r">Net recovery</th><th class="r">Net vs cost</th></tr></thead><tbody>
        ${worst.map(({ u, p }) => `<tr class="click" data-id="${esc(u.id)}"><td>${unitCell(u)}</td><td>${statusTag(u.status)}</td><td class="r num">${money(p.costBasis)}</td><td class="r num">${money(p.netRecovery)}</td><td class="r num ${profitClass(p.netVsCost)}">${money(p.netVsCost)}</td></tr>`).join('')}
      </tbody></table></div>
    </div>`;
  body.querySelectorAll('[data-filter]').forEach((a) => { a.onclick = () => { ui.special = a.dataset.filter; }; });
  body.querySelectorAll('tr[data-id]').forEach((tr) => { tr.onclick = () => openUnit(data.units.find((u) => u.id === tr.dataset.id), data, rerender); });
}

function unitCell(u) {
  return `<div style="max-width:360px"><b class="small">${esc(u.title || u.sku || 'Unit')}</b><div class="small muted mono">${esc(u.sku)}${u.lpn ? ` · ${esc(u.lpn)}` : ''}</div></div>`;
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------
function renderUnits(body, data, rerender) {
  const special = ui.special; ui.special = null;
  body.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <input type="search" id="q" placeholder="Search SKU, ASIN, LPN, title, order" value="${esc(ui.q)}" style="width:240px">
        <select id="st"><option value="">All statuses</option>${STATUSES.map((s) => `<option value="${s.id}" ${ui.status === s.id ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select>
        <select id="oc"><option value="">All outcomes</option>${Object.entries(OUTCOMES).map(([k, l]) => `<option value="${k}" ${ui.outcome === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <span class="grow"></span>
        <span class="small muted" id="cnt"></span>
        <button class="btn small" id="add">${icon('plus', 14)} Add unit</button>
        <button class="btn small" id="exp">${icon('download', 14)} CSV</button>
      </div>
      <div class="table-wrap"><table class="data" id="ut"><thead><tr>
        <th data-sort="title" data-first="asc">Unit</th><th data-sort="returnDate">Returned</th><th>Disposition</th><th data-sort="statusOrder" data-first="asc">Status</th><th data-sort="days" class="r">Days</th>
        <th data-sort="costBasis" class="r">Cost basis</th><th data-sort="netRecovery" class="r">Net recovery</th><th data-sort="netVsCost" class="r" data-first="asc">Net vs cost</th>
      </tr></thead><tbody></tbody></table></div>
    </div>`;
  const order = Object.fromEntries(STATUSES.map((s, i) => [s.id, i]));
  const rows = data.units.map((u) => ({ u, ...pnl(u), title: u.title || u.sku, returnDate: u.returnDate, statusOrder: order[u.status], days: daysOpen(u), oc: outcome(u) }));
  const stale = (r) => !STATUS[r.u.status].terminal && (Date.parse(today()) - Date.parse(r.u.statusDate || r.u.returnDate)) / 864e5 > data.settings.staleDays;
  const filtered = () => rows.filter((r) => (!ui.status || r.u.status === ui.status) && (!ui.outcome || r.oc === ui.outcome)
    && (special !== 'nocogs' || !num(r.u.costs.cogs)) && (special !== 'stale' || stale(r))
    && (!ui.q || `${r.u.sku} ${r.u.asin} ${r.u.lpn} ${r.u.title} ${r.u.orderId} ${Object.values(r.u.refs || {}).join(' ')}`.toLowerCase().includes(ui.q.toLowerCase())));
  const rowHtml = (r) => `<tr class="click" data-id="${esc(r.u.id)}"><td>${unitCell(r.u)}</td><td class="small nowrap">${dstr(r.u.returnDate)}</td><td class="small">${esc(r.u.disposition)}</td>
    <td>${statusTag(r.u.status)}</td><td class="r num">${r.days ?? '—'}</td><td class="r num ${num(r.u.costs.cogs) ? '' : 'muted'}">${money(r.costBasis)}</td>
    <td class="r num">${money(r.netRecovery)}</td><td class="r num ${profitClass(r.netVsCost)}">${money(r.netVsCost)}</td></tr>`;
  const table = body.querySelector('#ut');
  const count = (list) => { const t = rollup(list.map((r) => r.u)); body.querySelector('#cnt').innerHTML = `${fmtNum(list.length)} units · net vs cost <b class="${profitClass(t.netVsCost)}">${money(t.netVsCost)}</b>`; };
  const sorter = sortable(table, filtered(), rowHtml, { defaultKey: 'returnDate', defaultDir: 'desc', onSort: count });
  body.querySelector('#q').oninput = (e) => { ui.q = e.target.value; sorter.redraw(filtered()); };
  body.querySelector('#st').onchange = (e) => { ui.status = e.target.value; sorter.redraw(filtered()); };
  body.querySelector('#oc').onchange = (e) => { ui.outcome = e.target.value; sorter.redraw(filtered()); };
  table.addEventListener('click', (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) openUnit(data.units.find((u) => u.id === tr.dataset.id), data, rerender); });
  body.querySelector('#add').onclick = () => openUnit(emptyUnit({ returnDate: today() }), data, rerender, { isNew: true });
  body.querySelector('#exp').onclick = () => downloadFile(`returns-units-${today()}.csv`, toCSV(ledgerRows(filtered().map((r) => r.u))));
}

function pnlBlock(p) {
  return `<h4>P&amp;L for this unit</h4>
    <table class="data small"><tbody>
      <tr><td>Cost basis (COGS + original inbound)</td><td class="r num">${money(p.costBasis)}</td></tr>
      <tr><td>Return costs</td><td class="r num">${money(-p.returnCosts)}</td></tr>
      <tr><td>Net sale (price + postage − sale fees)</td><td class="r num">${money(p.netSale)}</td></tr>
      <tr><td>Reimbursement</td><td class="r num">${money(p.reimbursement)}</td></tr>
      <tr><td><b>Net recovery</b></td><td class="r num"><b>${money(p.netRecovery)}</b></td></tr>
      <tr><td><b>Net vs cost</b></td><td class="r num ${profitClass(p.netVsCost)}"><b>${money(p.netVsCost)}</b>${p.recoveryRate !== null ? ` <span class="muted">(${pct(p.recoveryRate, 0)} recovered)</span>` : ''}</td></tr>
    </tbody></table>`;
}

// ---------------------------------------------------------------------------
// Unit drawer: the detail editor. Transitions are offered, not free.
// ---------------------------------------------------------------------------
function openUnit(unit, data, done, { isNew = false } = {}) {
  if (!unit) return;
  let u = structuredClone(unit);
  const inp = (attr, label, value, { type = 'text', step = '0.01', wide = false } = {}) => `<label class="field ${wide ? 'span2' : ''}">${label}<input type="${type}" ${attr} value="${esc(value ?? '')}" ${type === 'number' ? `step="${step}"` : ''}></label>`;
  const m = modal({ title: isNew ? 'Add a returned unit' : (u.title || u.sku || 'Unit'), wide: true, body: '<div id="ud"></div>', onClose: () => {} });
  const host = m.body.querySelector('#ud');

  const collect = () => {
    host.querySelectorAll('[data-field]').forEach((el) => { u[el.dataset.field] = el.value.trim(); });
    host.querySelectorAll('[data-ref]').forEach((el) => { u.refs[el.dataset.ref] = el.value.trim(); });
    host.querySelectorAll('[data-cost]').forEach((el) => { u.costs[el.dataset.cost] = r2(num(el.value)); });
    const re = host.querySelector('[data-reimb]'); if (re) u.reimbursement = r2(num(re.value));
    const ch = host.querySelector('[data-channel]');
    if (ch) {
      if (!ch.value) u.sale = null;
      else {
        u.sale = { ...(u.sale || emptySale(ch.value)), channel: ch.value };
        host.querySelectorAll('[data-sale]').forEach((el) => { u.sale[el.dataset.sale] = el.type === 'number' ? r2(num(el.value)) : el.value.trim(); });
        host.querySelectorAll('[data-fee]').forEach((el) => { u.sale.fees = { ...u.sale.fees, [el.dataset.fee]: r2(num(el.value)) }; });
      }
    }
  };
  const save = async (msg = 'Saved') => {
    collect();
    if (!u.sku) { toast('A unit needs a SKU', 'error'); return false; }
    await store.putUnit(u);
    toast(msg, 'success');
    return true;
  };

  const draw = () => {
    const p = pnl(u);
    const nexts = NEXT_STATUS[u.status] || [];
    host.innerHTML = `
      <div class="row" style="margin-bottom:10px">${statusTag(u.status)}<span class="small muted">since ${dstr(u.statusDate)} · ${daysOpen(u) ?? '—'} days open · ${esc(STATUS[u.status].location)}</span></div>
      <div class="grid2">
        <div class="stack">
          <h4>Identifiers</h4>
          <div class="form-grid">
            ${inp('data-field="sku"', 'SKU', u.sku)}${inp('data-field="asin"', 'ASIN', u.asin)}${inp('data-field="lpn"', 'LPN', u.lpn)}
            ${inp('data-field="returnDate"', 'Return date', u.returnDate, { type: 'date' })}${inp('data-field="orderId"', 'Amazon order', u.orderId)}
            <label class="field">Disposition<select data-field="disposition">${DISPOSITIONS.map((d) => `<option ${u.disposition === d ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
            ${inp('data-ref="removalOrderId"', 'Removal order', u.refs.removalOrderId)}${inp('data-ref="tracking"', 'Tracking', u.refs.tracking)}
            ${inp('data-ref="ebayItemId"', 'eBay item no.', u.refs.ebayItemId)}${inp('data-ref="ebayOrderId"', 'eBay order', u.refs.ebayOrderId)}
          </div>
          ${inp('data-field="title"', 'Title', u.title, { wide: true })}
          <label class="field">Reason / customer comment<input type="text" data-field="reason" value="${esc(u.reason)}"></label>
          <label class="field">Notes<textarea data-field="notes" rows="3">${esc(u.notes)}</textarea></label>
        </div>
        <div class="stack">
          <h4>Costs</h4>
          <div class="form-grid">${COST_BUCKETS.map((b) => inp(`data-cost="${b.id}"`, `${b.label}${b.basis ? ' (basis)' : ''}`, u.costs[b.id], { type: 'number' })).join('')}
            ${inp('data-reimb', 'Amazon reimbursement', u.reimbursement, { type: 'number' })}</div>
          <h4>Resale</h4>
          <div class="form-grid">
            <label class="field">Channel<select data-channel><option value="">Not sold</option>${Object.entries(CHANNELS).map(([k, l]) => `<option value="${k}" ${u.sale?.channel === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
            ${u.sale ? `${inp('data-sale="date"', 'Sale date', u.sale.date, { type: 'date' })}${inp('data-sale="orderRef"', 'Order ref', u.sale.orderRef)}
              ${inp('data-sale="price"', 'Price', u.sale.price, { type: 'number' })}${inp('data-sale="shippingCollected"', 'Postage charged', u.sale.shippingCollected, { type: 'number' })}
              ${SALE_FEES.map((f) => inp(`data-fee="${f.id}"`, f.label, u.sale.fees?.[f.id], { type: 'number' })).join('')}` : ''}
          </div>
        </div>
      </div>
      <div class="card card-pad section" id="uPnl">${pnlBlock(p)}</div>
      <div class="section">
        <h4>Move to</h4>
        <div class="row">${nexts.map((s) => `<button class="btn small" data-move="${s}">${esc(STATUS[s].label)}</button>`).join('') || '<span class="muted small">No moves from here</span>'}</div>
        <input type="text" id="mvNote" placeholder="Optional note for the move" style="width:100%;margin-top:8px">
      </div>
      ${(u.history || []).length ? `<details class="section"><summary class="small">History (${u.history.length})</summary><table class="data small" style="margin-top:6px"><tbody>
        ${[...u.history].reverse().map((h) => `<tr><td class="nowrap">${dstr(h.date)}</td><td>${esc(STATUS[h.from]?.label || h.from)} → <b>${esc(STATUS[h.to]?.label || h.to)}</b></td><td class="muted">${esc(h.note || '')}</td></tr>`).join('')}
      </tbody></table></details>` : ''}
      <div class="row section">
        <button class="btn primary" id="uSave">${icon('check')} Save</button>
        <span class="grow"></span>
        ${isNew ? '' : `<button class="btn danger" id="uDel">${icon('trash')} Delete unit</button>`}
      </div>`;
    host.querySelector('[data-channel]').onchange = () => { collect(); draw(); };
    // Money edits refresh only the P&L block, so focus stays in the field being typed into.
    host.querySelectorAll('[data-cost], [data-reimb], [data-sale], [data-fee]').forEach((el) => { el.oninput = () => { collect(); host.querySelector('#uPnl').innerHTML = pnlBlock(pnl(u)); }; });
    host.querySelectorAll('[data-move]').forEach((b) => {
      b.onclick = async () => {
        collect();
        u = transition(u, b.dataset.move, { date: today(), note: host.querySelector('#mvNote').value.trim() });
        if (await save(`Moved to ${STATUS[u.status].label}`)) { isNew = false; draw(); done && done(); }
      };
    });
    host.querySelector('#uSave').onclick = async () => { if (await save()) { m.close(); done && done(); } };
    const del = host.querySelector('#uDel');
    if (del) del.onclick = async () => {
      if (!(await confirmBox('Delete this unit?', 'It is removed from the tracker. Re-importing the returns report would create it again.', { okLabel: 'Delete', danger: true }))) return;
      await store.delUnit(u.id); m.close(); toast('Unit deleted'); done && done();
    };
  };
  draw();
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------
function renderImport(body, data, rerender) {
  body.innerHTML = `
    <div class="card card-pad stack">
      <div class="dropzone" id="dz">${icon('upload', 28)}
        <div style="margin-top:8px"><b>Drop report files here</b> or click to choose (CSV, TXT or XLSX, several at once)</div>
        <div class="small">Re-importing the same report is safe: every line is applied to a unit at most once.</div>
        <input type="file" id="file" accept=".csv,.txt,.tsv,.xlsx" multiple hidden>
      </div>
      <details><summary>Which reports, and in what order?</summary>
        <table class="data small" style="margin-top:8px"><thead><tr><th>Report</th><th>Where to get it</th><th>What it does</th></tr></thead><tbody>
          ${FORMATS.map((f) => `<tr><td><b>${esc(f.label)}</b></td><td>${esc(f.source)}</td><td>${f.id === 'amazon_returns' ? 'Creates one unit per returned item' : f.id === 'stk_cogs' || f.id === 'sku_costs' ? 'Sets cost basis per SKU, fills units with no cost' : 'Adds costs, credits or moves units on'}</td></tr>`).join('')}
        </tbody></table>
        <p class="small muted" style="margin-top:8px">A good order: SKU costs (SellerToolkit Cost of Goods) → customer returns → removal orders → removal shipments → reimbursements → prep invoices → eBay / Amazon Used sales.</p>
      </details>
      <div id="staged"></div>
    </div>
    <div class="card section">
      <div class="toolbar"><b>Import log</b></div>
      <div class="table-wrap"><table class="data"><thead><tr><th>When</th><th>File</th><th>Report</th><th class="r">Rows</th><th class="r">Created</th><th class="r">Updated</th><th class="r">Skipped</th><th class="r">Unmatched</th></tr></thead><tbody>
        ${data.imports.slice(0, 300).map((im) => `<tr><td class="small nowrap">${esc(new Date(im.at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }))}</td><td class="small"><b>${esc(im.fileName)}</b></td><td class="small">${esc(im.formatLabel)}</td>
          ${['rows', 'created', 'updated', 'skipped', 'unmatched'].map((k) => `<td class="r num">${fmtNum(im.stats?.[k] || 0)}</td>`).join('')}</tr>`).join('') || '<tr><td colspan="8" class="empty">Nothing imported yet</td></tr>'}
      </tbody></table></div>
    </div>`;
  const dz = body.querySelector('#dz');
  const fileIn = body.querySelector('#file');
  dz.onclick = () => fileIn.click();
  dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('over'); };
  dz.ondragleave = () => dz.classList.remove('over');
  dz.ondrop = (e) => { e.preventDefault(); dz.classList.remove('over'); stage([...e.dataTransfer.files]); };
  fileIn.onchange = () => stage([...fileIn.files]);
  const host = body.querySelector('#staged');

  async function stage(files) {
    for (const f of files) {
      try {
        const grid = await readTabularFile(f);
        ui.staged.push({ name: f.name, parsed: parseRows(grid) });
      } catch (e) { ui.staged.push({ name: f.name, error: e.message }); }
    }
    drawStaged();
  }

  function drawStaged() {
    host.innerHTML = ui.staged.map((s, i) => {
      if (s.error) return `<div class="card card-pad"><b>${esc(s.name)}</b> <span class="neg small">${esc(s.error)}</span> <button class="btn small ghost" data-drop="${i}">Remove</button></div>`;
      const p = s.parsed;
      const low = p.confidence < 0.6;
      return `<div class="card card-pad stack" data-i="${i}">
        <div class="row"><b class="grow">${esc(s.name)}</b><span class="small muted">${fmtNum(p.rows.length)} rows</span><button class="btn small ghost" data-drop="${i}">${icon('x', 14)}</button></div>
        <div class="row">
          <label class="field">Report type<select data-fmt>${FORMATS.map((f) => {
            const rk = p.ranked.find((x) => x.id === f.id);
            return `<option value="${f.id}" ${f.id === p.formatId ? 'selected' : ''}>${esc(f.label)}${rk && rk.score ? ` (${Math.round(rk.score * 100)}%)` : ''}</option>`;
          }).join('')}</select></label>
          <span class="badge ${low ? 'err' : 'new'}">${Math.round(p.confidence * 100)}% match</span>
        </div>
        ${low ? '<div class="callout warn small">Not sure what this report is. Check the type and the columns below before importing.</div>' : ''}
        ${p.missing.length ? `<div class="callout warn small">Map a column for: <b>${p.missing.map(esc).join(', ')}</b></div>` : ''}
        <details ${low || p.missing.length ? 'open' : ''}><summary class="small">Columns (${Object.values(p.map).filter(Boolean).length} of ${Object.keys(p.map).length} mapped)</summary>
          <div class="form-grid" style="margin-top:8px">${Object.entries(p.map).map(([field, h]) => `<label class="field">${esc(field)}${p.format.required.includes(field) ? ' *' : ''}
            <select data-col="${esc(field)}"><option value="">—</option>${p.header.filter(Boolean).map((x) => `<option ${x === h ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>`).join('')}</div>
        </details>
        <div class="row"><button class="btn primary" data-go="${i}" ${p.missing.length ? 'disabled' : ''}>${icon('upload')} Import ${esc(p.format.label)}</button><span class="small" data-out></span></div>
      </div>`;
    }).join('');
    host.querySelectorAll('[data-drop]').forEach((b) => { b.onclick = () => { ui.staged.splice(Number(b.dataset.drop), 1); drawStaged(); }; });
    host.querySelectorAll('[data-i]').forEach((card) => {
      const s = ui.staged[Number(card.dataset.i)];
      card.querySelector('[data-fmt]').onchange = (e) => { s.parsed = remap(s.parsed, { formatId: e.target.value }); drawStaged(); };
      card.querySelectorAll('[data-col]').forEach((sel) => {
        sel.onchange = () => { s.parsed = remap(s.parsed, { map: { ...s.parsed.map, [sel.dataset.col]: sel.value } }); drawStaged(); };
      });
    });
    host.querySelectorAll('[data-go]').forEach((b) => {
      b.onclick = async () => {
        const i = Number(b.dataset.go);
        const s = ui.staged[i];
        b.disabled = true;
        try {
          const res = await applyImport(s.parsed, { fileName: s.name, store, settings: data.settings });
          toast(`${s.parsed.format.label}: ${res.skuCosts ? `${res.skuCosts} SKU costs saved, ` : ''}${res.created} units created, ${res.updated} updated, ${res.skipped} skipped${res.unmatched ? `, ${res.unmatched} unmatched` : ''}`, res.unmatched ? 'info' : 'success', 6000);
          ui.staged.splice(i, 1);
          rerender();
        } catch (e) { toast(`Import failed, nothing was written: ${e.message}`, 'error'); b.disabled = false; }
      };
    });
  }
  drawStaged();
}

// ---------------------------------------------------------------------------
// Costs: add a cost to one unit, and the SKU cost table
// ---------------------------------------------------------------------------
function renderCosts(body, data, rerender) {
  const open = [...data.units].sort((a, b) => (b.returnDate || '').localeCompare(a.returnDate || ''));
  const label = (u) => `${u.lpn || u.id.slice(0, 8)} · ${u.sku} · ${(u.title || '').slice(0, 50)}`;
  body.innerHTML = `
    <div class="card card-pad stack">
      <h3>${icon('plus')} Add a cost to a unit</h3>
      <div class="form-grid">
        <label class="field span2">Unit<input list="unitList" id="cu" placeholder="Type an LPN, SKU or title"><datalist id="unitList">${open.map((u) => `<option value="${esc(label(u))}">`).join('')}</datalist></label>
        <label class="field">Cost type<select id="cb">${COST_BUCKETS.filter((b) => !b.basis).map((b) => `<option value="${b.id}">${b.label}</option>`).join('')}</select></label>
        <label class="field">Amount ${sym}<input type="number" step="0.01" id="ca"></label>
        <label class="field span2">Note (optional)<input type="text" id="cn"></label>
      </div>
      <div class="row"><button class="btn primary" id="cAdd">${icon('check')} Add cost</button></div>
    </div>
    <div class="card section">
      <div class="toolbar"><b>SKU costs</b><span class="small muted">cost basis applied to new units, and back-filled onto units with no cost</span><span class="grow"></span>
        <button class="btn small" id="skAdd">${icon('plus', 14)} Add SKU</button><button class="btn small" id="skExp">${icon('download', 14)} CSV</button></div>
      <div class="table-wrap"><table class="data" id="sk"><thead><tr><th data-sort="sku" data-first="asc">SKU</th><th>Title</th><th class="r">COGS / unit</th><th class="r">Inbound / unit</th><th class="r">Units</th></tr></thead><tbody></tbody></table></div>
    </div>`;
  body.querySelector('#cAdd').onclick = async () => {
    const v = body.querySelector('#cu').value;
    const u = open.find((x) => label(x) === v) || open.find((x) => x.lpn && x.lpn === v.trim());
    if (!u) return toast('Pick a unit from the list', 'error');
    const amount = r2(num(body.querySelector('#ca').value));
    if (!amount) return toast('Enter an amount', 'error');
    const b = body.querySelector('#cb').value;
    const note = body.querySelector('#cn').value.trim();
    const next = { ...u, costs: { ...u.costs, [b]: r2(num(u.costs[b]) + amount) }, notes: note ? `${u.notes ? `${u.notes}\n` : ''}${today()}: ${COST_BUCKETS.find((x) => x.id === b).label} ${money(amount)} — ${note}` : u.notes };
    await store.putUnit(next);
    toast(`Added ${money(amount)} to ${u.lpn || u.sku}`, 'success');
    rerender();
  };
  const counts = {};
  for (const u of data.units) counts[u.sku] = (counts[u.sku] || 0) + 1;
  const rows = data.skuCosts.map((c) => ({ ...c, n: counts[c.sku] || 0 }));
  const rowHtml = (c) => `<tr data-sku="${esc(c.sku)}"><td class="mono small">${esc(c.sku)}</td><td class="small">${esc((c.title || '').slice(0, 70))}</td>
    <td class="r"><input class="cell" type="number" step="0.01" data-k="cogs" value="${c.cogs ?? ''}"></td><td class="r"><input class="cell" type="number" step="0.01" data-k="inboundPerUnit" value="${c.inboundPerUnit ?? ''}"></td><td class="r num">${c.n}</td></tr>`;
  const table = body.querySelector('#sk');
  sortable(table, rows, rowHtml, { defaultKey: 'sku', defaultDir: 'asc' });
  table.addEventListener('change', async (e) => {
    const el = e.target.closest('[data-k]'); if (!el) return;
    const sku = el.closest('tr').dataset.sku;
    const c = data.skuCosts.find((x) => x.sku === sku);
    c[el.dataset.k] = r2(num(el.value)); c.updatedAt = new Date().toISOString();
    await store.putSkuCosts([c]);
    // back-fill units of this SKU that still have no cost
    const fill = data.units.filter((u) => u.sku === sku && ((el.dataset.k === 'cogs' && !num(u.costs.cogs)) || (el.dataset.k === 'inboundPerUnit' && !num(u.costs.inboundOriginal))));
    if (fill.length) await store.putUnits(fill.map((u) => ({ ...u, costs: { ...u.costs, [el.dataset.k === 'cogs' ? 'cogs' : 'inboundOriginal']: c[el.dataset.k] }, updatedAt: new Date().toISOString() })));
    toast(`Saved ${sku}${fill.length ? ` · filled ${fill.length} unit${fill.length === 1 ? '' : 's'}` : ''}`, 'success');
  });
  body.querySelector('#skAdd').onclick = () => {
    const known = [...new Set(data.units.map((u) => u.sku))].filter((s) => !data.skuCosts.some((c) => c.sku === s));
    modal({
      title: 'Add a SKU cost',
      body: `<div class="form-grid"><label class="field">SKU<input id="nSku" list="nSkuList"><datalist id="nSkuList">${known.map((s) => `<option value="${esc(s)}">`).join('')}</datalist></label>
        <label class="field">COGS / unit<input id="nCogs" type="number" step="0.01"></label><label class="field">Inbound / unit<input id="nIn" type="number" step="0.01"></label></div>`,
      actions: [{ label: 'Cancel' }, {
        label: 'Add', kind: 'primary', onClick: async (el) => {
          const sku = el.querySelector('#nSku').value.trim(); if (!sku) { toast('Enter a SKU', 'error'); return false; }
          const unit = data.units.find((u) => u.sku === sku);
          const c = { sku, asin: unit?.asin || '', title: unit?.title || '', cogs: r2(num(el.querySelector('#nCogs').value)), inboundPerUnit: r2(num(el.querySelector('#nIn').value)), updatedAt: new Date().toISOString() };
          await store.putSkuCosts([c]);
          const fill = data.units.filter((u) => u.sku === sku && !num(u.costs.cogs));
          if (fill.length) await store.putUnits(fill.map((u) => ({ ...u, costs: { ...u.costs, cogs: c.cogs, inboundOriginal: num(u.costs.inboundOriginal) || c.inboundPerUnit }, updatedAt: new Date().toISOString() })));
          rerender();
          return true;
        },
      }],
    });
  };
  body.querySelector('#skExp').onclick = () => downloadFile(`returns-sku-costs-${today()}.csv`, toCSV([['SKU', 'ASIN', 'Title', 'COGS', 'Inbound per unit'], ...data.skuCosts.map((c) => [c.sku, c.asin, c.title, c.cogs, c.inboundPerUnit])]));
}

// ---------------------------------------------------------------------------
// Unmatched inbox
// ---------------------------------------------------------------------------
function renderUnmatched(body, data, rerender) {
  const rows = [...data.unmatched].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  body.innerHTML = `
    <div class="card">
      <div class="toolbar"><b>Unmatched report lines</b><span class="small muted">lines that couldn't be placed on a unit. Fix the cause (for example import the returns report first), re-import, then clear them.</span><span class="grow"></span>
        <button class="btn small" id="clrSel">Clear selected</button><button class="btn small danger" id="clrAll">Clear all</button></div>
      <div class="table-wrap"><table class="data"><thead><tr><th><input type="checkbox" id="all"></th><th>When</th><th>Report</th><th>Reason</th><th>Line</th></tr></thead><tbody>
        ${rows.map((r) => `<tr><td><input type="checkbox" data-id="${esc(r.id)}"></td><td class="small nowrap">${dstr(r.at)}</td><td class="small">${esc(FORMAT[r.formatId]?.label || r.formatId)}</td><td>${esc(r.reason)}</td>
          <td><details><summary class="small">show</summary><pre class="small mono" style="white-space:pre-wrap;max-width:520px">${esc(JSON.stringify(r.row, null, 1))}</pre></details></td></tr>`).join('') || '<tr><td colspan="5" class="empty">Nothing unmatched</td></tr>'}
      </tbody></table></div>
    </div>`;
  const all = body.querySelector('#all');
  if (all) all.onchange = () => body.querySelectorAll('[data-id]').forEach((c) => { c.checked = all.checked; });
  body.querySelector('#clrSel').onclick = async () => {
    const ids = [...body.querySelectorAll('[data-id]:checked')].map((c) => c.dataset.id);
    if (!ids.length) return toast('Tick some lines first');
    await store.delUnmatched(ids); rerender();
  };
  body.querySelector('#clrAll').onclick = async () => {
    if (!rows.length) return;
    if (!(await confirmBox('Clear all unmatched lines?', 'They are only a to-do list; your units are not changed.', { okLabel: 'Clear all' }))) return;
    await store.delUnmatched(rows.map((r) => r.id)); rerender();
  };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function renderSettings(body, data, rerender) {
  const s = data.settings;
  body.innerHTML = `
    <div class="card card-pad stack" style="max-width:720px">
      <h3>${icon('gear')} Returns tracker settings</h3>
      <label class="check"><input type="checkbox" id="vat" ${s.costsIncludeVat ? 'checked' : ''}> Use VAT-inclusive costs from SellerToolkit (leave ticked if you're not VAT registered)</label>
      <div class="form-grid">
        <label class="field">Warn when a unit hasn't moved for (days)<input type="number" id="stale" step="1" value="${esc(s.staleDays)}"></label>
        <label class="field">Currency symbol<input type="text" id="cur" value="${esc(s.currency)}" maxlength="3"></label>
      </div>
      <div class="callout small">Google Sheets sync for returns arrives with FBA Admin's Google sign-in, writing Returns, Movements, SKU costs, Unmatched and Import log tabs to your FBA Accounting sheet. Until then, use <b>Units → CSV</b> for a spreadsheet copy, and the <b>Backup</b> button to keep your data safe.</div>
      <div class="row"><button class="btn primary" id="save">${icon('check')} Save</button>
        <span class="grow"></span><button class="btn" id="ledger">${icon('download')} Full ledger CSV</button></div>
    </div>`;
  body.querySelector('#save').onclick = async () => {
    await saveSettings({ costsIncludeVat: body.querySelector('#vat').checked, staleDays: Math.max(1, Math.round(num(body.querySelector('#stale').value) || 30)), currency: body.querySelector('#cur').value.trim() || '£' });
    toast('Saved', 'success'); rerender();
  };
  body.querySelector('#ledger').onclick = () => downloadFile(`returns-ledger-${today()}.csv`, toCSV(ledgerRows(data.units)));
}
