const BASE = 'https://services.leadconnectorhq.com';

export function ghlConfigured() {
  return Boolean(process.env.GHL_API_TOKEN && process.env.GHL_LOCATION_ID && process.env.GHL_USER_ID && accounts() && Object.keys(accounts()).length);
}

function accounts() {
  try {
    return JSON.parse(process.env.GHL_ACCOUNT_IDS || '{}');
  } catch {
    return null;
  }
}

const headers = () => ({
  Authorization: `Bearer ${process.env.GHL_API_TOKEN}`,
  Version: '2021-07-28',
  'Content-Type': 'application/json',
  Accept: 'application/json'
});

const SITE_URL = 'https://www.elevate-villas.com';

/** Booking link with tracking. One property: its own page, otherwise the portfolio page. */
export function bookingUrl(post, platform) {
  const props = post.plan?.properties || [];
  const base = props.length === 1 && props[0].url ? props[0].url : SITE_URL;
  const campaign = `${post.pillar || 'post'}_${post.format || 'post'}_${post.id}`.replace(/[^a-z0-9_]/gi, '');
  return `${base}${base.includes('?') ? '&' : '?'}utm_source=${platform}&utm_medium=social&utm_campaign=${campaign}`;
}

function summaryFor(platform, copy, post) {
  const caption = (copy.captions && copy.captions[platform]) || (copy.captions && copy.captions.instagram) || '';
  if (platform === 'facebook') {
    // Links in Facebook text are clickable. Remove any "link in bio" sentence and append the real link.
    const clean = caption.replace(/[^.!?\n]*link in (the )?bio[^.!?\n]*[.!?]?/gi, '').replace(/\n{3,}/g, '\n\n').trim();
    return `${clean}\n\nBook direct: ${bookingUrl(post, 'facebook')}`;
  }
  if (platform === 'instagram' && Array.isArray(copy.hashtags) && copy.hashtags.length) {
    return `${caption}\n\n${copy.hashtags.map((h) => '#' + String(h).replace(/^#/, '')).join(' ')}`;
  }
  return caption;
}

/**
 * Create one GHL Social Planner draft per connected platform.
 * Accounts come from GHL_ACCOUNT_IDS, for example {"instagram":"...","facebook":"...","tiktok":"..."}.
 */
export async function createDrafts(post, mediaUrls) {
  const acc = accounts();
  const isVideo = post.media?.type === 'video';
  const type = post.format === 'reel' ? 'reel' : post.format === 'story' ? 'story' : 'post';
  const results = {};
  for (const [platform, accountId] of Object.entries(acc)) {
    if (platform === 'tiktok' && !isVideo) {
      results[platform] = { skipped: 'TikTok is only used for reels in this version' };
      continue;
    }
    const body = {
      accountIds: [accountId],
      summary: summaryFor(platform, post.copy, post),
      media: mediaUrls.map((url) => ({ url, type: isVideo ? 'video/mp4' : 'image/jpeg' })),
      status: 'draft',
      type,
      userId: process.env.GHL_USER_ID
    };
    try {
      const res = await fetch(`${BASE}/social-media-posting/${process.env.GHL_LOCATION_ID}/posts`, { method: 'POST', headers: headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
      const json = await res.json().catch(() => ({}));
      const id = json?.results?.post?._id || json?.results?.post?.id || json?.post?._id || json?.id || null;
      results[platform] = { ok: res.ok, status: res.status, id, response: res.ok ? undefined : json };
    } catch (e) {
      results[platform] = { ok: false, error: String(e.message || e) };
    }
  }
  return results;
}

/**
 * Set drafts to scheduled at a given time. GHL wants the complete post again on an edit
 * (accounts, media, text), not just the new status.
 */
export async function scheduleDrafts(post, scheduledForIso, mediaUrls) {
  const acc = accounts() || {};
  const isVideo = post.media?.type === 'video';
  const type = post.format === 'reel' ? 'reel' : post.format === 'story' ? 'story' : 'post';
  const results = {};
  for (const [platform, r] of Object.entries(post.ghl || {})) {
    if (!r || !r.id || !acc[platform]) continue;
    const body = {
      accountIds: [acc[platform]],
      summary: summaryFor(platform, post.copy, post),
      media: mediaUrls.map((url) => ({ url, type: isVideo ? 'video/mp4' : 'image/jpeg' })),
      status: 'scheduled',
      scheduleDate: scheduledForIso,
      type,
      userId: process.env.GHL_USER_ID
    };
    try {
      const res = await fetch(`${BASE}/social-media-posting/${process.env.GHL_LOCATION_ID}/posts/${r.id}`, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000)
      });
      const json = await res.json().catch(() => ({}));
      results[platform] = { ok: res.ok, status: res.status, response: res.ok ? undefined : json };
    } catch (e) {
      results[platform] = { ok: false, error: String(e.message || e) };
    }
  }
  return results;
}

/** Connected social accounts of the configured location, to find the ids for GHL_ACCOUNT_IDS. */
export async function listAccounts() {
  const res = await fetch(`${BASE}/social-media-posting/${process.env.GHL_LOCATION_ID}/accounts`, { headers: headers(), signal: AbortSignal.timeout(30000) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, status: res.status, response: json };
  const accounts = (json?.results?.accounts || []).map((a) => ({ id: a.id, platform: a.platform, type: a.type, name: a.name, active: a.active, expired: a.isExpired, ignore_messages: a.facebookIgnoreMessages, connection: a.connectionSource, missing_scopes: a.meta?.missingScopes, can_read_stats: a.hasStatisticsPermissions }));
  return { ok: true, accounts };
}

/** Users of the configured location, to find GHL_USER_ID. */
export async function listUsers() {
  const res = await fetch(`${BASE}/users/?locationId=${encodeURIComponent(process.env.GHL_LOCATION_ID)}`, { headers: headers(), signal: AbortSignal.timeout(30000) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, status: res.status, response: json };
  const users = (json?.users || []).map((u) => ({ id: u.id, name: u.name || [u.firstName, u.lastName].filter(Boolean).join(' '), email: u.email }));
  return { ok: true, users };
}

/** Analytics of the connected accounts from GHL (last 7 days against the 7 days before). Raw GHL answer inside data. */
export async function getStatistics() {
  const loc = process.env.GHL_LOCATION_ID;
  const accRes = await fetch(`${BASE}/social-media-posting/${loc}/accounts`, { headers: headers(), signal: AbortSignal.timeout(30000) });
  const accJson = await accRes.json().catch(() => ({}));
  if (!accRes.ok) return { ok: false, status: accRes.status, response: accJson };
  const accs = (accJson?.results?.accounts || []).filter((a) => a.active && !a.isExpired);
  const profileIds = [...new Set(accs.map((a) => a.profileId).filter(Boolean))];
  const platforms = [...new Set(accs.map((a) => a.platform).filter(Boolean))];
  if (!profileIds.length) return { ok: false, status: 404, response: { error: 'No active social accounts' } };
  const res = await fetch(`${BASE}/social-media-posting/statistics?locationId=${encodeURIComponent(loc)}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ profileIds, platforms }),
    signal: AbortSignal.timeout(60000)
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, platforms, data: res.ok ? data : undefined, response: res.ok ? undefined : data };
}
