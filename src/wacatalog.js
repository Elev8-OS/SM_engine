import { dbEnabled, q } from './db.js';
import { HttpError } from './util.js';
import { graph } from './meta.js';
import { elev8Tool, pricelabsRows, pricelabsBase, priceIds } from './agent/clients.js';
import { factsFor, withFacts } from './facts.js';
import { usdRates } from './fx.js';
import { lowestNightly, allBlockedRanges, priceString, priceLabel, roundPrice, convertAmount, productUrl, productTitle, sizeBand, PRODUCT_SETS, describeVilla, galleryUrls, withCover, batchSummary } from './wacatalog-core.js';

// WhatsApp catalog: one product per villa in a Meta commerce catalog that is connected to the WhatsApp Business account.
// The engine creates the catalog (needs META_BUSINESS_ID and a token with catalog_management), keeps it up to date and
// never sends a guess:
//   title   name, bedrooms and private pool (what a guest sees in the product list)
//   text    from the fact sheet of the villa (the "catalog" sentences, each one taken from the facts)
//   photos  the Elev8 gallery of the listing (public links, in gallery order), the first one is the main image; a fact sheet can
//           name a different cover photo ("cover": position in the gallery)
//   price   lowest nightly price over the next 90 days on free nights: PriceLabs (the price pushed to the channels), free
//           nights from Elev8. Shown in IDR (WA_CATALOG_CURRENCY): the CHF price is converted with the ECB rate of the day and
//           rounded to 10,000 IDR, with "(about USD n)" beside it. A property that is fully booked shows its PriceLabs base price,
//           is marked "out of stock" and says "Currently not available." in the text (otherwise "Dates available."). A property
//           without any price or rate is not sent; its item at Meta stays as it is.
//   link    booking page of the villa with utm_source=whatsapp
//   labels  custom_label_0 type (villa, apartment, shared villa), 1 area, 2 size band: for the collections and for catalog ads
//   collections  product sets (PRODUCT_SETS in the core file), created when they are missing
// Besides the single villas there are products that stand for several units: the apartment categories and the shared villa
// Merapi (SPECIAL below). A unit-based product is sold out only when every unit is blocked; its price is the lowest over the units.
// Preview first (nothing is written), then sync. A sync runs about every 6 hours when WA_CATALOG_AUTO=on and a catalog exists.
//
// Only what changed goes to Meta. Meta checks a product again when its title, text or photos change, and while a product is in
// that check it is not shown in the WhatsApp catalog. So a normal run sends only the fields that differ from the last run
// (usually price and availability), a product that did not change is not sent, and photos are set again only when they changed
// or the last attempt failed. A full send (every field of every product) is POST /wa-catalog/sync?full=1.

const DAY = 86400000;
const SYNC_EVERY_MS = 6 * 3600 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const baliToday = () => {
  const t = new Date(Date.now() + 8 * 3600 * 1000);
  return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
};
const list = (v, d) => String(v || d).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const SITE = 'https://www.elevate-villas.com';

// PriceLabs listings (channex) that are not in PRICELABS_LISTINGS yet. The variable wins when it has the key.
const PL_FALLBACK = {
  bratan: '60e9b31b-1313-45b9-9c61-13f9f5cc8cf4___7f7206ac-8595-40c4-8fca-c1394d350745',
  tambora: 'a34cc21d-f853-488e-ba11-a42902a6b0aa___254a15a0-f81a-45a1-8bed-60b445933f81',
  'apt-studio': '49f64992-d0c0-4566-9edf-fe7ce185f36b___78adf636-26dc-4ea6-a9b1-c0acfd17d5ae',
  'apt-mezzanine': '15a053e0-d4b8-491f-ae5b-fefcda8f8493___8c95568b-d972-40dc-99e3-4aa7c487ac86',
  'apt-plunge': '1ed9c430-09bd-497e-816f-ca5837296b3f___4de7f331-6ebc-44ab-bfdb-92f6f405cd1d'
};
const MERAPI_PL = ['afa397b2-7857-42f2-afe7-76f44e2372a4___05e77a25-1600-48b4-b984-5369062a9d0b', 'afa397b2-7857-42f2-afe7-76f44e2372a4___d92c422a-c8af-4679-913c-adc3a0d94c74'];
const plIds = () => ({ ...PL_FALLBACK, ...priceIds() });

