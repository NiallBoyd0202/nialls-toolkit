// eBay profit tracker: import eBay reports, set COGS per product, see P&L.
import * as db from '../db.js';
import { getSettings } from '../services.js';
import { icon, toast, sortable, profitClass, confirmBox, emptyState } from '../ui.js';
import { readTabularFile } from '../xlsx.js';
import { esc, money, num, pct, parseMoney, normHeader, toCSV, downloadFile, dateStr, amazonUrl } from '../util.js';

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------
const ALIASES = {
  date: ['transaction creation date', 'sale date', 'order creation date', 'paid on date', 'transaction date', 'creation date', 'date'],
  type: ['type', 'transaction type'],
  orderNumber: ['order number', 'order id', 'order no'],
  legacyOrder: ['legacy order id'],
  salesRecord: ['sales record number'],
  itemId: ['item id', 'item number'],
  transactionId: ['transaction id'],
  title: ['item title', 'title'],
  sku: ['custom label', 'custom label sku', 'sku'],
  qty: ['quantity', 'qty'],
  subtotal: ['item subtotal', 'sold for', 'sale price'],
  postage: ['postage and packaging', 'shipping and handling', 'postage'],
  net: ['net amount'],
  gross: ['gross transaction amount', 'total price'],
  feeFixed: ['final value fee fixed'],
  feeVar: ['final value fee variable'],
  feeOther: ['very high item not as described fee', 'below standard performance fee', 'international fee', 'deposit processing fee', 'regulatory operating fee'],
  description: ['description'],
  buyer: ['buyer username', 'buyer user id'],
};

function findHeader(rows) {
  let best = { idx: -1, score: 0 };
  const all = Object.values(ALIASES).flat();
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const score = rows[i].map(normHeader).filter((h) => all.includes(h)).length;
    if (score > best.score) best = { idx: i, score };
  }
  return best.score >= 3 ? best.idx : -1;
}

function colMap(header) {
  const hn = header.map(normHeader);
  const m = {};
  for (const [k, names] of Object.entries(ALIASES)) {
    if (k === 'feeOther') { m.feeOther = names.map((n) => hn.indexOf(n)).filter((i) => i >= 0); continue; }
    for (const n of names) { const i = hn.indexOf(n); if (i >= 0) { m[k] = i; break; } }
  }
  return m;
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
export function parseDateLoose(v) {
  const s = String(v || '').trim();
  if (!s || s === '--') return null;
  let m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})/); // UK dd/mm/yyyy
  if (m) { const y = Number(m[3].length === 2 ? '20' + m[3] : m[3]); return new Date(y, Number(m[2]) - 1, Number(m[1]), 12).getTime(); }
  m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3,4})[a-z]*[-\s,]+(\d{2,4})/); // 30-Sep-26 / 30 Sep 2026
  if (m && MONTHS[m[2].toLowerCase()] !== undefined) { const y = Number(m[3].length === 2 ? '20' + m[3] : m[3]); return new Date(y, MONTHS[m[2].toLowerCase()], Number(m[1]), 12).getTime(); }
  m = s.match(/^([A-Za-z]{3,4})[a-z]*[-\s](\d{1,2}),?\s+(\d{2,4})/); // Sep 30, 2026
  if (m && MONTHS[m[1].toLowerCase()] !== undefined) { const y = Number(m[3].length === 2 ? '20' + m[3] : m[3]); return new Date(y, MONTHS[m[1].toLowerCase()], Number(m[2]), 12).getTime(); }
  const t = Date.parse(s.replace(/\s+[A-Z]{2,5}$/, ''));
  return Number.isNaN(t) ? null : t;
}

