// Keepa API client with token-aware retries, plus a demo backend with sample data.
import { sleep, chunk } from './util.js';
import { kvGet, kvSet } from './db.js';

const BASE = 'https://api.keepa.com';

export class KeepaClient {
  constructor(key, { onTokens } = {}) {
    this.key = key;
    this.onTokens = onTokens || (() => {});
    this.tokensLeft = null;
    this.refillRate = null;
    this.refillIn = null;
    this.cancelled = false;
    this.demo = false;
    this.used = 0;
  }

  cancel() { this.cancelled = true; }
  resetCancel() { this.cancelled = false; }

  _update(data) {
    if (!data) return;
    if (typeof data.tokensLeft === 'number') this.tokensLeft = data.tokensLeft;
    if (typeof data.refillRate === 'number') this.refillRate = data.refillRate;
    if (typeof data.refillIn === 'number') this.refillIn = data.refillIn;
    if (typeof data.tokensConsumed === 'number') this.used += data.tokensConsumed;
    this.onTokens({ tokensLeft: this.tokensLeft, refillRate: this.refillRate, refillIn: this.refillIn, waiting: false });
  }

  async _waitMs(ms, reason) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (this.cancelled) throw new Error('Cancelled');
      this.onTokens({ tokensLeft: this.tokensLeft, refillRate: this.refillRate, waiting: true, waitLeft: until - Date.now(), reason });
      await sleep(Math.min(1000, until - Date.now()));
    }
  }

  async _request(path, params) {
    if (!this.key) throw new Error('No Keepa API key set — add one in Settings (or switch on demo mode).');
    const qs = new URLSearchParams({ key: this.key, ...params });
    for (let attempt = 0; attempt < 8; attempt++) {
      if (this.cancelled) throw new Error('Cancelled');
      // Keepa only processes a request while the balance is positive.
      if (this.tokensLeft !== null && this.tokensLeft <= 0 && this.refillRate) {
        const needed = 1 - this.tokensLeft;
        const ms = Math.ceil((needed / this.refillRate) * 60000) + 1500;
        await this._waitMs(ms, 'Waiting for Keepa tokens to refill');
      }
      let res;
      try {
        res = await fetch(`${BASE}/${path}?${qs.toString()}`);
      } catch {
        if (attempt < 3) { await this._waitMs(3000, 'Network error, retrying'); continue; }
        throw new Error('Could not reach Keepa — check your internet connection.');
      }
      let data = null;
      try { data = await res.json(); } catch { /* ignore */ }
      this._update(data);
      if (res.status === 429) {
        const ms = (data && data.refillIn) || 60000;
        await this._waitMs(ms + 1000, 'Out of Keepa tokens — waiting for refill');
        continue;
      }
      if (res.status === 401 || res.status === 403) throw new Error('Keepa rejected the API key — check it in Settings.');
      if (res.status === 402) throw new Error('Keepa says payment is required — is your API subscription active?');
      if (!res.ok) throw new Error((data && data.error && data.error.message) || `Keepa error (HTTP ${res.status})`);
      if (data && data.error) throw new Error(data.error.message || data.error.type || 'Keepa returned an error');
      return data;
    }
    throw new Error('Keepa kept refusing the request — try again later.');
  }

  async tokenStatus() {
    const data = await this._request('token', {});
    return { tokensLeft: data.tokensLeft, refillRate: data.refillRate, refillIn: data.refillIn };
  }

  // Seller info + storefront ASIN list (10 tokens).
  async seller(domain, sellerId) {
    const data = await this._request('seller', { domain, seller: sellerId, storefront: 1 });
    return (data.sellers || {})[sellerId] || null;
  }

  // Product details with current stats (1 token per product, up to 100 per call).
  async products(domain, asins, { statsDays = 90 } = {}) {
    const out = [];
    for (const group of chunk(asins, 100)) {
      const data = await this._request('product', { domain, asin: group.join(','), stats: statsDays, history: 0 });
      out.push(...(data.products || []));
    }
    return out;
  }

  // Products by barcode (EAN / UPC), up to 100 codes per call: about 1 token per product found.
  async productsByCode(domain, codes, { statsDays = 90 } = {}) {
    const out = [];
    for (const group of chunk(codes, 100)) {
      const data = await this._request('product', { domain, code: group.join(','), stats: statsDays, history: 0 });
      out.push(...(data.products || []));
    }
    return out;
  }

  // Search by words (for price list lines with no barcode). Costs more than a barcode lookup: about 10 tokens.
  async searchProducts(domain, term, { statsDays = 90 } = {}) {
    const data = await this._request('search', { domain, type: 'product', term, stats: statsDays, history: 0, page: 0 });
    return data.products || [];
  }
}

