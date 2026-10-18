// FBA Returns tracker — domain model. Pure: no browser, store or network dependencies.
// The unit of account is ONE physical returned item. Every cost and credit belongs to a unit.

export const STATUSES = [
  { id: 'returned_at_amazon', label: 'Returned at Amazon', group: 'At Amazon', location: 'Amazon FC', terminal: false },
  { id: 'relisted_by_amazon', label: 'Auto-relisted by Amazon', group: 'Closed', location: 'Amazon FC', terminal: true },
  { id: 'removal_requested', label: 'Removal requested', group: 'At Amazon', location: 'Amazon FC', terminal: false },
  { id: 'in_transit_to_prep', label: 'In transit to prep', group: 'In transit', location: 'In transit', terminal: false },
  { id: 'at_prep', label: 'At prep centre', group: 'At prep', location: 'Prep centre', terminal: false },
  { id: 'listed_ebay', label: 'Listed on eBay', group: 'For sale', location: 'Prep centre', terminal: false },
  { id: 'sold_ebay', label: 'Sold on eBay', group: 'Sold', location: 'Prep centre', terminal: false },
  { id: 'despatched_ebay', label: 'Despatched (eBay)', group: 'Closed', location: 'With buyer', terminal: true },
  { id: 'inbound_fba_used', label: 'Inbound to FBA as Used', group: 'In transit', location: 'In transit', terminal: false },
  { id: 'live_amazon_used', label: 'Live on Amazon as Used', group: 'For sale', location: 'Amazon FC', terminal: false },
  { id: 'sold_amazon_used', label: 'Sold on Amazon Used', group: 'Closed', location: 'With buyer', terminal: true },
  { id: 'written_off', label: 'Written off / disposed', group: 'Closed', location: 'Disposed', terminal: true },
];
export const STATUS = Object.fromEntries(STATUSES.map((s) => [s.id, s]));

// Legal moves. Deliberately permissive sideways (back to prep, reopen a closed unit),
// but never skips a stage that carries a cost.
export const NEXT_STATUS = {
  returned_at_amazon: ['removal_requested', 'relisted_by_amazon', 'written_off'],
  relisted_by_amazon: ['returned_at_amazon', 'removal_requested'],
  removal_requested: ['in_transit_to_prep', 'returned_at_amazon', 'written_off'],
  in_transit_to_prep: ['at_prep', 'written_off'],
  at_prep: ['listed_ebay', 'inbound_fba_used', 'written_off'],
  listed_ebay: ['sold_ebay', 'at_prep', 'written_off'],
  sold_ebay: ['despatched_ebay', 'listed_ebay', 'at_prep'],
  despatched_ebay: ['at_prep'],
  inbound_fba_used: ['live_amazon_used', 'at_prep', 'written_off'],
  live_amazon_used: ['sold_amazon_used', 'at_prep', 'written_off'],
  sold_amazon_used: ['live_amazon_used', 'at_prep'],
  written_off: ['at_prep', 'returned_at_amazon'],
};

export const DISPOSITIONS = ['SELLABLE', 'DEFECTIVE', 'CUSTOMER_DAMAGED', 'CARRIER_DAMAGED', 'DAMAGED', 'EXPIRED', 'WAREHOUSE_DAMAGED', 'DISPOSED', 'UNKNOWN'];

