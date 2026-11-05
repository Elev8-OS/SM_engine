import { q } from './db.js';
import { HttpError } from './util.js';
import { audiencePlan } from './audience.js';
import { mediaUrls } from './posts.js';
import { accountInfo, pixelStatus, metaConfig } from './meta.js';
import { usdRates, toUsd, fromUsd, roundBudget, fxView, PROPERTY_CURRENCY } from './fx.js';

// Ads planner, step 1: drafts, checks, editing and approval. Nothing here creates anything at Meta yet.
// Flow: draft -> approved -> (step 2: pushed paused to Meta -> active). The creative is an approved post (reel or carousel).
// Currencies: money is planned in USD (budget, price limits). The ad account runs in its own currency (IDR) and the
// properties are in CHF. Budgets are converted to the account currency when sent to Meta (see fx.js), and every figure is
// shown in all three currencies so nothing has to be converted in the head.

const SITE_URL = 'https://www.elevate-villas.com';
const DAY = 86400000;
const CTAS = ['BOOK_TRAVEL', 'LEARN_MORE', 'SIGN_UP'];
const PLACEMENTS = ['automatic', 'instagram'];
const GOALS = ['INITIATE_CHECKOUT', 'PURCHASE', 'VIEW_CONTENT'];
const COMMITTED = ['approved', 'pushed', 'active'];
const OPEN = ['draft', 'approved', 'pushed', 'active', 'paused'];
const LIVE_POST = ['approved', 'scheduled', 'published'];
const COLS = `*, to_char(start_date, 'YYYY-MM-DD') as start_day, to_char(end_date, 'YYYY-MM-DD') as end_day`;

const round2 = (x) => Math.round(x * 100) / 100;
const num = (v, d) => {
  const n = Number(v);
  return String(v ?? '').trim() !== '' && Number.isFinite(n) ? n : d;
};
const list = (v, d) => String(v || d).split(',').map((s) => s.trim()).filter(Boolean);
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const baliToday = () => {
  const t = new Date(Date.now() + 8 * 3600 * 1000);
  return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
};

export function adsSettings() {
  return {
    monthlyBudgetUsd: num(process.env.ADS_MONTHLY_BUDGET_USD, 500),
    prospectingShare: num(process.env.ADS_PROSPECTING_SHARE, 0.66),
    maxCpaUsd: num(process.env.ADS_MAX_CPA_USD, 40),
    stopNoCheckoutUsd: num(process.env.ADS_STOP_NO_CHECKOUT_USD, 60),
    countries: list(process.env.ADS_COUNTRIES, 'AU,GB').map((c) => c.toUpperCase()),
    villas: list(process.env.ADS_VILLAS, 'patuha,bratan').map((v) => v.toLowerCase()),
    days: 30
  };
}

/** Cut at a sentence or word boundary, never mid-word. */
function cut(text, n) {
  if (text.length <= n) return text;
  const head = text.slice(0, n);
  const at = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '), head.lastIndexOf('\n'));
  if (at > n * 0.5) return head.slice(0, at + 1).trim();
  return head.slice(0, head.lastIndexOf(' ')).trim();
}

