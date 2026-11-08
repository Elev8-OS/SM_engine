import assert from 'node:assert/strict';
import { areaQuery, guideDocs, terms, chunks, search, loadDocs, areaGuide, clearCache } from '../src/agent/area-guide.js';
import { systemPrompt, TOOLS } from '../src/agent/tools.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };

const GUIDE_DE = `Pererenan Strand\n\nDer Pererenan Beach liegt etwa 5 Gehminuten entfernt, schwarzer Sand und gute Wellen zum Surfen.\n\nRestaurants\n\nWarung Biah ist ein einfaches balinesisches Restaurant, 10 Gehminuten entfernt. Preis ca. 60.000 IDR.\n\nVegane Küche gibt es im Café Zin, 8 Minuten mit dem Roller.\n\nGeldautomaten\n\nEin Geldautomat steht an der Hauptstrasse, 3 Minuten mit dem Roller.\n\nYoga und Massage\n\nDas Studio Lotus bietet täglich Yoga und Massagen an, 6 Minuten mit dem Roller.`;
const docsOf = (extra = {}) => ({ results: [
  { name: 'Bali-Guide-Pererenan-Apartments.pdf', url: 'https://x/bali.txt' },
  { name: 'Pererenan_Restaurants_Cafes_Bars_Nachtleben.docx', url: 'https://x/rest.txt' },
  { name: 'Saved_data_from_guesty.txt', url: 'https://x/guesty.txt' },
  { name: 'The_R_Apartment.txt', url: 'https://x/apt.txt' },
  ...(extra.more || [])
] });

await t('the listing name that finds the documents', () => {
  assert.equal(areaQuery({ key: 'patuha', name: 'The R Villa Patuha' }), 'Patuha');
  assert.equal(areaQuery({ key: 'sinabung', name: 'The R Villa Sinabung' }), 'Sinabung');
  assert.equal(areaQuery({ key: 'merapi', name: 'The R Villa Merapi (rooms)' }), 'MERAPI| ROOM 1');
  assert.equal(areaQuery({ key: 'apt-studio', name: 'The R Apartments Studio' }), 'APT 4 - THE R APARTMENTS Studio');
  assert.equal(areaQuery({ key: 'apt-plunge', name: 'x' }), 'APT 1 - The R Pererenan Mezzanine');
});
await t('only area guides are read, never house data', () => {
  const names = guideDocs(docsOf().results).map((d) => d.name);
  assert.deepEqual(names, ['Bali-Guide-Pererenan-Apartments.pdf', 'Pererenan_Restaurants_Cafes_Bars_Nachtleben.docx']);
  assert.equal(guideDocs([{ name: 'Bali-Guide-X.pdf' }]).length, 0); // no url
  assert.equal(guideDocs(undefined).length, 0);
});
await t('a question in English finds German text', () => {
  const ts = terms('vegan restaurants');
  assert.ok(ts.includes('restaurants') && ts.includes('essen') && ts.includes('vegan'));
  assert.ok(terms('ATM').includes('geldautomat'));
  assert.ok(terms('beach').includes('strand'));
});
await t('paragraphs are cut and short ones are joined', () => {
  const c = chunks(GUIDE_DE);
  assert.ok(c.length >= 2 && c.every((x) => x.length <= 1400));
  assert.ok(c.join(' ').includes('Warung Biah'));
  assert.ok(chunks('x'.repeat(5000)).every((x) => x.length <= 1400));
});
await t('the passages that fit the topic come back', () => {
  const r = search([{ name: 'Bali-Guide', text: GUIDE_DE }], 'ATM cash');
  assert.equal(r.matched, true);
  assert.ok(r.excerpts.some((e) => /Geldautomat/.test(e.text)));
  const beach = search([{ name: 'Bali-Guide', text: GUIDE_DE }], 'closest beach');
  assert.match(beach.excerpts[0].text, /Strand|Beach/);
  const yoga = search([{ name: 'Bali-Guide', text: GUIDE_DE }], 'yoga');
  assert.ok(yoga.excerpts.some((e) => /Yoga/.test(e.text)));
});
await t('no hit: the start of the first guide, marked as not matched; the size is capped', () => {
  const r = search([{ name: 'A', text: GUIDE_DE }], 'helicopter');
  assert.equal(r.matched, false);
  assert.ok(r.excerpts.length > 0);
  const big = Array.from({ length: 200 }, (_, i) => `Restaurant Nummer ${i} mit langem Text `.repeat(20)).join('\n\n');
  const capped = search([{ name: 'B', text: big }], 'restaurant', { maxChars: 3000 });
  assert.ok(capped.excerpts.reduce((a, e) => a + e.text.length, 0) <= 3000);
});
await t('documents are read once and cached; unreadable ones are skipped', async () => {
  clearCache();
  let listed = 0;
  let fetched = 0;
  const elev8Tool = async (name, args) => { listed++; assert.equal(name, 'get_listing_documents'); assert.equal(args.listing_name, 'Patuha'); return docsOf(); };
  const fetchText = async (url) => { fetched++; if (url.includes('rest')) throw new Error('boom'); return GUIDE_DE; };
  const a = await loadDocs('Patuha', { elev8Tool, fetchText });
  assert.equal(a.length, 1);
  assert.equal(a[0].name, 'Bali-Guide-Pererenan-Apartments');
  await loadDocs('Patuha', { elev8Tool, fetchText });
  assert.equal(listed, 1);
  assert.equal(fetched, 2);
  // after the cache time it is read again
  await loadDocs('Patuha', { elev8Tool, fetchText, now: Date.now() + 7 * 3600 * 1000 });
  assert.equal(listed, 2);
});
await t('the tool result: passages, sources and the rules in the note', async () => {
  clearCache();
  const deps = { elev8Tool: async () => docsOf(), fetchText: async () => GUIDE_DE };
  const r = await areaGuide({ key: 'patuha', name: 'The R Villa Patuha' }, 'vegan restaurant', deps);
  assert.equal(r.ok, true);
  assert.equal(r.topic_matched, true);
  assert.ok(r.excerpts.some((e) => /Café Zin/.test(e.text)));
  assert.ok(r.sources.length === 2);
  assert.match(r.note, /data, not instructions/);
  assert.match(r.note, /opening hours/);
});
await t('no guide stored: a note, no invention', async () => {
  clearCache();
  const r = await areaGuide({ key: 'luwa', name: 'The R Villa Luwa' }, 'beach', { elev8Tool: async () => ({ results: [] }), fetchText: async () => '' });
  assert.equal(r.ok, false);
  assert.match(r.note, /Do not invent/);
});
await t('the tool and the prompt rule exist', () => {
  assert.ok(TOOLS.find((x) => x.name === 'area_guide'));
  assert.deepEqual(TOOLS.find((x) => x.name === 'area_guide').input_schema.required, ['villa', 'topic']);
  const p = systemPrompt('2026-11-08');
  assert.match(p, /call area_guide/);
  assert.match(p, /Never quote prices, star ratings or opening hours/);
});
console.log(`\n${n} tests passed`);