export const COST_BUCKETS = [
  { id: 'cogs', label: 'COGS', basis: true },
  { id: 'inboundOriginal', label: 'Original inbound', basis: true },
  { id: 'returnProcessingFee', label: 'Return processing fee', basis: false },
  // Amazon refunds most of the referral fee on a return, but keeps the FBA fulfilment fee for sending it out
  { id: 'outboundFee', label: 'Outbound FBA fee (kept by Amazon)', basis: false },
  { id: 'removalFee', label: 'Removal fee', basis: false },
  { id: 'prepFee', label: 'Prep / grading', basis: false },
  { id: 'storageFee', label: 'Storage at prep', basis: false },
  { id: 'onwardShipping', label: 'Postage to buyer', basis: false },
  { id: 'reInboundShipping', label: 'Re-inbound to Amazon', basis: false },
  { id: 'otherCost', label: 'Other cost', basis: false },
];
export const SALE_FEES = [
  { id: 'finalValueFee', label: 'Final value / referral fee' },
  { id: 'fulfilmentFee', label: 'Fulfilment fee' },
  { id: 'adFee', label: 'Ad fee' },
  { id: 'otherFee', label: 'Other fee' },
];
export const CHANNELS = { ebay: 'eBay', 'amazon-used': 'Amazon Used' };

// "£4.32", "-4.32", "(4.32)", "1,234.50" -> number; anything unreadable -> 0
export function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  let s = String(v ?? '').trim();
  if (!s) return 0;
  const neg = /^\(.*\)$/.test(s) || /^[-−–]/.test(s);
  s = s.replace(/[^0-9.]/g, '');
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return 0;
  return neg ? -n : n;
}
// Rounded at write time so stored values are always pence-exact.
export const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const today = () => new Date().toISOString().slice(0, 10);

export function emptyCosts() {
  return Object.fromEntries(COST_BUCKETS.map((b) => [b.id, 0]));
}
export function emptyFees() {
  return Object.fromEntries(SALE_FEES.map((f) => [f.id, 0]));
}

// Constructor and authoritative default for every field.
export function emptyUnit(seed = {}) {
  const now = new Date().toISOString();
  const u = {
    id: seed.id || (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `u-${Date.now()}-${Math.random().toString(36).slice(2)}`),
    lpn: '', returnDate: '', orderId: '', sku: '', asin: '', fnsku: '', title: '',
    disposition: 'UNKNOWN', reason: '', amazonStatus: '',
    status: 'returned_at_amazon', statusDate: seed.returnDate || today(), history: [],
    costs: emptyCosts(), reimbursement: 0, sale: null,
    refs: { removalOrderId: '', shipmentId: '', ebayItemId: '', ebayOrderId: '', amazonOrderId: '', tracking: '' },
    notes: '', applied: [], dedupeKey: '',
    createdAt: now, updatedAt: now,
    ...seed,
  };
  u.costs = { ...emptyCosts(), ...(seed.costs || {}) };
  u.refs = { removalOrderId: '', shipmentId: '', ebayItemId: '', ebayOrderId: '', amazonOrderId: '', tracking: '', ...(seed.refs || {}) };
  return u;
}

export function emptySale(channel = 'ebay') {
  return { channel, date: today(), orderRef: '', price: 0, shippingCollected: 0, fees: emptyFees() };
}

export function normDisposition(v) {
  const s = String(v || '').toUpperCase().replace(/[^A-Z]+/g, '_').replace(/^_|_$/g, '');
  return DISPOSITIONS.includes(s) ? s : (s ? (s.includes('SELLABLE') && !s.includes('UN') ? 'SELLABLE' : s.includes('DAMAGE') ? 'DAMAGED' : s.includes('DEFECT') ? 'DEFECTIVE' : 'UNKNOWN') : 'UNKNOWN');
}

export function canMove(from, to) {
  return (NEXT_STATUS[from] || []).includes(to);
}

// Returns a new unit; never mutates.
export function transition(unit, to, { date = today(), note = '' } = {}) {
  if (!STATUS[to]) throw new Error(`Unknown status ${to}`);
  if (unit.status === to) return unit;
  return {
    ...unit,
    status: to,
    statusDate: date,
    history: [...(unit.history || []), { from: unit.status, to, date, note }],
    updatedAt: new Date().toISOString(),
  };
}

