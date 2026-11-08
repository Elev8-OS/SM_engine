import assert from 'node:assert/strict';
import { budgetCheck } from '../src/agent/negotiation.js';
import { TOOLS, systemPrompt } from '../src/agent/tools.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };
const tier = (o, b, c = 'IDR') => budgetCheck({ offered: o, budget: b, currency: c }).tier;

await t('budget at or above the offer: nothing to lower', () => {
  assert.equal(tier(10_000_000, 10_000_000), 'no_discount_needed');
  assert.equal(tier(10_000_000, 12_000_000), 'no_discount_needed');
});
await t('up to 10% under: negotiate, boundary included', () => {
  assert.equal(tier(10_000_000, 9_500_000), 'negotiate');
  assert.equal(tier(10_000_000, 9_000_000), 'negotiate');
  assert.equal(tier(1000, 900, 'USD'), 'negotiate');
  assert.equal(tier(10_000_000, 8_999_000), 'team');
});
await t('between 10% and 30% under: the team', () => {
  assert.equal(tier(10_000_000, 8_500_000), 'team');
  assert.equal(tier(10_000_000, 7_100_000), 'team');
  assert.equal(budgetCheck({ offered: 10_000_000, budget: 8_000_000, currency: 'IDR' }).needs_human, true);
});
await t('30% or more under: polite no, the team is not informed, boundary included', () => {
  assert.equal(tier(10_000_000, 7_000_000), 'decline');
  assert.equal(tier(10_000_000, 3_000_000), 'decline');
  assert.equal(budgetCheck({ offered: 10_000_000, budget: 5_000_000 }).needs_human, false);
  assert.equal(tier(1000, 700, 'USD'), 'decline');
});
await t('floor is never more than 10% under the offer and never below the budget', () => {
  const r = budgetCheck({ offered: 10_000_000, budget: 9_200_000, currency: 'IDR' });
  assert.equal(r.lowest_price, 9_000_000);
  assert.ok(r.suggested_first_counter > r.lowest_price && r.suggested_first_counter < 10_000_000);
  const edge = budgetCheck({ offered: 9_999_000, budget: 8_999_100, currency: 'IDR' });
  assert.ok(edge.lowest_price <= 8_999_100);
  assert.ok(edge.lowest_price >= 9_999_000 * 0.9 - 10000);
});
await t('rounding by currency', () => {
  const idr = budgetCheck({ offered: 9_876_543, budget: 9_000_000, currency: 'IDR' });
  assert.equal(idr.lowest_price % 10000, 0);
  const usd = budgetCheck({ offered: 1234, budget: 1150, currency: 'usd' });
  assert.equal(usd.lowest_price % 5, 0);
  assert.equal(usd.currency, 'USD');
});
await t('percent under the offer is reported', () => {
  assert.equal(budgetCheck({ offered: 10_000_000, budget: 8_000_000 }).percent_under_offer, 20);
  assert.equal(budgetCheck({ offered: 10_000_000, budget: 11_000_000 }).percent_under_offer, 0);
});
await t('bad input is refused', () => {
  assert.throws(() => budgetCheck({ offered: 0, budget: 5 }));
  assert.throws(() => budgetCheck({ offered: 100, budget: -1 }));
  assert.throws(() => budgetCheck({ offered: 'x', budget: 5 }));
  assert.throws(() => budgetCheck({}));
});
await t('the tool exists and the prompt carries the rule', () => {
  const tool = TOOLS.find((x) => x.name === 'check_budget');
  assert.ok(tool);
  assert.deepEqual(tool.input_schema.required.sort(), ['budget', 'currency', 'offered']);
  const p = systemPrompt('2026-11-08');
  assert.match(p, /ask for their budget first/i);
  assert.match(p, /check_budget/);
  // price negotiation is no longer a plain hand-over
  assert.doesNotMatch(p, /discount or price negotiation/);
  assert.match(p, /Never offer a discount yourself/i);
});
console.log(`${n} tests passed`);
