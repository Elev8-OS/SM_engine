import assert from 'node:assert/strict';
import { hourIn, inWindow, normalise, autoNow, mayAutoSend, settingsView, loadSettings, saveSettings } from '../src/agent/settings.js';
import { withFees } from '../src/agent/villas.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };

await t('hours in the zones', () => {
  const d = new Date('2026-11-03T21:00:00Z');
  assert.equal(hourIn('Europe/Zurich', d), 22);
  assert.equal(hourIn('Asia/Makassar', d), 5);
  assert.equal(hourIn('Europe/Zurich', new Date('2026-11-03T23:30:00Z')), 0);
});
await t('window over midnight', () => {
  for (const h of [22, 23, 0, 3, 7]) assert.equal(inWindow(h, 22, 8), true, `h=${h}`);
  for (const h of [8, 9, 12, 21]) assert.equal(inWindow(h, 22, 8), false, `h=${h}`);
});
await t('window inside one day, and an empty window', () => {
  assert.equal(inWindow(9, 9, 17), true);
  assert.equal(inWindow(17, 9, 17), false);
  assert.equal(inWindow(8, 9, 17), false);
  assert.equal(inWindow(5, 5, 5), false);
});
await t('validation', () => {
  const ok = { mode: 'window', from: 22, to: 8, tz: 'Europe/Zurich' };
  assert.deepEqual(normalise({ ...ok, from: '22', to: '8' }), ok);
  assert.throws(() => normalise({ ...ok, mode: 'always' }), /mode/);
  assert.throws(() => normalise({ ...ok, from: 24 }), /from/);
  assert.throws(() => normalise({ ...ok, to: 7.5 }), /to/);
  assert.throws(() => normalise({ ...ok, tz: 'America/New_York' }), /tz/);
  assert.throws(() => normalise({ ...ok, from: 8, to: 8 }), /different/);
  assert.doesNotThrow(() => normalise({ ...ok, mode: 'review', from: 8, to: 8 }));
});
await t('auto now follows the mode', () => {
  const night = new Date('2026-11-03T22:30:00Z'); // 23:30 Zurich, 06:30 Bali
  const noon = new Date('2026-11-03T11:00:00Z');  // 12:00 Zurich, 19:00 Bali
  const w = { mode: 'window', from: 22, to: 8, tz: 'Europe/Zurich' };
  assert.equal(autoNow(w, night), true);
  assert.equal(autoNow(w, noon), false);
  assert.equal(autoNow({ ...w, tz: 'Asia/Makassar' }, night), true);   // 06:30 Bali is inside 22 to 8
  assert.equal(autoNow({ ...w, tz: 'Asia/Makassar' }, noon), false);   // 19:00 Bali
  assert.equal(autoNow({ ...w, mode: 'auto' }, noon), true);
  assert.equal(autoNow({ ...w, mode: 'review' }, night), false);
});
await t('a reply that needs a person is never sent automatically', () => {
  const s = { mode: 'auto', from: 22, to: 8, tz: 'Europe/Zurich' };
  assert.equal(mayAutoSend(s, { reply: 'Hi', needs_human: false }), true);
  assert.equal(mayAutoSend(s, { reply: 'Hi', needs_human: true }), false);
  assert.equal(mayAutoSend(s, { reply: '  ', needs_human: false }), false);
  assert.equal(mayAutoSend(s, null), false);
});
await t('view carries the state for the screen', () => {
  const v = settingsView({ mode: 'window', from: 22, to: 8, tz: 'Europe/Zurich' }, new Date('2026-11-03T21:00:00Z'));
  assert.equal(v.autoNow, true);
  assert.equal(v.hourNow, 22);
  assert.equal(v.zones['Asia/Makassar'], 'Bali');
});
await t('storage: default from the environment, then saved choice', async () => {
  let row = null;
  const q = async (sql, params) => {
    if (/^select/i.test(sql)) return row ? [{ value: row, updated_at: new Date() }] : [];
    if (/insert into agent_settings/i.test(sql)) { row = JSON.parse(params[0]); return []; }
    return [];
  };
  assert.equal((await loadSettings(q, {})).mode, 'review');
  assert.equal((await loadSettings(q, { AGENT_AUTO_SEND: 'true' })).mode, 'auto');
  const saved = await saveSettings(q, { mode: 'window', from: 21, to: 7 }, {});
  assert.deepEqual([saved.mode, saved.from, saved.to, saved.tz], ['window', 21, 7, 'Europe/Zurich']);
  const again = await loadSettings(q, { AGENT_AUTO_SEND: 'true' });
  assert.equal(again.mode, 'window'); // a saved choice beats the environment
  assert.equal(again.stored, true);
  await assert.rejects(() => saveSettings(q, { mode: 'nonsense' }, {}), /mode/);
  row = { mode: 'broken' };
  assert.equal((await loadSettings(q, {})).stored, false); // unreadable row falls back
});

// fees
const sum = { ok: true, currency: 'CHF', nights: 4, total: 1000, average_per_night: 250 };
await t('no fee amount: nothing is added', () => {
  assert.deepEqual(withFees(sum, [{ name: 'cleaning', amount: null, currency: 'CHF', per: 'stay' }]), sum);
  assert.deepEqual(withFees(sum, undefined), sum);
});
await t('a cleaning fee per stay is added', () => {
  const r = withFees(sum, [{ name: 'cleaning', label: 'Cleaning fee', amount: 80, currency: 'CHF', per: 'stay' }]);
  assert.equal(r.total, 1000);
  assert.equal(r.total_incl_fees, 1080);
  assert.equal(r.fees_total, 80);
  assert.deepEqual(r.fees, [{ name: 'Cleaning fee', amount: 80, currency: 'CHF' }]);
  assert.equal(r.average_per_night_incl_fees, 270);
});
await t('a fee per night is multiplied', () => {
  const r = withFees(sum, [{ name: 'x', amount: 5, currency: 'CHF', per: 'night' }]);
  assert.equal(r.fees_total, 20);
});
await t('a fee in another currency is reported, not added', () => {
  const r = withFees(sum, [{ name: 'cleaning', label: 'Cleaning fee', amount: 50, currency: 'USD', per: 'stay' }]);
  assert.equal(r.total_incl_fees, undefined);
  assert.match(r.fees_note, /USD/);
});
await t('a failed price stays failed', () => {
  const bad = { ok: false, note: 'no price' };
  assert.equal(withFees(bad, [{ amount: 80, currency: 'CHF' }]), bad);
});
console.log(`\n${n} tests passed`);
