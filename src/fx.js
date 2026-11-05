import { HttpError } from './util.js';

// Three currencies are in play in Meta Ads and all three are correct:
//   USD  planning: monthly budget, daily budget, price limits (what you think in)
//   IDR  the Meta ad account (what Meta bills and what it accepts as a budget)
//   CHF  properties and bookings (what a booking is worth)
// Nothing is mixed up silently. Budgets are planned in USD and converted to the account currency when they are sent to Meta
// (and again when an ad is switched on, if the rate moved). Spend coming back from Meta is converted to USD before it is
// compared with a USD limit. Rates: ECB daily rates (frankfurter.dev), fallback open.er-api.com. A rate can be fixed with
// FX_USD_<CUR> (units of that currency per 1 USD, e.g. FX_USD_IDR=16400), which then wins over the live rate.

export const PLAN_CURRENCY = 'USD';
export const PROPERTY_CURRENCY = String(process.env.PROPERTY_CURRENCY || 'CHF').toUpperCase();

const TTL = 6 * 3600 * 1000;
const cache = new Map();

const envRate = (cur) => {
  const n = Number(process.env[`FX_USD_${cur}`]);
  return n > 0 ? n : null;
};

async function fromFrankfurter(symbols) {
  const res = await fetch(`https://api.frankfurter.dev/v1/latest?base=USD&symbols=${symbols.join(',')}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`frankfurter ${res.status}`);
  const j = await res.json();
  if (!j?.rates || symbols.some((s) => !(j.rates[s] > 0))) throw new Error('frankfurter: rate missing');
  return { rates: j.rates, date: j.date || null, source: 'ECB (frankfurter.dev)' };
}

async function fromOpenEr(symbols) {
  const res = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`open.er-api ${res.status}`);
  const j = await res.json();
  if (j?.result !== 'success' || !j.rates || symbols.some((s) => !(j.rates[s] > 0))) throw new Error('open.er-api: rate missing');
  const date = j.time_last_update_unix ? new Date(j.time_last_update_unix * 1000).toISOString().slice(0, 10) : null;
  return { rates: j.rates, date, source: 'open.er-api.com' };
}

/**
 * Units of each currency per 1 USD, for the property currency and the ones asked for.
 * Cached for six hours; if the live sources fail, the last known rate is used and marked stale.
 */
export async function usdRates(currencies = []) {
  const symbols = [...new Set([PROPERTY_CURRENCY, ...currencies].map((c) => String(c || '').toUpperCase()).filter((c) => c && c !== PLAN_CURRENCY))].sort();
  const rates = { USD: 1 };
  const missing = [];
  for (const s of symbols) {
    const e = envRate(s);
    if (e) rates[s] = e;
    else missing.push(s);
  }
  let date = null;
  let source = missing.length ? '' : 'FX_USD env';
  let stale = false;
  if (missing.length) {
    const key = missing.join(',');
    const hit = cache.get(key);
    let data = hit && Date.now() - hit.at < TTL ? hit.data : null;
    if (!data) {
      for (const f of [fromFrankfurter, fromOpenEr]) {
        try {
          data = await f(missing);
          cache.set(key, { at: Date.now(), data });
          break;
        } catch (e) {
          console.error('fx source failed:', e.message);
        }
      }
    }
    if (!data && hit) {
      data = hit.data;
      stale = true;
    }
    if (!data) throw new HttpError(502, `No exchange rate available for ${missing.join(', ')}. Set FX_USD_${missing[0]} (units per 1 USD) as a fixed rate.`);
    for (const s of missing) rates[s] = data.rates[s];
    date = data.date;
    source = data.source;
  }
  return { rates, date, source, stale };
}

const need = (rates, cur) => {
  const r = rates?.[cur];
  if (!(r > 0)) throw new HttpError(502, `No exchange rate for ${cur}`);
  return r;
};

export const toUsd = (amount, cur, rates) => Number(amount) / need(rates, cur);
export const fromUsd = (usd, cur, rates) => Number(usd) * need(rates, cur);

// Budgets in big-unit currencies are rounded to a sensible step; everything else to two decimals.
const STEP = { IDR: 1000, VND: 1000, KRW: 100, JPY: 10, CLP: 100, HUF: 10, COP: 100 };
export function roundBudget(amount, cur) {
  const step = STEP[cur];
  return step ? Math.max(step, Math.round(amount / step) * step) : Math.round(amount * 100) / 100;
}

export function fmtMoney(amount, cur) {
  const big = Boolean(STEP[cur]) && STEP[cur] >= 10;
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: cur, maximumFractionDigits: big ? 0 : 2 }).format(amount);
  } catch {
    return `${Math.round(amount * 100) / 100} ${cur}`;
  }
}

/** What the app shows: the rates behind every converted figure. */
export function fxView(fx, accountCurrency) {
  return {
    plan: PLAN_CURRENCY,
    account: accountCurrency || null,
    property: PROPERTY_CURRENCY,
    usdToAccount: accountCurrency ? (fx.rates[accountCurrency] ?? null) : null,
    usdToProperty: fx.rates[PROPERTY_CURRENCY] ?? null,
    date: fx.date ?? null,
    source: fx.source ?? null,
    stale: Boolean(fx.stale),
    error: fx.error ?? null
  };
}
