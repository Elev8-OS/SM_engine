import assert from 'node:assert/strict';
import { priceIds } from '../src/agent/clients.js';
import { priceSummary, systemPrompt } from '../src/agent/tools.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };

await t('Bratan and Tambora have a PriceLabs listing without the variable', () => {
  delete process.env.PRICELABS_LISTINGS;
  const ids = priceIds();
  assert.match(ids.bratan, /___/);
  assert.match(ids.tambora, /___/);
});
await t('the variable wins over the fallback and keeps the other villas', () => {
  process.env.PRICELABS_LISTINGS = JSON.stringify({ bratan: 'x___y', patuha: 'p___q' });
  const ids = priceIds();
  assert.equal(ids.bratan, 'x___y');
  assert.equal(ids.patuha, 'p___q');
  assert.match(ids.tambora, /___/);
});
await t('a broken variable does not take the fallback away', () => {
  process.env.PRICELABS_LISTINGS = '{nope';
  assert.match(priceIds().bratan, /___/);
});
await t('no price: the booking page, not the team', () => {
  const r = priceSummary([], '2026-12-01', '2026-12-03', 'CHF');
  assert.equal(r.ok, false);
  assert.match(r.note, /booking page/);
  assert.doesNotMatch(r.note, /team/i);
  assert.match(systemPrompt('2026-11-08'), /do not say that you will ask the team about the price/);
});
console.log(`\n${n} tests passed`);
