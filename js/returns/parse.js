// FBA Returns tracker — report parsing. Pure: turns a grid of cells into { format, map, rows }.
// Knows nothing about units or storage, so it is reusable for any delimited report.

// lower-case, drop spaces / underscores / hyphens / dots / brackets / slashes
export const normKey = (s) => String(s ?? '').toLowerCase().replace(/[\s_\-.()[\]{}/\\:]+/g, '');

// Cell clean-up: trims, unwraps ="…" and =HYPERLINK("url","text") (SellerToolkit), strips stray quotes.
export function cleanCell(v) {
  let s = String(v ?? '').trim();
  // with its quotes, or with them already stripped by the CSV reader: =HYPERLINK(http://…,B0ABC12345)
  const hl = s.match(/^=HYPERLINK\(\s*"?([^",;]*)"?\s*[,;]\s*"?([^")]*)"?\s*\)$/i);
  if (hl) return hl[2].trim();
  const eq = s.match(/^="(.*)"$/);
  if (eq) return eq[1].trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1).trim();
  return s;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');
// Any report date -> 'YYYY-MM-DD', or '' if unreadable. Numeric dates are day-first (UK) unless
// order = 'mdy' (some Amazon CSVs, e.g. the inventory ledger, use 09/30/2026). See detectDateOrder().
export function parseDate(v, order = 'dmy') {
  const s = cleanCell(v);
  if (!s) return '';
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    const [d, mo] = order === 'mdy' ? [m[2], m[1]] : [m[1], m[2]];
    return `${y}-${pad(mo)}-${pad(d)}`;
  }
  m = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,9})[\s,-]+(\d{2,4})/);
  if (m) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mo) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${pad(mo)}-${pad(m[1])}`;
  }
  m = s.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) return `${m[3]}-${pad(MONTHS[m[1].slice(0, 3).toLowerCase()])}-${pad(m[2])}`;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : '';
}

// Looks at a column of numeric dates: any first part > 12 means day-first, any second part > 12 means
// month-first. Ambiguous columns use `fallback`.
export function detectDateOrder(values, fallback = 'dmy') {
  for (const v of values) {
    const m = cleanCell(v).match(/^(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}/);
    if (!m) continue;
    if (Number(m[1]) > 12) return 'dmy';
    if (Number(m[2]) > 12) return 'mdy';
  }
  return fallback;
}

// Format catalogue. Only amazon_returns creates units; the rest enrich existing ones.
// `hints` are the four distinguishing columns detection scores against.
export const FORMATS = [
  {
    id: 'amazon_returns', label: 'Amazon FBA customer returns', source: 'Seller Central → Reports → Fulfilment → Customer returns',
    required: ['sku'],
    hints: ['returndate', 'detaileddisposition', 'licenseplatenumber', 'fnsku'],
    fields: {
      returnDate: ['return-date', 'return date', 'returned date', 'date'],
      orderId: ['order-id', 'amazon-order-id', 'order id'],
      sku: ['sku', 'seller-sku', 'merchant-sku', 'msku'],
      asin: ['asin'],
      fnsku: ['fnsku'],
      title: ['product-name', 'product name', 'title'],
      quantity: ['quantity', 'qty'],
      disposition: ['detailed-disposition', 'disposition'],
      reason: ['reason', 'return-reason'],
      amazonStatus: ['status'],
      lpn: ['license-plate-number', 'licence-plate-number', 'license plate number', 'lpn'],
      comments: ['customer-comments', 'comments'],
    },
  },
  {
    id: 'amazon_removal_order', label: 'Amazon removal order detail', source: 'Reports → Fulfilment → Removal order detail',
    required: ['sku'],
    hints: ['removalfee', 'requestedquantity', 'ordertype', 'disposition'],
    fields: {
      requestDate: ['request-date', 'request date'],
      removalOrderId: ['order-id', 'removal-order-id', 'order id'],
      orderType: ['order-type', 'order type'],
      orderStatus: ['order-status', 'order status'],
      sku: ['sku', 'msku', 'seller-sku'],
      fnsku: ['fnsku'],
      disposition: ['disposition'],
      requestedQty: ['requested-quantity', 'requested quantity'],
      shippedQty: ['shipped-quantity', 'shipped quantity'],
      disposedQty: ['disposed-quantity', 'disposed quantity'],
      cancelledQty: ['cancelled-quantity', 'cancelled quantity'],
      removalFee: ['removal-fee', 'removal fee'],
    },
  },
  {
    id: 'amazon_removal_shipment', label: 'Amazon removal shipment detail', source: 'Reports → Fulfilment → Removal shipment detail',
    required: ['sku'],
    hints: ['shipmentdate', 'trackingnumber', 'shippedquantity', 'carrier'],
    fields: {
      requestDate: ['request-date', 'request date'],
      shipmentDate: ['shipment-date', 'shipment date'],
      removalOrderId: ['order-id', 'removal-order-id', 'order id'],
      sku: ['sku', 'msku', 'seller-sku'],
      fnsku: ['fnsku'],
      disposition: ['disposition'],
      shippedQty: ['shipped-quantity', 'shipped quantity', 'quantity'],
      carrier: ['carrier'],
      tracking: ['tracking-number', 'tracking number', 'tracking'],
    },
  },
  {
    id: 'amazon_reimbursements', label: 'Amazon reimbursements', source: 'Reports → Payments → Reimbursements',
    required: ['sku'],
    hints: ['reimbursementid', 'amountperunit', 'quantityreimbursedcash', 'approvaldate'],
    fields: {
      date: ['approval-date', 'approval date', 'date'],
      reimbursementId: ['reimbursement-id', 'reimbursement id'],
      orderId: ['amazon-order-id', 'order-id', 'order id'],
      reason: ['reason'],
      sku: ['sku', 'msku', 'seller-sku'],
      fnsku: ['fnsku'],
      asin: ['asin'],
      quantity: ['quantity-reimbursed-total', 'quantity-reimbursed-cash', 'quantity'],
      amountPerUnit: ['amount-per-unit', 'amount per unit'],
      amountTotal: ['amount-total', 'amount total', 'amount'],
    },
  },
  {
    id: 'amazon_transactions', label: 'Amazon payments transaction view', source: 'Reports → Payments → Transaction view (download)',
    required: [],
    hints: ['sellingfees', 'fbafees', 'productsales', 'total'],
    fields: {
      date: ['date/time', 'date time', 'date'],
      type: ['type'],
      orderId: ['order id', 'order-id'],
      sku: ['sku'],
      description: ['description'],
      quantity: ['quantity'],
      productSales: ['product sales'],
      sellingFees: ['selling fees'],
      fbaFees: ['fba fees'],
      otherFees: ['other transaction fees', 'other'],
      total: ['total'],
    },
  },
  {
    id: 'ebay_sales', label: 'eBay orders / sales', source: 'Seller Hub → Orders → Download report',
    required: [],
    hints: ['soldfor', 'customlabel', 'itemnumber', 'finalvaluefee'],
    fields: {
      saleDate: ['sale date', 'paid on date', 'transaction creation date', 'order creation date'],
      ebayOrderId: ['order number', 'order id'],
      ebayItemId: ['item number', 'item id'],
      sku: ['custom label', 'custom label (sku)', 'sku'],
      title: ['item title', 'title'],
      quantity: ['quantity'],
      price: ['sold for', 'item subtotal', 'sale price', 'price', 'item price'],
      shippingCollected: ['postage and packaging', 'shipping and handling', 'postage'],
      finalValueFee: ['final value fee', 'final value fee - variable', 'final value fee variable'],
      adFee: ['promoted listings fee', 'ad fee', 'promoted listing fee'],
      otherFee: ['other fee', 'final value fee - fixed', 'final value fee fixed'],
      postageCost: ['postage label cost', 'postage cost', 'label cost'],
      buyer: ['buyer username', 'buyer name'],
    },
  },
  {
    id: 'amazon_used_sales', label: 'Amazon Used sales (All Orders report)', source: 'Reports → Order reports → All orders, or your own export',
    required: ['sku'],
    hints: ['amazonorderid', 'itemprice', 'itemcondition', 'purchasedate'],
    fields: {
      saleDate: ['purchase-date', 'purchase date', 'date'],
      amazonOrderId: ['amazon-order-id', 'order id'],
      sku: ['sku'],
      asin: ['asin'],
      title: ['product-name', 'title'],
      condition: ['item-condition', 'condition'],
      quantity: ['quantity'],
      price: ['item-price', 'price'],
      shippingCollected: ['shipping-price', 'shipping'],
      referralFee: ['referral-fee', 'referral fee'],
      fbaFee: ['fba-fee', 'fba fee', 'fulfilment fee'],
      otherFee: ['other-fee', 'other fee'],
    },
  },
  {
    id: 'stk_cogs', label: 'SellerToolkit cost of goods', source: 'SellerToolkit → Cost of Goods V4 Detailed export',
    required: ['sku'],
    hints: ['unitcostvatinclusive', 'purchasedqty', 'deliveredqty', 'cogstatus'],
    fields: {
      sku: ['sku'],
      asin: ['asin'],
      title: ['title'],
      unitCostInc: ['unit_cost_vat_inclusive'],
      unitCostNet: ['unit_cost_net_of_vat'],
      deliveryInc: ['delivery_to_warehouse_cost_vat_inclusive'],
      deliveryNet: ['delivery_to_warehouse_cost_net_of_vat'],
      prepInc: ['prep_cost_vat_inclusive'],
      prepNet: ['prep_cost_net_of_vat'],
      purchasedQty: ['purchased_qty'],
      purchaseDate: ['purchase_date(dd/mm/yyyy)', 'purchase_date'],
      supplier: ['supplier'],
    },
  },
  {
    id: 'sku_costs', label: 'SKU costs (your own file)', source: 'A CSV with SKU and COGS columns',
    required: ['sku'],
    hints: ['cogs', 'sku', 'unitcost', 'inboundperunit'],
    fields: {
      sku: ['sku', 'seller sku', 'msku'],
      asin: ['asin'],
      title: ['title', 'product name'],
      cogs: ['cogs', 'unit cost', 'unitcost', 'cost'],
      inboundPerUnit: ['inbound per unit', 'inboundperunit', 'inbound'],
    },
  },
  {
    id: 'inbound_costs', label: 'Inbound shipment costs (your own file)', source: 'A CSV with shipment id, SKU, units and total cost',
    required: [],
    hints: ['shipmentid', 'units', 'totalcost', 'sku'],
    fields: {
      shipmentId: ['shipment id', 'shipmentid', 'shipment'],
      date: ['date'],
      sku: ['sku'],
      units: ['units', 'quantity'],
      totalCost: ['total cost', 'totalcost', 'cost'],
    },
  },
  {
    id: 'prep_costs', label: 'Prep centre invoice', source: 'Your prep centre invoice as CSV',
    required: [],
    hints: ['costtype', 'amount', 'lpn', 'reference'],
    fields: {
      date: ['date', 'invoice date'],
      lpn: ['lpn', 'license plate number', 'licence plate number'],
      sku: ['sku'],
      reference: ['reference', 'ref', 'order', 'tracking'],
      costType: ['cost type', 'costtype', 'type', 'description', 'service'],
      amount: ['amount', 'cost', 'total', 'price'],
    },
  },
];
export const FORMAT = Object.fromEntries(FORMATS.map((f) => [f.id, f]));

function scoreFormat(fmt, normHeaders) {
  const set = new Set(normHeaders);
  const hits = fmt.hints.filter((h) => set.has(normKey(h))).length;
  return hits / fmt.hints.length;
}

// Maps each canonical field to a raw header: exact normalised alias first, then substring.
export function autoMap(fmt, header) {
  const norm = header.map(normKey);
  const map = {};
  const used = new Set();
  for (const [field, aliases] of Object.entries(fmt.fields)) {
    let idx = -1;
    for (const a of aliases) { const i = norm.indexOf(normKey(a)); if (i >= 0 && !used.has(i)) { idx = i; break; } }
    if (idx < 0) {
      for (const a of aliases) {
        const na = normKey(a);
        if (na.length < 3) continue;
        const i = norm.findIndex((h, j) => !used.has(j) && h && (h.includes(na) || (na.includes(h) && h.length >= 4)));
        if (i >= 0) { idx = i; break; }
      }
    }
    map[field] = idx >= 0 ? header[idx] : '';
    if (idx >= 0) used.add(idx);
  }
  return map;
}

export function applyMap(rowObjects, map) {
  return rowObjects.map((ro) => {
    const r = { _raw: ro };
    for (const [field, h] of Object.entries(map)) r[field] = h ? cleanCell(ro[h]) : '';
    return r;
  });
}

// grid (array of arrays of cells) -> inspectable parse contract.
// `formats` lets another feature (FBA Admin) reuse the same reader with its own catalogue.
export function parseRows(grid, forcedFormatId = null, formats = FORMATS) {
  const byId = Object.fromEntries(formats.map((f) => [f.id, f]));
  const rows = (grid || []).map((r) => r.map((c) => String(c ?? ''))).filter((r) => r.some((c) => c.trim() !== ''));
  if (!rows.length) throw new Error('The file is empty');

  // Find the header row past banner rows: format score dominates, then the fullest row.
  let headerIdx = 0;
  let best = -1;
  for (let i = 0; i < Math.min(12, rows.length); i++) {
    const nh = rows[i].map((c) => normKey(cleanCell(c)));
    const fs = forcedFormatId ? scoreFormat(byId[forcedFormatId], nh) : Math.max(...formats.map((f) => scoreFormat(f, nh)));
    const s = fs * 100 + nh.filter(Boolean).length;
    if (s > best) { best = s; headerIdx = i; }
  }
  const header = rows[headerIdx].map((c) => cleanCell(c));
  const nh = header.map(normKey);
  const ranked = formats.map((f) => ({ id: f.id, label: f.label, score: scoreFormat(f, nh) })).sort((a, b) => b.score - a.score);
  const formatId = forcedFormatId || ranked[0].id;
  const format = byId[formatId];
  const confidence = forcedFormatId ? 1 : ranked[0].score;

  const rowObjects = rows.slice(headerIdx + 1).map((r) => Object.fromEntries(header.map((h, i) => [h || `col${i + 1}`, r[i] ?? ''])));
  const map = autoMap(format, header);
  const missing = format.required.filter((f) => !map[f]);
  return {
    format, formatId, confidence, header, headerIdx, map, missing,
    ranked: ranked.slice(0, 4),
    rowObjects,
    rows: applyMap(rowObjects, map),
    preamble: rows.slice(0, headerIdx), // banner rows above the header (e.g. a report's date range)
    formats,
  };
}

// Re-run after the user changes the format or a column, without re-reading the file.
export function remap(parsed, { formatId = parsed.formatId, map = null } = {}) {
  const format = (parsed.formats || FORMATS).find((f) => f.id === formatId);
  const m = map || (formatId === parsed.formatId ? parsed.map : autoMap(format, parsed.header));
  return { ...parsed, format, formatId, confidence: formatId === parsed.formatId ? parsed.confidence : 1, map: m, missing: format.required.filter((f) => !m[f]), rows: applyMap(parsed.rowObjects, m) };
}
