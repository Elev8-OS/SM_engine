import { q } from './db.js';
import { HttpError } from './util.js';

// Learnings: compares our posts by format, caption style and timing and proposes changes.
// Nothing is applied without approval in Orbit. Evidence is weak with small samples, so the rules are strict.

const DAY = 86400000;

// How much each signal counts (agreed order: clicks, follows and profile visits, saves and shares, reach, likes).
export const WEIGHTS = { click: 10, follow: 6, profileVisit: 3, save: 3, share: 3, comment: 1.5, reach: 0.03, like: 0.3 };
const MIN_AGE_DAYS = 7; // younger posts are still growing
const MIN_ELIGIBLE = 12; // posts needed before anything is proposed
const MIN_GROUP = 5; // posts per side of a comparison
const MAX_NEW = 3; // proposals per run
const CLICKS_MIN_TOTAL = 20; // clicks only count once the bio link has produced enough of them
const RECENT_DISMISS_DAYS = 60;
const RERUN_MS = 6 * 3600 * 1000;

// Rules handed to the copywriter once accepted. English, because the prompt is English.
export const COPY_RULES = {
  question_open: 'Where it feels natural, open the Instagram caption with a question to the reader. Our own results show this works better for us.',
  no_question_open: 'Do not open the Instagram caption with a question. Our own results show a scene opening works better for us.',
  short_caption: 'Keep the Instagram caption compact: about two short paragraphs and under 300 characters in total. Our own results show shorter captions work better for us.',
  long_caption: 'Write the Instagram caption fuller: three to four paragraphs and at least 450 characters. Our own results show longer captions work better for us.'
};
const OPPOSITE = { question_open: 'no_question_open', no_question_open: 'question_open', short_caption: 'long_caption', long_caption: 'short_caption' };
const HOUR_OF = { morning: 9, midday: 12, afternoon: 16, evening: 19 }; // Bali time

let ready = null;
export function ensureLearningsTables() {
  ready ??= (async () => {
    await q(`create table if not exists learnings (
      id serial primary key,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      key text not null, dimension text not null, value text not null, direction text not null,
      confidence text not null, stats jsonb not null, action jsonb not null,
      status text not null default 'proposed', decided_at timestamptz
    )`);
    await q("create unique index if not exists learnings_live on learnings (key) where status in ('proposed','accepted')");
    await q('create table if not exists learning_runs (id serial primary key, ran_at timestamptz not null default now(), summary jsonb not null)');
  })().catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hashSeed = (s) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);

/** Permutation test on the difference of medians. Seeded, so repeated runs give the same answer. */
export function permutationP(a, b, seed) {
  const all = [...a, ...b];
  const obs = Math.abs(median(a) - median(b));
  const rnd = mulberry32(seed);
  const N = 4000;
  let ge = 0;
  for (let i = 0; i < N; i++) {
    for (let j = all.length - 1; j > 0; j--) {
      const k = Math.floor(rnd() * (j + 1));
      [all[j], all[k]] = [all[k], all[j]];
    }
    if (Math.abs(median(all.slice(0, a.length)) - median(all.slice(a.length))) >= obs - 1e-9) ge++;
  }
  return (ge + 1) / (N + 1);
}

export function scoreOf(m, clicksMode) {
  return (
    WEIGHTS.follow * (m.follows || 0) +
    WEIGHTS.profileVisit * (m.profileVisits || 0) +
    WEIGHTS.save * (m.saved || 0) +
    WEIGHTS.share * (m.shares || 0) +
    WEIGHTS.comment * (m.comments || 0) +
    WEIGHTS.reach * (m.reach || 0) +
    WEIGHTS.like * (m.likes || 0) +
    (clicksMode ? WEIGHTS.click * (m.clicks || 0) : 0)
  );
}

const firstLine = (c) => String(c || '').split('\n').map((l) => l.trim()).find(Boolean) || '';

