import { q, dbEnabled } from './db.js';
import { audienceRoutes } from './audience.js';

// Per-post Instagram numbers from the Meta Graph API (Instagram API with Facebook Login).
// Needs META_ACCESS_TOKEN and META_IG_USER_ID.
const VERSION = () => process.env.META_GRAPH_VERSION || 'v22.0';
const GRAPH = () => `https://graph.facebook.com/${VERSION()}`;
const STALE_MS = 60 * 60 * 1000;
const DAY = 86400000;
const MAX_MEDIA = () => Math.min(300, Number(process.env.META_SYNC_MAX) || 150);

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
  let m = {};
  for (const metrics of attempts) {
    try {
      m = metricMap(await graph(`${media.id}/insights`, { metric: metrics.join(',') }));
      break;
    } catch (e) {
      if (e.code === 190) throw e; // token problem: stop, do not retry smaller sets
    }
  }
  // Optional extras, each in its own call so one unsupported metric cannot take the main numbers down.
  const extras = ['profile_visits,follows'];
  if (isReel) extras.push('ig_reels_avg_watch_time');
  for (const metric of extras) {
    try {
      Object.assign(m, metricMap(await graph(`${media.id}/insights`, { metric })));
    } catch (e) {
      if (e.code === 190) throw e;
    }
  }
  return m;
}

/** Match an Instagram media item to one of our posts by the start of the caption. */
function matchPost(media, posts) {
  const cap = normalise(media.caption).slice(0, 50);
  if (!cap) return null;
  return posts.find((p) => normalise(p.copy?.captions?.instagram).slice(0, 50) === cap)?.id ?? null;
}

async function listMedia() {
  const out = [];
  let after;
  while (out.length < MAX_MEDIA()) {
    const page = await graph(`${process.env.META_IG_USER_ID}/media`, {
      fields: 'id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count,thumbnail_url,media_url',
      limit: '50',
      ...(after ? { after } : {})
    });
    out.push(...(page.data || []));
    after = page.paging?.cursors?.after;
    if (!page.paging?.next || !after) break;
  }
  return out.slice(0, MAX_MEDIA());
}

// Early snapshots (about 1, 3 and 7 days after posting) allow fair comparisons between posts of different age.
const SNAPSHOT_WINDOWS = [
  [1, 0.75, 2],
  [3, 2.5, 4.5],
  [7, 6.5, 10]
];

let lastError = null;
let lastSyncAt = null;

async function runSync() {
  const media = await listMedia();
  const posts = await q("select id, copy from posts where copy is not null and status in ('scheduled','published','approved','draft_created','rendered')");
  const known = new Map((await q('select media_id, synced_at from post_insights')).map((r) => [r.media_id, new Date(r.synced_at).getTime()]));
  let n = 0;
  for (let i = 0; i < media.length; i += 4) {
    const batch = media.slice(i, i + 4);
    const results = await Promise.all(
      batch.map((m) => {
        const age = (Date.now() - new Date(m.timestamp).getTime()) / DAY;
        // Old posts barely change: look at them once a day only.
        if (age >= 30 && known.has(m.id) && Date.now() - known.get(m.id) < DAY) return null;
        return insightsFor(m);
      })
    );
    for (let j = 0; j < batch.length; j++) {
      const m = batch[j];
      const x = results[j];
      if (!x) continue;
      await q(
        `insert into post_insights (media_id, post_id, permalink, media_type, product_type, caption, posted_at, views, reach, likes, comments, saved, shares, interactions, avg_watch_ms, profile_visits, follows, thumbnail, synced_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, now())
         on conflict (media_id) do update set post_id = excluded.post_id, permalink = excluded.permalink, media_type = excluded.media_type, product_type = excluded.product_type, caption = excluded.caption,
           posted_at = excluded.posted_at, views = excluded.views, reach = excluded.reach, likes = excluded.likes, comments = excluded.comments, saved = excluded.saved, shares = excluded.shares,
           interactions = excluded.interactions, avg_watch_ms = excluded.avg_watch_ms, profile_visits = excluded.profile_visits, follows = excluded.follows, thumbnail = excluded.thumbnail, synced_at = now()`,
        [m.id, matchPost(m, posts), m.permalink, m.media_type, m.media_product_type, m.caption || null, m.timestamp, x.views ?? null, x.reach ?? null, x.likes ?? m.like_count ?? null, x.comments ?? m.comments_count ?? null, x.saved ?? null, x.shares ?? null, x.total_interactions ?? null, x.ig_reels_avg_watch_time ?? null, x.profile_visits ?? null, x.follows ?? null, m.thumbnail_url || m.media_url || null]
      );
      const age = (Date.now() - new Date(m.timestamp).getTime()) / DAY;
      for (const [bucket, lo, hi] of SNAPSHOT_WINDOWS) {
        if (age >= lo && age < hi) {
          await q(
            `insert into post_insight_snapshots (media_id, bucket_days, views, reach, likes, comments, saved, shares, profile_visits, follows)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (media_id, bucket_days) do nothing`,
            [m.id, bucket, x.views ?? null, x.reach ?? null, x.likes ?? m.like_count ?? null, x.comments ?? m.comments_count ?? null, x.saved ?? null, x.shares ?? null, x.profile_visits ?? null, x.follows ?? null]
          );
        }
      }
      n++;
    }
  }
  return n;
}

