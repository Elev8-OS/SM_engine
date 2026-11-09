import assert from 'node:assert/strict';
import { bookingOn, normalizePhone, validEmail, prepareBooking, createBooking, PREPARE_TOOL, BOOK_TOOL, BOOKING_NOTE } from '../src/agent/booking.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };

// A fake engine: one villa, a quote of CHF 677 for 6 nights, a store that behaves like agent_settings.
let store;
let clock;
const calls = [];
const q = async (sql, params = []) => {
  if (/^insert into agent_settings/.test(sql.trim())) {
    store.set(params[0], { value: JSON.parse(params[1]), at: clock });
    return [];
  }
  if (/count\(\*\)/.test(sql)) return [{ n: [...store.keys()].filter((k) => k.startsWith('book:')).length }];
  if (/^select value, extract/.test(sql)) {
    const r = store.get(params[0]);
    return r ? [{ value: r.value, age_s: Math.floor((clock - r.at) / 1000) }] : [];
  }
  throw new Error(`unexpected sql ${sql}`);
};
const QUOTE = { total_price: 677, currency: 'CHF', accommodation_total: 677, fees_total: 0, taxes_total: 0, discounts_total: 0, nights: 6 };
const mk = (over = {}) => ({
  env: { BOOKING_IN_CHAT: 'on' },
  villa: async (k) => ({ key: k, name: k === 'apt-mezzanine' ? 'The R Apartments Mezzanine' : 'The R Villa Sinabung', url: 'https://x' }),
  unsupported: (k) => k === 'merapi',
  maxGuests: () => 4,
  checkDates: (i) => ({ ci: i.check_in, co: i.check_out }),
  contactPhone: async () => '4179123456' + '7',
  promoKnown: async (c) => c === 'LEA-ANNA',
  resolveStay: async (_p, st) => ({ ok: true, listingName: 'Cozy 2BR the R Villa Sinabung', quote: { ...QUOTE, ...(st.promo ? { total_price: 640, discounts_total: 37 } : {}) } }),
  elev8: async (name, args) => { calls.push({ name, args }); return { reservation_id: 'PZTJKJ', payment_url: 'https://pay.example/abc', payment_link_expires_at: '2026-11-11T10:00:00Z' }; },
  q,
  ...over
});
const reset = () => { store = new Map(); clock = 1_000_000; calls.length = 0; };
const base = { villa: 'sinabung', check_in: '2027-01-18', check_out: '2027-01-24', adults: 2, children: 0, guest_first_name: 'Anna', guest_last_name: 'Muller', guest_email: 'anna@example.com' };
const wa = (id) => ({ channel: 'whatsapp', contactId: 'c1', inquiryId: id });
const ig = (id) => ({ channel: 'instagram', contactId: 'c2', inquiryId: id });

