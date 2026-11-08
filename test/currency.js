import assert from 'node:assert/strict';
import { convert, niceRound, rateTable, isCode } from '../src/agent/currency.js';
import { bookingLink, CURRENCY_PARAM, TOOLS, systemPrompt } from '../src/agent/tools.js';
import { linkResult } from '../src/agent/villas.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };

const er = (base, rates) => ({ result: 'success', base_code: base, time_last_update_utc: 'Tue, 03 Nov 2026 00:02:31 +0000', rates: { [base]: 1, ...rates } });
const reply = (json, ok = true, status = 200) => ({ ok, status, json: async () => json });
// a fake fetch that answers by address and counts the calls
const fake = (routes) => {
  const calls = [];
  const f = async (url) => { calls.push(url); for (const [k, v] of Object.entries(routes)) if (url.includes(k)) return typeof v === 'function' ? v(url) : v; throw new Error('offline'); };
  f.calls = calls;
  return f;
};

await t('rounding to three significant digits', () => {
  assert.equal(niceRound(7153200), 7150000);
  assert.equal(niceRound(349.2), 349);
  assert.equal(niceRound(12.37), 12.4);
  assert.equal(niceRound(163999), 164000);
  assert.equal(niceRound(0.8421), 0.842);
  assert.equal(niceRound(0), 0);
});
await t('codes', () => {
  assert.equal(isCode('IDR'), true);
  assert.equal(isCode('idr'), false);
  assert.equal(isCode('IDRX'), false);
});
await t('CHF to IDR', async () => {
  const fetchFn = fake({ 'open.er-api.com/v6/latest/CHF': reply(er('CHF', { IDR: 20500.4, EUR: 1.07 })) });
  const r = await convert({ amount: 349, from: 'CHF', to: 'IDR' }, { fetchFn, now: () => 1 });
  assert.equal(r.ok, true);
  assert.equal(r.converted, 7150000);
  assert.equal(r.rate, 20500.4);
  assert.equal(r.rate_date, '2026-11-03');
  assert.match(r.note, /about/);
});
await t('lower case input and a second currency from the cached table', async () => {
  const fetchFn = fake({ 'open.er-api.com/v6/latest/USD': reply(er('USD', { EUR: 0.9, IDR: 15900 })) });
  const a = await convert({ amount: 100, from: 'usd', to: 'eur' }, { fetchFn, now: () => 5 });
  const b = await convert({ amount: 100, from: 'USD', to: 'IDR' }, { fetchFn, now: () => 6 });
  assert.equal(a.converted, 90);
  assert.equal(b.converted, 1590000);
  assert.equal(fetchFn.calls.length, 1, 'one request serves both');
});
await t('cache expires after six hours, and the second provider takes over', async () => {
  let calls = 0;
  const fetchFn = fake({
    'open.er-api.com': () => { calls++; throw new Error('down'); },
    'frankfurter.dev': reply({ base: 'CHF', date: '2026-11-02', rates: { IDR: 20000 } })
  });
  const r = await convert({ amount: 100, from: 'CHF', to: 'IDR' }, { fetchFn, now: () => 10_000_000_000 });
  assert.equal(r.ok, true);
  assert.match(r.source, /frankfurter/);
  assert.equal(r.converted, 2000000);
  assert.equal(r.rate_date, '2026-11-02');
  assert.equal(calls, 1);
});
await t('a stale table is used when every provider is down', async () => {
  const good = fake({ 'open.er-api.com/v6/latest/GBP': reply(er('GBP', { IDR: 20000 })) });
  await rateTable('GBP', { fetchFn: good, now: () => 0 });
  const down = fake({});
  const r = await convert({ amount: 10, from: 'GBP', to: 'IDR' }, { fetchFn: down, now: () => 7 * 3600 * 1000 });
  assert.equal(r.ok, true);
  assert.equal(r.stale, true);
});
await t('no rates at all: a note, not an exception', async () => {
  const r = await convert({ amount: 10, from: 'AUD', to: 'IDR' }, { fetchFn: fake({}), now: () => 1 });
  assert.equal(r.ok, false);
  assert.match(r.note, /team confirms/);
});
await t('unknown target currency', async () => {
  const fetchFn = fake({ 'open.er-api.com/v6/latest/NZD': reply(er('NZD', { IDR: 9000 })) });
  const r = await convert({ amount: 10, from: 'NZD', to: 'XXX' }, { fetchFn, now: () => 1 });
  assert.equal(r.ok, false);
  assert.match(r.note, /XXX/);
});
await t('bad input', async () => {
  assert.equal((await convert({ amount: -1, from: 'CHF', to: 'IDR' })).ok, false);
  assert.equal((await convert({ amount: 'abc', from: 'CHF', to: 'IDR' })).ok, false);
  assert.equal((await convert({ amount: 5, from: 'CHF', to: 'RUPIAH' })).ok, false);
  assert.equal((await convert({ amount: 5, from: 'CHF', to: 'CHF' })).converted, 5);
});

