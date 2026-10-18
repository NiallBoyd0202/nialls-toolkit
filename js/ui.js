// Small UI toolkit: toasts, modals, icons, product cells, sortable tables.
import { esc, money, num, amazonUrl, keepaUrl, googleShopUrl, imageUrl, MARKETS } from './util.js';

export const h = (strings, ...vals) => strings.reduce((acc, s, i) => acc + s + (i < vals.length ? vals[i] : ''), '');

const ICONS = {
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  external: '<path d="M14 3h7v7"/><path d="M10 14 21 3"/><path d="M21 14v7H3V3h7"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  upload: '<path d="M12 16V4M6 10l6-6 6 6"/><path d="M4 20h16"/>',
  download: '<path d="M12 4v12M6 10l6 6 6-6"/><path d="M4 20h16"/>',
  spy: '<circle cx="7" cy="15" r="3"/><circle cx="17" cy="15" r="3"/><path d="M10 15h4M2 10h20M5 10l2-6h10l2 6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  scan: '<path d="M3 7V3h4M17 3h4v4M21 17v4h-4M7 21H3v-4"/><path d="M7 8v8M10 8v8M13 8v8M17 8v8"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>',
  pound: '<path d="M17 20H6c2-2 3-4 3-7V8a4 4 0 0 1 7.5-2"/><path d="M5 13h9"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  store: '<path d="M3 9l1.5-5h15L21 9"/><path d="M4 9v11h16V9"/><path d="M3 9c0 1.7 1.3 3 3 3s3-1.3 3-3c0 1.7 1.3 3 3 3s3-1.3 3-3c0 1.7 1.3 3 3 3s3-1.3 3-3"/>',
  ebay: '<path d="M4 7h16l-1.5 12h-13z"/><path d="M9 7a3 3 0 0 1 6 0"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  chart: '<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/>',
  bell: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10 21a2 2 0 0 0 4 0"/>',
  shield: '<path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  clip: '<path d="m21 11-8.6 8.6a5 5 0 0 1-7-7L14 4a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"/>',
  file: '<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4"/>',
  print: '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="1"/><path d="M6 14h12v7H6z"/>',
  cloud: '<path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.5a4.25 4.25 0 0 1-.5 8.5z"/>',
  cloudOff: '<path d="M7 18a4.5 4.5 0 0 1-.6-8.96M9.3 5.6A6 6 0 0 1 18 9.5a4.25 4.25 0 0 1 2.3 7.3M3 3l18 18"/>',
  cloudAlert: '<path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.5a4.25 4.25 0 0 1-.5 8.5z"/><path d="M12 10v3M12 15.5v.01"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  wallet: '<path d="M20 7V5a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2V6"/><path d="M16 13.5h.01"/>',
};

export function icon(name, size = 16) {
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

// ---- toasts ----
export function toast(msg, type = 'info', ms = 3800) {
  let wrap = document.getElementById('toasts');
  if (!wrap) { wrap = document.createElement('div'); wrap.id = 'toasts'; document.body.appendChild(wrap); }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, ms);
}

