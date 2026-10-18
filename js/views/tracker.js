// Storefront tracker: new-products feed and tracked storefronts (with CSV export / import).
import * as db from '../db.js';
import {
  getSettings, addSeller, removeSeller, refreshSellers, getProducts, cachedProducts, cancelKeepa, isDemo, sellerKey,
  storefrontRows, STOREFRONT_CSV_HEADER, parseStorefrontImport,
} from '../services.js';
import { DEMO_SELLERS } from '../keepa.js';
import { icon, toast, modal, confirmBox, productCell, priceCell, bsrCell, offersCell, sortable, progressUI, emptyState } from '../ui.js';
import { readTabularFile } from '../xlsx.js';
import { parseAmazonLink, handleAmazonLink, readClipboard } from '../links.js';
import {
  esc, num, ago, dateTimeStr, MARKETS, MARKET_IDS, parseSellerInput, storefrontUrl, sellerProfileUrl, toCSV, downloadFile, amazonUrl, startOfDay,
} from '../util.js';

const state = { period: '7', seller: '', q: '', minPrice: '', maxPrice: '', maxBsr: '', hideReviewed: true, multiOnly: false, dropped: false, limit: 200 };

export async function render(root, ctx) {
  const tab = ctx.tab || 'new';
  const sellers = await db.getAll('sellers');
  const items = await db.getAll('items');
  const newCount = items.filter((i) => !i.baseline && !i.reviewed && !i.removedAt).length;
  const lastFull = await db.kvGet('lastFullRefresh');
  const due = lastFull && Date.now() - lastFull > 20 * 3600e3;

  root.innerHTML = `
    <div class="card card-pad">
      <div class="row spread">
        <form class="row grow" id="addForm" autocomplete="off">
          ${navigator.clipboard?.readText ? `<button class="btn" type="button" id="pasteLink" title="Paste an Amazon storefront, seller or product link">${icon('clip')} Paste link</button>` : ''}
          <input type="text" id="addInput" class="grow" style="min-width:200px" placeholder="Seller ID, storefront link, or a product link (adds a lead)">
          <select id="addDomain" aria-label="Marketplace">${MARKET_IDS.map((d) => `<option value="${d}">${MARKETS[d].code}</option>`).join('')}</select>
          <button class="btn" type="submit">${icon('plus')} Track storefront</button>
        </form>
        <div class="row">
          <span class="small ${due ? 'badge demo' : 'muted'}" title="${lastFull ? dateTimeStr(lastFull) : ''}">Last refresh: <b>${lastFull ? ago(lastFull) : 'never'}</b>${due ? ' · due' : ''}</span>
          <button class="btn primary" id="refreshAll" ${sellers.length ? '' : 'disabled'}>${icon('refresh')} Refresh all <span class="small" style="opacity:.8">≈${num(sellers.length * 10)} tokens + new products</span></button>
        </div>
      </div>
    </div>
    <div id="trkProgress" class="section"></div>
    <div class="tabs section">
      <a class="tab ${tab === 'new' ? 'active' : ''}" href="#tracker/new">New products${newCount ? `<span class="count">${newCount}</span>` : ''}</a>
      <a class="tab ${tab === 'storefronts' ? 'active' : ''}" href="#tracker/storefronts">Storefronts<span class="count">${sellers.length}</span></a>
    </div>
    <div id="trkBody"></div>`;

  const body = root.querySelector('#trkBody');
  const progressEl = root.querySelector('#trkProgress');
  const rerender = () => render(root, ctx);

  const paste = root.querySelector('#pasteLink');
  if (paste) paste.onclick = async () => { const t = await readClipboard(); if (t) { root.querySelector('#addInput').value = t.trim(); root.querySelector('#addForm').requestSubmit(); } };
  root.querySelector('#addForm').onsubmit = async (e) => {
    e.preventDefault();
    const raw = root.querySelector('#addInput').value;
    // a product link (or a short amzn.eu link) goes to outreach leads / gets explained
    const link = parseAmazonLink(raw);
    if (link && link.kind !== 'seller') { root.querySelector('#addInput').value = ''; await handleAmazonLink(raw, { navigate: ctx.navigate }); return; }
    const parsed = parseSellerInput(raw);
    if (!parsed) return toast('Could not find a seller ID in that — it starts with "A" and is 10–21 characters.', 'error');
    const domain = parsed.domain || Number(root.querySelector('#addDomain').value);
    const { existed } = await addSeller(parsed.sellerId, domain, { source: 'manual' });
    if (existed) return toast('You are already tracking that storefront');
    root.querySelector('#addInput').value = '';
    await runRefresh([sellerKey(domain, parsed.sellerId)], progressEl, { fetchDetails: false, label: 'Importing storefront' });
    if (location.hash === '#tracker/storefronts') rerender(); else ctx.navigate('tracker/storefronts');
  };

  root.querySelector('#refreshAll').onclick = async () => {
    const all = await db.getAll('sellers');
    const res = await runRefresh(all.map((s) => s.key), progressEl, { fetchDetails: true, full: true, label: 'Refreshing storefronts' });
    if (res) { state.hideReviewed = true; if (tab === 'new') rerender(); else ctx.navigate('tracker/new'); }
  };

  window.addEventListener('nt:data', rerender);

  if (tab === 'storefronts') await renderStorefronts(body, { sellers, items, ctx, rerender, progressEl });
  else await renderNew(body, { sellers, items, ctx, rerender, progressEl });
  return () => window.removeEventListener('nt:data', rerender);
}

