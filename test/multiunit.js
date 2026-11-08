import assert from 'node:assert/strict';
import { CATEGORIES, categoryOf, categoryRows, categoryRow, enrich, pickAvailability, categoryAvailability, categoryPrices } from '../src/agent/multiunit.js';
import { villaView, linkResult } from '../src/agent/villas.js';
import { systemPrompt } from '../src/agent/tools.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };

// a unit as get_blocked_dates returns it: blocked ranges with an exclusive end
const unit = (name, blocked = [], unknown = []) => ({ internal_name: name, listing_name: name, blocked_ranges: blocked.map(([start, end_exclusive]) => ({ start, end_exclusive })), unknown_dates: unknown });
const IN = '2026-12-22';
const OUT = '2026-12-25';

await t('categories and keys', () => {
  assert.ok(categoryOf('apt-studio'));
  assert.ok(categoryOf('APT-PLUNGE'));
  assert.ok(categoryOf('merapi'));
  assert.equal(categoryOf('patuha'), null);
  assert.equal(categoryOf('apartments'), null);
  assert.deepEqual(categoryRows().map((r) => r.key), ['apt-studio', 'apt-mezzanine', 'apt-plunge']);
  assert.ok(categoryRows().every((r) => r.promoKey === 'apartments' && r.url.startsWith('https://www.elevate-villas.com/property/')));
  assert.equal(categoryRow('apt-plunge').name, 'The R Apartments Mezzanine with Plunge Pool');
  assert.equal(categoryRow('merapi'), null);
});
await t('units belong to one category by their name', () => {
  const studio = CATEGORIES['apt-studio'].pick;
  const mezz = CATEGORIES['apt-mezzanine'].pick;
  const plunge = CATEGORIES['apt-plunge'].pick;
  assert.equal(studio(unit('APT 05')), true);
  assert.equal(studio(unit('APT 8')), false);
  assert.equal(mezz(unit('APT 08')), true);
  assert.equal(mezz(unit('APT 11')), true);
  assert.equal(plunge(unit('APT 2')), true);
  assert.equal(plunge(unit('APT 4')), false);
  assert.equal(CATEGORIES.merapi.pick(unit('Merapi Room 3')), true);
});
await t('free when at least one unit is free', () => {
  const units = [unit('APT 04', [['2026-12-23', '2026-12-24']]), unit('APT 05')];
  assert.equal(pickAvailability(units, IN, OUT).available, true);
});
await t('not free when every unit has a blocked night', () => {
  const units = [unit('APT 04', [['2026-12-23', '2026-12-24']]), unit('APT 05', [['2026-12-20', '2026-12-30']])];
  const r = pickAvailability(units, IN, OUT);
  assert.equal(r.available, false);
  assert.equal(r.of_nights, 3);
});
await t('unknown dates and no units are not guessed', () => {
  assert.equal(pickAvailability([unit('APT 04', [], ['2026-12-23'])], IN, OUT).available, null);
  assert.equal(pickAvailability([], IN, OUT).available, null);
  // one unit free beats an unknown one
  assert.equal(pickAvailability([unit('APT 04', [], ['2026-12-23']), unit('APT 05')], IN, OUT).available, true);
});
await t('the calendar of the right category is used', async () => {
  const asked = [];
  const elev8Tool = async (name, args) => {
    asked.push({ name, args });
    return { results: [unit('APT 04', [['2026-12-20', '2026-12-30']]), unit('APT 05', [['2026-12-20', '2026-12-30']]), unit('APT 08'), unit('Merapi Room 1', [['2026-12-20', '2026-12-30']])] };
  };
  assert.equal((await categoryAvailability(CATEGORIES['apt-studio'], IN, OUT, { elev8Tool })).available, false);
  assert.equal((await categoryAvailability(CATEGORIES['apt-mezzanine'], IN, OUT, { elev8Tool })).available, true);
  assert.equal((await categoryAvailability(CATEGORIES.merapi, IN, OUT, { elev8Tool })).available, false);
  assert.equal(asked[0].name, 'get_blocked_dates');
  assert.equal(asked[0].args.listing_name, 'APT');
  assert.equal(asked[2].args.listing_name, 'merapi');
});

