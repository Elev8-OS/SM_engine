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

function summaryFor(platform, copy) {
  const caption = (copy.captions && copy.captions[platform]) || (copy.captions && copy.captions.instagram) || '';
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
      summary: summaryFor(platform, post.copy),
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

/** Set drafts to scheduled at a given time. Edits each stored GHL post. */
export async function scheduleDrafts(post, scheduledForIso) {
  const results = {};
  for (const [platform, r] of Object.entries(post.ghl || {})) {
    if (!r || !r.id) continue;
    const type = post.format === 'reel' ? 'reel' : post.format === 'story' ? 'story' : 'post';
    try {
      const res = await fetch(`${BASE}/social-media-posting/${process.env.GHL_LOCATION_ID}/posts/${r.id}`, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify({ status: 'scheduled', scheduleDate: scheduledForIso, type, userId: process.env.GHL_USER_ID }),
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
