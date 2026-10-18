// Supplier price lists: drop a wholesaler's list, find each line on Amazon (barcode first, then by name if you
// choose), and rank them by profit, ROI, sales and price stability at that supplier's price. Links into Outreach.
import * as db from '../db.js';
import { readPriceList, FIELD_LABEL, evaluate, unitCost } from '../pricelists/model.js';
import { saveScan, allScans, scanResults, updateScan, deleteScan, barcodeBudget, matchBarcodes, searchByName, setMatch, sendToOutreach, newScanId } from '../pricelists/service.js';
import { getSettings as orSettings } from '../outreach/store.js';
import { getSettings as faSettings } from '../fbaadmin/store.js';
import { cancelKeepa, isDemo, getSettings as gsSettings } from '../services.js';
import { readTabularFile } from '../xlsx.js';
import { icon, toast, modal, confirmBox, sortable, progressUI, productCell, emptyState } from '../ui.js';
import { esc, num, pct, money, toCSV, downloadFile } from '../util.js';

const ui = { staged: null, minRoi: '', minProfit: '', hideAmazon: false, matchedOnly: true, q: '' };
const dstr = (ms) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' });
const scoreCell = (s) => (s === null || s === undefined ? '<span class="muted">—</span>' : `<span class="score s${s >= 70 ? 'hi' : s >= 50 ? 'mid' : 'lo'}">${s}</span>`);
const MATCH = { barcode: 'by barcode', name: 'by name', manual: 'by you', notfound: 'not on Amazon UK', nocode: 'no barcode', pending: 'not looked up yet' };

export async function render(root, ctx) {
  const id = ctx?.sub || '';
  if (id) return renderScan(root, id, ctx);
  return renderList(root, ctx);
}