function hashStr(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const productKeyOf = (sku, itemId, title) => (sku ? `sku:${sku.trim().toLowerCase()}` : itemId ? `item:${itemId}` : `title:${String(title || '').trim().toLowerCase().slice(0, 80)}`);

export function parseEbayReport(rows, settings) {
  const hIdx = findHeader(rows);
  if (hIdx < 0) throw new Error('Could not find eBay report columns. Use the Transaction report (Payments → Reports) or the Orders report (Seller Hub → Orders → Download report).');
  const header = rows[hIdx];
  const m = colMap(header);
  const kind = m.net !== undefined && m.type !== undefined ? 'transactions' : 'orders';
  const get = (r, k) => (m[k] !== undefined ? String(r[m[k]] ?? '').trim() : '');
  const money_ = (r, k) => (m[k] !== undefined ? parseMoney(r[m[k]]) : null);
  const lines = [];
  const seen = new Map();
  let skipped = 0;

  for (const r of rows.slice(hIdx + 1)) {
    if (r.filter((c) => String(c).trim() !== '').length < 3) { skipped++; continue; }
    const raw = r.join('\u0001');
    const h = hashStr(raw);
    const nth = (seen.get(h) || 0) + 1;
    seen.set(h, nth);
    const date = parseDateLoose(get(r, 'date'));
    const orderNumber = get(r, 'orderNumber') || get(r, 'legacyOrder') || get(r, 'salesRecord');
    const itemId = get(r, 'itemId').replace(/\.0+$/, '');
    const sku = get(r, 'sku') === '--' ? '' : get(r, 'sku');
    const title = get(r, 'title') === '--' ? '' : get(r, 'title');
    const qty = parseInt(get(r, 'qty'), 10) || 0;

    if (kind === 'transactions') {
      const type = get(r, 'type').toLowerCase();
      if (!type || /payout|hold|transfer|reserve/.test(type)) { skipped++; continue; }
      const net = money_(r, 'net') ?? 0;
      let lineKind = 'other';
      if (type === 'order' || type === 'sale') lineKind = 'sale';
      else if (type.includes('refund')) lineKind = 'refund';
      else if (type.includes('shipping label') || type.includes('postage label')) lineKind = 'postage';
      else if (type.includes('fee')) lineKind = 'fee';
      const gross = money_(r, 'gross') ?? ((money_(r, 'subtotal') || 0) + (money_(r, 'postage') || 0));
      let fees = null;
      if (lineKind === 'sale') {
        const parts = [money_(r, 'feeFixed'), money_(r, 'feeVar'), ...(m.feeOther || []).map((i) => parseMoney(r[i]))].filter((x) => x !== null);
        fees = parts.length ? parts.reduce((a, b) => a + Math.abs(b), 0) : (gross !== null ? Math.max(0, gross - net) : null);
      }
      lines.push({
        key: `t|${h}|${nth}`, source: 'transactions', kind: lineKind, type: get(r, 'type'), date, orderNumber, itemId,
        orderKey: lineKind === 'sale' ? `${orderNumber}|${itemId}` : null, transactionId: get(r, 'transactionId'),
        title: title || get(r, 'description'), sku, qty: lineKind === 'sale' ? (qty || 1) : (lineKind === 'refund' ? qty : 0),
        gross: lineKind === 'sale' ? gross : null, fees, net, estimatedFees: false,
        productKey: (lineKind === 'sale' || lineKind === 'refund') && (sku || itemId || title) ? productKeyOf(sku, itemId, title) : null,
      });
    } else {
      if (!itemId && !title) { skipped++; continue; }
      if (!orderNumber) { skipped++; continue; }
      const q = qty || 1;
      const unit = money_(r, 'subtotal');
      const post = money_(r, 'postage') || 0;
      const total = money_(r, 'gross');
      const gross = total ?? (unit !== null ? unit * q + post : null);
      if (gross === null) { skipped++; continue; }
      const fees = gross * Number(settings.ebayFeePct || 0) + Number(settings.ebayFeeFixed || 0);
      lines.push({
        key: `o|${h}|${nth}`, source: 'orders', kind: 'sale', type: 'Order', date, orderNumber, itemId,
        orderKey: `${orderNumber}|${itemId}`, transactionId: '', title, sku, qty: q, gross, fees, net: gross - fees, estimatedFees: true,
        productKey: productKeyOf(sku, itemId, title),
      });
    }
  }
  const dates = lines.map((l) => l.date).filter(Boolean);
  return { kind, lines, skipped, from: dates.length ? Math.min(...dates) : null, to: dates.length ? Math.max(...dates) : null };
}

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------
async function loadAll() {
  const [sales, products, imports] = await Promise.all([db.getAll('ebaySales'), db.getAll('ebayProducts'), db.getAll('ebayImports')]);
  return { sales, products: new Map(products.map((p) => [p.key, p])), imports };
}

function rangeFor(preset, from, to) {
  const now = new Date();
  const y = now.getFullYear(); const mo = now.getMonth();
  switch (preset) {
    case 'this-month': return [new Date(y, mo, 1).getTime(), Infinity];
    case 'last-month': return [new Date(y, mo - 1, 1).getTime(), new Date(y, mo, 1).getTime() - 1];
    case '3m': return [new Date(y, mo - 2, 1).getTime(), Infinity];
    case 'ytd': return [new Date(y, 0, 1).getTime(), Infinity];
    case 'custom': return [from ? new Date(from).getTime() : 0, to ? new Date(to).getTime() + 86400e3 - 1 : Infinity];
    default: return [0, Infinity];
  }
}

function lineCosts(l, products) {
  if (l.kind !== 'sale') return { cogs: 0, other: 0, missing: false };
  const p = products.get(l.productKey);
  const cogs = p && p.cogs !== null && p.cogs !== undefined && p.cogs !== '' ? Number(p.cogs) : null;
  const other = p && p.otherCost ? Number(p.otherCost) : 0;
  return { cogs: (cogs || 0) * l.qty, other: other * l.qty, missing: cogs === null };
}

function totals(lines, products) {
  const t = { units: 0, revenue: 0, fees: 0, refunds: 0, postage: 0, otherFees: 0, other: 0, net: 0, cogs: 0, otherCost: 0, missing: 0, orders: new Set() };
  for (const l of lines) {
    t.net += l.net || 0;
    if (l.kind === 'sale') {
      t.units += l.qty; t.revenue += l.gross || 0; t.fees += l.fees || 0; t.orders.add(l.orderNumber);
      const c = lineCosts(l, products);
      t.cogs += c.cogs; t.otherCost += c.other; if (c.missing) t.missing++;
    } else if (l.kind === 'refund') t.refunds += l.net || 0;
    else if (l.kind === 'postage') t.postage += l.net || 0;
    else if (l.kind === 'fee') t.otherFees += l.net || 0;
    else t.other += l.net || 0;
  }
  t.profit = t.net - t.cogs - t.otherCost;
  t.margin = t.revenue ? t.profit / t.revenue : null;
  return t;
}

let ui = { tab: 'overview', preset: 'this-month', from: '', to: '', q: '', missingSales: false, missingProducts: false, kindFilter: '' };

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
export async function render(root, ctx) {
  if (ctx?.sub) ui.tab = ctx.sub;
  const data = await loadAll();
  const [from, to] = rangeFor(ui.preset, ui.from, ui.to);
  const inRange = data.sales.filter((l) => (l.date || 0) >= from && (l.date || 0) <= to);

  root.innerHTML = `
    <div class="tabs">
      ${[['overview', 'Overview'], ['sales', 'Sales & fees'], ['products', 'Products & COGS'], ['import', 'Import reports']].map(([id, l]) => `<a class="tab ${ui.tab === id ? 'active' : ''}" href="#ebay/${id}">${l}</a>`).join('')}
    </div>
    ${ui.tab !== 'import' ? `<div class="row" style="margin-bottom:14px">
      <select id="preset">${[['this-month', 'This month'], ['last-month', 'Last month'], ['3m', 'Last 3 months'], ['ytd', 'This year'], ['all', 'All time'], ['custom', 'Custom…']].map(([v, l]) => `<option value="${v}" ${ui.preset === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <span id="customRange" ${ui.preset === 'custom' ? '' : 'hidden'}><input type="date" id="from" value="${ui.from}"> – <input type="date" id="to" value="${ui.to}"></span>
      <span class="small muted">${num(inRange.length)} lines in range · ${num(data.sales.length)} imported in total</span>
    </div>` : ''}
    <div id="ebBody"></div>`;

  const pre = root.querySelector('#preset');
  if (pre) {
    pre.onchange = () => { ui.preset = pre.value; render(root, ctx); };
    root.querySelector('#from').onchange = (e) => { ui.from = e.target.value; render(root, ctx); };
    root.querySelector('#to').onchange = (e) => { ui.to = e.target.value; render(root, ctx); };
  }
  const body = root.querySelector('#ebBody');
  if (!data.sales.length && ui.tab !== 'import') {
    body.innerHTML = emptyState('ebay', 'No eBay sales imported yet', 'Download your <b>Transaction report</b> from eBay (Seller Hub → Payments → Reports → Transaction report, CSV) and import it — it includes the real fees. The Orders report works too, with estimated fees.', '<a class="btn primary" href="#ebay/import">Import a report</a>');
    return;
  }
  if (ui.tab === 'overview') renderOverview(body, inRange, data);
  else if (ui.tab === 'sales') renderSales(body, inRange, data, root, ctx);
  else if (ui.tab === 'products') renderProducts(body, inRange, data, root, ctx);
  else renderImport(body, data, root, ctx);
}

function renderOverview(body, lines, data) {
  const t = totals(lines, data.products);
  const kpi = (label, value, sub = '', cls = '') => `<div class="kpi"><div class="label">${label}</div><div class="value ${cls}">${value}</div><div class="sub">${sub}</div></div>`;
  // by month
  const months = new Map();
  for (const l of lines) {
    const d = new Date(l.date || 0);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!months.has(k)) months.set(k, []);
    months.get(k).push(l);
  }
  const mRows = [...months.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([k, ls]) => ({ k, ...totals(ls, data.products) }));
  const maxAbs = Math.max(1, ...mRows.map((r) => Math.abs(r.profit)));
  const anyEstimated = lines.some((l) => l.estimatedFees);

  body.innerHTML = `
    ${t.missing ? `<div class="callout warn" style="margin-bottom:14px">${num(t.missing)} sale line${t.missing === 1 ? ' has' : 's have'} no COGS yet, so profit is overstated. <a href="#ebay/products">Add costs →</a></div>` : ''}
    <div class="kpis">
      ${kpi('Sales (gross)', money(t.revenue), `${num(t.units)} units · ${num(t.orders.size)} orders`)}
      ${kpi('eBay fees', money(-t.fees), anyEstimated ? 'includes estimates' : 'final value + other fees')}
      ${kpi('Refunds', money(t.refunds), '')}
      ${kpi('Postage labels & other fees', money(t.postage + t.otherFees + t.other), 'labels bought on eBay, ads, etc.')}
      ${kpi('Net from eBay', money(t.net), 'what eBay pays out')}
      ${kpi('COGS + prep', money(-(t.cogs + t.otherCost)), `COGS ${money(t.cogs)} · prep/post ${money(t.otherCost)}`)}
      ${kpi('Profit', money(t.profit), t.margin !== null ? `${pct(t.margin, 1)} margin` : '', profitClass(t.profit))}
    </div>
    <div class="card section">
      <div class="toolbar"><b>By month</b></div>
      <div class="table-wrap"><table class="data"><thead><tr>
        <th>Month</th><th class="r">Units</th><th class="r">Sales</th><th class="r">Fees</th><th class="r">Refunds & other</th><th class="r">Net</th><th class="r">COGS + prep</th><th class="r">Profit</th><th></th><th class="r">Margin</th>
      </tr></thead><tbody>
      ${mRows.map((r) => {
        const [y, m] = r.k.split('-');
        const label = new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
        const w = Math.round((Math.abs(r.profit) / maxAbs) * 100);
        return `<tr><td><b>${label}</b></td><td class="r num">${num(r.units)}</td><td class="r num">${money(r.revenue)}</td><td class="r num">${money(-r.fees)}</td>
          <td class="r num">${money(r.refunds + r.postage + r.otherFees + r.other)}</td><td class="r num">${money(r.net)}</td><td class="r num">${money(-(r.cogs + r.otherCost))}</td>
          <td class="r num ${profitClass(r.profit)}">${money(r.profit)}</td>
          <td><div class="bar-cell" title="${label}: ${money(r.profit)}"><div class="bar-track"><span class="${r.profit < 0 ? 'neg' : ''}" style="width:${w}%"></span></div></div></td>
          <td class="r num">${pct(r.margin, 1)}</td></tr>`;
      }).join('')}
      </tbody></table></div>
    </div>`;
}

function renderSales(body, lines, data, root, ctx) {
  body.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <input type="search" id="q" placeholder="Search title, SKU, order" value="${esc(ui.q)}" style="width:220px">
        <select id="kf"><option value="">All types</option>${['sale', 'refund', 'postage', 'fee', 'other'].map((k) => `<option value="${k}" ${ui.kindFilter === k ? 'selected' : ''}>${{ sale: 'Sales', refund: 'Refunds', postage: 'Postage labels', fee: 'Other fees', other: 'Other' }[k]}</option>`).join('')}</select>
        <label class="check small"><input type="checkbox" id="mo" ${ui.missingSales ? 'checked' : ''}> Missing COGS only</label>
        <span class="grow"></span>
        <button class="btn small" id="exp">${icon('download', 14)} CSV</button>
      </div>
      <div class="table-wrap"><table class="data" id="sl"><thead><tr>
        <th data-sort="date">Date</th><th>Type</th><th>Item</th><th data-sort="qty" class="r">Qty</th><th data-sort="gross" class="r">Sale</th><th data-sort="fees" class="r">Fees</th><th data-sort="net" class="r">Net</th><th class="r">COGS / unit</th><th data-sort="profit" class="r">Profit</th>
      </tr></thead><tbody></tbody></table></div>
    </div>`;
  const rowsAll = lines.map((l) => {
    const c = lineCosts(l, data.products);
    return { ...l, profit: (l.net || 0) - c.cogs - c.other, missing: c.missing, cogsUnit: data.products.get(l.productKey)?.cogs ?? null };
  });
  const filtered = () => rowsAll.filter((r) => (!ui.kindFilter || r.kind === ui.kindFilter) && (!ui.missingSales || (r.kind === 'sale' && r.missing))
    && (!ui.q || `${r.title} ${r.sku} ${r.orderNumber} ${r.itemId}`.toLowerCase().includes(ui.q.toLowerCase())));
  const label = { sale: 'Sale', refund: 'Refund', postage: 'Postage label', fee: 'Fee', other: 'Other' };
  const rowHtml = (r) => `<tr class="${r.kind === 'sale' && r.missing ? 'missing' : ''}" data-pk="${esc(r.productKey || '')}">
    <td class="small num">${dateStr(r.date)}</td>
    <td><span class="tag ${r.kind === 'sale' ? 'new' : r.kind === 'refund' ? 'gone' : ''}">${label[r.kind]}</span>${r.estimatedFees ? ' <span class="tag" title="Fees estimated from your Settings (Orders report has no fees)">est.</span>' : ''}</td>
    <td><div style="max-width:380px"><b class="small">${esc(r.title || r.type || '')}</b><div class="small muted">${r.sku ? `SKU ${esc(r.sku)} · ` : ''}${r.orderNumber ? `Order ${esc(r.orderNumber)}` : ''}</div></div></td>
    <td class="r num">${r.kind === 'sale' ? r.qty : ''}</td>
    <td class="r num">${r.gross !== null && r.gross !== undefined ? money(r.gross) : ''}</td>
    <td class="r num muted">${r.fees ? money(-r.fees) : ''}</td>
    <td class="r num">${money(r.net)}</td>
    <td class="r">${r.kind === 'sale' && r.productKey ? `<input class="cell" type="number" step="0.01" data-cogs value="${r.cogsUnit ?? ''}" placeholder="add">` : ''}</td>
    <td class="r num ${profitClass(r.profit)}">${money(r.profit)}</td></tr>`;
  const table = body.querySelector('#sl');
  let shown = [];
  const sorter = sortable(table, filtered(), rowHtml, { defaultKey: 'date', defaultDir: 'desc', onSort: (x) => { shown = x; } });
  body.querySelector('#q').oninput = (e) => { ui.q = e.target.value; sorter.redraw(filtered()); };
  body.querySelector('#kf').onchange = (e) => { ui.kindFilter = e.target.value; sorter.redraw(filtered()); };
  body.querySelector('#mo').onchange = (e) => { ui.missingSales = e.target.checked; sorter.redraw(filtered()); };
  table.addEventListener('change', async (e) => {
    if (!e.target.matches('[data-cogs]')) return;
    const pk = e.target.closest('tr').dataset.pk;
    const p = data.products.get(pk);
    if (!p) return;
    p.cogs = e.target.value === '' ? null : Number(e.target.value);
    p.updatedAt = Date.now();
    await db.put('ebayProducts', p);
    toast(`COGS saved for ${p.title || p.sku || 'item'} — applies to all its sales`);
    render(root, ctx);
  });
  body.querySelector('#exp').onclick = () => {
    const out = [['Date', 'Type', 'Order', 'Item ID', 'SKU', 'Title', 'Qty', 'Sale', 'Fees', 'Net', 'COGS/unit', 'Prep & postage/unit', 'Profit']];
    for (const r of shown) {
      const p = data.products.get(r.productKey);
      out.push([r.date ? new Date(r.date).toISOString().slice(0, 10) : '', label[r.kind], r.orderNumber, r.itemId, r.sku, r.title, r.kind === 'sale' ? r.qty : '', r.gross ?? '', r.fees ? (-r.fees).toFixed(2) : '', (r.net || 0).toFixed(2), p?.cogs ?? '', p?.otherCost ?? '', r.profit.toFixed(2)]);
    }
    downloadFile(`ebay-sales-${new Date().toISOString().slice(0, 10)}.csv`, toCSV(out));
  };
}

function renderProducts(body, lines, data, root, ctx) {
  const agg = new Map();
  for (const l of lines) {
    if (!l.productKey || (l.kind !== 'sale' && l.kind !== 'refund')) continue;
    if (!agg.has(l.productKey)) agg.set(l.productKey, { units: 0, revenue: 0, net: 0, refunds: 0 });
    const a = agg.get(l.productKey);
    if (l.kind === 'sale') { a.units += l.qty; a.revenue += l.gross || 0; a.net += l.net || 0; } else { a.refunds += l.net || 0; a.net += l.net || 0; }
  }
  const rows = [...data.products.values()].map((p) => {
    const a = agg.get(p.key) || { units: 0, revenue: 0, net: 0, refunds: 0 };
    const cost = ((p.cogs || 0) + (p.otherCost || 0)) * a.units;
    const profit = a.net - cost;
    return { ...p, ...a, profit, roi: cost > 0 ? profit / cost : null, missing: p.cogs === null || p.cogs === undefined || p.cogs === '' };
  }).filter((r) => r.units > 0 || r.refunds !== 0 || ui.preset === 'all');

  body.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <input type="search" id="q" placeholder="Search title or SKU" value="${esc(ui.q)}" style="width:220px">
        <label class="check small"><input type="checkbox" id="mo" ${ui.missingProducts ? 'checked' : ''}> Missing COGS only</label>
        <span class="grow"></span>
        <label class="btn small">${icon('upload', 14)} Import COGS CSV<input type="file" id="cogsFile" accept=".csv,.xlsx" hidden></label>
        <button class="btn small" id="exp">${icon('download', 14)} CSV</button>
      </div>
      <p class="small muted" style="margin:10px 14px 0">COGS is what you paid for the unit. <b>Prep & postage</b> is your prep-centre handling, storage and postage to the buyer per unit. Both apply to every sale of that product. Changes save automatically.</p>
      <div class="table-wrap"><table class="data" id="pt"><thead><tr>
        <th>Product</th><th data-sort="units" class="r">Units</th><th data-sort="revenue" class="r">Sales</th><th data-sort="net" class="r">Net</th>
        <th class="r">COGS / unit</th><th class="r">Prep & postage / unit</th><th>ASIN</th><th data-sort="profit" class="r">Profit</th><th data-sort="roi" class="r">ROI</th>
      </tr></thead><tbody></tbody></table></div>
    </div>`;
  const filtered = () => rows.filter((r) => (!ui.missingProducts || r.missing) && (!ui.q || `${r.title} ${r.sku} ${r.itemId}`.toLowerCase().includes(ui.q.toLowerCase())));
  const rowHtml = (r) => `<tr data-pk="${esc(r.key)}" class="${r.missing ? 'missing' : ''}">
    <td><div style="max-width:420px"><b class="small">${esc(r.title || '(no title)')}</b><div class="small muted">${r.sku ? `SKU ${esc(r.sku)}` : ''}${r.itemId ? `${r.sku ? ' · ' : ''}Item ${esc(r.itemId)}` : ''}</div></div></td>
    <td class="r num">${num(r.units)}</td><td class="r num">${money(r.revenue)}</td><td class="r num">${money(r.net)}</td>
    <td class="r"><input class="cell" type="number" step="0.01" data-f="cogs" value="${r.cogs ?? ''}" placeholder="add"></td>
    <td class="r"><input class="cell" type="number" step="0.01" data-f="otherCost" value="${r.otherCost ?? ''}" placeholder="0.00"></td>
    <td><input type="text" data-f="asin" value="${esc(r.asin || '')}" placeholder="B0…" style="width:110px;padding:5px 7px" class="mono">${r.asin ? ` <a href="${amazonUrl(2, r.asin)}" target="_blank" rel="noopener">${icon('external', 13)}</a>` : ''}</td>
    <td class="r num ${profitClass(r.profit)}">${money(r.profit)}</td><td class="r num ${profitClass(r.roi)}">${pct(r.roi)}</td></tr>`;
  const table = body.querySelector('#pt');
  const sorter = sortable(table, filtered(), rowHtml, { defaultKey: (r) => (r.missing ? 1e9 : 0) + r.units, defaultDir: 'desc' });
  body.querySelector('#q').oninput = (e) => { ui.q = e.target.value; sorter.redraw(filtered()); };
  body.querySelector('#mo').onchange = (e) => { ui.missingProducts = e.target.checked; sorter.redraw(filtered()); };
  table.addEventListener('change', async (e) => {
    const f = e.target.dataset.f;
    if (!f) return;
    const pk = e.target.closest('tr').dataset.pk;
    const p = data.products.get(pk);
    if (f === 'asin') p.asin = e.target.value.trim().toUpperCase();
    else p[f] = e.target.value === '' ? null : Number(e.target.value);
    p.updatedAt = Date.now();
    await db.put('ebayProducts', p);
    const r = rows.find((x) => x.key === pk);
    Object.assign(r, p);
    const cost = ((p.cogs || 0) + (p.otherCost || 0)) * r.units;
    r.profit = r.net - cost; r.roi = cost > 0 ? r.profit / cost : null; r.missing = p.cogs === null || p.cogs === undefined;
    const tr = e.target.closest('tr');
    tr.classList.toggle('missing', r.missing);
    tr.children[7].className = `r num ${profitClass(r.profit)}`; tr.children[7].textContent = money(r.profit);
    tr.children[8].className = `r num ${profitClass(r.roi)}`; tr.children[8].textContent = pct(r.roi);
  });
  body.querySelector('#exp').onclick = () => {
    const out = [['SKU', 'Item ID', 'Title', 'ASIN', 'Units', 'Sales', 'Net', 'COGS/unit', 'Prep & postage/unit', 'Profit', 'ROI %']];
    for (const r of filtered()) out.push([r.sku, r.itemId, r.title, r.asin, r.units, r.revenue.toFixed(2), r.net.toFixed(2), r.cogs ?? '', r.otherCost ?? '', r.profit.toFixed(2), r.roi !== null ? (r.roi * 100).toFixed(1) : '']);
    downloadFile(`ebay-products-${new Date().toISOString().slice(0, 10)}.csv`, toCSV(out));
  };
  body.querySelector('#cogsFile').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const rows2 = await readTabularFile(file);
      const hdr = rows2[0].map(normHeader);
      const iSku = hdr.findIndex((h) => ['sku', 'custom label', 'custom label sku'].includes(h));
      const iItem = hdr.findIndex((h) => ['item id', 'item number', 'itemid'].includes(h));
      const iCogs = hdr.findIndex((h) => ['cogs', 'cost', 'unit cost', 'cogs unit', 'cost price'].includes(h));
      const iOther = hdr.findIndex((h) => ['prep', 'prep cost', 'other cost', 'prep postage unit', 'prep and postage', 'postage'].includes(h));
      if ((iSku < 0 && iItem < 0) || iCogs < 0) throw new Error('Needs a "SKU" (or "Item ID") column and a "COGS" (or "Cost") column');
      let n = 0;
      for (const r of rows2.slice(1)) {
        const sku = iSku >= 0 ? String(r[iSku] || '').trim() : '';
        const item = iItem >= 0 ? String(r[iItem] || '').trim().replace(/\.0+$/, '') : '';
        const key = sku ? `sku:${sku.toLowerCase()}` : item ? `item:${item}` : null;
        const p = key && data.products.get(key);
        if (!p) continue;
        const c = parseMoney(r[iCogs]);
        if (c !== null) p.cogs = c;
        if (iOther >= 0) { const o = parseMoney(r[iOther]); if (o !== null) p.otherCost = o; }
        p.updatedAt = Date.now();
        await db.put('ebayProducts', p); n++;
      }
      toast(`Updated costs for ${n} product${n === 1 ? '' : 's'}`, 'success');
      render(root, ctx);
    } catch (err) { toast(err.message, 'error', 7000); }
  };
}

function renderImport(body, data, root, ctx) {
  const imports = [...data.imports].sort((a, b) => b.at - a.at);
  body.innerHTML = `
    <div class="card card-pad stack">
      <div class="dropzone" id="dz">${icon('upload', 28)}
        <div style="margin-top:8px"><b>Drop eBay report CSVs here</b> or click to choose (you can pick several)</div>
        <div class="small">Re-importing overlapping dates is safe — duplicates are skipped automatically.</div>
        <input type="file" id="file" accept=".csv,.xlsx" multiple hidden>
      </div>
      <details><summary>Which report should I download?</summary>
        <div class="small" style="margin-top:8px">
          <p><b>Transaction report (recommended)</b>: Seller Hub → <i>Payments</i> → <i>Reports</i> → <i>Transaction report</i> → choose dates → download the CSV. It has real final value fees, refunds, postage labels and ad fees.</p>
          <p><b>Orders report</b>: Seller Hub → <i>Orders</i> → <i>Download report</i>. It has no fee data, so fees are estimated with the % in Settings (currently shown as "est.").</p>
          <p>If you import both for the same orders, the Transaction report version is kept.</p>
        </div></details>
      <div id="preview"></div>
    </div>
    <div class="card section">
      <div class="toolbar"><b>Import history</b></div>
      <div class="table-wrap"><table class="data"><thead><tr><th>Imported</th><th>File</th><th>Type</th><th>Dates covered</th><th class="r">Lines added</th><th class="r">Duplicates</th><th></th></tr></thead>
      <tbody>${imports.map((im) => `<tr data-id="${im.id}"><td class="small">${dateStr(im.at)}</td><td><b class="small">${esc(im.file)}</b></td><td class="small">${im.kind === 'transactions' ? 'Transaction report' : 'Orders report'}</td>
        <td class="small">${dateStr(im.from)} – ${dateStr(im.to)}</td><td class="r num">${num(im.added)}</td><td class="r num">${num(im.dupes)}</td>
        <td class="r"><button class="btn small danger" data-undo>Undo</button></td></tr>`).join('') || '<tr><td colspan="7" class="empty">Nothing imported yet</td></tr>'}</tbody></table></div>
    </div>`;

  const dz = body.querySelector('#dz');
  const fileIn = body.querySelector('#file');
  dz.onclick = () => fileIn.click();
  dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('over'); };
  dz.ondragleave = () => dz.classList.remove('over');
  dz.ondrop = (e) => { e.preventDefault(); dz.classList.remove('over'); handle([...e.dataTransfer.files]); };
  fileIn.onchange = () => handle([...fileIn.files]);

  body.querySelectorAll('[data-undo]').forEach((b) => {
    b.onclick = async () => {
      const id = Number(b.closest('tr').dataset.id);
      if (!(await confirmBox('Undo this import?', 'All sales lines added by this import will be removed. Product costs you entered are kept.', { okLabel: 'Undo import', danger: true }))) return;
      const ls = await db.getAllByIndex('ebaySales', 'byImport', id);
      await db.delMany('ebaySales', ls.map((l) => l.key));
      await db.del('ebayImports', id);
      toast(`Removed ${ls.length} lines`);
      render(root, ctx);
    };
  });

  async function handle(files) {
    const s = await getSettings();
    const parsed = [];
    for (const f of files) {
      try {
        const rows = await readTabularFile(f);
        parsed.push({ file: f.name, ...parseEbayReport(rows, s) });
      } catch (e) { parsed.push({ file: f.name, error: e.message }); }
    }
    const existing = new Set(data.sales.map((l) => l.key));
    const txOrderKeys = new Set(data.sales.filter((l) => l.source === 'transactions' && l.orderKey).map((l) => l.orderKey));
    for (const p of parsed) if (!p.error && p.kind === 'transactions') for (const l of p.lines) if (l.orderKey) txOrderKeys.add(l.orderKey);
    const batchKeys = new Set();
    for (const p of parsed) {
      if (p.error) continue;
      p.fresh = p.lines.filter((l) => !existing.has(l.key) && !batchKeys.has(l.key) && !(l.source === 'orders' && txOrderKeys.has(l.orderKey)));
      for (const l of p.fresh) batchKeys.add(l.key);
      p.dupes = p.lines.length - p.fresh.length;
    }
    const pv = body.querySelector('#preview');
    pv.innerHTML = `<div class="table-wrap"><table class="data"><thead><tr><th>File</th><th>Detected</th><th>Dates</th><th class="r">Lines</th><th class="r">New</th><th class="r">Already imported</th></tr></thead><tbody>
      ${parsed.map((p) => p.error ? `<tr><td><b class="small">${esc(p.file)}</b></td><td colspan="5" class="neg small">${esc(p.error)}</td></tr>`
        : `<tr><td><b class="small">${esc(p.file)}</b></td><td class="small">${p.kind === 'transactions' ? 'Transaction report' : 'Orders report (fees estimated)'}</td><td class="small">${dateStr(p.from)} – ${dateStr(p.to)}</td>
          <td class="r num">${num(p.lines.length)}</td><td class="r num pos">${num(p.fresh.length)}</td><td class="r num">${num(p.dupes)}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="row" style="justify-content:flex-end;margin-top:10px"><button class="btn ghost" id="cx">Cancel</button><button class="btn primary" id="ok" ${parsed.some((p) => p.fresh?.length) ? '' : 'disabled'}>Import ${num(parsed.reduce((a, p) => a + (p.fresh?.length || 0), 0))} lines</button></div>`;
    pv.querySelector('#cx').onclick = () => { pv.innerHTML = ''; fileIn.value = ''; };
    pv.querySelector('#ok').onclick = async () => {
      let total = 0;
      for (const p of parsed) {
        if (p.error || !p.fresh.length) continue;
        const importId = await db.put('ebayImports', { at: Date.now(), file: p.file, kind: p.kind, from: p.from, to: p.to, added: p.fresh.length, dupes: p.dupes });
        // Transaction-report sales replace any estimated Orders-report versions of the same order line.
        if (p.kind === 'transactions') {
          const keys = new Set(p.fresh.filter((l) => l.orderKey).map((l) => l.orderKey));
          const old = data.sales.filter((l) => l.source === 'orders' && keys.has(l.orderKey)).map((l) => l.key);
          await db.delMany('ebaySales', old);
        }
        await db.putMany('ebaySales', p.fresh.map((l) => ({ ...l, importId })));
        for (const l of p.fresh) {
          if (!l.productKey || l.kind !== 'sale') continue;
          const ex = data.products.get(l.productKey) || await db.get('ebayProducts', l.productKey);
          const rec = ex ? { ...ex, title: ex.title || l.title, sku: ex.sku || l.sku, itemId: ex.itemId || l.itemId }
            : { key: l.productKey, sku: l.sku, itemId: l.itemId, title: l.title, cogs: null, otherCost: null, asin: '', createdAt: Date.now() };
          data.products.set(rec.key, rec);
          await db.put('ebayProducts', rec);
        }
        total += p.fresh.length;
      }
      toast(`Imported ${num(total)} lines`, 'success');
      ui.tab = 'products'; ui.missingProducts = true; ui.preset = 'all';
      location.hash = 'ebay/products';
      render(root, { ...ctx, sub: 'products' });
    };
  }
}