const rowsOf = (price) => [{ date: '2026-12-22', price }, { date: '2026-12-23', price }, { date: '2026-12-24', price }];
await t('price: one list for an apartment category', async () => {
  const seen = [];
  const rowsFn = async (id) => { seen.push(id); return { currency: 'CHF', rows: rowsOf(100) }; };
  const r = await categoryPrices(CATEGORIES['apt-studio'], IN, OUT, { rowsFn, ids: () => ({ 'apt-studio': 'LIST_STUDIO' }) });
  assert.equal(r.ok, true);
  assert.equal(r.total, 300);
  assert.equal(r.currency, 'CHF');
  assert.deepEqual(seen, ['LIST_STUDIO']);
});
await t('price: the lowest room of Merapi', async () => {
  const prices = [140, 90];
  let i = 0;
  const rowsFn = async () => ({ currency: 'CHF', rows: rowsOf(prices[i++]) });
  const r = await categoryPrices(CATEGORIES.merapi, IN, OUT, { rowsFn });
  assert.equal(r.total, 270);
  assert.equal(r.price_of, 'lowest room');
});
await t('price: a list without prices, or no list, sends the guest to the booking page', async () => {
  const none = await categoryPrices(CATEGORIES['apt-studio'], IN, OUT, { rowsFn: async () => ({ currency: 'CHF', rows: [] }), ids: () => ({ 'apt-studio': 'X' }) });
  assert.equal(none.ok, false);
  assert.match(none.note, /booking page/);
  const missing = await categoryPrices(CATEGORIES['apt-studio'], IN, OUT, { ids: () => ({}) });
  assert.equal(missing.ok, false);
  assert.match(missing.note, /booking page/);
  assert.doesNotMatch(missing.note, /team/i);
});
await t('what the assistant sees of a category and of Merapi', () => {
  const studio = categoryRow('apt-studio');
  const v = villaView(studio, false, []);
  assert.equal(v.key, 'apt-studio');
  assert.equal(v.guests, 2);
  assert.match(v.note, /at least one studio is free/);
  const m = enrich({ key: 'merapi', name: 'The R Villa Merapi (rooms)', guests: 5, url: 'https://old.example/x' });
  assert.equal(m.guests, 2);
  assert.match(m.url, /the-r-villa-merapi-0e45abbd$/);
  assert.equal(enrich({ key: 'patuha', name: 'x', guests: 8 }).guests, 8);
});
await t('booking link of a category: its page, its guest limit, the promotions of the apartments', () => {
  const studio = categoryRow('apt-studio');
  const ok = linkResult(studio, { villa: 'apt-studio', check_in: IN, check_out: OUT, adults: 2, children: 0, currency: 'IDR' }, { multiUnit: true });
  assert.equal(ok.ok, true);
  assert.match(ok.booking_link, /the-r-apartments-studio-dc20bb99\?check_in_date=2026-12-22/);
  assert.match(ok.note, /which unit is free/);
  const tooMany = linkResult(studio, { villa: 'apt-studio', check_in: IN, check_out: OUT, adults: 3, children: 0 }, { multiUnit: true });
  assert.equal(tooMany.ok, false);
  const promo = { code: 'EARLYCHECKIN', property_key: 'apartments', terms: 'x', stay_from: null, stay_to: null, min_nights: null };
  const withCode = linkResult(studio, { villa: 'apt-studio', check_in: IN, check_out: OUT, adults: 2, children: 0, promo_code: 'earlycheckin' }, { multiUnit: true, promos: [promo] });
  assert.equal(withCode.ok, true);
  assert.equal(withCode.promo_code, 'EARLYCHECKIN');
  const merapi = enrich({ key: 'merapi', name: 'The R Villa Merapi (rooms)', guests: 2, url: 'x' });
  assert.equal(linkResult(merapi, { villa: 'merapi', check_in: IN, check_out: OUT, adults: 3, children: 0 }, { multiUnit: true }).ok, false);
});
await t('the prompt explains the categories', () => {
  const p = systemPrompt('2026-11-08');
  assert.match(p, /apt-studio, apt-mezzanine, apt-plunge/);
  assert.match(p, /Never name a unit/);
});
console.log(`\n${n} tests passed`);