// The only place money is computed.
export function pnl(unit) {
  const c = { ...emptyCosts(), ...(unit.costs || {}) };
  let costBasis = 0;
  let returnCosts = 0;
  for (const b of COST_BUCKETS) {
    if (b.basis) costBasis += num(c[b.id]); else returnCosts += num(c[b.id]);
  }
  const sale = unit.sale;
  let saleFees = 0;
  let netSale = 0;
  if (sale) {
    for (const f of SALE_FEES) saleFees += num(sale.fees?.[f.id]);
    netSale = num(sale.price) + num(sale.shippingCollected) - saleFees;
  }
  const reimbursement = num(unit.reimbursement);
  const netRecovery = netSale + reimbursement - returnCosts;
  const netVsCost = netRecovery - costBasis;
  return {
    costBasis: r2(costBasis),
    returnCosts: r2(returnCosts),
    saleFees: r2(saleFees),
    netSale: r2(netSale),
    reimbursement: r2(reimbursement),
    netRecovery: r2(netRecovery),
    netVsCost: r2(netVsCost),
    recoveryRate: costBasis > 0 ? netRecovery / costBasis : null,
  };
}

export function outcome(unit) {
  const s = STATUS[unit.status];
  if (!s?.terminal) return 'open';
  const p = pnl(unit);
  if (unit.status === 'relisted_by_amazon') return 'relisted';
  if (unit.status === 'written_off') return 'written_off';
  return p.netVsCost >= 0 ? 'recovered' : 'loss';
}

export function daysOpen(unit, now = today()) {
  const start = unit.returnDate || unit.createdAt?.slice(0, 10);
  if (!start) return null;
  const end = STATUS[unit.status]?.terminal ? (unit.statusDate || now) : now;
  const d = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 864e5;
  return Number.isFinite(d) ? Math.max(0, Math.round(d)) : null;
}

// Sums the same figures across a set, plus counts by status / disposition / channel.
export function rollup(units) {
  const t = { units: units.length, open: 0, settled: 0, costBasis: 0, returnCosts: 0, netSale: 0, reimbursement: 0, netRecovery: 0, netVsCost: 0, byStatus: {}, byDisposition: {}, byChannel: {}, byOutcome: {}, noCogs: 0 };
  for (const u of units) {
    const p = pnl(u);
    t.costBasis += p.costBasis; t.returnCosts += p.returnCosts; t.netSale += p.netSale;
    t.reimbursement += p.reimbursement; t.netRecovery += p.netRecovery; t.netVsCost += p.netVsCost;
    if (STATUS[u.status]?.terminal) t.settled++; else t.open++;
    t.byStatus[u.status] = (t.byStatus[u.status] || 0) + 1;
    t.byDisposition[u.disposition] = (t.byDisposition[u.disposition] || 0) + 1;
    if (u.sale) t.byChannel[u.sale.channel] = (t.byChannel[u.sale.channel] || 0) + 1;
    const o = outcome(u); t.byOutcome[o] = (t.byOutcome[o] || 0) + 1;
    if (!num(u.costs?.cogs)) t.noCogs++;
  }
  for (const k of ['costBasis', 'returnCosts', 'netSale', 'reimbursement', 'netRecovery', 'netVsCost']) t[k] = r2(t[k]);
  t.recoveryRate = t.costBasis > 0 ? t.netRecovery / t.costBasis : null;
  return t;
}

// Statuses each kind of report line may allocate against (stage-appropriate sets).
export const STAGE = {
  removal: ['returned_at_amazon', 'relisted_by_amazon'],
  removalShipment: ['removal_requested'],
  atAmazon: ['returned_at_amazon', 'relisted_by_amazon', 'removal_requested'],
  prep: ['at_prep', 'listed_ebay', 'in_transit_to_prep', 'sold_ebay', 'inbound_fba_used'],
  ebaySale: ['listed_ebay', 'at_prep'],
  usedSale: ['live_amazon_used', 'inbound_fba_used'],
  anyOpen: STATUSES.filter((s) => !s.terminal).map((s) => s.id),
};
