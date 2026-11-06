import { dbEnabled, q } from './db.js';
import { HttpError } from './util.js';
import { adView } from './ads.js';
import { accountId, accountInfo, graph, metaConfig, pixelStatus } from './meta.js';
import { usdRates, toUsd, fromUsd, roundBudget, fmtMoney, PROPERTY_CURRENCY } from './fx.js';

// Ads planner, step 2: send an approved ad to Meta (everything is created PAUSED), switch it on, pause it and watch it.
// Sending runs in the background (Meta needs time to process a video); the screen refreshes until meta.pushing is false.
// Currencies: the plan is in USD, the ad account in its own currency (IDR). The daily budget is converted when the ad is
// sent and checked again when it is switched on; spend coming back is converted to USD before it meets a USD limit.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const usd = (n) => `$${Number(n).toFixed(2)}`;
const r2 = (x) => Math.round(x * 100) / 100;

// The goals of the app and the names Meta wants in promoted_object.custom_event_type. They differ: Meta says
// INITIATED_CHECKOUT and CONTENT_VIEW (answer of the Marketing API, error 100, November 2026).
const META_EVENT = { INITIATE_CHECKOUT: 'INITIATED_CHECKOUT', PURCHASE: 'PURCHASE', VIEW_CONTENT: 'CONTENT_VIEW' };
const metaEvent = (goal) => META_EVENT[goal] || goal;

const row = async (id) => {
  const r = await q(`select *, to_char(end_date, 'YYYY-MM-DD') as end_day from ad_campaigns where id = $1`, [id]);
  if (!r.length) throw new HttpError(404, 'Ad not found');
  return r[0];
};
const patchMeta = (id, patch) => q(`update ad_campaigns set meta = coalesce(meta, '{}'::jsonb) || $2::jsonb, updated_at = now() where id = $1`, [id, JSON.stringify(patch)]);
const baliToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

const blockers = (v, phase) => v.checks.filter((c) => c.phase === phase && !c.ok && c.level === 'block');

/** The daily budget of an ad in the account currency and in Meta's minor units. */
async function budgetFor(dailyUsd) {
  const acct = await accountInfo();
  const fx = await usdRates([acct.currency]);
  const account = roundBudget(fromUsd(dailyUsd, acct.currency, fx.rates), acct.currency);
  return { acct, fx, currency: acct.currency, account, minor: Math.round(account * acct.offset) };
}

/** The Instagram account Meta lets this ad account advertise with (null: the ad then runs under the Facebook page). */
async function instagramUserId() {
  try {
    const r = await graph('GET', `${accountId()}/instagram_accounts`, { fields: 'id,username' });
    const list = r.data || [];
    const want = process.env.META_IG_USER_ID;
    return (list.find((a) => a.id === want) || list[0])?.id || null;
  } catch {
    return null;
  }
}

/** Upload a video by link, wait until Meta has processed it, and take its preferred thumbnail (video ads need one). */
async function uploadVideo(url, name, knownId) {
  const id = knownId || (await graph('POST', `${accountId()}/advideos`, { file_url: url, name })).id;
  const t0 = Date.now();
  for (;;) {
    const s = await graph('GET', id, { fields: 'status' });
    const st = s.status?.video_status;
    if (st === 'ready') break;
    if (st === 'error') throw new HttpError(502, `Meta could not process the video: ${JSON.stringify(s.status).slice(0, 200)}`);
    if (Date.now() - t0 > 6 * 60 * 1000) throw new HttpError(504, 'Meta is still processing the video. Try again in a few minutes.');
    await sleep(6000);
  }
  let thumbnail = null;
  for (let i = 0; i < 4 && !thumbnail; i++) {
    const th = await graph('GET', `${id}/thumbnails`, {}).catch(() => ({}));
    const pick = (th.data || []).find((t) => t.is_preferred) || (th.data || [])[0];
    thumbnail = pick?.uri || null;
    if (!thumbnail) await sleep(4000);
  }
  if (!thumbnail) throw new HttpError(502, 'Meta has no thumbnail for the video yet. Try again in a minute.');
  return { id, thumbnail };
}

