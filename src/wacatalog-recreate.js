import { q } from './db.js';
import { HttpError } from './util.js';
import { graph } from './meta.js';
import { catalogId, startSync, waCatalogSettings } from './wacatalog.js';

// Recreate a product of the WhatsApp catalog: the product is deleted at Meta and sent again as a NEW product with all its photos.
// Why: WhatsApp keeps showing one photo for a product it has read once, although the Commerce Manager holds all of them. A product
// that is new for WhatsApp is read with the photos it has at that moment. Only the named villas are touched; the others stay
// untouched and in the catalog. The product is missing for a short time (about a minute).
//
//   GET /wa-catalog/recreate?key=masurai&confirm=1      (keys, comma separated; confirm=1 is required)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let busy = false;
let lastRecreate = null;

async function waitFinished(catalog, handle) {
  let status = 'no_handle';
  for (let i = 0; i < 15 && handle; i++) {
    const s = await graph('GET', `${catalog}/check_batch_request_status`, { handle, load_ids_of_invalid_requests: true });
    const d = s.data?.[0] || {};
    status = d.status || status;
    if (d.status === 'finished' || d.status === 'failed') break;
    await sleep(4000);
  }
  return status;
}

export async function recreateProducts(keys) {
  if (busy) throw new HttpError(409, 'A recreate is running already');
  const catalog = await catalogId();
  if (!catalog) throw new HttpError(409, 'There is no catalog yet');
  const allowed = new Set(waCatalogSettings().villas);
  const wanted = [...new Set(keys)].filter((k) => allowed.has(k));
  if (!wanted.length) throw new HttpError(400, `No known villa in the list. Known: ${[...allowed].join(', ')}`);
  const rows = await q('select retailer_id, property_key from wa_catalog_items where property_key = any($1)', [wanted]);
  if (!rows.length) throw new HttpError(404, 'These villas have no product in the catalog yet');
  busy = true;
  const out = { at: new Date().toISOString(), villas: wanted, products: rows.map((r) => r.retailer_id), step: 'deleting', deleteStatus: null, sync: null, error: null };
  lastRecreate = out;
  // The work runs in the background (about a minute); the answer shows where it stands: GET /wa-catalog/recreate without parameters.
  (async () => {
    try {
      const r = await graph('POST', `${catalog}/items_batch`, { item_type: 'PRODUCT_ITEM', requests: out.products.map((id) => ({ method: 'DELETE', data: { id } })) });
      out.deleteStatus = await waitFinished(catalog, r.handles?.[0] ?? null);
      if (out.deleteStatus !== 'finished') throw new Error(`Meta did not finish the deletion (${out.deleteStatus})`);
      // Forget what was sent, so the next send is a full new product (every field, all photos).
      await q('delete from wa_catalog_items where retailer_id = any($1)', [out.products]);
      out.step = 'waiting';
      await sleep(20000);
      out.step = 'sending';
      // A sync that runs at this moment would refuse; try again for a few minutes.
      for (let i = 0; i < 8 && !out.sync; i++) {
        try {
          out.sync = await startSync({});
        } catch (e) {
          if (!/already running/i.test(String(e.message))) throw e;
          await sleep(30000);
        }
      }
      if (!out.sync) throw new Error('The product was deleted but a sync kept running; the next sync sends it again (POST /wa-catalog/sync)');
      out.step = 'sent';
    } catch (e) {
      out.error = String(e.message || e).slice(0, 300);
      out.step = 'failed';
      console.error('WhatsApp catalog recreate failed:', e.message);
    } finally {
      busy = false;
    }
  })();
  return out;
}

/**
 * What Meta says about the review of each product (changes nothing). One short line per product, because the probe of the SM
 * engine keeps only the first part of an answer:  <key>:<review status>|<rejection reasons>|<visibility>|<label 3>
 * Each field is asked for on its own, so a field Meta does not know cannot spoil the others ("-" means: not returned).
 */
