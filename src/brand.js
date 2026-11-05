import { elev8Tool } from './agent/clients.js';
import { HttpError } from './util.js';

// Public brand data of the operator, read from Elev8 (read-only): Instagram, Facebook, website, WhatsApp, logo.
//
// Only an allow-list of public fields leaves this file. The Elev8 listing tool also returns door codes, wifi names and other
// internal data. None of it is copied, logged or returned here.
//
// The brand NAME is deliberately not taken from the tenant profile: that is the legal operator (Elevate Schweiz GmbH),
// while guests and venues know the brand "The R Villas Bali". The name stays a setting in the app.

const TAG = process.env.AUDIENCE_TAG || 'indonesia';
const TTL = 6 * 3600 * 1000;
const RESERVED = new Set(['p', 'reel', 'reels', 'explore', 'stories', 'accounts', 'direct']);

let cache = { at: 0, data: null };

/** Most common non-empty value (the villas should all agree; if one differs, the majority wins). */
const top = (values) => {
  const n = new Map();
  for (const v of values) if (v) n.set(v, (n.get(v) || 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
};

const cleanUrl = (u, keepPath) => {
  const s = String(u || '').trim();
  if (!s) return '';
  try {
    const x = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    return keepPath ? x.href : x.origin;
  } catch {
    return '';
  }
};

const digits = (s) => String(s || '').replace(/\D/g, '');

export function instagramHandle(url) {
  const m = String(url || '').match(/instagram\.com\/([A-Za-z0-9._]+)/i);
  const h = m?.[1] || '';
  return h && !RESERVED.has(h.toLowerCase()) ? h : '';
}

export function pickBrand(profile, listings) {
  const ls = (Array.isArray(listings) ? listings : []).filter((l) => l && (l.status === 1 || l.status == null));
  const instagramUrl = top(ls.map((l) => cleanUrl(l.instagram_url, true)));
  const logo = String(profile?.logo_url || '').trim();
  return {
    instagram: instagramHandle(instagramUrl),
    instagramUrl,
    facebookUrl: top(ls.map((l) => cleanUrl(l.facebook_url, true))),
    website: top(ls.map((l) => cleanUrl(l.website_url, false))),
    whatsapp: top(ls.map((l) => digits(l.whatsapp))),
    logoUrl: /^https:\/\//i.test(logo) ? logo : '',
    listings: ls.length
  };
}

export async function brandData({ refresh = false } = {}) {
  if (!refresh && cache.data && Date.now() - cache.at < TTL) return cache.data;
  const [p, l] = await Promise.allSettled([elev8Tool('get_tenant_profile', {}), elev8Tool('get_listings_by_tag', { listing_tag: TAG })]);
  if (p.status === 'rejected' && l.status === 'rejected') {
    if (cache.data) return cache.data; // better slightly old than nothing
    throw new HttpError(502, 'Elev8 brand data is not reachable');
  }
  const profile = p.status === 'fulfilled' ? p.value?.results?.[0] : null;
  const listings = l.status === 'fulfilled' ? l.value?.results : [];
  const data = { ...pickBrand(profile, listings), fetchedAt: new Date().toISOString() };
  cache = { at: Date.now(), data };
  return data;
}

export function brandRoutes(app, ah) {
  app.get('/brand', ah(async (req, res) => res.json(await brandData({ refresh: req.query.refresh === '1' }))));
}
