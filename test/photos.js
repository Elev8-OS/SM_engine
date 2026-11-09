import assert from 'node:assert/strict';
import { WA_PROMPT_NOTE, PHOTO_NOTE } from '../src/agent/whatsapp.js';
import { matchProducts } from '../src/wacatalog-send.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };

const rows = [
  { retailer_id: 'villa-sinabung', link: 'https://www.elevate-villas.com/property/cozy-2br-sinabung-1234' },
  { retailer_id: 'villa-samalas', link: 'https://www.elevate-villas.com/property/samalas-5678' },
  { retailer_id: 'apartment-mezzanine', link: 'https://www.elevate-villas.com/property/the-r-pererenan-mezzanine-apartment-w-balcony-90672e94' }
];

await t('the WhatsApp prompt tells Lea to answer a photo request with the villa link, so the card follows', () => {
  assert.ok(WA_PROMPT_NOTE.includes(PHOTO_NOTE));
  assert.match(PHOTO_NOTE, /never say that you cannot send photos/);
  assert.match(PHOTO_NOTE, /catalog card of the villa with its photo and price follows your message automatically/);
  assert.match(PHOTO_NOTE, /up to three links/);
  assert.match(PHOTO_NOTE, /ask which one/);
  assert.match(PHOTO_NOTE, /never promise a photo of a specific room/i);
});
await t('a reply with the plain page link or the booking link of a villa gets that villa card', () => {
  const plain = 'Here are the photos.\nhttps://www.elevate-villas.com/property/cozy-2br-sinabung-1234';
  assert.deepEqual(matchProducts(plain, rows), ['villa-sinabung']);
  const withStay = 'Photos and price:\nhttps://www.elevate-villas.com/property/samalas-5678?check_in_date=2027-01-18&check_out_date=2027-01-24&number_of_adult=2&number_of_children=0&utm_source=whatsapp';
  assert.deepEqual(matchProducts(withStay, rows), ['villa-samalas']);
});
await t('several links give several cards, no link gives none', () => {
  const two = 'Both:\nhttps://www.elevate-villas.com/property/cozy-2br-sinabung-1234\nhttps://www.elevate-villas.com/property/samalas-5678';
  assert.deepEqual(matchProducts(two, rows), ['villa-sinabung', 'villa-samalas']);
  assert.deepEqual(matchProducts('I will send photos soon.', rows), []);
  assert.deepEqual(matchProducts('https://example.com/other', rows), []);
});
await t('an apartment category gets its card too', () => {
  const text = 'Photos:\nhttps://www.elevate-villas.com/property/the-r-pererenan-mezzanine-apartment-w-balcony-90672e94';
  assert.deepEqual(matchProducts(text, rows), ['apartment-mezzanine']);
});
console.log(`${n} tests passed`);
