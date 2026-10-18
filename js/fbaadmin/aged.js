// FBA Admin — aged stock and Amazon's aged inventory surcharge. Pure.
// Ages come from Amazon's FBA Inventory (inventory health) report when you've imported one; otherwise they're
// estimated from the inventory ledger's receipt dates (oldest units assumed sold first) and your purchase dates.

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const D = (s) => new Date(`${s}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => iso(new Date(D(s).getTime() + n * 864e5));
const daysBetween = (a, b) => Math.round((D(b) - D(a)) / 864e5);

// UK rate card effective 1 February 2026: £ per cubic foot per month (the last two tiers have a per-unit minimum).
// Not charged on clothing & accessories, footwear, rucksacks & handbags, luggage, jewellery & watches.
export const AIS_TIERS = [
  { from: 241, to: 270, perCuFt: 1.18, label: '241–270 days' },
  { from: 271, to: 300, perCuFt: 3.14, label: '271–300 days' },
  { from: 301, to: 330, perCuFt: 3.26, label: '301–330 days' },
  { from: 331, to: 365, perCuFt: 3.41, label: '331–365 days' },
  { from: 366, to: 455, perCuFt: 5.71, perUnitMin: 0.20, label: '365–455 days' },
  { from: 456, to: Infinity, perCuFt: 6.14, perUnitMin: 0.25, label: 'over 455 days' },
];
export const AIS_FIRST_DAY = 241;
export const AIS_SOURCE = 'Amazon Europe FBA rate card, effective 1 Feb 2026 (UK)';

export const tierFor = (age) => AIS_TIERS.find((t) => age >= t.from && age <= t.to) || null;
export function monthlyFee(age, units, cuFtPerUnit) {
  const t = tierFor(age);
  if (!t || !units) return 0;
  const byVol = cuFtPerUnit ? units * cuFtPerUnit * t.perCuFt : 0;
  const byUnit = t.perUnitMin ? units * t.perUnitMin : 0;
  return r2(Math.max(byVol, byUnit));
}

const toCuFt = (vol, unit) => {
  const v = Number(vol); if (!v) return null;
  return /cm|centi/i.test(unit || '') ? v / 28316.8466 : /m3|metre|meter/i.test(unit || '') && !/centi/i.test(unit) ? v * 35.3147 : v;
};

// Inventory health rows → one record per SKU (the report is a snapshot; the newest import replaces older ones).
export function healthRecords(rows, { parseDate = (x) => x } = {}) {
  const n = (v) => Number(String(v ?? '').replace(/[^0-9.-]/g, '')) || 0;
  return rows.filter((r) => r.sku).map((r) => ({
    id: r.sku, sku: r.sku, asin: r.asin || '', title: r.title || '', snapshotDate: parseDate(r.snapshotDate) || '',
    available: n(r.available),
    ages: { '0-90': n(r.a0_90) || n(r.a0_30) + n(r.a31_60) + n(r.a61_90), '91-180': n(r.a91_180), '181-270': n(r.a181_270), '271-365': n(r.a271_365), '365+': n(r.a365plus) },
    amazonAis: r2(['ais241', 'ais271', 'ais301', 'ais331', 'ais365'].reduce((a, k) => a + n(r[k]), 0)),
    cuFt: toCuFt(r.itemVolume, r.volumeUnit), storageType: r.storageType || '', recommendedAction: r.recommendedAction || '', daysOfSupply: n(r.daysOfSupply) || null,
  }));
}

// FIFO estimate: what's at Amazon now is the newest stock. Walk receipts newest → oldest until the sellable count is used up.
export function fifoLots({ ledger = [], stock = [], asOf, sellableBySku }) {
  const receipts = {};
  for (const l of ledger) if (l.receipts > 0) (receipts[l.sku] ||= []).push({ date: l.date, qty: l.receipts, from: 'ledger receipt' });
  const firstLedger = ledger.reduce((m, l) => (!m || l.date < m ? l.date : m), '');
  for (const s of stock) {
    // purchases before the ledger window stand in for receipts we can't see
    if (s.datePurchased && (!firstLedger || s.datePurchased < firstLedger)) (receipts[s.sku] ||= []).push({ date: s.datePurchased, qty: s.quantity, from: 'purchase date' });
  }
  const out = {};
  for (const [sku, units] of Object.entries(sellableBySku)) {
    let left = units; const lots = [];
    for (const r of (receipts[sku] || []).sort((a, b) => b.date.localeCompare(a.date))) {
      if (left <= 0) break;
      const q = Math.min(left, r.qty); lots.push({ date: r.date, qty: q, age: daysBetween(r.date, asOf), from: r.from }); left -= q;
    }
    if (left > 0) lots.push({ date: firstLedger || null, qty: left, age: firstLedger ? daysBetween(firstLedger, asOf) : null, from: 'older than your data', minimum: true });
    out[sku] = lots;
  }
  return out;
}

// One row per SKU with units by age band, when the surcharge starts, and the estimated monthly cost.
// opts: { asOf, health (from healthRecords), sellableBySku, ledger, stock, titles, avgCost, warnDays }
export function agedReport({ asOf, health = [], sellableBySku = {}, ledger = [], stock = [], titles = {}, avgCost = {}, warnDays = 60 }) {
  const rows = [];
  if (health.length) {
    const snap = health.reduce((m, h) => (h.snapshotDate > m ? h.snapshotDate : m), '');
    for (const h of health) {
      const a = h.ages; const total = Object.values(a).reduce((x, y) => x + y, 0);
      if (!total) continue;
      // buckets are coarse: 181–270 units may already be past day 241, so treat them as "in or near the fee"
      const charged = a['271-365'] + a['365+'];
      const soon = a['181-270'];
      const estFee = h.cuFt ? r2(monthlyFee(300, a['271-365'], h.cuFt) + monthlyFee(400, a['365+'], h.cuFt)) : (a['365+'] ? r2(a['365+'] * 0.20) : null);
      rows.push({
        sku: h.sku, asin: h.asin, title: titles[h.sku] || h.title || '', units: total, bands: a, charged, soon,
        oldestBand: a['365+'] ? '365+' : a['271-365'] ? '271-365' : a['181-270'] ? '181-270' : a['91-180'] ? '91-180' : '0-90',
        feeStarts: charged ? 'now' : soon ? 'within 90 days' : null, estMonthlyFee: h.amazonAis || estFee, feeFrom: h.amazonAis ? "Amazon's estimate" : h.cuFt ? 'rate card × volume' : (a['365+'] ? 'per-unit minimum' : null),
        cost: avgCost[h.sku] ? r2(avgCost[h.sku] * total) : null, costAtRisk: avgCost[h.sku] ? r2(avgCost[h.sku] * (charged + soon)) : 0, action: h.recommendedAction, method: 'Amazon inventory report', asOf: h.snapshotDate || snap,
      });
    }
  } else {
    const lots = fifoLots({ ledger, stock, asOf, sellableBySku });
    for (const [sku, ls] of Object.entries(lots)) {
      const units = ls.reduce((a, l) => a + l.qty, 0);
      if (!units) continue;
      const bands = { '0-90': 0, '91-180': 0, '181-270': 0, '271-365': 0, '365+': 0 };
      let firstFeeDate = null; let charged = 0; let soon = 0; let unknown = 0;
      for (const l of ls) {
        if (l.age === null) { unknown += l.qty; continue; }
        const k = l.age <= 90 ? '0-90' : l.age <= 180 ? '91-180' : l.age <= 270 ? '181-270' : l.age <= 365 ? '271-365' : '365+';
        bands[k] += l.qty;
        if (l.age >= AIS_FIRST_DAY) charged += l.qty;
        else { const d = addDays(l.date, AIS_FIRST_DAY); if (daysBetween(asOf, d) <= warnDays) soon += l.qty; if (!firstFeeDate || d < firstFeeDate) firstFeeDate = d; }
      }
      const oldest = ls.filter((l) => l.age !== null).reduce((m, l) => Math.max(m, l.age), 0);
      rows.push({
        sku, asin: '', title: titles[sku] || '', units, bands, charged, soon, unknown, oldestAge: oldest, lots: ls,
        oldestBand: bands['365+'] ? '365+' : bands['271-365'] ? '271-365' : bands['181-270'] ? '181-270' : bands['91-180'] ? '91-180' : '0-90',
        feeStarts: charged ? 'now' : firstFeeDate, estMonthlyFee: charged ? r2(ls.filter((l) => l.age >= AIS_FIRST_DAY).reduce((a, l) => a + monthlyFee(l.age, l.qty, null), 0)) || null : null,
        feeFrom: charged ? 'per-unit minimum (import the FBA Inventory report for volume)' : null,
        cost: avgCost[sku] ? r2(avgCost[sku] * units) : null, costAtRisk: avgCost[sku] ? r2(avgCost[sku] * (charged + soon)) : 0, method: 'Estimate from ledger receipts and purchase dates', asOf,
      });
    }
  }
  rows.sort((a, b) => (b.charged - a.charged) || (b.soon - a.soon) || String(a.feeStarts || 'z').localeCompare(String(b.feeStarts || 'z')));
  const flagged = rows.filter((r) => r.charged || r.soon);
  return {
    rows, flagged, method: health.length ? 'Amazon inventory report' : 'estimate', asOf,
    totals: { charged: rows.reduce((a, r) => a + r.charged, 0), soon: rows.reduce((a, r) => a + r.soon, 0), estMonthlyFee: r2(rows.reduce((a, r) => a + (r.estMonthlyFee || 0), 0)), costAtRisk: r2(rows.reduce((a, r) => a + (r.costAtRisk || 0), 0)) },
  };
}
