import assert from 'node:assert/strict';
import { planDeal, makeCode, promoArgs, createDealCode, dealCodesOn, DEAL_TOOL } from '../src/agent/deal-code.js';
import { budgetCheck } from '../src/agent/negotiation.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };

// the fake engine: one villa, a stay of 3 nights at CHF 500 in total, 1 CHF = 18,000 IDR
const calls = { elev8: [], saved: [] };
const mk = (over = {}) => ({
  env: { DEAL_CODES: 'on' },
  villa: async (k) => ({ key: k, name: 'The R Villa Samalas', url: 'https://www.elevate-villas.com/property/samalas' }),
  unsupported: (k) => k === 'merapi',
  maxGuests: () => 8,
  checkDates: (i) => ({ ci: i.check_in, co: i.check_out }),
  quote: async () => ({ ok: true, currency: 'CHF', total: 500, total_incl_fees: 500 }),
  convert: async ({ amount, to }) => ({ ok: true, converted: to === 'IDR' ? amount * 18000 : amount * 1.1 }),
  listingNames: async (p) => (p.key.startsWith('apt-') ? ['APT 8 - THE R APARTMENTS Mezzanine', 'APT 9 - THE R APARTMENTS Mezzanine', 'APT 10 - THE R APARTMENTS Mezzanine', 'APT 11 - THE R APARTMENTS Mezzanine'] : ['The R Villa Samalas | 4BR Retreat in Pererenan']),
  elev8: async (name, args) => { calls.elev8.push({ name, args }); return {}; },
  q: async (sql, params) => {
    if (/count\(\*\)/.test(sql)) return [{ n: over.countToday ?? 0 }];
    if (/select value/.test(sql)) return over.hit ? [{ value: over.hit }] : [];
    calls.saved.push(params);
    return [];
  },
  today: () => '2026-11-10',
  ...over
});
const input = { villa: 'samalas', check_in: '2026-12-01', check_out: '2026-12-04', adults: 2, children: 0, agreed_price: 8_300_000, basis: 'total', currency: 'IDR' };
// offered 9,000,000 IDR: agreed 8,300,000 is 7.78% under
const reset = () => { calls.elev8.length = 0; calls.saved.length = 0; };

