// FBA Admin — bank categories and keyword rules. Pure.

export const CATEGORIES = {
  out: ['Stock Purchase', 'Prep Centre', 'Subscription', 'Software', 'Shipping', 'Packaging', 'Ad Spend', 'Professional Fees', 'Insurance', 'Bank Charges', 'Mileage / Travel', 'Other Expense', 'Director Loan', 'Transfer', 'Uncategorized'],
  in: ['Amazon Payout', 'eBay Payout', 'Refund Received', 'Director Loan', 'Income', 'Transfer'],
};
export const ALL_CATEGORIES = [...new Set([...CATEGORIES.out, ...CATEGORIES.in])];

// Not operating costs (stock is costed through COGS, payouts are already in the Amazon/eBay figures,
// loans and transfers are not income or expense). Everything else that's money out is an overhead,
// including ad spend paid by card (ads billed to your Amazon balance come from the settlement report instead).
export const EXCLUDED_FROM_PNL = new Set(['Stock Purchase', 'Amazon Payout', 'eBay Payout', 'Director Loan', 'Transfer']);

// keyword -> category, first match wins, so specific before general.
// Tuned to the payees on your Revolut Business statement; edit them on the Rules tab.
export const DEFAULT_RULES = [
  { keyword: 'amazon payments', category: 'Amazon Payout' },
  { keyword: 'ebay commerce', category: 'eBay Payout' },
  { keyword: 'dir loan', category: 'Director Loan' },
  { keyword: "director's loan", category: 'Director Loan' },
  { keyword: 'sellersmart', category: 'Prep Centre' },
  { keyword: 'sellertoolki', category: 'Subscription' },
  { keyword: 'seller amp', category: 'Subscription' },
  { keyword: 'selleramp', category: 'Subscription' },
  { keyword: 'keepa', category: 'Subscription' },
  { keyword: 'anthropic', category: 'Software' },
  { keyword: 'claude', category: 'Software' },
  { keyword: 'google', category: 'Software' },
  { keyword: 'microsoft', category: 'Software' },
  { keyword: 'revolut business fee', category: 'Bank Charges' },
  { keyword: 'simply business', category: 'Insurance' },
  { keyword: 'ups ltd', category: 'Shipping' },
  { keyword: 'royal mail', category: 'Shipping' },
  { keyword: 'parcelforce', category: 'Shipping' },
  { keyword: 'dpd', category: 'Shipping' },
  { keyword: 'evri', category: 'Shipping' },
  { keyword: 'amazon ads', category: 'Ad Spend' },
  { keyword: 'sharkninja', category: 'Stock Purchase' },
  { keyword: 'anylamp', category: 'Stock Purchase' },
  { keyword: 'currys', category: 'Stock Purchase' },
  { keyword: 'argos', category: 'Stock Purchase' },
  { keyword: 'costco', category: 'Stock Purchase' },
  { keyword: 'klarna', category: 'Director Loan' }, // personal financing repaid through the company
  { keyword: 'amazon.co.uk', category: 'Stock Purchase' },
  { keyword: 'amazon.co.uk', category: 'Refund Received' }, // money back from an Amazon purchase
];

const blob = (s) => String(s ?? '').toLowerCase().replace(/[\s\-_*•]+/g, ' ').trim();

export function suggestCategory(description, amount, rules = DEFAULT_RULES) {
  const b = blob(description);
  for (const r of rules) {
    if (r.keyword && b.includes(blob(r.keyword))) {
      // a money-in category never lands on money out, and vice versa (Transfer / Director Loan are both)
      const allowed = amount >= 0 ? CATEGORIES.in : CATEGORIES.out;
      if (allowed.includes(r.category)) return { category: r.category, source: 'rule', keyword: r.keyword };
    }
  }
  return { category: amount > 0 ? 'Income' : 'Uncategorized', source: 'default', keyword: '' };
}

// Strips the noise banks add so the same payee groups together:
// "CARD PAYMENT TO KEEPA.COM 14AUG £19.99" -> "keepa com", "Klarna*lw Enterprise" -> "klarna lw enterprise"
export function normaliseVendor(description) {
  return String(description ?? '').toLowerCase()
    .replace(/\b(card payment to|direct debit|dd|standing order|so|bp|payment to|purchase|visa|mastercard|contactless|money added from|ref[:.]?|on \d{1,2}\w*)\b/g, ' ')
    .replace(/\b\d{1,2}[a-z]{3}\d{0,4}\b/g, ' ')
    .replace(/[^a-z ]+/g, ' ')
    .trim().split(/\s+/).filter((w) => w.length > 2).slice(0, 3).join(' ');
}

// The keyword a "make this a rule" offer uses: the payee words, as specific as is still general.
export function ruleKeyword(description) {
  const s = String(description ?? '');
  const first = s.split(/[•|]/)[0].trim().toLowerCase().replace(/\s+/g, ' ');
  return first.length >= 3 ? first : normaliseVendor(s);
}

// Re-run rules over transactions. Rows the user set by hand are never touched.
export function recategorise(txns, rules) {
  const changed = [];
  for (const t of txns) {
    if (t.categorySource === 'manual') continue;
    const s = suggestCategory(t.description, t.amount, rules);
    if (s.category !== t.category || s.source !== t.categorySource) changed.push({ ...t, category: s.category, categorySource: s.source, ruleKeyword: s.keyword, updatedAt: new Date().toISOString() });
  }
  return changed;
}
