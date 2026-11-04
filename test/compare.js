import assert from 'node:assert/strict';
import { mannWhitney, median, compareCohorts, formatOf } from '../src/compare-sources.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };
const NOW = Date.parse('2026-12-01T00:00:00Z');
const day = (d) => new Date(NOW - d * 86400000).toISOString();
const row = (o) => ({ posted_at: day(20), post_id: null, product_type: 'REELS', media_type: 'VIDEO', reach: 1000, views: 1500, likes: 50, comments: 5, saved: 10, shares: 5, profile_visits: 8, follows: 2, ...o });

t('median', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
  assert.equal(median([NaN, 5]), 5);
});
t('Mann-Whitney: clear difference, no difference, ties, empty', () => {
  const lo = [1, 2, 3, 4, 5, 6, 7, 8];
  const hi = [9, 10, 11, 12, 13, 14, 15, 16];
  assert.ok(mannWhitney(lo, hi).p < 0.01);
  assert.ok(mannWhitney(lo, [1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5]).p > 0.5);
  assert.equal(mannWhitney([5, 5, 5], [5, 5, 5]).p, 1);
  assert.equal(mannWhitney([], [1]), null);
});
t('format: reels and videos against posts', () => {
  assert.equal(formatOf({ product_type: 'REELS' }), 'reel');
  assert.equal(formatOf({ media_type: 'VIDEO' }), 'reel');
  assert.equal(formatOf({ product_type: 'FEED', media_type: 'CAROUSEL_ALBUM' }), 'post');
});
t('too few posts: no verdict, however big the gap', () => {
  const rows = [...Array(7).fill(0).map(() => row({ post_id: 1, reach: 5000 })), ...Array(20).fill(0).map(() => row())];
  const c = compareCohorts(rows, { now: NOW });
  const reach = c.groups.reel.metrics.find((m) => m.key === 'reach');
  assert.equal(reach.verdict, 'too_few');
  assert.equal(reach.diffPct, 400);
  assert.equal(c.groups.reel.enough, false);
});
t('enough posts and a clear gap: verdict for the better side', () => {
  const rows = [
    ...Array(10).fill(0).map((_, i) => row({ post_id: i + 1, reach: 2000 + i * 50 })),
    ...Array(10).fill(0).map((_, i) => row({ reach: 1000 + i * 20 }))
  ];
  const c = compareCohorts(rows, { now: NOW });
  const reach = c.groups.reel.metrics.find((m) => m.key === 'reach');
  assert.equal(reach.verdict, 'auto_better');
  assert.ok(reach.p < 0.01);
  assert.equal(c.groups.reel.enough, true);
  const flipped = compareCohorts(rows.map((r) => ({ ...r, post_id: r.post_id ? null : 1 })), { now: NOW });
  assert.equal(flipped.groups.reel.metrics.find((m) => m.key === 'reach').verdict, 'manual_better');
});
t('a small gap or noise is "no clear difference"', () => {
  const rows = [
    ...Array(10).fill(0).map((_, i) => row({ post_id: i + 1, reach: 1000 + (i % 3) * 30 })),
    ...Array(10).fill(0).map((_, i) => row({ reach: 1005 + (i % 3) * 30 }))
  ];
  assert.equal(compareCohorts(rows, { now: NOW }).groups.reel.metrics.find((m) => m.key === 'reach').verdict, 'no_clear_difference');
});
t('posts under 7 days are left out, formats are kept apart', () => {
  const rows = [row({ post_id: 1, posted_at: day(3) }), row({ post_id: 2 }), row({ product_type: 'FEED', media_type: 'IMAGE' })];
  const c = compareCohorts(rows, { now: NOW });
  assert.equal(c.groups.all.nAuto, 1);
  assert.equal(c.groups.reel.nAuto, 1);
  assert.equal(c.groups.reel.nManual, 0);
  assert.equal(c.groups.post.nManual, 1);
  assert.equal(c.groups.all.mixed, true);
});
t('periods of both groups and their overlap, empty input', () => {
  const rows = [row({ post_id: 1, posted_at: day(10) }), row({ post_id: 2, posted_at: day(30) }), row({ posted_at: day(25) }), row({ posted_at: day(60) })];
  const g = compareCohorts(rows, { now: NOW }).groups.reel;
  assert.equal(g.autoFrom, '2026-11-01');
  assert.equal(g.manualFrom, '2026-10-02');
  assert.equal(g.overlapDays, 5);
  const none = compareCohorts([], { now: NOW }).groups.reel;
  assert.equal(none.overlapDays, null);
  assert.equal(none.metrics[0].verdict, 'too_few');
  assert.equal(compareCohorts(null, { now: NOW }).groups.all.nAuto, 0);
});
t('ratios: a post without reach does not break the numbers', () => {
  const g = compareCohorts([row({ reach: 0, post_id: 1 }), row({ reach: null })], { now: NOW }).groups.reel;
  const eng = g.metrics.find((m) => m.key === 'engagementRate');
  assert.equal(eng.nAuto, 0);
  assert.equal(eng.auto, null);
});
console.log(`\n${n} tests passed`);
