// Retailer & wholesaler outreach: settings, stages, default email templates, storage helpers.
import * as db from '../db.js';

export const SETTINGS_KEY = 'outreachSettings';

// The pipeline, in order. "Declined" sits outside it.
export const STAGES = [
  ['to_contact', 'To contact'],
  ['emailed', 'Emailed'],
  ['replied', 'Replied'],
  ['account', 'Account open'],
  ['ordering', 'Ordering'],
];
export const DECLINED = ['declined', 'Declined / not a fit'];
export const STAGE_LABEL = Object.fromEntries([...STAGES, DECLINED]);
export const STAGE_ORDER = Object.fromEntries([...STAGES, DECLINED].map(([id], i) => [id, i]));
export const SUPPLIER_TYPES = ['Wholesaler', 'Distributor', 'Brand / manufacturer', 'Retailer', 'Other'];

export const DEFAULT_SETTINGS = {
  myName: '', myCompany: 'NBOYD GROUP LTD', myEmail: '', myPhone: '', myWebsite: '',
  followUpDays: 5,          // chase a supplier this many days after emailing with no reply
  targetRoi: 0.3,           // what "worth buying" means, for the max buy price
  prepPerUnit: 0.5,         // prep centre per unit £
  inboundPerUnit: 0.4,      // shipping to Amazon per unit £
  defaultFbaFee: 3.2,       // when Keepa has no FBA fee for a product
  defaultReferralPct: 0.15, // when Keepa has no referral fee
  supplierPricesIncVat: false, // wholesale price lists are usually ex VAT
};

export async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await db.kvGet(SETTINGS_KEY, {})) };
}
export async function saveSettings(patch) {
  const cur = await getSettings();
  const s = { ...cur, ...patch, savedAt: Date.now() };
  await db.kvSet(SETTINGS_KEY, s, { fields: db.changedFields(cur, patch) });
  return s;
}

// Fixed ids, so two devices setting these up don't end up with two copies of each.
export const DEFAULT_TEMPLATES = [
  {
    id: 'tpl-account', name: 'Open a trade account',
    subject: 'Trade account enquiry – {{myCompany}}',
    body: `Hi {{contactFirst}},

I'm {{myName}} from {{myCompany}}, a UK online retailer selling on Amazon. We'd like to open a trade account with {{company}} and start stocking {{brands}}.

Could you send your wholesale price list, minimum order and account application form? The lines we're most interested in are:
{{products}}

We pay promptly and can usually place a first order within a week of the account being opened.

Many thanks,
{{myName}}
{{myCompany}}
{{myPhone}}
{{myEmail}}`,
  },
  {
    id: 'tpl-followup', name: 'Follow-up (no reply yet)',
    subject: 'Re: Trade account enquiry – {{myCompany}}',
    body: `Hi {{contactFirst}},

Just following up on my email of {{lastEmailDate}} about opening a trade account with {{company}} for {{brands}}.

If there's someone else I should speak to about wholesale accounts, I'd be grateful if you could point me in the right direction.

Thanks again,
{{myName}}
{{myCompany}}
{{myPhone}}`,
  },
  {
    id: 'tpl-brand', name: 'Approach the brand directly',
    subject: 'Stocking {{brand}} on Amazon UK',
    body: `Hi {{contactFirst}},

I'm {{myName}} from {{myCompany}}. We sell on Amazon UK and would like to stock {{brand}}, buying either from you directly or through your approved UK distributor.

We look after listings carefully: correct images and descriptions, prices kept at or above RRP, and fast, well-reviewed delivery through Amazon's fulfilment network.

Could you let me know how to become a stockist, or which distributor to contact?

Kind regards,
{{myName}}
{{myCompany}}
{{myPhone}}
{{myEmail}}`,
  },
  {
    id: 'tpl-pricelist', name: 'Ask for an updated price list',
    subject: 'Updated price list – account {{accountNumber}}',
    body: `Hi {{contactFirst}},

Could you send your latest price list and stock availability for {{brands}}? We're planning our next order and are particularly interested in:
{{products}}

Our account number is {{accountNumber}}.

Thanks,
{{myName}}
{{myCompany}}`,
  },
];

export async function ensureTemplates() {
  const have = await db.getAll('orTemplates');
  if (have.length) return have;
  // stamped as old as possible: an edited copy synced from another device always wins over these
  await db.rawApply({ orTemplates: { put: DEFAULT_TEMPLATES.map((t) => ({ ...t, isDefault: true, _mt: 1 })) } });
  return db.getAll('orTemplates');
}

export async function loadOutreach() {
  const [suppliers, leads, links, activity, templates, settings] = await Promise.all([
    db.getAll('orSuppliers'), db.getAll('orLeads'), db.getAll('orLinks'), db.getAll('orActivity'), ensureTemplates(), getSettings(),
  ]);
  return { suppliers, leads, links, activity, templates, settings };
}

export const newId = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
export const brandKey = (b) => String(b || '').trim().toLowerCase().replace(/\s+/g, ' ');
