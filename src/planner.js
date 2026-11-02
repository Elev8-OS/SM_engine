import { q } from './db.js';
import { slotFor, PILLARS, RULES, COPY_SCHEMA } from './strategy.js';
import { AREAS } from './seed.js';

const HERO_ROOMS = ['pool', 'exterior', 'view', 'terrace'];
const DETAIL_ROOMS = ['detail', 'bathroom', 'kitchen', 'living', 'bedroom', 'pool'];
const COUNTS = { reel: 5, carousel: 6, single: 1, story: 1 };

function shuffle(a) {
  return a
    .map((x) => [Math.random(), x])
    .sort((x, y) => x[0] - y[0])
    .map((x) => x[1]);
}

function rank(photos) {
  // Least used first, then best quality, with a little randomness among equals.
  return shuffle(photos).sort((a, b) => a.used_count - b.used_count || b.quality - a.quality);
}

/** Choose n photos from different rooms. The first prefers one of heroRooms. */
export function pickPhotos(photos, n, { heroRooms = HERO_ROOMS, preferReel = false } = {}) {
  let pool = photos.filter((p) => !p.has_people);
  if (preferReel) {
    const reel = pool.filter((p) => p.reel_fit);
    if (reel.length >= n) pool = reel;
  }
  const ranked = rank(pool);
  const picked = [];
  const rooms = new Set();
  const hero = ranked.find((p) => heroRooms.includes(p.room));
  if (hero) {
    picked.push(hero);
    rooms.add(hero.room);
  }
  for (const p of ranked) {
    if (picked.length >= n) break;
    if (picked.includes(p) || rooms.has(p.room)) continue;
    picked.push(p);
    rooms.add(p.room);
  }
  for (const p of ranked) {
    if (picked.length >= n) break;
    if (!picked.includes(p)) picked.push(p);
  }
  return picked.length >= n ? picked : null;
}

async function loadCandidates() {
  const props = await q('select * from properties where active order by last_posted_at asc nulls first, key');
  const photos = await q('select * from photos where approved and quality >= 4');
  const byProp = new Map();
  for (const p of photos) {
    if (!byProp.has(p.property_key)) byProp.set(p.property_key, []);
    byProp.get(p.property_key).push(p);
  }
  return props.map((p) => ({ ...p, photos: byProp.get(p.key) || [] })).filter((p) => p.photos.length > 0);
}

const factsOf = (p) => ({ key: p.key, name: p.name, area: p.area, type: p.type, guests: p.guests, sizeM2: p.size_m2, bedrooms: p.bedrooms, url: p.url, highlights: p.highlights });
const photoOut = (p) => ({ fileId: p.file_id, propertyKey: p.property_key, name: p.name, room: p.room, motif: p.motif, issues: p.issues || '' });

function choose(candidates, pillar, format) {
  const need = COUNTS[format];
  if (pillar === 'which_villa_for') {
    // Three villas of different size, one hero photo each.
    const sized = candidates.filter((c) => c.type === 'villa' && c.guests);
    const bands = [(g) => g <= 4, (g) => g >= 5 && g <= 6, (g) => g >= 7];
    const picks = [];
    for (const band of bands) {
      const c = sized.find((s) => band(s.guests) && !picks.includes(s) && pickPhotos(s.photos, 1));
      if (c) picks.push(c);
    }
    if (picks.length < 2) return null;
    return { props: picks, photos: picks.map((c) => pickPhotos(c.photos, 1)[0]) };
  }
  let list = candidates;
  if (pillar === 'workation') list = candidates.filter((c) => /office|desk|workspace/i.test(c.highlights || ''));
  for (const c of list) {
    let photos;
    if (pillar === 'design_details') photos = pickPhotos(c.photos.filter((p) => p.quality >= 5 && DETAIL_ROOMS.includes(p.room)), 1, { heroRooms: DETAIL_ROOMS });
    else if (pillar === 'neighbourhood') photos = pickPhotos(c.photos.filter((p) => HERO_ROOMS.includes(p.room)), Math.min(need, 3), { preferReel: true });
    else photos = pickPhotos(c.photos, need, { preferReel: format === 'reel' });
    if (photos) return { props: [c], photos };
  }
  return null;
}

/**
 * Plan the post for a date. Returns the existing post when the day is already planned,
 * so a rerun never creates duplicates.
 */
export async function planNext(date) {
  const slot = slotFor(date);
  const planDate = date.toISOString().slice(0, 10);
  const existing = await q("select * from posts where plan_date = $1 and format = $2 and status <> 'rejected' limit 1", [planDate, slot.format]);
  if (existing.length) return toPlan(existing[0]);

  const candidates = await loadCandidates();
  let pillar = slot.pillar;
  let picked = choose(candidates, pillar, slot.format);
  if (!picked && pillar !== 'villa_spotlight') {
    pillar = 'villa_spotlight'; // fall back when the pillar has no matching property yet
    picked = choose(candidates, pillar, slot.format);
  }
  if (!picked) throw new Error('No property has enough approved photos for this format yet');

  const areas = [...new Set(picked.props.map((p) => p.area))];
  const plan = {
    planDate,
    format: slot.format,
    pillar,
    angle: PILLARS[pillar],
    properties: picked.props.map(factsOf),
    photos: picked.photos.map(photoOut),
    areaFacts: pillar === 'neighbourhood' ? Object.fromEntries(areas.map((a) => [a, AREAS[a] || []])) : undefined,
    rules: RULES,
    copySchema: COPY_SCHEMA
  };
  const rows = await q(
    `insert into posts (plan_date, pillar, format, property_key, status, plan) values ($1,$2,$3,$4,'planned',$5)
     on conflict do nothing returning *`,
    [planDate, pillar, slot.format, picked.props[0].key, plan]
  );
  const row = rows[0] || (await q("select * from posts where plan_date = $1 and format = $2 and status <> 'rejected' limit 1", [planDate, slot.format]))[0];
  for (const p of picked.photos) await q('update photos set used_count = used_count + 1, last_used_at = now() where file_id = $1', [p.file_id]);
  for (const p of picked.props) await q('update properties set last_posted_at = now() where key = $1', [p.key]);
  return toPlan(row);
}

function toPlan(row) {
  return { postId: row.id, status: row.status, ...row.plan };
}
