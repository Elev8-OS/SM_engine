import assert from 'node:assert/strict';
import { keyOf, freeWindows, candidateWindows, pickWindow, checkAvailability, availabilityPromptBlock, shortDate } from '../src/availability.js';
import { checkCopy } from '../src/posts.js';
import { accountsFor } from '../src/ghl.js';
import { PILLARS, AVAILABILITY_SCHEMA } from '../src/strategy.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };
const L = (name, ranges = [], unknown = []) => ({ internal_name: name, blocked_ranges: ranges.map(([start, end]) => ({ start, end })), unknown_dates: unknown });

t('villa key comes from the Elev8 internal name, rooms and apartments are skipped', () => {
  assert.equal(keyOf('ID - LUWA| 5BR Pool the R Villa Luwa'), 'luwa');
  assert.equal(keyOf('ID -  SAMALAS| The R Villa Samalas'), 'samalas');
  assert.equal(keyOf('ID - APT 4 - THE R APARTMENTS Studio'), null);
  assert.equal(keyOf(''), null);
});
t('free windows are the complement of the blocked ranges', () => {
  const w = freeWindows(L('x', [['2026-11-26', '2026-11-28']]), '2026-11-24', '2026-12-15');
  assert.deepEqual(w.map((x) => [x.checkIn, x.checkOut, x.nights]), [['2026-11-24', '2026-11-26', 2], ['2026-11-29', '2026-12-16', 17]]);
  assert.equal(w[0].openStart, true);
  assert.equal(w[1].openEnd, true);
});
t('a fully free listing is one window, a fully blocked one has none', () => {
  assert.equal(freeWindows(L('x'), '2026-11-24', '2026-12-15')[0].nights, 22);
  assert.deepEqual(freeWindows(L('x', [['2026-11-24', '2026-12-15']]), '2026-11-24', '2026-12-15'), []);
});
t('unknown dates are never free', () => {
  const w = freeWindows(L('x', [], ['2026-11-30']), '2026-11-24', '2026-12-05');
  assert.deepEqual(w.map((x) => [x.checkIn, x.checkOut]), [['2026-11-24', '2026-11-30'], ['2026-12-01', '2026-12-06']]);
});
t('candidates need 3 nights and a check-in 2 to 21 days ahead; real gaps come first', () => {
  const results = [
    L('ID - TAMBORA| x'), // fully free
    L('ID - LUWA| x', [['2026-11-24', '2026-11-30'], ['2026-12-06', '2026-12-20']]), // gap 1 to 5 Dec: 5 nights
    L('ID - BRATAN| x', [['2026-11-24', '2026-11-24'], ['2026-11-26', '2026-12-30']]), // only 1 free night
    L('ID - APT 4 - x') // not a villa
  ];
  const c = candidateWindows(results, { today: '2026-11-24' });
  assert.equal(c[0].key, 'luwa');
  assert.equal(c[0].checkIn, '2026-12-01');
  assert.equal(c[0].nights, 5);
  assert.equal(c[0].gap, true);
  assert.ok(c.some((x) => x.key === 'tambora'));
  assert.ok(!c.some((x) => x.key === 'bratan'));
});
t('a check-in tomorrow is too late, in 22 days too early', () => {
  assert.deepEqual(candidateWindows([L('ID - TAMBORA| x', [['2026-11-24', '2026-11-24']])], { today: '2026-11-24' }).map((x) => x.lead), [2]);
  assert.equal(candidateWindows([L('ID - TAMBORA| x', [['2026-11-24', '2026-12-14']])], { today: '2026-11-24' }).length, 1);
  assert.equal(candidateWindows([L('ID - TAMBORA| x', [['2026-11-24', '2026-12-15']])], { today: '2026-11-24' }).length, 0);
});
t('pickWindow skips villas without photos and villas used lately', () => {
  const w = [{ key: 'luwa' }, { key: 'tambora' }, { key: 'bratan' }];
  assert.equal(pickWindow(w, { allowed: new Set(['tambora', 'bratan']) }).key, 'tambora');
  assert.equal(pickWindow(w, { allowed: new Set(['luwa', 'tambora']), recentKeys: ['luwa'] }).key, 'tambora');
  assert.equal(pickWindow(w, { allowed: new Set(['luwa']), recentKeys: ['luwa'] }), null);
});
const plan = { availability: { key: 'luwa', checkIn: '2026-12-01', checkOut: '2026-12-06', nights: 5 }, platforms: ['facebook'], properties: [{ key: 'luwa', guests: 10 }] };
t('the prompt names only the free dates', () => {
  const p = availabilityPromptBlock(plan.availability).join('\n');
  assert.match(p, /Free from 1 Dec \(check-in\) to 6 Dec \(check-out\), 5 nights/);
  assert.match(p, /No other date, no price, no discount/);
  assert.deepEqual(availabilityPromptBlock(null), []);
  assert.equal(shortDate('2026-12-06'), '6 Dec');
});
t('check: dates inside the window pass', () => {
  assert.deepEqual(checkAvailability({ captions: { facebook: 'Free from 1 Dec to 6 Dec. Dec 3 is a Thursday.' }, lines: [{ headline: 'Your slow week, 1 to 6 Dec' }] }, plan), []);
});
t('check: dates outside the window, prices and pressure wording warn', () => {
  const w = checkAvailability({ captions: { facebook: 'Free 28 Nov to 6 Dec for IDR 2,500,000. 20% off, hurry!' } }, plan);
  assert.ok(w.some((x) => /28 nov/i.test(x)));
  assert.ok(w.some((x) => /price/.test(x)));
  assert.ok(w.some((x) => /pressure/.test(x)));
});
t('check: a copy without availability plan is not touched', () => {
  assert.deepEqual(checkAvailability({ captions: { facebook: 'Anything 28 Nov 20% off' } }, { properties: [] }), []);
});
t('an availability post needs a Facebook caption, not Instagram hashtags', () => {
  const ok = checkCopy({ captions: { facebook: 'Free 1 Dec to 6 Dec.' }, lines: [{ headline: 'x' }] }, plan);
  assert.ok(!ok.some((x) => /hashtag|Instagram/i.test(x)), ok.join('; '));
  const missing = checkCopy({ captions: {}, lines: [] }, plan);
  assert.ok(missing.includes('Missing Facebook caption'));
  const normal = checkCopy({ captions: {}, hashtags: [] }, { properties: [{ key: 'luwa' }] });
  assert.ok(normal.includes('Missing Instagram caption') && normal.includes('Too few hashtags'));
});
t('drafts go only to the platforms the plan names', () => {
  const acc = { instagram: 'a', facebook: 'b', tiktok: 'c' };
  assert.deepEqual(accountsFor({ plan: { platforms: ['facebook'] } }, acc), { facebook: 'b' });
  assert.deepEqual(accountsFor({ plan: {} }, acc), acc);
  assert.deepEqual(accountsFor({}, acc), acc);
});
t('the pillar has a brief and the schema asks for Facebook only', () => {
  assert.ok(PILLARS.availability);
  assert.match(AVAILABILITY_SCHEMA.captions, /facebook/);
  assert.ok(!/instagram/i.test(AVAILABILITY_SCHEMA.captions));
});

console.log(`\n${n} tests passed`);