await t('phone: E.164, a local number is never guessed', () => {
  assert.deepEqual(normalizePhone('+41 79 123 45 67'), { ok: true, phone: '+41791234567' });
  assert.deepEqual(normalizePhone('0041 79 123 45 67'), { ok: true, phone: '+41791234567' });
  assert.deepEqual(normalizePhone('+62 812-3456-7890'), { ok: true, phone: '+6281234567890' });
  assert.equal(normalizePhone('079 123 45 67').reason, 'no_country_code');
  assert.equal(normalizePhone('41791234567').reason, 'no_country_code', 'typed digits without plus are not trusted');
  assert.deepEqual(normalizePhone('41791234567', { trustCountryCode: true }), { ok: true, phone: '+41791234567' });
  assert.equal(normalizePhone('079123', { trustCountryCode: true }).ok, false);
  assert.equal(normalizePhone('').reason, 'missing');
  assert.equal(normalizePhone('+1').reason, 'invalid');
  assert.equal(normalizePhone('abc').reason, 'invalid');
});
await t('email check', () => {
  assert.ok(validEmail('anna@example.com'));
  assert.ok(!validEmail('anna@'));
  assert.ok(!validEmail('anna example@x.com'));
  assert.ok(!validEmail(''));
  assert.ok(!validEmail('<x>@y.com'));
});
await t('off by default: nothing is prepared or booked', async () => {
  reset();
  assert.equal(bookingOn({}), false);
  assert.equal(bookingOn({ BOOKING_IN_CHAT: 'on' }), true);
  const a = await prepareBooking(base, wa(5), mk({ env: {} }));
  assert.equal(a.ok, false);
  assert.match(a.note, /switched off/);
  const b = await createBooking({ ...base, guest_confirmed: true, confirmed_total: 677 }, wa(6), mk({ env: {} }));
  assert.equal(b.ok, false);
  assert.equal(calls.length, 0);
});
await t('prepare on WhatsApp: the phone comes from the chat, the guest is not asked', async () => {
  reset();
  const r = await prepareBooking(base, wa(5), mk());
  assert.ok(r.ok, r.note);
  assert.equal(r.ready, true);
  assert.equal(r.phone_from, 'whatsapp');
  assert.equal(r.total, 677);
  assert.equal(r.currency, 'CHF');
  assert.ok(!JSON.stringify(r).includes('41791234567'), 'the number is not shown to the model');
  assert.match(r.note, /Do not call create_booking in this message/);
});
await t('prepare on Instagram: the phone is asked for, and a local number is refused', async () => {
  reset();
  const r = await prepareBooking(base, ig(5), mk());
  assert.equal(r.ready, false);
  assert.deepEqual(r.missing, ['phone_with_country_code']);
  const local = await prepareBooking({ ...base, guest_phone: '079 123 45 67' }, ig(5), mk());
  assert.equal(local.ready, false);
  assert.match(local.missing[0], /no valid country code/);
  const ok = await prepareBooking({ ...base, guest_phone: '+41 79 123 45 67' }, ig(5), mk());
  assert.equal(ok.ready, true);
  assert.equal(ok.phone_from, 'guest');
});
await t('prepare lists every missing detail, and a WhatsApp contact without a number is asked', async () => {
  reset();
  const r = await prepareBooking({ ...base, guest_last_name: '', guest_email: 'nope' }, wa(5), mk({ contactPhone: async () => '' }));
  assert.equal(r.ready, false);
  assert.deepEqual(r.missing.map((m) => m.split(' ')[0]), ['last_name', 'email', 'phone_with_country_code']);
});
await t('prepare: Merapi, too many guests, bad input', async () => {
  reset();
  assert.equal((await prepareBooking({ ...base, villa: 'merapi' }, wa(5), mk())).ok, false);
  const many = await prepareBooking({ ...base, adults: 5 }, wa(5), mk());
  assert.equal(many.ok, false);
  assert.match(many.note, /sleeps up to 4/);
  assert.equal((await prepareBooking({ ...base, adults: 0 }, wa(5), mk())).ok, false);
});
await t('prepare: dates Elev8 cannot book give a note for the guest, not a hand over', async () => {
  reset();
  const r = await prepareBooking(base, wa(5), mk({ resolveStay: async () => ({ ok: false, reason: 'dates already booked' }) }));
  assert.equal(r.ok, false);
  assert.match(r.note, /already booked/);
  assert.doesNotMatch(r.note, /needs_human true/);
});
await t('a deal code is applied; a code Elev8 does not apply is never promised', async () => {
  reset();
  const r = await prepareBooking({ ...base, promo_code: 'lea-anna' }, wa(5), mk());
  assert.equal(r.total, 640);
  assert.equal(r.discounts_total, 37);
  const unknown = await prepareBooking({ ...base, promo_code: 'LEA-OTHER' }, wa(5), mk());
  assert.equal(unknown.ok, false);
  const ignored = await prepareBooking({ ...base, promo_code: 'LEA-ANNA' }, wa(5), mk({ resolveStay: async () => ({ ok: true, listingName: 'x', quote: QUOTE }) }));
  assert.equal(ignored.ok, false);
  assert.match(ignored.note, /did not apply the code/);
  assert.match(ignored.note, /needs_human true/);
});
const confirm = { ...base, guest_confirmed: true, confirmed_total: 677 };
await t('create is refused without a summary in an earlier message', async () => {
  reset();
  // nothing prepared at all
  let r = await createBooking(confirm, wa(6), mk());
  assert.equal(r.ok, false);
  assert.match(r.note, /earlier message/);
  // prepared and created in the same message
  await prepareBooking(base, wa(6), mk());
  r = await createBooking(confirm, wa(6), mk());
  assert.equal(r.ok, false);
  assert.equal(calls.length, 0);
});
await t('create works after the guest saw the summary and answered in a later message', async () => {
  reset();
  assert.equal((await prepareBooking(base, wa(5), mk())).ready, true);
  const r = await createBooking(confirm, wa(6), mk());
  assert.ok(r.ok, r.note);
  assert.equal(r.payment_url, 'https://pay.example/abc');
  assert.equal(r.reservation, 'PZTJKJ');
  assert.equal(r.total, 677);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'create_reservation_inquiry');
  const a = calls[0].args;
  assert.equal(a.listing_name, 'Cozy 2BR the R Villa Sinabung');
  assert.equal(a.check_in_date, '2027-01-18');
  assert.equal(a.check_out_date, '2027-01-24');
  assert.equal(a.number_of_adults, 2);
  assert.equal(a.number_of_children, 0);
  assert.equal(a.first_name, 'Anna');
  assert.equal(a.last_name, 'Muller');
  assert.equal(a.email, 'anna@example.com');
  assert.equal(a.phone, '+41791234567');
  assert.equal(a.expiry_hours, 24);
  assert.match(a.idempotency_key, /^lea-[0-9a-f]{20}$/);
  assert.ok(!('promo_code' in a));
  // the guest is told: pay soon, nothing held, confirmed after payment, in CHF, the link goes last
  assert.match(r.note, /on a line of its own at the very end/);
  assert.match(r.note, /confirmed automatically once the payment is complete/);
  assert.match(r.note, /dates are not held/);
  assert.match(r.note, /677 CHF/);
  assert.match(r.note, /2026-11-11T10:00:00Z/);
});
await t('asking prepare again in the message of the yes does not block the booking', async () => {
  reset();
  await prepareBooking(base, wa(5), mk());
  await prepareBooking(base, wa(6), mk());
  assert.ok((await createBooking(confirm, wa(6), mk())).ok);
});
await t('create is refused when the guest has not confirmed or the price moved', async () => {
  reset();
  await prepareBooking(base, wa(5), mk());
  assert.equal((await createBooking({ ...confirm, guest_confirmed: false }, wa(6), mk())).ok, false);
  const moved = await createBooking({ ...confirm, confirmed_total: 600 }, wa(6), mk());
  assert.equal(moved.ok, false);
  assert.match(moved.note, /Call prepare_booking again/);
  assert.equal(calls.length, 0);
  // the price Elev8 gives now is another one than at the summary
  const dearer = await createBooking(confirm, wa(6), mk({ resolveStay: async () => ({ ok: true, listingName: 'x', quote: { ...QUOTE, total_price: 720 } }) }));
  assert.equal(dearer.ok, false);
  assert.equal(calls.length, 0);
});
await t('a summary that is hours old does not count', async () => {
  reset();
  await prepareBooking(base, wa(5), mk());
  clock += 7 * 3600 * 1000;
  assert.equal((await createBooking(confirm, wa(6), mk())).ok, false);
});
await t('the same stay is booked once: a repeat gets the same link, an expired one a new attempt', async () => {
  reset();
  await prepareBooking(base, wa(5), mk());
  const first = await createBooking(confirm, wa(6), mk());
  const again = await createBooking(confirm, wa(7), mk());
  assert.ok(again.ok);
  assert.equal(again.reused, true);
  assert.equal(again.payment_url, first.payment_url);
  assert.equal(calls.length, 1);
  assert.match(again.note, /do not say a new booking was made/);
  // after the link expired a new inquiry is made, with its own key
  clock += 25 * 3600 * 1000;
  await prepareBooking(base, wa(8), mk());
  const later = await createBooking(confirm, wa(9), mk());
  assert.ok(later.ok);
  assert.equal(calls.length, 2);
  assert.notEqual(calls[1].args.idempotency_key, calls[0].args.idempotency_key);
  assert.match(calls[1].args.idempotency_key, /-2$/);
});
await t('a deal code goes into the booking', async () => {
  reset();
  await prepareBooking({ ...base, promo_code: 'LEA-ANNA' }, wa(5), mk());
  const r = await createBooking({ ...confirm, promo_code: 'LEA-ANNA', confirmed_total: 640 }, wa(6), mk());
  assert.ok(r.ok, r.note);
  assert.equal(calls[0].args.promo_code, 'LEA-ANNA');
  assert.equal(r.total, 640);
});
await t('daily limit', async () => {
  reset();
  for (let i = 0; i < 10; i++) store.set(`book:x${i}`, { value: {}, at: clock });
  await prepareBooking(base, wa(5), mk());
  const r = await createBooking(confirm, wa(6), mk());
  assert.equal(r.ok, false);
  assert.match(r.note, /daily limit/);
  assert.equal(calls.length, 0);
});
await t('Elev8 refuses, or answers without a payment link: a note, no link, hand over', async () => {
  reset();
  await prepareBooking(base, wa(5), mk());
  const denied = await createBooking(confirm, wa(6), mk({ elev8: async () => { throw new Error('Elev8: Unauthenticated'); } }));
  assert.equal(denied.ok, false);
  assert.ok(!denied.payment_url);
  assert.match(denied.note, /needs_human true/);
  assert.match(denied.note, /Do not send a booking link of your own/);
  const nolink = await createBooking(confirm, wa(6), mk({ elev8: async () => ({ reservation_id: 'X' }) }));
  assert.equal(nolink.ok, false);
  assert.match(nolink.note, /no payment link/);
  // a failed attempt leaves no record that would hand out a link
  assert.equal([...store.keys()].filter((k) => k.startsWith('book:')).length, 0);
});
await t('details are checked again at create', async () => {
  reset();
  await prepareBooking(base, wa(5), mk());
  const r = await createBooking({ ...confirm, guest_email: 'bad' }, wa(6), mk());
  assert.equal(r.ok, false);
  assert.match(r.note, /email/);
  assert.equal(calls.length, 0);
});
await t('the test route: force skips the summary rule, the link lives one hour, the key is its own', async () => {
  reset();
  const r = await createBooking({ ...base, guest_phone: '+41791234567' }, ig(0), mk({ env: {} }), { force: true, testOnly: true });
  assert.ok(r.ok, r.note);
  assert.equal(calls[0].args.expiry_hours, 1);
  assert.match(calls[0].args.idempotency_key, /^lea-test-/);
  assert.ok([...store.keys()].some((k) => k.startsWith('book:test-')));
});
await t('names are cleaned and an attack in a field is not passed on', async () => {
  reset();
  await prepareBooking({ ...base, guest_first_name: 'Anna<script>', guest_last_name: "O'Neil-Muller" }, wa(5), mk());
  await createBooking({ ...confirm, guest_first_name: 'Anna<script>', guest_last_name: "O'Neil-Muller" }, wa(6), mk());
  assert.equal(calls[0].args.first_name, 'Annascript');
  assert.equal(calls[0].args.last_name, "O'Neil-Muller");
});
await t('tools and prompt', () => {
  assert.equal(PREPARE_TOOL.name, 'prepare_booking');
  assert.equal(BOOK_TOOL.name, 'create_booking');
  for (const k of ['guest_confirmed', 'confirmed_total', 'guest_email']) assert.ok(BOOK_TOOL.input_schema.required.includes(k), k);
  assert.ok(!PREPARE_TOOL.input_schema.required.includes('guest_email'));
  assert.match(BOOKING_NOTE('whatsapp'), /Never ask for a phone number here/);
  assert.match(BOOKING_NOTE('instagram'), /phone number with country code/);
  assert.match(BOOKING_NOTE('whatsapp'), /payment is taken in CHF/);
  assert.match(BOOKING_NOTE('whatsapp'), /only when the guest answers yes in a later message/i);
});
console.log(`${n} tests passed`);
