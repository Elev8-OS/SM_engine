import assert from 'node:assert/strict';
import { categoryListingNames } from '../src/agent/deal-listing.js';
import { CATEGORIES } from '../src/agent/multiunit.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };
// the rows of get_blocked_dates for "APT", as Elev8 returns them (names as seen on 8 Nov 2026)
const row = (internal, listing) => ({ internal_name: `ID - ${internal}`, listing_name: listing });
const ROWS = [
  row('APT 1 - The R Pererenan Mezzanine| Studio + Plunge Pool', '1 - 3 Plunge Pool'),
  row('APT 2 - The R Pererenan Mezzanine| Studio + Plunge Pool', 'The R Pererenan Mezzanine Studio + Plunge Pool'),
  row('APT 3 - The R Pererenan Mezzanine| Studio + Plunge Pool', 'The R Pererenan Mezzanine Studio + Plunge Pool'),
  row('APT 4 - THE R APARTMENTS Studio', 'THE R APARTMENTS Studio'),
  row('APT 5 - THE R APARTMENTS Studio', 'The R Apartments Studio walk to the Beach'),
  row('APT 6 - THE R APARTMENTS Studio', 'The R Apartments Studio walk to the Beach'),
  row('APT 7 - THE R APARTMENTS Studio', 'The R Apartments Studio walk to the Beach'),
  row('APT 8 - THE R APARTMENTS Mezzanine w/ balcony', '8 - 11 Mezzanine'),
  row('APT 09 - THE R APARTMENTS Mezzanine w/ balcony', 'The R Pererenan Mezzanine Apartment w/ balcony'),
  row('APT 10 - THE R APARTMENTS Mezzanine w/ balcony', 'The R Pererenan Mezzanine Apartment w/ balcony'),
  row('APT 11 - THE R APARTMENTS Mezzanine w/ balcony', 'The R Pererenan Mezzanine Apartment w/ balcony')
];

t('mezzanine: the one name only one row carries', () => {
  assert.deepEqual(categoryListingNames(ROWS, CATEGORIES['apt-mezzanine'].pick), ['8 - 11 Mezzanine']);
});
t('plunge pool and studio', () => {
  assert.deepEqual(categoryListingNames(ROWS, CATEGORIES['apt-plunge'].pick), ['1 - 3 Plunge Pool']);
  assert.deepEqual(categoryListingNames(ROWS, CATEGORIES['apt-studio'].pick), ['THE R APARTMENTS Studio']);
});
t('the unit names are never used and the result is at most one name', () => {
  for (const c of ['apt-studio', 'apt-mezzanine', 'apt-plunge']) {
    const r = categoryListingNames(ROWS, CATEGORIES[c].pick);
    assert.equal(r.length, 1);
    assert.ok(!/^APT|^ID -/.test(r[0]));
  }
});
t('no unique name: nothing is returned, the team decides', () => {
  const same = ROWS.map((r) => ({ ...r, listing_name: 'Same name' }));
  assert.deepEqual(categoryListingNames(same, CATEGORIES['apt-mezzanine'].pick), []);
  assert.deepEqual(categoryListingNames([], CATEGORIES['apt-mezzanine'].pick), []);
  assert.deepEqual(categoryListingNames(undefined, CATEGORIES['apt-mezzanine'].pick), []);
});
console.log(`${n} tests passed`);