// ---- modal ----
export function modal({ title, body, actions = [], wide = false, onClose }) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
    <div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>
    <div class="modal-body"></div>
    <div class="modal-foot"></div></div>`;
  const bodyEl = back.querySelector('.modal-body');
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.appendChild(body);
  const foot = back.querySelector('.modal-foot');
  const close = () => { back.remove(); onClose && onClose(); };
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = `btn ${a.kind || ''}`;
    b.textContent = a.label;
    b.onclick = async () => { const r = a.onClick ? await a.onClick(back) : undefined; if (r !== false) close(); };
    foot.appendChild(b);
  }
  if (!actions.length) foot.remove();
  back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', function onKey(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } });
  document.body.appendChild(back);
  return { el: back, body: bodyEl, close };
}

export function confirmBox(title, text, { okLabel = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    modal({
      title,
      body: `<p>${esc(text)}</p>`,
      actions: [
        { label: 'Cancel', onClick: () => { done = true; resolve(false); } },
        { label: okLabel, kind: danger ? 'danger' : 'primary', onClick: () => { done = true; resolve(true); } },
      ],
      onClose: () => { if (!done) resolve(false); },
    });
  });
}

// ---- product rendering ----
export function thumb(p, size = 44) {
  if (p && p.image) return `<img class="thumb" loading="lazy" src="${esc(imageUrl(p.image, size * 2))}" width="${size}" height="${size}" alt="">`;
  const letters = esc(((p && p.title) || '?').replace(/[^A-Za-z ]/g, '').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?');
  return `<div class="thumb ph" style="width:${size}px;height:${size}px">${letters}</div>`;
}

export function productCell(p, { asin, domain = 2, extra = '' } = {}) {
  const a = (p && p.asin) || asin;
  const d = (p && p.domain) || domain;
  const title = p ? p.title : 'Details not loaded yet';
  return `<div class="pcell">
    ${thumb(p)}
    <div class="pmeta">
      <a class="ptitle" href="${amazonUrl(d, a)}" target="_blank" rel="noopener" title="${esc(title)}">${esc(title)}</a>
      <div class="psub"><span class="mono">${esc(a)}</span>${p && p.brand ? ` · ${esc(p.brand)}` : ''}${p && p.category ? ` · ${esc(p.category)}` : ''}${MARKETS[d] && d !== 2 ? ` · <span class="tag">${MARKETS[d].code}</span>` : ''}${extra}</div>
      <div class="plinks">
        <a href="${keepaUrl(d, a)}" target="_blank" rel="noopener">Keepa</a>
        <a href="${amazonUrl(d, a)}" target="_blank" rel="noopener">Amazon</a>
        ${p ? `<a href="${googleShopUrl(p.title)}" target="_blank" rel="noopener">Find source</a>` : ''}
      </div>
    </div></div>`;
}

export function priceCell(p) {
  if (!p) return '<span class="muted">—</span>';
  const sym = MARKETS[p.domain]?.symbol || '£';
  return `<div class="num">${money(p.price, sym)}</div>${p.avg90 ? `<div class="muted small">90d ${money(p.avg90, sym)}</div>` : ''}`;
}

export function bsrCell(p) {
  if (!p || !p.bsr) return '<span class="muted">—</span>';
  return `<div class="num">#${num(p.bsr)}</div>${p.monthlySold ? `<div class="muted small">${num(p.monthlySold)}+/mo</div>` : (p.drops30 !== null && p.drops30 !== undefined ? `<div class="muted small">${p.drops30} drops/30d</div>` : '')}`;
}

export function offersCell(p) {
  if (!p) return '—';
  return `${p.offerCount ?? '—'}${p.amazonOnListing ? ' <span class="tag warn" title="Amazon is selling this">AMZ</span>' : ''}`;
}

export function profitClass(v) {
  if (v === null || v === undefined) return '';
  return v > 0 ? 'pos' : v < 0 ? 'neg' : '';
}

// Turn a <table> with th[data-sort] headers into a sortable table driven by a data array.
export function sortable(table, rows, renderRow, { defaultKey, defaultDir = 'desc', onSort } = {}) {
  let key = defaultKey;
  let dir = defaultDir;
  const tbody = table.querySelector('tbody');
  const draw = () => {
    const sorted = [...rows];
    if (key) {
      sorted.sort((a, b) => {
        const va = typeof key === 'function' ? key(a) : a[key];
        const vb = typeof key === 'function' ? key(b) : b[key];
        const na = va === null || va === undefined || va === '';
        const nb = vb === null || vb === undefined || vb === '';
        if (na && nb) return 0; if (na) return 1; if (nb) return -1;
        const r = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
        return dir === 'asc' ? r : -r;
      });
    }
    tbody.innerHTML = sorted.length ? sorted.map(renderRow).join('') : `<tr><td colspan="99" class="empty">Nothing to show</td></tr>`;
    table.querySelectorAll('th[data-sort]').forEach((th) => {
      th.classList.toggle('sorted', th.dataset.sort === key);
      th.dataset.dir = th.dataset.sort === key ? dir : '';
    });
    onSort && onSort(sorted);
  };
  table.querySelectorAll('th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const k = th.dataset.sort;
      if (key === k) dir = dir === 'asc' ? 'desc' : 'asc'; else { key = k; dir = th.dataset.first || 'desc'; }
      draw();
    });
  });
  draw();
  return { redraw: (newRows) => { if (newRows) rows = newRows; draw(); } };
}

export function progressUI(container) {
  container.innerHTML = `<div class="progress"><div class="progress-bar"><span style="width:0%"></span></div><div class="progress-text small muted"></div><button class="btn small" data-cancel>Cancel</button></div>`;
  const bar = container.querySelector('.progress-bar span');
  const text = container.querySelector('.progress-text');
  return {
    set(fraction, msg) { bar.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`; if (msg !== undefined) text.textContent = msg; },
    onCancel(fn) { container.querySelector('[data-cancel]').onclick = fn; },
    done() { container.innerHTML = ''; },
  };
}

export function emptyState(iconName, title, text, actionHtml = '') {
  return `<div class="empty-state">${icon(iconName, 34)}<h3>${esc(title)}</h3><p>${text}</p>${actionHtml}</div>`;
}
