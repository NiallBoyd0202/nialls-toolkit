// Retailer & wholesaler outreach: turn storefront-tracker leads into supplier relationships.
// Overview (pipeline + follow-ups + brands to approach first) · Brands & products ranking · Leads · Suppliers · Templates · Settings
import * as db from '../db.js';
import { loadOutreach, saveSettings, STAGES, DECLINED, STAGE_LABEL, SUPPLIER_TYPES, DEFAULT_TEMPLATES, newId, brandKey } from '../outreach/store.js';
import { rankProducts, rankBrands, followUpsDue, fillTemplate, unitEconomics, PLACEHOLDERS } from '../outreach/analysis.js';
import { getSettings as faSettings } from '../fbaadmin/store.js';
import { icon, toast, modal, confirmBox, sortable, productCell, progressUI } from '../ui.js';
import { esc, num, money, pct, toCSV, downloadFile, normHeader, amazonUrl } from '../util.js';
import { readTabularFile } from '../xlsx.js';

const TABS = [['overview', 'Overview'], ['brands', 'Brands & products'], ['leads', 'Leads'], ['suppliers', 'Suppliers'], ['templates', 'Email templates'], ['settings', 'Settings']];
const ui = { tab: 'overview', view: 'brands', q: '', stage: '', onlyFirst: false, minStores: 1 };
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const dstr = (d) => (d ? new Date(`${String(d).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }) : '—');
const stageTag = (st) => (st ? `<span class="tag stage-${esc(st)}">${esc(STAGE_LABEL[st] || st)}</span>` : '<span class="muted small">—</span>');
const kpi = (label, value, sub = '', href = '') => `<${href ? `a href="${href}"` : 'div'} class="kpi${href ? ' kpi-link' : ''}"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></${href ? 'a' : 'div'}>`;
const scoreCell = (s) => `<span class="score s${s >= 70 ? 'hi' : s >= 50 ? 'mid' : 'lo'}">${s}</span>`;
const findUrl = (brand) => `https://www.google.co.uk/search?q=${encodeURIComponent(`"${brand}" wholesale UK trade account`)}`;

async function loadAll() {
  const [o, items, sellers, prods, fa] = await Promise.all([loadOutreach(), db.getAll('items'), db.getAll('sellers'), db.getAll('products'), faSettings()]);
  const products = new Map(prods.map((p) => [p.key, p]));
  const data = { ...o, items, sellers, products, vatRegistered: !!fa.vatRegistered };
  data.productRows = rankProducts(data);
  data.brandRows = rankBrands(data, data.productRows);
  data.due = followUpsDue(o.suppliers, today());
  return data;
}

// Nav badge: follow-ups due today or earlier.
export async function dueCount() {
  return followUpsDue(await db.getAll('orSuppliers'), today()).length;
}

// The Outreach tabs in the Google Sheet follow a minute after your last change here (if the sheet is connected).
let sheetTimer = null;
function scheduleSheetSync() {
  clearTimeout(sheetTimer);
  sheetTimer = setTimeout(async () => { try { (await import('../fbaadmin/sync.js')).autoSync(); } catch { /* optional */ } }, 60e3);
}

export async function render(root, ctx) {
  if (ctx?.sub && TABS.some(([id]) => id === ctx.sub)) ui.tab = ctx.sub;
  const data = await loadAll();
  const rerender = async () => { scheduleSheetSync(); await render(root, { ...ctx, sub: ui.tab }); ctx?.refreshBadges?.(); };
  root.innerHTML = `<div class="tabs">${TABS.map(([id, l]) => `<a class="tab ${ui.tab === id ? 'active' : ''}" href="#outreach/${id}">${l}${id === 'overview' && data.due.length ? `<span class="count">${data.due.length}</span>` : ''}${id === 'suppliers' && data.suppliers.length ? `<span class="count">${data.suppliers.length}</span>` : ''}</a>`).join('')}</div><div id="orBody"></div>`;
  const body = root.querySelector('#orBody');
  const views = { overview: renderOverview, brands: renderBrands, leads: renderLeads, suppliers: renderSuppliers, templates: renderTemplates, settings: renderSettings };
  await views[ui.tab](body, data, rerender);
}

// ---------------------------------------------------------------------------
// Overview: pipeline board, follow-ups, brands to approach first
// ---------------------------------------------------------------------------
function renderOverview(body, data, rerender) {
  const first = data.brandRows.filter((b) => b.approachFirst);
  const byStage = Object.fromEntries([...STAGES, DECLINED].map(([id]) => [id, []]));
  for (const s of data.suppliers) (byStage[s.stage || 'to_contact'] ||= []).push(s);
  const leadsOf = (sid) => data.links.filter((l) => l.supplierId === sid).map((l) => data.leads.find((x) => x.id === l.leadId)).filter(Boolean);
  const noTracker = !data.items.length;
  body.innerHTML = `
    ${noTracker ? `<div class="callout section-first">The brand and product ranking comes from the <a href="#tracker/new">Storefront tracker</a>: track some competitor storefronts (or load the demo ones) and their products appear here, ranked. You can add suppliers and leads by hand any time.</div>` : ''}
    <div class="kpis">
      ${kpi('Follow-ups due', num(data.due.length), data.due.length ? `oldest ${dstr(data.due[0].nextFollowUp)}` : 'nothing to chase')}
      ${kpi('Brands to approach first', num(first.length), first.length ? first.slice(0, 2).map((b) => esc(b.brand)).join(', ') : 'none flagged yet', '#outreach/brands')}
      ${kpi('Suppliers in the pipeline', num(data.suppliers.filter((s) => s.stage !== 'declined').length), `${byStage.account.length + byStage.ordering.length} with an account`, '#outreach/suppliers')}
      ${kpi('Leads', num(data.leads.length), `${data.leads.filter((l) => data.links.some((k) => k.leadId === l.id)).length} linked to a supplier`, '#outreach/leads')}
    </div>

    ${data.due.length ? `<div class="card section"><div class="toolbar"><b>${icon('bell', 15)} Follow-ups due</b><span class="small muted">suppliers to chase today or earlier</span></div>
      <div class="table-wrap"><table class="data"><tbody>${data.due.map((s) => `<tr data-sid="${esc(s.id)}"><td><a href="#" data-open>${esc(s.company)}</a><div class="small muted">${esc(s.contactName || '')}${s.email ? ` · ${esc(s.email)}` : ''}</div></td>
        <td>${stageTag(s.stage)}<div class="small ${s.nextFollowUp < today() ? 'neg' : 'muted'}">${dstr(s.nextFollowUp)}</div></td>
        <td class="r"><div class="row" style="justify-content:flex-end;gap:6px"><button class="btn small primary" data-email>${icon('mail', 14)} Email</button><button class="btn small" data-snooze>+3 days</button><button class="btn small ghost" data-done>Done</button></div></td></tr>`).join('')}</tbody></table></div></div>` : ''}

    <div class="card section"><div class="toolbar"><b>Pipeline</b><span class="grow"></span><button class="btn small primary" id="addSup">${icon('plus', 14)} Add supplier</button></div>
      <div class="board">${STAGES.map(([id, label]) => `<div class="board-col"><div class="board-h">${label} <span class="muted">${byStage[id].length}</span></div>
        ${byStage[id].sort((a, b) => String(a.nextFollowUp || '9').localeCompare(String(b.nextFollowUp || '9'))).map((s) => {
          const ls = leadsOf(s.id);
          return `<div class="board-card" data-sid="${esc(s.id)}"><b>${esc(s.company)}</b><div class="small muted">${esc(s.type || '')}${ls.length ? ` · ${ls.slice(0, 3).map((l) => esc(l.brand || l.asin)).join(', ')}${ls.length > 3 ? '…' : ''}` : ''}</div>
            ${s.nextFollowUp ? `<div class="small ${s.nextFollowUp <= today() ? 'neg' : 'muted'}">${icon('bell', 12)} ${dstr(s.nextFollowUp)}</div>` : ''}</div>`;
        }).join('') || '<div class="small muted board-empty">—</div>'}</div>`).join('')}</div>
      ${byStage.declined.length ? `<p class="small muted" style="padding:0 14px 12px">${byStage.declined.length} declined / not a fit: ${byStage.declined.map((s) => `<a href="#" data-sid-link="${esc(s.id)}">${esc(s.company)}</a>`).join(', ')}</p>` : ''}
    </div>

    <div class="card section"><div class="toolbar"><b>${icon('star', 15)} Brands to approach first</b><span class="small muted">listed by 2+ of your tracked storefronts, good demand, steady prices, Amazon mostly not selling, and no conversation started yet</span><span class="grow"></span><a class="btn small" href="#outreach/brands">All brands</a></div>
      ${first.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Brand</th><th class="r">Score</th><th class="r">Storefronts</th><th class="r">Products</th><th class="r">Sales / month</th><th class="r">Price stability</th><th></th></tr></thead><tbody>
        ${first.map((b) => `<tr data-brand="${esc(b.brandKey)}"><td><b>${esc(b.brand)}</b><div class="small muted">${b.topProducts.map((p) => esc(p.title.slice(0, 40))).join(' · ')}</div></td><td class="r">${scoreCell(b.score)}</td><td class="r num">${b.storefronts}</td><td class="r num">${b.products}</td>
          <td class="r num">${b.monthlySold ? `${num(b.monthlySold)}+` : '—'}</td><td class="r num">${b.stability ?? '—'}</td>
          <td class="r nowrap">${b.hasLead ? '<span class="tag new">Lead</span>' : `<button class="btn small" data-addbrand>${icon('plus', 14)} Lead</button>`} <a class="btn small ghost" href="${findUrl(b.brand)}" target="_blank" rel="noopener">${icon('search', 14)} Find suppliers</a></td></tr>`).join('')}
      </tbody></table></div>` : `<p class="small muted" style="padding:12px 14px">${noTracker ? 'Nothing to rank yet.' : 'No brands stand out yet: they need to be listed by at least 2 of your tracked storefronts. Track more storefronts or check the full list.'}</p>`}
    </div>`;

  const sup = (el) => data.suppliers.find((s) => s.id === el.closest('[data-sid]')?.dataset.sid);
  body.querySelectorAll('.board-card').forEach((c) => { c.onclick = () => openSupplier(sup(c), data, rerender); });
  body.querySelectorAll('[data-sid-link]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); openSupplier(data.suppliers.find((s) => s.id === a.dataset.sidLink), data, rerender); }; });
  body.querySelectorAll('[data-open]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); openSupplier(sup(a), data, rerender); }; });
  body.querySelectorAll('[data-email]').forEach((b) => { b.onclick = () => compose(sup(b), data, rerender, 'tpl-followup'); });
  body.querySelectorAll('[data-snooze]').forEach((b) => { b.onclick = async () => { const s = sup(b); await db.put('orSuppliers', { ...s, nextFollowUp: addDays(today(), 3) }); rerender(); }; });
  body.querySelectorAll('[data-done]').forEach((b) => { b.onclick = async () => { const s = sup(b); await db.put('orSuppliers', { ...s, nextFollowUp: '' }); await logActivity(s.id, 'note', 'Follow-up done'); rerender(); }; });
  body.querySelectorAll('[data-addbrand]').forEach((b) => { b.onclick = async () => { const row = data.brandRows.find((x) => x.brandKey === b.closest('tr').dataset.brand); await addLead({ type: 'brand', brand: row.brand }); toast(`${row.brand} added to leads`, 'success'); rerender(); }; });
  body.querySelector('#addSup').onclick = () => openSupplier(null, data, rerender);
}

// ---------------------------------------------------------------------------
// Brands & products ranking
// ---------------------------------------------------------------------------
function renderBrands(body, data, rerender) {
  const s = data.settings;
  const brandsView = ui.view === 'brands';
  // products listed by enough storefronts to matter, that Keepa hasn't described yet (so no brand, price or rank)
  const missing = data.productRows.filter((p) => !p.product && p.storefronts >= Math.max(ui.minStores, 1));
  body.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <div class="seg"><button class="btn small ${brandsView ? 'primary' : ''}" data-view="brands">Brands</button><button class="btn small ${brandsView ? '' : 'primary'}" data-view="products">Products</button></div>
        <input type="search" id="q" placeholder="Search brand, title, ASIN" value="${esc(ui.q)}" style="width:200px">
        <label class="small">Min storefronts <select id="minS">${[1, 2, 3, 4, 5].map((n) => `<option ${ui.minStores === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        ${brandsView ? `<label class="check small"><input type="checkbox" id="first" ${ui.onlyFirst ? 'checked' : ''}> Approach first only</label>` : ''}
        <span class="grow"></span>${missing.length ? `<button class="btn small" id="loadDet" title="Brands are only known once Keepa details are loaded">${icon('download', 14)} Load details for ${num(missing.length)} product${missing.length === 1 ? '' : 's'} (≈${num(missing.length)} tokens)</button>` : ''}<button class="btn small" id="csv">${icon('download', 14)} CSV</button>
      </div>
      <div id="detProg"></div>
      <div class="table-wrap"><table class="data" id="rank"><thead>${brandsView
        ? '<tr><th data-sort="brand" data-first="asc">Brand</th><th data-sort="score" class="r">Score</th><th data-sort="storefronts" class="r">Storefronts</th><th data-sort="products" class="r">Products</th><th data-sort="monthlySold" class="r">Sales / mo</th><th data-sort="medianBsr" data-first="asc" class="r">Median BSR</th><th data-sort="stability" class="r">Price stability</th><th data-sort="bestRoi" class="r">Best ROI</th><th class="r">Amazon on</th><th>Status</th><th></th></tr>'
        : '<tr><th>Product</th><th data-sort="score" class="r">Score</th><th data-sort="storefronts" class="r">Storefronts</th><th data-sort="price" class="r">Price</th><th data-sort="bsr" data-first="asc" class="r">BSR</th><th data-sort="stability" class="r">Price stability</th><th class="r" title="Most you can pay for your target ROI">Max buy</th><th class="r">Supplier price</th><th class="r">Profit / ROI</th><th></th></tr>'}</thead><tbody></tbody></table></div>
    </div>
    <p class="small muted section">Score (0–100): 35% how many of your tracked storefronts list it, 25% demand (Keepa sales estimate or rank), 15% price stability (90-day low/high and the last 30 days against 90), 25% profit: ROI at the supplier's price where you've entered one, otherwise what's left after Amazon fees (capped). Amazon selling on the listing takes 15 off. <b>Max buy</b> is the most you can pay per unit (${s.supplierPricesIncVat ? 'inc' : 'ex'} VAT) for a ${pct(Number(s.targetRoi) || 0)} ROI after fees, ${money(Number(s.prepPerUnit) + Number(s.inboundPerUnit))} prep and shipping${data.vatRegistered ? ', VAT registered' : ', not VAT registered'} (<a href="#outreach/settings">change</a>). Price stability needs product details refreshed since v2.0.</p>`;
  const q = ui.q.trim().toLowerCase();
  const table = body.querySelector('#rank');
  let rows;
  if (brandsView) {
    rows = data.brandRows.filter((b) => b.storefronts >= ui.minStores && (!ui.onlyFirst || b.approachFirst) && (!q || b.brandKey.includes(q) || b.allProducts.some((p) => p.asin.toLowerCase() === q)));
    sortable(table, rows, (b) => `<tr data-brand="${esc(b.brandKey)}" class="click"><td><b>${esc(b.brand)}</b>${b.approachFirst ? ' <span class="tag hot">Approach first</span>' : ''}</td><td class="r">${scoreCell(b.score)}</td>
      <td class="r num">${b.storefronts}</td><td class="r num">${b.products}</td><td class="r num">${b.monthlySold ? `${num(b.monthlySold)}+` : '—'}</td><td class="r num">${b.medianBsr ? `#${num(b.medianBsr)}` : '—'}</td>
      <td class="r num">${b.stability ?? '—'}</td><td class="r num">${b.bestRoi === null ? '—' : pct(b.bestRoi)}</td><td class="r num">${pct(b.amazonShare)}</td>
      <td>${b.stage ? stageTag(b.stage) : b.hasLead ? '<span class="tag new">Lead</span>' : ''}</td>
      <td class="r nowrap">${b.hasLead ? '' : `<button class="btn small" data-addbrand title="Add as a lead">${icon('plus', 14)} Lead</button>`} <a class="icon-btn" href="${findUrl(b.brand)}" target="_blank" rel="noopener" title="Search for UK wholesalers">${icon('search', 15)}</a></td></tr>`, { defaultKey: 'score' });
  } else {
    rows = data.productRows.filter((p) => p.storefronts >= ui.minStores && (!q || `${p.asin} ${p.title} ${p.brand}`.toLowerCase().includes(q)));
    rows.forEach((r) => { r.profitSort = r.econ?.profit ?? null; });
    sortable(table, rows.slice(0, 500), (p) => `<tr data-pkey="${esc(p.pkey)}"><td>${productCell(p.product, { asin: p.asin, domain: p.domain })}</td><td class="r">${scoreCell(p.score)}</td><td class="r num">${p.storefronts}</td>
      <td class="r num">${money(p.price)}</td><td class="r num">${p.bsr ? `#${num(p.bsr)}` : '—'}${p.monthlySold ? `<div class="small muted">${num(p.monthlySold)}+/mo</div>` : ''}</td><td class="r num">${p.stability ?? '—'}</td>
      <td class="r num">${p.econ ? money(p.econ.maxBuy) : '—'}</td><td class="r num">${p.supplierCost ? `${money(p.supplierCost.cost)}<div class="small muted">${esc(p.supplier?.company || '')}</div>` : '—'}</td>
      <td class="r num">${p.econ?.profit !== undefined ? `<span class="${p.econ.profit >= 0 ? 'pos' : 'neg'}">${money(p.econ.profit)}</span><div class="small muted">${p.econ.roi === null ? '' : pct(p.econ.roi)} ROI</div>` : '—'}</td>
      <td class="r"><button class="btn small" data-addasin title="Add as a lead">${icon('plus', 14)} Lead</button></td></tr>`, { defaultKey: 'score' });
  }
  body.querySelectorAll('[data-view]').forEach((b) => { b.onclick = () => { ui.view = b.dataset.view; rerender(); }; });
  const ld = body.querySelector('#loadDet');
  if (ld) ld.onclick = async () => {
    const { getProducts, cancelKeepa } = await import('../services.js');
    const p = progressUI(body.querySelector('#detProg'));
    p.onCancel(() => cancelKeepa());
    ld.disabled = true;
    try {
      const byDomain = {};
      for (const r of missing.sort((a, b) => b.storefronts - a.storefronts)) (byDomain[r.domain] ||= []).push(r.asin);
      for (const [d, asins] of Object.entries(byDomain)) await getProducts(Number(d), asins, { onProgress: (x, t) => p.set(x / t, `Loading details ${x}/${t}`) });
      p.done(); toast('Details loaded', 'success');
    } catch (e) { p.done(); toast(e.message, 'error'); }
    rerender();
  };
  body.querySelector('#q').oninput = (e) => { ui.q = e.target.value; clearTimeout(ui.qt); ui.qt = setTimeout(rerender, 250); };
  body.querySelector('#minS').onchange = (e) => { ui.minStores = Number(e.target.value); rerender(); };
  const f = body.querySelector('#first'); if (f) f.onchange = (e) => { ui.onlyFirst = e.target.checked; rerender(); };
  table.addEventListener('click', async (e) => {
    const tr = e.target.closest('tr'); if (!tr || !tr.parentElement.matches('tbody')) return;
    if (e.target.closest('a')) return;
    if (e.target.closest('[data-addbrand]')) { const b = data.brandRows.find((x) => x.brandKey === tr.dataset.brand); await addLead({ type: 'brand', brand: b.brand }); toast(`${b.brand} added to leads`, 'success'); return rerender(); }
    if (e.target.closest('[data-addasin]')) { const p = data.productRows.find((x) => x.pkey === tr.dataset.pkey); await addLead({ type: 'asin', asin: p.asin, domain: p.domain, brand: p.brand, title: p.title }); toast('Added to leads', 'success'); return rerender(); }
    if (tr.dataset.brand) brandModal(data.brandRows.find((x) => x.brandKey === tr.dataset.brand), data, rerender);
  });
  body.querySelector('#csv').onclick = () => {
    if (brandsView) downloadFile(`brands-ranked-${today()}.csv`, toCSV([['Brand', 'Score', 'Approach first', 'Storefronts', 'Products', 'Sales per month', 'Median BSR', 'Price stability', 'Best ROI %', 'Amazon on listing %', 'Status'], ...rows.map((b) => [b.brand, b.score, b.approachFirst ? 'Yes' : '', b.storefronts, b.products, b.monthlySold ?? '', b.medianBsr ?? '', b.stability ?? '', b.bestRoi === null ? '' : Math.round(b.bestRoi * 100), Math.round(b.amazonShare * 100), b.stage ? STAGE_LABEL[b.stage] : b.hasLead ? 'Lead' : ''])]));
    else downloadFile(`products-ranked-${today()}.csv`, toCSV([['ASIN', 'Title', 'Brand', 'Score', 'Storefronts', 'Price', 'BSR', 'Sales per month', 'Price stability', 'Max buy', 'Supplier price', 'Supplier', 'Profit', 'ROI %', 'Amazon on listing', 'Link'], ...rows.map((p) => [p.asin, p.title, p.brand, p.score, p.storefronts, p.price ?? '', p.bsr ?? '', p.monthlySold ?? '', p.stability ?? '', p.econ?.maxBuy ?? '', p.supplierCost?.cost ?? '', p.supplier?.company || '', p.econ?.profit ?? '', p.econ?.roi === null || p.econ?.roi === undefined ? '' : Math.round(p.econ.roi * 100), p.amazon ? 'yes' : 'no', amazonUrl(p.domain, p.asin)])]));
  };
}

function brandModal(b, data, rerender) {
  const m = modal({
    title: b.brand, wide: true,
    body: `<div class="kpis" style="margin-bottom:12px">${kpi('Score', scoreCell(b.score), b.approachFirst ? 'approach first' : '')}${kpi('Storefronts', b.storefronts, 'of yours list it')}${kpi('Sales / month', b.monthlySold ? `${num(b.monthlySold)}+` : '—', 'Keepa estimate, all its products')}${kpi('Price stability', b.stability ?? '—', '100 = steady')}</div>
      ${b.suppliers.length ? `<p class="small">Suppliers linked: ${b.suppliers.map((s) => `${esc(s.company)} ${stageTag(s.stage)}`).join(', ')}</p>` : '<p class="small muted">No supplier linked yet.</p>'}
      <div class="table-wrap"><table class="data"><thead><tr><th>Product</th><th class="r">Storefronts</th><th class="r">Price</th><th class="r">BSR</th><th class="r">Stability</th><th class="r">Max buy</th><th class="r">Profit / ROI</th></tr></thead><tbody>
      ${b.allProducts.sort((x, y) => y.score - x.score).map((p) => `<tr><td>${productCell(p.product, { asin: p.asin, domain: p.domain })}</td><td class="r num">${p.storefronts}</td><td class="r num">${money(p.price)}</td><td class="r num">${p.bsr ? `#${num(p.bsr)}` : '—'}</td><td class="r num">${p.stability ?? '—'}</td><td class="r num">${p.econ ? money(p.econ.maxBuy) : '—'}</td><td class="r num">${p.econ?.profit !== undefined ? `${money(p.econ.profit)} · ${pct(p.econ.roi)}` : '—'}</td></tr>`).join('')}
      </tbody></table></div>`,
    actions: [
      { label: 'Find suppliers', onClick: () => { window.open(findUrl(b.brand), '_blank', 'noopener'); return false; } },
      ...(b.hasLead ? [] : [{ label: 'Add as a lead', kind: 'primary', onClick: async () => { await addLead({ type: 'brand', brand: b.brand }); toast(`${b.brand} added to leads`, 'success'); rerender(); } }]),
    ],
  });
  return m;
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------
async function addLead(l) {
  const leads = await db.getAll('orLeads');
  const dupe = leads.find((x) => (l.type === 'brand' ? x.type === 'brand' && brandKey(x.brand) === brandKey(l.brand) : x.type === 'asin' && x.asin === l.asin));
  if (dupe) return dupe;
  const rec = { id: newId('lead'), type: l.type, brand: l.brand || '', asin: l.asin || '', domain: l.domain || 2, title: l.title || '', note: l.note || '', addedAt: Date.now() };
  await db.put('orLeads', rec);
  return rec;
}
export { addLead };

function leadEcon(lead, link, data) {
  if (lead.type !== 'asin') return null;
  const p = data.products.get(`${lead.domain || 2}:${lead.asin}`);
  return p ? unitEconomics(p, link?.cost, data.settings, { vatRegistered: data.vatRegistered }) : null;
}

function renderLeads(body, data, rerender) {
  const supById = new Map(data.suppliers.map((s) => [s.id, s]));
  const rows = data.leads.map((l) => {
    const links = data.links.filter((k) => k.leadId === l.id);
    const brandRow = data.brandRows.find((b) => b.brandKey === brandKey(l.brand));
    const prodRow = l.type === 'asin' ? data.productRows.find((p) => p.asin === l.asin) : null;
    return { ...l, links, label: l.type === 'brand' ? l.brand : (l.title || l.asin), score: (l.type === 'brand' ? brandRow?.score : prodRow?.score) ?? null, storefronts: (l.type === 'brand' ? brandRow?.storefronts : prodRow?.storefronts) ?? null };
  });
  body.innerHTML = `
    <div class="card card-pad stack">
      <div class="row"><b class="grow">Add a lead</b></div>
      <div class="row"><select id="lt"><option value="brand">Brand</option><option value="asin">ASIN</option></select>
        <input id="lv" class="grow" placeholder="Brand name, or an ASIN like B0ABC12345" list="brandList"><datalist id="brandList">${data.brandRows.slice(0, 300).map((b) => `<option value="${esc(b.brand)}">`).join('')}</datalist>
        <button class="btn primary" id="addL">${icon('plus', 14)} Add</button></div>
      <p class="small muted">Or add them from <a href="#outreach/brands">Brands &amp; products</a> or the <a href="#tracker/new">New products</a> feed (＋ Lead).</p>
    </div>
    <div class="card section"><div class="toolbar"><b>${rows.length} leads</b></div>
      ${rows.length ? `<div class="table-wrap"><table class="data" id="lt2"><thead><tr><th data-sort="label" data-first="asc">Lead</th><th data-sort="score" class="r">Score</th><th data-sort="storefronts" class="r">Storefronts</th><th>Suppliers (price)</th><th class="r">Best profit / ROI</th><th></th></tr></thead><tbody></tbody></table></div>`
        : `<div class="empty-state small">${icon('star', 28)}<p>No leads yet.</p></div>`}
    </div>`;
  const tb = body.querySelector('#lt2');
  if (tb) sortable(tb, rows, (l) => {
    const econs = l.links.map((k) => leadEcon(l, k, data)).filter((e) => e?.profit !== undefined);
    const best = econs.sort((a, b) => b.profit - a.profit)[0];
    return `<tr data-lid="${esc(l.id)}"><td><span class="tag">${l.type === 'brand' ? 'Brand' : 'ASIN'}</span> <b>${esc(l.label.slice(0, 70))}</b>${l.type === 'asin' ? `<div class="small muted mono">${esc(l.asin)}${l.brand ? ` · ${esc(l.brand)}` : ''}</div>` : ''}${l.note ? `<div class="small muted">${esc(l.note)}</div>` : ''}</td>
      <td class="r">${l.score === null ? '—' : scoreCell(l.score)}</td><td class="r num">${l.storefronts ?? '—'}</td>
      <td><div class="chips">${l.links.map((k) => { const s = supById.get(k.supplierId); return s ? `<span class="chip" title="${esc(STAGE_LABEL[s.stage] || '')}">${esc(s.company)}${k.cost !== '' && k.cost !== undefined && k.cost !== null ? ` · ${money(Number(k.cost))}` : ''}</span>` : ''; }).join('') || '<span class="small muted">none yet</span>'}</div></td>
      <td class="r num">${best ? `<span class="${best.profit >= 0 ? 'pos' : 'neg'}">${money(best.profit)}</span> <span class="small muted">${pct(best.roi)}</span>` : '—'}</td>
      <td class="r nowrap"><button class="btn small" data-link>${icon('plus', 14)} Supplier</button> <button class="icon-btn" data-del title="Remove lead">${icon('trash', 15)}</button></td></tr>`;
  }, { defaultKey: 'score' });
  body.querySelector('#addL').onclick = async () => {
    const t = body.querySelector('#lt').value; const v = body.querySelector('#lv').value.trim();
    if (!v) return toast('Type a brand or an ASIN', 'error');
    if (t === 'asin' && !/^[A-Z0-9]{10}$/i.test(v)) return toast('An ASIN is 10 letters and numbers, like B0ABC12345', 'error');
    const p = t === 'asin' ? data.products.get(`2:${v.toUpperCase()}`) : null;
    await addLead(t === 'brand' ? { type: 'brand', brand: v } : { type: 'asin', asin: v.toUpperCase(), domain: 2, brand: p?.brand || '', title: p?.title || '' });
    toast('Lead added', 'success'); rerender();
  };
  if (tb) tb.addEventListener('click', async (e) => {
    const tr = e.target.closest('tr[data-lid]'); if (!tr) return;
    const lead = data.leads.find((l) => l.id === tr.dataset.lid);
    if (e.target.closest('[data-del]')) {
      if (!(await confirmBox('Remove this lead?', 'Its links to suppliers (and the prices you entered) are removed too. The suppliers stay.', { okLabel: 'Remove', danger: true }))) return;
      await db.delMany('orLinks', data.links.filter((k) => k.leadId === lead.id).map((k) => k.id));
      await db.del('orLeads', lead.id); rerender();
    } else if (e.target.closest('[data-link]')) linkModal({ lead }, data, rerender);
  });
}

// Link a lead to a supplier (from either side), with the supplier's price.
function linkModal({ lead = null, supplier = null, link = null }, data, rerender) {
  const brandProducts = (l) => data.productRows.filter((p) => l?.type === 'brand' && p.brandKey === brandKey(l.brand));
  const body = document.createElement('div');
  const draw = () => {
    const l = lead || data.leads.find((x) => x.id === body.querySelector('#lk')?.value);
    const prods = brandProducts(l);
    body.innerHTML = `<div class="form-grid">
      ${lead ? `<div><div class="small muted">Lead</div><b>${esc(lead.type === 'brand' ? lead.brand : lead.title || lead.asin)}</b></div>`
        : `<label class="field">Lead<select id="lk">${data.leads.map((x) => `<option value="${esc(x.id)}" ${l?.id === x.id ? 'selected' : ''}>${x.type === 'brand' ? 'Brand: ' : ''}${esc(x.type === 'brand' ? x.brand : x.title || x.asin)}</option>`).join('')}</select></label>`}
      ${supplier ? `<div><div class="small muted">Supplier</div><b>${esc(supplier.company)}</b></div>`
        : `<label class="field">Supplier<select id="sk">${data.suppliers.map((x) => `<option value="${esc(x.id)}" ${link?.supplierId === x.id ? 'selected' : ''}>${esc(x.company)}</option>`).join('')}</select></label>`}
      ${l?.type === 'asin' ? `<label class="field">Their price per unit £ (${data.settings.supplierPricesIncVat ? 'inc' : 'ex'} VAT)<input id="cost" type="number" step="0.01" min="0" value="${esc(link?.cost ?? '')}"></label>` : ''}
      <label class="field">Case / pack size<input id="pack" type="number" step="1" min="1" value="${esc(link?.packSize ?? '')}"></label>
      <label class="field span2">Note<input id="note" value="${esc(link?.note || '')}" placeholder="e.g. in their price list p.12, MOQ 2 cases"></label></div>
      ${l?.type === 'brand' && prods.length ? `<p class="small muted" style="margin-top:12px">Their price for each of the brand's products you track (leave blank if they don't stock it):</p>
        <div class="table-wrap"><table class="data small"><tbody>${prods.map((p) => `<tr><td>${esc(p.title.slice(0, 60))}<div class="muted mono">${esc(p.asin)} · sells ${money(p.price)} · max buy ${p.econ ? money(p.econ.maxBuy) : '—'}</div></td><td class="r"><input class="cell" data-price="${esc(p.asin)}" type="number" step="0.01" min="0" value="${esc(link?.prices?.[p.asin] ?? '')}"></td></tr>`).join('')}</tbody></table></div>` : ''}`;
    const lk = body.querySelector('#lk'); if (lk) lk.onchange = draw;
  };
  if (!data.leads.length && !lead) return toast('Add a lead first (Leads tab)', 'error');
  if (!data.suppliers.length && !supplier) return toast('Add a supplier first (Suppliers tab)', 'error');
  draw();
  modal({
    title: link ? 'Edit link' : 'Link a supplier', body,
    actions: [
      ...(link ? [{ label: 'Unlink', kind: 'danger', onClick: async () => { await db.del('orLinks', link.id); rerender(); } }] : []),
      { label: 'Cancel' },
      { label: 'Save', kind: 'primary', onClick: async () => {
        const leadId = lead?.id || body.querySelector('#lk').value; const supplierId = supplier?.id || body.querySelector('#sk').value;
        const prices = {}; body.querySelectorAll('[data-price]').forEach((i) => { if (i.value !== '') prices[i.dataset.price] = Number(i.value); });
        const existing = link || data.links.find((k) => k.leadId === leadId && k.supplierId === supplierId);
        const c = body.querySelector('#cost');
        await db.put('orLinks', { ...(existing || { id: newId('link'), addedAt: Date.now() }), leadId, supplierId, cost: c ? (c.value === '' ? '' : Number(c.value)) : (existing?.cost ?? ''), packSize: body.querySelector('#pack').value, note: body.querySelector('#note').value.trim(), prices });
        toast('Saved', 'success'); rerender();
      } },
    ],
  });
}

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------
async function logActivity(supplierId, kind, text, extra = {}) {
  await db.put('orActivity', { id: newId('act'), supplierId, kind, text, at: Date.now(), ...extra });
}

function renderSuppliers(body, data, rerender) {
  const q = ui.q.trim().toLowerCase();
  const lastAct = new Map();
  for (const a of data.activity) if (!lastAct.has(a.supplierId) || lastAct.get(a.supplierId).at < a.at) lastAct.set(a.supplierId, a);
  const rows = data.suppliers.filter((s) => (!ui.stage || (s.stage || 'to_contact') === ui.stage) && (!q || `${s.company} ${s.contactName} ${s.email} ${s.notes}`.toLowerCase().includes(q)))
    .map((s) => ({ ...s, leadsN: data.links.filter((k) => k.supplierId === s.id).length, last: lastAct.get(s.id)?.at || 0, stageN: [...STAGES, DECLINED].findIndex(([id]) => id === (s.stage || 'to_contact')) }));
  body.innerHTML = `
    <div class="card"><div class="toolbar">
      <input type="search" id="q" placeholder="Search suppliers" value="${esc(ui.q)}" style="width:200px">
      <select id="st"><option value="">All stages</option>${[...STAGES, DECLINED].map(([id, l]) => `<option value="${id}" ${ui.stage === id ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <span class="grow"></span>
      <button class="btn small" id="imp">${icon('upload', 14)} Import CSV</button><input type="file" id="impF" accept=".csv,.xlsx,.txt" hidden>
      <button class="btn small" id="exp">${icon('download', 14)} CSV</button>
      <button class="btn small primary" id="add">${icon('plus', 14)} Add supplier</button></div>
      ${rows.length ? `<div class="table-wrap"><table class="data" id="sl"><thead><tr><th data-sort="company" data-first="asc">Company</th><th>Contact</th><th data-sort="stageN" class="">Stage</th><th data-sort="nextFollowUp" data-first="asc">Follow up</th><th data-sort="leadsN" class="r">Leads</th><th data-sort="last">Last contact</th><th></th></tr></thead><tbody></tbody></table></div>`
        : `<div class="empty-state">${icon('users', 30)}<h3>No suppliers yet</h3><p>Add the wholesalers, distributors and brands you want to buy from. Import a CSV with columns like Company, Contact, Email, Phone, Website, Account number, Minimum order, Notes.</p></div>`}
    </div>`;
  const tb = body.querySelector('#sl');
  if (tb) sortable(tb, rows, (s) => `<tr data-sid="${esc(s.id)}" class="click"><td><b>${esc(s.company)}</b><div class="small muted">${esc(s.type || '')}${s.website ? ` · ${esc(s.website.replace(/^https?:\/\//, '').replace(/\/$/, ''))}` : ''}</div></td>
      <td class="small">${esc(s.contactName || '')}${s.email ? `<div><a href="mailto:${esc(s.email)}">${esc(s.email)}</a></div>` : ''}${s.phone ? `<div><a href="tel:${esc(s.phone.replace(/\s/g, ''))}">${esc(s.phone)}</a></div>` : ''}</td>
      <td>${stageTag(s.stage || 'to_contact')}</td><td class="small nowrap ${s.nextFollowUp && s.nextFollowUp <= today() ? 'neg' : ''}">${s.nextFollowUp ? dstr(s.nextFollowUp) : ''}</td>
      <td class="r num">${s.leadsN || ''}</td><td class="small muted nowrap">${s.last ? dstr(new Date(s.last).toISOString()) : ''}</td>
      <td class="r"><button class="btn small" data-email ${s.email ? '' : 'disabled'}>${icon('mail', 14)}</button></td></tr>`, { defaultKey: 'nextFollowUp', defaultDir: 'asc' });
  body.querySelector('#q').oninput = (e) => { ui.q = e.target.value; clearTimeout(ui.qt); ui.qt = setTimeout(rerender, 250); };
  body.querySelector('#st').onchange = (e) => { ui.stage = e.target.value; rerender(); };
  body.querySelector('#add').onclick = () => openSupplier(null, data, rerender);
  if (tb) tb.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-sid]'); if (!tr || e.target.closest('a')) return;
    const s = data.suppliers.find((x) => x.id === tr.dataset.sid);
    if (e.target.closest('[data-email]')) compose(s, data, rerender); else openSupplier(s, data, rerender);
  });
  body.querySelector('#exp').onclick = () => downloadFile(`suppliers-${today()}.csv`, toCSV([['Company', 'Type', 'Contact', 'Email', 'Phone', 'Website', 'Account number', 'Minimum order', 'Stage', 'Next follow-up', 'Leads', 'Notes'],
    ...data.suppliers.map((s) => [s.company, s.type, s.contactName, s.email, s.phone, s.website, s.accountNumber, s.minOrder, STAGE_LABEL[s.stage || 'to_contact'], s.nextFollowUp || '', data.links.filter((k) => k.supplierId === s.id).map((k) => { const l = data.leads.find((x) => x.id === k.leadId); return l ? (l.brand || l.asin) : ''; }).join('; '), s.notes])]));
  const fi = body.querySelector('#impF');
  body.querySelector('#imp').onclick = () => fi.click();
  fi.onchange = async () => {
    try {
      const grid = await readTabularFile(fi.files[0]);
      const hdr = (grid[0] || []).map(normHeader);
      const col = (...n) => hdr.findIndex((h) => n.includes(h));
      const c = { company: col('company', 'company name', 'supplier', 'name', 'business'), contactName: col('contact', 'contact name', 'person'), email: col('email', 'e mail', 'email address'), phone: col('phone', 'telephone', 'tel', 'mobile'), website: col('website', 'web', 'url', 'site'), accountNumber: col('account number', 'account', 'account no'), minOrder: col('minimum order', 'moq', 'min order', 'minimum'), notes: col('notes', 'note'), type: col('type') };
      if (c.company < 0) throw new Error('Needs a Company (or Supplier / Name) column');
      const have = new Set(data.suppliers.map((s) => s.company.trim().toLowerCase()));
      const add = [];
      for (const r of grid.slice(1)) {
        const company = String(r[c.company] || '').trim(); if (!company || have.has(company.toLowerCase())) continue;
        have.add(company.toLowerCase());
        const v = (k) => (c[k] >= 0 ? String(r[c[k]] ?? '').trim() : '');
        add.push({ id: newId('sup'), company, contactName: v('contactName'), email: v('email'), phone: v('phone'), website: v('website'), accountNumber: v('accountNumber'), minOrder: v('minOrder'), notes: v('notes'), type: SUPPLIER_TYPES.find((t) => t.toLowerCase().startsWith(v('type').toLowerCase().slice(0, 5)) && v('type')) || 'Wholesaler', stage: 'to_contact', addedAt: Date.now() });
      }
      await db.putMany('orSuppliers', add);
      toast(`${add.length} supplier${add.length === 1 ? '' : 's'} imported${grid.length - 1 - add.length > 0 ? ` · ${grid.length - 1 - add.length} skipped (blank or already there)` : ''}`, 'success', 6000);
      rerender();
    } catch (e) { toast(e.message, 'error', 7000); }
  };
}

function openSupplier(s0, data, rerender) {
  const s = s0 ? { ...s0 } : { id: newId('sup'), company: '', type: 'Wholesaler', stage: 'to_contact', addedAt: Date.now() };
  const isNew = !s0;
  const links = data.links.filter((k) => k.supplierId === s.id);
  const acts = data.activity.filter((a) => a.supplierId === s.id).sort((a, b) => b.at - a.at);
  const f = (id, label, type = 'text', extra = '') => `<label class="field">${label}<input id="s_${id}" type="${type}" value="${esc(s[id] ?? '')}" ${extra}></label>`;
  const body = document.createElement('div');
  body.innerHTML = `<div class="sup-grid">
    <div class="stack">
      <div class="form-grid">
        ${f('company', 'Company *')}
        <label class="field">Type<select id="s_type">${SUPPLIER_TYPES.map((t) => `<option ${s.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        ${f('contactName', 'Contact name')}${f('email', 'Email', 'email')}${f('phone', 'Phone', 'tel')}${f('website', 'Website', 'url', 'placeholder="https://"')}
        ${f('accountNumber', 'Account number')}${f('minOrder', 'Minimum order', 'text', 'placeholder="e.g. £250 or 2 cases"')}
        <label class="field">Stage<select id="s_stage">${[...STAGES, DECLINED].map(([id, l]) => `<option value="${id}" ${(s.stage || 'to_contact') === id ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        ${f('nextFollowUp', 'Next follow-up', 'date')}
      </div>
      <label class="field">Notes<textarea id="s_notes" rows="3">${esc(s.notes || '')}</textarea></label>
      ${isNew ? '' : `<div><div class="row"><b class="grow">Leads they stock</b><button class="btn small" id="addLink">${icon('plus', 14)} Link a lead</button></div>
        <div class="table-wrap"><table class="data small"><tbody>${links.map((k) => { const l = data.leads.find((x) => x.id === k.leadId); if (!l) return ''; const e = leadEcon(l, k, data);
          return `<tr data-link="${esc(k.id)}" class="click"><td><span class="tag">${l.type === 'brand' ? 'Brand' : 'ASIN'}</span> ${esc(l.type === 'brand' ? l.brand : (l.title || l.asin).slice(0, 50))}${l.type === 'brand' && Object.keys(k.prices || {}).length ? `<div class="muted">${Object.keys(k.prices).length} product prices</div>` : ''}</td>
          <td class="r num">${k.cost !== '' && k.cost !== undefined && k.cost !== null ? money(Number(k.cost)) : ''}</td><td class="r num">${e?.profit !== undefined ? `<span class="${e.profit >= 0 ? 'pos' : 'neg'}">${money(e.profit)}</span> ${pct(e.roi)}` : ''}</td></tr>`; }).join('') || '<tr><td class="empty">No leads linked yet</td></tr>'}</tbody></table></div></div>`}
    </div>
    ${isNew ? '' : `<div class="stack">
      <div class="row"><b class="grow">Activity</b><button class="btn small primary" id="emailBtn" ${s.email ? '' : 'disabled title="Add an email address first"'}>${icon('mail', 14)} Email</button></div>
      <div class="row"><input id="noteIn" class="grow" placeholder="Add a note or call log…"><select id="noteKind"><option value="note">Note</option><option value="call">Call</option><option value="email">Email (sent elsewhere)</option><option value="order">Order</option></select><button class="btn small" id="addNote">Add</button></div>
      <div class="timeline">${acts.map((a) => `<div class="tl ${esc(a.kind)}"><div class="small muted">${new Date(a.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })} · ${esc({ email: 'Email', call: 'Call', note: 'Note', stage: 'Stage', order: 'Order' }[a.kind] || a.kind)}</div><div class="small">${esc(a.text)}</div></div>`).join('') || '<p class="small muted">Nothing yet.</p>'}</div>
    </div>`}
  </div>`;
  const collect = () => {
    const v = (id) => body.querySelector(`#s_${id}`).value.trim();
    return { ...s, company: v('company'), type: v('type'), contactName: v('contactName'), email: v('email'), phone: v('phone'), website: v('website'), accountNumber: v('accountNumber'), minOrder: v('minOrder'), stage: v('stage'), nextFollowUp: v('nextFollowUp'), notes: body.querySelector('#s_notes').value.trim() };
  };
  const save = async () => {
    const next = collect();
    if (!next.company) { toast('Give the supplier a company name', 'error'); return false; }
    if ((s0?.stage || 'to_contact') !== next.stage && !isNew) await logActivity(s.id, 'stage', `${STAGE_LABEL[s0?.stage || 'to_contact']} → ${STAGE_LABEL[next.stage]}`);
    await db.put('orSuppliers', next);
    return next;
  };
  const m = modal({
    title: isNew ? 'Add supplier' : s.company, wide: !isNew, body,
    actions: [
      ...(isNew ? [] : [{ label: 'Delete', kind: 'danger', onClick: async () => {
        if (!(await confirmBox(`Delete ${s.company}?`, 'Removes the supplier, its activity log and its links to leads. Leads stay.', { okLabel: 'Delete', danger: true }))) return false;
        await db.delMany('orLinks', links.map((k) => k.id)); await db.delMany('orActivity', acts.map((a) => a.id)); await db.del('orSuppliers', s.id);
        toast('Deleted'); rerender();
      } }]),
      { label: 'Cancel' },
      { label: 'Save', kind: 'primary', onClick: async () => { const r = await save(); if (r === false) return false; toast('Saved', 'success'); rerender(); } },
    ],
  });
  if (isNew) return m;
  body.querySelector('#addLink').onclick = async () => { const r = await save(); if (r === false) return; m.close(); linkModal({ supplier: r }, data, rerender); };
  body.querySelectorAll('[data-link]').forEach((tr) => { tr.onclick = async () => { const r = await save(); if (r === false) return; m.close(); const k = links.find((x) => x.id === tr.dataset.link); linkModal({ supplier: r, lead: data.leads.find((l) => l.id === k.leadId), link: k }, data, rerender); }; });
  body.querySelector('#emailBtn').onclick = async () => { const r = await save(); if (r === false) return; m.close(); compose(r, data, rerender); };
  body.querySelector('#addNote').onclick = async () => {
    const t = body.querySelector('#noteIn').value.trim(); if (!t) return;
    const kind = body.querySelector('#noteKind').value;
    const r = await save(); if (r === false) return;
    await logActivity(s.id, kind, t);
    if (kind === 'email' && (r.stage || 'to_contact') === 'to_contact') await db.put('orSuppliers', { ...r, stage: 'emailed', lastEmailAt: Date.now(), nextFollowUp: r.nextFollowUp || addDays(today(), Number(data.settings.followUpDays) || 5) });
    m.close(); await rerender();
    const fresh = await loadAll();
    openSupplier(fresh.suppliers.find((x) => x.id === s.id) || r, fresh, rerender);
  };
  return m;
}

// ---------------------------------------------------------------------------
// Composing an email from a template (opens your email app; logs it and sets the follow-up)
// ---------------------------------------------------------------------------
function templateContext(s, data) {
  const ls = data.links.filter((k) => k.supplierId === s.id).map((k) => ({ k, l: data.leads.find((x) => x.id === k.leadId) })).filter((x) => x.l);
  const brands = [...new Set(ls.map(({ l }) => l.brand).filter(Boolean))];
  const prods = [];
  for (const { k, l } of ls) {
    if (l.type === 'asin') prods.push(`• ${(l.title || l.asin).slice(0, 80)} (ASIN ${l.asin})`);
    else for (const asin of Object.keys(k.prices || {})) { const p = data.products.get(`2:${asin}`); prods.push(`• ${(p?.title || asin).slice(0, 80)} (ASIN ${asin})`); }
  }
  if (!prods.length) for (const b of brands) { const row = data.brandRows.find((x) => x.brandKey === brandKey(b)); for (const p of (row?.topProducts || []).slice(0, 3)) prods.push(`• ${p.title.slice(0, 80)} (ASIN ${p.asin})`); }
  const lastEmail = data.activity.filter((a) => a.supplierId === s.id && a.kind === 'email').sort((a, b) => b.at - a.at)[0];
  const st = data.settings;
  return {
    company: s.company, contact: s.contactName || '', contactFirst: (s.contactName || '').split(/\s+/)[0] || 'there',
    brand: brands[0] || 'your range', brands: brands.length ? (brands.length > 1 ? `${brands.slice(0, -1).join(', ')} and ${brands.at(-1)}` : brands[0]) : 'your range',
    products: prods.slice(0, 12).join('\n') || '• (your best-selling lines)', asins: ls.filter(({ l }) => l.asin).map(({ l }) => l.asin).join(', '),
    accountNumber: s.accountNumber || '', lastEmailDate: lastEmail ? new Date(lastEmail.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' }) : 'last week',
    today: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
    myName: st.myName, myCompany: st.myCompany, myEmail: st.myEmail, myPhone: st.myPhone, myWebsite: st.myWebsite,
  };
}

function compose(s, data, rerender, preferId = null) {
  if (!s?.email) return toast('Add an email address for this supplier first', 'error');
  const hasEmailed = data.activity.some((a) => a.supplierId === s.id && a.kind === 'email');
  let tplId = preferId || (hasEmailed ? 'tpl-followup' : (s.type === 'Brand / manufacturer' ? 'tpl-brand' : (s.stage === 'account' || s.stage === 'ordering' ? 'tpl-pricelist' : 'tpl-account')));
  if (!data.templates.some((t) => t.id === tplId)) tplId = data.templates[0]?.id;
  const ctx = templateContext(s, data);
  const body = document.createElement('div');
  const fill = () => {
    const t = data.templates.find((x) => x.id === body.querySelector('#tpl').value);
    body.querySelector('#subj').value = fillTemplate(t?.subject, ctx);
    body.querySelector('#msg').value = fillTemplate(t?.body, ctx);
    const missing = [...new Set([...`${t?.subject} ${t?.body}`.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).filter((k) => !ctx[k] && k !== 'accountNumber'))];
    body.querySelector('#miss').innerHTML = missing.length ? `Not filled in: ${missing.map((k) => `<code>{{${esc(k)}}}</code>`).join(' ')}${missing.some((k) => k.startsWith('my')) ? ' · add your details in <a href="#outreach/settings">Settings</a>' : ''}` : '';
  };
  body.innerHTML = `<div class="stack">
    <div class="form-grid"><label class="field">Template<select id="tpl">${data.templates.map((t) => `<option value="${esc(t.id)}" ${t.id === tplId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
      <label class="field">To<input value="${esc(s.email)}" readonly></label></div>
    <label class="field">Subject<input id="subj"></label>
    <label class="field">Message<textarea id="msg" rows="14"></textarea></label>
    <div class="small warn-text" id="miss"></div>
    <label class="check small"><input type="checkbox" id="log" checked> Log it, move ${esc(s.company)} to <b>Emailed</b> if it hasn't got further, and follow up in <input id="fud" type="number" min="1" max="60" value="${esc(data.settings.followUpDays || 5)}" style="width:56px"> days</label>
  </div>`;
  fill();
  body.querySelector('#tpl').onchange = fill;
  const record = async () => {
    if (!body.querySelector('#log').checked) return;
    const days = Math.max(1, Number(body.querySelector('#fud').value) || 5);
    const t = data.templates.find((x) => x.id === body.querySelector('#tpl').value);
    await logActivity(s.id, 'email', `${t?.name || 'Email'}: ${body.querySelector('#subj').value}`, { templateId: t?.id });
    const cur = (await db.get('orSuppliers', s.id)) || s;
    const stage = (cur.stage || 'to_contact') === 'to_contact' ? 'emailed' : cur.stage;
    if (stage !== (cur.stage || 'to_contact')) await logActivity(s.id, 'stage', `${STAGE_LABEL[cur.stage || 'to_contact']} → ${STAGE_LABEL[stage]}`);
    await db.put('orSuppliers', { ...cur, stage, lastEmailAt: Date.now(), nextFollowUp: addDays(today(), days) });
  };
  modal({
    title: `Email ${s.company}`, wide: true, body,
    actions: [
      { label: 'Cancel' },
      { label: 'Copy', onClick: async () => { await navigator.clipboard.writeText(`To: ${s.email}\nSubject: ${body.querySelector('#subj').value}\n\n${body.querySelector('#msg').value}`).catch(() => {}); await record(); toast('Copied. Paste it into your email.', 'success'); rerender(); } },
      { label: 'Open in email app', kind: 'primary', onClick: async () => {
        const href = `mailto:${encodeURIComponent(s.email)}?subject=${encodeURIComponent(body.querySelector('#subj').value)}&body=${encodeURIComponent(body.querySelector('#msg').value)}`;
        await record();
        window.location.href = href;
        rerender();
      } },
    ],
  });
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------
function renderTemplates(body, data, rerender) {
  body.innerHTML = `<div class="grid2">
    <div class="card"><div class="toolbar"><b>${data.templates.length} templates</b><span class="grow"></span><button class="btn small" id="reset">Restore the standard ones</button><button class="btn small primary" id="new">${icon('plus', 14)} New</button></div>
      <table class="data"><tbody>${data.templates.map((t) => `<tr data-tid="${esc(t.id)}" class="click ${ui.tpl === t.id ? 'hit' : ''}"><td><b>${esc(t.name)}</b><div class="small muted">${esc(t.subject)}</div></td></tr>`).join('')}</tbody></table></div>
    <div class="card card-pad stack" id="ed">${(() => {
      const t = data.templates.find((x) => x.id === ui.tpl);
      if (!t) return `<p class="small muted">Pick a template to edit, or make a new one.</p><h4>Placeholders</h4><table class="data small"><tbody>${PLACEHOLDERS.map(([k, l]) => `<tr><td class="mono">{{${k}}}</td><td>${esc(l)}</td></tr>`).join('')}</tbody></table>`;
      return `<label class="field">Name<input id="tn" value="${esc(t.name)}"></label><label class="field">Subject<input id="ts" value="${esc(t.subject)}"></label><label class="field">Message<textarea id="tb" rows="16">${esc(t.body)}</textarea></label>
        <p class="small muted">Placeholders: ${PLACEHOLDERS.map(([k, l]) => `<code title="${esc(l)}">{{${k}}}</code>`).join(' ')}</p>
        <div class="row"><button class="btn primary" id="sv">${icon('check')} Save</button><button class="btn danger" id="dl">Delete</button></div>`;
    })()}</div></div>`;
  body.querySelectorAll('[data-tid]').forEach((tr) => { tr.onclick = () => { ui.tpl = tr.dataset.tid; rerender(); }; });
  body.querySelector('#new').onclick = async () => { const t = { id: newId('tpl'), name: 'New template', subject: '', body: 'Hi {{contactFirst}},\n\n\n\nThanks,\n{{myName}}\n{{myCompany}}' }; await db.put('orTemplates', t); ui.tpl = t.id; rerender(); };
  body.querySelector('#reset').onclick = async () => {
    if (!(await confirmBox('Restore the standard templates?', 'Puts back the four standard templates as they came. Templates you made yourself are kept.', { okLabel: 'Restore' }))) return;
    await db.putMany('orTemplates', DEFAULT_TEMPLATES.map((t) => ({ ...t, isDefault: true }))); rerender();
  };
  const sv = body.querySelector('#sv');
  if (sv) {
    sv.onclick = async () => { const t = data.templates.find((x) => x.id === ui.tpl); await db.put('orTemplates', { ...t, name: body.querySelector('#tn').value.trim() || 'Untitled', subject: body.querySelector('#ts').value, body: body.querySelector('#tb').value }); toast('Saved', 'success'); rerender(); };
    body.querySelector('#dl').onclick = async () => { if (!(await confirmBox('Delete this template?', 'Emails already sent with it stay in the activity log.', { okLabel: 'Delete', danger: true }))) return; await db.del('orTemplates', ui.tpl); ui.tpl = null; rerender(); };
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function renderSettings(body, data, rerender) {
  const s = data.settings;
  const f = (id, label, type = 'text', step = '', hint = '') => `<label class="field">${label}<input id="o_${id}" type="${type}" ${step ? `step="${step}"` : ''} value="${esc(s[id] ?? '')}">${hint ? `<span class="hint">${hint}</span>` : ''}</label>`;
  body.innerHTML = `<div class="grid2">
    <div class="card card-pad stack"><h3>${icon('mail')} Your details (for emails)</h3>
      <div class="form-grid">${f('myName', 'Your name')}${f('myCompany', 'Company')}${f('myEmail', 'Email', 'email')}${f('myPhone', 'Phone', 'tel')}${f('myWebsite', 'Website', 'url')}${f('followUpDays', 'Follow up after (days)', 'number', '1')}</div></div>
    <div class="card card-pad stack"><h3>${icon('pound')} Profit &amp; ROI at the supplier's price</h3>
      <div class="form-grid">
        <label class="field">Target ROI %<input id="o_targetRoi" type="number" step="1" value="${esc(Math.round((Number(s.targetRoi) || 0) * 100))}"><span class="hint">sets the "max buy" price</span></label>
        ${f('prepPerUnit', 'Prep per unit £', 'number', '0.01')}${f('inboundPerUnit', 'Shipping to Amazon per unit £', 'number', '0.01')}
        ${f('defaultFbaFee', 'FBA fee if Keepa has none £', 'number', '0.01')}
        <label class="field">Referral fee if Keepa has none %<input id="o_defaultReferralPct" type="number" step="0.5" value="${esc(Math.round((Number(s.defaultReferralPct) || 0) * 1000) / 10)}"></label>
      </div>
      <label class="check"><input type="checkbox" id="o_vat" ${s.supplierPricesIncVat ? 'checked' : ''}> Supplier prices I enter include VAT (wholesale price lists usually don't)</label>
      <p class="small muted">VAT: you're set as <b>${data.vatRegistered ? 'VAT registered' : 'not VAT registered'}</b> (FBA Admin → Settings). ${data.vatRegistered ? 'Sales are counted ex VAT and the VAT on stock and Amazon fees is reclaimed.' : 'Sales are counted at the full price, and VAT on stock and on Amazon\'s fees is a cost.'}</p></div>
  </div>
  <div class="row section" style="justify-content:flex-end"><button class="btn primary" id="save">${icon('check')} Save</button></div>`;
  body.querySelector('#save').onclick = async () => {
    const v = (id) => body.querySelector(`#o_${id}`).value.trim();
    await saveSettings({ myName: v('myName'), myCompany: v('myCompany'), myEmail: v('myEmail'), myPhone: v('myPhone'), myWebsite: v('myWebsite'), followUpDays: Math.max(1, Number(v('followUpDays')) || 5),
      targetRoi: (Number(v('targetRoi')) || 0) / 100, prepPerUnit: Number(v('prepPerUnit')) || 0, inboundPerUnit: Number(v('inboundPerUnit')) || 0, defaultFbaFee: Number(v('defaultFbaFee')) || 0, defaultReferralPct: (Number(v('defaultReferralPct')) || 0) / 100, supplierPricesIncVat: body.querySelector('#o_vat').checked });
    toast('Saved', 'success'); rerender();
  };
}
