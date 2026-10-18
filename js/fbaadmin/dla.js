// FBA Admin — director's loan entries you add by hand (money put in or taken out outside the business bank). Pure.
// Positive = the company owes you more (you put money in); negative = it was repaid to you.

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export const DLA_TYPES = [['in', 'I put money in'], ['out', 'Repaid to me']];

export const entryTxns = (entries = []) => entries.map((e) => ({
  id: `dlae:${e.id}`, entryId: e.id, date: e.date, description: e.description || (e.type === 'out' ? 'Repaid to me' : 'Money I put in'),
  amount: r2((e.type === 'out' ? -1 : 1) * Math.abs(Number(e.amount) || 0)), category: 'Director Loan', manual: true, source: 'entry', note: e.note || '',
}));

// Where each movement came from, for the statement.
export function sourceOf(t) {
  if (t.source === 'entry') return 'entry';
  if (String(t.id).startsWith('dla:')) return 'personal';
  return 'bank';
}

// Balance by day (for the chart): a point per day from `from` to `to`.
export function balanceSeries(rows, opening, from, to) {
  const out = []; let i = 0; let bal = r2(opening);
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const step = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
  for (let d = from; d <= to; d = step(d)) {
    while (i < sorted.length && sorted[i].date <= d) bal = r2(bal + sorted[i++].amount);
    out.push({ date: d, balance: bal });
  }
  return out;
}
