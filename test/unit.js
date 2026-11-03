import assert from 'node:assert/strict';
import { bookingLink, BOOKING_PARAMS, DM_UTM, systemPrompt, TOOLS } from '../src/agent/tools.js';
import { villaView, linkResult, maxGuests } from '../src/agent/villas.js';
import { areaFor, areaPromptBlock, checkArea, how } from '../src/area.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };

const samalas = { key: 'samalas', name: 'The R Villa Samalas', area: 'Pererenan', type: 'villa', guests: 8, size_m2: 300, bedrooms: '4', url: 'https://www.elevate-villas.com/property/the-r-villa-samalas-4br-retreat-in-pererenan-a1200ded', highlights: 'Retreat in Pererenan', open_questions: 'old' };
const plain = { key: 'luwa', name: 'The R Villa Luwa', area: 'Pererenan', type: 'villa', guests: 10, bedrooms: '5', url: 'https://www.elevate-villas.com/property/luwa', open_questions: 'Facts to be confirmed' };

// booking link
t('link has the four parameters with the agreed names', () => {
  const u = new URL(bookingLink(samalas.url, { checkIn: '2027-01-10', checkOut: '2027-01-17', adults: 4, children: 2 }));
  assert.equal(u.searchParams.get('check_in_date'), '2027-01-10');
  assert.equal(u.searchParams.get('check_out_date'), '2027-01-17');
  assert.equal(u.searchParams.get('number_of_adult'), '4');
  assert.equal(u.searchParams.get('number_of_children'), '2');
  assert.deepEqual(Object.values(BOOKING_PARAMS).sort(), ['check_in_date', 'check_out_date', 'number_of_adult', 'number_of_children']);
});
t('link keeps the path and adds utm', () => {
  const u = new URL(bookingLink(samalas.url, { checkIn: '2027-01-10', checkOut: '2027-01-17', adults: 2, children: 0 }, DM_UTM));
  assert.equal(u.pathname, '/property/the-r-villa-samalas-4br-retreat-in-pererenan-a1200ded');
  assert.equal(u.searchParams.get('number_of_children'), '0');
  assert.equal(u.searchParams.get('utm_campaign'), 'agent');
});
t('link keeps an existing query', () => {
  const u = new URL(bookingLink('https://x.test/p?lang=de', { checkIn: '2027-01-10', checkOut: '2027-01-11', adults: 1 }));
  assert.equal(u.searchParams.get('lang'), 'de');
  assert.equal(u.searchParams.get('number_of_children'), '0');
});
t('link rejects bad input', () => {
  const ok = { checkIn: '2027-01-10', checkOut: '2027-01-17', adults: 2, children: 0 };
  assert.throws(() => bookingLink(null, ok));
  assert.throws(() => bookingLink(samalas.url, { ...ok, checkIn: '10.01.2027' }));
  assert.throws(() => bookingLink(samalas.url, { ...ok, checkOut: '2027-01-10' }));
  assert.throws(() => bookingLink(samalas.url, { ...ok, adults: 0 }));
  assert.throws(() => bookingLink(samalas.url, { ...ok, adults: 2.5 }));
  assert.throws(() => bookingLink(samalas.url, { ...ok, children: -1 }));
});

// tool result
const input = { villa: 'samalas', check_in: '2027-01-10', check_out: '2027-01-17', adults: 6, children: 2 };
t('samalas takes 10 guests although the table says 8', () => {
  assert.equal(maxGuests(samalas), 10);
  const r = linkResult(samalas, input);
  assert.equal(r.ok, true);
  assert.match(r.booking_link, /number_of_adult=6/);
});
t('too many guests gives no link', () => {
  const r = linkResult(samalas, { ...input, adults: 8, children: 3 });
  assert.equal(r.ok, false);
  assert.equal(r.booking_link, undefined);
  assert.match(r.note, /up to 10/);
});
t('bad dates come back as a note, not an exception', () => {
  const r = linkResult(samalas, { ...input, check_in: 'tomorrow' });
  assert.equal(r.ok, false);
  assert.match(r.note, /YYYY-MM-DD/);
});
t('villa without sheet uses the table', () => {
  assert.equal(maxGuests(plain), 10);
  assert.equal(linkResult(plain, { ...input, adults: 9, children: 2 }).ok, false);
  assert.equal(linkResult(plain, { ...input, adults: 9, children: 1 }).ok, true);
});