async function runRefresh(keys, progressEl, { fetchDetails, full = false, label }) {
  const p = progressUI(progressEl);
  p.onCancel(() => cancelKeepa());
  p.set(0, `${label}…`);
  try {
    const res = await refreshSellers(keys, { fetchDetails, full, onProgress: (f, m) => p.set(f, m) });
    p.done();
    const parts = [`${res.sellers} storefront${res.sellers === 1 ? '' : 's'} refreshed`, `${res.newItems.length} new product${res.newItems.length === 1 ? '' : 's'}`];
    if (res.removed) parts.push(`${res.removed} dropped`);
    if (res.tokensUsed) parts.push(`${num(res.tokensUsed)} tokens used`);
    toast(parts.join(' · '), 'success', 6000);
    if (res.errors.length) toast(`${res.errors.length} failed: ${res.errors.map((e) => `${e.seller} (${e.error})`).join('; ')}`, 'error', 9000);
    return res;
  } catch (e) {
    p.done();
    const cancelled = e.message === 'Cancelled';
    toast(cancelled ? 'Refresh cancelled — anything already fetched has been saved.' : e.message, cancelled ? 'info' : 'error', 7000);
    return null;
  }
}

// ---------------------------------------------------------------------------
// New products feed
// ---------------------------------------------------------------------------
async function renderNew(body, { sellers, items, ctx, rerender, progressEl }) {
  if (!sellers.length) {
    const demo = isDemo(await getSettings());
    body.innerHTML = emptyState('store', 'No storefronts tracked yet',
      'Paste a competitor\'s seller ID or storefront link above, import a list on the <a href="#tracker/storefronts">Storefronts</a> tab, or click <b>＋ Track seller</b> on any Amazon storefront page.',
      demo ? '<button class="btn primary" id="loadDemo">Load demo storefronts</button><p class="small" style="margin-top:10px">Demo mode: adds 3 made-up storefronts and runs two refreshes so you can see new products appear.</p>' : '');
    const ld = body.querySelector('#loadDemo');
    if (ld) ld.onclick = async () => {
      ld.disabled = true;
      const keys = [];
      for (const [id] of DEMO_SELLERS.slice(0, 3)) { await addSeller(id, 2, { source: 'manual' }); keys.push(sellerKey(2, id)); }
      await runRefresh(keys, progressEl, { fetchDetails: false, label: 'Importing demo storefronts' });
      await runRefresh(keys, progressEl, { fetchDetails: true, full: true, label: 'Simulating the next day\'s refresh' });
      rerender();
    };
    return;
  }
  const sellerMap = new Map(sellers.map((s) => [s.key, s]));
  // how many tracked storefronts currently list each product
  const listedBy = new Map();
  for (const it of items) {
    if (it.removedAt) continue;
    if (!listedBy.has(it.pkey)) listedBy.set(it.pkey, new Set());
    listedBy.get(it.pkey).add(it.sellerKey);
  }

  body.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <select id="fPeriod" aria-label="Period">
          ${[['1', 'Last 24 hours'], ['3', 'Last 3 days'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['all', 'All time']].map(([v, l]) => `<option value="${v}" ${state.period === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <select id="fSeller" aria-label="Storefront"><option value="">All storefronts</option>${sellers.map((s) => `<option value="${esc(s.key)}" ${state.seller === s.key ? 'selected' : ''}>${esc(s.name || s.sellerId)}</option>`).join('')}</select>
        <input type="search" id="fQ" placeholder="Search title, brand, ASIN" value="${esc(state.q)}" style="width:190px">
        <input type="number" id="fMin" placeholder="Min £" value="${esc(state.minPrice)}" style="width:80px" step="0.01">
        <input type="number" id="fMax" placeholder="Max £" value="${esc(state.maxPrice)}" style="width:80px" step="0.01">
        <input type="number" id="fBsr" placeholder="Max BSR" value="${esc(state.maxBsr)}" style="width:100px">
        <span class="sep"></span>
        <label class="check small"><input type="checkbox" id="fHide" ${state.hideReviewed ? 'checked' : ''}> Hide reviewed</label>
        <label class="check small" title="Products listed by 2 or more of your tracked storefronts"><input type="checkbox" id="fMulti" ${state.multiOnly ? 'checked' : ''}> In 2+ storefronts</label>
        <label class="check small" title="Products that disappeared from a storefront (sold out or delisted)"><input type="checkbox" id="fDropped" ${state.dropped ? 'checked' : ''}> Show dropped instead</label>
      </div>
      <div class="toolbar">
        <span id="feedCount" class="small muted"></span>
        <span class="grow"></span>
        <button class="btn small" id="loadDetails">${icon('download', 14)} Load missing details</button>
        <button class="btn small" id="markAll">${icon('check', 14)} Mark shown as reviewed</button>
        <button class="btn small" id="exportCsv">${icon('download', 14)} Export CSV</button>
      </div>
      <div class="table-wrap"><table class="data" id="feed">
        <thead><tr>
          <th>Product</th><th>Storefront(s)</th>
          <th data-sort="price" class="r">Price</th><th data-sort="bsr" data-first="asc" class="r">BSR</th>
          <th data-sort="offers" data-first="asc" class="r">Offers</th><th data-sort="firstSeen">Spotted</th><th></th>
        </tr></thead><tbody></tbody></table></div>
      <div id="moreWrap" class="toolbar" hidden><button class="btn small" id="more">Show more</button></div>
    </div>`;

  const productsCache = new Map((await db.getAll('products')).map((p) => [p.key, p]));

  function buildRows() {
    const since = state.period === 'all' ? 0 : (state.period === '1' ? Date.now() - 86400e3 : startOfDay() - (Number(state.period) - 1) * 86400e3);
    const groups = new Map();
    for (const it of items) {
      if (state.dropped) {
        if (!it.removedAt || it.removedAt < since) continue;
      } else if (it.baseline || it.removedAt || it.firstSeen < since) continue;
      if (state.seller && it.sellerKey !== state.seller) continue;
      let g = groups.get(it.pkey);
      if (!g) {
        g = { pkey: it.pkey, asin: it.asin, domain: it.domain, items: [], firstSeen: Infinity, reviewed: true, relisted: false };
        groups.set(it.pkey, g);
      }
      g.items.push(it);
      g.firstSeen = Math.min(g.firstSeen, state.dropped ? it.removedAt : it.firstSeen);
      g.reviewed = g.reviewed && !!it.reviewed;
      g.relisted = g.relisted || !!it.relisted;
    }
    const q = state.q.trim().toLowerCase();
    const out = [];
    for (const g of groups.values()) {
      const p = productsCache.get(g.pkey) || null;
      g.product = p;
      g.price = p?.price ?? null;
      g.bsr = p?.bsr ?? null;
      g.offers = p?.offerCount ?? null;
      g.listedBy = listedBy.get(g.pkey)?.size || 0;
      if (state.hideReviewed && !state.dropped && g.reviewed) continue;
      if (state.multiOnly && g.listedBy < 2) continue;
      if (q && !(`${g.asin} ${p?.title || ''} ${p?.brand || ''}`.toLowerCase().includes(q))) continue;
      if (state.minPrice !== '' && (g.price === null || g.price < Number(state.minPrice))) continue;
      if (state.maxPrice !== '' && (g.price === null || g.price > Number(state.maxPrice))) continue;
      if (state.maxBsr !== '' && (g.bsr === null || g.bsr > Number(state.maxBsr))) continue;
      out.push(g);
    }
    return out;
  }

  let rows = buildRows();
  let shown = [];

  const rowHtml = (g) => {
    const names = g.items.map((it) => sellerMap.get(it.sellerKey)).filter(Boolean)
      .map((s) => `<span class="chip" title="${esc(s.sellerId)}">${esc(s.name || s.sellerId)}</span>`).join('');
    const hot = g.listedBy >= 2 ? `<span class="tag hot" title="Listed by ${g.listedBy} of your tracked storefronts">🔥 ${g.listedBy} sellers</span>` : '';
    const flag = state.dropped ? '<span class="tag gone">Dropped</span>' : (g.relisted ? '<span class="tag">Re-listed</span>' : (!g.reviewed ? '<span class="tag new">New</span>' : ''));
    return `<tr class="${g.reviewed && !state.dropped ? 'reviewed' : ''}" data-pkey="${esc(g.pkey)}">
      <td>${productCell(g.product, { asin: g.asin, domain: g.domain, extra: ` ${flag} ${hot}` })}</td>
      <td><div class="chips">${names}</div></td>
      <td class="r">${priceCell(g.product)}</td>
      <td class="r">${bsrCell(g.product)}</td>
      <td class="r">${offersCell(g.product)}</td>
      <td class="small nowrap">${ago(g.firstSeen)}<div class="muted">${dateTimeStr(g.firstSeen)}</div></td>
      <td class="nowrap">${state.dropped ? '' : `<button class="icon-btn" data-act="review" title="${g.reviewed ? 'Mark as not reviewed' : 'Mark as reviewed'}">${icon(g.reviewed ? 'eye' : 'check')}</button>`}<button class="icon-btn" data-act="lead" title="Add to outreach leads (find a supplier for it)">${icon('users')}</button></td></tr>`;
  };

  const table = body.querySelector('#feed');
  const sorter = sortable(table, rows.slice(0, state.limit), rowHtml, {
    defaultKey: 'firstSeen', defaultDir: 'desc',
    onSort: (sorted) => { shown = sorted; },
  });
  const updateCount = () => {
    const missing = rows.filter((r) => !r.product).length;
    body.querySelector('#feedCount').textContent = `${num(rows.length)} product${rows.length === 1 ? '' : 's'}${missing ? ` · ${missing} without details` : ''}`;
    body.querySelector('#moreWrap').hidden = rows.length <= state.limit;
    body.querySelector('#loadDetails').hidden = !missing;
  };
  const redraw = () => { rows = buildRows(); sorter.redraw(rows.slice(0, state.limit)); updateCount(); };
  updateCount();

  const bind = (id, key, ev = 'change', fn = (el) => el.value) => {
    body.querySelector(id).addEventListener(ev, (e) => { state[key] = fn(e.target); state.limit = 200; redraw(); });
  };
  bind('#fPeriod', 'period'); bind('#fSeller', 'seller'); bind('#fQ', 'q', 'input');
  bind('#fMin', 'minPrice', 'input'); bind('#fMax', 'maxPrice', 'input'); bind('#fBsr', 'maxBsr', 'input');
  bind('#fHide', 'hideReviewed', 'change', (el) => el.checked);
  bind('#fMulti', 'multiOnly', 'change', (el) => el.checked);
  bind('#fDropped', 'dropped', 'change', (el) => el.checked);
  body.querySelector('#more').onclick = () => { state.limit += 200; redraw(); };

  body.querySelector('#markAll').onclick = async () => {
    const pk = new Set(shown.map((g) => g.pkey));
    const upd = items.filter((it) => pk.has(it.pkey) && !it.reviewed).map((it) => ({ ...it, reviewed: true }));
    await db.putMany('items', upd);
    for (const u of upd) Object.assign(items.find((i) => i.key === u.key), u);
    redraw(); ctx.refreshBadges();
    toast(`Marked ${pk.size} product${pk.size === 1 ? '' : 's'} as reviewed`);
  };

  body.querySelector('#loadDetails').onclick = async () => {
    const byDomain = {};
    for (const r of rows.filter((x) => !x.product)) (byDomain[r.domain] ||= []).push(r.asin);
    const p = progressUI(progressEl);
    p.onCancel(() => cancelKeepa());
    try {
      for (const [d, asins] of Object.entries(byDomain)) {
        const got = await getProducts(Number(d), asins, { onProgress: (x, t) => p.set(x / t, `Loading details ${x}/${t} (≈1 token each)`) });
        for (const v of got.values()) productsCache.set(v.key, v);
      }
      p.done(); redraw();
    } catch (e) { p.done(); toast(e.message, 'error'); }
  };

  body.querySelector('#exportCsv').onclick = () => {
    const out = [['ASIN', 'Marketplace', 'Title', 'Brand', 'Category', 'Price', 'BSR', 'Monthly sold', 'Offers', 'Amazon selling', 'Storefronts', 'Listed by (tracked)', state.dropped ? 'Dropped' : 'Spotted', 'Amazon link']];
    for (const g of rows) {
      const p = g.product || {};
      out.push([g.asin, MARKETS[g.domain]?.code, p.title, p.brand, p.category, p.price, p.bsr, p.monthlySold, p.offerCount, p.amazonOnListing ? 'yes' : 'no',
        g.items.map((it) => sellerMap.get(it.sellerKey)?.name || it.sellerKey).join(' | '), g.listedBy, new Date(g.firstSeen).toISOString().replace('T', ' ').slice(0, 16), amazonUrl(g.domain, g.asin)]);
    }
    downloadFile(`new-products-${new Date().toISOString().slice(0, 10)}.csv`, toCSV(out));
  };

  table.addEventListener('click', async (e) => {
    const lb = e.target.closest('button[data-act=lead]');
    if (lb) {
      const g = rows.find((r) => r.pkey === lb.closest('tr').dataset.pkey);
      if (g) leadPicker(g);
      return;
    }
    const btn = e.target.closest('button[data-act=review]');
    if (!btn) return;
    const g = rows.find((r) => r.pkey === btn.closest('tr').dataset.pkey);
    if (!g) return;
    const val = !g.reviewed;
    const upd = g.items.map((it) => ({ ...it, reviewed: val }));
    await db.putMany('items', upd);
    for (const u of upd) Object.assign(items.find((i) => i.key === u.key), u);
    redraw(); ctx.refreshBadges();
  });
}

// "＋ Lead": add the product, or its brand, to Retailer & wholesaler outreach.
function leadPicker(g) {
  const p = g.product;
  const add = async (lead) => {
    const { addLead } = await import('./outreach.js');
    await addLead(lead);
    toast(`${lead.type === 'brand' ? lead.brand : 'Product'} added to outreach leads`, 'success');
  };
  modal({
    title: 'Add to outreach leads',
    body: `<p class="small">Find a supplier for this product, or for the whole brand. Leads are ranked and linked to suppliers in <a href="#outreach/leads">Outreach</a>.</p><p><b>${esc(p?.title || g.asin)}</b><br><span class="small muted mono">${esc(g.asin)}</span>${p?.brand ? ` <span class="small muted">· ${esc(p.brand)}</span>` : ''}</p>`,
    actions: [
      { label: 'Cancel' },
      { label: 'This product', onClick: () => add({ type: 'asin', asin: g.asin, domain: g.domain, brand: p?.brand || '', title: p?.title || '' }) },
      ...(p?.brand ? [{ label: `The brand: ${p.brand.slice(0, 24)}`, kind: 'primary', onClick: () => add({ type: 'brand', brand: p.brand }) }] : []),
    ],
  });
}

// ---------------------------------------------------------------------------
// Storefronts
// ---------------------------------------------------------------------------
async function renderStorefronts(body, { sellers, items, ctx, rerender, progressEl }) {
  const bySeller = new Map();
  const wk = Date.now() - 7 * 86400e3;
  for (const it of items) {
    if (!bySeller.has(it.sellerKey)) bySeller.set(it.sellerKey, { total: 0, new7: 0, dropped7: 0, unreviewed: 0 });
    const c = bySeller.get(it.sellerKey);
    if (!it.removedAt) c.total++;
    if (!it.baseline && it.firstSeen > wk && !it.removedAt) c.new7++;
    if (it.removedAt && it.removedAt > wk) c.dropped7++;
    if (!it.baseline && !it.reviewed && !it.removedAt) c.unreviewed++;
  }
  let sortBy = 'new';
  let q = '';
  const selected = new Set();

  body.innerHTML = `
    <div class="row spread" style="margin-bottom:12px">
      <div class="row">
        <input type="search" id="sQ" placeholder="Search storefronts" style="width:200px">
        <select id="sSort" aria-label="Sort"><option value="new">Most new (7 days)</option><option value="name">Name</option><option value="asins">Most products</option><option value="refresh">Least recently refreshed</option></select>
      </div>
      <div class="row">
        <span class="small muted" id="selCount"></span>
        <button class="btn" id="shared" disabled title="Products that 2+ of the selected storefronts all sell">${icon('list')} Shared products</button>
        <span class="sep"></span>
        <label class="btn" title="Bulk-add storefronts from a CSV or Excel file">${icon('upload')} Import CSV<input type="file" id="impFile" accept=".csv,.txt,.xlsx" hidden></label>
        <button class="btn" id="expCsv" ${sellers.length ? '' : 'disabled'} title="One row per storefront">${icon('download')} Export CSV</button>
      </div>
    </div>
    <div class="seller-grid" id="grid"></div>`;

  body.querySelector('#impFile').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importStorefronts(f, { progressEl, rerender }); };
  body.querySelector('#expCsv').onclick = async () => {
    const rows = await storefrontRows();
    downloadFile(`tracked-storefronts-${new Date().toISOString().slice(0, 10)}.csv`, toCSV([STOREFRONT_CSV_HEADER, ...rows]));
    toast(`Exported ${rows.length} storefront${rows.length === 1 ? '' : 's'}`);
  };

  const grid = body.querySelector('#grid');
  if (!sellers.length) {
    grid.outerHTML = emptyState('store', 'No storefronts yet', 'Add one with the box above, import a CSV of seller IDs or storefront links, or open any Amazon storefront and click <b>＋ Track seller</b> in the bottom-right corner.');
    return;
  }

  const draw = () => {
    const list = sellers.filter((s) => !q || `${s.name} ${s.sellerId} ${s.note || ''}`.toLowerCase().includes(q));
    list.sort((a, b) => {
      if (sortBy === 'name') return (a.name || a.sellerId).localeCompare(b.name || b.sellerId);
      if (sortBy === 'asins') return (b.asinCount || 0) - (a.asinCount || 0);
      if (sortBy === 'refresh') return (a.lastRefresh || 0) - (b.lastRefresh || 0);
      return (bySeller.get(b.key)?.new7 || 0) - (bySeller.get(a.key)?.new7 || 0);
    });
    grid.innerHTML = list.map((s) => {
      const c = bySeller.get(s.key) || { total: 0, new7: 0, dropped7: 0, unreviewed: 0 };
      const status = s.status === 'pending' ? '<span class="badge">Not imported yet</span>'
        : s.status === 'error' ? `<span class="badge err" title="${esc(s.error || '')}">Error</span>` : '';
      return `<div class="card seller-card" data-key="${esc(s.key)}">
        <div class="row spread" style="flex-wrap:nowrap">
          <h4><label class="check"><input type="checkbox" data-sel ${selected.has(s.key) ? 'checked' : ''} aria-label="Select"></label>
            <a href="${storefrontUrl(s.domain, s.sellerId)}" target="_blank" rel="noopener">${esc(s.name || s.sellerId)}</a></h4>
          <span class="tag">${MARKETS[s.domain]?.code || s.domain}</span>
        </div>
        <div class="row small muted" style="gap:6px"><span class="mono">${esc(s.sellerId)}</span>${status}</div>
        <div class="stat-line">
          <span><b>${num(s.asinCount || c.total)}</b> products</span>
          <span><b class="${c.new7 ? 'pos' : ''}">${num(c.new7)}</b> new (7d)</span>
          <span><b>${num(c.dropped7)}</b> dropped (7d)</span>
        </div>
        <div class="stat-line">
          <span>Last refresh <b>${ago(s.lastRefresh)}</b>${s.lastRefresh ? ` (+${s.lastNew || 0})` : ''}</span>
          ${s.rating !== null && s.rating !== undefined ? `<span>Rating <b>${s.rating}%</b>${s.ratingCount ? ` (${num(s.ratingCount)})` : ''}</span>` : ''}
        </div>
        ${s.status === 'error' ? `<div class="small neg">${esc(s.error || '')}</div>` : ''}
        ${s.note ? `<div class="small">${esc(s.note)}</div>` : ''}
        <div class="row" style="gap:6px;margin-top:2px">
          <button class="btn small" data-act="products">${icon('list', 14)} Products${c.unreviewed ? ` <span class="badge new">${c.unreviewed} new</span>` : ''}</button>
          <button class="btn small" data-act="refresh" title="≈10 tokens">${icon('refresh', 14)} Refresh</button>
          <a class="btn small ghost" href="${sellerProfileUrl(s.domain, s.sellerId)}" target="_blank" rel="noopener" title="Seller profile on Amazon">${icon('external', 14)}</a>
          <button class="btn small ghost" data-act="note" title="Add a note">✎</button>
          <button class="btn small ghost danger" data-act="remove" title="Stop tracking">${icon('trash', 14)}</button>
        </div>
      </div>`;
    }).join('') || '<div class="muted">No matches</div>';
  };
  draw();

  const selCount = body.querySelector('#selCount');
  const sharedBtn = body.querySelector('#shared');
  const updSel = () => { selCount.textContent = selected.size ? `${selected.size} selected` : 'Tick 2+ to compare'; sharedBtn.disabled = selected.size < 2; };
  updSel();

  body.querySelector('#sQ').oninput = (e) => { q = e.target.value.toLowerCase(); draw(); };
  body.querySelector('#sSort').onchange = (e) => { sortBy = e.target.value; draw(); };

  grid.addEventListener('change', (e) => {
    if (!e.target.matches('[data-sel]')) return;
    const key = e.target.closest('[data-key]').dataset.key;
    if (e.target.checked) selected.add(key); else selected.delete(key);
    updSel();
  });

  grid.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const key = btn.closest('[data-key]').dataset.key;
    const s = sellers.find((x) => x.key === key);
    const act = btn.dataset.act;
    if (act === 'refresh') {
      if (await runRefresh([key], progressEl, { fetchDetails: true, label: `Refreshing ${s.name || s.sellerId}` })) rerender();
    } else if (act === 'remove') {
      if (await confirmBox('Stop tracking?', `Remove ${s.name || s.sellerId} and its product history?`, { okLabel: 'Remove', danger: true })) {
        await removeSeller(key);
        rerender(); ctx.refreshBadges();
      }
    } else if (act === 'note') {
      const m = modal({
        title: 'Storefront note',
        body: `<textarea id="noteTxt" rows="3" placeholder="e.g. Sources from B&M / Home Bargains, mostly toys">${esc(s.note || '')}</textarea>`,
        actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: async (el) => { await db.put('sellers', { ...s, note: el.querySelector('#noteTxt').value.trim() }); rerender(); } }],
      });
      m.body.querySelector('textarea').focus();
    } else if (act === 'products') {
      showSellerProducts(s, items.filter((it) => it.sellerKey === key));
    }
  });

  sharedBtn.onclick = () => showShared([...selected].map((k) => sellers.find((s) => s.key === k)), items);
}

