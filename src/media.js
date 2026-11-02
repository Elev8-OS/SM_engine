import crypto from 'node:crypto';

// Public, signed links to stored media. They are served by this service itself, so they can be valid
// for a year (the storage bucket's own links stop after 7 days). The signature covers the file and the expiry.
const secret = () => process.env.MEDIA_SECRET || process.env.API_KEY || '';
const base = () => (process.env.PUBLIC_BASE_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')).replace(/\/+$/, '');

const sign = (id, name, exp) => crypto.createHmac('sha256', secret()).update(`${id}/${name}:${exp}`).digest('hex');

/** Signed link for a storage key like posts/2/01.jpg, or null when the public address or secret is not set. */
export function mediaUrl(key, ttlSeconds = 365 * 24 * 3600) {
  const m = /^posts\/(\d+)\/([\w.-]+)$/.exec(key);
  if (!m || !base() || !secret()) return null;
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return `${base()}/m/${m[1]}/${m[2]}?exp=${exp}&sig=${sign(m[1], m[2], exp)}`;
}

export function verifyMedia(id, name, exp, sig) {
  const e = Number(exp);
  if (!Number.isFinite(e) || e < Date.now() / 1000 || typeof sig !== 'string' || !secret()) return false;
  const want = Buffer.from(sign(id, name, e));
  const given = Buffer.from(sig);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}