/** Instagram caption to ad text: no hashtags, no "link in bio" (an ad has a button). */
export function adText(caption) {
  const t = String(caption || '')
    .replace(/[^.!?\n]*link in (the )?bio[^.!?\n]*[.!?]?/gi, '')
    .replace(/(^|\s)#[\p{L}\p{N}_]+/gu, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cut(t, 600);
}

/** Landing page of the villa with paid tracking: the booking site stores these at booking time. */
export function adUrl(prop, postId) {
  const base = prop.url || SITE_URL;
  return `${base}${base.includes('?') ? '&' : '?'}utm_source=meta&utm_medium=paid_social&utm_campaign=${`ads_${prop.key}_${postId}`.replace(/[^a-z0-9_]/gi, '')}&utm_content=post${postId}`;
}

// ---- Meta state (cached five minutes, so the screen does not hammer the API) ----
let metaCache = { at: 0, data: null };
async function metaState(force = false) {
  if (!force && metaCache.data && Date.now() - metaCache.at < 5 * 60 * 1000) return metaCache.data;
  const config = metaConfig();
  const out = { config, account: null, pixel: null, errors: {} };
  await Promise.all([
    config.token && config.account ? accountInfo().then((a) => (out.account = a)).catch((e) => (out.errors.account = e.message)) : null,
    config.token && config.pixelId ? pixelStatus().then((p) => (out.pixel = p)).catch((e) => (out.errors.pixel = e.message)) : null
  ]);
  metaCache = { at: Date.now(), data: out };
  return out;
}

/** A USD amount in the account currency (rounded for budgets) and in the property currency. Missing rates give null, never a wrong number. */
function convert(ctx, usd) {
  const cur = ctx.meta.account?.currency ?? null;
  const rates = ctx.fx?.rates || {};
  return {
    usd: round2(usd),
    account: cur && rates[cur] > 0 ? roundBudget(fromUsd(usd, cur, rates), cur) : null,
    property: rates[PROPERTY_CURRENCY] > 0 ? round2(fromUsd(usd, PROPERTY_CURRENCY, rates)) : null
  };
}

/**
 * Checks for one ad. phase 'approve' must pass before approval, phase 'activate' before it can go live (step 2).
 * level 'block' stops, 'warn' only informs. Results are keys with params; the app writes the texts.
 */
function buildChecks(c, { post, meta, fx, plan, settings, committedOthers }) {
  const out = [];
  const add = (key, ok, params = {}, phase = 'approve', level = 'block') => out.push({ key, ok: Boolean(ok), level: ok ? 'ok' : level, phase, params });
  const monthly = Number(c.daily_budget_usd) * 30;
  const cfg = meta.config;
  const cur = meta.account?.currency ?? null;
  const rate = cur && fx?.rates ? fx.rates[cur] : null;

  add('post_ready', post && LIVE_POST.includes(post.status), { status: post?.status ?? 'missing' });
  add('media', (c.creative?.mediaKeys || []).length > 0, { count: (c.creative?.mediaKeys || []).length });

  const missing = [!cfg.token && 'META_ADS_TOKEN', !cfg.account && 'META_AD_ACCOUNT_ID', !cfg.page && 'META_PAGE_ID', !cfg.pixelId && 'META_PIXEL_ID'].filter(Boolean);
  add('meta_setup', !missing.length, { missing });
  add('account_ok', meta.account && meta.account.status === 1, { status: meta.account?.status ?? null, error: meta.errors.account ?? null });
  // The account may run in any currency: what counts is that there is a rate to convert the USD plan into it.
  add('currency', Boolean(meta.account && rate > 0), { currency: cur, rate: rate ?? null, date: fx?.date ?? null, source: fx?.source ?? null, propertyCurrency: PROPERTY_CURRENCY, error: fx?.error ?? null });
  add('budget_cap', committedOthers + monthly <= settings.monthlyBudgetUsd + 0.01, { committed: round2(committedOthers), thisAd: round2(monthly), cap: settings.monthlyBudgetUsd });

  const cap = meta.account?.spendCap;
  const remainingUsd = cap != null && rate > 0 ? toUsd(cap - (meta.account.amountSpent || 0), cur, fx.rates) : null;
  add(
    'account_spend_cap',
    cap == null || remainingUsd == null || remainingUsd >= monthly,
    { cap: cap ?? null, spent: meta.account?.amountSpent ?? null, currency: cur, remainingUsd: remainingUsd == null ? null : round2(remainingUsd), monthlyUsd: round2(monthly) },
    'approve',
    'warn'
  );

  const v = plan?.villas?.find((x) => x.key === c.property_key);
  add('free_nights', v && v.freeNights > 0, { freeNights: v?.freeNights ?? null, days: plan?.horizonDays ?? null }, 'approve', 'warn');

  // Before switching on: the unit Meta uses for amounts in this currency must be certain, or a budget could be off by 100x.
  add('budget_units', !meta.account || meta.account.offsetSource !== 'assumed', { currency: cur, offset: meta.account?.offset ?? null, source: meta.account?.offsetSource ?? null }, 'activate');

  const ev = meta.pixel?.events || {};
  add('pixel_events', (ev.InitiateCheckout || 0) > 0, { initiateCheckout: ev.InitiateCheckout || 0, pageView: ev.PageView || 0, purchase: ev.Purchase || 0, lastFired: meta.pixel?.lastFired ?? null, error: meta.errors.pixel ?? null }, 'activate');
  add('pixel_purchase', (ev.Purchase || 0) > 0, { purchase: ev.Purchase || 0 }, 'activate', 'warn');
  return out;
}

async function context(force = false) {
  const [meta, plan, committedRow] = await Promise.all([
    metaState(force),
    audiencePlan({ days: 60 }).catch(() => null),
    q('select coalesce(sum(daily_budget_usd), 0)::float * 30 as monthly from ad_campaigns where status = any($1)', [COMMITTED])
  ]);
  const cur = meta.account?.currency;
  const fx = await usdRates(cur ? [cur] : []).catch((e) => ({ rates: { USD: 1 }, date: null, source: null, stale: false, error: String(e.message || e) }));
  return { meta, plan, fx, settings: adsSettings(), committed: committedRow[0].monthly };
}

async function views(rows, ctx) {
  const ids = [...new Set(rows.map((r) => r.post_id).filter(Boolean))];
  const posts = new Map(
    (ids.length ? await q(`select id, format, pillar, status, to_char(plan_date, 'YYYY-MM-DD') as plan_date from posts where id = any($1)`, [ids]) : []).map((p) => [p.id, p])
  );
  const cur = ctx.meta.account?.currency ?? null;
  return Promise.all(
    rows.map(async (r) => {
      const post = posts.get(r.post_id) || null;
      const own = COMMITTED.includes(r.status) ? Number(r.daily_budget_usd) * 30 : 0;
      const days = r.end_day ? Math.round((Date.parse(r.end_day) - Date.parse(r.start_day)) / DAY) + 1 : ctx.settings.days;
      const spend = Number(r.daily_budget_usd) * days;
      return {
        id: r.id,
        status: r.status,
        kind: r.kind,
        propertyKey: r.property_key,
        postId: r.post_id,
        post,
        name: r.name,
        optimizeFor: r.optimize_for,
        dailyBudgetUsd: Number(r.daily_budget_usd),
        monthlyBudgetUsd: round2(Number(r.daily_budget_usd) * 30),
        startDate: r.start_day,
        endDate: r.end_day,
        maxCpaUsd: Number(r.max_cpa_usd),
        stopNoCheckoutUsd: Number(r.stop_no_checkout_usd),
        audience: r.audience,
        creative: { ...r.creative, mediaUrls: await mediaUrls({ media: { keys: r.creative?.mediaKeys || [] } }).catch(() => []) },
        estimate: { days, spendUsd: round2(spend), bookingsAtMaxCpa: round2(spend / Number(r.max_cpa_usd)) },
        // The same amounts in the account currency and the property currency (null when a rate is missing).
        money: {
          accountCurrency: cur,
          propertyCurrency: PROPERTY_CURRENCY,
          daily: convert(ctx, Number(r.daily_budget_usd)),
          maxCpa: convert(ctx, Number(r.max_cpa_usd)),
          stopNoCheckout: convert(ctx, Number(r.stop_no_checkout_usd)),
          estimateSpend: convert(ctx, spend)
        },
        checks: buildChecks(r, { post, meta: ctx.meta, fx: ctx.fx, plan: ctx.plan, settings: ctx.settings, committedOthers: ctx.committed - own }),
        approvedAt: r.approved_at,
        feedback: r.feedback,
        error: r.error,
        meta: r.meta
      };
    })
  );
}

const getRow = async (id) => {
  const rows = await q(`select ${COLS} from ad_campaigns where id = $1`, [id]);
  if (!rows.length) throw new HttpError(404, 'Ad not found');
  return rows[0];
};

export async function adView(id) {
  const ctx = await context();
  return (await views([await getRow(id)], ctx))[0];
}

export async function listAds({ refresh = false } = {}) {
  const ctx = await context(refresh);
  const rows = await q(`select ${COLS} from ad_campaigns order by id desc limit 50`);
  const m = ctx.meta;
  return {
    settings: ctx.settings,
    budget: {
      monthlyUsd: ctx.settings.monthlyBudgetUsd,
      committedUsd: round2(ctx.committed),
      freeUsd: round2(ctx.settings.monthlyBudgetUsd - ctx.committed),
      monthly: convert(ctx, ctx.settings.monthlyBudgetUsd),
      committed: convert(ctx, ctx.committed)
    },
    fx: fxView(ctx.fx, m.account?.currency ?? null),
    meta: {
      version: m.config.version,
      configured: { token: m.config.token, account: Boolean(m.config.account), page: m.config.page, instagram: m.config.instagram, pixel: Boolean(m.config.pixelId) },
      account: m.account,
      pixel: m.pixel,
      errors: m.errors
    },
    campaigns: await views(rows, ctx)
  };
}

/** Draft for one villa from its latest approved reel or carousel (or the post you name). */
export async function createDraft({ propertyKey, postId } = {}) {
  const s = adsSettings();
  const prop = (await q('select key, name, url from properties where key = $1', [propertyKey]))[0];
  if (!prop) throw new HttpError(404, `Unknown property: ${propertyKey}`);
  const post = postId
    ? (await q('select * from posts where id = $1', [Number(postId)]))[0]
    : (
        await q(
          `select * from posts where property_key = $1 and format in ('reel','carousel') and status = any($2) and media is not null order by plan_date desc nulls last, id desc limit 1`,
          [propertyKey, LIVE_POST]
        )
      )[0];
  if (!post) throw new HttpError(409, `No approved reel or carousel for ${prop.name} yet. Approve a post first.`);
  if (post.property_key !== propertyKey) throw new HttpError(400, `Post ${post.id} belongs to ${post.property_key}, not ${propertyKey}`);
  if (!['reel', 'carousel'].includes(post.format)) throw new HttpError(400, 'Only reels and carousels can be used as ads');
  if (!post.media?.keys?.length) throw new HttpError(409, `Post ${post.id} has no rendered media`);
  const dup = await q('select id from ad_campaigns where post_id = $1 and status = any($2)', [post.id, OPEN]);
  if (dup.length) throw new HttpError(409, `Ad ${dup[0].id} already uses post ${post.id}`);

  const caption = post.copy?.captions?.instagram || post.copy?.captions?.facebook || '';
  const creative = {
    primaryText: adText(caption),
    headline: cut(String(post.copy?.hook || prop.name), 80),
    description: 'Book direct. Best rate guaranteed.',
    cta: 'BOOK_TRAVEL',
    url: adUrl(prop, post.id),
    mediaType: post.media.type,
    mediaKeys: post.media.keys
  };
  const audience = { countries: s.countries, ageMin: 28, ageMax: 65, placements: 'automatic' };
  const daily = Math.max(1, Math.round(((s.monthlyBudgetUsd * s.prospectingShare) / 30 / Math.max(1, s.villas.length)) * 2) / 2);
  const start = baliToday() + DAY;
  const end = start + (s.days - 1) * DAY;
  const name = `Prospecting | ${prop.name} | ${s.countries.join('+')} | ${iso(start)}`;
  const rows = await q(
    `insert into ad_campaigns (property_key, post_id, name, daily_budget_usd, start_date, end_date, max_cpa_usd, stop_no_checkout_usd, audience, creative)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [propertyKey, post.id, name, daily, iso(start), iso(end), s.maxCpaUsd, s.stopNoCheckoutUsd, audience, creative]
  );
  return adView(rows[0].id);
}

/** One draft per configured villa that has no open ad yet. */
export async function createDrafts() {
  const s = adsSettings();
  const created = [];
  const skipped = [];
  for (const key of s.villas) {
    const open = await q('select id from ad_campaigns where property_key = $1 and status = any($2) limit 1', [key, OPEN]);
    if (open.length) {
      skipped.push({ villa: key, reason: `ad ${open[0].id} is already open` });
      continue;
    }
    try {
      created.push((await createDraft({ propertyKey: key })).id);
    } catch (e) {
      skipped.push({ villa: key, reason: String(e.message || e) });
    }
  }
  return { created, skipped };
}

const validDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

export async function editAd(id, body = {}) {
  const r = await getRow(id);
  if (r.status !== 'draft') throw new HttpError(409, `Only a draft can be edited (this ad is ${r.status}). Reopen it first.`);
  const sets = [];
  const vals = [id];
  const set = (col, v) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  const range = (name, v, a, b) => {
    const n = Number(v);
    if (!(n >= a && n <= b)) throw new HttpError(400, `${name} must be between ${a} and ${b}`);
    return round2(n);
  };

  if ('name' in body) {
    const v = String(body.name || '').trim();
    if (!v || v.length > 150) throw new HttpError(400, 'name must be 1 to 150 characters');
    set('name', v);
  }
  if ('dailyBudgetUsd' in body) set('daily_budget_usd', range('dailyBudgetUsd', body.dailyBudgetUsd, 1, 100));
  if ('maxCpaUsd' in body) set('max_cpa_usd', range('maxCpaUsd', body.maxCpaUsd, 5, 500));
  if ('stopNoCheckoutUsd' in body) set('stop_no_checkout_usd', range('stopNoCheckoutUsd', body.stopNoCheckoutUsd, 10, 500));
  if ('optimizeFor' in body) {
    if (!GOALS.includes(body.optimizeFor)) throw new HttpError(400, `optimizeFor must be one of ${GOALS.join(', ')}`);
    set('optimize_for', body.optimizeFor);
  }
  if ('startDate' in body || 'endDate' in body) {
    const start = body.startDate ?? r.start_day;
    const end = body.endDate ?? r.end_day;
    if (!validDay(start) || !validDay(end)) throw new HttpError(400, 'startDate and endDate must be YYYY-MM-DD');
    if (Date.parse(start) < baliToday()) throw new HttpError(400, 'startDate cannot be in the past');
    if (Date.parse(end) < Date.parse(start)) throw new HttpError(400, 'endDate must not be before startDate');
    set('start_date', start);
    set('end_date', end);
  }
  if (body.audience && typeof body.audience === 'object') {
    const a = { ...r.audience };
    if ('countries' in body.audience) {
      const cs = [...new Set((Array.isArray(body.audience.countries) ? body.audience.countries : []).map((c) => String(c).trim().toUpperCase()))];
      if (!cs.length || cs.length > 10 || cs.some((c) => !/^[A-Z]{2}$/.test(c))) throw new HttpError(400, 'countries must be 1 to 10 two-letter codes');
      if (cs.includes('RU')) throw new HttpError(400, 'Meta does not deliver ads to RU');
      a.countries = cs;
    }
    if ('ageMin' in body.audience) a.ageMin = Math.round(range('ageMin', body.audience.ageMin, 18, 65));
    if ('ageMax' in body.audience) a.ageMax = Math.round(range('ageMax', body.audience.ageMax, 18, 65));
    if (a.ageMax < a.ageMin) throw new HttpError(400, 'ageMax must not be below ageMin');
    if ('placements' in body.audience) {
      if (!PLACEMENTS.includes(body.audience.placements)) throw new HttpError(400, `placements must be one of ${PLACEMENTS.join(', ')}`);
      a.placements = body.audience.placements;
    }
    set('audience', a);
  }
  if (body.creative && typeof body.creative === 'object') {
    const c = { ...r.creative };
    const text = (k, max) => {
      if (!(k in body.creative)) return;
      const v = String(body.creative[k] ?? '').trim();
      if (k !== 'description' && !v) throw new HttpError(400, `${k} must not be empty`);
      if (v.length > max) throw new HttpError(400, `${k} must be at most ${max} characters`);
      c[k] = v;
    };
    text('primaryText', 2000);
    text('headline', 80);
    text('description', 100);
    if ('cta' in body.creative) {
      if (!CTAS.includes(body.creative.cta)) throw new HttpError(400, `cta must be one of ${CTAS.join(', ')}`);
      c.cta = body.creative.cta;
    }
    set('creative', c);
  }
  if (!sets.length) throw new HttpError(400, 'No known fields to update');
  await q(`update ad_campaigns set ${sets.join(', ')}, updated_at = now() where id = $1`, vals);
  return adView(id);
}

export async function approveAd(id) {
  const v = await adView(id);
  if (v.status !== 'draft') throw new HttpError(409, `Ad ${id} is ${v.status}; only a draft can be approved`);
  const blocked = v.checks.filter((c) => c.phase === 'approve' && !c.ok && c.level === 'block');
  if (blocked.length) throw new HttpError(409, `Checks failed: ${blocked.map((c) => c.key).join(', ')}`);
  // checks is a list: node-pg turns a JS array into a Postgres array literal, which is not valid JSON. It must go in as a JSON string.
  await q(`update ad_campaigns set status = 'approved', checks = $2::jsonb, approved_at = now(), error = null, updated_at = now() where id = $1`, [id, JSON.stringify(v.checks)]);
  return adView(id);
}

export async function reopenAd(id) {
  const r = await getRow(id);
  if (r.status !== 'approved') throw new HttpError(409, `Ad ${id} is ${r.status}; only an approved ad (not yet at Meta) can be reopened`);
  await q(`update ad_campaigns set status = 'draft', approved_at = null, updated_at = now() where id = $1`, [id]);
  return adView(id);
}

export async function rejectAd(id, feedback) {
  const r = await getRow(id);
  if (!['draft', 'approved'].includes(r.status)) throw new HttpError(409, `Ad ${id} is ${r.status}; only a draft or approved ad can be rejected here`);
  await q(`update ad_campaigns set status = 'rejected', feedback = coalesce($2, feedback), updated_at = now() where id = $1`, [id, feedback ? String(feedback).slice(0, 500) : null]);
  return adView(id);
}

export function adsRoutes(app, needDb, ah) {
  app.get('/ads', needDb, ah(async (req, res) => res.json(await listAds({ refresh: req.query.refresh === '1' }))));
  app.post('/ads/draft', needDb, ah(async (req, res) => res.json(await createDraft(req.body || {}))));
  app.post('/ads/draft-all', needDb, ah(async (_req, res) => res.json(await createDrafts())));
  app.put('/ads/:id', needDb, ah(async (req, res) => res.json(await editAd(Number(req.params.id), req.body || {}))));
  app.post('/ads/:id/approve', needDb, ah(async (req, res) => res.json(await approveAd(Number(req.params.id)))));
  app.post('/ads/:id/reopen', needDb, ah(async (req, res) => res.json(await reopenAd(Number(req.params.id)))));
  app.post('/ads/:id/reject', needDb, ah(async (req, res) => res.json(await rejectAd(Number(req.params.id), req.body?.feedback))));
}
