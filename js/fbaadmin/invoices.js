// FBA Admin — invoices & receipts. Pure helpers (naming, link suggestions, missing-receipt check).
// Files are kept in the extension (as data: URLs, so they travel in backups) and/or uploaded to
// Google Drive under FBA Accounting/Invoices/YYYY/MM Month/.

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// "Klarna*lw Enterprise" -> "KlarnaLwEnterprise" (NFKD, non-word stripped, max 30 chars)
export function slugVendor(v) {
  return String(v || 'Unknown').normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^A-Za-z0-9]+/).filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1)).join('').slice(0, 30) || 'Unknown';
}

// {YYYY-MM-DD}_{Vendor}_£{Amount}_{Type}.{ext}, safe on Windows and in Drive
export function invoiceName({ date, vendor, amount, type, ext = 'pdf' }) {
  const t = String(type || 'Expense').replace(/[^A-Za-z0-9]+/g, '');
  const name = `${date || 'undated'}_${slugVendor(vendor)}_£${r2(Math.abs(amount)).toFixed(2)}_${t}.${ext}`;
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '');
}

// Never overwrite: "name.pdf" -> "name-2.pdf" while it exists.
export function uniqueName(name, taken) {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name; const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}${ext}`)) return `${base}-${i}${ext}`;
}

export const drivePath = (date) => {
  const [y, m] = String(date || new Date().toISOString().slice(0, 10)).split('-');
  return ['FBA Accounting', 'Invoices', y, `${m} ${MONTHS[Number(m) - 1] || ''}`.trim()];
};

// Best candidates to attach an invoice to: same amount (±1p), within 10 days; bank lines and stock purchases.
export function suggestLinks({ date, amount }, txns, stock) {
  const amt = Math.abs(Number(amount) || 0);
  const d0 = date ? Date.parse(`${date}T00:00:00Z`) : null;
  const near = (d) => (d0 && d ? Math.abs(Date.parse(`${d}T00:00:00Z`) - d0) / 864e5 : 999);
  const out = [];
  for (const t of txns) {
    if (t.amount >= 0) continue;
    const diff = Math.abs(-t.amount - amt);
    if (amt && diff <= 0.01 && near(t.date) <= 10) out.push({ kind: 'txn', id: t.id, date: t.date, label: `${t.description} · £${(-t.amount).toFixed(2)}`, score: near(t.date) });
  }
  for (const s of stock) {
    const diff = Math.abs(s.totalCost - amt);
    if (amt && diff <= 0.01 && near(s.datePurchased) <= 10) out.push({ kind: 'stock', id: s.id, date: s.datePurchased, label: `${s.productName} × ${s.quantity} · £${s.totalCost.toFixed(2)}`, score: near(s.datePurchased) });
  }
  return out.sort((a, b) => a.score - b.score).slice(0, 6);
}

// Costs that should have paperwork but don't: bank money out in P&L or stock categories over a threshold.
export function missingReceipts(txns, invoices, { from = '2000-01-01', to = '2100-01-01', min = 10, categories = null } = {}) {
  const linked = new Set(invoices.filter((i) => i.linkedTo?.kind === 'txn').map((i) => i.linkedTo.id));
  const skip = new Set(['Amazon Payout', 'eBay Payout', 'Director Loan', 'Transfer', 'Bank Charges']);
  const rows = txns.filter((t) => t.amount < 0 && -t.amount >= min && t.date >= from && t.date <= to && !skip.has(t.category) && (!categories || categories.includes(t.category)) && !linked.has(t.id));
  return { rows, total: r2(rows.reduce((a, t) => a - t.amount, 0)) };
}