// ---------------------------------------------------------------------------
// All lists + loading a new one
// ---------------------------------------------------------------------------
async function renderList(root, ctx) {
  const scans = (await allScans()).sort((a, b) => b.at - a.at);
  const stats = new Map();
  for (const s of scans) { const r = await scanResults(s.id); stats.set(s.id, { lines: r.length, matched: r.filter((x) => x.asin).length }); }
  root.innerHTML = `
    <div class="card card-pad stack">
      <div class="dropzone" id="pdz">${icon('upload', 28)}<div style="margin-top:8px"><b>Drop a supplier's price list here</b> or click to choose (CSV or Excel)</div>
        <div class="small">Barcodes (EAN/UPC) find products on Amazon most reliably, at about 1 Keepa token each. Lines without one can be searched by name. Nothing is looked up until you say so.</div>
        <input type="file" id="pfile" accept=".csv,.txt,.xlsx" hidden></div>
      <div id="pstaged"></div>
    </div>
    <div class="card section"><div class="toolbar"><b>Your price lists</b></div>
      ${scans.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>List</th><th>Supplier</th><th>Loaded</th><th class="r">Lines</th><th class="r">On Amazon</th></tr></thead><tbody>
        ${scans.map((s) => `<tr class="click" data-id="${esc(s.id)}"><td><b>${esc(s.name)}</b></td><td>${esc(s.supplierName || '—')}</td><td class="small nowrap">${dstr(s.at)}</td><td class="r num">${num(stats.get(s.id).lines)}</td><td class="r num">${num(stats.get(s.id).matched)}</td></tr>`).join('')}
      </tbody></table></div>` : `<div class="empty-state small">${icon('list', 28)}<p>No price lists yet.</p></div>`}</div>`;
  const dz = root.querySelector('#pdz'); const fin = root.querySelector('#pfile');
  dz.onclick = () => fin.click();
  dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('over'); };
  dz.ondragleave = () => dz.classList.remove('over');
  dz.ondrop = (e) => { e.preventDefault(); dz.classList.remove('over'); stage(e.dataTransfer.files[0]); };
  fin.onchange = () => stage(fin.files[0]);
  root.querySelectorAll('tr[data-id]').forEach((tr) => { tr.onclick = () => ctx.navigate(`pricelists/${tr.dataset.id}`); });
  const host = root.querySelector('#pstaged');

  async function stage(file) {
    if (!file) return;
    try {
      const grid = await readTabularFile(file);
      const o = await orSettings();
      ui.staged = { file: file.name, grid, parsed: readPriceList(grid), pricePer: 'unit', pricesIncVat: !!o.supplierPricesIncVat, supplierName: file.name.replace(/\.(csv|xlsx|txt)$/i, '').replace(/[_-]+/g, ' ').replace(/price ?list/i, '').trim() };
      draw();
    } catch (e) { toast(e.message, 'error'); }
  }
  async function draw() {
    const st = ui.staged; if (!st) { host.innerHTML = ''; return; }
    const p = st.parsed; const L = p.lines;
    const suppliers = await db.getAll('orSuppliers');
    host.innerHTML = `<div class="card card-pad stack">
      <div class="row"><b class="grow">${icon('file', 14)} ${esc(st.file)}</b><span class="small muted">${num(L.length)} lines</span><button class="btn small ghost" id="pDrop">${icon('x', 14)}</button></div>
      <div class="small">${num(L.filter((l) => l.code).length)} with a barcode · ${num(L.filter((l) => !l.code).length)} without${L.filter((l) => l.badCode).length ? ` (<span class="warn-text">${num(L.filter((l) => l.badCode).length)} barcodes Excel has turned into numbers like 5.01E+12: re-save the list with that column as Text</span>)` : ''} · ${num(L.filter((l) => l.cost === null).length)} with no price</div>
      <div class="form-grid">
        <label class="field">Supplier<input id="pSup" list="pSupList" value="${esc(st.supplierName)}"><datalist id="pSupList">${suppliers.map((s) => `<option value="${esc(s.company)}">`).join('')}</datalist></label>
        <label class="field">Prices are<select id="pPer"><option value="unit" ${st.pricePer === 'unit' ? 'selected' : ''}>per unit</option><option value="case" ${st.pricePer === 'case' ? 'selected' : ''}>per case (divide by pack size)</option></select></label>
        <label class="field">VAT<select id="pVat"><option value="0" ${st.pricesIncVat ? '' : 'selected'}>prices are ex VAT</option><option value="1" ${st.pricesIncVat ? 'selected' : ''}>prices include VAT</option></select></label>
      </div>
      <details ${p.map.cost < 0 || (p.map.code < 0 && p.map.title < 0) ? 'open' : ''}><summary class="small">Columns</summary><div class="form-grid" style="margin-top:8px">
        ${Object.entries(FIELD_LABEL).map(([f, l]) => `<label class="field">${esc(l)}<select data-col="${f}"><option value="-1">—</option>${p.header.map((h, i) => (h ? `<option value="${i}" ${p.map[f] === i ? 'selected' : ''}>${esc(h)}</option>` : '')).join('')}</select></label>`).join('')}
      </div></details>
      ${p.map.cost < 0 ? '<div class="callout warn small">Pick the price column.</div>' : ''}
      <div class="row"><button class="btn primary" id="pSave" ${p.map.cost < 0 ? 'disabled' : ''}>${icon('check')} Save list</button><span class="small muted">Then find the products on Amazon, and see what they'd make.</span></div></div>`;
    host.querySelector('#pDrop').onclick = () => { ui.staged = null; draw(); };
    host.querySelector('#pSup').oninput = (e) => { st.supplierName = e.target.value; };
    host.querySelector('#pPer').onchange = (e) => { st.pricePer = e.target.value; };
    host.querySelector('#pVat').onchange = (e) => { st.pricesIncVat = e.target.value === '1'; };
    host.querySelectorAll('[data-col]').forEach((sel) => { sel.onchange = () => { st.parsed = readPriceList(st.grid, { ...st.parsed.map, [sel.dataset.col]: Number(sel.value) }); draw(); }; });
    host.querySelector('#pSave').onclick = async () => {
      const sup = suppliers.find((x) => x.company.trim().toLowerCase() === st.supplierName.trim().toLowerCase());
      const scan = { id: newScanId(), name: st.file, supplierName: st.supplierName.trim(), supplierId: sup?.id || '', at: Date.now(), pricePer: st.pricePer, pricesIncVat: st.pricesIncVat, columns: st.parsed.map };
      await saveScan(scan, st.parsed.lines);
      ui.staged = null;
      ctx.navigate(`pricelists/${scan.id}`);
    };
  }
  draw();
}

