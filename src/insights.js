import { q } from './db.js';
import { audienceRoutes } from './audience.js';

// Per-post Instagram numbers from the Meta Graph API (Instagram API with Facebook Login).
// Needs META_ACCESS_TOKEN (a Page access token) and META_IG_USER_ID (the Instagram business account id).
const VERSION = () => process.env.META_GRAPH_VERSION || 'v22.0';
const GRAPH = () => `https://graph.facebook.com/${VERSION()}`;
const STALE_MS = 60 * 60 * 1000;

export const metaConfigured = () => Boolean(process.env.META_ACCESS_TOKEN && process.env.META_IG_USER_ID);

export class MetaError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function graph(path, params = {}) {
  const url = new URL(`${GRAPH()}/${path.replace(/^\//, '')}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('access_token', process.env.META_ACCESS_TOKEN);
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const e = json.error || {};
    throw new MetaError(e.message || `Meta ${res.status}`, e.code, res.status);
  }
  return json;
}

const normalise = (s) => String(s || '').toLowerCase().replace(/#\S+/g, ' ').replace(/[^a-z0-9äöüéèà]+/gi, ' ').trim();

/** Metric values come back either as values[0].value or total_value.value. */
function metricMap(data) {
  const out = {};
  for (const m of data?.data || []) out[m.name] = m.values?.[0]?.value ?? m.total_value?.value ?? null;
  return out;
}

async function insightsFor(media) {
  const isReel = media.media_product_type === 'REELS';
  const attempts = [
    ['reach', 'views', 'saved', 'shares', 'total_interactions', 'likes', 'comments'],
    ['reach', 'saved', 'shares', 'total_interactions'],
    ['reach']
  ];
  for (const metrics of attempts) {
    try {
      const m = metricMap(await graph(`${media.id}/insights`, { metric: metrics.join(',') }));
      if (isReel) {
        try {
          Object.assign(m, metricMap(await graph(`${media.id}/insights`, { metric: 'ig_reels_avg_watch_time' })));
        } catch {
          /* optional */
        }
      }
      return m;
    } catch (e) {
      if (e.code === 190) throw e; // token problem: stop, do not retry smaller sets
    }
  }
  return {};
}

/** Match an Instagram media item to one of our posts by the start of the caption. */
function matchPost(media, posts) {
  const cap = normalise(media.caption).slice(0, 50);
  if (!cap) return null;
  return posts.find((p) => normalise(p.copy?.captions?.instagram).slice(0, 50) === cap)?.id ?? null;
}

let running = null;

async function runSync() {
  const list = await graph(`${process.env.META_IG_USER_ID}/media`, {
    fields: 'id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count,thumbnail_url,media_url',
    limit: '40'
  });
  const media = list.data || [];
  const posts = await q("select id, copy from posts where copy is not null and status in ('scheduled','published','approved','draft_created','rendered')");
  let n = 0;
  for (let i = 0; i < media.length; i += 4) {
    const batch = media.slice(i, i + 4);
    const results = await Promise.all(batch.map((m) => insightsFor(m)));
    for (let j = 0; j < batch.length; j++) {
      const m = batch[j];
      const x = results[j];
      await q(
        `insert into post_insights (media_id, post_id, permalink, media_type, product_type, caption, posted_at, views, reach, likes, comments, saved, shares, interactions, avg_watch_ms, thumbnail, synced_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())
         on conflict (media_id) do update set post_id = excluded.post_id, permalink = excluded.permalink, media_type = excluded.media_type, product_type = excluded.product_type, caption = excluded.caption,
           posted_at = excluded.posted_at, views = excluded.views, reach = excluded.reach, likes = excluded.likes, comments = excluded.comments, saved = excluded.saved, shares = excluded.shares,
           interactions = excluded.interactions, avg_watch_ms = excluded.avg_watch_ms, thumbnail = excluded.thumbnail, synced_at = now()`,
        [m.id, matchPost(m, posts), m.permalink, m.media_type, m.media_product_type, m.caption || null, m.timestamp, x.views ?? null, x.reach ?? null, x.likes ?? m.like_count ?? null, x.comments ?? m.comments_count ?? null, x.saved ?? null, x.shares ?? null, x.total_interactions ?? null, x.ig_reels_avg_watch_time ?? null, m.thumbnail_url || m.media_url || null]
      );
      n++;
    }
  }
  return n;
}

let tableReady = null;
export function ensureInsightsTable() {
  tableReady ??= q(`create table if not exists post_insights (
    media_id text primary key,
    post_id int references posts(id) on delete set null,
    permalink text, media_type text, product_type text, caption text, posted_at timestamptz,
    views int, reach int, likes int, comments int, saved int, shares int, interactions int, avg_watch_ms int,
    thumbnail text, synced_at timestamptz not null default now()
  )`).catch((e) => {
    tableReady = null;
    throw e;
  });
  return tableReady;
}

/** Returns the stored per-post numbers, refreshing from Meta when they are older than an hour (or on demand). */
export async function postInsights({ refresh = false } = {}) {
  if (!metaConfigured()) return { configured: false, posts: [] };
  await ensureInsightsTable();
  let error = null;
  const last = (await q('select max(synced_at) as t from post_insights'))[0]?.t;
  const stale = !last || Date.now() - new Date(last).getTime() > STALE_MS;
  if (refresh || stale) {
    try {
      running ??= runSync().finally(() => {
        running = null;
      });
      await running;
    } catch (e) {
      error = { message: String(e.message || e).slice(0, 300), code: e.code ?? null, tokenExpired: e.code === 190 };
    }
  }
  const rows = await q(
    `select i.*, p.format, p.pillar, p.property_key, p.plan_date,
            (select count(*)::int from clicks c where c.post_id = i.post_id and not c.is_bot) as clicks
       from post_insights i left join posts p on p.id = i.post_id
      order by i.posted_at desc nulls last limit 60`
  );
  const syncedAt = (await q('select max(synced_at) as t from post_insights'))[0]?.t ?? null;
  return {
    configured: true,
    syncedAt,
    error,
    posts: rows.map((r) => {
      const eng = (r.likes || 0) + (r.comments || 0) + (r.saved || 0) + (r.shares || 0);
      return {
        mediaId: r.media_id,
        permalink: r.permalink,
        type: r.product_type || r.media_type,
        caption: r.caption,
        postedAt: r.posted_at,
        views: r.views,
        reach: r.reach,
        likes: r.likes,
        comments: r.comments,
        saved: r.saved,
        shares: r.shares,
        interactions: r.interactions,
        avgWatchSeconds: r.avg_watch_ms ? Math.round(r.avg_watch_ms / 100) / 10 : null,
        engagementRate: r.reach ? Math.round((eng / r.reach) * 1000) / 10 : null,
        thumbnail: r.thumbnail,
        postId: r.post_id,
        format: r.format,
        pillar: r.pillar,
        villa: r.property_key,
        clicks: r.clicks ?? 0
      };
    })
  };
}

/** Helps to find META_IG_USER_ID: lists the Instagram business accounts the token can see. */
export async function metaAccounts() {
  if (!process.env.META_ACCESS_TOKEN) return { ok: false, error: 'META_ACCESS_TOKEN is not set' };
  try {
    const pages = await graph('me/accounts', { fields: 'name,instagram_business_account{id,username}' });
    return { ok: true, pages: (pages.data || []).map((p) => ({ page: p.name, instagram_id: p.instagram_business_account?.id || null, username: p.instagram_business_account?.username || null })) };
  } catch (e1) {
    try {
      const me = await graph('me', { fields: 'id,name,instagram_business_account{id,username}' });
      return { ok: true, pages: [{ page: me.name, instagram_id: me.instagram_business_account?.id || null, username: me.instagram_business_account?.username || null }] };
    } catch (e2) {
      return { ok: false, error: String(e2.message || e1.message).slice(0, 300), code: e2.code ?? e1.code ?? null };
    }
  }
}

// Analytics routes: per-post Instagram numbers, Meta account helper and the audience planner.
export function insightsRoutes(app, needDb, ah) {
  app.get('/stats/posts', needDb, ah(async (req, res) => res.json(await postInsights({ refresh: req.query.refresh === '1' }))));
  audienceRoutes(app, needDb, ah);
  app.get('/stats/meta/accounts', ah(async (_req, res) => res.json(await metaAccounts())));
}
