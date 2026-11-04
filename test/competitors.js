import assert from 'node:assert/strict';
import { parseHandle, summarise, unreadable, compare } from '../src/competitors.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };
const NOW = Date.parse('2026-11-04T00:00:00Z');
const day = (d) => new Date(NOW - d * 86400000).toISOString();

t('handles from links, @names and plain names', () => {
  assert.equal(parseHandle('https://www.instagram.com/purahomesbali?obrf=ZGNkdnAxcWE1M3c1'), 'purahomesbali');
  assert.equal(parseHandle('\u2060https://www.instagram.com/rent.property.bali?psln=MWFjNXVydDQxMHppcg=='), 'rent.property.bali');
  assert.equal(parseHandle('https://www.instagram.com/mioestate/?xtok=x'), 'mioestate');
  assert.equal(parseHandle('@House_Of_Reservations'), 'house_of_reservations');
  assert.equal(parseHandle('sandaramanagement'), 'sandaramanagement');
  assert.equal(parseHandle(''), null);
  assert.equal(parseHandle('not a handle!'), null);
});
t('numbers from an account', () => {
  const bd = {
    followers_count: 10000,
    media_count: 400,
    media: { data: [
      { timestamp: day(2), like_count: 300, comments_count: 10, media_product_type: 'REELS', permalink: 'https://i/1', caption: 'Reel  one\nwith lines' },
      { timestamp: day(9), like_count: 100, comments_count: 4, media_type: 'CAROUSEL_ALBUM', permalink: 'https://i/2' },
      { timestamp: day(20), like_count: 200, comments_count: 20, media_type: 'IMAGE', permalink: 'https://i/3' },
      { timestamp: day(45), like_count: 50, comments_count: 0, media_type: 'IMAGE', permalink: 'https://i/4' }
    ] }
  };
  const s = summarise(bd, NOW);
  assert.equal(s.followers, 10000);
  assert.equal(s.posts_30d, 3);
  assert.equal(s.posts_per_week, 0.7);
  assert.equal(s.avg_likes, 162.5);
  assert.equal(s.avg_comments, 8.5);
  assert.equal(s.engagement_pct, 1.71);
  assert.equal(s.reel_share_pct, 25);
  assert.equal(s.top[0].permalink, 'https://i/1');
  assert.equal(s.top[0].reel, true);
  assert.equal(s.top[0].caption, 'Reel one with lines');
  assert.equal(s.top.length, 3);
});
t('an account without posts or hidden likes does not break', () => {
  const s = summarise({ followers_count: 500, media_count: 0, media: { data: [] } }, NOW);
  assert.equal(s.posts_30d, 0);
  assert.equal(s.avg_likes, null);
  assert.equal(s.engagement_pct, null);
  assert.equal(s.reel_share_pct, null);
  const hidden = summarise({ followers_count: 500, media: { data: [{ timestamp: day(1), media_type: 'IMAGE' }] } }, NOW);
  assert.equal(hidden.avg_likes, null);
  assert.equal(hidden.engagement_pct, null);
  assert.equal(summarise(null, NOW).followers, null);
});
t('which errors mean "cannot be read"', () => {
  assert.equal(unreadable(Object.assign(new Error('Invalid user id'), { code: 110 })), true);
  assert.equal(unreadable(new Error('Unsupported get request. The user is not a business account')), true);
  assert.equal(unreadable(Object.assign(new Error('Error validating access token'), { code: 190 })), false);
  assert.equal(unreadable(new Error('timeout')), false);
});
const comp = (handle, o = {}) => ({ handle, status: 'ok', followers: 10000, postsPerWeek: 3, avgLikes: 100, avgComments: 5, engagementPct: 1, reelSharePct: 40, ...o });
t('comparison: rank, median and verdict per metric', () => {
  const comps = [comp('a', { followers: 20000, engagementPct: 2 }), comp('b', { followers: 10000, engagementPct: 1 }), comp('c', { followers: 5000, engagementPct: 0.5 })];
  const self = { followers: 8000, posts_per_week: 3, avg_likes: 100, avg_comments: 5, engagement_pct: 1.5, reel_share_pct: 10 };
  const c = compare(self, comps);
  const by = (k) => c.rows.find((r) => r.key === k);
  assert.equal(c.readable, 3);
  assert.equal(by('followers').median, 10000);
  assert.equal(by('followers').rank, 3);
  assert.equal(by('followers').of, 4);
  assert.equal(by('followers').diffPct, -20);
  assert.equal(by('followers').verdict, 'worse');
  assert.equal(by('followers').bestHandle, 'a');
  assert.equal(by('engagementPct').verdict, 'better');
  assert.equal(by('engagementPct').rank, 2);
  assert.equal(by('postsPerWeek').verdict, 'similar');
  assert.equal(by('reelSharePct').verdict, 'worse');
  assert.deepEqual(c.summary, { better: 1, worse: 2, similar: 3 });
});
t('comparison ignores accounts that cannot be read and copes with a missing own account', () => {
  const comps = [comp('a'), { handle: 'b', status: 'not_readable' }, { handle: 'c', status: 'error' }];
  const c = compare({ followers: 12000, posts_per_week: 3, avg_likes: 100, avg_comments: 5, engagement_pct: 1, reel_share_pct: 40 }, comps);
  assert.equal(c.readable, 1);
  assert.equal(c.rows.find((r) => r.key === 'followers').of, 2);
  assert.equal(c.rows.find((r) => r.key === 'followers').rank, 1);
  const none = compare(null, comps);
  assert.equal(none.rows[0].ours, null);
  assert.equal(none.rows[0].verdict, 'unknown');
  assert.equal(compare({ error: 'x' }, comps).rows[0].verdict, 'unknown');
  const empty = compare({ followers: 5 }, []);
  assert.equal(empty.readable, 0);
  assert.equal(empty.rows[0].verdict, 'unknown');
});
t('comparison: a median of zero does not divide', () => {
  const comps = [comp('a', { avgComments: 0 }), comp('b', { avgComments: 0 })];
  assert.equal(compare({ avg_comments: 3 }, comps).rows.find((r) => r.key === 'avgComments').verdict, 'better');
  assert.equal(compare({ avg_comments: 0 }, comps).rows.find((r) => r.key === 'avgComments').verdict, 'similar');
});
console.log(`\n${n} tests passed`);
