// Pure helpers for the WhatsApp catalog (no network, no database), so they can be tested on their own.

const DAY = 86400000;

/** The nights of [fromIso, fromIso + days) as YYYY-MM-DD. */
export function nightList(fromIso, days) {
  const t0 = Date.parse(`${fromIso}T00:00:00Z`);
  return Array.from({ length: days }, (_, i) => new Date(t0 + i * DAY).toISOString().slice(0, 10));
}

/**
 * Lowest nightly price over the free nights. rows are PriceLabs rows (date, price, user_price, unbookable), blocked are the
 * Elev8 blocked ranges (start, end_exclusive). The price pushed to the channels (user_price) wins over the recommendation.
 * A night that is blocked, unbookable or without a price does not count. Nothing is guessed: no price, no result.
 */
export function lowestNightly(rows, blocked, fromIso, days) {
  const byDate = new Map((rows || []).map((r) => [r.date, r]));
  let min = null;
  let free = 0;
  let priced = 0;
  for (const d of nightList(fromIso, days)) {
    if ((blocked || []).some((b) => d >= b.start && d < b.end_exclusive)) continue;
    const r = byDate.get(d);
    if (r?.unbookable) continue;
    free++;
    const p = r ? (r.user_price > 0 ? r.user_price : r.price) : null;
    if (p > 0) {
      priced++;
      if (min === null || p < min) min = p;
    }
  }
  return { min, freeNights: free, pricedNights: priced };
}

/**
 * The nights on which EVERY unit is blocked, as one-night ranges. A product that stands for several units (an apartment
 * category, the rooms of a shared villa) is sold out only when no unit can be booked. unitRanges: one list of
 * {start, end_exclusive} per unit.
 */
