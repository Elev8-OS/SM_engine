import { q } from './db.js';
import { HttpError } from './util.js';
import { catalogId, waCatalogSettings, connectCatalog } from './wacatalog.js';
import { graph } from './meta.js';
import { elev8Tool } from './agent/clients.js';

// Product messages: a catalog product (or several) sent into a WhatsApp chat as an interactive message that shows the photo, title and
// price, with a button to open the product. Only inside the 24 hours after the guest's last message. This is the TEST of the way:
// does the sales number accept a product message from the engine (token permission, number registered for the API)?
//   GET /wa-catalog/send-test?to=<number with country code>&key=masurai&confirm=1        one villa (keys, comma separated: several villas)
// It sends exactly one message to the number you name, so use your own number, and write to the sales number first so the 24 hours are open.

const VERSION = process.env.META_GRAPH_VERSION || 'v25.0';
const digits = (s) => String(s || '').replace(/\D/g, '');

// The sales assistant sends a product message after its text reply when WA_PRODUCT_MESSAGES is on (off by default): the villa(s) whose
// booking page the reply links to. The text and the link stay, so a guest still gets the link if the product message is refused.
export const productMessagesOn = () => /^(true|1|yes|on)$/i.test(String(process.env.WA_PRODUCT_MESSAGES || '').replace(/["'\s]/g, ''));

/** The catalog products whose booking page (the path of the link) appears in a text. Pure; rows are { retailer_id, link }. At most 10. */
export function matchProducts(text, rows) {
  const paths = new Set();
  for (const m of String(text || '').match(/https?:\/\/[^\s)>\]]+/g) || []) {
    try {
      paths.add(new URL(m).pathname.replace(/\/+$/, ''));
    } catch {
      // not a link
    }
  }
  const out = [];
  for (const r of rows) {
    try {
      if (r.link && paths.has(new URL(r.link).pathname.replace(/\/+$/, '')) && !out.includes(r.retailer_id)) out.push(r.retailer_id);
    } catch {
      // a product without a usable link
    }
  }
  return out.slice(0, 10);
}

export async function productsInText(text) {
  const rows = await q(`select retailer_id, payload->>'link' as link from wa_catalog_items`);
  return matchProducts(text, rows);
}

/** The interactive object: one product, or a list (at most 10 villas here, WhatsApp allows 30). */
export function productInteractive(catalog, ids, text) {
  // One product needs no text (the card shows photo, title and price); a list needs one.
  if (ids.length === 1) return { type: 'product', ...(text ? { body: { text } } : {}), action: { catalog_id: catalog, product_retailer_id: ids[0] } };
  return { type: 'product_list', header: { type: 'text', text: 'Villas for your dates' }, body: { text }, action: { catalog_id: catalog, sections: [{ title: 'Villas', product_items: ids.slice(0, 10).map((id) => ({ product_retailer_id: id })) }] } };
}

/** Posts one product message (one product, or a list) to a number. Returns { ok, ... } and never throws on a refusal by Meta. */
export async function postProducts(to, ids, text) {
  const phoneId = waCatalogSettings().phoneId;
  const catalog = await catalogId();
  const token = process.env.META_ADS_TOKEN;
  if (!phoneId || !catalog || !token) throw new HttpError(409, 'META_WA_PHONE_ID, the catalog or META_ADS_TOKEN is missing');
  const num = digits(to);
  if (num.length < 8 || num.length > 15) throw new HttpError(400, 'to must be a phone number with country code, digits only');
  const body = { messaging_product: 'whatsapp', recipient_type: 'individual', to: num, type: 'interactive', interactive: productInteractive(catalog, ids, text) };
  const res = await fetch(`https://graph.facebook.com/${VERSION}/${phoneId}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = json?.error || {};
    return { ok: false, status: res.status, code: e.code, subcode: e.error_subcode, message: String(e.message || '').slice(0, 250), detail: String(e.error_data?.details || e.error_user_msg || '').slice(0, 250), products: ids };
  }
  return { ok: true, products: ids, to: `${num.slice(0, 4)}…${num.slice(-2)}`, messageId: json.messages?.[0]?.id ?? null };
}

export async function sendProductMessage({ to, keys, text }) {
  const rows = await q('select retailer_id, property_key from wa_catalog_items where property_key = any($1)', [keys]);
  if (!rows.length) throw new HttpError(404, 'No catalog product for these villas');
  return postProducts(to, rows.map((r) => r.retailer_id), text);
}

/**
 * Diagnosis of the catalog button in the WhatsApp chat: what Meta says about the number (name, status), whether the catalog is shown in
 * the chat (is_catalog_visible) and which catalogs are linked to the WhatsApp account. With fix (and confirm) it links the catalog again
 * and switches it visible, the same step as the first set-up. One short answer, because the probe keeps only the first part.
 */
export async function commerceState({ fix = false } = {}) {
  const s = waCatalogSettings();
  const catalog = await catalogId();
  const out = { catalog, phone: null, commerce: null, linked: null, errors: [] };
  const cut = (e) => String(e?.message || e).slice(0, 120);
  try {
    const p = await graph('GET', s.phoneId, { fields: 'display_phone_number,verified_name,name_status,quality_rating,platform_type,code_verification_status' });
    out.phone = `${p.display_phone_number} | ${p.verified_name} | name ${p.name_status} | ${p.platform_type} | ${p.code_verification_status} | quality ${p.quality_rating}`;
  } catch (e) {
    out.errors.push(`phone: ${cut(e)}`);
  }
  try {
    const c = await graph('GET', `${s.phoneId}/whatsapp_commerce_settings`);
    const x = c.data?.[0] ?? c;
    out.commerce = `catalog visible ${x.is_catalog_visible}, cart ${x.is_cart_enabled}`;
  } catch (e) {
    out.errors.push(`commerce: ${cut(e)}`);
  }
  try {
    const l = await graph('GET', `${s.wabaId}/product_catalogs`, { fields: 'id,name' });
    out.linked = (l.data || []).map((x) => `${x.id} ${x.name}`).join(' ; ') || 'none';
  } catch (e) {
    out.errors.push(`linked: ${cut(e)}`);
  }
  if (fix) out.fix = await connectCatalog();
  return out;
}

/** Test: does the token of the engine get a price from Elev8 (get_quote, the price of a stay with fees and taxes, as the website charges it)? */
export async function quoteTest({ villa, checkIn, checkOut, adults, children }) {
  try {
    const r = await elev8Tool('get_quote', { check_in_date: checkIn, check_out_date: checkOut, listing_id: '', listing_name: villa, number_of_adults: adults, number_of_children: children, rate_plan_id: '' });
    return { ok: true, raw: JSON.stringify(r).slice(0, 1500) };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 300) };
  }
}

/**
 * Why does the catalog not show in the chat? Collects what Meta says in four short parts (the probe keeps only the first part of an answer):
 *   part 1  the catalog: name, type, owner, number of products, product sets
 *   part 2  the number: status, official account, business profile (what is filled in), commerce settings
 *   part 3  the business: verification, which catalogs and WhatsApp accounts it owns
 *   part 4  the WhatsApp account and the diagnostics Meta keeps for the catalog
 * Every step reports its own error, so a missing permission is named instead of hiding the rest.
 */
export async function whyState(part = 1) {
  const s = waCatalogSettings();
  const catalog = await catalogId();
  const cut = (e, n = 110) => String(e?.message || e).replace(/\s+/g, ' ').slice(0, n);
  const step = async (label, fn) => {
    try {
      return `${label}: ${await fn()}`;
    } catch (e) {
      return `${label} ERR ${cut(e)}`;
    }
  };
  const lines = [];
  if (part === 1) {
    lines.push(await step('catalog', async () => {
      const c = await graph('GET', catalog, { fields: 'name,vertical,product_count,business{id,name}' });
      return `${c.name} | type ${c.vertical} | n ${c.product_count} | owner ${c.business?.id} ${c.business?.name || ''} | env business ${s.businessId || 'not set'}`;
    }));
    lines.push(await step('sets', async () => {
      const r = await graph('GET', `${catalog}/product_sets`, { fields: 'name,product_count', limit: 20 });
      return (r.data || []).map((x) => `${x.name}(${x.product_count})`).join(' ') || 'none';
    }));
  } else if (part === 2) {
    lines.push(await step('number', async () => {
      const p = await graph('GET', s.phoneId, { fields: 'status,account_mode,is_official_business_account,messaging_limit_tier,platform_type' });
      return `status ${p.status} | mode ${p.account_mode} | official ${p.is_official_business_account} | tier ${p.messaging_limit_tier} | ${p.platform_type}`;
    }));
    lines.push(await step('profile', async () => {
      const r = await graph('GET', `${s.phoneId}/whatsapp_business_profile`, { fields: 'about,address,description,email,profile_picture_url,websites,vertical' });
      const x = r.data?.[0] || r;
      return `about ${String(x.about || '').length}c | desc ${String(x.description || '').length}c | picture ${x.profile_picture_url ? 'yes' : 'NO'} | sites ${(x.websites || []).length} | email ${x.email ? 'yes' : 'no'} | address ${x.address ? 'yes' : 'no'} | vertical ${x.vertical || 'none'}`;
    }));
    lines.push(await step('commerce', async () => JSON.stringify((await graph('GET', `${s.phoneId}/whatsapp_commerce_settings`)).data?.[0] ?? {}).slice(0, 140)));
  } else if (part === 3) {
    lines.push(await step('business', async () => {
      const b = await graph('GET', s.businessId, { fields: 'name,verification_status' });
      return `${b.name} | verification ${b.verification_status}`;
    }));
    lines.push(await step('owns catalogs', async () => ((await graph('GET', `${s.businessId}/owned_product_catalogs`, { fields: 'name', limit: 20 })).data || []).map((x) => `${x.id} ${x.name}`).join(' ; ') || 'none'));
    lines.push(await step('owns WABA', async () => ((await graph('GET', `${s.businessId}/owned_whatsapp_business_accounts`, { fields: 'name', limit: 20 })).data || []).map((x) => `${x.id} ${x.name}`).join(' ; ') || 'none'));
    lines.push(await step('client WABA', async () => ((await graph('GET', `${s.businessId}/client_whatsapp_business_accounts`, { fields: 'name', limit: 20 })).data || []).map((x) => `${x.id} ${x.name}`).join(' ; ') || 'none'));
  } else {
    lines.push(await step('waba', async () => {
      const w = await graph('GET', s.wabaId, { fields: 'name,account_review_status,business_verification_status,ownership_type,currency' });
      return `${w.name} | review ${w.account_review_status} | verification ${w.business_verification_status} | ${w.ownership_type} | ${w.currency}`;
    }));
    lines.push(await step('diagnostics', async () => JSON.stringify((await graph('GET', `${catalog}/diagnostics`, { fields: 'type,diagnostics' })).data || []).slice(0, 420)));
  }
  return { part, s: lines.join(' || ') };
}

export function sendRoutes(app, needDb, ah) {
  app.get('/wa-catalog/why', needDb, ah(async (req, res) => res.json(await whyState(Number(req.query.part) || 1))));
  app.get('/wa-catalog/commerce', needDb, ah(async (req, res) => {
    const fix = String(req.query.fix || '') === '1';
    if (fix && String(req.query.confirm || '') !== '1') throw new HttpError(400, 'fix links the catalog to the WhatsApp account again and switches it visible. Add confirm=1.');
    res.json(await commerceState({ fix }));
  }));
  app.get('/wa-catalog/quote-test', needDb, ah(async (req, res) => {
    res.json(await quoteTest({ villa: String(req.query.villa || 'Bratan'), checkIn: String(req.query.in || '2026-12-05'), checkOut: String(req.query.out || '2026-12-09'), adults: Number(req.query.adults) || 3, children: Number(req.query.children) || 0 }));
  }));
  app.get('/wa-catalog/send-test', needDb, ah(async (req, res) => {
    if (String(req.query.confirm || '') !== '1') throw new HttpError(400, 'This sends one WhatsApp product message to the number you name. Add confirm=1.');
    const keys = String(req.query.key || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!keys.length) throw new HttpError(400, 'key is required, for example key=masurai');
    res.json(await sendProductMessage({ to: String(req.query.to || ''), keys, text: String(req.query.notext || '') === '1' ? '' : String(req.query.text || 'Here is the villa from our catalog. Tap to see photos and the price.').slice(0, 300) }));
  }));
}
