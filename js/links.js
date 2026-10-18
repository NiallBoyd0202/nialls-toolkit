// Amazon links pasted or shared into the app (the iPhone has no "Track seller" button):
// a storefront or seller page → track it; a product page → add it to outreach leads.
import { parseSellerInput, domainFromHost } from './util.js';
import { addSeller } from './services.js';
import { toast, modal } from './ui.js';
import * as db from './db.js';
import { esc } from './util.js';

const ASIN_IN_PATH = /\/(?:dp|gp\/product|gp\/aw\/d|exec\/obidos\/asin|product)\/([A-Z0-9]{10})(?:[/?#]|$)/i;

// -> { kind: 'seller', sellerId, domain } | { kind: 'product', asin, domain } | { kind: 'short', url } | null
export function parseAmazonLink(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const url = (s.match(/https?:\/\/\S+/i) || [])[0] || '';
  let host = ''; let path = '';
  try { if (url) { const u = new URL(url); host = u.hostname; path = u.pathname; } } catch { /* not a URL */ }
  if (/(^|\.)amzn\.(eu|to|com)$|^a\.co$/i.test(host)) return { kind: 'short', url };
  // a product page wins, even when its address names the seller (…/dp/B0…?smid=A…)
  const dp = path.match(ASIN_IN_PATH);
  if (dp) return { kind: 'product', asin: dp[1].toUpperCase(), domain: domainFromHost(host) || 2 };
  const seller = parseSellerInput(url || s);
  if (seller) return { kind: 'seller', sellerId: seller.sellerId, domain: seller.domain || domainFromHost(host) || null };
  const m = s.match(/\b(B0[A-Z0-9]{8})\b/);
  if (m) return { kind: 'product', asin: m[1].toUpperCase(), domain: domainFromHost(host) || 2 };
  return null;
}

// Does whatever the link is for. Returns true if it recognised it.
export async function handleAmazonLink(text, { navigate = (h) => { location.hash = h; } } = {}) {
  const l = parseAmazonLink(text);
  if (!l) { toast("That isn't an Amazon storefront or product link", 'error', 6000); return false; }
  if (l.kind === 'short') {
    toast('That\'s a short amzn.eu link: open it, then copy the full address from the address bar (or the seller\'s storefront page) and paste that.', 'error', 9000);
    return false;
  }
  if (l.kind === 'seller') {
    const { existed } = await addSeller(l.sellerId, l.domain || 2, { source: 'link' });
    toast(existed ? 'You\'re already tracking that storefront' : 'Storefront added: importing it now', existed ? 'info' : 'success');
    window.dispatchEvent(new Event('nt:sellersChanged')); // the shell imports pending storefronts
    navigate('tracker/storefronts');
    return true;
  }
  // a product: offer it (or its brand, if Keepa has described it) as an outreach lead
  const p = await db.get('products', `${l.domain}:${l.asin}`);
  const add = async (lead) => {
    const { addLead } = await import('./views/outreach.js');
    await addLead(lead);
    toast(`${lead.type === 'brand' ? lead.brand : 'Product'} added to outreach leads`, 'success');
    navigate('outreach/leads');
  };
  modal({
    title: 'Add to outreach leads',
    body: `<p><b>${esc(p?.title || l.asin)}</b><br><span class="small muted mono">${esc(l.asin)}</span>${p?.brand ? ` <span class="small muted">· ${esc(p.brand)}</span>` : ''}</p><p class="small muted">Find a supplier for this product${p?.brand ? ', or for the whole brand' : ''}.${p ? '' : ' Its details load from Keepa next time you rank products.'}</p>`,
    actions: [
      { label: 'Cancel' },
      { label: 'This product', kind: p?.brand ? '' : 'primary', onClick: () => add({ type: 'asin', asin: l.asin, domain: l.domain, brand: p?.brand || '', title: p?.title || '' }) },
      ...(p?.brand ? [{ label: `The brand: ${p.brand.slice(0, 24)}`, kind: 'primary', onClick: () => add({ type: 'brand', brand: p.brand }) }] : []),
    ],
  });
  return true;
}

// Reads the clipboard (iPhone shows a "Paste" bubble to allow it). Returns the text or null.
export async function readClipboard() {
  try { return await navigator.clipboard.readText(); } catch { toast('Couldn\'t read the clipboard: long-press the box and choose Paste', 'error', 6000); return null; }
}