const aptNo = (name) => {
  const m = /\bAPT\s*0?(\d{1,2})\b/i.exec(String(name || ''));
  return m ? Number(m[1]) : null;
};
const aptUnits = (nums) => (u) => nums.includes(aptNo(u.internal_name));

// Products that are not a single listing. units picks the Elev8 listings behind the product by their internal name.
// url: the booking page on elevate-villas.com (one page per category; for Merapi the page of room 1).
// kind: custom_label_0 of the product (a single villa is "villa").
const SPECIAL = {
  merapi: {
    retailerId: 'villa-merapi',
    kind: 'shared villa',
    name: 'The R Villa Merapi (shared villa)',
    area: 'Pererenan',
    guests: null,
    highlights: 'Shared villa with five private rooms, up to 2 guests per room',
    url: `${SITE}/property/the-r-villa-merapi-0e45abbd`,
    units: (u) => /merapi/i.test(String(u.internal_name || '')),
    priceListings: MERAPI_PL
  },
  'apt-studio': { retailerId: 'apartment-studio', kind: 'apartment', name: 'The R Apartments Studio', area: 'Pererenan', guests: null, highlights: 'Studio apartments, walk to the beach', url: `${SITE}/property/the-r-apartments-studio-dc20bb99`, units: aptUnits([4, 5, 6, 7]) },
  'apt-mezzanine': { retailerId: 'apartment-mezzanine', kind: 'apartment', name: 'The R Apartments Mezzanine', area: 'Pererenan', guests: 3, highlights: 'Mezzanine apartments with balcony', url: `${SITE}/property/the-r-pererenan-mezzanine-apartment-w-balcony-90672e94`, units: aptUnits([8, 9, 10, 11]) },
  'apt-plunge': { retailerId: 'apartment-plunge-pool', kind: 'apartment', name: 'The R Apartments Mezzanine with Plunge Pool', area: 'Pererenan', guests: 3, highlights: 'Mezzanine studio with plunge pool', url: `${SITE}/property/1-3-plunge-pool-0efd1608`, units: aptUnits([1, 2, 3]) }
};

