// Pure rules for the music library of the reels. No database, no storage: easy to test.
// A track is only used when its license is confirmed (with a reference) and it is switched on.
export const MOODS = ['calm', 'upbeat', 'any'];
export const MAX_BYTES = 15 * 1024 * 1024;

const UPBEAT = new Set(['neighbourhood', 'which_villa_for']);
/** Calm tracks for villas and details, livelier ones for the area and for matching villas to groups. */
export const moodFor = (pillar) => (UPBEAT.has(pillar) ? 'upbeat' : 'calm');

/** An MP3 starts with an ID3 tag or a frame sync. */
export function looksLikeMp3(buf) {
  if (!buf || buf.length < 4096) return false;
  if (buf.subarray(0, 3).toString('latin1') === 'ID3') return true;
  return buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
}

const bool = (v) => v === true || v === 'true' || v === 1 || v === '1';

/** Cleans the fields that came in. Only present fields are returned. Throws a readable error. */
export function cleanTrack(body = {}, { create = false } = {}) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  if (create || has('title')) {
    const t = String(body.title ?? '').trim();
    if (!t) throw new Error('A title is required');
    if (t.length > 120) throw new Error('The title is too long (120 characters at most)');
    out.title = t;
  }
  if (has('provider')) out.provider = String(body.provider ?? '').trim().slice(0, 120);
  if (has('license_ref')) out.license_ref = String(body.license_ref ?? '').trim().slice(0, 300);
  if (has('note')) out.note = String(body.note ?? '').trim().slice(0, 500);
  if (has('mood')) {
    if (!MOODS.includes(body.mood)) throw new Error(`mood must be one of ${MOODS.join(', ')}`);
    out.mood = body.mood;
  }
  if (has('license_ok')) out.license_ok = bool(body.license_ok);
  if (has('active')) out.active = bool(body.active);
  return out;
}

/** The whole track after a change is merged in. Returns an error text or null. */
export function problem(t) {
  if (t.license_ok && !String(t.provider || '').trim()) return 'Confirming the license needs the provider';
  if (t.license_ok && !String(t.license_ref || '').trim()) return 'Confirming the license needs a reference (link, invoice or license ID)';
  return null;
}

export const eligible = (t) => Boolean(t && t.license_ok && t.active);

/** A track for a mood: only licensed and active ones, the least used first, a random one among equals. */
export function choose(tracks, mood, rand = Math.random) {
  const ok = (tracks || []).filter(eligible);
  if (!ok.length) return null;
  const fit = ok.filter((t) => t.mood === mood || t.mood === 'any');
  const pool = fit.length ? fit : ok;
  const least = Math.min(...pool.map((t) => t.used_count ?? 0));
  const group = pool.filter((t) => (t.used_count ?? 0) === least);
  return group[Math.floor(rand() * group.length)];
}
