// FBA Admin — Amazon settlement / date range reports. Pure.
//
// SellerToolkit's order profit already includes every ORDER-level line (sale, referral, FBA fee, refund).
// So from settlements we keep only the ACCOUNT-level lines it doesn't see — storage, the Pro subscription,
// advertising billed through Amazon, removal/disposal, inbound/placement, other fees — plus reimbursements,
// and the payouts, which are matched against your bank.

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export const FEE_TYPES = ['Storage', 'Long-term storage', 'Seller subscription', 'Advertising', 'Removal & disposal', 'Inbound & placement', 'Other Amazon fee'];
export const INCOME_TYPES = ['Reimbursement', 'Liquidation'];

// -> { group: 'order'|'payout'|'reserve'|'fee'|'income', type }
export function classify({ type = '', description = '', amountType = '', orderId = '', amount = 0 }) {
  const t = String(type).toLowerCase(); const d = String(description).toLowerCase(); const a = String(amountType).toLowerCase();
  const blob = `${t} ${a} ${d}`;
  if (/^transfer$/.test(t) || /to account ending|successful charge|payable to amazon|disbursement/.test(blob)) return { group: 'payout', type: 'Payout' };
  if (/reserve/.test(blob)) return { group: 'reserve', type: 'Reserve' };
  if (/reimburs|warehouse_damage|warehouse_lost|missing_from_inbound|damaged:warehouse|lost:warehouse|compensated|safe-t/.test(blob) && amount > 0) return { group: 'income', type: 'Reimbursement' };
  if (/liquidat/.test(blob) && amount > 0) return { group: 'income', type: 'Liquidation' };
  // order-level lines: SellerToolkit already counts them
  if (orderId && /order|refund|chargeback|retrocharge|guarantee|itemprice|itemfees|promotion|principal|commission|fbaperunit/.test(blob)) return { group: 'order', type: 'Order' };
  if (/^(order|refund)$/.test(t)) return { group: 'order', type: 'Order' };
  if (/long.?term storage|aged inventory/.test(blob)) return { group: 'fee', type: 'Long-term storage' };
  if (/storage/.test(blob)) return { group: 'fee', type: 'Storage' };
  if (/subscription/.test(blob)) return { group: 'fee', type: 'Seller subscription' };
  if (/advertis|sponsored|cost of advertising|transactiontotalamount/.test(blob)) return { group: 'fee', type: 'Advertising' };
  if (/removal|disposal/.test(blob)) return { group: 'fee', type: 'Removal & disposal' };
  if (/inbound|placement|transportation|labeling|labelling|prep fee|polybag|bubblewrap|taping/.test(blob)) return { group: 'fee', type: 'Inbound & placement' };
  if (orderId) return { group: 'order', type: 'Order' };
  return { group: 'fee', type: 'Other Amazon fee' };
}

// Flat File V2: the first data row is the settlement summary (id, period, deposit date, total).
export function fromSettlementV2(rows, { rowKey, parseDate, money }) {
  const lines = []; const settlements = new Map();
  const seen = new Map();
  for (const r of rows) {
    const id = r.settlementId;
    if (!id) continue;
    if (r.totalAmount !== '' && r.totalAmount !== undefined && !r.amountDescription) {
      settlements.set(id, { id: `v2-${id}`, settlementId: id, start: parseDate(r.start), end: parseDate(r.end), depositDate: parseDate(r.depositDate), total: r2(money(r.totalAmount)), currency: r.currency || 'GBP', source: 'settlement' });
      continue;
    }
    const amount = r2(money(r.amount));
    if (!amount) continue;
    const c = classify({ type: r.type, description: r.amountDescription, amountType: r.amountType, orderId: r.orderId, amount });
    const postedDate = parseDate(r.postedDate);
    const base = [id, r.type, r.orderId, r.adjustmentId, r.sku, r.amountType, r.amountDescription, amount, postedDate].join('|');
    const n = (seen.get(base) || 0) + 1; seen.set(base, n);
    lines.push({ id: rowKey('stl', base, n), settlementId: id, date: postedDate, group: c.group, feeType: c.type, description: r.amountDescription || r.amountType || r.type, txType: r.type || '', orderId: r.orderId || '', sku: r.sku || '', amount });
  }
  return { lines, settlements: [...settlements.values()] };
}

// Date range report: one row per transaction with a signed total; Transfer rows are the payouts.
export function fromDateRange(rows, { rowKey, parseDate, money }) {
  const lines = []; const settlements = [];
  const seen = new Map();
  for (const r of rows) {
    const date = parseDate(r.date);
    const amount = r2(money(r.total));
    if (!date || !amount) continue;
    const c = classify({ type: r.type, description: r.description, orderId: r.orderId, amount });
    const base = [r.settlementId, date, r.type, r.orderId, r.sku, r.description, amount].join('|');
    const n = (seen.get(base) || 0) + 1; seen.set(base, n);
    if (c.group === 'payout') {
      settlements.push({ id: `dr-${rowKey(base, n)}`, settlementId: r.settlementId || '', start: '', end: '', depositDate: date, total: r2(-amount), currency: 'GBP', source: 'date range report' });
      continue;
    }
    lines.push({ id: rowKey('dr', base, n), settlementId: r.settlementId || '', date, group: c.group, feeType: c.type, description: r.description || r.type, txType: r.type || '', orderId: r.orderId || '', sku: r.sku || '', amount });
  }
  return { lines, settlements };
}

// Account-level fees and reimbursements in a period.
export function accountLines(fees, from, to) {
  const out = { feesTotal: 0, incomeTotal: 0, byType: {}, incomeByType: {} };
  for (const l of fees) {
    if (!l.date || l.date < from || l.date > to) continue;
    if (l.group === 'fee') { const cost = -l.amount; out.feesTotal += cost; out.byType[l.feeType] = (out.byType[l.feeType] || 0) + cost; }
    if (l.group === 'income') { out.incomeTotal += l.amount; out.incomeByType[l.feeType] = (out.incomeByType[l.feeType] || 0) + l.amount; }
  }
  out.feesTotal = r2(out.feesTotal); out.incomeTotal = r2(out.incomeTotal);
  for (const k of Object.keys(out.byType)) out.byType[k] = r2(out.byType[k]);
  for (const k of Object.keys(out.incomeByType)) out.incomeByType[k] = r2(out.incomeByType[k]);
  return out;
}

// Each Amazon payout matched to a bank line: same amount (to the penny), banked 0–7 days after the deposit date.
export function reconcilePayouts(settlements, txns) {
  const bank = txns.filter((t) => t.category === 'Amazon Payout' && t.amount > 0).sort((a, b) => a.date.localeCompare(b.date));
  const used = new Set();
  const day = (d) => Date.parse(`${d}T00:00:00Z`) / 864e5;
  const rows = [...settlements].filter((s) => s.total > 0).sort((a, b) => (a.depositDate || '').localeCompare(b.depositDate || '')).map((s) => {
    const m = bank.find((t) => !used.has(t.id) && Math.abs(t.amount - s.total) < 0.005 && day(t.date) - day(s.depositDate) >= -1 && day(t.date) - day(s.depositDate) <= 7);
    if (m) used.add(m.id);
    return { ...s, bankId: m?.id || '', bankDate: m?.date || '', matched: !!m };
  });
  const from = rows[0]?.depositDate; const to = rows.at(-1)?.depositDate;
  const unexplained = from ? bank.filter((t) => !used.has(t.id) && t.date >= from && t.date <= to) : [];
  return { rows, unmatched: rows.filter((r) => !r.matched), unexplained, window: from ? { from, to } : null };
}