function storySpec(v, { pageId, igUser, video }) {
  const c = v.creative;
  const cta = { type: c.cta, value: { link: c.url } };
  const base = { page_id: pageId, ...(igUser ? { instagram_user_id: igUser } : {}) };
  if (c.mediaType === 'video') {
    return { ...base, video_data: { video_id: video.id, image_url: video.thumbnail, message: c.primaryText, title: c.headline, link_description: c.description || undefined, call_to_action: cta } };
  }
  return {
    ...base,
    link_data: {
      link: c.url,
      message: c.primaryText,
      child_attachments: (c.mediaUrls || []).slice(0, 10).map((u) => ({ link: c.url, picture: u, name: c.headline, call_to_action: cta })),
      multi_share_optimized: false,
      multi_share_end_card: false
    }
  };
}

/**
 * Targeting of the ad set. With Advantage+ audience (Meta's default for sales) the hard age limits are fixed by Meta:
 * the minimum may not be above 25 and the maximum is 65. A narrower range (here 28 to 65) goes in as a suggestion
 * (age_range), which Meta may widen. Without Advantage+ the ages are hard limits.
 */
function targetingFor(v, advantage) {
  const a = v.audience;
  const base = { geo_locations: { countries: a.countries }, ...(a.placements === 'instagram' ? { publisher_platforms: ['instagram'] } : {}) };
  if (!advantage) return { ...base, age_min: a.ageMin, age_max: a.ageMax, targeting_automation: { advantage_audience: 0 } };
  return {
    ...base,
    age_min: Math.min(a.ageMin, 25),
    age_max: 65,
    ...(a.ageMin > 25 || a.ageMax < 65 ? { age_range: [a.ageMin, a.ageMax] } : {}),
    targeting_automation: { advantage_audience: 1 }
  };
}

