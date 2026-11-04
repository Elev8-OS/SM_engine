import assert from 'node:assert/strict';
import { cleanPromo, problem, isLive, appliesTo, promoView, promoPromptBlock, checkPromoCopy, matchGaps, suggest, normaliseCode, addDays } from '../src/promo-rules.js';
import { villaView, linkResult } from '../src/agent/villas.js';
import { bookingLink, PROMO_PARAM, TOOLS, systemPrompt } from '../src/agent/tools.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };
const promo = (o = {}) => ({ property_key: 'samalas', title: 'Jan', code: 'SAMALAS-JAN', terms: 'Free early check-in, 2 hours', status: 'active', stay_from: '2027-01-05', stay_to: '2027-01-31', book_until: '2026-12-15', min_nights: 5, ...o });

t('code is normalised', () => {
  assert.equal(normaliseCode(' samalas jan'), 'SAMALASJAN');
  assert.equal(cleanPromo({ code: 'ab-12' }).code, 'AB-12');
  assert.throws(() => cleanPromo({ code: 'a' }), /letters, digits/);
  assert.throws(() => cleanPromo({ code: 'THIS-IS-FAR-TOO-LONG-FOR-A-CODE' }), /letters, digits/);
  assert.equal(cleanPromo({ code: '' }).code, '');
});
t('create needs a villa and a title', () => {
  assert.throws(() => cleanPromo({ title: 'x' }, { create: true }), /villa/);
  assert.throws(() => cleanPromo({ property_key: 'samalas' }, { create: true }), /title/);
  assert.equal(cleanPromo({ property_key: 'ALL', title: ' Test ' }, { create: true }).property_key, 'all');
});
t('dates, minimum stay and status are checked', () => {
  assert.throws(() => cleanPromo({ stay_from: '10.01.2027' }), /YYYY-MM-DD/);
  assert.equal(cleanPromo({ stay_from: '' }).stay_from, null);
  assert.throws(() => cleanPromo({ min_nights: 0 }), /whole number/);
  assert.equal(cleanPromo({ min_nights: '5' }).min_nights, 5);
  assert.equal(cleanPromo({ min_nights: '' }).min_nights, null);
  assert.throws(() => cleanPromo({ status: 'live' }), /status/);
  assert.deepEqual(cleanPromo({ foo: 1 }), {});
});
t('an active promotion needs code and terms, and a sane window', () => {
  assert.equal(problem(promo()), null);
  assert.match(problem(promo({ code: '' })), /code/);
  assert.match(problem(promo({ terms: ' ' })), /terms/);
  assert.equal(problem(promo({ code: '', status: 'draft' })), null);
  assert.match(problem(promo({ stay_from: '2027-02-01' })), /ends before/);
});
t('live while neither the booking day nor the stay window has passed', () => {
  assert.equal(isLive(promo(), '2026-11-04'), true);
  assert.equal(isLive(promo(), '2026-12-15'), true);
  assert.equal(isLive(promo(), '2026-12-16'), false);
  assert.equal(isLive(promo({ book_until: null }), '2027-01-31'), true);
  assert.equal(isLive(promo({ book_until: null }), '2027-02-01'), false);
  assert.equal(isLive(promo({ status: 'draft' }), '2026-11-04'), false);
  assert.equal(isLive(promo({ code: '' }), '2026-11-04'), false);
});
t('a stay qualifies for villa, window and minimum nights', () => {
  assert.equal(appliesTo(promo(), 'samalas', '2027-01-10', '2027-01-17').ok, true);
  assert.equal(appliesTo(promo({ property_key: 'all' }), 'patuha', '2027-01-10', '2027-01-17').ok, true);
  assert.match(appliesTo(promo(), 'patuha', '2027-01-10', '2027-01-17').why, /another villa/);
  assert.match(appliesTo(promo(), 'samalas', '2027-01-02', '2027-01-09').why, /from 2027-01-05/);
  assert.match(appliesTo(promo(), 'samalas', '2027-01-28', '2027-02-04').why, /end by 2027-01-31/);
  assert.equal(appliesTo(promo(), 'samalas', '2027-01-26', '2027-01-31').ok, true, 'check-out on the last day is fine');
  assert.match(appliesTo(promo(), 'samalas', '2027-01-10', '2027-01-13').why, /at least 5 nights/);
});
t('what Lea sees', () => {
  const v = promoView(promo({ stay_from: null, min_nights: null }));
  assert.equal(v.code, 'SAMALAS-JAN');
  assert.equal(v.stay_from, undefined);
  assert.equal(v.villa, 'samalas');
});
t('post prompt: no offer without a promotion, exact terms with one', () => {
  assert.match(promoPromptBlock([]).join('\n'), /No promotion is active/);
  const b = promoPromptBlock([promoView(promo())]).join('\n');
  assert.match(b, /code SAMALAS-JAN/);
  assert.match(b, /Free early check-in/);
  assert.match(b, /at least 5 nights/);
  assert.match(b, /only in the Instagram caption/);
});
t('copy check without a promotion flags offer wording', () => {
  const plan = { promotions: [] };
  assert.equal(checkPromoCopy({ captions: { instagram: 'A calm week in Pererenan.' }, lines: [{ headline: 'Pool days' }] }, plan).length, 0);
  assert.match(checkPromoCopy({ captions: { instagram: 'Book now and get 15% off' } }, plan)[0], /without an active promotion/);
  assert.match(checkPromoCopy({ captions: { instagram: 'Use code BALI10 today' } }, plan)[0], /without an active promotion/);
  assert.match(checkPromoCopy({ captions: { instagram: 'Free airport transfer for you' } }, plan)[0], /without an active promotion/);
  assert.equal(checkPromoCopy({ captions: { instagram: 'Book direct. Best rate guaranteed.' } }, plan).length, 0);
});
t('copy check with a promotion: only the active code, caption only', () => {
  const plan = { promotions: [promoView(promo())] };
  assert.equal(checkPromoCopy({ captions: { instagram: 'Use code SAMALAS-JAN for a free early check-in.' }, lines: [{ headline: 'Pool' }] }, plan).length, 0);
  assert.match(checkPromoCopy({ captions: { instagram: 'Use code WRONG10 now' } }, plan)[0], /not in the active promotions: WRONG10/);
  assert.match(checkPromoCopy({ captions: { instagram: 'Use code SAMALAS-JAN' }, lines: [{ headline: 'Code SAMALAS-JAN' }] }, plan)[0], /caption only/);
  assert.match(checkPromoCopy({ captions: { instagram: 'Take 20% off with SAMALAS-JAN' } }, plan)[0], /Percentage not in the promotion terms/);
  assert.equal(checkPromoCopy({ captions: { instagram: 'A code for you, as a thank you' } }, plan).length, 0, 'words after "code" are not a code');
});
const gaps = [
  { listing_name: 'MASURAI - Pererenan the R Villa Masurai', unbooked_nights: 61, first_gap_date: '2026-11-04' },
  { listing_name: 'The R Villa Samalas | 4BR Retreat', unbooked_nights: 23, first_gap_date: '2026-12-06' },
  { listing_name: 'Tranquil the R Villa Patuha-Pool', unbooked_nights: 36, first_gap_date: '2026-11-04' },
  { listing_name: 'The R Villa Merapi', unbooked_nights: 61, first_gap_date: '2026-11-04' },
  { listing_name: 'The R Villa Merapi', unbooked_nights: 30, first_gap_date: '2026-11-06' },
  { listing_name: 'The R Apartment Holzfluh', unbooked_nights: 61, first_gap_date: '2026-11-04' }
];
const props = [{ key: 'masurai', name: 'The R Villa Masurai', guests: 4 }, { key: 'samalas', name: 'The R Villa Samalas', guests: 10 }, { key: 'patuha', name: 'The R Villa Patuha', guests: 8 }, { key: 'merapi', name: 'The R Villa Merapi', guests: 3 }, { key: 'luwa', name: 'The R Villa Luwa', guests: 10 }];
t('gaps are matched to properties, units added up, other listings ignored', () => {
  const m = matchGaps(gaps, props, 60);
  assert.equal(m.length, 4, 'luwa has no gap row, the Swiss apartment matches nothing');
  const mer = m.find((x) => x.property_key === 'merapi');
  assert.equal(mer.units, 2);
  assert.equal(mer.open_nights, 91);
  assert.equal(Math.round(mer.share * 100), 76);
  assert.equal(mer.first_gap_date, '2026-11-04');
  assert.equal(m.find((x) => x.property_key === 'masurai').share, 1);
});
t('suggestions follow the share of open nights', () => {
  const s = suggest(matchGaps(gaps, props, 60), '2026-11-04', 60);
  const by = (id) => s.find((x) => x.id === id);
  assert.equal(by('masurai-short_notice').benefit, 'early_checkin');
  assert.equal(by('masurai-short_notice').book_until, '2026-11-25');
  assert.equal(by('masurai-short_notice').stay_from, '2026-11-06');
  assert.equal(by('masurai-short_notice').stay_to, '2026-12-19');
  assert.equal(by('patuha-long_stay').benefit, 'transfer_van');
  assert.equal(by('patuha-long_stay').min_nights, 5);
  assert.equal(by('merapi-short_notice').benefit, 'early_checkin', 'merapi has 76 percent free nights');
  assert.equal(by('merapi-long_stay'), undefined);
  assert.equal(by('masurai-couples').benefit, 'romantic', 'small villa with many free nights');
  assert.equal(by('samalas-short_notice'), undefined, 'samalas has 38 percent free nights');
  assert.equal(by('samalas-extras').benefit, 'late_checkout');
  assert.equal(s[0].share, 1);
});
t('a moderate share gets the light idea', () => {
  const s = suggest([{ property_key: 'dempo', name: 'The R Villa Dempo', guests: 4, units: 1, open_nights: 25, share: 25 / 60, first_gap_date: '2026-12-10' }], '2026-11-04', 60);
  assert.equal(s[0].type, 'extras');
  assert.equal(s[0].benefit, 'late_checkout');
  assert.equal(s[0].stay_from, '2026-12-10', 'never before the first gap');
});
t('date helper', () => assert.equal(addDays('2026-12-30', 3), '2027-01-02'));

