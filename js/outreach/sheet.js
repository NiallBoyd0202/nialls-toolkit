// Retailer & wholesaler outreach in the FBA Accounting spreadsheet: an "Outreach" tab (every supplier, where it's up to
// and what it stocks at what price) and "Outreach Brands" (the brand ranking).
import * as db from '../db.js';
import { loadOutreach, STAGE_LABEL } from './store.js';
import { rankProducts, rankBrands } from './analysis.js';

export async function outreachTabs({ vatRegistered = false } = {}) {
  const o = await loadOutreach();
  const [items, prods] = await Promise.all([db.getAll('items'), db.getAll('products')]);
  const tabs = {};
  if (o.suppliers.length || o.leads.length) {
    const lastAct = new Map();
    for (const a of o.activity) if (!lastAct.has(a.supplierId) || lastAct.get(a.supplierId).at < a.at) lastAct.set(a.supplierId, a);
    const rows = [['Company', 'Type', 'Stage', 'Next follow-up', 'Contact', 'Email', 'Phone', 'Website', 'Account number', 'Minimum order', 'Lead', 'Lead type', 'ASIN', 'Their price', 'Pack size', 'Link note', 'Last contact', 'Last contact note', 'Notes']];
    for (const s of o.suppliers.sort((a, b) => a.company.localeCompare(b.company))) {
      const la = lastAct.get(s.id);
      const base = [s.company, s.type || '', STAGE_LABEL[s.stage || 'to_contact'], s.nextFollowUp || '', s.contactName || '', s.email || '', s.phone || '', s.website || '', s.accountNumber || '', s.minOrder || ''];
      const tail = [la ? new Date(la.at).toISOString().slice(0, 10) : '', la?.text || '', s.notes || ''];
      const links = o.links.filter((k) => k.supplierId === s.id);
      if (!links.length) { rows.push([...base, '', '', '', '', '', '', ...tail]); continue; }
      for (const k of links) {
        const l = o.leads.find((x) => x.id === k.leadId); if (!l) continue;
        const prices = Object.entries(k.prices || {});
        if (l.type === 'brand' && prices.length) for (const [asin, c] of prices) rows.push([...base, l.brand, 'Brand', asin, c, k.packSize || '', k.note || '', ...tail]);
        else rows.push([...base, l.type === 'brand' ? l.brand : (l.title || l.asin), l.type === 'brand' ? 'Brand' : 'ASIN', l.asin || '', k.cost ?? '', k.packSize || '', k.note || '', ...tail]);
      }
    }
    // leads nobody's been linked to yet
    for (const l of o.leads.filter((x) => !o.links.some((k) => k.leadId === x.id))) rows.push(['(no supplier yet)', '', '', '', '', '', '', '', '', '', l.type === 'brand' ? l.brand : (l.title || l.asin), l.type === 'brand' ? 'Brand' : 'ASIN', l.asin || '', '', '', '', '', '', l.note || '']);
    tabs.Outreach = rows;
  }
  if (items.length) {
    const data = { ...o, items, products: new Map(prods.map((p) => [p.key, p])), vatRegistered };
    const brands = rankBrands(data, rankProducts(data));
    if (brands.length) {
      tabs['Outreach Brands'] = [['Brand', 'Score', 'Approach first', 'Storefronts', 'Products', 'Sales per month', 'Median BSR', 'Price stability', 'Best ROI %', 'Amazon on listing %', 'Status', 'Suppliers'],
        ...brands.slice(0, 1000).map((b) => [b.brand, b.score, b.approachFirst ? 'Yes' : '', b.storefronts, b.products, b.monthlySold ?? '', b.medianBsr ?? '', b.stability ?? '', b.bestRoi === null ? '' : Math.round(b.bestRoi * 100), Math.round(b.amazonShare * 100), b.stage ? STAGE_LABEL[b.stage] : b.hasLead ? 'Lead' : '', b.suppliers.map((s) => s.company).join(', ')])];
    }
  }
  return tabs;
}