async function runPush(id) {
  const created = {};
  try {
    const v = await adView(id);
    const cfg = metaConfig();
    const known = (await row(id)).meta || {};
    const igUser = await instagramUserId();
    let video = null;
    if (v.creative.mediaType === 'video') {
      video = await uploadVideo(v.creative.mediaUrls[0], v.name, known.videoId);
      await patchMeta(id, { videoId: video.id });
    }

    // The budget in the account currency, converted now at today's rate.
    const b = await budgetFor(v.dailyBudgetUsd);

    // Campaign with its own daily budget, spread by Meta. Always created paused.
    const campaign = await graph('POST', `${accountId()}/campaigns`, {
      name: v.name,
      objective: 'OUTCOME_SALES',
      status: 'PAUSED',
      special_ad_categories: [],
      daily_budget: b.minor,
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP'
    });
    created.campaignId = campaign.id;
    // Read the budget back: if Meta stored something else than what was sent, nothing is left at Meta.
    const back = await graph('GET', campaign.id, { fields: 'daily_budget' });
    if (Number(back.daily_budget) !== b.minor) {
      throw new HttpError(502, `Meta stored the daily budget as ${back.daily_budget} instead of ${b.minor} (${fmtMoney(b.account, b.currency)}). Nothing was left at Meta.`);
    }

    const adsetBody = (advantage) => ({
      name: v.name,
      campaign_id: campaign.id,
      status: 'PAUSED',
      billing_event: 'IMPRESSIONS',
      optimization_goal: 'OFFSITE_CONVERSIONS',
      destination_type: 'WEBSITE',
      promoted_object: { pixel_id: cfg.pixelId, custom_event_type: metaEvent(v.optimizeFor) },
      targeting: targetingFor(v, advantage),
      start_time: `${v.startDate}T00:00:00+0800`,
      end_time: v.endDate ? `${v.endDate}T23:59:00+0800` : undefined
    });
    // First with Advantage+ audience and the age as a suggestion. If Meta refuses that, with a manual audience and hard ages.
    let adset;
    let audienceMode = 'advantage_plus';
    try {
      adset = await graph('POST', `${accountId()}/adsets`, adsetBody(true));
    } catch (e) {
      if (!/advantage|age_range|age|audience|targeting/i.test(String(e.message))) throw e;
      console.error('ad set with Advantage+ audience refused, retrying with a manual audience:', e.message);
      adset = await graph('POST', `${accountId()}/adsets`, adsetBody(false));
      audienceMode = 'manual';
    }
    created.adsetId = adset.id;

    // The creative stays as approved: Meta's automatic enhancements are switched off. Older rules may not know the switch, then without it.
    const spec = storySpec(v, { pageId: process.env.META_PAGE_ID, igUser, video });
    const makeCreative = (optOut) =>
      graph('POST', `${accountId()}/adcreatives`, {
        name: `${v.name} | creative`,
        object_story_spec: spec,
        ...(optOut ? { degrees_of_freedom_spec: { creative_features_spec: { standard_enhancements: { enroll_status: 'OPT_OUT' } } } } : {})
      });
    let creative;
    try {
      creative = await makeCreative(true);
    } catch {
      creative = await makeCreative(false);
    }
    created.creativeId = creative.id;

    const ad = await graph('POST', `${accountId()}/ads`, { name: v.name, adset_id: adset.id, creative: { creative_id: creative.id }, status: 'PAUSED' });
    created.adId = ad.id;

    await q(`update ad_campaigns set status = 'pushed', error = null, meta = coalesce(meta, '{}'::jsonb) || $2::jsonb, updated_at = now() where id = $1`, [
      id,
      JSON.stringify({
        pushing: false,
        campaignId: campaign.id,
        adsetId: adset.id,
        creativeId: creative.id,
        adId: ad.id,
        instagramUserId: igUser,
        audienceMode,
        pushedAt: new Date().toISOString(),
        budgetCurrency: b.currency,
        dailyBudgetAccount: b.account,
        budgetOffset: b.acct.offset,
        budgetOffsetSource: b.acct.offsetSource,
        fxRate: b.fx.rates[b.currency],
        fxDate: b.fx.date
      })
    ]);
  } catch (e) {
    // Nothing half-built stays at Meta: deleting the campaign removes its ad set and ad.
    if (created.campaignId) await graph('DELETE', created.campaignId).catch(() => {});
    await q(`update ad_campaigns set error = $2, meta = coalesce(meta, '{}'::jsonb) || '{"pushing": false}'::jsonb, updated_at = now() where id = $1`, [id, String(e.message || e).slice(0, 500)]).catch(() => {});
    console.error('ad push failed', id, e.message);
  }
}

/** Start sending an approved ad to Meta (paused). Answers at once; the work continues in the background. */
export async function pushAd(id) {
  const v = await adView(id);
  if (v.status !== 'approved') throw new HttpError(409, `Ad ${id} is ${v.status}; only an approved ad can be sent to Meta`);
  const blocked = blockers(v, 'approve');
  if (blocked.length) throw new HttpError(409, `Checks failed: ${blocked.map((c) => c.key).join(', ')}`);
  const claimed = await q(
    `update ad_campaigns set meta = coalesce(meta, '{}'::jsonb) || $2::jsonb, error = null, updated_at = now()
      where id = $1 and status = 'approved' and (coalesce((meta->>'pushing')::boolean, false) = false or coalesce((meta->>'pushingAt')::timestamptz, 'epoch'::timestamptz) < now() - interval '10 minutes')
      returning id`,
    [id, JSON.stringify({ pushing: true, pushingAt: new Date().toISOString() })]
  );
  if (!claimed.length) throw new HttpError(409, 'This ad is already being sent to Meta');
  runPush(id).catch((e) => console.error('ad push crashed', id, e));
  return adView(id);
}