export async function reviewCatalog() {
  const catalog = await catalogId();
  if (!catalog) throw new HttpError(409, 'There is no catalog yet');
  const fields = ['review_status', 'review_rejection_reasons', 'visibility', 'custom_label_3'];
  const rows = new Map();
  const notes = [];
  for (const f of fields) {
    try {
      let after = null;
      for (let page = 0; page < 3; page++) {
        const r = await graph('GET', `${catalog}/products`, { fields: `retailer_id,${f}`, limit: 50, ...(after ? { after } : {}) });
        for (const x of r.data || []) rows.set(x.retailer_id, { ...(rows.get(x.retailer_id) || {}), [f]: x[f] });
        after = r.paging?.cursors?.after;
        if (!r.paging?.next || !after) break;
      }
    } catch (e) {
      notes.push(`${f}: ${String(e.message || e).slice(0, 90)}`);
    }
  }
  const sets = await graph('GET', `${catalog}/product_sets`, { fields: 'name,product_count', limit: 25 }).catch((e) => ({ error: String(e.message || e).slice(0, 90) }));
  const val = (v) => (v === undefined || v === null || v === '' ? '-' : Array.isArray(v) ? v.join('+') || '-' : String(v));
  const short = (id) => String(id).replace(/^(villa|apartment)-/, '');
  return {
    p: [...rows.entries()].map(([id, x]) => `${short(id)}:${val(x.review_status)}|${val(x.review_rejection_reasons)}|${val(x.visibility)}|${val(x.custom_label_3)}`).join(' ; '),
    sets: sets.error ? sets.error : (sets.data || []).map((x) => `${x.name} ${x.product_count}`).join(' ; '),
    notes: notes.length ? notes : undefined
  };
}

/**
 * A test, not a feature: change ONE field of ONE product at Meta and nothing else, to find out which kind of change makes WhatsApp
 * drop the product from its list for a while (the product stays "published" at Meta).
 *   price      the price goes up by 10,000 IDR (the next normal sync sets the real price again)
 *   description  only the text: the USD figure in it goes up by one (the next normal sync sets the real text again)
 *   label_off  custom_label_3 is emptied (the offer label)
 *   label_on   custom_label_3 is set to "offer" again
 * The stored copy of the engine is not changed, so a normal sync does not know about it: put the label back with label_on.
 *   GET /wa-catalog/touch?key=sinabung&change=price&confirm=1
 */
export async function touchProduct(key, change) {
  const catalog = await catalogId();
  if (!catalog) throw new HttpError(409, 'There is no catalog yet');
  const [row] = await q('select retailer_id, payload from wa_catalog_items where property_key = $1', [key]);
  if (!row) throw new HttpError(404, 'No product stored for this villa');
  const data = { id: row.retailer_id };
  if (change === 'price') {
    const n = Number(String(row.payload?.price || '').split(' ')[0]);
    if (!(n > 0)) throw new HttpError(409, 'The stored price cannot be read');
    data.price = `${n + 10000} IDR`;
  } else if (change === 'description') {
    // only the text: the figure after "about USD" goes up by one (the next normal sync sets the real text again)
    const d = String(row.payload?.description || '');
    if (!/about USD \d+/.test(d)) throw new HttpError(409, 'The stored text has no USD figure to change');
    data.description = d.replace(/about USD (\d+)/, (_m, n) => `about USD ${Number(n) + 1}`);
  } else if (change === 'label_off') data.custom_label_3 = '';
  else if (change === 'label_on') data.custom_label_3 = 'offer';
  else throw new HttpError(400, 'change must be price, description, label_off or label_on');
  const r = await graph('POST', `${catalog}/items_batch`, { item_type: 'PRODUCT_ITEM', requests: [{ method: 'UPDATE', data }] });
  const status = await waitFinished(catalog, r.handles?.[0] ?? null);
  return { at: new Date().toISOString(), villa: key, product: row.retailer_id, change, sent: Object.keys(data).filter((k) => k !== 'id'), status };
}

export function recreateRoutes(app, needDb, ah) {
  app.get('/wa-catalog/touch', needDb, ah(async (req, res) => {
    if (String(req.query.confirm || '') !== '1') throw new HttpError(400, 'This changes one field of one product at Meta. Add confirm=1.');
    res.json(await touchProduct(String(req.query.key || ''), String(req.query.change || '')));
  }));
  app.get('/wa-catalog/review', needDb, ah(async (_req, res) => res.json(await reviewCatalog())));
  app.get('/wa-catalog/recreate', needDb, ah(async (req, res) => {
    const keys = String(req.query.key || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!keys.length) return res.json(lastRecreate || { note: 'No recreate since the start. Use ?key=masurai&confirm=1' });
    if (String(req.query.confirm || '') !== '1') throw new HttpError(400, 'This deletes the product at Meta and sends it again. Add confirm=1.');
    res.status(202).json(await recreateProducts(keys));
  }));
}
