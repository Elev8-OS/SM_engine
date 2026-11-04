import { q } from './db.js';

// Posts made by the tool (matched to one of our posts) against posts made by hand in Instagram (no match).
// Fair by design: only posts of at least 7 days (the numbers have settled), the same metrics in relative terms,
// compared inside one format, medians instead of means, and a verdict only with enough posts on both sides.
const DAY = 86400000;
export const MIN_PER_GROUP = 8;
export const MIN_AGE_DAYS = 7;

const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
const per1000 = (v, reach) => (reach > 0 && Number.isFinite(num(v)) ? (num(v) / reach) * 1000 : NaN);

export const METRICS = {
  reach: (r) => num(r.reach),
  views: (r) => num(r.views),
  engagementRate: (r) => (num(r.reach) > 0 ? (((num(r.likes) || 0) + (num(r.comments) || 0) + (num(r.saved) || 0) + (num(r.shares) || 0)) / num(r.reach)) * 100 : NaN),
  savesPer1000: (r) => per1000(r.saved, num(r.reach)),
  sharesPer1000: (r) => per1000(r.shares, num(r.reach)),
  profileVisitsPer1000: (r) => per1000(r.profile_visits, num(r.reach)),
  followsPer1000: (r) => per1000(r.follows, num(r.reach))
};

export const formatOf = (r) => (r.product_type === 'REELS' || r.media_type === 'VIDEO' ? 'reel' : 'post');

export function median(a) {
  const v = a.filter(Number.isFinite).sort((x, y) => x - y);
  if (!v.length) return null;
  const m = v.length / 2;
  return v.length % 2 ? v[Math.floor(m)] : (v[m - 1] + v[m]) / 2;
}

function normTail(z) {
  // upper tail of the standard normal for z >= 0 (Abramowitz and Stegun 26.2.17)
  const t = 1 / (1 + 0.2316419 * z);
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  return d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
}

/** Mann-Whitney U test, two sided, normal approximation with tie correction. Returns { p } or null. */
export function mannWhitney(a, b) {
  const n1 = a.length;
  const n2 = b.length;
  if (!n1 || !n2) return null;
  const all = [...a.map((v) => ({ v, g: 0 })), ...b.map((v) => ({ v, g: 1 }))].sort((x, y) => x.v - y.v);
  const N = all.length;
  const ranks = new Array(N);
  let tie = 0;
  for (let i = 0; i < N; ) {
    let j = i;
    while (j + 1 < N && all[j + 1].v === all[i].v) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = rank;
    const t = j - i + 1;
    tie += t * t * t - t;
    i = j + 1;
  }
  let r1 = 0;
  all.forEach((x, k) => {
    if (x.g === 0) r1 += ranks[k];
  });
  const u = r1 - (n1 * (n1 + 1)) / 2;
  const sigma = Math.sqrt(((n1 * n2) / 12) * (N + 1 - tie / (N * (N - 1))));
  if (!(sigma > 0)) return { p: 1 };
  const z = Math.max(0, Math.abs(u - (n1 * n2) / 2) - 0.5) / sigma;
  return { p: Math.min(1, 2 * normTail(z)) };
}

const iso = (ms) => (ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString().slice(0, 10));

/**
 * rows: one per post with posted_at, post_id (null = by hand), product_type, media_type and the numbers.
 * Returns, per format (all, reel, post), the medians of both groups, the gap, a p-value and a verdict:
 * too_few (under minPerGroup on one side), auto_better, manual_better, no_clear_difference (gap under 20% or p of 0.10 and more).
 */