async function setMetaStatus(m, status) {
  await graph('POST', m.campaignId, { status });
  await graph('POST', m.adsetId, { status });
  await graph('POST', m.adId, { status });
}

/**
 * Switch on. Needs the pixel to have received InitiateCheckout events (fresh read), the approval checks to still hold and
 * the amount unit of the account currency to be certain. If the exchange rate moved by more than 3 per cent since the ad
 * was sent, the budget at Meta is brought back to the planned USD amount first.
 */
export async function activateAd(id) {
  const v = await adView(id);
  if (!['pushed', 'paused'].includes(v.status)) throw new HttpError(409, `Ad ${id} is ${v.status}; only an ad that is at Meta can be switched on`);
  const m = v.meta || {};
  if (!m.campaignId || !m.adsetId || !m.adId) throw new HttpError(409, 'This ad has no objects at Meta yet');
  const blocked = blockers(v, 'approve');
  if (blocked.length) throw new HttpError(409, `Checks failed: ${blocked.map((c) => c.key).join(', ')}`);
  const units = v.checks.find((c) => c.key === 'budget_units');
  if (units && !units.ok) {
    throw new HttpError(409, `The amount unit for ${units.params.currency || 'this currency'} is only assumed (factor ${units.params.offset}). Check the daily budget of the campaign in Ads Manager, then set META_CURRENCY_OFFSET=${units.params.offset} in Railway.`);
  }
  const px = await pixelStatus();
  if (!((px.events.InitiateCheckout || 0) > 0)) {
    throw new HttpError(409, `The pixel has received no InitiateCheckout event in the last 7 days (PageView: ${px.events.PageView || 0}). Without it Meta cannot optimise this ad.`);
  }

  const b = await budgetFor(v.dailyBudgetUsd);
  if (m.dailyBudgetAccount && Math.abs(b.account / Number(m.dailyBudgetAccount) - 1) > 0.03) {
    await graph('POST', m.campaignId, { daily_budget: b.minor });
    await patchMeta(id, { budgetCurrency: b.currency, dailyBudgetAccount: b.account, budgetOffset: b.acct.offset, budgetOffsetSource: b.acct.offsetSource, fxRate: b.fx.rates[b.currency], fxDate: b.fx.date });
  }

  await setMetaStatus(m, 'ACTIVE');
  await q(`update ad_campaigns set status = 'active', error = null, updated_at = now() where id = $1`, [id]);
  await patchMeta(id, { activatedAt: new Date().toISOString() });
  return adView(id);
}

export async function pauseAd(id) {
  const r = await row(id);
  if (r.status !== 'active') throw new HttpError(409, `Ad ${id} is ${r.status}; only a running ad can be paused`);
  await setMetaStatus(r.meta || {}, 'PAUSED');
  await q(`update ad_campaigns set status = 'paused', updated_at = now() where id = $1`, [id]);
  return adView(id);
}

const CHECKOUT = ['omni_initiated_checkout', 'offsite_conversion.fb_pixel_initiate_checkout'];
const PURCHASE = ['omni_purchase', 'offsite_conversion.fb_pixel_purchase'];
const countAction = (actions, names) => {
  for (const n of names) {
    const a = (actions || []).find((x) => x.action_type === n);
    if (a) return Number(a.value) || 0;
  }
  return 0;
};

/**
 * Watch the running ads: store the numbers (in the account currency, in USD and in the property currency), pause an ad
 * that spent its USD limit without a single InitiateCheckout, and mark ads whose end date has passed.
 * Scaling a budget is never done automatically.
 */
