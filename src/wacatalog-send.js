import { q } from './db.js';
import { HttpError } from './util.js';
import { catalogId, waCatalogSettings } from './wacatalog.js';

// Product messages: a catalog product (or several) sent into a WhatsApp chat as an interactive message that shows the photo, title and
// price, with a button to open the product. Only inside the 24 hours after the guest's last message. This is the TEST of the way:
// does the sales number accept a product message from the engine (token permission, number registered for the API)?
//   GET /wa-catalog/send-test?to=<number with country code>&key=masurai&confirm=1        one villa (keys, comma separated: several villas)
// It sends exactly one message to the number you name, so use your own number, and write to the sales number first so the 24 hours are open.

const VERSION = process.env.META_GRAPH_VERSION || 'v25.0';
const digits = (s) => String(s || '').replace(/\D/g, '');

/** The interactive object: one product, or a list (at most 10 villas here, WhatsApp allows 30). */
export function productInteractive(catalog, ids, text) {
  if (ids.length === 1) return { type: 'product', body: { text }, action: { catalog_id: catalog, product_retailer_id: ids[0] } };
  return { type: 'product_list', header: { type: 'text', text: 'Villas for your dates' }, body: { text }, action: { catalog_id: catalog, sections: [{ title: 'Villas', product_items: ids.slice(0, 10).map((id) => ({ product_retailer_id: id })) }] } };
}

export async function sendProductMessage({ to, keys, text }) {
  const phoneId = waCatalogSettings().phoneId;
  const catalog = await catalogId();
  const token = process.env.META_ADS_TOKEN;
  if (!phoneId || !catalog || !token) throw new HttpError(409, 'META_WA_PHONE_ID, the catalog or META_ADS_TOKEN is missing');
  const num = digits(to);
  if (num.length < 8 || num.length > 15) throw new HttpError(400, 'to must be a phone number with country code, digits only');
  const rows = await q('select retailer_id, property_key from wa_catalog_items where property_key = any($1)', [keys]);
  if (!rows.length) throw new HttpError(404, 'No catalog product for these villas');
  const ids = rows.map((r) => r.retailer_id);
  const body = { messaging_product: 'whatsapp', recipient_type: 'individual', to: num, type: 'interactive', interactive: productInteractive(catalog, ids, text) };
  const res = await fetch(`https://graph.facebook.com/${VERSION}/${phoneId}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = json?.error || {};
    return { ok: false, status: res.status, code: e.code, subcode: e.error_subcode, message: String(e.message || '').slice(0, 250), detail: String(e.error_data?.details || e.error_user_msg || '').slice(0, 250), products: ids };
  }
  return { ok: true, products: ids, to: `${num.slice(0, 4)}…${num.slice(-2)}`, messageId: json.messages?.[0]?.id ?? null };
}

export function sendRoutes(app, needDb, ah) {
  app.get('/wa-catalog/send-test', needDb, ah(async (req, res) => {
    if (String(req.query.confirm || '') !== '1') throw new HttpError(400, 'This sends one WhatsApp product message to the number you name. Add confirm=1.');
    const keys = String(req.query.key || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!keys.length) throw new HttpError(400, 'key is required, for example key=masurai');
    res.json(await sendProductMessage({ to: String(req.query.to || ''), keys, text: String(req.query.text || 'Here is the villa from our catalog. Tap to see photos and the price.').slice(0, 300) }));
  }));
}
