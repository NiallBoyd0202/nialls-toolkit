// Retailer & wholesaler outreach — the numbers. Pure: no storage, no DOM.
//
// Ranks brands and products from the storefront tracker by
//   - how many of your tracked storefronts list them (the strongest signal: other sellers found a supplier),
//   - demand (Keepa monthly sales, else sales rank) and price stability (90-day low/high and 30 vs 90-day average),
//   - estimated profit and ROI at the supplier's price (when you've entered one), else the room left after fees,
// and flags the brands worth approaching first.
import { STAGE_ORDER, brandKey } from './store.js';

const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
const r2 = (n) => Math.round(n * 100) / 100;
const median = (xs) => { const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const avg = (xs) => { const s = xs.filter((x) => Number.isFinite(x)); return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null; };

// ---------------------------------------------------------------------------
// One unit: Amazon fees, profit, ROI, and the most you could pay for the target ROI
// ---------------------------------------------------------------------------
// Prices on Amazon include VAT. VAT registered: you pay VAT on the sale and reclaim it on costs and fees.
// Not registered: no VAT on the sale, but VAT on Amazon's fees and on supplier prices is a cost.
export function unitEconomics(p, cost, s, { vatRegistered = false } = {}) {
  const price = p?.price;
  if (!price) return null;
  const referral = price * (p.referralPct ?? s.defaultReferralPct);
  const fba = p.fbaFee ?? s.defaultFbaFee;
  const fees = referral + fba;
  const revenue = vatRegistered ? price / 1.2 : price;
  const feesCost = vatRegistered ? fees : fees * 1.2;
  const extras = (Number(s.prepPerUnit) || 0) + (Number(s.inboundPerUnit) || 0);
  // supplier price as entered -> what it really costs you
  const toNet = (c) => (s.supplierPricesIncVat ? (vatRegistered ? c / 1.2 : c) : (vatRegistered ? c : c * 1.2));
  const fromNet = (n) => (s.supplierPricesIncVat ? (vatRegistered ? n * 1.2 : n) : (vatRegistered ? n : n / 1.2));
  const room = revenue - feesCost - extras; // what's left for the stock itself
  const target = Number(s.targetRoi) || 0;
  const maxBuy = room > 0 ? r2(fromNet((revenue - feesCost) / (1 + target) - extras)) : 0;
  const out = { price, fees: r2(fees), feesCost: r2(feesCost), revenue: r2(revenue), extras: r2(extras), maxBuy: Math.max(0, maxBuy), roomPct: room / price };
  if (cost === null || cost === undefined || cost === '' || !Number.isFinite(Number(cost))) return out;
  const costNet = toNet(Number(cost));
  const profit = room - costNet;
  return { ...out, cost: Number(cost), costNet: r2(costNet), profit: r2(profit), roi: costNet + extras > 0 ? profit / (costNet + extras) : null, margin: profit / price };
}

// 0–100: how steady the price has been (100 = flat). From the 90-day low/high, recent drift and today vs average.
export function priceStability(p) {
  const ref = p?.avg90 || p?.price;
  if (!ref) return null;
  const parts = [];
  if (p.min90 && p.max90) parts.push((p.max90 - p.min90) / ref);
  if (p.avg30 && p.avg90) parts.push((Math.abs(p.avg30 - p.avg90) / ref) * 2);
  if (p.price && p.avg90) parts.push(Math.abs(p.price - p.avg90) / ref);
  if (!parts.length) return null;
  return Math.round(clamp(100 - avg(parts) * 250));
}

// 0–100: demand from Keepa's monthly sales estimate, or from sales rank when there isn't one.
export function demandScore(p) {
  if (p?.monthlySold) return Math.round(clamp((Math.log10(p.monthlySold) / 3) * 100)); // 1,000+/month = 100
  if (p?.bsr) return Math.round(clamp(100 - (Math.log10(p.bsr) - 3) * 33)); // #1,000 = 100, #100k ≈ 34
  return null;
}

function profitScore(e) {
  if (!e) return null;
  if (e.roi !== undefined && e.roi !== null) return Math.round(clamp((e.roi / 0.6) * 100)); // 60% ROI = 100
  return Math.round(clamp(((e.roomPct - 0.3) / 0.4) * 60)); // no supplier price yet: at most 60
}

// ---------------------------------------------------------------------------
// Rankings
// ---------------------------------------------------------------------------
// data: { items, sellers, products (Map pkey -> summary), leads, links, suppliers, settings, vatRegistered }
export function rankProducts(data) {
  const { items, products, leads = [], links = [], suppliers = [], settings: s } = data;
  const supplierById = new Map(suppliers.map((x) => [x.id, x]));
  const leadById = new Map(leads.map((l) => [l.id, l]));
  // supplier prices: per ASIN, from ASIN leads (link.cost) and brand leads (link.prices[asin])
  const costs = new Map();
  const addCost = (asin, c, link) => { if (c === '' || c === null || c === undefined || !Number.isFinite(Number(c))) return; const cur = costs.get(asin); if (!cur || Number(c) < cur.cost) costs.set(asin, { cost: Number(c), supplierId: link.supplierId, link }); };
  for (const l of links) {
    const lead = leadById.get(l.leadId); if (!lead) continue;
    if (lead.type === 'asin') addCost(lead.asin, l.cost, l);
    for (const [asin, c] of Object.entries(l.prices || {})) addCost(asin, c, l);
  }
  const listedBy = new Map();
  for (const it of items) {
    if (it.removedAt) continue;
    if (!listedBy.has(it.pkey)) listedBy.set(it.pkey, { asin: it.asin, domain: it.domain, sellers: new Set(), firstSeen: it.firstSeen });
    const g = listedBy.get(it.pkey); g.sellers.add(it.sellerKey); g.firstSeen = Math.min(g.firstSeen, it.firstSeen || Infinity);
  }
  const rows = [];
  for (const [pkey, g] of listedBy) {
    const p = products.get(pkey) || null;
    const c = costs.get(g.asin);
    const e = p ? unitEconomics(p, c?.cost, s, { vatRegistered: data.vatRegistered }) : null;
    const stab = p ? priceStability(p) : null;
    const dem = p ? demandScore(p) : null;
    const prof = profitScore(e);
    const store = clamp((g.sellers.size / 5) * 100);
    let score = 0.35 * store + 0.25 * (dem ?? 30) + 0.15 * (stab ?? 50) + 0.25 * (prof ?? 30);
    if (p?.amazonOnListing) score -= 15;
    if ((p?.offerCount ?? 0) > 15) score -= 5;
    rows.push({
      pkey, asin: g.asin, domain: g.domain, product: p, title: p?.title || g.asin, brand: p?.brand || '', brandKey: brandKey(p?.brand),
      storefronts: g.sellers.size, sellerKeys: [...g.sellers], bsr: p?.bsr ?? null, monthlySold: p?.monthlySold ?? null, price: p?.price ?? null,
      stability: stab, demand: dem, econ: e, supplierCost: c || null, supplier: c ? supplierById.get(c.supplierId) || null : null,
      amazon: !!p?.amazonOnListing, offers: p?.offerCount ?? null, score: Math.round(clamp(score)),
    });
  }
  return rows.sort((a, b) => b.score - a.score);
}

export function rankBrands(data, productRows = rankProducts(data)) {
  const { leads = [], links = [], suppliers = [] } = data;
  const supplierById = new Map(suppliers.map((x) => [x.id, x]));
  const byBrand = new Map();
  for (const r of productRows) {
    if (!r.brandKey) continue;
    if (!byBrand.has(r.brandKey)) byBrand.set(r.brandKey, { brandKey: r.brandKey, brand: r.brand, products: [], sellers: new Set() });
    const b = byBrand.get(r.brandKey); b.products.push(r); r.sellerKeys.forEach((k) => b.sellers.add(k));
  }
  const brandLeads = new Map(leads.filter((l) => l.type === 'brand').map((l) => [brandKey(l.brand), l]));
  const asinLeadsByBrand = new Map();
  for (const l of leads) if (l.type === 'asin' && l.brand) { const k = brandKey(l.brand); if (!asinLeadsByBrand.has(k)) asinLeadsByBrand.set(k, []); asinLeadsByBrand.get(k).push(l); }
  const rows = [];
  for (const b of byBrand.values()) {
    const top = [...b.products].sort((x, y) => (y.demand ?? 0) - (x.demand ?? 0)).slice(0, 3);
    const dem = avg(top.map((x) => x.demand));
    const stab = avg(b.products.map((x) => x.stability));
    const prof = avg(top.map((x) => profitScore(x.econ)));
    const amazonShare = b.products.filter((x) => x.amazon).length / b.products.length;
    const store = clamp((b.sellers.size / 6) * 100);
    let score = 0.35 * store + 0.25 * (dem ?? 30) + 0.15 * (stab ?? 50) + 0.25 * (prof ?? 30) - amazonShare * 15 + Math.min(10, (b.products.length - 1) * 2);
    // where you are with this brand: the furthest-along supplier linked to it
    const lead = brandLeads.get(b.brandKey);
    const leadIds = new Set([lead?.id, ...(asinLeadsByBrand.get(b.brandKey) || []).map((l) => l.id)].filter(Boolean));
    const sup = links.filter((l) => leadIds.has(l.leadId)).map((l) => supplierById.get(l.supplierId)).filter(Boolean);
    const stage = sup.reduce((best, x) => (best === null || (STAGE_ORDER[x.stage] ?? -1) > (STAGE_ORDER[best] ?? -1) ? x.stage : best), null);
    const rois = b.products.map((x) => x.econ?.roi).filter((x) => Number.isFinite(x));
    rows.push({
      brandKey: b.brandKey, brand: b.brand, products: b.products.length, storefronts: b.sellers.size,
      monthlySold: b.products.reduce((a, x) => a + (x.monthlySold || 0), 0) || null, medianBsr: median(b.products.map((x) => x.bsr)),
      avgPrice: avg(b.products.map((x) => x.price)), stability: stab === null ? null : Math.round(stab), demand: dem === null ? null : Math.round(dem),
      bestRoi: rois.length ? Math.max(...rois) : null, amazonShare, lead: lead || null, hasLead: leadIds.size > 0, suppliers: sup, stage,
      topProducts: top, allProducts: b.products, score: Math.round(clamp(score)),
    });
  }
  rows.sort((a, b) => b.score - a.score);
  // the ones to approach first: strong, and you haven't got a conversation going yet
  let n = 0;
  for (const r of rows) {
    const untouched = !r.stage || r.stage === 'to_contact';
    r.approachFirst = untouched && r.score >= 55 && r.storefronts >= 2 && r.amazonShare < 0.5 && n < 10;
    if (r.approachFirst) n++;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Follow-ups: suppliers to chase today or earlier
// ---------------------------------------------------------------------------
export function followUpsDue(suppliers, today) {
  return suppliers
    .filter((x) => x.nextFollowUp && x.nextFollowUp <= today && x.stage !== 'ordering' && x.stage !== 'declined')
    .sort((a, b) => a.nextFollowUp.localeCompare(b.nextFollowUp));
}

// Fills {{placeholders}} in a template for one supplier.
export function fillTemplate(text, ctx) {
  return String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (ctx[k] !== undefined && ctx[k] !== null && ctx[k] !== '' ? String(ctx[k]) : (k === 'accountNumber' ? '' : m)));
}

export const PLACEHOLDERS = [
  ['company', 'Supplier company name'], ['contact', 'Contact name'], ['contactFirst', 'Contact first name (or "there")'],
  ['brand', 'First linked brand'], ['brands', 'All linked brands'], ['products', 'Bulleted list of linked products'], ['asins', 'Linked ASINs'],
  ['accountNumber', 'Your account number with them'], ['lastEmailDate', 'When you last emailed them'], ['today', "Today's date"],
  ['myName', 'Your name'], ['myCompany', 'Your company'], ['myEmail', 'Your email'], ['myPhone', 'Your phone'], ['myWebsite', 'Your website'],
];
