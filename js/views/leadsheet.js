// Lead sheet: your Google Sheet of buy leads, with the best ones to buy, the most profitable, stats and price rises.
// Read only: nothing is written to the sheet and no Keepa tokens are used.
import { getLeadSettings, saveLeadSettings, read, cached, toLeads, score, dedupe } from '../leads/leadsheet.js';
import { icon, toast, sortable, emptyState } from '../ui.js';
import { esc, num, pct, money, toCSV, downloadFile, keepaUrl } from '../util.js';

const ui = { q: '', minRoi: '', loading: false };
const today = () => new Date().toISOString().slice(0, 10);
const dstr = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }) : '—');
const kpi = (label, value, sub = '', cls = '') => `<div class="kpi"><div class="label">${label}</div><div class="value ${cls}">${value}</div><div class="sub">${sub}</div></div>`;
const roiCell = (r) => (r === null || r === undefined ? '—' : `<span class="${r >= 0.3 ? 'pos' : r < 0.2 ? 'neg' : ''}">${pct(r, 0)}</span>`);
const scoreCell = (s) => `<span class="score s${s >= 70 ? 'hi' : s >= 50 ? 'mid' : 'lo'}">${s}</span>`;
const titleCell = (l) => `<div style="max-width:380px"><a class="ptitle" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title || l.asin)}</a><div class="psub"><span class="mono">${esc(l.asin)}</span>${l.buyFrom ? ` · ${esc(l.buyFrom)}` : ''}${l.times > 1 ? ` · <span class="tag" title="Listed ${l.times} times in the sheet: the newest row is used">×${l.times}</span>` : ''} · <a href="${keepaUrl(2, l.asin)}" target="_blank" rel="noopener">Keepa</a></div></div>`;

export async function render(root) {
  const s = await getLeadSettings();
  const c = await cached();
  if (!s.url) {
    root.innerHTML = `<div class="card card-pad stack" style="max-width:720px"><h3>${icon('list')} Link your lead sheet</h3>
      <p class="small muted">Paste the link to your Google Sheet of buy leads (open it in Google Sheets and copy the address). It's read with your Google sign-in and never changed. You only do this once: the link syncs to your other devices.</p>
      <div class="row"><input id="lsUrl" class="grow" placeholder="https://docs.google.com/spreadsheets/d/…"><input type="hidden" id="lsTab" value=""><button class="btn primary" id="lsSave">${icon('check')} Use this sheet</button></div></div>`;
    wireSetup(root, s); return;
  }
  draw(root, s, c);
  // fresh copy if this one is more than 10 minutes old
  if (!ui.loading && (!c || Date.now() - c.at > 10 * 60e3)) reload(root, s, { quiet: !!c });
}

async function reload(root, s, { quiet = false } = {}) {
  ui.loading = true;
  const btn = root.querySelector('#lsReload'); if (btn) { btn.disabled = true; btn.textContent = 'Reading…'; }
  try { const c = await read(s); draw(root, s, c); if (!quiet) toast(`Read ${c.tab}`, 'success'); } catch (e) {
    if (!quiet || !(await cached())) toast(e.message, 'error', 8000);
    if (btn) { btn.disabled = false; btn.textContent = 'Reload'; }
  } finally { ui.loading = false; }
}

