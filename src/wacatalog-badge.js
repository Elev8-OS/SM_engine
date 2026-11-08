import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { q } from './db.js';
import { HttpError } from './util.js';
import { graph } from './meta.js';
import { catalogId } from './wacatalog.js';
import { putFile } from './storage.js';
import { mediaUrl } from './media.js';
import { badgeImage } from './offer-image.js';

// TEST, not a feature of the normal sync: a red "SPECIAL OFFER" badge on the main photo of ONE product.
// Question to answer: does Meta accept a badge on a catalog photo (Meta asks for photos without promotional text), and does WhatsApp
// keep the nine additional photos when the main photo is swapped?
//   GET /wa-catalog/badge?key=dempo&mode=on&confirm=1    puts a copy of the main photo with the badge into the catalog
//   GET /wa-catalog/badge?key=dempo&mode=off&confirm=1   puts the original main photo back
//   GET /wa-catalog/badge?key=dempo                      shows what Meta holds now (main photo, number of additional photos)
// The stored copy of the engine is not changed: it keeps the original photo, so a normal sync neither sets nor removes the badge.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function holds(catalog, retailerId) {
  const r = await graph('GET', `${catalog}/products`, { filter: { retailer_id: { eq: retailerId } }, fields: 'retailer_id,image_url,additional_image_urls,image_cdn_urls,additional_image_cdn_urls,visibility', limit: 1 });
  const x = r.data?.[0] || {};
  const cut = (u) => String(u || '').replace(/^https?:\/\//, '').slice(0, 90);
  return { visibility: x.visibility, main: cut(x.image_url), additional: Array.isArray(x.additional_image_urls) ? x.additional_image_urls.length : null, cdn: `${Array.isArray(x.image_cdn_urls) ? x.image_cdn_urls.length : '?'}+${Array.isArray(x.additional_image_cdn_urls) ? x.additional_image_cdn_urls.length : '?'}` };
}

export async function badgeProduct(key, mode) {
  const catalog = await catalogId();
  if (!catalog) throw new HttpError(409, 'There is no catalog yet');
  const [row] = await q('select retailer_id, payload from wa_catalog_items where property_key = $1', [key]);
  if (!row) throw new HttpError(404, 'No product stored for this villa');
  const original = row.payload?.image_link;
  if (!original) throw new HttpError(409, 'The stored copy has no main photo');
  if (!mode) return { villa: key, product: row.retailer_id, original: String(original).replace(/^https?:\/\//, '').slice(0, 90), now: await holds(catalog, row.retailer_id) };
  let url = original;
  if (mode === 'on') {
    const res = await fetch(original, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new HttpError(502, `The main photo could not be read (${res.status})`);
    const out = await badgeImage(Buffer.from(await res.arrayBuffer()));
    const name = `${key}-offer-${Date.now()}.jpg`;
    const tmp = path.join(os.tmpdir(), name);
    await fs.writeFile(tmp, out);
    try {
      await putFile(tmp, `posts/9000/${name}`, 'image/jpeg');
    } finally {
      fs.rm(tmp, { force: true }).catch(() => {});
    }
    url = mediaUrl(`posts/9000/${name}`);
    if (!url) throw new HttpError(409, 'No public address for the photo (PUBLIC_BASE_URL or RAILWAY_PUBLIC_DOMAIN, MEDIA_SECRET)');
  } else if (mode !== 'off') throw new HttpError(400, 'mode must be on or off');
  const r = await graph('POST', `${catalog}/items_batch`, { item_type: 'PRODUCT_ITEM', requests: [{ method: 'UPDATE', data: { id: row.retailer_id, image_link: url } }] });
  const status = await waitFinished(catalog, r.handles?.[0] ?? null);
  await sleep(8000);
  return { at: new Date().toISOString(), villa: key, product: row.retailer_id, mode, batch: status, sent: url.replace(/^https?:\/\//, '').slice(0, 90), now: await holds(catalog, row.retailer_id) };
}

export function badgeRoutes(app, needDb, ah) {
  app.get('/wa-catalog/badge', needDb, ah(async (req, res) => {
    const mode = String(req.query.mode || '');
    if (mode && String(req.query.confirm || '') !== '1') throw new HttpError(400, 'This changes the main photo of one product at Meta. Add confirm=1.');
    res.json(await badgeProduct(String(req.query.key || ''), mode));
  }));
}