// ---- the booking link carries the currency when the guest asked for one ----
const u = (x) => new URL(x);
const ok = { checkIn: '2027-01-10', checkOut: '2027-01-17', adults: 4, children: 2 };
const base = 'https://www.elevate-villas.com/property/x';
const sam = { key: 'samalas', name: 'The R Villa Samalas', guests: 8, url: base };
const linkInput = { villa: 'samalas', check_in: '2027-01-10', check_out: '2027-01-17', adults: 4, children: 2 };

await t('the currency parameter has the agreed name', () => {
  assert.equal(CURRENCY_PARAM, 'currency');
});
await t('link carries the currency, upper case', () => {
  assert.equal(u(bookingLink(base, { ...ok, currency: 'IDR' })).searchParams.get('currency'), 'IDR');
  assert.equal(u(bookingLink(base, { ...ok, currency: 'idr' })).searchParams.get('currency'), 'IDR');
});
await t('no currency asked, no parameter', () => {
  assert.equal(u(bookingLink(base, ok)).searchParams.has('currency'), false);
  assert.equal(u(bookingLink(base, { ...ok, currency: '' })).searchParams.has('currency'), false);
});
await t('a bad currency code is refused', () => {
  assert.throws(() => bookingLink(base, { ...ok, currency: 'RUPIAH' }), /3-letter/);
  assert.equal(linkResult(sam, { ...linkInput, adults: 2, children: 0, currency: 'RUPIAH' }).ok, false);
});
await t('tool result passes the currency on and keeps the other parameters', () => {
  const r = linkResult(sam, { ...linkInput, currency: 'idr' });
  assert.equal(r.ok, true);
  assert.equal(r.currency, 'IDR');
  assert.equal(u(r.booking_link).searchParams.get('currency'), 'IDR');
  assert.equal(u(r.booking_link).searchParams.get('number_of_adult'), '4');
  assert.equal(u(r.booking_link).searchParams.get('check_in_date'), '2027-01-10');
});
await t('tool definitions and prompt', () => {
  const tool = TOOLS.find((x) => x.name === 'build_booking_link');
  assert.ok(tool.input_schema.properties.currency);
  assert.ok(!tool.input_schema.required.includes('currency'));
  assert.deepEqual(TOOLS.find((x) => x.name === 'convert_currency').input_schema.required, ['amount', 'from', 'to']);
  const prompt = systemPrompt('2026-11-03');
  assert.match(prompt, /convert_currency/);
  // Guests are quoted in IDR with about USD (the catalog), and the booking link carries the currency that was quoted.
  assert.match(prompt, /quote every price in IDR with the approximate USD amount/);
  assert.match(prompt, /Never quote CHF unless the guest asks for it/);
  assert.match(prompt, /Always pass currency \(3-letter code\): IDR/);
  // The title is said in the guest's language with the right grammatical gender.
  assert.match(prompt, /virtual Assistant of The R Villas Bali/);
  assert.match(prompt, /die virtuelle Assistentin/);
  assert.doesNotMatch(prompt, /Sales Assistant/);
  // The default currency can be changed with AGENT_DEFAULT_CURRENCY.
  process.env.AGENT_DEFAULT_CURRENCY = 'eur';
  assert.match(systemPrompt('2026-11-03'), /quote every price in EUR/);
  delete process.env.AGENT_DEFAULT_CURRENCY;
});
console.log(`\n${n} tests passed`);
