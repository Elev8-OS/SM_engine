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

/** The ad account: currency, state and spend cap. Money fields come back in minor units (cents). */
export async function accountInfo() {
  const a = await graph('GET', accountId(), { fields: 'name,currency,account_status,disable_reason,spend_cap,amount_spent' });
  const cap = Number(a.spend_cap);
  return {
    id: a.id,
    name: a.name,
    currency: a.currency,
    status: a.account_status, // 1 = active
    disableReason: a.disable_reason ?? null,
    spendCap: cap > 0 ? cap / 100 : null, // 0 means no cap
    amountSpent: Number(a.amount_spent) / 100 || 0
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