function draw(root, s, c) {
  const setup = `<details class="card card-pad section" ${c ? '' : 'open'}><summary class="small"><b>Which sheet</b></summary>
    <div class="form-grid" style="margin-top:10px"><label class="field span2">Google Sheet link<input id="lsUrl" value="${esc(s.url)}"></label>
      <label class="field">Tab<select id="lsTab"><option value="">${c ? 'The one in the link' : 'Buy Sheet, or the one in the link'}</option>${(c?.tabs || []).map((t) => `<option ${t === s.tab ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label></div>
    <p class="small muted">The toolkit reads it with your Google sign-in (Devices &amp; sync) and never changes it. It needs the columns ASIN, Cost Price and Profit per Unit; Product Name, Sale Price, SPM, Due to Go Up, Buy From, Date and Notes are used when they're there.</p>
    <div class="row"><button class="btn small primary" id="lsSave">${icon('check', 14)} Save</button></div></details>`;
  if (!c) {
    root.innerHTML = `${emptyState('list', 'Reading your lead sheet…', 'If this doesn\'t load, check you\'re connected to Google on <a href="#sync">Devices &amp; sync</a>.')}${setup}`;
    wireSetup(root, s); return;
  }
  const { leads: rows, problems } = toLeads(c.values);
  const t0 = today();
  const leads = dedupe(rows).map((l) => ({ ...l, score: score(l, t0) }));
  const withRoi = leads.filter((l) => l.roi !== null);
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const thisMonth = t0.slice(0, 7);
  const rising = leads.filter((l) => l.dueUp && l.dueUp >= t0 && (Date.parse(l.dueUp) - Date.parse(t0)) / 864e5 <= 14).sort((a, b) => a.dueUp.localeCompare(b.dueUp));
  const best = [...leads].sort((a, b) => b.score - a.score).slice(0, 15);
  const top = (key, n = 10) => [...leads].filter((l) => l[key] !== null && l[key] !== undefined).sort((a, b) => b[key] - a[key]).slice(0, n);
  const group = (key) => {
    const m = new Map();
    for (const l of leads) { const k = key(l) || '(not filled in)'; if (!m.has(k)) m.set(k, []); m.get(k).push(l); }
    return [...m.entries()].map(([k, ls]) => ({ k, n: ls.length, roi: avg(ls.map((l) => l.roi).filter((x) => x !== null)), profit: avg(ls.map((l) => l.profit).filter((x) => x !== null)) }));
  };
  const stores = group((l) => l.buyFrom.trim()).sort((a, b) => b.n - a.n).slice(0, 10);
  const months = group((l) => (l.date || '').slice(0, 7)).filter((x) => x.k !== '(not filled in)').sort((a, b) => b.k.localeCompare(a.k)).slice(0, 12);
  const mini = (title, list, val) => `<div class="card"><div class="toolbar"><b>${title}</b></div><div class="table-wrap"><table class="data small"><tbody>${list.map((l) => `<tr><td>${titleCell(l)}</td><td class="r num">${val(l)}</td></tr>`).join('') || '<tr><td class="empty">None</td></tr>'}</tbody></table></div></div>`;

  root.innerHTML = `
    <div class="row" style="margin-bottom:12px"><b class="grow">${esc(c.title)} › ${esc(c.tab)}</b>
      <span class="small muted">read ${esc(new Date(c.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}</span>
      <button class="btn small" id="lsReload">${icon('refresh', 14)} Reload</button><a class="btn small ghost" href="https://docs.google.com/spreadsheets/d/${esc(c.id)}/edit" target="_blank" rel="noopener">${icon('external', 14)} Open sheet</a></div>
    ${problems.missing.length ? `<div class="callout warn small section-first">Couldn't find a column for ${problems.missing.map((m) => `<b>${esc(m)}</b>`).join(', ')}: pick the right tab below, or rename the column in your sheet.</div>` : ''}
    <div class="kpis">
      ${kpi('Leads', num(leads.length), rows.length > leads.length ? `${num(rows.length)} rows, ${num(rows.length - leads.length)} repeats` : `${num(leads.filter((l) => (l.date || '').startsWith(thisMonth)).length)} added this month`)}
      ${kpi('Average ROI', withRoi.length ? pct(avg(withRoi.map((l) => l.roi)), 0) : '—', `best ${withRoi.length ? pct(Math.max(...withRoi.map((l) => l.roi)), 0) : '—'}`)}
      ${kpi('Average profit', money(avg(leads.map((l) => l.profit).filter((x) => x !== null))), 'per unit')}
      ${kpi('Strong leads', num(leads.filter((l) => l.score >= 70).length), 'score 70+')}
      ${kpi('Price going up soon', num(rising.length), 'in the next 14 days', rising.length ? 'warn-text' : '')}
    </div>
    ${problems.roiFixed ? `<p class="small muted section">ROI is worked out here as profit ÷ cost: ${num(problems.roiFixed)} row${problems.roiFixed === 1 ? '' : 's'} in the sheet's ROI column held a £ amount or a figure that didn't match.</p>` : ''}

    <div class="card section"><div class="toolbar"><b>${icon('star', 15)} Best ones to buy</b><span class="small muted">score: 40% ROI, 30% profit per unit, 30% sales per month, plus a nudge for a price rise in the next 2 weeks</span></div>
      <div class="table-wrap"><table class="data"><thead><tr><th>Product</th><th class="r">Score</th><th class="r">Cost</th><th class="r">Sells</th><th class="r">Profit</th><th class="r">ROI</th><th class="r">Sales/mo</th><th>Price rise</th></tr></thead><tbody>
      ${best.map((l) => `<tr><td>${titleCell(l)}</td><td class="r">${scoreCell(l.score)}</td><td class="r num">${money(l.cost)}</td><td class="r num">${money(l.sale)}</td><td class="r num">${money(l.profit)}</td><td class="r num">${roiCell(l.roi)}</td><td class="r num">${esc(l.spmText || '—')}</td><td class="small nowrap">${l.dueUp ? dstr(l.dueUp) : esc(l.dueUpText && l.dueUpText !== '-' ? l.dueUpText : '')}</td></tr>`).join('')}
      </tbody></table></div></div>

    ${rising.length ? `<div class="card section"><div class="toolbar"><b>${icon('bell', 15)} Price going up soon</b><span class="small muted">buy before the rise</span></div><div class="table-wrap"><table class="data small"><tbody>
      ${rising.map((l) => `<tr><td class="nowrap"><b>${dstr(l.dueUp)}</b></td><td>${titleCell(l)}</td><td class="r num">${money(l.profit)} · ${roiCell(l.roi)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}

    <div class="grid2 section">
      ${mini('Most profitable per unit', top('profit'), (l) => `${money(l.profit)}<div class="muted">${pct(l.roi ?? 0, 0)} ROI</div>`)}
      ${mini('Highest ROI', top('roi'), (l) => `${roiCell(l.roi)}<div class="muted">${money(l.profit)} profit</div>`)}
    </div>
    <div class="grid2 section">
      ${mini('Best sellers', top('spm'), (l) => `${esc(l.spmText)}<div class="muted">${money(l.profit)} · ${pct(l.roi ?? 0, 0)}</div>`)}
      <div class="card"><div class="toolbar"><b>Where they're from</b></div><table class="data small"><thead><tr><th>Buy from</th><th class="r">Leads</th><th class="r">Avg ROI</th><th class="r">Avg profit</th></tr></thead><tbody>
        ${stores.map((x) => `<tr><td>${esc(x.k)}</td><td class="r num">${x.n}</td><td class="r num">${x.roi === null ? '—' : pct(x.roi, 0)}</td><td class="r num">${money(x.profit)}</td></tr>`).join('')}</tbody></table>
        ${months.length ? `<div class="toolbar"><b>Added each month</b></div><table class="data small"><tbody>${months.map((x) => `<tr><td>${esc(new Date(`${x.k}-15T12:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }))}</td><td class="r num">${x.n} leads</td><td class="r num">${x.roi === null ? '—' : pct(x.roi, 0)}</td><td class="r num">${money(x.profit)}</td></tr>`).join('')}</tbody></table>` : ''}
      </div>
    </div>

    <div class="card section"><div class="toolbar"><b>All leads</b><input type="search" id="lsQ" placeholder="Search product, ASIN, store" value="${esc(ui.q)}" style="width:200px">
      <label class="small">Min ROI % <input id="lsMin" type="number" step="5" value="${esc(ui.minRoi)}" style="width:70px"></label><span class="grow"></span><button class="btn small" id="lsCsv">${icon('download', 14)} CSV</button></div>
      <div class="table-wrap"><table class="data" id="lsAll"><thead><tr><th data-sort="title" data-first="asc">Product</th><th data-sort="date">Added</th><th data-sort="score" class="r">Score</th><th data-sort="cost" class="r">Cost</th><th data-sort="sale" class="r">Sells</th><th data-sort="profit" class="r">Profit</th><th data-sort="roi" class="r">ROI</th><th data-sort="spm" class="r">Sales/mo</th><th>Notes</th></tr></thead><tbody></tbody></table></div></div>
    ${setup}`;

  const filtered = () => leads.filter((l) => (!ui.q || `${l.title} ${l.asin} ${l.buyFrom} ${l.notes}`.toLowerCase().includes(ui.q.toLowerCase())) && (ui.minRoi === '' || (l.roi ?? -1) * 100 >= Number(ui.minRoi)));
  const sorter = sortable(root.querySelector('#lsAll'), filtered(), (l) => `<tr><td>${titleCell(l)}</td><td class="small nowrap">${dstr(l.date)}</td><td class="r">${scoreCell(l.score)}</td><td class="r num">${money(l.cost)}</td><td class="r num">${money(l.sale)}</td><td class="r num">${money(l.profit)}</td><td class="r num">${roiCell(l.roi)}</td><td class="r num">${esc(l.spmText || '—')}</td><td class="small">${esc([l.notes, l.lead, l.priceDrop].filter(Boolean).join(' · ').slice(0, 80))}</td></tr>`, { defaultKey: 'score' });
  root.querySelector('#lsQ').oninput = (e) => { ui.q = e.target.value; sorter.redraw(filtered()); };
  root.querySelector('#lsMin').oninput = (e) => { ui.minRoi = e.target.value; sorter.redraw(filtered()); };
  root.querySelector('#lsReload').onclick = () => reload(root, s);
  root.querySelector('#lsCsv').onclick = () => downloadFile(`lead-sheet-ranked-${today()}.csv`, toCSV([['ASIN', 'Product', 'Added', 'Score', 'Cost', 'Sells for', 'Profit', 'ROI %', 'Sales per month', 'Price rise', 'Buy from', 'Notes', 'Amazon'],
    ...filtered().sort((a, b) => b.score - a.score).map((l) => [l.asin, l.title, l.date, l.score, l.cost ?? '', l.sale ?? '', l.profit ?? '', l.roi === null ? '' : Math.round(l.roi * 1000) / 10, l.spmText, l.dueUp || l.dueUpText, l.buyFrom, l.notes, l.url])]));
  wireSetup(root, s);
}

function wireSetup(root, s) {
  const save = root.querySelector('#lsSave');
  if (save) save.onclick = async () => {
    const url = root.querySelector('#lsUrl').value.trim(); const tab = root.querySelector('#lsTab').value;
    await saveLeadSettings({ url, tab });
    toast('Saved', 'success');
    reload(root, { url, tab });
  };
}