async function importStorefronts(file, { progressEl, rerender }) {
  let rows;
  try { rows = await readTabularFile(file); } catch (e) { return toast(e.message, 'error', 7000); }
  const found = parseStorefrontImport(rows, 2);
  if (!found.length) return toast('No seller IDs or storefront links found in that file', 'error', 7000);
  const existing = new Set((await db.getAll('sellers')).map((s) => s.key));
  const fresh = found.filter((f) => !existing.has(f.key));
  const dupes = found.length - fresh.length;
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <p>Found <b>${found.length}</b> storefront${found.length === 1 ? '' : 's'} in <b>${esc(file.name)}</b>.
      ${fresh.length ? `<b class="pos">${fresh.length} new</b>` : 'None are new'}${dupes ? ` · ${dupes} already tracked (skipped)` : ''}.</p>
    ${fresh.length ? `<div class="table-wrap" style="max-height:300px"><table class="data"><thead><tr><th>Seller ID</th><th>Name</th><th>Market</th><th>Note</th></tr></thead><tbody>
      ${fresh.slice(0, 200).map((f) => `<tr><td class="mono">${esc(f.sellerId)}</td><td>${esc(f.name)}</td><td>${MARKETS[f.domain]?.code}</td><td class="small">${esc(f.note)}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="small muted" style="margin-top:10px">Importing pulls each storefront from Keepa: about <b>${num(fresh.length * 10)} tokens</b>. If you run low, it waits for tokens to refill and carries on.</p>` : ''}`;
  modal({
    title: 'Import storefronts',
    body: wrap,
    actions: fresh.length ? [
      { label: 'Cancel' },
      { label: 'Add without importing', onClick: async () => { for (const f of fresh) await addSeller(f.sellerId, f.domain, { name: f.name, note: f.note }); toast(`Added ${fresh.length} — they'll import on your next Refresh all`); rerender(); } },
      {
        label: `Add & import ${fresh.length}`, kind: 'primary', onClick: async () => {
          for (const f of fresh) await addSeller(f.sellerId, f.domain, { name: f.name, note: f.note });
          await runRefresh(fresh.map((f) => f.key), progressEl, { fetchDetails: false, label: 'Importing storefronts' });
          rerender();
        },
      },
    ] : [{ label: 'Close' }],
  });
}

async function showSellerProducts(seller, sItems) {
  let filter = sItems.some((i) => !i.baseline && !i.removedAt) ? 'new' : 'all';
  const wrap = document.createElement('div');
  modal({ title: `${seller.name || seller.sellerId} — products`, body: wrap, wide: true });
  const draw = async () => {
    const list = sItems.filter((i) => (filter === 'new' ? !i.baseline && !i.removedAt : filter === 'dropped' ? !!i.removedAt : !i.removedAt));
    list.sort((a, b) => (filter === 'dropped' ? b.removedAt - a.removedAt : b.firstSeen - a.firstSeen));
    const prods = await cachedProducts(seller.domain, list.map((i) => i.asin));
    const missing = list.filter((i) => !prods.has(i.asin)).map((i) => i.asin);
    wrap.innerHTML = `
      <div class="row spread" style="margin-bottom:10px">
        <div class="row">
          ${[['new', 'New since tracking'], ['all', 'All current'], ['dropped', 'Dropped']].map(([v, l]) => `<button class="btn small ${filter === v ? 'primary' : ''}" data-f="${v}">${l}</button>`).join('')}
        </div>
        <div class="row small muted">${num(list.length)} products${missing.length ? ` · ${num(missing.length)} without details <button class="btn small" id="loadMore">Load next ${Math.min(100, missing.length)} (≈${Math.min(100, missing.length)} tokens)</button>` : ''}</div>
      </div>
      <div class="table-wrap"><table class="data"><thead><tr><th>Product</th><th class="r">Price</th><th class="r">BSR</th><th class="r">Offers</th><th>${filter === 'dropped' ? 'Dropped' : 'First seen'}</th></tr></thead>
      <tbody>${list.slice(0, 500).map((i) => {
        const p = prods.get(i.asin);
        const when = filter === 'dropped' ? i.removedAt : i.firstSeen;
        return `<tr><td>${productCell(p, { asin: i.asin, domain: seller.domain, extra: i.baseline ? '' : ' <span class="tag new">New</span>' })}</td>
          <td class="r">${priceCell(p)}</td><td class="r">${bsrCell(p)}</td><td class="r">${offersCell(p)}</td>
          <td class="small">${i.baseline && filter !== 'dropped' ? '<span class="muted">At first import</span>' : dateTimeStr(when)}</td></tr>`;
      }).join('') || '<tr><td colspan="5" class="empty">Nothing here yet</td></tr>'}</tbody></table></div>
      ${list.length > 500 ? '<p class="small muted">Showing the first 500.</p>' : ''}`;
    wrap.querySelectorAll('[data-f]').forEach((b) => { b.onclick = () => { filter = b.dataset.f; draw(); }; });
    const lm = wrap.querySelector('#loadMore');
    if (lm) lm.onclick = async () => {
      lm.disabled = true; lm.textContent = 'Loading…';
      try { await getProducts(seller.domain, missing.slice(0, 100)); } catch (e) { toast(e.message, 'error'); }
      draw();
    };
  };
  draw();
}

async function showShared(selSellers, items) {
  const keys = new Set(selSellers.map((s) => s.key));
  const map = new Map();
  for (const it of items) {
    if (!keys.has(it.sellerKey) || it.removedAt) continue;
    if (!map.has(it.pkey)) map.set(it.pkey, { asin: it.asin, domain: it.domain, sellers: new Set() });
    map.get(it.pkey).sellers.add(it.sellerKey);
  }
  const rows = [...map.values()].filter((r) => r.sellers.size >= 2).sort((a, b) => b.sellers.size - a.sellers.size);
  const nameOf = (k) => { const s = selSellers.find((x) => x.key === k); return s ? (s.name || s.sellerId) : k; };
  const wrap = document.createElement('div');
  modal({ title: `Shared products across ${selSellers.length} storefronts`, body: wrap, wide: true });
  const draw = async () => {
    const prods = new Map();
    for (const r of rows.slice(0, 300)) { const p = await db.get('products', `${r.domain}:${r.asin}`); if (p) prods.set(r.asin, p); }
    const missing = rows.filter((r) => !prods.has(r.asin));
    wrap.innerHTML = `<div class="row spread" style="margin-bottom:10px"><span class="small muted">${num(rows.length)} products are sold by 2 or more of the selected storefronts.</span>
      ${missing.length ? `<button class="btn small" id="ld">Load details for ${Math.min(100, missing.length)} (≈${Math.min(100, missing.length)} tokens)</button>` : ''}</div>
      <div class="table-wrap"><table class="data"><thead><tr><th>Product</th><th>Sold by</th><th class="r">Price</th><th class="r">BSR</th><th class="r">Offers</th></tr></thead><tbody>
      ${rows.slice(0, 300).map((r) => `<tr><td>${productCell(prods.get(r.asin), { asin: r.asin, domain: r.domain })}</td>
        <td><div class="chips">${[...r.sellers].map((k) => `<span class="chip">${esc(nameOf(k))}</span>`).join('')}</div></td>
        <td class="r">${priceCell(prods.get(r.asin))}</td><td class="r">${bsrCell(prods.get(r.asin))}</td><td class="r">${offersCell(prods.get(r.asin))}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">No overlap between these storefronts</td></tr>'}
      </tbody></table></div>`;
    const ld = wrap.querySelector('#ld');
    if (ld) ld.onclick = async () => {
      ld.disabled = true; ld.textContent = 'Loading…';
      const byD = {};
      for (const r of missing.slice(0, 100)) (byD[r.domain] ||= []).push(r.asin);
      try { for (const [d, a] of Object.entries(byD)) await getProducts(Number(d), a); } catch (e) { toast(e.message, 'error'); }
      draw();
    };
  };
  draw();
}