await t('plan: the discount is worked out from the real price', () => {
  const p = planDeal({ offered: 9_000_000, agreed: 8_300_000 });
  assert.ok(p.ok);
  assert.equal(p.percent, 7.78);
  assert.ok(Math.abs(p.expected_price - 8_300_000) < 5000);
  assert.ok(p.expected_price <= 8_300_000 + 1, 'the guest never pays more than agreed because of rounding');
});
await t('plan: exactly 10% is fine, a hair above is clamped, more is refused', () => {
  assert.equal(planDeal({ offered: 10_000_000, agreed: 9_000_000 }).percent, 10);
  const c = planDeal({ offered: 10_000_000, agreed: 8_995_000 });
  assert.ok(c.ok && c.clamped && c.percent === 10 && c.expected_price === 9_000_000);
  assert.equal(planDeal({ offered: 10_000_000, agreed: 8_900_000 }).ok, false);
  assert.equal(planDeal({ offered: 10_000_000, agreed: 5_000_000 }).ok, false);
});
await t('plan: no code when the agreed price is not below the shown price, bad input refused', () => {
  assert.equal(planDeal({ offered: 100, agreed: 100 }).ok, false);
  assert.equal(planDeal({ offered: 100, agreed: 120 }).ok, false);
  assert.equal(planDeal({ offered: 0, agreed: 5 }).ok, false);
  assert.equal(planDeal({}).ok, false);
});
await t('codes: format and no look-alike characters', () => {
  for (let i = 0; i < 200; i++) assert.match(makeCode(), /^LEA-[A-HJ-NP-Z2-9]{6}$/);
  assert.notEqual(makeCode(), makeCode());
});
await t('promo arguments: one use, one villa, the one stay, valid until the next day', () => {
  const a = promoArgs({ website: 'www.elevate-villas.com', code: 'LEA-ABC234', percent: 7.78, listingNames: ['X'], checkIn: '2026-12-01', checkOut: '2026-12-04', today: '2026-11-10' });
  assert.equal(a.quota, 1);
  assert.equal(a.quota_per_user, 1);
  assert.equal(a.discount_kind, 1);
  assert.equal(a.percentage_discount, 7.78);
  assert.deepEqual(a.listings, ['X']);
  assert.equal(a.booking_from_date, '2026-11-10');
  assert.equal(a.booking_until_date, '2026-11-11');
  assert.equal(a.stay_from_date, '2026-12-01');
  // the stay window holds the whole stay, check-in to check-out
  assert.equal(a.stay_until_date, '2026-12-04');
  // every field the Elev8 tool requires is present
  for (const k of ['booking_from_date', 'booking_until_date', 'currency', 'description', 'discount_amount', 'discount_kind', 'listings', 'name', 'percentage_discount', 'promo_code', 'quota', 'quota_per_user', 'stay_from_date', 'stay_until_date', 'upsell', 'upsell_item', 'website']) assert.ok(k in a, k);
});
await t('promo arguments: the window ends at check-in at the latest; a test code is already expired', () => {
  assert.equal(promoArgs({ website: 'w', code: 'C', percent: 5, listingNames: ['X'], checkIn: '2026-11-10', checkOut: '2026-11-13', today: '2026-11-10' }).booking_until_date, '2026-11-10');
  // never longer than the next day, however far away the stay is
  assert.equal(promoArgs({ website: 'w', code: 'C', percent: 5, listingNames: ['X'], checkIn: '2027-03-01', checkOut: '2027-03-08', today: '2026-11-10' }).booking_until_date, '2026-11-11');
  const x = promoArgs({ website: 'w', code: 'C', percent: 1, listingNames: ['X'], checkIn: '2026-12-01', checkOut: '2026-12-04', today: '2026-11-10', testOnly: true });
  assert.ok(x.booking_until_date < '2026-11-10' && x.booking_from_date < x.booking_until_date);
});
await t('a stay of several nights lies inside the stay window of its code', async () => {
  reset();
  const r = await createDealCode({ ...input, check_in: '2027-01-18', check_out: '2027-01-24', agreed_price: 8_300_000 }, mk({ today: () => '2026-11-08' }));
  assert.ok(r.ok, r.note);
  const a = calls.elev8[0].args;
  assert.ok(a.stay_from_date <= '2027-01-18' && a.stay_until_date >= '2027-01-24');
  assert.equal(a.stay_from_date, '2027-01-18');
  assert.equal(a.stay_until_date, '2027-01-24');
});
await t('off by default: no code, the team is told', async () => {
  reset();
  assert.equal(dealCodesOn({}), false);
  const r = await createDealCode(input, mk({ env: {} }));
  assert.equal(r.ok, false);
  assert.match(r.note, /needs_human true/);
  assert.equal(calls.elev8.length, 0);
});
await t('creates one code and returns the link with the code in it', async () => {
  reset();
  const r = await createDealCode(input, mk());
  assert.ok(r.ok, r.note);
  assert.equal(calls.elev8.length, 1);
  assert.equal(calls.elev8[0].name, 'create_promo_code');
  assert.equal(calls.elev8[0].args.percentage_discount, 7.78);
  assert.equal(calls.elev8[0].args.promo_code, r.promo_code);
  const u = new URL(r.booking_link);
  assert.equal(u.searchParams.get('promo_code'), r.promo_code);
  assert.equal(u.searchParams.get('currency'), 'IDR');
  assert.equal(u.searchParams.get('check_in_date'), '2026-12-01');
  assert.equal(u.searchParams.get('number_of_adult'), '2');
  assert.ok(r.single_use);
  assert.equal(r.valid_until, '2026-11-11');
  // the guest is told: valid until the next day, no booking without payment, not held for others
  assert.match(r.note, /valid until 2026-11-11/);
  assert.match(r.note, /never confirmed without a completed payment/);
  assert.match(r.note, /booked by someone else/);
  assert.equal(calls.saved.length, 1);
});
await t('per night price is multiplied by the nights', async () => {
  reset();
  const r = await createDealCode({ ...input, agreed_price: 2_766_667, basis: 'per_night' }, mk());
  assert.ok(r.ok, r.note);
  assert.ok(Math.abs(r.percent_off - 7.78) < 0.02);
});
await t('the same deal does not create a second code', async () => {
  reset();
  const r = await createDealCode(input, mk({ hit: { code: 'LEA-SAME22' } }));
  assert.ok(r.ok);
  assert.equal(r.promo_code, 'LEA-SAME22');
  assert.equal(calls.elev8.length, 0);
});
await t('more than 10% under the price is refused and nothing is created', async () => {
  reset();
  const r = await createDealCode({ ...input, agreed_price: 7_000_000 }, mk());
  assert.equal(r.ok, false);
  assert.match(r.note, /team/);
  assert.equal(calls.elev8.length, 0);
});
await t('Merapi, too many guests, daily limit: refused', async () => {
  reset();
  assert.equal((await createDealCode({ ...input, villa: 'merapi' }, mk())).ok, false);
  assert.equal((await createDealCode({ ...input, adults: 9 }, mk())).ok, false);
  const limit = await createDealCode(input, mk({ countToday: 10 }));
  assert.equal(limit.ok, false);
  assert.match(limit.note, /daily limit/);
  assert.equal(calls.elev8.length, 0);
});
await t('Elev8 refuses (for example no permission): a note, no link, no throw', async () => {
  reset();
  const r = await createDealCode(input, mk({ elev8: async () => { throw new Error('Elev8: Unauthorized'); } }));
  assert.equal(r.ok, false);
  assert.ok(!r.booking_link);
  assert.match(r.note, /could not be created/);
  assert.equal(calls.saved.length, 0);
});
await t('the villa must be found in Elev8', async () => {
  reset();
  const r = await createDealCode(input, mk({ listingNames: async () => [] }));
  assert.equal(r.ok, false);
  assert.equal(calls.elev8.length, 0);
});
await t('apartment category: one code for every unit of the category', async () => {
  reset();
  const r = await createDealCode({ ...input, villa: 'apt-mezzanine', adults: 3, agreed_price: 8_300_000 }, mk());
  assert.ok(r.ok, r.note);
  assert.equal(calls.elev8.length, 1);
  assert.equal(calls.elev8[0].args.listings.length, 4);
  assert.ok(calls.elev8[0].args.listings.every((x) => /^APT \d+ - /.test(x)));
  assert.equal(calls.elev8[0].args.quota, 1);
  assert.match(r.note, /every unit of this category/);
  assert.match(r.note, /Never name a unit/);
  // a villa does not get that sentence
  const v = await createDealCode(input, mk());
  assert.doesNotMatch(v.note, /every unit/);
});
await t('dry run writes nothing and shows the arguments', async () => {
  reset();
  const r = await createDealCode(input, mk({ env: {} }), { dryRun: true, force: true });
  assert.ok(r.ok && r.dry_run);
  assert.equal(r.create_promo_code_args.quota, 1);
  assert.equal(calls.elev8.length, 0);
  assert.equal(calls.saved.length, 0);
});
await t('test code: expired, kept apart from real codes, no link', async () => {
  reset();
  const r = await createDealCode(input, mk(), { force: true, testOnly: true });
  assert.ok(r.ok && r.test_only);
  assert.ok(!r.booking_link);
  assert.ok(calls.elev8[0].args.booking_until_date < '2026-11-10');
  assert.match(String(calls.saved[0][0]), /^deal-test:/);
});
await t('the negotiation instruction follows the switch', () => {
  const off = budgetCheck({ offered: 10_000_000, budget: 9_500_000, currency: 'IDR' });
  const on = budgetCheck({ offered: 10_000_000, budget: 9_500_000, currency: 'IDR', dealCodes: true });
  assert.doesNotMatch(off.instruction, /create_deal_code/);
  assert.match(off.instruction, /needs_human true/);
  assert.match(on.instruction, /create_deal_code/);
  assert.equal(DEAL_TOOL.name, 'create_deal_code');
  assert.ok(DEAL_TOOL.input_schema.required.includes('agreed_price'));
});
console.log(`${n} tests passed`);
