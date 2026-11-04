import assert from 'node:assert/strict';
import { detectVillas, pillarByRules, pillarByModel } from '../src/classify.js';
import { moodFor, looksLikeMp3, cleanTrack, problem, eligible, choose } from '../src/music-rules.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };
const props = [
  { key: 'samalas', name: 'The R Villa Samalas' },
  { key: 'patuha', name: 'The R Villa Patuha' },
  { key: 'luwa', name: 'The R Villa Luwa' },
  { key: 'merapi', name: 'The R Villa Merapi' },
  { key: 'apartments', name: 'The R Apartments' }
];

await t('villa by name, hashtag and alias', () => {
  assert.deepEqual(detectVillas('Slow mornings at Villa Samalas in Pererenan', props), ['samalas']);
  assert.deepEqual(detectVillas('Pool day #thervillapatuha #bali', props), ['patuha']);
  assert.deepEqual(detectVillas('Samalas or Patuha? Both sleep 8+', props), ['samalas', 'patuha']);
  assert.deepEqual(detectVillas('Our studios at The R Apartments', props), ['apartments']);
  assert.deepEqual(detectVillas('Fresh Luwak coffee at the warung', props), [], 'a four letter name needs a whole word');
  assert.deepEqual(detectVillas('Luwa pool at sunset', props), ['luwa']);
  assert.deepEqual(detectVillas('', props), []);
  assert.deepEqual(detectVillas(null, props), []);
});
await t('category by rules', () => {
  assert.equal(pillarByRules('Book direct and get the best rate', ['samalas']), 'book_direct');
  assert.equal(pillarByRules('Workation with a desk and fast WiFi', ['patuha']), 'workation');
  assert.equal(pillarByRules('Samalas or Patuha?', ['samalas', 'patuha']), 'which_villa_for');
  assert.equal(pillarByRules('Perfect for couples who like slow mornings', ['samalas']), 'which_villa_for');
  assert.equal(pillarByRules('Three minutes to the best cafe in Pererenan', ['samalas']), 'neighbourhood');
  assert.equal(pillarByRules('The light in the bathroom, a quiet detail', []), 'design_details');
  assert.equal(pillarByRules('Slow mornings by the pool', ['samalas']), 'villa_spotlight');
  assert.equal(pillarByRules('Happy Nyepi from our team', []), 'other');
  assert.equal(pillarByRules('', ['samalas']), 'other');
});
await t('category by model: forced tool answer, and silence on any problem', async () => {
  process.env.ANTHROPIC_API_KEY = 'test';
  const ok = async () => ({ ok: true, json: async () => ({ content: [{ type: 'tool_use', input: { pillar: 'neighbourhood' } }] }) });
  assert.equal(await pillarByModel('Cafe round the corner', [], { fetchFn: ok }), 'neighbourhood');
  const wrong = async () => ({ ok: true, json: async () => ({ content: [{ type: 'tool_use', input: { pillar: 'nonsense' } }] }) });
  assert.equal(await pillarByModel('x', [], { fetchFn: wrong }), null);
  const fail = async () => ({ ok: false, json: async () => ({}) });
  assert.equal(await pillarByModel('x', [], { fetchFn: fail }), null);
  const boom = async () => { throw new Error('offline'); };
  assert.equal(await pillarByModel('x', [], { fetchFn: boom }), null);
  assert.equal(await pillarByModel('   ', [], { fetchFn: ok }), null);
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(await pillarByModel('x', [], { fetchFn: ok }), null, 'no key, no call');
});
await t('mood follows the category', () => {
  assert.equal(moodFor('neighbourhood'), 'upbeat');
  assert.equal(moodFor('which_villa_for'), 'upbeat');
  assert.equal(moodFor('villa_spotlight'), 'calm');
  assert.equal(moodFor('design_details'), 'calm');
  assert.equal(moodFor(undefined), 'calm');
});
await t('an mp3 is recognised by its start', () => {
  const body = Buffer.alloc(8000);
  assert.equal(looksLikeMp3(Buffer.concat([Buffer.from('ID3'), body])), true);
  assert.equal(looksLikeMp3(Buffer.concat([Buffer.from([0xff, 0xfb]), body])), true);
  assert.equal(looksLikeMp3(Buffer.concat([Buffer.from('RIFF'), body])), false);
  assert.equal(looksLikeMp3(Buffer.from('ID3')), false, 'too short');
  assert.equal(looksLikeMp3(null), false);
});
await t('track fields are cleaned and the license needs proof', () => {
  assert.throws(() => cleanTrack({}, { create: true }), /title/);
  assert.throws(() => cleanTrack({ mood: 'loud' }), /mood/);
  const c = cleanTrack({ title: ' Slow Bali ', mood: 'calm', license_ok: 'true', active: 0, extra: 1 }, { create: true });
  assert.deepEqual(c, { title: 'Slow Bali', mood: 'calm', license_ok: true, active: false });
  assert.match(problem({ license_ok: true, provider: '', license_ref: 'x' }), /provider/);
  assert.match(problem({ license_ok: true, provider: 'Epidemic Sound', license_ref: ' ' }), /reference/);
  assert.equal(problem({ license_ok: true, provider: 'Epidemic Sound', license_ref: 'INV-1' }), null);
  assert.equal(problem({ license_ok: false, provider: '', license_ref: '' }), null);
});
await t('only licensed and active tracks are chosen, by mood, least used first', () => {
  const tr = (id, o = {}) => ({ id, mood: 'calm', license_ok: true, active: true, used_count: 0, ...o });
  assert.equal(eligible(tr(1, { license_ok: false })), false);
  assert.equal(eligible(tr(1, { active: false })), false);
  assert.equal(choose([], 'calm'), null);
  assert.equal(choose([tr(1, { license_ok: false }), tr(2, { active: false })], 'calm'), null, 'nothing licensed: silent');
  assert.equal(choose([tr(1), tr(2, { mood: 'upbeat' })], 'upbeat').id, 2);
  assert.equal(choose([tr(1), tr(2, { mood: 'any' })], 'upbeat').id, 2, 'an "any" track fits every mood');
  assert.equal(choose([tr(1)], 'upbeat').id, 1, 'no track of that mood: another licensed one beats silence');
  assert.equal(choose([tr(1, { used_count: 3 }), tr(2, { used_count: 1 }), tr(3, { used_count: 1 })], 'calm', () => 0.99).id, 3);
  assert.equal(choose([tr(1, { used_count: 3 }), tr(2, { used_count: 1 }), tr(3, { used_count: 1 })], 'calm', () => 0).id, 2);
});
console.log(`\n${n} tests passed`);