let running = null;
/** One sync at a time. Never rejects: problems end up in lastError and are shown in the dashboard. */
function startSync() {
  running ??= runSync()
    .then(() => {
      lastError = null;
      lastSyncAt = Date.now();
    })
    .catch((e) => {
      lastError = { message: String(e.message || e).slice(0, 300), code: e.code ?? null, tokenExpired: e.code === 190 };
      console.error('Instagram insights sync failed:', lastError.message);
    })
    .finally(() => {
      running = null;
    });
  return running;
}

let tableReady = null;
export function ensureInsightsTable() {
  tableReady ??= (async () => {
    await q(`create table if not exists post_insights (
      media_id text primary key,
      post_id int references posts(id) on delete set null,
      permalink text, media_type text, product_type text, caption text, posted_at timestamptz,
      views int, reach int, likes int, comments int, saved int, shares int, interactions int, avg_watch_ms int,
      thumbnail text, synced_at timestamptz not null default now()
    )`);
    await q('alter table post_insights add column if not exists profile_visits int');
    await q('alter table post_insights add column if not exists follows int');
    await q(`create table if not exists post_insight_snapshots (
      media_id text not null references post_insights(media_id) on delete cascade,
      bucket_days int not null,
      taken_at timestamptz not null default now(),
      views int, reach int, likes int, comments int, saved int, shares int, profile_visits int, follows int,
      primary key (media_id, bucket_days)
    )`);
  })().catch((e) => {
    tableReady = null;
    throw e;
  });
  return tableReady;
}

/**
 * Stored per-post numbers. Refreshes from Meta on demand, or in the background when older than an hour
 * (the dashboard never waits for Meta once there is something to show).
 * days: only posts of the last N days (0 or null: everything).
 */
export async function postInsights({ refresh = false, days = 90, limit = 100 } = {}) {
  if (!metaConfigured()) return { configured: false, posts: [] };
  await ensureInsightsTable();
  const last = (await q('select max(synced_at) as t, count(*)::int as n from post_insights'))[0];
  const stale = !last.t || Date.now() - new Date(last.t).getTime() > STALE_MS;
  if (refresh || last.n === 0) await startSync();
  else if (stale) startSync();

  const d = Number(days) > 0 ? Number(days) : null;
  const lim = Math.min(300, Math.max(1, Number(limit) || 100));
  const rows = await q(
    `select i.*, p.format, p.pillar, p.property_key, p.plan_date,
            (select count(*)::int from clicks c where c.post_id = i.post_id and not c.is_bot) as clicks
       from post_insights i left join posts p on p.id = i.post_id
      where ($1::int is null or i.posted_at >= now() - ($1::int * interval '1 day'))
      order by i.posted_at desc nulls last limit $2`,
    [d, lim]
  );
  const total = (await q('select count(*)::int as n from post_insights where ($1::int is null or posted_at >= now() - ($1::int * interval \'1 day\'))', [d]))[0].n;
  const syncedAt = (await q('select max(synced_at) as t from post_insights'))[0]?.t ?? null;
  return {
    configured: true,
    syncedAt,
    refreshing: Boolean(running),
    error: lastError,
    days: d ?? 0,
    total,
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
        profileVisits: r.profile_visits,
        follows: r.follows,
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

/** Hourly refresh so early snapshots (1, 3, 7 days) are taken even when nobody opens the dashboard. */
function startScheduler() {
  if (globalThis.__insightsTimer || !metaConfigured() || !dbEnabled()) return;
  const tick = () => ensureInsightsTable().then(() => startSync()).catch((e) => console.error('Insights scheduler:', e.message));
  setTimeout(tick, 90 * 1000).unref();
  globalThis.__insightsTimer = setInterval(tick, STALE_MS);
  globalThis.__insightsTimer.unref();
}

// Analytics routes: per-post Instagram numbers, Meta account helper and the audience planner.
export function insightsRoutes(app, needDb, ah) {
  startScheduler();
  app.get('/stats/posts', needDb, ah(async (req, res) => {
    const raw = String(req.query.days ?? '90').toLowerCase();
    const days = raw === 'alle' || raw === 'all' ? 0 : Number(raw);
    res.json(await postInsights({ refresh: req.query.refresh === '1', days: Number.isFinite(days) ? days : 90, limit: req.query.limit }));
  }));
  audienceRoutes(app, needDb, ah);
  app.get('/stats/meta/accounts', ah(async (_req, res) => res.json(await metaAccounts())));
}