// ---------------------------------------------------------------------------
// Demo backend — same interface, fictional data, no tokens spent.
// ---------------------------------------------------------------------------

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed) {
  let s = seed || 1;
  return () => { s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x6d2b79f5) >>> 0; return (s % 100000) / 100000; };
}
const ALPH = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
function fakeAsin(r) { let s = 'B0'; for (let i = 0; i < 8; i++) s += ALPH[Math.floor(r() * ALPH.length)]; return s; }

export const DEMO_SELLERS = [
  ['A1DEMONORTHFIELD', 'Northfield Trading (demo)'],
  ['A2DEMOBRIGHTSIDE', 'Brightside Deals UK (demo)'],
  ['A3DEMOKESTRELCO', 'Kestrel & Co (demo)'],
  ['A4DEMOHARBOURBAY', 'Harbour Bay Supplies (demo)'],
];
const ADJ = ['Premium', 'Compact', 'Heavy Duty', 'Rechargeable', 'Stainless Steel', 'Foldable', 'Wireless', 'Non-Stick', 'LED', 'Waterproof', 'Kids', 'Professional', 'Eco', 'Magnetic', 'Insulated'];
const NOUN = ['Desk Lamp', 'Garlic Press', 'Bike Light Set', 'Storage Boxes (Pack of 6)', 'Kettle 1.7L', 'Hair Clipper', 'Water Bottle 750ml', 'Phone Holder', 'Frying Pan 28cm', 'Torch', 'Building Blocks Set', 'Dog Lead', 'Electric Toothbrush Heads (8)', 'Tool Kit 40pc', 'Bath Towel Set', 'Board Game', 'Shower Head', 'Lunch Box', 'Air Fryer Liners (100)', 'Vacuum Flask'];
const CATS = ['Home & Kitchen', 'Toys & Games', 'DIY & Tools', 'Sports & Outdoors', 'Health & Personal Care', 'Pet Supplies', 'Beauty', 'Electronics & Photo', 'Garden', 'Baby'];
const BRANDS = ['Arvo', 'Brindle', 'Calder', 'Dunmore', 'Elsby', 'Fenwick Home', 'Glenhaven', 'Holloway', 'Ivers', 'Juniper & Co'];

function demoProduct(asin, domain = 2) {
  const r = rng(hash(asin));
  const title = `${BRANDS[Math.floor(r() * BRANDS.length)]} ${ADJ[Math.floor(r() * ADJ.length)]} ${NOUN[Math.floor(r() * NOUN.length)]}`;
  const cents = Math.round((6 + r() * 60) * 100);
  const bsr = Math.floor(200 + Math.pow(r(), 2) * 180000);
  const offers = 1 + Math.floor(r() * 14);
  const amazon = r() < 0.18 ? cents + Math.round(r() * 150) : -1;
  const cat = CATS[Math.floor(r() * CATS.length)];
  const avg = Math.round(cents * (0.9 + r() * 0.25));
  const swing = r() < 0.3 ? 0.35 : 0.08; // some demo products have jumpy prices
  const lo = Math.round(avg * (1 - swing * r())); const hi = Math.round(avg * (1 + swing * r()));
  const pair = (v) => [Math.floor(Date.now() / 60000) - 21564000, v];
  const minMax = (v) => Array.from({ length: 19 }, (_, i) => (i === 1 || i === 18 ? pair(v) : -1));
  return {
    asin,
    domainId: domain,
    title,
    brand: title.split(' ')[0],
    imagesCSV: '',
    categoryTree: [{ catId: 1, name: cat }],
    monthlySold: bsr < 30000 ? Math.round((50 + r() * 900) / 50) * 50 : (bsr < 80000 ? 50 : null),
    stats: {
      current: [amazon, cents, -1, bsr, -1, -1, -1, -1, -1, -1, cents, offers, 0, 0, 0, 0, 44, 120, cents],
      avg90: [amazon, avg, -1, Math.round(bsr * 1.1), -1, -1, -1, -1, -1, -1, -1, offers, 0, 0, 0, 0, 44, 120, avg],
      avg30: [amazon, Math.round((avg + cents) / 2), -1, Math.round(bsr * 1.02), -1, -1, -1, -1, -1, -1, -1, offers, 0, 0, 0, 0, 44, 120, Math.round((avg + cents) / 2)],
      avg180: [amazon, Math.round(avg * (0.95 + r() * 0.1)), -1, Math.round(bsr * 1.2), -1, -1, -1, -1, -1, -1, -1, offers, 0, 0, 0, 0, 44, 120, Math.round(avg * (0.95 + r() * 0.1))],
      minInInterval: minMax(lo),
      maxInInterval: minMax(hi),
      buyBoxPrice: cents,
      salesRankDrops30: Math.max(0, Math.round(40 - Math.log(bsr) * 3 + r() * 10)),
    },
  };
}