export const waCatalogSettings = () => ({
  villas: list(process.env.WA_CATALOG_VILLAS, 'patuha,masurai'),
  days: 90,
  currency: String(process.env.WA_CATALOG_CURRENCY || 'IDR').toUpperCase(),
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

// The whole portfolio once per run (a few minutes), for products that stand for several units.
let portfolio = { at: 0, key: '', results: null };
async function elev8Portfolio(from, to) {
  const k = `${from}|${to}`;
  if (portfolio.results && portfolio.key === k && Date.now() - portfolio.at < 5 * 60 * 1000) return portfolio.results;
  const r = await elev8Tool('get_blocked_dates', { from_date: from, to_date: to, listing_name: '', listing_tag: '' });
  portfolio = { at: Date.now(), key: k, results: r?.results || [] };
  return portfolio.results;
}

async function lastKnown(retailerId) {
  const r = (await q('select price, currency from wa_catalog_items where retailer_id = $1', [retailerId]))[0];
  return r && Number(r.price) > 0 ? { price: Number(r.price), currency: r.currency } : null;
}

/** The base price of the PriceLabs listing(s), the lowest one; else the lowest recommended rate, blocked nights included. */
async function basePriceOf(ids, pls, sourceCurrency) {
  const found = [];
  for (const id of ids) {
    try {
      const b = await pricelabsBase(id);
      if (b.base > 0) found.push({ base: b.base, currency: b.currency || sourceCurrency });
    } catch {
      // fall back to the recommended rates below
    }
  }
  if (found.length) {
    const best = found.reduce((a, b) => (b.base < a.base ? b : a));
    return { amount: best.base, currency: best.currency, source: 'pricelabs_base' };
  }
  const rates = pls.flatMap((pl) => (pl.rows || []).map((r) => (r.price > 0 ? r.price : 0))).filter((p) => p > 0);
  if (rates.length) return { amount: Math.min(...rates), currency: sourceCurrency, source: 'pricelabs_lowest_rate' };
  return null;
}

/** A price in the catalog currency (IDR is rounded to a readable step) and, beside it, about how many USD that is (to 5). */
async function toCatalogPrice(amount, sourceCurrency, currency, warnings) {
  if (sourceCurrency === currency) return { price: roundPrice(amount, currency), converted: false, base: null, usd: null };
  const fx = await usdRates([sourceCurrency, currency]);
  const price = roundPrice(convertAmount(amount, sourceCurrency, currency, fx.rates), currency);
  if (fx.stale) warnings.push('The exchange rate is not from today (rate service not reachable)');
  let usd = null;
  if (currency !== 'USD') {
    try {
      usd = Math.max(5, Math.round(convertAmount(amount, sourceCurrency, 'USD', fx.rates) / 5) * 5);
    } catch {
      usd = null;
    }
  }
  return {
    price,
    converted: true,
    usd,
    base: { amount: Math.round(amount), currency: sourceCurrency, rate: Math.round((fx.rates[currency] / (sourceCurrency === 'USD' ? 1 : fx.rates[sourceCurrency])) * 100) / 100, date: fx.date, source: fx.source, stale: Boolean(fx.stale) }
  };
}

/** One product (villa, apartment category or the shared villa). Throws a readable error when a part is missing: it is then left out and reported. */
export async function buildProduct(prop, settings, special = null) {
  const key = prop.key;
  const warnings = [];
  const from = iso(baliToday() + DAY);
  const to = iso(baliToday() + settings.days * DAY);
  const retailerId = special?.retailerId || `villa-${key}`;
  const sheet = factsFor(key);

  // Elev8: the units behind the product, the nights that cannot be booked, the id of the gallery.
  let blocked;
  let listingId;
  if (special) {
    const all = await elev8Portfolio(from, to);
    const units = all.filter((u) => special.units(u));
    if (!units.length) throw new Error(`No Elev8 units found for "${key}"`);
    blocked = allBlockedRanges(units.map((u) => u.blocked_ranges || []), from, settings.days);
    listingId = units[0].property_id || units[0].listing_id;
  } else {
    const { listing, several } = await elev8Listing(key, from, to);
    if (several) warnings.push(`Elev8 has several listings that match "${key}", the first one is used`);
    blocked = listing.blocked_ranges || [];
    listingId = listing.property_id || listing.listing_id;
  }

  let images = [];
  try {
    images = galleryUrls((await elev8Tool('get_listing_images', { listing_id: listingId, listing_name: '', listing_tag: '' }))?.results);
  } catch (e) {
    throw new Error(`Photos from Elev8 not available (${e.message})`);
  }
  if (!images.length) throw new Error('The Elev8 listing has no photos');
  images = withCover(images, sheet?.cover);

  const ids = special?.priceListings || [plIds()[key]].filter(Boolean);
  if (!ids.length) throw new Error(`No PriceLabs listing for "${key}" (PRICELABS_LISTINGS)`);
  const pls = [];
  for (const id of ids) pls.push(await pricelabsRows(id, from, to));
  const calcs = pls.map((pl) => lowestNightly(pl.rows, blocked, from, settings.days));
  const mins = calcs.map((c) => c.min).filter((x) => x > 0);
  const freeNights = Math.max(...calcs.map((c) => c.freeNights));
  const pricedNights = Math.max(...calcs.map((c) => c.pricedNights));
  const sourceCurrency = String(pls.find((pl) => pl.currency)?.currency || 'CHF').toUpperCase();
  const currency = settings.currency;
  const soldOut = freeNights === 0;

  let price = null;
  let usd = null;
  let priceSource = 'pricelabs';
  let base = null;
  if (mins.length) {
    const c = await toCatalogPrice(Math.min(...mins), sourceCurrency, currency, warnings);
    price = c.price;
    usd = c.usd;
    base = c.base;
    if (c.converted) priceSource = 'pricelabs_converted';
  } else if (soldOut) {
    // Fully booked: the base price from PriceLabs, marked as out of stock.
    const b = await basePriceOf(ids, pls, sourceCurrency);
    if (!b) throw new Error('Fully booked and no base price in PriceLabs');
    const c = await toCatalogPrice(b.amount, String(b.currency || sourceCurrency).toUpperCase(), currency, warnings);
    price = c.price;
    usd = c.usd;
    base = c.base;
    priceSource = b.source;
    warnings.push('Fully booked: the PriceLabs base price is shown');
  } else {
    // Free nights but no price for them: keep the last price that was sent, never guess one.
    const prev = await lastKnown(retailerId);
    if (!prev || prev.currency !== currency) throw new Error(`No price for the next ${settings.days} days (nights with price: ${pricedNights})`);
    price = prev.price;
    priceSource = 'last_sent';
    warnings.push('No current price, the last price that was sent is kept');
  }

  const p = withFacts(prop);
  const availability = soldOut ? 'out of stock' : 'in stock';
  const link = productUrl(prop.url, key);
  // "Dates available" says there are free nights in the next 90 days, not that a given date is free.
  const fromLine = `From ${priceLabel(price, currency)} per night${usd ? ` (about USD ${usd})` : ''}. ${soldOut ? 'Currently not available.' : 'Dates available.'}`;
  const payload = {
    id: retailerId,
    title: productTitle(p.name, sheet),
    description: describeVilla(p, sheet, fromLine),
    availability,
    condition: 'new',
    price: priceString(price, currency),
    link,
    image_link: images[0],
    brand: 'The R Villas Bali',
    custom_label_0: special?.kind || 'villa'
  };
  if (prop.area) payload.custom_label_1 = String(prop.area);
  const band = sizeBand(sheet?.bedrooms);
  if (band && !special) payload.custom_label_2 = band;
  return {
    retailerId,
    propertyKey: key,
    price,
    currency,
    availability,
    freeNights,
    priceSource,
    base,
    imageCount: images.length,
    extraImages: images.slice(1),
    warnings,
    payload
  };
}

// A few products at a time: every one calls Elev8 and PriceLabs, ten and more in a row take too long.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

async function buildAll() {
  const s = waCatalogSettings();
  const props = await q('select * from properties where key = any($1)', [s.villas.filter((k) => !SPECIAL[k])]);
  const results = await mapLimit(s.villas, 3, async (key) => {
    const sp = SPECIAL[key];
    const prop = sp ? { key, name: sp.name, area: sp.area, guests: sp.guests, highlights: sp.highlights, url: sp.url } : props.find((x) => x.key === key);
    if (!prop) return { error: { villa: key, error: 'Unknown villa in WA_CATALOG_VILLAS' } };
    try {
      return { item: await buildProduct(prop, s, sp || null) };
    } catch (e) {
      return { error: { villa: key, error: String(e.message || e).slice(0, 300) } };
    }
  });
  return { items: results.filter((r) => r.item).map((r) => r.item), errors: results.filter((r) => r.error).map((r) => r.error), villas: s.villas };
}

// What the screen gets. The number of free nights stays inside the engine on purpose.
const view = (i) => ({ retailerId: i.retailerId, villa: i.propertyKey, title: i.payload.title, price: i.payload.price, amount: i.price, currency: i.currency, base: i.base, availability: i.availability, priceSource: i.priceSource, link: i.payload.link, mainImage: i.payload.image_link, images: i.imageCount, description: i.payload.description, warnings: i.warnings });

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

/** The collections (product sets) of the catalog: the ones that are missing are created, existing ones are left as they are. Returns the problems, if any. */
async function ensureProductSets(catalog) {
  const notes = [];
  let byName = new Map();
  try {
    const have = await graph('GET', `${catalog}/product_sets`, { fields: 'id,name', limit: 100 });
    byName = new Map((have.data || []).map((s) => [s.name, s.id]));
  } catch (e) {
    return [`collections not checked (${String(e.message || e).slice(0, 150)})`];
  }
  for (const s of PRODUCT_SETS) {
    if (byName.has(s.name)) continue;
    try {
      await graph('POST', `${catalog}/product_sets`, { name: s.name, filter: { [`custom_label_${s.label}`]: { eq: s.value } } });
    } catch (e) {
      notes.push(`collection "${s.name}" not set (${String(e.message || e).slice(0, 150)})`);
    }
  }
  return notes;
}

/**
 * What to send for one product. A new product (or force) goes with every field. A known product goes with the fields that differ
 * from the last send; nothing differs means nothing is sent. Photos are set again only when they changed or the last try failed.
 * old is the stored payload of the last send (it also carries __photos, the photo list, and __photosOk, whether the extra photos were set).
 */
export function planItem(item, old, force = false) {
  const photos = JSON.stringify([item.payload.image_link, ...item.extraImages]);
  if (!old || force) return { data: item.payload, changed: Object.keys(item.payload), send: true, photos, needExtras: true };
  const { __photos, __photosOk, ...before } = old;
  const data = { id: item.retailerId };
  const changed = [];
  for (const [k, v] of Object.entries(item.payload)) {
    if (JSON.stringify(v) !== JSON.stringify(before[k])) {
      data[k] = v;
      changed.push(k);
    }
  }
  // A row stored before this logic has no photo record: it counts as set (the photos were checked by hand).
  const needExtras = __photosOk === false || (__photos !== undefined && __photos !== photos);
  return { data, changed, send: changed.length > 0, photos, needExtras };
}

/**
 * Build the products and either show them (dryRun, nothing is written) or send them to the catalog in one batch.
 * A villa that cannot be built is left out and listed under errors; the rest is still sent.
 */
export async function syncCatalog({ dryRun = false, force = false } = {}) {
  await ensureTables();
  const catalog = await catalogId();
  const built = await buildAll();
  if (dryRun) return { dryRun: true, catalogId: catalog, items: built.items.map(view), errors: built.errors };
  if (!catalog) throw new HttpError(409, 'There is no catalog yet. Create it first (POST /wa-catalog/create).');
  if (!built.items.length) throw new HttpError(409, `Nothing to send: ${built.errors.map((e) => `${e.villa}: ${e.error}`).join(' | ') || 'no villas configured'}`);

  const before = new Map((await q('select retailer_id, payload from wa_catalog_items')).map((r) => [r.retailer_id, r.payload || null]));
  const plan = built.items.map((i) => ({ i, ...planItem(i, before.get(i.retailerId) || null, force), prev: before.get(i.retailerId) || null }));
  const toSend = plan.filter((p) => p.send);

  let handle = null;
  let batch = { status: 'finished', errorsTotal: 0, warningsTotal: 0, errors: [] };
  if (toSend.length) {
    const r = await graph('POST', `${catalog}/items_batch`, { item_type: 'PRODUCT_ITEM', allow_upsert: true, requests: toSend.map((p) => ({ method: 'UPDATE', data: p.data })) });
    handle = r.handles?.[0] ?? null;
    batch = handle ? batchSummary(await waitBatch(catalog, handle)) : { status: 'no_handle', errorsTotal: 0, warningsTotal: 0, errors: [] };
  }

  const notes = [];
  for (const p of plan) {
    p.extrasOk = p.prev?.__photosOk !== false;
    if (!p.needExtras) continue;
    try {
      await setExtraImages(catalog, p.i.retailerId, p.i.extraImages);
      p.extrasOk = true;
    } catch (e) {
      p.extrasOk = false;
      notes.push(`${p.i.retailerId}: extra photos not set (${String(e.message || e).slice(0, 150)}), the next sync tries again`);
    }
  }
  const unchanged = plan.length - toSend.length;
  if (unchanged) notes.push(`${unchanged} of ${plan.length} products did not change and were not sent`);
  notes.push(...(await ensureProductSets(catalog)));

  for (const p of plan) {
    const i = p.i;
    const bad = batch.errors.some((e) => e.startsWith(i.retailerId));
    const stored = { ...i.payload, __photos: p.photos, __photosOk: p.extrasOk };
    await q(
      `insert into wa_catalog_items (retailer_id, property_key, price, currency, availability, free_nights, payload, status, error, handle, synced_at)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10, now())
       on conflict (retailer_id) do update set property_key = excluded.property_key, price = excluded.price, currency = excluded.currency, availability = excluded.availability, free_nights = excluded.free_nights,
         payload = excluded.payload, status = excluded.status, error = excluded.error, handle = excluded.handle, synced_at = now()`,
      [i.retailerId, i.propertyKey, i.price, i.currency, i.availability, i.freeNights, JSON.stringify(stored), bad ? 'error' : p.send ? (batch.status === 'finished' ? 'ok' : batch.status) : 'ok', bad ? batch.errors.filter((e) => e.startsWith(i.retailerId)).join('; ').slice(0, 400) : null, p.send ? handle : null]
    );
  }
  const summary = { at: new Date().toISOString(), sent: built.items.length, changed: toSend.length, status: batch.status, batchErrors: batch.errorsTotal, villaErrors: built.errors.length };
  await setState('lastSync', summary);
  const result = { catalogId: catalog, ...summary, items: built.items.map(view), errors: built.errors, batch, notes };
  await setState('lastResult', result);
  return result;
}

// The sync takes a while (Meta processes the batch), longer than a screen should wait. It runs in the background; the screen
// asks for the state (run, lastResult). A run that is marked running for more than 10 minutes is taken as dead (restart).
let running = false;
export async function startSync(options = {}) {
  await ensureTables();
  if (!(await catalogId())) throw new HttpError(409, 'There is no catalog yet. Create it first.');
  const run = await getState('syncRun');
  if (running || (run?.running && Date.now() - Date.parse(run.since) < 10 * 60 * 1000)) throw new HttpError(409, 'A sync is already running');
  running = true;
  await setState('syncRun', { running: true, since: new Date().toISOString() });
  syncCatalog(options)
    .then(() => setState('syncRun', { running: false, finishedAt: new Date().toISOString() }))
    .catch((e) => {
      console.error('WhatsApp catalog sync failed:', e.message);
      return setState('syncRun', { running: false, finishedAt: new Date().toISOString(), error: String(e.message || e).slice(0, 400) });
    })
    .catch(() => {})
    .finally(() => {
      running = false;
    });
  return { started: true, full: Boolean(options.force) };
}

/** What the screen shows: settings (never secrets), the catalog and the state of each item. */
export async function waCatalogStatus() {
  await ensureTables();
  const s = waCatalogSettings();
  return {
    configured: { token: Boolean(process.env.META_ADS_TOKEN), businessId: Boolean(s.businessId), wabaId: Boolean(s.wabaId), phoneId: Boolean(s.phoneId), pricelabsVillas: Object.keys(plIds()) },
    catalogId: await catalogId(),
    villas: s.villas,
    auto: s.auto,
    lastSync: await getState('lastSync'),
    run: await getState('syncRun'),
    lastResult: await getState('lastResult'),
    items: await q(`select retailer_id, property_key, price::float as price, currency, availability, status, error, synced_at from wa_catalog_items order by property_key`)
  };
}

/** Every hour a check; a sync runs when the last one is more than 6 hours ago. Only with WA_CATALOG_AUTO=on and an existing catalog. */
export function startWaCatalogSync() {
  const run = async () => {
    try {
      if (!dbEnabled() || !waCatalogSettings().auto) return;
      if (!(await catalogId())) return;
      const last = await getState('lastSync');
      if (last?.at && Date.now() - Date.parse(last.at) < SYNC_EVERY_MS) return;
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
  app.post('/wa-catalog/sync', needDb, ah(async (req, res) => res.status(202).json(await startSync({ force: String(req.query.full || '') === '1' }))));
}