export function compareCohorts(rows, { minPerGroup = MIN_PER_GROUP, now = Date.now() } = {}) {
  const usable = (rows || []).filter((r) => r.posted_at && now - Date.parse(r.posted_at) >= MIN_AGE_DAYS * DAY);
  const age = (r) => (now - Date.parse(r.posted_at)) / DAY;
  const groups = {};
  for (const fmt of ['reel', 'post', 'all']) {
    const subset = usable.filter((r) => fmt === 'all' || formatOf(r) === fmt);
    const auto = subset.filter((r) => r.post_id !== null && r.post_id !== undefined);
    const manual = subset.filter((r) => r.post_id === null || r.post_id === undefined);
    const metrics = Object.entries(METRICS).map(([key, get]) => {
      const a = auto.map(get).filter(Number.isFinite);
      const m = manual.map(get).filter(Number.isFinite);
      const ma = median(a);
      const mm = median(m);
      const diffPct = ma !== null && mm !== null && mm > 0 ? Math.round(((ma - mm) / mm) * 100) : null;
      let verdict = 'too_few';
      let p = null;
      if (a.length >= minPerGroup && m.length >= minPerGroup) {
        p = mannWhitney(a, m)?.p ?? null;
        if (diffPct === null || p === null) verdict = 'no_clear_difference';
        else if (p < 0.1 && diffPct >= 20) verdict = 'auto_better';
        else if (p < 0.1 && diffPct <= -20) verdict = 'manual_better';
        else verdict = 'no_clear_difference';
      }
      return { key, auto: ma === null ? null : Math.round(ma * 100) / 100, manual: mm === null ? null : Math.round(mm * 100) / 100, nAuto: a.length, nManual: m.length, diffPct, p: p === null ? null : Math.round(p * 1000) / 1000, verdict };
    });
    const t = (arr) => arr.map((r) => Date.parse(r.posted_at));
    const ta = t(auto);
    const tm = t(manual);
    const lo = (x) => (x.length ? Math.min(...x) : null);
    const hi = (x) => (x.length ? Math.max(...x) : null);
    const overlapMs = ta.length && tm.length ? Math.min(hi(ta), hi(tm)) - Math.max(lo(ta), lo(tm)) : null;
    groups[fmt] = {
      nAuto: auto.length,
      nManual: manual.length,
      medianAgeAuto: auto.length ? Math.round(median(auto.map(age))) : null,
      medianAgeManual: manual.length ? Math.round(median(manual.map(age))) : null,
      autoFrom: iso(lo(ta)),
      autoTo: iso(hi(ta)),
      manualFrom: iso(lo(tm)),
      manualTo: iso(hi(tm)),
      overlapDays: overlapMs === null ? null : Math.max(0, Math.round(overlapMs / DAY)),
      enough: auto.length >= minPerGroup && manual.length >= minPerGroup,
      mixed: fmt === 'all',
      metrics
    };
  }
  return { minPerGroup, minAgeDays: MIN_AGE_DAYS, groups };
}

/** How the drafts of the tool fared in the last 60 days: how many were made, approved and rejected. */
export async function processStats() {
  const rows = await q("select status, count(*)::int as n from posts where plan_date >= current_date - 60 group by status");
  const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  const n = (...k) => k.reduce((s, x) => s + (by[x] || 0), 0);
  const approved = n('approved', 'scheduled', 'published');
  const rejected = n('rejected');
  return { drafts: n('rendered', 'draft_created') + approved + rejected + n('failed'), approved, rejected, failed: n('failed'), waiting: n('rendered', 'draft_created'), approvalRate: approved + rejected ? Math.round((approved / (approved + rejected)) * 100) : null };
}

export async function sourceComparison({ days = 90 } = {}) {
  const d = Number(days) > 0 ? Number(days) : null;
  const rows = await q(
    `select i.media_id, i.post_id, i.posted_at, i.product_type, i.media_type,
            coalesce(s.reach, i.reach) as reach, coalesce(s.views, i.views) as views, coalesce(s.likes, i.likes) as likes,
            coalesce(s.comments, i.comments) as comments, coalesce(s.saved, i.saved) as saved, coalesce(s.shares, i.shares) as shares,
            coalesce(s.profile_visits, i.profile_visits) as profile_visits, coalesce(s.follows, i.follows) as follows
       from post_insights i left join post_insight_snapshots s on s.media_id = i.media_id and s.bucket_days = 7
      where ($1::int is null or i.posted_at >= now() - ($1::int * interval '1 day'))`,
    [d]
  );
  return { days: d ?? 0, ...compareCohorts(rows), process: await processStats() };
}

export function compareRoutes(app, needDb, ah) {
  app.get('/stats/compare', needDb, ah(async (req, res) => {
    const raw = String(req.query.days ?? '90').toLowerCase();
    const days = raw === 'alle' || raw === 'all' ? 0 : Number(raw);
    res.json(await sourceComparison({ days: Number.isFinite(days) ? days : 90 }));
  }));
}