export class DemoKeepa {
  constructor({ onTokens } = {}) {
    this.onTokens = onTokens || (() => {});
    this.tokensLeft = 1200;
    this.refillRate = 20;
    this.cancelled = false;
    this.demo = true;
    this.used = 0;
  }
  cancel() { this.cancelled = true; }
  resetCancel() { this.cancelled = false; }
  async _spend(n) {
    if (this.cancelled) throw new Error('Cancelled');
    await sleep(120 + Math.random() * 180);
    this.used += n;
    this.tokensLeft = Math.max(0, 1200 - (this.used % 1200));
    this.onTokens({ tokensLeft: this.tokensLeft, refillRate: this.refillRate, waiting: false, demo: true });
  }
  async tokenStatus() { return { tokensLeft: this.tokensLeft, refillRate: this.refillRate, refillIn: 3000 }; }

  async seller(domain, sellerId) {
    await this._spend(10);
    const known = DEMO_SELLERS.find((s) => s[0] === sellerId);
    const r = rng(hash(sellerId));
    const st = (await kvGet('demoState')) || { storefronts: {} };
    let list = st.storefronts[sellerId];
    if (!list) {
      list = Array.from({ length: 25 + Math.floor(r() * 60) }, () => fakeAsin(r));
      // demo sellers share a pool of products so "listed by 2+ storefronts" shows up
      for (let i = 0; i < 5; i++) list.push(fakeAsin(rng(hash('shared' + ((hash(sellerId) + i) % 9)))));
    } else {
      // each refresh: a few new listings, sometimes a shared "hot" one, sometimes one drops off
      const r2 = rng(Date.now() ^ hash(sellerId));
      const add = 1 + Math.floor(r2() * 4);
      for (let i = 0; i < add; i++) list.unshift(fakeAsin(r2));
      if (r2() < 0.5) list.unshift(fakeAsin(rng(hash('hot' + new Date().getDate()))));
      if (r2() < 0.5 && list.length > 10) list.splice(5 + Math.floor(r2() * (list.length - 6)), 1);
      list = [...new Set(list)];
    }
    st.storefronts[sellerId] = list;
    await kvSet('demoState', st);
    return {
      sellerId,
      sellerName: known ? known[1] : `Seller ${sellerId.slice(-5)} (demo)`,
      domainId: domain,
      ratingCount: [12, 40, 160, 400 + Math.floor(r() * 4000)],
      positiveRating: [100, 98, 97, 90 + Math.floor(r() * 10)],
      hasFBA: true,
      asinList: list,
      asinListLastSeen: list.map(() => Math.floor(Date.now() / 60000) - 21564000),
    };
  }

  async products(domain, asins) {
    await this._spend(asins.length);
    return asins.map((a) => demoProduct(a, domain));
  }

  // Demo: about 3 in 4 barcodes are "found", each on a made-up product carrying that barcode.
  async productsByCode(domain, codes) {
    const found = codes.filter((c) => hash(`code${c}`) % 4 !== 0);
    await this._spend(found.length);
    return found.map((c) => ({ ...demoProduct(fakeAsin(rng(hash(`asin${c}`))), domain), eanList: [String(c)] }));
  }

  async searchProducts(domain, term) {
    await this._spend(10);
    const r = rng(hash(term));
    return Array.from({ length: 1 + Math.floor(r() * 3) }, () => demoProduct(fakeAsin(r), domain));
  }
}
