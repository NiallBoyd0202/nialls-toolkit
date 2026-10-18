// FBA Returns tracker — the flat ledger: one row per unit (CSV export and the Google Sheets Returns tab). Pure.
import { STATUS, COST_BUCKETS, SALE_FEES, CHANNELS, pnl, outcome, daysOpen, r2 } from './model.js';

export const OUTCOMES = { open: 'Open', recovered: 'Recovered cost', loss: 'Lost money', relisted: 'Relisted by Amazon', written_off: 'Written off' };

export const LEDGER_HEADER = ['Unit id', 'LPN', 'SKU', 'ASIN', 'Title', 'Return date', 'Order id', 'Disposition', 'Reason', 'Status', 'Status date', 'Days open', 'Outcome',
  ...COST_BUCKETS.map((b) => b.label), 'Reimbursement', 'Sale channel', 'Sale date', 'Sale order', 'Sale price', 'Shipping collected', ...SALE_FEES.map((f) => f.label),
  'Cost basis', 'Return costs', 'Net sale', 'Net recovery', 'Net vs cost', 'Recovery rate', 'Removal order', 'Tracking', 'eBay item', 'eBay order', 'Notes'];
export function ledgerRows(units) {
  return [LEDGER_HEADER, ...units.map((u) => {
    const p = pnl(u);
    return [u.id, u.lpn, u.sku, u.asin, u.title, u.returnDate, u.orderId, u.disposition, u.reason, STATUS[u.status]?.label, u.statusDate, daysOpen(u), OUTCOMES[outcome(u)],
      ...COST_BUCKETS.map((b) => r2(u.costs[b.id])), r2(u.reimbursement), u.sale ? CHANNELS[u.sale.channel] : '', u.sale?.date || '', u.sale?.orderRef || '', u.sale ? r2(u.sale.price) : '', u.sale ? r2(u.sale.shippingCollected) : '',
      ...SALE_FEES.map((f) => (u.sale ? r2(u.sale.fees?.[f.id]) : '')), p.costBasis, p.returnCosts, p.netSale, p.netRecovery, p.netVsCost, p.recoveryRate === null ? '' : r2(p.recoveryRate * 100) + '%',
      u.refs?.removalOrderId, u.refs?.tracking, u.refs?.ebayItemId, u.refs?.ebayOrderId, u.notes];
  })];
}

