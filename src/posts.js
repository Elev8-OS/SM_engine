import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { q } from './db.js';
import { HttpError } from './util.js';
import { renderReel } from './reel.js';
import { renderCarousel } from './carousel.js';
import { putFile, presign } from './storage.js';
import { mediaUrl } from './media.js';
import { createDrafts, scheduleDrafts, ghlConfigured } from './ghl.js';
import { checkFacts, factNumbers } from './facts.js';
import { checkArea } from './area.js';
import { checkPromoCopy } from './promo-rules.js';

const SITE = 'elevate-villas.com'; // shown as plain text, never as a button
const BANNED = ['leverage', 'synergy', 'synergies', 'ecosystem', 'world-class', 'best-in-class', 'innovative solution', 'unlock', 'seamless', 'actualize'];

/** Cheap guards on the generated copy. Returns a list of warnings, never throws. */
export function checkCopy(copy, plan) {
  const warnings = [];
  const text = JSON.stringify(copy).toLowerCase();
  for (const w of BANNED) if (text.includes(w)) warnings.push(`Banned word: ${w}`);
  const guests = new Set(plan.properties.map((p) => p.guests).filter(Boolean));
  const beds = new Set(plan.properties.flatMap((p) => String(p.bedrooms || '').match(/\d+/g) || []).map(Number));
  const fromSheets = factNumbers(plan); // fact sheets know more than the properties table (for example 10 guests)
  fromSheets.guests.forEach((n) => guests.add(n));
  fromSheets.bedrooms.forEach((n) => beds.add(n));
  const caps = Object.values(copy.captions || {}).join(' ');
  for (const m of caps.matchAll(/(\d+)\s*(guests?|bedrooms?)/gi)) {
    const n = Number(m[1]);
    const set = /guest/i.test(m[2]) ? guests : beds;
    if (set.size && !set.has(n)) warnings.push(`Number not in facts: ${m[0]}`);
  }
  warnings.push(...checkFacts(copy, plan));
  warnings.push(...checkArea(copy, plan)); // places, walking times, prices and ratings of places
  warnings.push(...checkPromoCopy(copy, plan)); // offers and codes: only the active promotion may appear
  if (!copy.captions?.instagram) warnings.push('Missing Instagram caption');
  if (!Array.isArray(copy.hashtags) || copy.hashtags.length < 3) warnings.push('Too few hashtags');
  return warnings;
}

/** Pull the first JSON object out of model text (tolerates fences or stray words). */
export function parseCopyText(text) {
  const t = String(text || '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new HttpError(400, 'copyText contains no JSON object');
  try {
    return JSON.parse(t.slice(a, b + 1));
  } catch {
    throw new HttpError(400, 'copyText is not valid JSON');
  }
}

/** Accepts JSON bodies or form fields (copyText and photos as strings), which is what Make sends safely. */
export function normaliseRenderBody(body) {
  const out = { ...(body || {}) };
  if (!out.copy && out.copyText) out.copy = parseCopyText(out.copyText);
  if (typeof out.photos === 'string') {
    try {
      out.photos = JSON.parse(out.photos);
    } catch {
      throw new HttpError(400, 'photos is not valid JSON');
    }
  }
  return out;
}

const get = async (id) => {
  const rows = await q('select * from posts where id = $1', [id]);
  if (!rows.length) throw new HttpError(404, 'Post not found');
  return rows[0];
};

function validateRender(post, body) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'Body must be a JSON object');
  const { copy, photos } = body;
  if (!copy || typeof copy !== 'object') throw new HttpError(400, 'copy is required');
  if (!Array.isArray(photos) || photos.length !== post.plan.photos.length) throw new HttpError(400, `photos must contain ${post.plan.photos.length} items, one per planned photo`);
  const byId = new Map(photos.map((p) => [p.fileId, p]));
  for (const p of post.plan.photos) {
    const src = byId.get(p.fileId);
    if (!src || !(src.url || src.base64)) throw new HttpError(400, `Missing url or base64 for photo ${p.fileId}`);
  }
  if (!Array.isArray(copy.lines)) copy.lines = [];
  return byId;
}

