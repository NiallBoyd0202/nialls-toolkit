// Feature registry: which IndexedDB stores and settings belong to which feature.
// db.js builds the database from this, and backup.js uses it for per-feature export / import.
//
// Adding a feature later = add an entry here (and bump DB_VERSION in db.js if it adds stores).
//
// store definition: { keyPath, autoIncrement?, indexes?: [[name, path]], refs?: [[otherStore, field]], merge?: fn }
//   refs    - other stores whose `field` points at this store's key. Used when an imported autoIncrement
//             id clashes with a different local record and has to be renumbered.
//   merge   - optional (local, incoming) => record, for stores whose records change without a timestamp.

export const FEATURES = [
  {
    id: 'settings',
    label: 'General settings',
    description: 'Keepa options, Discord, eBay fee estimate. Your Keepa API key is never exported.',
    kv: ['settings'],
    stores: {},
  },
  {
    id: 'tracker',
    label: 'Storefront tracker',
    description: 'Tracked storefronts, their product history and cached Keepa product details.',
    kv: ['demoState', 'lastFullRefresh'],
    stores: {
      sellers: { keyPath: 'key' },
      items: {
        keyPath: 'key',
        indexes: [['bySeller', 'sellerKey'], ['byFirstSeen', 'firstSeen'], ['byAsin', 'pkey']],
        // "reviewed" is set without a timestamp, so never lose a tick from either side.
        merge: (local, incoming, newer) => ({ ...newer, reviewed: !!(local.reviewed || incoming.reviewed) }),
      },
      products: { keyPath: 'key' },
      refreshLog: { keyPath: 'id', autoIncrement: true },
    },
  },
  {
    id: 'ebay',
    label: 'eBay profit tracker',
    description: 'Imported eBay sales, products with COGS, and import history.',
    kv: [],
    stores: {
      ebaySales: { keyPath: 'key', indexes: [['byImport', 'importId'], ['byOrderKey', 'orderKey'], ['byProduct', 'productKey']] },
      ebayProducts: { keyPath: 'key' },
      ebayImports: { keyPath: 'id', autoIncrement: true, refs: [['ebaySales', 'importId']] },
    },
  },
  {
    id: 'returns',
    label: 'FBA Returns tracker',
    description: 'Returned units with their costs, sales and history, SKU costs, import log and unmatched rows.',
    kv: ['returnsSettings'],
    stores: {
      rtUnits: { keyPath: 'id', indexes: [['byLpn', 'lpn'], ['bySku', 'sku'], ['byStatus', 'status'], ['byReturnDate', 'returnDate']] },
      rtSkuCosts: { keyPath: 'sku' },
      rtImports: { keyPath: 'id' },
      rtUnmatched: { keyPath: 'id' },
    },
  },
  {
    id: 'outreach',
    label: 'Retailer & wholesaler outreach',
    description: 'Supplier contacts and their pipeline, leads (brands and ASINs), which suppliers stock each lead and at what price, emails sent, follow-ups and email templates.',
    kv: ['outreachSettings'],
    stores: {
      orSuppliers: { keyPath: 'id' },
      orLeads: { keyPath: 'id' },
      orLinks: { keyPath: 'id', indexes: [['bySupplier', 'supplierId'], ['byLead', 'leadId']] },
      orActivity: { keyPath: 'id', indexes: [['bySupplier', 'supplierId']] },
      orTemplates: { keyPath: 'id' },
    },
  },
  {
    id: 'storescan',
    label: 'Store Scan',
    hidden: true, // not built yet: kept so the database layout and old backups stay compatible
    description: 'Retailer settings and discounts, scans and their results, barcode-to-ASIN matches, filter presets.',
    kv: ['storeScanSettings', 'storeScanPresets'],
    stores: {
      ssRetailers: { keyPath: 'id' },
      ssScans: { keyPath: 'id', indexes: [['byRetailer', 'retailerId']] },
      ssResults: { keyPath: 'key', indexes: [['byScan', 'scanId'], ['byAsin', 'asin']] },
      ssMatches: { keyPath: 'code' },
    },
  },
  {
    id: 'fbaadmin',
    label: 'FBA Admin',
    description: 'Sales, returns, Amazon fees, bank transactions and their categories, stock purchases, invoices, subscriptions, expenses (by hand, recurring and planned), director\'s loan entries, sold products (SellerToolkit), inventory ledger, inventory age, listings, Amazon sales dashboard, P&L snapshots, category rules and remembered column layouts.',
    kv: ['fbaAdminSettings', 'fbaChecklist', 'fbaMappings', 'fbaCategoryRules', 'fbaSalesDashboard'],
    stores: {
      faSales: { keyPath: 'id', indexes: [['byDate', 'orderDate'], ['bySku', 'sku']] },
      faReturns: { keyPath: 'id', indexes: [['byDate', 'returnDate']] },
      faFees: { keyPath: 'id', indexes: [['byDate', 'postedDate']] },
      faSettlements: { keyPath: 'id' },
      faTransactions: { keyPath: 'id', indexes: [['byDate', 'date']] },
      faStock: { keyPath: 'id', indexes: [['bySku', 'sku']] },
      faInvoices: { keyPath: 'id' },
      faSubscriptions: { keyPath: 'id' },
      faPnl: { keyPath: 'id' },
      faImportLog: { keyPath: 'id' },
      faSoldProducts: { keyPath: 'id', indexes: [['byDate', 'date'], ['bySku', 'sku']] },
      faStkExpenses: { keyPath: 'id', indexes: [['byDate', 'date']] },
      faLedger: { keyPath: 'id', indexes: [['byDate', 'date'], ['bySku', 'sku']] },
      faListings: { keyPath: 'id' },
      faSkuMap: { keyPath: 'asin' },
      faExpenses: { keyPath: 'id', indexes: [['byKind', 'kind']] },
      faInvHealth: { keyPath: 'id' },
      faDlaEntries: { keyPath: 'id' },
      faCashDays: { keyPath: 'id' },     // each day's safe-to-spend target, as worked out that morning
      faPayoutPreds: { keyPath: 'id' },  // what each Amazon payout was predicted to be, to check against what arrived
      faSpendLog: { keyPath: 'id' },     // spends logged on the go, until the bank statement shows them
    },
  },
];

// Fields that must never leave the browser in a backup file.
export const SECRETS = {
  settings: ['keepaKey'],
  returnsSettings: ['sheetToken'],
  fbaAdminSettings: ['googleToken', 'accessToken', 'googleClientSecret'],
  storeScanSettings: [],
};

export const KV_STORE = 'kv';
// Sync's record of deletions (store + key + when), so they reach your other devices. Not part of any backup.
export const TOMB_STORE = 'syncTomb';

export function feature(id) {
  return FEATURES.find((f) => f.id === id);
}

// { storeName: definition } across every feature, plus the shared kv store and sync's tombstones.
export function allStores() {
  const out = { [KV_STORE]: { keyPath: 'k' }, [TOMB_STORE]: { keyPath: 'id' } };
  for (const f of FEATURES) Object.assign(out, f.stores);
  return out;
}

export function featureOfStore(store) {
  return FEATURES.find((f) => store in f.stores) || null;
}

export function featureOfKv(k) {
  return FEATURES.find((f) => f.kv.includes(k)) || null;
}
