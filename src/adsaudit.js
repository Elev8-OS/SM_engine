import { HttpError } from './util.js';
import { adView } from './ads.js';
import { accountId, accountInfo, graph, metaConfig, pixelStatus } from './meta.js';
import { fmtMoney } from './fx.js';

// Audit of a running or sent ad: reads the objects live from Meta (nothing is written) and compares them with what the
// app planned. The answer is a list of checks (level block, warn, info, ok) with a short fix, plus the numbers behind them.
// Every read is tried on its own: a field Meta does not know or a missing permission shows up under "unread" and never stops the audit.

const attempt = async (fn) => {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 240) };
  }
};
const read = (path, fields, extra = {}) => graph('GET', path, { fields, ...extra });

// Meta's name of the optimisation event and the name the pixel reports it under
const PIXEL_EVENT = { INITIATED_CHECKOUT: 'InitiateCheckout', CONTENT_VIEW: 'ViewContent', PURCHASE: 'Purchase', ADD_TO_CART: 'AddToCart', LEAD: 'Lead' };

const num = (x) => (x === undefined || x === null || x === '' ? null : Number(x));
const actionCount = (actions, names) => {
  for (const n of names) {
    const a = (actions || []).find((x) => x.action_type === n);
    if (a) return Number(a.value) || 0;
  }
  return 0;
};
/** The values a pixel statistics answer lists, whatever the exact shape (rows of data with value and count). */
function statValues(d) {
  const out = {};
  const walk = (x) => {
    if (!x) return;
    if (Array.isArray(x)) return x.forEach(walk);
    if (typeof x === 'object') {
      if (x.value !== undefined && x.count !== undefined) out[String(x.value)] = (out[String(x.value)] || 0) + (Number(x.count) || 0);
      else Object.values(x).forEach(walk);
    }
  };
  walk(d?.data);
  return out;
}

