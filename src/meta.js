import { HttpError } from './util.js';

// Small Meta Graph API client for ads. Version is pinned (META_GRAPH_VERSION): Marketing API versions expire after a
// limited time, so check the current one from time to time.
const VERSION = process.env.META_GRAPH_VERSION || 'v25.0';
const GRAPH = 'https://graph.facebook.com';

export const accountId = () => {
  const a = String(process.env.META_AD_ACCOUNT_ID || '').replace(/\s/g, '');
  return a ? (a.startsWith('act_') ? a : `act_${a}`) : '';
};

/** What is set up. Booleans and public ids only, never the token. */
export const metaConfig = () => ({
  version: VERSION,
  token: Boolean(process.env.META_ADS_TOKEN),
  account: accountId(),
  page: Boolean(process.env.META_PAGE_ID),
  instagram: Boolean(process.env.META_IG_USER_ID),
  pixelId: String(process.env.META_PIXEL_ID || '').trim()
});

export async function graph(method, path, params = {}) {
  const token = process.env.META_ADS_TOKEN;
  if (!token) throw new HttpError(409, 'META_ADS_TOKEN is not set');
  const url = new URL(`${GRAPH}/${VERSION}/${String(path).replace(/^\//, '')}`);
  const enc = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
  const init = { method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60000) };
  if (method === 'GET') {
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, enc(v));
  } else {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) body.set(k, enc(v));
    init.body = body;
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  const res = await fetch(url, init);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = json?.error || {};
    const msg = [e.message, e.error_user_title, e.error_user_msg].filter(Boolean).join(' - ');
    throw new HttpError(502, `Meta ${res.status}: ${msg.slice(0, 400) || 'request failed'} (code ${e.code ?? '?'})`);
  }
  return json;
}

// Meta takes and returns budgets in the smallest unit of the account currency ("offset"): 100 for most currencies
// (cents), 1 for currencies without minor units. A wrong factor means a budget off by 100x, so it is not guessed.
// Order of trust:
//   env      META_CURRENCY_OFFSET (set by you once you have checked the budget in Ads Manager)
//   known    currencies where the offset is certain. IDR is 1: the spend limit of the Elevate Villas account reads
//            Rp 11.000.000 in Ads Manager and comes back from the API as 11000000, checked in November 2026.
//   measured lifetime amount_spent (minor units) divided by lifetime spend (insights, major units)
//   assumed  100; an ad is then sent paused, but cannot be switched on until the budget has been confirmed (see ads.js)
const ZERO_DECIMAL = new Set(['IDR', 'JPY', 'KRW', 'VND', 'CLP', 'ISK', 'UGX', 'PYG', 'RWF', 'XAF', 'XOF', 'XPF', 'KMF', 'GNF', 'DJF', 'BIF', 'VUV']);
const TWO_DECIMAL = new Set(['USD', 'EUR', 'CHF', 'GBP', 'AUD', 'CAD', 'NZD', 'SGD', 'HKD', 'SEK', 'NOK', 'DKK']);
const OFFSETS = [1, 10, 100, 1000];

async function currencyOffset(currency, rawSpent) {
  const env = Number(process.env.META_CURRENCY_OFFSET);
  if (OFFSETS.includes(env)) return { offset: env, source: 'env' };
  if (ZERO_DECIMAL.has(currency)) return { offset: 1, source: 'known' };
  if (TWO_DECIMAL.has(currency)) return { offset: 100, source: 'known' };
  if (rawSpent > 0) {
    const ins = await graph('GET', `${accountId()}/insights`, { fields: 'spend', date_preset: 'maximum' }).catch(() => null);
    const spend = Number(ins?.data?.[0]?.spend);
    if (spend > 0) {
      const ratio = rawSpent / spend;
      const snap = OFFSETS.reduce((best, c) => (Math.abs(Math.log(ratio / c)) < Math.abs(Math.log(ratio / best)) ? c : best), OFFSETS[0]);
      if (Math.abs(Math.log(ratio / snap)) < 0.25) return { offset: snap, source: 'measured' };
    }
  }
  return { offset: 100, source: 'assumed' };
}

/** The ad account: currency, state and spend cap. Money fields are converted from Meta's minor units to the account currency. */
export async function accountInfo() {
  const a = await graph('GET', accountId(), { fields: 'name,currency,account_status,disable_reason,spend_cap,amount_spent' });
  const raw = Number(a.amount_spent) || 0;
  const { offset, source } = await currencyOffset(a.currency, raw);
  const cap = Number(a.spend_cap);
  return {
    id: a.id,
    name: a.name,
    currency: a.currency,
    status: a.account_status, // 1 = active
    disableReason: a.disable_reason ?? null,
    spendCap: cap > 0 ? cap / offset : null, // 0 means no cap
    amountSpent: raw / offset,
    offset,
    offsetSource: source
  };
}

/** Events the pixel received in the last days (browser and server together), counted by event name. */
export async function pixelStatus(days = 7) {
  const id = metaConfig().pixelId;
  if (!id) throw new HttpError(409, 'META_PIXEL_ID is not set');
  const info = await graph('GET', id, { fields: 'name,last_fired_time,is_unavailable' });
  const stats = await graph('GET', `${id}/stats`, { aggregation: 'event', start_time: Math.floor(Date.now() / 1000) - days * 86400 }).catch(() => null);
  const events = {};
  for (const bucket of stats?.data || []) for (const e of bucket.data || []) events[e.value] = (events[e.value] || 0) + Number(e.count || 0);
  return { id, name: info.name, lastFired: info.last_fired_time ?? null, unavailable: Boolean(info.is_unavailable), events, statsOk: Boolean(stats) };
}
