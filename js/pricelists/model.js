// Supplier price lists — reading a wholesaler's list and scoring each line. Pure: no storage, no network.
//
// A price list is whatever the supplier sends: CSV or Excel with some of barcode (EAN/UPC), description, price,
// pack size, RRP, their product code, brand. Columns are found by name (you can change any of them), the header
// row can sit below a banner, and barcodes Excel has mangled ("5.01234E+12") are flagged rather than guessed.
import { normHeader, parseMoney } from '../util.js';
import { unitEconomics, priceStability, demandScore } from '../outreach/analysis.js';

export const PL_FIELDS = {
  code: ['ean', 'ean13', 'ean 13', 'barcode', 'bar code', 'upc', 'gtin', 'ean code', 'ean upc', 'ean number', 'barcode ean', 'unit barcode', 'unit ean'],
  title: ['description', 'product description', 'product', 'product name', 'title', 'item description', 'item', 'name', 'item name'],
  cost: ['unit price', 'price', 'trade price', 'unit cost', 'cost', 'wholesale price', 'your price', 'net price', 'cost price', 'buy price', 'price each', 'ex vat price'],
  pack: ['pack size', 'case size', 'outer', 'outer qty', 'qty per case', 'units per case', 'pack qty', 'case qty', 'pack', 'units per outer'],
  rrp: ['rrp', 'retail price', 'srp', 'rsp'],
  sku: ['product code', 'item code', 'stock code', 'supplier code', 'code', 'sku', 'part number', 'ref', 'reference'],
  brand: ['brand', 'manufacturer', 'make'],
  stock: ['stock', 'in stock', 'available', 'qty available', 'free stock', 'availability'],
};
export const FIELD_LABEL = { code: 'Barcode (EAN/UPC)', title: 'Description', cost: 'Price', pack: 'Pack / case size', rrp: 'RRP', sku: 'Their product code', brand: 'Brand', stock: 'Stock' };

function findColumns(header) {
  const h = header.map(normHeader);
  const used = new Set(); const map = {};
  for (const [field, names] of Object.entries(PL_FIELDS)) {
    let i = h.findIndex((x, j) => !used.has(j) && names.includes(x));
    if (i < 0) i = h.findIndex((x, j) => !used.has(j) && x && names.some((n) => n.length > 3 && x.includes(n)));
    map[field] = i; if (i >= 0) used.add(i);
  }
  return map;
}

// A barcode as digits, or { bad } when Excel has turned it into a rounded number.
export function cleanCode(v) {
  const s = String(v ?? '').trim();
  if (!s) return { code: '' };
  if (/e\+?\d+$/i.test(s)) return { code: '', bad: s };
  const d = s.replace(/\.0+$/, '').replace(/[^0-9]/g, '');
  if (![8, 12, 13, 14].includes(d.length)) return { code: '', bad: d.length ? s : '' };
  return { code: d };
}

// grid (rows of cells) -> { headerIdx, header, map, lines }
export function readPriceList(grid, map0 = null) {
  let headerIdx = 0; let best = -1;
  for (let i = 0; i < Math.min(15, grid.length); i++) {
    const m = findColumns(grid[i] || []);
    const n = Object.values(m).filter((x) => x >= 0).length + (m.cost >= 0 ? 2 : 0) + (m.code >= 0 || m.title >= 0 ? 2 : 0);
    if (n > best) { best = n; headerIdx = i; }
  }
  const header = (grid[headerIdx] || []).map((c) => String(c ?? '').trim());
  const map = map0 || findColumns(header);
  const lines = [];
  grid.slice(headerIdx + 1).forEach((r, i) => {
    const g = (f) => (map[f] >= 0 ? r[map[f]] : '');
    const cost = parseMoney(g('cost'));
    const title = String(g('title') ?? '').trim();
    const c = cleanCode(g('code'));
    if (!title && !c.code && cost === null) return; // blank or a section heading
    lines.push({ i: headerIdx + 1 + i, code: c.code, badCode: c.bad || '', title, cost: cost === null ? null : Math.abs(cost),
      pack: Math.max(1, Math.round(parseMoney(g('pack')) || 1)), rrp: parseMoney(g('rrp')), sku: String(g('sku') ?? '').trim(), brand: String(g('brand') ?? '').trim(), stock: String(g('stock') ?? '').trim() });
  });
  return { headerIdx, header, map, lines };
}

// What a unit actually costs, from the line's price and the list's settings.
export const unitCost = (line, scan) => (line.cost === null ? null : scan.pricePer === 'case' && line.pack > 1 ? line.cost / line.pack : line.cost);

// 0–100: 45% profit (ROI at the supplier's price, 60% = full), 25% demand, 15% price stability, 15% competition,
// minus 20 if Amazon sells it, plus 5 if 2+ of your tracked storefronts already list it.
export function scoreLine(p, econ, { storefronts = 0 } = {}) {
  if (!p || !econ) return null;
  const prof = econ.roi === undefined || econ.roi === null ? 0 : Math.max(0, Math.min(1, econ.roi / 0.6));
  const dem = (demandScore(p) ?? 30) / 100;
  const stab = (priceStability(p) ?? 50) / 100;
  const offers = p.offerCount ?? 8;
  const comp = Math.max(0, Math.min(1, (20 - offers) / 17));
  let s = 45 * prof + 25 * dem + 15 * stab + 15 * comp;
  if (p.amazonOnListing) s -= 20;
  if (storefronts >= 2) s += 5;
  if ((econ.profit ?? 0) <= 0) s = Math.min(s, 15);
  return Math.round(Math.max(0, Math.min(100, s)));
}

// Everything the results table shows for one line.
export function evaluate(line, scan, product, outreachSettings, { vatRegistered = false, storefronts = 0 } = {}) {
  const cost = unitCost(line, scan);
  const s = { ...outreachSettings, supplierPricesIncVat: !!scan.pricesIncVat };
  const econ = product ? unitEconomics(product, cost, s, { vatRegistered }) : null;
  return { cost, econ, stability: product ? priceStability(product) : null, demand: product ? demandScore(product) : null, score: scoreLine(product, econ, { storefronts }) };
}