export async function auditAd(id) {
  const v = await adView(id);
  const m = v.meta || {};
  if (!m.campaignId || !m.adsetId || !m.adId) throw new HttpError(409, 'This ad has not been sent to Meta yet');
  const cfg = metaConfig();
  const acct = await accountInfo();
  const now = Math.floor(Date.now() / 1000);
  const since = now - 7 * 86400;
  const stat = (aggregation) => graph('GET', `${cfg.pixelId}/stats`, { aggregation, start_time: since, end_time: now });

  const [campR, setR, adR, crR, igR, pxR, insR, accR, px, sEvents, sPii, sMethod, sHost] = await Promise.all([
    attempt(() => read(m.campaignId, 'name,objective,status,effective_status,daily_budget,bid_strategy,buying_type,special_ad_categories')),
    attempt(() => read(m.adsetId, 'name,status,effective_status,optimization_goal,billing_event,destination_type,promoted_object,targeting,attribution_spec,start_time,end_time,learning_stage_info,issues_info')),
    attempt(() => read(m.adId, 'name,status,effective_status,configured_status,issues_info,ad_review_feedback,tracking_specs,conversion_domain')),
    attempt(() => read(m.creativeId, 'name,object_story_spec,url_tags,degrees_of_freedom_spec,instagram_actor_id,effective_object_story_id')),
    attempt(() => read(`${accountId()}/instagram_accounts`, 'id,username')),
    attempt(() => read(cfg.pixelId, 'name,last_fired_time,is_unavailable,enable_automatic_matching,first_party_cookie_status,data_use_setting')),
    attempt(() => read(`${m.adId}/insights`, 'impressions,reach,frequency,spend,clicks,ctr,cpc,cpm,inline_link_clicks,actions,cost_per_action_type', { date_preset: 'maximum' })),
    attempt(() => read(accountId(), 'account_status,disable_reason,currency,spend_cap,amount_spent,timezone_name')),
    attempt(() => pixelStatus()),
    attempt(() => stat('event_total_counts')),
    attempt(() => stat('pii_keys')),
    attempt(() => stat('event_detection_method')),
    attempt(() => stat('host'))
  ]);

  const unread = {};
  for (const [k, r] of Object.entries({ campaign: campR, adset: setR, ad: adR, creative: crR, instagram: igR, pixel: pxR, insights: insR, account: accR, pixelEvents: px, statEvents: sEvents, statPii: sPii, statMethod: sMethod, statHost: sHost })) if (!r.ok) unread[k] = r.error;

  const camp = campR.data || {};
  const adset = setR.data || {};
  const ad = adR.data || {};
  const cr = crR.data || {};
  const pixel = pxR.data || {};
  const ins = insR.data?.data?.[0] || {};
  const cur = acct.currency;
  const checks = [];
  const add = (level, area, key, text, fix = '') => checks.push({ level, area, key, text, fix });

  // ---- Delivery and review
  if (adR.ok) {
    const issues = (ad.issues_info || []).map((i) => i.error_summary || i.error_message).filter(Boolean);
    if (issues.length) add('block', 'setup', 'ad_issues', `Meta reports problems with the ad: ${issues.join('; ')}`, 'Open the ad in Ads Manager and fix what Meta names.');
    else add('ok', 'setup', 'ad_status', `Ad status at Meta: ${ad.effective_status}`);
  }
  if (accR.ok && accR.data.account_status !== undefined && Number(accR.data.account_status) !== 1) add('block', 'setup', 'account_status', `The ad account is not active (status ${accR.data.account_status}, reason ${accR.data.disable_reason ?? 'unknown'}).`, 'Check the account in Business Settings.');

  // ---- Budget as Meta stored it
  if (campR.ok && camp.daily_budget) {
    const seen = Number(camp.daily_budget) / acct.offset;
    const planned = num(m.dailyBudgetAccount);
    if (planned && Math.abs(seen / planned - 1) > 0.01) add('block', 'setup', 'budget', `Daily budget at Meta is ${fmtMoney(seen, cur)}, planned was ${fmtMoney(planned, cur)}.`, 'The amount unit of the currency is probably wrong. Do not switch the ad on, check META_CURRENCY_OFFSET.');
    else add('ok', 'setup', 'budget', `Daily budget at Meta: ${fmtMoney(seen, cur)}${planned ? ' (as planned)' : ''}. Per week about ${fmtMoney(seen * 7, cur)}.`);
  }

  // ---- Optimisation and learning
  if (setR.ok) {
    const goal = adset.promoted_object?.custom_event_type;
    const pixelName = PIXEL_EVENT[goal] || goal;
    const weekly = px.ok ? Number(px.data.events?.[pixelName]) || 0 : null;
    add('info', 'conversion', 'optimisation', `Optimised for ${goal || adset.optimization_goal} on the website (${adset.optimization_goal}, billed per ${adset.billing_event}).`);
    if (weekly !== null) {
      if (weekly < 50) add('warn', 'conversion', 'event_volume', `The pixel saw ${weekly} ${pixelName} events in 7 days across the whole site. Meta wants about 50 optimisation events per week for this one ad set to leave the learning phase.`, 'With a small budget optimise for an event further up the funnel for the first weeks, then move down.');
      else add('ok', 'conversion', 'event_volume', `The pixel saw ${weekly} ${pixelName} events in 7 days.`);
    }
    const ls = adset.learning_stage_info;
    if (ls?.status) add(ls.status === 'FAIL' ? 'warn' : 'info', 'conversion', 'learning', `Learning phase: ${ls.status}${ls.conversions !== undefined ? ` (${ls.conversions} conversions so far)` : ''}.`, ls.status === 'FAIL' ? 'Learning limited: too few conversions for the budget. Raise the budget or move the goal up the funnel.' : '');
    const win = (adset.attribution_spec || []).map((a) => `${a.window_days} day ${String(a.event_type).replace('_THROUGH', '').toLowerCase()}`).join(', ');
    if (win) add('info', 'tracking', 'attribution', `Attribution window: ${win}. Villa bookings often take longer to decide than this, so only your own data (source stored with the booking) shows the whole picture.`);
    const t = adset.targeting || {};
    const countries = t.geo_locations?.countries || [];
    add('info', 'conversion', 'audience', `Countries: ${countries.join(', ') || 'none named'}; age ${t.age_min ?? '?'} to ${t.age_max ?? '?'}${t.age_range ? ` (suggestion ${t.age_range.join(' to ')})` : ''}; Advantage+ audience ${t.targeting_automation?.advantage_audience === 1 ? 'on' : 'off'}; placements ${t.publisher_platforms ? t.publisher_platforms.join(', ') : 'automatic'}.`);
    const hasSignal = (t.custom_audiences || []).length > 0 || (t.flexible_spec || []).length > 0;
    if (!hasSignal) add('warn', 'conversion', 'no_audience_signal', 'No custom audience or interest is given as a signal. Meta starts from nothing and has to find the buyers itself.', 'Add website visitors and a list of past guests as audience signals. Later add a lookalike of past guests.');
    if (!(adset.end_time)) add('info', 'setup', 'end_time', 'The ad set has no end date.');
  }

  // ---- Creative and links
  if (crR.ok) {
    const spec = cr.object_story_spec || {};
    const links = [spec.link_data?.link, ...((spec.link_data?.child_attachments || []).map((c) => c.link)), spec.video_data?.call_to_action?.value?.link].filter(Boolean);
    const utmInLink = links.length > 0 && links.every((l) => /utm_source=/i.test(l));
    if (cr.url_tags || utmInLink) add('ok', 'tracking', 'utm', `URL parameters are set (${cr.url_tags || 'in the link'}).`);
    else add('warn', 'tracking', 'utm', 'The ad has no UTM parameters. Visits and bookings cannot be tied to this ad in your own data.', 'Set URL parameters on the ad: utm_source=facebook&utm_medium=paid_social&utm_campaign={{campaign.name}}&utm_content={{ad.name}} and store them with the booking.');
    const ig = spec.instagram_user_id || spec.instagram_actor_id || cr.instagram_actor_id;
    if (!ig) {
      const accounts = igR.ok ? (igR.data.data || []).map((a) => a.username).filter(Boolean) : [];
      add('warn', 'conversion', 'instagram_identity', `The ad runs under the Facebook page only, without an Instagram account${accounts.length ? ` (the ad account offers: ${accounts.join(', ')})` : ' (the ad account has no Instagram account assigned)'}.`, 'Pick the Instagram account in the ad (Identity). In Business Settings assign it to the ad account so the app finds it next time.');
    } else add('ok', 'conversion', 'instagram_identity', 'The ad runs with the Instagram account.');
    const ctas = (spec.link_data?.child_attachments || []).map((c) => c.call_to_action?.type).filter(Boolean);
    const cta = spec.video_data?.call_to_action?.type || spec.link_data?.call_to_action?.type;
    add(ctas.length || cta ? 'ok' : 'warn', 'conversion', 'cta', ctas.length ? `Button on each card: ${[...new Set(ctas)].join(', ')}.` : cta ? `Button: ${cta}.` : 'No call-to-action button found.');
    const enh = cr.degrees_of_freedom_spec?.creative_features_spec?.standard_enhancements?.enroll_status;
    add('info', 'conversion', 'enhancements', `Meta's automatic enhancements of the creative: ${enh === 'OPT_OUT' ? 'off' : enh || 'default'}. Consider testing them on one variant.`);
    if ((spec.link_data?.child_attachments || []).length === 0 && !spec.video_data) add('info', 'conversion', 'format', 'Single image ad. A carousel and a video usually give Meta more to learn from.');
  }

  // ---- Pixel and events
  if (pxR.ok) {
    const last = pixel.last_fired_time ? Date.parse(pixel.last_fired_time) : null;
    if (pixel.is_unavailable) add('block', 'tracking', 'pixel_unavailable', 'The pixel is marked unavailable.', 'Check the pixel in Events Manager.');
    else if (last && Date.now() - last > 24 * 3600 * 1000) add('warn', 'tracking', 'pixel_fresh', `The pixel last fired ${new Date(last).toISOString()}.`, 'Check that the code is still on the site.');
    else if (last) add('ok', 'tracking', 'pixel_fresh', `The pixel fired recently (${new Date(last).toISOString()}).`);
    if (pixel.enable_automatic_matching === false) add('warn', 'tracking', 'automatic_matching', 'Automatic advanced matching is off. Meta gets no email or phone hash from the browser.', 'Switch it on in Events Manager (Settings) or send the hashes with the events.');
    if (pixel.first_party_cookie_status && !/ENABLED/i.test(pixel.first_party_cookie_status)) add('warn', 'tracking', 'first_party_cookie', `First-party cookie setting: ${pixel.first_party_cookie_status}.`, 'Switch the first-party cookie on in Events Manager.');
  }
  if (px.ok) {
    const e = px.data.events || {};
    const line = ['PageView', 'ViewContent', 'InitiateCheckout', 'AddPaymentInfo', 'Purchase'].map((k) => `${k} ${e[k] || 0}`).join(', ');
    add('info', 'tracking', 'events', `Events in the last 7 days: ${line}.`);
    if (!e.ViewContent) add('warn', 'tracking', 'no_viewcontent', 'No ViewContent event: the villa pages are not reported as product views.', 'Send ViewContent on each villa page with content_ids (villa-patuha and so on) and value.');
    if (!e.AddPaymentInfo) add('info', 'tracking', 'no_paymentinfo', 'No AddPaymentInfo event. One more step in the funnel would show where guests drop out.');
    if (!e.Purchase) add('warn', 'tracking', 'no_purchase', 'No Purchase event yet in 7 days.', 'Send every direct booking from Elev8 as a Purchase through the Conversions API (hashed email and phone, value, currency, event_id), also those that do not come through the website.');
  }
  if (sPii.ok) {
    const keys = Object.keys(statValues(sPii.data));
    const has = (k) => keys.includes(k);
    if (keys.length === 0) add('warn', 'tracking', 'match_keys', 'No customer information (email, phone) arrives with the events. The match quality is low and Meta finds fewer of the buyers.', 'Send hashed email and phone at checkout and with the Purchase, plus fbp and fbc.');
    else add(has('em') && has('ph') ? 'ok' : 'warn', 'tracking', 'match_keys', `Customer information keys seen in 7 days: ${keys.join(', ')}.`, has('em') && has('ph') ? '' : 'Send hashed email and phone as well.');
  }
  if (sMethod.ok) {
    const keys = Object.keys(statValues(sMethod.data));
    const server = keys.some((k) => /server|api|capi/i.test(k));
    add(server ? 'ok' : 'warn', 'tracking', 'server_events', `Events by source in 7 days: ${keys.join(', ') || 'none'}.`, server ? '' : 'No server-side event seen yet. The Purchase through the Conversions API should show up here once a booking is made.');
  }

  // ---- What the ad has done so far
  let summary = null;
  if (insR.ok) {
    const spend = num(ins.spend) || 0;
    const lpv = actionCount(ins.actions, ['landing_page_view', 'omni_landing_page_view']);
    const checkouts = actionCount(ins.actions, ['omni_initiated_checkout', 'offsite_conversion.fb_pixel_initiate_checkout']);
    const purchases = actionCount(ins.actions, ['omni_purchase', 'offsite_conversion.fb_pixel_purchase']);
    const linkClicks = num(ins.inline_link_clicks) || actionCount(ins.actions, ['link_click']);
    summary = { spend, currency: cur, impressions: num(ins.impressions), reach: num(ins.reach), frequency: num(ins.frequency), clicks: num(ins.clicks), linkClicks, ctr: num(ins.ctr), cpc: num(ins.cpc), cpm: num(ins.cpm), landingPageViews: lpv, checkouts, purchases, costPerLandingPageView: lpv ? Math.round((spend / lpv) * 100) / 100 : null, costPerCheckout: checkouts ? Math.round((spend / checkouts) * 100) / 100 : null };
    if (linkClicks >= 30 && lpv / linkClicks < 0.6) add('warn', 'conversion', 'lpv_ratio', `Only ${Math.round((lpv / linkClicks) * 100)} per cent of the link clicks become landing page views. The page loads too slowly or the pixel fires late.`, 'Check the mobile loading time of the landing page.');
  }

  const order = { block: 0, warn: 1, info: 2, ok: 3 };
  checks.sort((a, b) => order[a.level] - order[b.level]);
  return {
    adId: id,
    name: v.name,
    readAt: new Date().toISOString(),
    counts: { block: checks.filter((c) => c.level === 'block').length, warn: checks.filter((c) => c.level === 'warn').length },
    summary,
    checks,
    raw: {
      campaign: campR.ok ? { objective: camp.objective, status: camp.status, effective_status: camp.effective_status, bid_strategy: camp.bid_strategy, daily_budget: camp.daily_budget } : null,
      adset: setR.ok ? { status: adset.status, effective_status: adset.effective_status, optimization_goal: adset.optimization_goal, destination_type: adset.destination_type, promoted_object: adset.promoted_object, attribution_spec: adset.attribution_spec, learning_stage_info: adset.learning_stage_info, targeting: adset.targeting } : null,
      pixelHosts: sHost.ok ? statValues(sHost.data) : null
    },
    unread
  };
}

export function adsAuditRoutes(app, needDb, ah) {
  app.get('/ads/:id/audit', needDb, ah(async (req, res) => res.json(await auditAd(Number(req.params.id)))));
}