export function featuresOf(r) {
  const bali = new Date(new Date(r.posted_at).getTime() + 8 * 3600 * 1000);
  const hour = bali.getUTCHours();
  const dow = bali.getUTCDay();
  const caption = String(r.caption || '');
  const bare = caption.replace(/#\S+/g, '').trim();
  const first = firstLine(caption);
  const tags = (caption.match(/#\w+/g) || []).length;
  const format = r.format || (r.product_type === 'REELS' ? 'reel' : r.media_type === 'CAROUSEL_ALBUM' ? 'carousel' : 'single');
  return {
    format,
    pillar: r.pillar || null,
    villa: r.property_key || null,
    source: r.post_id != null ? 'engine' : 'manual',
    weekend: dow === 0 || dow === 6 ? 'yes' : 'no',
    hour: hour < 11 ? 'morning' : hour < 15 ? 'midday' : hour < 19 ? 'afternoon' : 'evening',
    question: /\?/.test(first) ? 'yes' : 'no',
    emoji: /\p{Extended_Pictographic}/u.test(first) ? 'yes' : 'no',
    captionLength: bare.length < 300 ? 'short' : bare.length <= 600 ? 'medium' : 'long',
    hashtags: tags <= 5 ? 'few' : tags <= 10 ? 'normal' : 'many'
  };
}

// engineOnly: the feature only exists for posts made by the engine. onlyValues: evaluate just these values (yes/no pairs are mirrors).
const DIMENSIONS = [
  { dimension: 'format' },
  { dimension: 'captionLength' },
  { dimension: 'question', onlyValues: ['yes'] },
  { dimension: 'emoji', onlyValues: ['yes'] },
  { dimension: 'hour' },
  { dimension: 'weekend', onlyValues: ['yes'] },
  { dimension: 'hashtags' },
  { dimension: 'source', onlyValues: ['engine'] },
  { dimension: 'pillar', engineOnly: true },
  { dimension: 'villa', engineOnly: true }
];

export function actionFor(dimension, value, direction) {
  if (dimension === 'question') return { type: 'copy_rule', key: direction === 'more' ? 'question_open' : 'no_question_open' };
  if (dimension === 'captionLength' && direction === 'more' && value === 'short') return { type: 'copy_rule', key: 'short_caption' };
  if (dimension === 'captionLength' && direction === 'more' && value === 'long') return { type: 'copy_rule', key: 'long_caption' };
  if (dimension === 'hour' && direction === 'more') return { type: 'post_hour', hour: HOUR_OF[value] };
  return { type: 'info' };
}

/**
 * Pure comparison step, kept separate so it can be tested without a database.
 * Many comparisons are made at once, so some "wins" appear by chance. The p-values are therefore corrected:
 * "solid" needs p x number of tests below 0.05 (Bonferroni), "tentative" passes a false-discovery-rate limit of 10 % (Benjamini-Hochberg).
 */
export function findPatterns(posts, { minGroup = MIN_GROUP } = {}) {
  const tests = [];
  for (const def of DIMENSIONS) {
    const pool = def.engineOnly ? posts.filter((p) => p.f.source === 'engine') : posts;
    const values = [...new Set(pool.map((p) => p.f[def.dimension]).filter(Boolean))];
    for (const value of values) {
      if (def.onlyValues && !def.onlyValues.includes(value)) continue;
      const a = pool.filter((p) => p.f[def.dimension] === value).map((p) => p.score);
      const b = pool.filter((p) => p.f[def.dimension] !== value).map((p) => p.score);
      if (a.length < minGroup || b.length < minGroup) continue;
      const ma = median(a);
      const mb = median(b);
      tests.push({ def, value, a, b, ma, mb, ratio: ma / Math.max(mb, 1), direction: ma > mb ? 'more' : 'less', p: permutationP(a, b, hashSeed(`${def.dimension}:${value}`)) });
    }
  }
  const m = tests.length;
  const ranked = [...tests].sort((x, y) => x.p - y.p);
  let bhCut = 0;
  ranked.forEach((t, i) => {
    if (t.p <= ((i + 1) / m) * 0.1) bhCut = i + 1;
  });
  const passing = new Set(ranked.slice(0, bhCut));
  const found = [];
  for (const t of tests) {
    if (!passing.has(t) || !(t.ratio >= 1.4 || t.ratio <= 0.7)) continue;
    found.push({
      key: `${t.def.dimension}:${t.value}:${t.direction}`,
      dimension: t.def.dimension,
      value: t.value,
      direction: t.direction,
      confidence: t.p * m < 0.05 ? 'solid' : 'tentative',
      stats: { n: t.a.length, nRest: t.b.length, median: Math.round(t.ma * 10) / 10, medianRest: Math.round(t.mb * 10) / 10, ratio: Math.round(t.ratio * 100) / 100, p: Math.round(t.p * 10000) / 10000, tests: m },
      action: actionFor(t.def.dimension, t.value, t.direction)
    });
  }
  found.sort((x, y) => Math.abs(Math.log(y.stats.ratio)) - Math.abs(Math.log(x.stats.ratio)));
  return { found, tested: m };
}

async function loadPosts() {
  const rows = await q(
    `select i.media_id, i.post_id, i.product_type, i.media_type, i.caption, i.posted_at,
            i.reach, i.likes, i.comments, i.saved, i.shares, i.profile_visits, i.follows,
            p.format, p.pillar, p.property_key,
            (select count(*)::int from clicks c where c.post_id = i.post_id and not c.is_bot) as clicks,
            s.reach as s_reach, s.likes as s_likes, s.comments as s_comments, s.saved as s_saved, s.shares as s_shares, s.profile_visits as s_pv, s.follows as s_follows
       from post_insights i
       left join posts p on p.id = i.post_id
       left join post_insight_snapshots s on s.media_id = i.media_id and s.bucket_days = 7
      where i.posted_at is not null`
  );
  return rows.map((r) => {
    const snap = r.s_reach != null;
    const m = snap
      ? { reach: r.s_reach, likes: r.s_likes, comments: r.s_comments, saved: r.s_saved, shares: r.s_shares, profileVisits: r.s_pv, follows: r.s_follows }
      : { reach: r.reach, likes: r.likes, comments: r.comments, saved: r.saved, shares: r.shares, profileVisits: r.profile_visits, follows: r.follows };
    return { r, m: { ...m, clicks: r.clicks }, age: (Date.now() - new Date(r.posted_at).getTime()) / DAY };
  });
}

export async function runAnalysis() {
  await ensureLearningsTables();
  const all = await loadPosts();
  const eligible = all.filter((x) => x.age >= MIN_AGE_DAYS);
  const totalClicks = all.reduce((a, x) => a + (x.r.post_id != null ? x.m.clicks || 0 : 0), 0);
  const clicksMode = totalClicks >= CLICKS_MIN_TOTAL;
  // With clicks in the score only engine posts are comparable, manual posts have no tracked link.
  const pool = (clicksMode ? eligible.filter((x) => x.r.post_id != null) : eligible).map((x) => ({ f: featuresOf(x.r), score: scoreOf(x.m, clicksMode) }));
  const enough = pool.length >= MIN_ELIGIBLE;
  let found = [];
  let tested = 0;
  if (enough) ({ found, tested } = findPatterns(pool));

  const live = new Map((await q("select * from learnings where status in ('proposed','accepted')")).map((l) => [l.key, l]));
  const recentDismissed = new Set((await q(`select key from learnings where status = 'dismissed' and decided_at > now() - interval '${RECENT_DISMISS_DAYS} days'`)).map((l) => l.key));
  const fresh = [];
  for (const f of found) {
    const existing = live.get(f.key);
    if (existing) await q('update learnings set stats = $2, confidence = $3, updated_at = now() where id = $1', [existing.id, f.stats, f.confidence]);
    else if (!recentDismissed.has(f.key)) fresh.push(f);
  }
  for (const f of fresh.slice(0, MAX_NEW)) {
    await q('insert into learnings (key, dimension, value, direction, confidence, stats, action) values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing', [f.key, f.dimension, f.value, f.direction, f.confidence, f.stats, f.action]);
  }
  const foundKeys = new Set(found.map((f) => f.key));
  for (const [key, l] of live) if (l.status === 'proposed' && !foundKeys.has(key)) await q("update learnings set status = 'expired', updated_at = now() where id = $1", [l.id]);

  const summary = { posts: all.length, eligible: pool.length, needMore: Math.max(0, MIN_ELIGIBLE - pool.length), enough, tested, found: found.length, newProposals: Math.min(fresh.length, MAX_NEW), clicksMode, totalClicks, minAgeDays: MIN_AGE_DAYS, minGroup: MIN_GROUP, weights: WEIGHTS };
  await q('insert into learning_runs (summary) values ($1)', [summary]);
  return summary;
}

/** Called after each Instagram sync: runs the analysis at most every 6 hours. */
export async function maybeAnalyse() {
  await ensureLearningsTables();
  const last = (await q('select max(ran_at) as t from learning_runs'))[0]?.t;
  if (!last || Date.now() - new Date(last).getTime() > RERUN_MS) return runAnalysis();
  return null;
}

export async function getLearnings() {
  await ensureLearningsTables();
  const run = (await q('select ran_at, summary from learning_runs order by id desc limit 1'))[0] || null;
  const rows = await q("select * from learnings where status in ('proposed','accepted') or (status = 'dismissed' and decided_at > now() - interval '30 days') order by status, updated_at desc");
  const view = (l) => ({ id: l.id, dimension: l.dimension, value: l.value, direction: l.direction, confidence: l.confidence, stats: l.stats, action: l.action, status: l.status, createdAt: l.created_at, decidedAt: l.decided_at });
  return {
    run: run ? { ranAt: run.ran_at, ...run.summary } : null,
    proposed: rows.filter((l) => l.status === 'proposed').map(view),
    accepted: rows.filter((l) => l.status === 'accepted').map(view),
    dismissed: rows.filter((l) => l.status === 'dismissed').map(view)
  };
}

export async function decide(id, action) {
  await ensureLearningsTables();
  const l = (await q('select * from learnings where id = $1', [id]))[0];
  if (!l) throw new HttpError(404, 'Learning not found');
  if (action === 'accept') {
    if (l.status === 'expired') throw new HttpError(409, 'This proposal is no longer supported by the data');
    // Opposite rules cannot both be active.
    const opposite = l.action?.type === 'copy_rule' ? OPPOSITE[l.action.key] : null;
    if (opposite) await q("update learnings set status = 'dismissed', decided_at = now() where status = 'accepted' and action->>'key' = $1", [opposite]);
    if (l.action?.type === 'post_hour') await q("update learnings set status = 'dismissed', decided_at = now() where status = 'accepted' and action->>'type' = 'post_hour' and id <> $1", [id]);
    await q("update learnings set status = 'accepted', decided_at = now() where id = $1", [id]);
  } else if (action === 'dismiss') {
    await q("update learnings set status = 'dismissed', decided_at = now() where id = $1", [id]);
  } else throw new HttpError(400, 'action must be accept or dismiss');
  return { ok: true };
}

/** What accepted learnings change: extra copy rules for the next plans and a preferred posting hour (Bali time). */
export async function activeGuidance() {
  try {
    await ensureLearningsTables();
    const rows = await q("select id, action from learnings where status = 'accepted' order by decided_at");
    const rules = rows.filter((r) => r.action?.type === 'copy_rule' && COPY_RULES[r.action.key]).map((r) => COPY_RULES[r.action.key]);
    const hour = [...rows].reverse().find((r) => r.action?.type === 'post_hour')?.action.hour ?? null;
    return { rules, postHour: hour, ids: rows.map((r) => r.id) };
  } catch (e) {
    console.error('Learnings guidance unavailable:', e.message);
    return { rules: [], postHour: null, ids: [] };
  }
}

export function learningRoutes(app, needDb, ah) {
  app.get('/learnings', needDb, ah(async (_req, res) => res.json(await getLearnings())));
  app.get('/learnings/active', needDb, ah(async (_req, res) => res.json(await activeGuidance())));
  app.post('/learnings/run', needDb, ah(async (_req, res) => res.json(await runAnalysis())));
  app.post('/learnings/:id/:action', needDb, ah(async (req, res) => res.json(await decide(Number(req.params.id), req.params.action))));
}
