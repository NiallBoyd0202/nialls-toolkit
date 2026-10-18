// Supplier price lists — storage and finding each line on Amazon (Keepa).
//   ssScans    one record per price list you've loaded (supplier, file, how prices are given)
//   ssResults  one record per line, with the ASIN it matched (by barcode, by name, or by you)
//   ssMatches  barcode → ASIN, shared by every list and synced, so a barcode is only ever paid for once
import * as db from '../db.js';
import { keepa, getProducts } from '../services.js';
import { summariseProduct, chunk } from '../util.js';

const DOMAIN = 2; // Amazon UK
const NOT_FOUND_DAYS = 30; // ask Keepa again about a barcode it didn't know after this long

export const newScanId = () => `pl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export async function saveScan(scan, lines) {
  await db.put('ssScans', scan);
  await db.putMany('ssResults', lines.map((l) => ({ key: `${scan.id}:${l.i}`, scanId: scan.id, ...l, asin: '', matchType: l.code ? 'pending' : 'nocode', alternatives: [] })));
}
export const allScans = () => db.getAll('ssScans');
export const scanResults = (id) => db.getAllByIndex('ssResults', 'byScan', id);
export async function updateScan(scan) { await db.put('ssScans', scan); }
export async function deleteScan(id) {
  await db.delMany('ssResults', (await scanResults(id)).map((r) => r.key));
  await db.del('ssScans', id);
}

// Barcodes not looked up yet, and how many Keepa tokens finding them will take (about 1 each).
export async function barcodeBudget(scanId) {
  const res = await scanResults(scanId);
  const codes = [...new Set(res.filter((r) => r.code && r.matchType === 'pending').map((r) => r.code))];
  let known = 0;
  for (const c of codes) { const m = await db.get('ssMatches', c); if (m && (m.asin || Date.now() - m.at < NOT_FOUND_DAYS * 864e5)) known++; }
  return { codes: codes.length, toLookUp: codes.length - known };
}

// Looks every pending barcode up (cached ones free), then loads details for matched products that have none.
export async function matchBarcodes(scanId, { onProgress = () => {} } = {}) {
  const res = await scanResults(scanId);
  const codes = [...new Set(res.filter((r) => r.code && r.matchType === 'pending').map((r) => r.code))];
  const known = new Map();
  for (const c of codes) { const m = await db.get('ssMatches', c); if (m && (m.asin || Date.now() - m.at < NOT_FOUND_DAYS * 864e5)) known.set(c, m); }
  const todo = codes.filter((c) => !known.has(c));
  const k = await keepa();
  let done = 0;
  for (const group of chunk(todo, 100)) {
    onProgress(done / Math.max(1, todo.length), `Finding ${done + 1}–${Math.min(todo.length, done + group.length)} of ${todo.length} barcodes on Amazon…`);
    const raw = await k.productsByCode(DOMAIN, group);
    const want = new Set(group); const found = new Map(); const sums = [];
    for (const p of raw) {
      const s = summariseProduct(p, DOMAIN); if (!s) continue;
      sums.push(s);
      for (const code of [...(p.eanList || []), ...(p.upcList || [])].map(String)) if (want.has(code)) { if (!found.has(code)) found.set(code, []); found.get(code).push(s); }
    }
    await db.putMany('products', sums);
    // several listings for one barcode (multipacks, duplicates): the best-selling one, the others kept as alternatives
    const writes = group.map((code) => { const list = (found.get(code) || []).sort((a, b) => (a.bsr || 9e9) - (b.bsr || 9e9)); return { code, asin: list[0]?.asin || '', alternatives: list.slice(1).map((x) => x.asin), at: Date.now() }; });
    await db.putMany('ssMatches', writes);
    for (const w of writes) known.set(w.code, w);
    done += group.length;
  }
  const upd = res.filter((r) => r.code && r.matchType === 'pending' && known.has(r.code)).map((r) => {
    const m = known.get(r.code);
    return { ...r, asin: m.asin, matchType: m.asin ? 'barcode' : 'notfound', alternatives: m.alternatives || [] };
  });
  await db.putMany('ssResults', upd);
  // matched earlier (cached barcode) but with no product details on this device yet
  const asins = [...new Set(upd.filter((r) => r.asin).map((r) => r.asin))];
  const missing = [];
  for (const a of asins) if (!(await db.get('products', `${DOMAIN}:${a}`))) missing.push(a);
  if (missing.length) await getProducts(DOMAIN, missing, { maxAgeHours: 24 * 365, onProgress: (d, t) => onProgress(d / t, `Loading details for ${t} products…`) });
  onProgress(1, 'Done');
  return { lookedUp: todo.length, matched: upd.filter((r) => r.asin).length, notFound: upd.filter((r) => !r.asin).length };
}

// A line with no barcode (or none Keepa knows): search Amazon by its description. About 10 tokens.
export async function searchByName(r) {
  const term = [r.brand, r.title].filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 90);
  if (!term) throw new Error('This line has no description to search with');
  const raw = await (await keepa()).searchProducts(DOMAIN, term);
  const sums = raw.map((p) => summariseProduct(p, DOMAIN)).filter(Boolean);
  await db.putMany('products', sums);
  return sums.slice(0, 6);
}

export async function setMatch(r, asin, how) {
  await db.put('ssResults', { ...r, asin, matchType: asin ? how : (r.code ? 'notfound' : 'nocode') });
  if (asin && r.code && how === 'manual') await db.put('ssMatches', { code: r.code, asin, alternatives: [], at: Date.now(), byHand: true });
}

// The chosen lines into Retailer & wholesaler outreach: the supplier (found by name, or added), an ASIN lead for
// each product, linked with this list's price.
export async function sendToOutreach(scan, rows) {
  const { addLead } = await import('../views/outreach.js');
  const { newId } = await import('../outreach/store.js');
  const suppliers = await db.getAll('orSuppliers');
  let sup = suppliers.find((s) => s.id === scan.supplierId) || suppliers.find((s) => s.company.trim().toLowerCase() === String(scan.supplierName || '').trim().toLowerCase());
  if (!sup) {
    sup = { id: newId('sup'), company: scan.supplierName || 'Price list supplier', type: 'Wholesaler', stage: 'to_contact', addedAt: Date.now(), notes: `Added from the price list "${scan.name}"` };
    await db.put('orSuppliers', sup);
  }
  const links = await db.getAll('orLinks');
  let added = 0;
  for (const r of rows) {
    if (!r.asin) continue;
    const p = await db.get('products', `${DOMAIN}:${r.asin}`);
    const lead = await addLead({ type: 'asin', asin: r.asin, domain: DOMAIN, brand: p?.brand || r.brand || '', title: p?.title || r.title });
    const ex = links.find((l) => l.leadId === lead.id && l.supplierId === sup.id);
    await db.put('orLinks', { ...(ex || { id: newId('link'), addedAt: Date.now() }), leadId: lead.id, supplierId: sup.id, cost: r.unitCost, packSize: r.pack > 1 ? String(r.pack) : '', note: `${scan.name}${r.sku ? ` · their code ${r.sku}` : ''}`, prices: ex?.prices || {} });
    added++;
  }
  if (scan.supplierId !== sup.id) await updateScan({ ...scan, supplierId: sup.id, supplierName: sup.company });
  return { supplier: sup, added };
}