export async function renderPost(id, rawBody) {
  const post = await get(id);
  const body = normaliseRenderBody(rawBody);
  const byId = validateRender(post, body);
  const { copy } = body;
  const ordered = post.plan.photos.map((p) => byId.get(p.fileId));
  const end = copy.endCard || {};
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'smpost-'));
  try {
    const keys = [];
    let mediaType;
    if (post.format === 'reel') {
      const job = {
        hook: copy.hook || copy.lines[0]?.headline || 'Villa in Bali',
        subhook: copy.subhook,
        photos: ordered.map((p, i) => ({ url: p.url, base64: p.base64, video: p.video, line: copy.lines[i]?.headline, sub: copy.lines[i]?.sub })),
        endCard: { title: end.title || 'Book direct. Best rate guaranteed.', subtitle: end.subtitle, cta: SITE, hint: 'Link in bio' },
        music: body.music
      };
      const r = await renderReel(job, dir);
      keys.push(await putFile(r.file, `posts/${id}/reel.mp4`, 'video/mp4'));
      mediaType = 'video';
    } else {
      const slides = ordered.map((p, i) => ({ photo: p, headline: copy.lines[i]?.headline || copy.hook || 'The R Villas Bali', sub: copy.lines[i]?.sub }));
      if (post.format === 'carousel') {
        slides.push({ photo: ordered[0], headline: end.title || 'Book direct. Best rate guaranteed.', sub: end.subtitle, cta: SITE, darken: true });
      }
      const files = await renderCarousel({ format: post.format === 'story' ? 'story' : 'feed', slides }, dir);
      for (const f of files) keys.push(await putFile(f.file, `posts/${id}/${f.name}`, 'image/jpeg'));
      mediaType = 'image';
    }
    const warnings = checkCopy(copy, post.plan);
    await q("update posts set copy = $2, media = $3, status = 'rendered', error = $4, updated_at = now() where id = $1", [id, { ...copy, warnings }, { type: mediaType, keys }, warnings.length ? warnings.join('; ') : null]);
    return { postId: id, status: 'rendered', media: { type: mediaType, keys }, warnings };
  } catch (e) {
    await q("update posts set status = 'failed', error = $2, updated_at = now() where id = $1", [id, String(e.message || e).slice(0, 500)]);
    throw e;
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function mediaUrls(post) {
  const keys = post.media?.keys || [];
  // Own signed links (valid a year) when the public address is known, otherwise the bucket's 7 day links.
  return Promise.all(keys.map(async (k) => mediaUrl(k) || (await presign(k))));
}

export async function postView(id) {
  const post = await get(id);
  return { ...post, mediaUrls: await mediaUrls(post) };
}

export async function listPosts({ status, limit = 50 } = {}) {
  const rows = status
    ? await q('select * from posts where status = $1 order by plan_date desc, id desc limit $2', [status, limit])
    : await q('select * from posts order by plan_date desc, id desc limit $1', [limit]);
  return rows;
}

export async function draftToGhl(id) {
  const post = await get(id);
  if (!post.media?.keys?.length) throw new HttpError(409, 'Post has no rendered media yet');
  if (!ghlConfigured()) throw new HttpError(409, 'GHL is not configured yet (token, location, user and social accounts)');
  const urls = await mediaUrls(post);
  const ghl = await createDrafts(post, urls);
  const ok = Object.values(ghl).some((r) => r && r.ok);
  await q('update posts set ghl = $2, status = $3, error = $4, updated_at = now() where id = $1', [id, ghl, ok ? 'draft_created' : post.status, ok ? post.error : 'GHL draft failed']);
  return { postId: id, status: ok ? 'draft_created' : post.status, ghl };
}

export async function setStatus(id, { status, feedback, scheduledFor }) {
  const allowed = ['approved', 'rejected', 'scheduled', 'published', 'planned', 'rendered'];
  if (!allowed.includes(status)) throw new HttpError(400, `status must be one of ${allowed.join(', ')}`);
  const post = await get(id);
  let ghl = post.ghl;
  if (status === 'scheduled') {
    if (!scheduledFor || Number.isNaN(Date.parse(scheduledFor))) throw new HttpError(400, 'scheduledFor must be an ISO date');
    if (!ghlConfigured()) throw new HttpError(409, 'GHL is not configured yet');
    const res = await scheduleDrafts(post, new Date(scheduledFor).toISOString(), await mediaUrls(post));
    if (!Object.values(res).some((r) => r.ok)) throw new HttpError(502, `GHL did not accept the schedule: ${JSON.stringify(res).slice(0, 400)}`);
    ghl = { ...post.ghl, schedule: res };
  }
  await q('update posts set status = $2, feedback = coalesce($3, feedback), scheduled_for = coalesce($4, scheduled_for), ghl = $5, updated_at = now() where id = $1', [id, status, feedback ?? null, scheduledFor ?? null, ghl]);
  return postView(id);
}