export async function monitorAds() {
  const rows = await q(`select *, to_char(end_date, 'YYYY-MM-DD') as end_day from ad_campaigns where status = 'active'`);
  if (!rows.length) return [];
  let acct = null;
  let fx = null;
  try {
    acct = await accountInfo();
    fx = await usdRates([acct.currency]);
  } catch (e) {
    console.error('ads monitor: account or rate not available:', e.message);
  }
  const results = [];
  for (const r of rows) {
    const m = r.meta || {};
    try {
      const cur = acct?.currency || m.budgetCurrency || 'USD';
      // Fresh rate, else the one stored when the ad was sent: the protective rule must still work if the rate service is down.
      const rate = cur === 'USD' ? 1 : fx?.rates?.[cur] || Number(m.fxRate) || null;
      const propRate = fx?.rates?.[PROPERTY_CURRENCY] || null;
      const ins = await graph('GET', `${m.campaignId}/insights`, { fields: 'spend,impressions,clicks,actions,action_values', date_preset: 'maximum' });
      const d = ins.data?.[0] || {};
      const spend = Number(d.spend) || 0;
      const checkouts = countAction(d.actions, CHECKOUT);
      const purchases = countAction(d.actions, PURCHASE);
      const value = countAction(d.action_values, PURCHASE);
      const spendUsd = rate ? spend / rate : null;
      const toProp = (amount) => (rate && propRate ? r2((amount / rate) * propRate) : null);
      const snapshot = {
        at: new Date().toISOString(),
        currency: cur,
        propertyCurrency: PROPERTY_CURRENCY,
        spend,
        spendUsd: spendUsd == null ? null : r2(spendUsd),
        spendProperty: toProp(spend),
        impressions: Number(d.impressions) || 0,
        clicks: Number(d.clicks) || 0,
        checkouts,
        purchases,
        cpa: purchases ? r2(spend / purchases) : null,
        cpaUsd: purchases && spendUsd != null ? r2(spendUsd / purchases) : null,
        cpaProperty: purchases ? toProp(spend / purchases) : null,
        purchaseValue: value,
        purchaseValueProperty: toProp(value),
        roas: spend > 0 && value > 0 ? r2(value / spend) : null
      };
      await patchMeta(r.id, { insights: snapshot });
      let action = 'ok';
      if (spendUsd == null) {
        action = 'no_rate';
      } else if (spendUsd >= Number(r.stop_no_checkout_usd) && checkouts === 0) {
        await setMetaStatus(m, 'PAUSED');
        await q(`update ad_campaigns set status = 'paused', error = $2, updated_at = now() where id = $1`, [
          r.id,
          `Paused automatically: ${fmtMoney(spend, cur)} (${usd(spendUsd)}) spent without an InitiateCheckout (limit ${usd(r.stop_no_checkout_usd)}).`
        ]);
        action = 'paused_no_checkout';
      } else if (r.end_day && r.end_day < baliToday()) {
        await q(`update ad_campaigns set status = 'ended', updated_at = now() where id = $1`, [r.id]);
        action = 'ended';
      }
      results.push({ id: r.id, action, ...snapshot });
    } catch (e) {
      results.push({ id: r.id, action: 'error', error: String(e.message || e).slice(0, 200) });
    }
  }
  return results;
}

/** Every three hours, but only when an ad is running. ADS_MONITOR=off switches it off. */
export function startAdsMonitor() {
  if (process.env.ADS_MONITOR === 'off') return;
  const run = async () => {
    try {
      if (!dbEnabled()) return;
      const any = await q(`select 1 from ad_campaigns where status = 'active' limit 1`);
      if (any.length) await monitorAds();
    } catch (e) {
      console.error('ads monitor failed', e.message);
    }
  };
  setInterval(run, 3 * 3600 * 1000).unref();
}

export function adsLiveRoutes(app, needDb, ah) {
  app.post('/ads/monitor', needDb, ah(async (_req, res) => res.json({ results: await monitorAds() })));
  app.post('/ads/:id/push', needDb, ah(async (req, res) => res.status(202).json(await pushAd(Number(req.params.id)))));
  app.post('/ads/:id/activate', needDb, ah(async (req, res) => res.json(await activateAd(Number(req.params.id)))));
  app.post('/ads/:id/pause', needDb, ah(async (req, res) => res.json(await pauseAd(Number(req.params.id)))));
}
