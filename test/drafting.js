import assert from 'node:assert/strict';
import { baliDay, autoDate, cleanSettings, feedbackItems, feedbackPromptBlock } from '../src/drafting.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };

t('today in Bali: the date is already the next one in the late evening in Zurich', () => {
  assert.equal(baliDay(Date.parse('2026-11-04T10:00:00Z')).toISOString(), '2026-11-04T00:00:00.000Z');
  assert.equal(baliDay(Date.parse('2026-11-04T16:30:00Z')).toISOString(), '2026-11-05T00:00:00.000Z');
});
t('automatic date: today in Bali plus the lead days, 7 by default', () => {
  assert.equal(autoDate(undefined, Date.parse('2026-11-04T10:00:00Z')).toISOString().slice(0, 10), '2026-11-11');
  assert.equal(autoDate(0, Date.parse('2026-11-04T10:00:00Z')).toISOString().slice(0, 10), '2026-11-04');
  assert.equal(autoDate(10, Date.parse('2026-12-28T10:00:00Z')).toISOString().slice(0, 10), '2027-01-07');
});
t('settings: switch and lead days are checked', () => {
  assert.deepEqual(cleanSettings({ enabled: 'true', leadDays: '7' }), { enabled: true, leadDays: 7 });
  assert.deepEqual(cleanSettings({ enabled: false }), { enabled: false });
  assert.deepEqual(cleanSettings({}), {});
  assert.throws(() => cleanSettings({ leadDays: 30 }), /0 to 21/);
  assert.throws(() => cleanSettings({ leadDays: 2.5 }), /whole number/);
  assert.throws(() => cleanSettings({ leadDays: 'x' }), /whole number/);
});
t('feedback: cleaned, no duplicates, no empty notes, a limit', () => {
  const rows = [
    { feedback: '  No dark bar \n behind the text ', format: 'reel', pillar: 'neighbourhood' },
    { feedback: 'no dark bar behind the text', format: 'reel', pillar: 'x' },
    { feedback: '   ', format: 'reel' },
    { feedback: null },
    { feedback: 'Too many exclamation marks', format: 'single', pillar: 'design_details' }
  ];
  const items = feedbackItems(rows);
  assert.equal(items.length, 2);
  assert.equal(items[0].text, 'No dark bar behind the text');
  assert.equal(feedbackItems(Array(20).fill(0).map((_, i) => ({ feedback: `note ${i}` })), 3).length, 3);
  assert.equal(feedbackItems(null).length, 0);
  assert.equal(feedbackItems([{ feedback: 'x'.repeat(500) }])[0].text.length, 300);
});
t('feedback block for the brief', () => {
  assert.deepEqual(feedbackPromptBlock([]), []);
  assert.deepEqual(feedbackPromptBlock(undefined), []);
  const block = feedbackPromptBlock([{ text: 'No dark bar', format: 'reel', pillar: 'neighbourhood' }, { text: 'Shorter', format: null, pillar: null }]);
  assert.match(block[1], /TEAM FEEDBACK/);
  assert.equal(block[2], '- (reel, neighbourhood) No dark bar');
  assert.equal(block[3], '- (post) Shorter');
});
console.log(`\n${n} tests passed`);