// ---------------------------------------------------------------------------
// One list: find on Amazon, ranked results
// ---------------------------------------------------------------------------
async function renderScan(root, id, ctx) {
  const scan = (await allScans()).find((s) => s.id === id);
  if (!scan) { root.innerHTML = emptyState('list', 'Price list not found', 'It may have been deleted on another device.', '<a class="btn" href="#pricelists">All price lists</a>'); return; }
  const [results, os, fa, gs, items] = await Promise.all([scanResults(id), orSettings(), faSettings(), gsSettings(), db.getAll('items')]);
  const budget = await barcodeBudget(id);
  const listedBy = new Map(); for (const it of items) if (!it.removedAt) { if (!listedBy.has(it.asin)) listedBy.set(it.asin, new Set()); listedBy.get(it.asin).add(it.sellerKey); }
  const prods = new Map();
  for (const r of results) if (r.asin && !prods.has(r.asin)) prods.set(r.asin, await db.get('products', `2:${r.asin}`));
  const rows = results.map((r) => {
    const p = r.asin ? prods.get(r.asin) : null;
    const ev = evaluate(r, scan, p, os, { vatRegistered: !!fa.vatRegistered, storefronts: listedBy.get(r.asin)?.size || 0 });
    return { ...r, p, ...ev, unitCost: unitCost(r, scan), profit: ev.econ?.profit ?? null, roi: ev.econ?.roi ?? null, price: p?.price ?? null, bsr: p?.bsr ?? null, offers: p?.offerCount ?? null, amazon: !!p?.amazonOnListing, storefronts: listedBy.get(r.asin)?.size || 0 };
  });
  const matched = rows.filter((r) => r.asin);
  const target = Number(os.targetRoi) || 0.3;
  const good = matched.filter((r) => (r.roi ?? -1) >= target && (r.profit ?? 0) > 0);
  const kpi = (label, value, sub = '', cls = '') => `<div class="kpi"><div class="label">${label}</div><div class="value ${cls}">${value}</div><div class="sub">${sub}</div></div>`;
  const filtered = () => rows.filter((r) => (!ui.matchedOnly || r.asin) && (!ui.hideAmazon || !r.amazon)
    && (ui.minRoi === '' || (r.roi ?? -9) * 100 >= Number(ui.minRoi)) && (ui.minProfit === '' || (r.profit ?? -9e9) >= Number(ui.minProfit))
    && (!ui.q || `${r.title} ${r.code} ${r.sku} ${r.p?.title || ''} ${r.asin}`.toLowerCase().includes(ui.q.toLowerCase())));
  const noName = rows.filter((r) => !r.asin && (r.matchType === 'nocode' || r.matchType === 'notfound') && r.title).length;

  root.innerHTML = `
    <div class="row" style="margin-bottom:12px"><a class="btn small ghost" href="#pricelists">← All price lists</a><b class="grow">${esc(scan.name)}</b>
      <span class="small muted">${esc(scan.supplierName || 'no supplier')} · prices ${scan.pricePer === 'case' ? 'per case' : 'per unit'}, ${scan.pricesIncVat ? 'inc' : 'ex'} VAT · ${fa.vatRegistered ? 'VAT registered' : 'not VAT registered'}</span>
      <button class="btn small danger" id="plDel">${icon('trash', 14)} Delete</button></div>
    ${budget.codes ? `<div class="callout section-first"><div class="row"><span class="grow">${num(budget.codes)} barcode${budget.codes === 1 ? '' : 's'} to look up: ${budget.toLookUp ? `<b>about ${num(budget.toLookUp)} Keepa token${budget.toLookUp === 1 ? '' : 's'}</b>${budget.codes > budget.toLookUp ? ` (${num(budget.codes - budget.toLookUp)} already known, free)` : ''}` : 'all already known, free'}${isDemo(gs) ? ' · demo mode: made-up results' : ''}.</span>
      <button class="btn primary" id="plFind">${icon('search', 14)} Find on Amazon</button></div></div>` : ''}
    <div id="plProg"></div>
    <div class="kpis">
      ${kpi('Lines', num(rows.length), `${num(rows.filter((r) => r.code).length)} with a barcode`)}
      ${kpi('Found on Amazon', num(matched.length), `${num(rows.filter((r) => r.matchType === 'notfound').length)} not found · ${num(rows.filter((r) => r.matchType === 'nocode').length)} no barcode`)}
      ${kpi('Worth buying', num(good.length), `${pct(target, 0)}+ ROI after fees (<a href="#outreach/settings">change</a>)`, good.length ? 'pos' : '')}
      ${kpi('Best ROI', matched.length ? pct(Math.max(...matched.map((r) => r.roi ?? -1)), 0) : '—', matched.length ? `best profit ${money(Math.max(...matched.map((r) => r.profit ?? -1e9)))}` : '')}
    </div>
    <div class="card section"><div class="toolbar">
      <input type="search" id="plQ" placeholder="Search" value="${esc(ui.q)}" style="width:160px">
      <label class="small">Min ROI % <input id="plRoi" type="number" step="5" value="${esc(ui.minRoi)}" style="width:66px"></label>
      <label class="small">Min profit £ <input id="plProf" type="number" step="0.5" value="${esc(ui.minProfit)}" style="width:66px"></label>
      <label class="check small"><input type="checkbox" id="plAmz" ${ui.hideAmazon ? 'checked' : ''}> Hide Amazon-sold</label>
      <label class="check small"><input type="checkbox" id="plMatched" ${ui.matchedOnly ? 'checked' : ''}> Found on Amazon only</label>
      <span class="grow"></span>
      ${noName ? `<button class="btn small" id="plNames" title="About 10 Keepa tokens each">${icon('search', 14)} Search ${num(Math.min(noName, 20))} by name</button>` : ''}
      <button class="btn small primary" id="plOut">${icon('users', 14)} Ticked to Outreach</button><button class="btn small" id="plCsv">${icon('download', 14)} CSV</button></div>
      <div class="table-wrap"><table class="data" id="plT"><thead><tr><th class="check-col"><input type="checkbox" id="plAll" title="Tick all shown"></th><th>Product</th><th data-sort="unitCost" class="r">Their price</th><th data-sort="price" class="r">Sells for</th><th data-sort="profit" class="r">Profit</th><th data-sort="roi" class="r">ROI</th><th data-sort="bsr" data-first="asc" class="r">Sales</th><th data-sort="stability" class="r">Steady</th><th data-sort="offers" data-first="asc" class="r">Offers</th><th data-sort="score" class="r">Score</th><th></th></tr></thead><tbody></tbody></table></div></div>
    <p class="small muted section">Profit is after Amazon's referral and FBA fees${fa.vatRegistered ? ', ex VAT' : ', VAT on fees and stock included (not VAT registered)'}, plus ${money(Number(os.prepPerUnit) + Number(os.inboundPerUnit))} prep and shipping a unit (<a href="#outreach/settings">change</a>). Score: 45% ROI, 25% sales, 15% price stability, 15% competition, minus 20 when Amazon sells it, plus 5 when 2+ of your tracked storefronts list it.</p>`;

  const ticked = new Set();
  const rowHtml = (r) => `<tr data-k="${esc(r.key)}"><td class="check-col">${r.asin ? `<input type="checkbox" data-tick ${ticked.has(r.key) ? 'checked' : ''}>` : ''}</td>
    <td>${r.asin ? productCell(r.p, { asin: r.asin, domain: 2, extra: ` · <span class="tag" title="${esc(r.title)}">${esc(MATCH[r.matchType] || '')}</span>${r.alternatives?.length ? ` <span class="tag warn" title="This barcode is on ${r.alternatives.length + 1} listings: the best seller is shown">${r.alternatives.length + 1} listings</span>` : ''}` }) : `<div style="max-width:420px"><b class="small">${esc(r.title || r.code)}</b><div class="small muted mono">${esc(r.code || r.badCode || '')}${r.sku ? ` · ${esc(r.sku)}` : ''} · ${esc(MATCH[r.matchType] || '')}</div></div>`}
      ${r.asin ? `<div class="small muted" style="margin-top:2px">Their line: ${esc(r.title.slice(0, 70))}${r.pack > 1 ? ` · pack of ${r.pack}` : ''}</div>` : ''}</td>
    <td class="r num">${money(r.unitCost)}${scan.pricePer === 'case' && r.pack > 1 ? `<div class="small muted">${money(r.cost)}/case</div>` : ''}</td>
    <td class="r num">${r.price ? money(r.price) : '—'}</td>
    <td class="r num ${r.profit === null ? '' : r.profit >= 0 ? 'pos' : 'neg'}">${r.profit === null ? '—' : money(r.profit)}${r.econ?.maxBuy ? `<div class="small muted">max ${money(r.econ.maxBuy)}</div>` : ''}</td>
    <td class="r num">${r.roi === null ? '—' : `<span class="${r.roi >= target ? 'pos' : r.roi < 0 ? 'neg' : ''}">${pct(r.roi, 0)}</span>`}</td>
    <td class="r num">${r.p?.monthlySold ? `${num(r.p.monthlySold)}+/mo` : r.bsr ? `#${num(r.bsr)}` : '—'}</td>
    <td class="r num">${r.stability ?? '—'}</td>
    <td class="r num">${r.offers ?? '—'}${r.amazon ? ' <span class="tag warn">AMZ</span>' : ''}</td>
    <td class="r">${scoreCell(r.score)}</td>
    <td class="r nowrap">${r.asin ? `<button class="icon-btn" data-unmatch title="Wrong product">${icon('x', 14)}</button>` : (r.title ? `<button class="btn small" data-name title="About 10 Keepa tokens">${icon('search', 14)}</button>` : '')}</td></tr>`;
  const table = root.querySelector('#plT');
  const sorter = sortable(table, filtered(), rowHtml, { defaultKey: 'score' });
  const redraw = () => sorter.redraw(filtered());
  const $ = (s) => root.querySelector(s);
  $('#plQ').oninput = (e) => { ui.q = e.target.value; redraw(); };
  $('#plRoi').oninput = (e) => { ui.minRoi = e.target.value; redraw(); };
  $('#plProf').oninput = (e) => { ui.minProfit = e.target.value; redraw(); };
  $('#plAmz').onchange = (e) => { ui.hideAmazon = e.target.checked; redraw(); };
  $('#plMatched').onchange = (e) => { ui.matchedOnly = e.target.checked; redraw(); };
  $('#plAll').onchange = (e) => { for (const r of filtered()) if (r.asin) { if (e.target.checked) ticked.add(r.key); else ticked.delete(r.key); } redraw(); };
  const rerender = () => renderScan(root, id, ctx);

  table.addEventListener('change', (e) => { const cb = e.target.closest('[data-tick]'); if (!cb) return; const k = cb.closest('tr').dataset.k; if (cb.checked) ticked.add(k); else ticked.delete(k); });
  table.addEventListener('click', async (e) => {
    const tr = e.target.closest('tr[data-k]'); if (!tr) return;
    const r = rows.find((x) => x.key === tr.dataset.k);
    if (e.target.closest('[data-unmatch]')) {
      const alts = r.alternatives || [];
      if (alts.length) return pickMatch(r, alts.map((a) => ({ asin: a })), rerender, 'Other listings with this barcode');
      await setMatch(r, '', 'manual'); toast('Unmatched'); rerender();
    } else if (e.target.closest('[data-name]')) {
      try { const c = await searchByName(r); if (!c.length) return toast('Nothing found on Amazon for that description', 'info'); pickMatch(r, c, rerender, `Search: ${r.title.slice(0, 50)}`); } catch (err) { toast(err.message, 'error'); }
    }
  });
  const find = $('#plFind');
  if (find) find.onclick = async () => {
    find.disabled = true;
    const p = progressUI($('#plProg')); p.onCancel(() => cancelKeepa());
    try { const r = await matchBarcodes(id, { onProgress: (f, m) => p.set(f, m) }); p.done(); toast(`${num(r.matched)} found on Amazon${r.notFound ? `, ${num(r.notFound)} not found` : ''}`, 'success', 6000); } catch (e) { p.done(); toast(e.message, 'error', 8000); }
    rerender();
  };
  const names = $('#plNames');
  if (names) names.onclick = async () => {
    const todo = rows.filter((r) => !r.asin && (r.matchType === 'nocode' || r.matchType === 'notfound') && r.title).slice(0, 20);
    if (!(await confirmBox(`Search ${todo.length} by name?`, `About ${todo.length * 10} Keepa tokens. Each line is matched to the closest Amazon listing by its description; check them, because a name match can be wrong (use ✕ to undo one).`, { okLabel: 'Search' }))) return;
    const p = progressUI($('#plProg')); p.onCancel(() => cancelKeepa());
    let n = 0;
    try {
      for (const [i, r] of todo.entries()) {
        p.set(i / todo.length, `Searching ${i + 1} of ${todo.length}: ${r.title.slice(0, 40)}…`);
        const c = await searchByName(r);
        if (c[0]) { await setMatch(r, c[0].asin, 'name'); n++; }
      }
      p.done(); toast(`${n} matched by name: check them`, 'success');
    } catch (e) { p.done(); toast(e.message, 'error'); }
    rerender();
  };
  $('#plOut').onclick = async () => {
    const chosen = rows.filter((r) => ticked.has(r.key));
    if (!chosen.length) return toast('Tick the products to send to Outreach first', 'error');
    const res = await sendToOutreach(scan, chosen);
    toast(`${res.added} product${res.added === 1 ? '' : 's'} added to Outreach, linked to ${res.supplier.company} at these prices`, 'success', 6000);
    ctx.navigate('outreach/leads');
  };
  $('#plCsv').onclick = () => downloadFile(`price-list-${scan.supplierName || 'supplier'}-ranked.csv`.replace(/\s+/g, '-'), toCSV([['Their description', 'Barcode', 'Their code', 'Pack', 'Their price (unit)', 'ASIN', 'Amazon title', 'Matched', 'Sells for', 'Profit', 'ROI %', 'Max buy', 'Sales per month', 'BSR', 'Price stability', 'Offers', 'Amazon selling', 'Score'],
    ...filtered().sort((a, b) => (b.score ?? -1) - (a.score ?? -1)).map((r) => [r.title, r.code, r.sku, r.pack, r.unitCost ?? '', r.asin, r.p?.title || '', MATCH[r.matchType] || '', r.price ?? '', r.profit ?? '', r.roi === null ? '' : Math.round(r.roi * 1000) / 10, r.econ?.maxBuy ?? '', r.p?.monthlySold ?? '', r.bsr ?? '', r.stability ?? '', r.offers ?? '', r.amazon ? 'yes' : 'no', r.score ?? ''])]));
  $('#plDel').onclick = async () => {
    if (!(await confirmBox('Delete this price list?', 'Removes the list and its results. Products you sent to Outreach stay there.', { okLabel: 'Delete', danger: true }))) return;
    await deleteScan(id); ctx.navigate('pricelists');
  };
}

// Choose which Amazon listing a line is (from a name search, or the other listings sharing its barcode).
async function pickMatch(r, candidates, done, title) {
  const list = [];
  for (const c of candidates) list.push(c.title ? c : (await db.get('products', `2:${c.asin}`)) || c);
  modal({
    title, wide: true,
    body: `<p class="small muted">Their line: <b>${esc(r.title)}</b>${r.code ? ` · ${esc(r.code)}` : ''}</p><div class="table-wrap"><table class="data small"><tbody>
      ${list.map((p) => `<tr><td>${productCell(p.title ? p : null, { asin: p.asin, domain: 2 })}</td><td class="r num">${p.price ? money(p.price) : ''}</td><td class="r"><button class="btn small primary" data-pick="${esc(p.asin)}">This one</button></td></tr>`).join('')}
      </tbody></table></div>`,
    actions: [{ label: 'None of these', onClick: async () => { await setMatch(r, '', 'manual'); done(); } }],
  }).body.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-pick]'); if (!b) return;
    await setMatch(r, b.dataset.pick, r.matchType === 'nocode' || r.matchType === 'notfound' ? 'name' : 'manual');
    document.querySelector('.modal-back')?.remove(); done();
  });
}
