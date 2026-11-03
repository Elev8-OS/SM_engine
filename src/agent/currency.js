// Currency conversion for Lea. Prices are quoted in the currency PriceLabs returns (usually CHF).
// When a guest asks for IDR, EUR, USD ..., Lea converts with a current rate and says "about".
// The booking page converts with its own rate table, so the page and Lea can differ by a little: always indicative.

const TTL_MS = 6 * 3600 * 1000;
const cache = new Map();

const providers = [
  // The same kind of source the website uses for its own currency menu
  {
    name: 'open.er-api.com',
    url: (b) => `https://open.er-api.com/v6/latest/${b}`,
    parse: (j) => (j?.result === 'success' && j.rates ? { rates: j.rates, date: new Date(j.time_last_update_utc || Date.now()).toISOString().slice(0, 10) } : null)
  },
  {
    name: 'frankfurter.dev (ECB)',
    url: (b) => `https://api.frankfurter.dev/v1/latest?base=${b}`,
    parse: (j) => (j?.rates ? { rates: { ...j.rates, [j.base || 'X']: 1 }, date: j.date } : null)
  }
];

export const isCode = (c) => /^[A-Z]{3}$/.test(String(c || ''));

async function getJson(url, fetchFn) {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Rates for one base currency, cached for six hours. A stale table is better than none. */
export async function rateTable(base, { fetchFn = fetch, now = Date.now } = {}) {
  const hit = cache.get(base);
  if (hit && now() - hit.at < TTL_MS) return hit;
  let lastErr;
  for (const p of providers) {
    try {
      const parsed = p.parse(await getJson(p.url(base), fetchFn));
      if (parsed) {
        const v = { ...parsed, source: p.name, at: now() };
        cache.set(base, v);
        return v;
      }
    } catch (e) {
      lastErr = e;
    }
  }
  if (hit) return { ...hit, stale: true };
  throw lastErr || new Error('no rates');
}

/** Three significant digits: 7,153,200 becomes 7,150,000 and 349.2 becomes 349. */
export function niceRound(x) {
  if (!Number.isFinite(x) || x === 0) return 0;
  const mag = Math.floor(Math.log10(Math.abs(x)));
  const step = 10 ** (mag - 2);
  const r = Math.round(x / step) * step;
  return Number(r.toFixed(Math.max(0, 2 - mag)));
}

/** Result of the convert_currency tool. Never throws: a problem comes back as a note the model can act on. */
export async function convert({ amount, from, to } = {}, deps = {}) {
  const a = Number(amount);
  const f = String(from || '').toUpperCase();
  const t = String(to || '').toUpperCase();
  if (!Number.isFinite(a) || a <= 0) return { ok: false, note: 'amount must be a positive number' };
  if (!isCode(f) || !isCode(t)) return { ok: false, note: 'from and to must be 3-letter currency codes, for example CHF and IDR' };
  if (f === t) return { ok: true, amount: a, from: f, to: t, converted: a, rate: 1, note: 'Same currency.' };
  try {
    const table = await rateTable(f, deps);
    const rate = table.rates?.[t];
    if (!Number.isFinite(rate)) return { ok: false, note: `No exchange rate for ${t}. Say that the team confirms the amount in ${t}.` };
    return {
      ok: true,
      amount: a,
      from: f,
      to: t,
      rate,
      rate_date: table.date,
      source: table.source,
      stale: table.stale || undefined,
      converted: niceRound(a * rate),
      note: `Indicative. Say "about" and that the booking page shows the final price in the chosen currency.`
    };
  } catch {
    return { ok: false, note: `Exchange rates are not available right now. Say that the team confirms the amount in ${t}.` };
  }
}
