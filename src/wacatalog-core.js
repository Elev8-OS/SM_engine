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

/** Meta's price format: amount with two decimals, a space and the ISO currency code. */
export const priceString = (amount, currency) => `${Number(amount).toFixed(2)} ${String(currency).toUpperCase()}`;

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
 * Product text from the fact sheet: only confirmed or Elev8 facts and what is NOT available. Facts that are not confirmed
 * (the open list) never go in. Without a sheet the highlights of the property are used.
 */
export function describeVilla(prop, sheet) {
  const intro = `${prop.name}${prop.area ? ` in ${prop.area}, Bali` : ' in Bali'}.`;
  const parts = [];
  if (sheet) {
    for (const x of sheet.facts || []) if (USABLE.has(x.status) && x.text) parts.push(String(x.text).trim());
    for (const a of sheet.absent || []) if (a.text) parts.push(String(a.text).trim());
  } else {
    if (prop.guests) parts.push(`Sleeps up to ${prop.guests} guests.`);
    if (prop.highlights) parts.push(`${String(prop.highlights).replace(/\.$/, '')}.`);
  }
  const text = [intro, ...parts, 'Book direct on elevate-villas.com.'].join(' ');
  return text.length > 4000 ? `${text.slice(0, 3990).replace(/\s+\S*$/, '')}.` : text;
}

/** Images of an Elev8 listing in gallery order, as public URLs, at most max. */
export function galleryUrls(results, max = 10) {
  const seen = new Set();
  return (results || [])
    .filter((x) => x && typeof x.image_url === 'string' && /^https:\/\//.test(x.image_url))
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
