import { q, dbEnabled } from './db.js';
import { HttpError } from './util.js';

// Competitor benchmark: public numbers of other providers' Instagram accounts, read with the Business Discovery
// feature of the Meta Graph API (needs META_ACCESS_TOKEN and META_IG_USER_ID, works for business and creator accounts only).
const VERSION = () => process.env.META_GRAPH_VERSION || 'v22.0';
export const metaReady = () => Boolean(process.env.META_ACCESS_TOKEN && process.env.META_IG_USER_ID);
const DAY = 86400000;

export const SEED = ['house_of_reservations', 'purahomesbali', 'rent.property.bali', 'sandaramanagement', 'mioestate'];

/** A handle from a plain name, an @name or a profile link (tracking parameters are ignored). */
export function parseHandle(input) {
  let s = String(input ?? '').replace(/[\u2060\u200b\u200e\u200f]/g, '').trim();
  if (!s) return null;
  const m = s.match(/instagram\.com\/([A-Za-z0-9._]+)/i);
  if (m) s = m[1];
  s = s.replace(/^@/, '').replace(/[/?#].*$/, '').toLowerCase();
  return /^[a-z0-9._]{1,30}$/.test(s) ? s : null;
}

const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

/** Numbers from one Business Discovery answer. Media come newest first. */
export function summarise(bd, now = Date.now()) {
  const media = (bd?.media?.data || []).filter((m) => m.timestamp);
  const followers = Number(bd?.followers_count) || null;
  const recent = media.filter((m) => now - Date.parse(m.timestamp) <= 30 * DAY);
  const last = media.slice(0, 12);
  const nums = (arr, k) => arr.map((m) => m[k]).filter((v) => Number.isFinite(v));
  const likes = avg(nums(last, 'like_count'));
  const comments = avg(nums(last, 'comments_count'));
  const eng = followers && (likes != null || comments != null) ? (((likes || 0) + (comments || 0)) / followers) * 100 : null;
  const isReel = (m) => m.media_product_type === 'REELS' || m.media_type === 'VIDEO';
  const top = [...media]
    .sort((a, b) => (b.like_count || 0) + (b.comments_count || 0) * 3 - ((a.like_count || 0) + (a.comments_count || 0) * 3))
    .slice(0, 3)
    .map((m) => ({ permalink: m.permalink || null, likes: m.like_count ?? null, comments: m.comments_count ?? null, reel: isReel(m), caption: String(m.caption || '').replace(/\s+/g, ' ').slice(0, 140), postedAt: m.timestamp }));
  return {
    followers,
    media_count: Number.isFinite(Number(bd?.media_count)) ? Number(bd.media_count) : null,
    posts_30d: recent.length,
    posts_per_week: r1(recent.length / (30 / 7)),
    avg_likes: r1(likes),
    avg_comments: r1(comments),
    engagement_pct: r2(eng),
    reel_share_pct: media.length ? Math.round((media.filter(isReel).length / media.length) * 100) : null,
    top
  };
}

/** Is a Graph error "this account cannot be read" (private, personal or unknown) rather than a real fault? */
export function unreadable(err) {
  if (!err || err.code === 190) return false;
  return /business|creator|not exist|does not exist|invalid user|cannot be|unsupported|private/i.test(String(err.message || '')) || [110, 100, 2207013].includes(err.code);
}

// ---- Our own account, measured the same way ----

async function graphGet(path, params = {}) {
  const url = new URL(`https://graph.facebook.com/${VERSION()}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('access_token', process.env.META_ACCESS_TOKEN);
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error?.message || `Meta ${res.status}`);
  return json;
}

let ownCache = null;
/**
 * Our Instagram account with the same definitions as the competitors: followers from Meta, the last 30 posts
 * from the stored post numbers. Cached for 30 minutes. Returns { error } when it cannot be read.
 */
export async function ownSnapshot(now = Date.now()) {
  if (!metaReady()) return null;
  if (ownCache && now - ownCache.at < 30 * 60 * 1000) return ownCache.value;
  let value;
  try {
    const acc = await graphGet(process.env.META_IG_USER_ID, { fields: 'username,followers_count,media_count' });
    let rows = [];
    try {
      rows = await q('select posted_at, likes, comments, media_type, product_type, permalink, caption from post_insights where posted_at is not null order by posted_at desc limit 30');
    } catch {
      rows = []; // the post numbers table does not exist before the first insights sync
    }
    const bd = {
      followers_count: acc.followers_count,
      media_count: acc.media_count,
      media: { data: rows.map((r) => ({ timestamp: new Date(r.posted_at).toISOString(), like_count: r.likes, comments_count: r.comments, media_type: r.media_type, media_product_type: r.product_type, permalink: r.permalink, caption: r.caption })) }
    };
    value = { handle: acc.username || null, ...summarise(bd, now) };
  } catch (e) {
    value = { error: String(e.message || e).slice(0, 200) };
  }
  ownCache = { at: now, value };
  return value;
}

const METRICS = {
  followers: (x) => x.followers,
  postsPerWeek: (x) => x.postsPerWeek ?? x.posts_per_week,
  avgLikes: (x) => x.avgLikes ?? x.avg_likes,
  avgComments: (x) => x.avgComments ?? x.avg_comments,
  engagementPct: (x) => x.engagementPct ?? x.engagement_pct,
  reelSharePct: (x) => x.reelSharePct ?? x.reel_share_pct
};
const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));

/**
 * Where we stand against the readable competitors: per metric our value, the median, the best account, our rank and the gap to the median.
 * "better" and "worse" mean more than 10 percent above or below the median.
 */
export function compare(self, competitors) {
  const ok = (competitors || []).filter((c) => c.status === 'ok');
  const rows = [];
  for (const [key, get] of Object.entries(METRICS)) {
    const ours = self && !self.error ? num(get(self)) : NaN;
    const others = ok.map((c) => ({ handle: c.handle, v: num(get(c)) })).filter((o) => Number.isFinite(o.v));
    if (!others.length) {
      rows.push({ key, ours: Number.isFinite(ours) ? ours : null, median: null, best: null, bestHandle: null, rank: null, of: 0, diffPct: null, verdict: 'unknown' });
      continue;
    }
    const vals = others.map((o) => o.v).sort((a, b) => a - b);
    const mid = vals.length / 2;
    const median = vals.length % 2 ? vals[Math.floor(mid)] : (vals[mid - 1] + vals[mid]) / 2;
    const best = others.reduce((a, b) => (b.v > a.v ? b : a));
    let diffPct = null;
    let verdict = 'unknown';
    if (Number.isFinite(ours)) {
      diffPct = median > 0 ? Math.round(((ours - median) / median) * 100) : null;
      verdict = diffPct === null ? (ours > 0 ? 'better' : 'similar') : diffPct >= 10 ? 'better' : diffPct <= -10 ? 'worse' : 'similar';
    }
    rows.push({
      key,
      ours: Number.isFinite(ours) ? ours : null,
      median: Math.round(median * 100) / 100,
      best: best.v,
      bestHandle: best.handle,
      rank: Number.isFinite(ours) ? 1 + others.filter((o) => o.v > ours).length : null,
      of: others.length + 1,
      diffPct,
      verdict
    });
  }
  const count = (v) => rows.filter((r) => r.verdict === v).length;
  return { readable: ok.length, rows, summary: { better: count('better'), worse: count('worse'), similar: count('similar') } };
}

async function fetchBusinessDiscovery(handle, fetchFn = fetch) {
  const fields = `business_discovery.username(${handle}){username,name,followers_count,media_count,media.limit(30){timestamp,like_count,comments_count,media_type,media_product_type,permalink,caption}}`;
  const url = new URL(`https://graph.facebook.com/${VERSION()}/${process.env.META_IG_USER_ID}`);
  url.searchParams.set('fields', fields);
  url.searchParams.set('access_token', process.env.META_ACCESS_TOKEN);
  const res = await fetchFn(url, { signal: AbortSignal.timeout(30000) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const e = new Error(json.error?.message || `Meta ${res.status}`);
    e.code = json.error?.code ?? null;
    throw e;
  }
  return json.business_discovery || null;
}

let ready = null;
export function ensureCompetitorTable() {
  ready ??= (async () => {
    const fresh = (await q("select to_regclass('public.competitors') as t"))[0].t === null;
    await q(`create table if not exists competitors (
      handle text primary key,
      added_at timestamptz not null default now(),
      checked_at timestamptz,
      status text not null default 'new',
      error text,
      name text,
      followers int,
      media_count int,
      posts_30d int,
      posts_per_week numeric,
      avg_likes numeric,
      avg_comments numeric,
      engagement_pct numeric,
      reel_share_pct int,
      top jsonb
    )`);
    if (fresh) for (const h of SEED) await q('insert into competitors (handle) values ($1) on conflict do nothing', [h]);
  })().catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}

/** Reads one account and stores the result. Never throws: the outcome is the status of the row. */
export async function checkOne(handle, fetchFn = fetch) {
  try {
    const bd = await fetchBusinessDiscovery(handle, fetchFn);
    if (!bd) throw Object.assign(new Error('The account returned no data'), { code: 110 });
    const s = summarise(bd);
    await q(
      `update competitors set checked_at = now(), status = 'ok', error = null, name = $2, followers = $3, media_count = $4, posts_30d = $5, posts_per_week = $6,
         avg_likes = $7, avg_comments = $8, engagement_pct = $9, reel_share_pct = $10, top = $11 where handle = $1`,
      [handle, bd.name || null, s.followers, s.media_count, s.posts_30d, s.posts_per_week, s.avg_likes, s.avg_comments, s.engagement_pct, s.reel_share_pct, JSON.stringify(s.top)]
    );
    return 'ok';
  } catch (e) {
    const status = unreadable(e) ? 'not_readable' : 'error';
    await q('update competitors set checked_at = now(), status = $2, error = $3 where handle = $1', [handle, status, String(e.message || e).slice(0, 300)]);
    return status;
  }
}

let running = null;
/** Checks all accounts (or those older than maxAgeHours), one after the other, so the rate limit is respected. */
export function checkAll({ maxAgeHours = 0 } = {}) {
  running ??= (async () => {
    await ensureCompetitorTable();
    const rows = await q('select handle from competitors where $1::int = 0 or checked_at is null or checked_at < now() - ($1::int * interval \'1 hour\') order by handle', [maxAgeHours]);
    for (const r of rows) {
      await checkOne(r.handle);
      await new Promise((ok) => setTimeout(ok, 1500));
    }
    return rows.length;
  })().finally(() => {
    running = null;
  });
  return running;
}

function scheduler() {
  if (globalThis.__competitorTimer || !metaReady() || !dbEnabled()) return;
  const tick = () => checkAll({ maxAgeHours: 24 }).catch((e) => console.error('Competitor check:', e.message));
  setTimeout(tick, 5 * 60 * 1000).unref();
  globalThis.__competitorTimer = setInterval(tick, 6 * 3600 * 1000);
  globalThis.__competitorTimer.unref();
}

const view = (r) => ({
  handle: r.handle,
  name: r.name,
  status: r.status,
  error: r.error,
  checkedAt: r.checked_at,
  followers: r.followers,
  mediaCount: r.media_count,
  posts30d: r.posts_30d,
  postsPerWeek: r.posts_per_week == null ? null : Number(r.posts_per_week),
  avgLikes: r.avg_likes == null ? null : Number(r.avg_likes),
  avgComments: r.avg_comments == null ? null : Number(r.avg_comments),
  engagementPct: r.engagement_pct == null ? null : Number(r.engagement_pct),
  reelSharePct: r.reel_share_pct,
  top: r.top || []
});

export function competitorRoutes(app, needDb, ah) {
  scheduler();
  app.get('/competitors', needDb, ah(async (_req, res) => {
    await ensureCompetitorTable();
    const rows = await q('select * from competitors order by followers desc nulls last, handle');
    const competitors = rows.map(view);
    const self = await ownSnapshot();
    res.json({ configured: metaReady(), checking: Boolean(running), competitors, self, comparison: compare(self, competitors) });
  }));
  app.post('/competitors', needDb, ah(async (req, res) => {
    await ensureCompetitorTable();
    const handle = parseHandle(req.body?.handle);
    if (!handle) throw new HttpError(400, 'Enter an Instagram name or profile link');
    await q('insert into competitors (handle) values ($1) on conflict do nothing', [handle]);
    if (metaReady()) await checkOne(handle);
    const [row] = await q('select * from competitors where handle = $1', [handle]);
    res.status(201).json(view(row));
  }));
  // Starts a check of all accounts in the background and answers at once
  app.post('/competitors/refresh', needDb, ah(async (_req, res) => {
    if (!metaReady()) throw new HttpError(409, 'META_ACCESS_TOKEN and META_IG_USER_ID are not set');
    checkAll().catch((e) => console.error('Competitor check:', e.message));
    res.json({ started: true });
  }));
  app.delete('/competitors/:handle', needDb, ah(async (req, res) => {
    await ensureCompetitorTable();
    const handle = parseHandle(req.params.handle);
    if (handle) await q('delete from competitors where handle = $1', [handle]);
    res.json({ handle, deleted: true });
  }));
}
