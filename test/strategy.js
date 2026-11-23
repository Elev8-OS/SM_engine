import assert from 'node:assert/strict';
import { slotFor, PILLARS, RULES, COPY_SCHEMA, WEEK } from '../src/strategy.js';
import { featuresOf, findPatterns } from '../src/learnings.js';
import { PILLAR_KEYS } from '../src/classify.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };
const day = (s) => new Date(`${s}T00:00:00Z`);

t('every pillar the grid can produce has a brief and a classifier key', () => {
  const seen = new Set();
  for (let i = 0; i < 28; i++) {
    const d = new Date(day('2026-11-02').getTime() + i * 86400000);
    seen.add(slotFor(d).pillar);
  }
  for (const p of seen) {
    assert.ok(PILLARS[p], `PILLARS has ${p}`);
    assert.ok(PILLAR_KEYS.includes(p), `PILLAR_KEYS has ${p}`);
  }
  assert.ok(seen.has('villa_angles') && seen.has('villa_spotlight'));
});
t('Sunday alternates between spotlight and angles, always a carousel', () => {
  const a = slotFor(day('2026-11-22'));
  const b = slotFor(day('2026-11-29'));
  assert.equal(a.format, 'carousel');
  assert.equal(b.format, 'carousel');
  assert.notEqual(a.pillar, b.pillar);
  assert.ok(['villa_spotlight', 'villa_angles'].includes(a.pillar));
});
t('the other weekdays are unchanged', () => {
  assert.deepEqual(slotFor(day('2026-11-23')), { format: 'reel', pillar: 'villa_spotlight' });
  assert.deepEqual(slotFor(day('2026-11-24')), { format: 'carousel', pillar: 'which_villa_for' });
  assert.equal(WEEK[7].pillar, 'spotlight_or_angles');
});
t('the brief asks for a hook style and the schema carries it', () => {
  assert.ok(RULES.some((r) => /Hooks:/.test(r) && /never promises more than the facts/.test(r)));
  assert.match(COPY_SCHEMA.hookType, /curiosity.*surprise.*contrast.*open_loop.*moment/);
});
t('learnings read the hook style of engine posts', () => {
  const f = featuresOf({ posted_at: '2026-11-01T02:00:00Z', caption: 'Wake up.', post_id: 1, hook_type: 'contrast' });
  assert.equal(f.hookType, 'contrast');
  assert.equal(featuresOf({ posted_at: '2026-11-01T02:00:00Z', caption: 'x', post_id: 2 }).hookType, null);
});
t('hookType is compared like the other dimensions and never proposes a rule', () => {
  const mk = (type, score, i) => ({ f: { source: 'engine', hookType: type, format: 'reel', captionLength: 'medium', hour: 'morning', hashtags: 'normal', weekend: 'no', question: 'no', emoji: 'no', pillar: 'villa_spotlight', villa: `v${i % 2}` }, score });
  const posts = [];
  for (let i = 0; i < 8; i++) posts.push(mk('contrast', 200 + i, i));
  for (let i = 0; i < 8; i++) posts.push(mk('moment', 20 + i, i));
  const { found } = findPatterns(posts);
  const hit = found.find((x) => x.dimension === 'hookType' && x.value === 'contrast');
  assert.ok(hit, 'contrast hooks are found to do better');
  assert.deepEqual(hit.action, { type: 'info' });
});

console.log(`\n${n} tests passed`);
