// Placeholder page for a feature that has its storage and backup in place but no screens yet.
import { feature } from '../features.js';
import { featureCounts } from '../backup.js';
import { downloadBackup, importFlow } from '../backup-ui.js';
import { icon } from '../ui.js';
import { esc, num } from '../util.js';

const ABOUT = {
  returns: {
    icon: 'undo',
    status: 'Next up',
    what: 'One record per returned FBA unit, from Amazon booking the return to resale on eBay or as Amazon Used, with the full cost and recovery P&L per unit.',
    note: 'You can already import a backup from the standalone FBA Returns Tracker extension here (its Data → Export file). Your units are kept safe and will appear once the screens are built.',
  },
  storescan: {
    icon: 'scan',
    status: 'Planned',
    what: 'Scan a whole retailer, match each product to an Amazon ASIN, price it with Keepa, and keep only products at or above your ROI threshold (default 15%) after all fees. Results sync to your Google Sheet.',
    note: '',
  },
  fbaadmin: {
    icon: 'chart',
    status: 'Next up',
    what: 'Accounting for Amazon FBA: import Amazon reports (settlement, sales, returns, inventory ledger and more) and bank statements, categorise money in and out (fix any that are wrong), see your key numbers on a dashboard, and get actual net profit per sold product from SellerToolkit reports after expenses and returns. Stored here and mirrored to your Google Sheet.',
    note: '',
  },
};

export async function render(root, ctx) {
  const id = ctx.feature;
  const f = feature(id);
  const a = ABOUT[id] || { icon: 'list', status: 'Planned', what: '', note: '' };
  const counts = await featureCounts();
  root.innerHTML = `
    <div class="card card-pad stack" style="max-width:760px">
      <div class="row"><h3 class="grow">${icon(a.icon, 20)} ${esc(f.label)}</h3><span class="badge">${esc(a.status)}</span></div>
      <p>${esc(a.what)}</p>
      ${a.note ? `<div class="callout small">${esc(a.note)}</div>` : ''}
      <hr class="sep">
      <p class="small muted">Storage and backup for this feature are already set up, so nothing you import now is lost when the screens arrive. <b>${num(counts[id] || 0)}</b> records stored.</p>
      <div class="row">
        <button class="btn" id="exp">${icon('download')} Export all ${esc(f.label)} data</button>
        <button class="btn" id="imp">${icon('upload')} Import ${esc(f.label)} data</button>
      </div>
    </div>`;
  root.querySelector('#exp').onclick = () => downloadBackup([id]);
  root.querySelector('#imp').onclick = () => importFlow(id);
}
