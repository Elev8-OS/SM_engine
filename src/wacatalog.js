import { dbEnabled, q } from './db.js';
import { HttpError } from './util.js';
import { graph } from './meta.js';
import { elev8Tool, pricelabsRows, priceIds } from './agent/clients.js';
import { factsFor, withFacts } from './facts.js';
import { lowestNightly, priceString, productUrl, describeVilla, galleryUrls, batchSummary } from './wacatalog-core.js';

// WhatsApp catalog: one product per villa in a Meta commerce catalog that is connected to the WhatsApp Business account.
// The engine creates the catalog (needs META_BUSINESS_ID and a token with catalog_management), keeps it up to date and
// never sends a guess:
//   text    from the fact sheet of the villa (confirmed and Elev8 facts, plus what is not available)
//   photos  the Elev8 gallery of the listing (public links, in gallery order), the first one is the main image
//   price   lowest nightly price over the next 90 days on free nights: PriceLabs (the price pushed to the channels), free
//           nights from Elev8. A villa without a price is not sent; its item at Meta stays as it is.
//   link    booking page of the villa with utm_source=whatsapp
// Preview first (nothing is written), then sync. A nightly sync runs when WA_CATALOG_AUTO=on and a catalog exists.

const DAY = 86400000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const baliToday = () => {
  const t = new Date(Date.now() + 8 * 3600 * 1000);
  return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
};
const list = (v, d) => String(v || d).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

