// FBA Admin — recurring costs found in the bank. Pure.
// Group money out by payee and exact amount, then judge the gaps between payments.
// Nothing is a subscription until you confirm it; detection only suggests.

import { normaliseVendor } from './categories.js';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const day = (d) => Date.parse(`${d}T00:00:00Z`) / 864e5;
const iso = (n) => new Date(n * 864e5).toISOString().slice(0, 10);

// "Gocardless • SELLERTOOLKI-PS763" -> "Sellertoolki": drop the payment processor, mandate references and SHOUTING.
export function prettyPayee(description) {
  const parts = String(description || '').split(/[•|]/).map((x) => x.trim()).filter(Boolean);
  let name = parts.length > 1 && /^(gocardless|paypal|stripe|sumup|direct debit)/i.test(parts[0]) ? parts[1] : (parts[0] || '');
  name = name.replace(/[-\s]+(?=[A-Z0-9]*\d)[A-Z0-9]{3,}$/i, '').trim() || name;
  if (name === name.toUpperCase() && /[A-Z]{3}/.test(name)) name = name.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
  return name;
}

export const FREQS = { Monthly: { perYear: 12, days: [24, 38], every: 30.4 }, Quarterly: { perYear: 4, days: [80, 100], every: 91 }, Annual: { perYear: 1, days: [330, 400], every: 365 } };

function frequencyOf(dates) {
  if (dates.length < 2) return null;
  const gaps = dates.slice(1).map((d, i) => day(d) - day(dates[i]));
  const mean = gaps.reduce((a, g) => a + g, 0) / gaps.length;
  for (const [f, v] of Object.entries(FREQS)) if (mean >= v.days[0] && mean <= v.days[1]) return f;
  return null;
}

// txns: bank transactions. Transfers, stock and director's loan are never subscriptions.
export function detectSubscriptions(txns, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const skip = new Set(['Stock Purchase', 'Director Loan', 'Transfer', 'Amazon Payout', 'eBay Payout']);
  const groups = new Map();
  for (const t of txns) {
    if (t.amount >= 0 || skip.has(t.category)) continue;
    const vendor = normaliseVendor(t.description) || t.description.toLowerCase();
    const k = `${vendor}|${(-t.amount).toFixed(2)}`;
    const g = groups.get(k) || { vendor, amount: r2(-t.amount), dates: [], description: t.description, category: t.category };
    g.dates.push(t.date); g.description = t.description; g.category = t.category;
    groups.set(k, g);
  }
  const found = [];
  for (const g of groups.values()) {
    g.dates.sort();
    const frequency = frequencyOf(g.dates);
    if (!frequency) continue;
    const last = g.dates.at(-1);
    const nextDue = iso(day(last) + FREQS[frequency].every);
    // "Gocardless • SELLERTOOLKI-PS763": the payment processor isn't the payee
    const name = prettyPayee(g.description);
    found.push({
      key: `${g.vendor}|${g.amount.toFixed(2)}|${frequency}`, vendor: g.vendor, name, description: g.description,
      amount: g.amount, frequency, occurrences: g.dates.length, firstSeen: g.dates[0], lastSeen: last, nextDue,
      overdue: day(today) - day(nextDue) > 7, category: g.category, annual: r2(g.amount * FREQS[frequency].perYear),
    });
  }
  // price changes: an older group for the same payee that stopped when a newer one started
  for (const s of found) {
    const older = found.filter((o) => o.vendor === s.vendor && o !== s && o.lastSeen < s.firstSeen);
    if (older.length) { const o = older.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))[0]; s.priceChange = { from: o.amount, to: s.amount, since: s.firstSeen }; o.replacedBy = s.key; }
  }
  return found.sort((a, b) => b.annual - a.annual);
}

// Merge detection with what you confirmed or dismissed before (stored in faSubscriptions).
export function mergeSubscriptions(detected, saved) {
  const byKey = new Map(saved.map((s) => [s.id, s]));
  const out = detected.map((d) => ({ ...d, id: d.key, active: byKey.get(d.key)?.active ?? null, dismissed: !!byKey.get(d.key)?.dismissed, category: byKey.get(d.key)?.category || d.category, note: byKey.get(d.key)?.note || '' }));
  // keep confirmed ones that no longer show up in the bank data (e.g. older statements removed)
  for (const s of saved) if (!out.some((o) => o.id === s.id) && s.active) out.push({ ...s, stale: true });
  const confirmed = out.filter((s) => s.active && !s.replacedBy && !s.dismissed);
  return { all: out, confirmed, candidates: out.filter((s) => s.active === null && !s.dismissed && !s.replacedBy), annual: r2(confirmed.reduce((a, s) => a + s.annual, 0)), monthly: r2(confirmed.reduce((a, s) => a + s.annual / 12, 0)) };
}
