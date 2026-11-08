import { elev8Tool as realElev8, pricelabsRows as realRows, priceIds } from './clients.js';
import { availabilityFrom, priceSummary, nightsBetween } from './tools.js';

// The products that stand for several units: the three apartment categories and the shared villa Merapi (rooms).
// Until now the assistant refused them ("several units, the team confirms"). The WhatsApp catalog already worked them out in the same way:
//   availability  the category is free when at least ONE of its units is free for every night (the calendar of each unit in Elev8)
//   price         PriceLabs: one price list per apartment category, two for Merapi (the lowest total counts)
//   link          one booking page per category (the same pages as in the catalog, so a product card can follow the link)
// The tools take the keys apt-studio, apt-mezzanine, apt-plunge and merapi like a villa key.

const SITE = 'https://www.elevate-villas.com';
const MERAPI_PL = ['afa397b2-7857-42f2-afe7-76f44e2372a4___05e77a25-1600-48b4-b984-5369062a9d0b', 'afa397b2-7857-42f2-afe7-76f44e2372a4___d92c422a-c8af-4679-913c-adc3a0d94c74'];

const aptNo = (name) => {
  const m = /\bAPT\s*0?(\d{1,2})\b/i.exec(String(name || ''));
  return m ? Number(m[1]) : null;
};
const apt = (nums) => (u) => nums.includes(aptNo(u.internal_name));

export const CATEGORIES = {
  'apt-studio': {
    kind: 'apartment',
    name: 'The R Apartments Studio',
    // Some studios take 4 guests, one only 2 (fact sheet): more than 2 guests is confirmed by the team.
    guests: 2,
    url: `${SITE}/property/the-r-apartments-studio-dc20bb99`,
    query: 'APT',
    pick: apt([4, 5, 6, 7]),
    priceKeys: ['apt-studio'],
    note: 'Studio apartments, several units. Free means at least one studio is free. Up to 2 guests are quoted here; for 3 or 4 guests the team confirms which studio fits.'
  },
  'apt-mezzanine': {
    kind: 'apartment',
    name: 'The R Apartments Mezzanine',
    guests: 3,
    url: `${SITE}/property/the-r-pererenan-mezzanine-apartment-w-balcony-90672e94`,
    query: 'APT',
    pick: apt([8, 9, 10, 11]),
    priceKeys: ['apt-mezzanine'],
    note: 'Mezzanine apartments, several units. Free means at least one unit is free.'
  },
  'apt-plunge': {
    kind: 'apartment',
    name: 'The R Apartments Mezzanine with Plunge Pool',
    guests: 3,
    url: `${SITE}/property/1-3-plunge-pool-0efd1608`,
    query: 'APT',
    pick: apt([1, 2, 3]),
    priceKeys: ['apt-plunge'],
    note: 'Mezzanine studios with a private plunge pool, several units. Free means at least one unit is free.'
  },
  merapi: {
    kind: 'room',
    name: 'The R Villa Merapi (rooms)',
    guests: 2,
    url: `${SITE}/property/the-r-villa-merapi-0e45abbd`,
    query: 'merapi',
    pick: (u) => /merapi/i.test(String(u.internal_name || '')),
    priceIds: MERAPI_PL,
    note: 'A shared villa with five private rooms of up to 2 guests each. Free means at least one room is free. The price is the lowest room price; more than 2 guests need several rooms, the team confirms that.'
  }
};

/** The category of a key, or null for a normal villa. */
export const categoryOf = (key) => CATEGORIES[String(key || '').toLowerCase()] || null;

/** The three apartment categories as property rows (what list_villas shows next to the villas). promoKey: promotions use "apartments". */
export function categoryRows() {
  return Object.entries(CATEGORIES)
    .filter(([, c]) => c.kind === 'apartment')
    .map(([key, c]) => ({ key, name: c.name, area: 'Pererenan', type: 'apartment', guests: c.guests, size_m2: null, bedrooms: null, url: c.url, highlights: null, open_questions: null, promoKey: 'apartments', note: c.note, linkNote: 'Share this link exactly as it is. The booking page shows which unit is free.' }));
}

/** A property row of the table, with what the category knows better (Merapi: page, guests, notes). Other rows stay as they are. */
export function enrich(p) {
  const c = categoryOf(p?.key);
  if (!c || c.kind === 'apartment') return p;
  return { ...p, guests: c.guests, url: c.url, promoKey: p.key, note: c.note, linkNote: 'Share this link exactly as it is. The booking page shows which room is free.' };
}

/** The row of an apartment category (or null). */
export const categoryRow = (key) => categoryRows().find((r) => r.key === String(key || '').toLowerCase()) || null;

/** Availability of a category from the unit calendars: free when at least one unit has no blocked night in the stay. Pure. */
export function pickAvailability(units, checkIn, checkOut) {
  if (!units.length) return { available: null, note: 'No calendar found for these units. The team confirms.' };
  const results = units.map((u) => availabilityFrom(u, checkIn, checkOut));
  if (results.some((r) => r.available === true)) return { available: true, nights: nightsBetween(checkIn, checkOut).length, note: 'At least one unit of this category is free for these dates.' };
  if (results.some((r) => r.available === null)) return { available: null, note: 'Some of these dates are not verified. The team confirms.' };
  return { available: false, of_nights: nightsBetween(checkIn, checkOut).length, note: 'Every unit of this category has a booked night in this stay.' };
}

export async function categoryAvailability(cat, checkIn, checkOut, { elev8Tool = realElev8 } = {}) {
  const to = new Date(Date.parse(`${checkOut}T00:00:00Z`) + 30 * 86400000).toISOString().slice(0, 10);
  const res = await elev8Tool('get_blocked_dates', { from_date: checkIn, to_date: to, listing_name: cat.query, listing_tag: '' });
  return pickAvailability((res?.results || []).filter(cat.pick), checkIn, checkOut);
}

/** The lowest total of the price lists of a category. Same summary as a villa (currency, total, average, minimum stay). */
export async function categoryPrices(cat, checkIn, checkOut, { rowsFn = realRows, ids = priceIds } = {}) {
  const list = (cat.priceIds || cat.priceKeys.map((k) => ids()[k])).filter(Boolean);
  if (!list.length) return { ok: false, note: 'No price source for this category yet. The booking page shows the price for these dates.' };
  const sums = [];
  for (const id of list) {
    const { currency, rows } = await rowsFn(id, checkIn, checkOut);
    const s = priceSummary(rows, checkIn, checkOut, currency);
    if (s.ok) sums.push(s);
  }
  if (!sums.length) return { ok: false, note: 'No price available for these nights. The booking page shows the price for these dates.' };
  const best = sums.reduce((a, b) => (b.total < a.total ? b : a));
  return { ...best, price_of: cat.kind === 'room' ? 'lowest room' : 'category (lowest unit)', note: 'This is the lowest price of the category. The booking page shows the exact price.' };
}