// villa view
t('villa view is corrected by the sheet', () => {
  const v = villaView(samalas);
  assert.equal(v.guests, 10);
  assert.equal(v.size_m2, undefined);
  assert.equal(v.plot_m2, 300);
  assert.match(v.bedrooms, /bunk-bed/);
  assert.ok(v.verified_facts.length > 5);
  assert.ok(v.not_available.includes('No bathtub.'));
  assert.ok(v.uncertain_facts.some((x) => /beachfront/.test(x)));
  assert.ok(!v.uncertain_facts.includes('old'));
  assert.match(v.booking_link, /utm_campaign=agent/);
});
t('villa view without sheet is unchanged', () => {
  const v = villaView(plain, true);
  assert.equal(v.guests, 10);
  assert.equal(v.uncertain_facts, 'Facts to be confirmed');
  assert.equal(v.verified_facts, undefined);
  assert.match(v.note, /Several units/);
});

// tool definition and prompt
t('tool is defined with all fields required', () => {
  const tool = TOOLS.find((x) => x.name === 'build_booking_link');
  assert.deepEqual(tool.input_schema.required, ['villa', 'check_in', 'check_out', 'adults', 'children']);
});
t('prompt explains when to build the link', () => {
  const p = systemPrompt('2026-11-03');
  assert.match(p, /build_booking_link/);
  assert.match(p, /adults and how many children/);
});

// area
t('area loads', () => {
  const a = areaFor('samalas');
  assert.ok(a.spots.length > 30);
  assert.equal(areaFor('nope'), null);
  assert.ok(!JSON.stringify(a).match(/\bIDR\b|Rp\.? ?\d|\d(?:[.,]\d)? ?stars?/i), 'area file has no prices or ratings');
});
t('how() never calls a long walk a walk', () => {
  assert.equal(how({ walkMin: 3 }), '3 min on foot');
  assert.match(how({ walkMin: 34, scooterMin: 7 }), /7 min by scooter/);
  assert.match(how({ walkMin: 27 }), /not a walk/);
  assert.match(how({ distanceKm: 1.9 }), /1\.9 km/);
  assert.match(how({ where: 'Pererenan' }), /in Pererenan/);
});
t('prompt block: short for normal posts, full for neighbourhood', () => {
  const short = areaPromptBlock([samalas]);
  const full = areaPromptBlock([samalas], { all: true });
  assert.ok(short.length < full.length);
  assert.ok(short.some((l) => l.includes('Shortcut Cafe Canggu (cafe): 3 min on foot')));
  assert.ok(!short.some((l) => l.includes('Tanah Lot')));
  assert.ok(full.some((l) => l.includes('Tanah Lot')));
  assert.ok(full.some((l) => l.includes('not for swimming')));
  assert.ok(full.some((l) => l.includes('Nyepi')));
  assert.ok(!short.some((l) => l.includes('Nyepi')));
  assert.deepEqual(areaPromptBlock([plain]), []);
});
const plan = { properties: [samalas] };
t('check: clean copy passes', () => {
  assert.deepEqual(checkArea({ captions: { instagram: 'Coffee at Shortcut Cafe, 3 min on foot. Sunset at Pererenan Beach, 7 min by scooter.' } }, plan), []);
});
t('check: prices, ratings, sea swimming and wrong walks warn', () => {
  const w = checkArea({ captions: { instagram: 'Dinner for IDR 150,000, rated 4.8 stars. Swim in the ocean, then a 25 min walk to the beach. 12-minute walk to the cafe.' } }, plan);
  assert.ok(w.some((x) => /rupiah/.test(x)));
  assert.ok(w.some((x) => /star ratings/.test(x)));
  assert.ok(w.some((x) => /not for swimming/.test(x)));
  assert.ok(w.some((x) => /"25 min walk"/.test(x)));
  assert.ok(!w.some((x) => /12-minute walk/.test(x)), '12 min is a known walk');
});
t('check: villas without area file are not checked', () => {
  assert.deepEqual(checkArea({ captions: { instagram: 'IDR 5, swim in the sea' } }, { properties: [plain] }), []);
});

console.log(`\n${n} tests passed`);