export const waCatalogSettings = () => ({
  villas: list(process.env.WA_CATALOG_VILLAS, 'patuha,masurai'),
  days: 90,
  currency: String(process.env.WA_CATALOG_CURRENCY || 'CHF').toUpperCase(),
  auto: /^(true|1|yes|on)$/i.test(String(process.env.WA_CATALOG_AUTO || '').replace(/["'\s]/g, '')),
  name: String(process.env.WA_CATALOG_NAME || 'The R Villas Bali'),
  businessId: String(process.env.META_BUSINESS_ID || '').trim(),
  wabaId: String(process.env.META_WABA_ID || '').trim(),
  phoneId: String(process.env.META_WA_PHONE_ID || '').trim()
});

// ---- Own tables (created on first use) ----
let ready = null;
function ensureTables() {
  ready ??= (async () => {
    await q(`create table if not exists wa_catalog_state (k text primary key, v jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now())`);
    await q(
      `create table if not exists wa_catalog_items (retailer_id text primary key, property_key text not null, price numeric, currency text, availability text, free_nights int, payload jsonb not null default '{}'::jsonb, status text, error text, handle text, synced_at timestamptz)`
    );
  })().catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}
const getState = async (k) => (await q('select v from wa_catalog_state where k = $1', [k]))[0]?.v ?? null;
const setState = (k, v) => q(`insert into wa_catalog_state (k, v) values ($1, $2::jsonb) on conflict (k) do update set v = excluded.v, updated_at = now()`, [k, JSON.stringify(v)]);

/** The catalog: META_CATALOG_ID if set, else the one this engine created. */
export async function catalogId() {
  const env = String(process.env.META_CATALOG_ID || '').trim();
  if (env) return env;
  await ensureTables();
  return (await getState('catalog'))?.id ?? null;
}

/** Create the catalog at Meta (once). Needs META_BUSINESS_ID, and the token needs catalog_management and business_management. */
export async function createCatalog() {
  await ensureTables();
  const existing = await catalogId();
  if (existing) return { id: existing, created: false };
  const s = waCatalogSettings();
  if (!s.businessId) throw new HttpError(409, 'META_BUSINESS_ID is not set. It is the id of the Meta Business that owns the page and the ad account.');
  const r = await graph('POST', `${s.businessId}/owned_product_catalogs`, { name: s.name, vertical: 'commerce' });
  await setState('catalog', { id: r.id, createdAt: new Date().toISOString() });
  return { id: r.id, created: true };
}

/** Connect the catalog to the WhatsApp Business account and show it in the chat. Each step reports its own result. */
export async function connectCatalog() {
  const id = await catalogId();
  if (!id) throw new HttpError(409, 'There is no catalog yet. Create it first.');
  const s = waCatalogSettings();
  const out = { catalogId: id, linked: null, visible: null, errors: {} };
  if (!s.wabaId) out.errors.link = 'META_WABA_ID is not set';
  else {
    try {
      await graph('POST', `${s.wabaId}/product_catalogs`, { catalog_id: id });
      out.linked = true;
    } catch (e) {
      out.linked = false;
      out.errors.link = e.message;
    }
  }
  if (!s.phoneId) out.errors.visible = 'META_WA_PHONE_ID is not set';
  else {
    try {
      await graph('POST', `${s.phoneId}/whatsapp_commerce_settings`, { is_catalog_visible: true, is_cart_enabled: false });
      out.visible = true;
    } catch (e) {
      out.visible = false;
      out.errors.visible = e.message;
    }
  }
  return out;
}

// ---- Building the products ----
async function elev8Listing(key, from, to) {
  const r = await elev8Tool('get_blocked_dates', { from_date: from, to_date: to, listing_name: key, listing_tag: '' });
  const hits = (r?.results || []).filter((x) => String(x.listing_name || x.internal_name || '').toLowerCase().includes(key));
  if (!hits.length) throw new Error(`No Elev8 listing found for "${key}"`);
  return { listing: hits[0], several: hits.length > 1 };
}

async function lastKnown(retailerId) {
  const r = (await q('select price, currency from wa_catalog_items where retailer_id = $1', [retailerId]))[0];
  return r && Number(r.price) > 0 ? { price: Number(r.price), currency: r.currency } : null;
}

/** One villa as a product. Throws a readable error when a part is missing: that villa is then left out and reported. */
export async function buildProduct(prop, settings) {
  const key = prop.key;
  const warnings = [];
  const from = iso(baliToday() + DAY);
  const to = iso(baliToday() + settings.days * DAY);
  const retailerId = `villa-${key}`;

  const { listing, several } = await elev8Listing(key, from, to);
  if (several) warnings.push(`Elev8 has several listings that match "${key}", the first one is used`);
  const listingId = listing.property_id || listing.listing_id;

  let images = [];
  try {
    images = galleryUrls((await elev8Tool('get_listing_images', { listing_id: listingId, listing_name: '', listing_tag: '' }))?.results);
  } catch (e) {
    throw new Error(`Photos from Elev8 not available (${e.message})`);
  }
  if (!images.length) throw new Error('The Elev8 listing has no photos');

  const plId = priceIds()[key];
  if (!plId) throw new Error(`No PriceLabs listing for "${key}" (PRICELABS_LISTINGS)`);
  const pl = await pricelabsRows(plId, from, to);
  const calc = lowestNightly(pl.rows, listing.blocked_ranges || [], from, settings.days);
  const currency = String(pl.currency || settings.currency).toUpperCase();
  if (pl.currency && pl.currency.toUpperCase() !== settings.currency) warnings.push(`PriceLabs prices are in ${pl.currency.toUpperCase()}, the catalog uses that`);

  let price = calc.min;
  let priceSource = 'pricelabs';
  if (!(price > 0)) {
    // Fully booked or no price for the free nights: keep the last price that was sent, never guess one.
    const prev = await lastKnown(retailerId);
    if (!prev) throw new Error(`No price for the next ${settings.days} days (free nights: ${calc.freeNights}, with price: ${calc.pricedNights})`);
    price = prev.price;
    priceSource = 'last_sent';
    warnings.push('No current price, the last price that was sent is kept');
  }
  price = Math.round(price);

  const sheet = factsFor(key);
  const p = withFacts(prop);
  const availability = calc.freeNights > 0 ? 'in stock' : 'out of stock';
  const link = productUrl(prop.url, key);
  return {
    retailerId,
    propertyKey: key,
    price,
    currency,
    availability,
    freeNights: calc.freeNights,
    priceSource,
    imageCount: images.length,
    extraImages: images.slice(1),
    warnings,
    payload: {
      id: retailerId,
      title: String(p.name).slice(0, 150),
      description: describeVilla(p, sheet),
      availability,
      condition: 'new',
      price: priceString(price, currency),
      link,
      image_link: images[0],
      brand: 'The R Villas Bali'
    }
  };
}

async function buildAll() {
  const s = waCatalogSettings();
  const props = await q('select * from properties where key = any($1)', [s.villas]);
  const items = [];
  const errors = [];
  for (const key of s.villas) {
    const prop = props.find((x) => x.key === key);
    if (!prop) {
      errors.push({ villa: key, error: 'Unknown villa in WA_CATALOG_VILLAS' });
      continue;
    }
    try {
      items.push(await buildProduct(prop, s));
    } catch (e) {
      errors.push({ villa: key, error: String(e.message || e).slice(0, 300) });
    }
  }
  return { items, errors, villas: s.villas };
}

const view = (i) => ({ retailerId: i.retailerId, villa: i.propertyKey, title: i.payload.title, price: i.payload.price, availability: i.availability, freeNights: i.freeNights, priceSource: i.priceSource, link: i.payload.link, mainImage: i.payload.image_link, images: i.imageCount, description: i.payload.description, warnings: i.warnings });

// ---- Sending ----
async function waitBatch(id, handle) {
  const t0 = Date.now();
  for (;;) {
    const s = await graph('GET', `${id}/check_batch_request_status`, { handle, load_ids_of_invalid_requests: true });
    const d = s.data?.[0] || {};
    if (d.status === 'finished' || d.status === 'failed') return d;
    if (Date.now() - t0 > 60000) return { ...d, status: d.status || 'in_progress' };
    await sleep(4000);
  }
}

/** Additional photos go in with a second, documented call per item: the item must exist at Meta first. */
async function setExtraImages(catalog, retailerId, urls) {
  if (!urls.length) return;
  let itemId = null;
  for (let i = 0; i < 4 && !itemId; i++) {
    const f = await graph('GET', `${catalog}/products`, { filter: { retailer_id: { eq: retailerId } }, fields: 'id,retailer_id', limit: 1 });
    itemId = f.data?.[0]?.id || null;
    if (!itemId) await sleep(5000);
  }
  if (!itemId) throw new Error('the item is not visible at Meta yet');
  await graph('POST', itemId, { additional_image_urls: urls });
}

/**
 * Build the products and either show them (dryRun, nothing is written) or send them to the catalog in one batch.
 * A villa that cannot be built is left out and listed under errors; the rest is still sent.
 */
export async function syncCatalog({ dryRun = false } = {}) {
  await ensureTables();
  const catalog = await catalogId();
  const built = await buildAll();
  if (dryRun) return { dryRun: true, catalogId: catalog, items: built.items.map(view), errors: built.errors };
  if (!catalog) throw new HttpError(409, 'There is no catalog yet. Create it first (POST /wa-catalog/create).');
  if (!built.items.length) throw new HttpError(409, `Nothing to send: ${built.errors.map((e) => `${e.villa}: ${e.error}`).join(' | ') || 'no villas configured'}`);

  const r = await graph('POST', `${catalog}/items_batch`, { item_type: 'PRODUCT_ITEM', allow_upsert: true, requests: built.items.map((i) => ({ method: 'UPDATE', data: i.payload })) });
  const handle = r.handles?.[0] ?? null;
  const batch = handle ? batchSummary(await waitBatch(catalog, handle)) : { status: 'no_handle', errorsTotal: 0, warningsTotal: 0, errors: [] };

  const extras = [];
  for (const i of built.items) {
    try {
      await setExtraImages(catalog, i.retailerId, i.extraImages);
    } catch (e) {
      extras.push(`${i.retailerId}: extra photos not set (${String(e.message || e).slice(0, 150)}), the next sync tries again`);
    }
  }

  for (const i of built.items) {
    const bad = batch.errors.some((e) => e.startsWith(i.retailerId));
    await q(
      `insert into wa_catalog_items (retailer_id, property_key, price, currency, availability, free_nights, payload, status, error, handle, synced_at)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10, now())
       on conflict (retailer_id) do update set property_key = excluded.property_key, price = excluded.price, currency = excluded.currency, availability = excluded.availability, free_nights = excluded.free_nights,
         payload = excluded.payload, status = excluded.status, error = excluded.error, handle = excluded.handle, synced_at = now()`,
      [i.retailerId, i.propertyKey, i.price, i.currency, i.availability, i.freeNights, JSON.stringify(i.payload), bad ? 'error' : batch.status === 'finished' ? 'ok' : batch.status, bad ? batch.errors.filter((e) => e.startsWith(i.retailerId)).join('; ').slice(0, 400) : null, handle]
    );
  }
  const summary = { at: new Date().toISOString(), sent: built.items.length, status: batch.status, batchErrors: batch.errorsTotal, villaErrors: built.errors.length };
  await setState('lastSync', summary);
  return { catalogId: catalog, ...summary, items: built.items.map(view), errors: built.errors, batch, notes: extras };
}

/** What the screen shows: settings (never secrets), the catalog and the state of each item. */
export async function waCatalogStatus() {
  await ensureTables();
  const s = waCatalogSettings();
  return {
    configured: { token: Boolean(process.env.META_ADS_TOKEN), businessId: Boolean(s.businessId), wabaId: Boolean(s.wabaId), phoneId: Boolean(s.phoneId), pricelabsVillas: Object.keys(priceIds()) },
    catalogId: await catalogId(),
    villas: s.villas,
    auto: s.auto,
    lastSync: await getState('lastSync'),
    items: await q(`select retailer_id, property_key, price::float as price, currency, availability, free_nights, status, error, synced_at from wa_catalog_items order by property_key`)
  };
}

/** Every hour a check; a sync runs when the last one is more than 22 hours ago. Only with WA_CATALOG_AUTO=on and an existing catalog. */
export function startWaCatalogSync() {
  const run = async () => {
    try {
      if (!dbEnabled() || !waCatalogSettings().auto) return;
      if (!(await catalogId())) return;
      const last = await getState('lastSync');
      if (last?.at && Date.now() - Date.parse(last.at) < 22 * 3600 * 1000) return;
      await syncCatalog();
    } catch (e) {
      console.error('WhatsApp catalog sync failed:', e.message);
    }
  };
  setInterval(run, 3600 * 1000).unref();
}

export function waCatalogRoutes(app, needDb, ah) {
  app.get('/wa-catalog', needDb, ah(async (_req, res) => res.json(await waCatalogStatus())));
  app.post('/wa-catalog/create', needDb, ah(async (_req, res) => res.json(await createCatalog())));
  app.post('/wa-catalog/connect', needDb, ah(async (_req, res) => res.json(await connectCatalog())));
  app.post('/wa-catalog/preview', needDb, ah(async (_req, res) => res.json(await syncCatalog({ dryRun: true }))));
  app.post('/wa-catalog/sync', needDb, ah(async (_req, res) => res.json(await syncCatalog())));
}
