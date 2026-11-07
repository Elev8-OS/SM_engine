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

export function recreateRoutes(app, needDb, ah) {
  app.get('/wa-catalog/recreate', needDb, ah(async (req, res) => {
    const keys = String(req.query.key || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!keys.length) return res.json(lastRecreate || { note: 'No recreate since the start. Use ?key=masurai&confirm=1' });
    if (String(req.query.confirm || '') !== '1') throw new HttpError(400, 'This deletes the product at Meta and sends it again. Add confirm=1.');
    res.status(202).json(await recreateProducts(keys));
  }));
}