export function allBlockedRanges(unitRanges, fromIso, days) {
  if (!Array.isArray(unitRanges) || !unitRanges.length) return [];
  const out = [];
  for (const d of nightList(fromIso, days)) {
    const next = new Date(Date.parse(`${d}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
    if (unitRanges.every((ranges) => (ranges || []).some((b) => d >= b.start && d < b.end_exclusive))) out.push({ start: d, end_exclusive: next });
  }
  return out;
}

const ZERO_DECIMAL = new Set(['IDR', 'JPY', 'KRW', 'VND', 'CLP', 'HUF']);
// Rounding step for a "from" price: a clean number a guest can read (2,380,000 rather than 2,376,412).
const STEP = { IDR: 10000, VND: 10000, KRW: 1000, JPY: 100, CLP: 1000, HUF: 100 };

/** Round a price to the step of its currency (whole numbers for the others). */
export const roundPrice = (amount, currency) => {
  const step = STEP[String(currency).toUpperCase()];
  return step ? Math.max(step, Math.round(Number(amount) / step) * step) : Math.round(Number(amount));
};

/** Amount in another currency through USD rates (units of the currency per 1 USD). Throws when a rate is missing: no guessing. */
export function convertAmount(amount, from, to, rates) {
  const f = String(from).toUpperCase();
  const t = String(to).toUpperCase();
  if (f === t) return Number(amount);
  const rf = f === 'USD' ? 1 : rates?.[f];
  const rt = t === 'USD' ? 1 : rates?.[t];
  if (!(rf > 0) || !(rt > 0)) throw new Error(`No exchange rate for ${!(rf > 0) ? f : t}`);
  return (Number(amount) / rf) * rt;
}

/** Meta's price format: amount and the ISO currency code. Two decimals, none for currencies without minor units (IDR). */
export const priceString = (amount, currency) => {
  const c = String(currency).toUpperCase();
  return ZERO_DECIMAL.has(c) ? `${Math.round(Number(amount))} ${c}` : `${Number(amount).toFixed(2)} ${c}`;
};

/** "IDR 2,380,000" for texts a guest reads. */
export const priceLabel = (amount, currency) => `${String(currency).toUpperCase()} ${Math.round(Number(amount)).toLocaleString('en-US')}`;

/** Booking page of the villa with tracking for the WhatsApp catalog. */
export function productUrl(baseUrl, key) {
  const u = new URL(baseUrl);
  u.searchParams.set('utm_source', 'whatsapp');
  u.searchParams.set('utm_medium', 'catalog');
  u.searchParams.set('utm_campaign', `wa_catalog_${String(key).replace(/[^a-z0-9_]/gi, '')}`);
  return u.toString();
}

const USABLE = new Set(['confirmed', 'elev8']);

/**
 * Product text, laid out to be read on a phone: the place, the price line, the features as a short list, the booking line.
 * Blocks are separated by a blank line, the features by line breaks.
 * When the fact sheet has a "catalog" list (short sentences written for guests, each one taken from the facts) exactly those
 * sentences are used. Without it the confirmed and Elev8 facts and what is NOT available are used. Facts that are not
 * confirmed (the open list) never go in. Without a sheet the highlights of the property are used.
 */
export function describeVilla(prop, sheet, fromLine = '') {
  const intro = `${prop.name}${prop.area ? ` in ${prop.area}, Bali` : ' in Bali'}.`;
  const bullets = [];
  if (sheet && Array.isArray(sheet.catalog) && sheet.catalog.length) {
    for (const t of sheet.catalog) if (t) bullets.push(String(t).trim());
  } else if (sheet) {
    for (const x of sheet.facts || []) if (USABLE.has(x.status) && x.text) bullets.push(String(x.text).trim());
    for (const a of sheet.absent || []) if (a.text) bullets.push(String(a.text).trim());
  } else {
    if (prop.guests) bullets.push(`Sleeps up to ${prop.guests} guests.`);
    if (prop.highlights) bullets.push(`${String(prop.highlights).replace(/\.$/, '')}.`);
  }
  const blocks = [intro];
  if (fromLine) blocks.push(fromLine);
  if (bullets.length) blocks.push(bullets.map((b) => `\u2022 ${b}`).join('\n'));
  blocks.push('Book direct on elevate-villas.com.');
  const text = blocks.join('\n\n');
  return text.length > 4000 ? `${text.slice(0, 3990).replace(/\s+\S*$/, '')}.` : text;
}

// The apartment categories: one Elev8 id holds the photos of several galleries (a folder per gallery, each numbered from 1).
// For these the gallery of the website page is used, so the catalog shows the same photos as the booking page.
// key: the Elev8 id of the category, value: the photo folder that the website page of the category shows.
const PREFERRED_FOLDER = {
  '49f64992-d0c0-4566-9edf-fe7ce185f36b': '266e5503-d7fb-4349-9959-f01f03f1d290', // The R Apartments Studio
  '15a053e0-d4b8-491f-ae5b-fefcda8f8493': '42b7110f-8164-4052-8fde-847de20f6965', // Mezzanine with balcony
  '1ed9c430-09bd-497e-816f-ca5837296b3f': '5d711329-c94e-4480-96ed-9c37cee35fed' // Mezzanine with plunge pool
};
const folderOf = (url) => /\/listing\/([0-9a-f-]{36})\//i.exec(String(url))?.[1] || '';

/**
 * Images of an Elev8 listing in gallery order, as public URLs, at most max.
 * One listing id can hold the galleries of several folders. Each gallery numbers its photos from 1, so sorting everything
 * together mixes them. A category with a known website gallery uses that folder. Otherwise the folder of the first photo is used;
 * a very short one (fewer than 4 photos) gives way to the longest.
 */
export function galleryUrls(results, max = 10) {
  const usable = (results || []).filter((x) => x && typeof x.image_url === 'string' && /^https:\/\//.test(x.image_url));
  const byFolder = new Map();
  for (const x of usable) {
    const k = folderOf(x.image_url);
    if (!byFolder.has(k)) byFolder.set(k, []);
    byFolder.get(k).push(x);
  }
  const folders = [...byFolder.entries()];
  const preferred = PREFERRED_FOLDER[usable[0]?.listing_id];
  let chosen = (preferred && byFolder.get(preferred)) || folders[0]?.[1] || [];
  if (!(preferred && byFolder.get(preferred)) && chosen.length < 4) {
    const longest = folders.map(([, v]) => v).sort((a, b) => b.length - a.length)[0];
    if (longest && longest.length > chosen.length) chosen = longest;
  }
  const seen = new Set();
  return [...chosen]
    .sort((a, b) => (a.sequence ?? 999) - (b.sequence ?? 999))
    .map((x) => x.image_url)
    .filter((u) => (seen.has(u) ? false : (seen.add(u), true)))
    .slice(0, max);
}

/** What Meta says about a batch: finished or not, and the problems in plain lines. */
export function batchSummary(d) {
  const errors = (d?.errors || []).map((e) => `${e.id ?? `line ${e.line ?? '?'}`}: ${String(e.message || e.error_message || 'error').slice(0, 200)}`);
  return { status: d?.status || 'unknown', errorsTotal: Number(d?.errors_total_count) || errors.length, warningsTotal: Number(d?.warnings_total_count) || 0, errors };
}