// ---- Lea: promotions in the villa view and in the booking link ----
const sam = { key: 'samalas', name: 'The R Villa Samalas', guests: 8, url: 'https://www.elevate-villas.com/property/x' };
const live = [promo({ stay_from: '2027-01-05', stay_to: '2027-01-31' })];
const inp = { villa: 'samalas', check_in: '2027-01-10', check_out: '2027-01-17', adults: 4, children: 2 };
const qs = (u) => new URL(u).searchParams;
t('villa view lists active promotions', () => {
  assert.equal(PROMO_PARAM, 'promo_code');
  assert.equal(villaView(sam, false, []).active_promotions, undefined);
  assert.equal(villaView(sam, false, live).active_promotions[0].code, 'SAMALAS-JAN');
});
t('booking link carries a valid code', () => {
  assert.equal(qs(bookingLink(sam.url, { checkIn: '2027-01-10', checkOut: '2027-01-17', adults: 2, promo: 'samalas-jan' })).get('promo_code'), 'SAMALAS-JAN');
  assert.throws(() => bookingLink(sam.url, { checkIn: '2027-01-10', checkOut: '2027-01-17', adults: 2, promo: 'x' }), /not a valid code/);
});
t('tool result: code, currency and the other parameters together', () => {
  const ok = linkResult(sam, { ...inp, promo_code: 'samalas-jan', currency: 'IDR' }, { promos: live });
  assert.equal(ok.ok, true);
  assert.equal(ok.promo_code, 'SAMALAS-JAN');
  assert.equal(qs(ok.booking_link).get('promo_code'), 'SAMALAS-JAN');
  assert.equal(qs(ok.booking_link).get('currency'), 'IDR');
  assert.equal(qs(ok.booking_link).get('number_of_adult'), '4');
});
t('a code that is not active, wrong villa or wrong dates is refused', () => {
  const unknown = linkResult(sam, { ...inp, promo_code: 'MADEUP10' }, { promos: live });
  assert.equal(unknown.ok, false);
  assert.match(unknown.note, /not an active promotion/);
  const wrongDates = linkResult(sam, { ...inp, check_in: '2027-03-01', check_out: '2027-03-08', promo_code: 'SAMALAS-JAN' }, { promos: live });
  assert.equal(wrongDates.ok, false);
  assert.match(wrongDates.note, /Do not offer it for this stay/);
  const other = linkResult({ ...sam, key: 'patuha', name: 'The R Villa Patuha' }, { ...inp, villa: 'patuha', promo_code: 'SAMALAS-JAN' }, { promos: live });
  assert.equal(other.ok, false);
  assert.equal(linkResult(sam, inp, { promos: live }).promo_code, undefined, 'never added on its own');
});
t('tool definition and prompt', () => {
  const tool = TOOLS.find((x) => x.name === 'build_booking_link');
  assert.ok(tool.input_schema.properties.promo_code);
  assert.ok(!tool.input_schema.required.includes('promo_code'));
  assert.match(systemPrompt('2026-11-04'), /active_promotions/);
});
console.log(`\n${n} tests passed`);
