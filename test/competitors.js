import assert from 'node:assert/strict';
import { parseHandle, summarise, unreadable } from '../src/competitors.js';

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
console.log(`\n${n} tests passed`);
