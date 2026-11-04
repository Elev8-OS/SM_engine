// Pure rules for promotions ("Aktionen" in the SM Manager). No database and no network, so they are easy to test.
// A promotion is a code the team created by hand in Elev8, with its terms in free text and an optional window.
const DAY = 86400000;

export const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
export const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const nightsOf = (ci, co) => Math.round((Date.parse(`${co}T00:00:00Z`) - Date.parse(`${ci}T00:00:00Z`)) / DAY);

export const STATUSES = ['draft', 'active', 'ended'];
export const normaliseCode = (c) => String(c ?? '').replace(/\s+/g, '').toUpperCase();
const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,23}$/;

/** Cleans the fields that came in. Only fields that are present are returned. Throws a readable error. */
export function cleanPromo(body = {}, { create = false } = {}) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  if (create || has('property_key')) {
    const k = String(body.property_key ?? '').trim().toLowerCase();
    if (!/^[a-z0-9_-]{2,40}$/.test(k)) throw new Error('Choose a villa, or all villas');
    out.property_key = k;
  }
  if (create || has('title')) {
    const t = String(body.title ?? '').trim();
    if (!t) throw new Error('A title is required');
    if (t.length > 120) throw new Error('The title is too long (120 characters at most)');
    out.title = t;
  }
  if (has('code')) {
    const c = normaliseCode(body.code);
    if (c && !CODE_RE.test(c)) throw new Error('The code may only contain letters, digits, - and _ (3 to 24 characters)');
    out.code = c;
  }
  if (has('terms')) {
    const t = String(body.terms ?? '').trim();
    if (t.length > 1000) throw new Error('The terms are too long (1000 characters at most)');
    out.terms = t;
  }
  for (const k of ['stay_from', 'stay_to', 'book_until']) {
    if (!has(k)) continue;
    const v = body[k];
    if (v === null || v === undefined || v === '') out[k] = null;
    else if (isDate(v)) out[k] = String(v);
    else throw new Error(`${k} must be a date (YYYY-MM-DD)`);
  }
  if (has('min_nights')) {
    const v = body.min_nights;
    if (v === null || v === undefined || v === '') out.min_nights = null;
    else {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 60) throw new Error('The minimum stay must be a whole number from 1 to 60');
      out.min_nights = n;
    }
  }
  if (has('status')) {
    if (!STATUSES.includes(body.status)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
    out.status = body.status;
  }
  if (has('note')) out.note = String(body.note ?? '').trim().slice(0, 500);
  if (has('suggestion_id')) out.suggestion_id = String(body.suggestion_id ?? '').trim().slice(0, 80);
  return out;
}

/** Checks the whole promotion after a change is merged in. Returns an error text or null. */
export function problem(p) {
  if (p.stay_from && p.stay_to && p.stay_to < p.stay_from) return 'The stay window ends before it starts';
  if (p.status === 'active') {
    if (!p.code) return 'An active promotion needs a code';
    if (!String(p.terms || '').trim()) return 'An active promotion needs its terms, so Lea and the posts know what the code means';
  }
  return null;
}

/** Running right now: active, has code and terms, and neither the last booking day nor the last stay day has passed. */
export function isLive(p, today) {
  if (!p || p.status !== 'active' || !p.code || !String(p.terms || '').trim()) return false;
  if (p.book_until && today > p.book_until) return false;
  if (p.stay_to && today > p.stay_to) return false;
  return true;
}

/** Does a stay of a villa qualify? Returns { ok } or { ok: false, why }. */
export function appliesTo(p, key, checkIn, checkOut) {
  if (p.property_key !== 'all' && p.property_key !== key) return { ok: false, why: 'This code is for another villa.' };
  if (p.stay_from && checkIn < p.stay_from) return { ok: false, why: `This code is for stays from ${p.stay_from}.` };
  if (p.stay_to && checkOut > p.stay_to) return { ok: false, why: `This code is for stays that end by ${p.stay_to}.` };
  if (p.min_nights && nightsOf(checkIn, checkOut) < p.min_nights) return { ok: false, why: `This code needs at least ${p.min_nights} nights.` };
  return { ok: true };
}

/** What Lea and the post generator see of a promotion. */
export const promoView = (p) => ({
  code: p.code,
  terms: p.terms,
  villa: p.property_key,
  stay_from: p.stay_from || undefined,
  stay_to: p.stay_to || undefined,
  book_until: p.book_until || undefined,
  min_nights: p.min_nights || undefined
});

/** Lines for the post prompt. Without a live promotion the model is told to mention no offer at all. */
export function promoPromptBlock(promotions) {
  if (!promotions?.length) return ['', 'OFFERS: No promotion is active. Do not mention any discount, promo code, free extra or special offer.'];
  const window = (p) => [p.stay_from && `stays from ${p.stay_from}`, p.stay_to && `stays ending by ${p.stay_to}`, p.min_nights && `at least ${p.min_nights} nights`, p.book_until && `book by ${p.book_until}`].filter(Boolean).join(', ');
  return [
    '',
    'ACTIVE PROMOTION (the only offer you may mention):',
    ...promotions.map((p) => `- ${p.villa === 'all' ? 'all villas' : p.villa}: code ${p.code}. Terms: ${p.terms}${window(p) ? ` (${window(p)})` : ''}`),
    'Rules for the offer: name it at most once and only in the Instagram caption, never in the slide or video text. Say the benefit exactly as the terms say. Do not change, extend or combine it. No other discounts, free extras or percentages.'
  ];
}

const OFFER_RE = /(promo(?:tion)?\s*code|\bcode\b|discount|\d+\s?%\s*off|rabatt|gratis|free\s+(?:early|late|airport|transfer|breakfast|upgrade|night|massage|cancell)|complimentary|special offer)/i;

/** Warnings on offer wording in generated copy. Advisory: a person decides. */
export function checkPromoCopy(copy, plan) {
  const promos = plan?.promotions || [];
  const captions = Object.values(copy?.captions || {}).join(' \n ');
  const slides = [copy?.hook, copy?.subhook, ...(copy?.lines || []).flatMap((l) => [l?.headline, l?.sub]), copy?.endCard?.title, copy?.endCard?.subtitle].filter(Boolean).join(' \n ');
  const all = `${captions} \n ${slides}`;
  const warnings = [];
  if (!promos.length) {
    const m = all.match(OFFER_RE);
    if (m) warnings.push(`Offer wording without an active promotion: "${m[0]}"`);
    return warnings;
  }
  const codes = new Set(promos.map((p) => p.code));
  for (const m of all.matchAll(/\bcode[:\s]+["\u201c']?([A-Za-z0-9_-]{3,24})/gi)) {
    if (m[1] !== m[1].toUpperCase()) continue; // "code for you" is words, not a code
    if (!codes.has(m[1])) warnings.push(`Promo code not in the active promotions: ${m[1]}`);
  }
  for (const c of codes) if (slides.toUpperCase().includes(c)) warnings.push(`Promo code ${c} appears in the slide or video text, it belongs in the caption only`);
  const termsText = promos.map((p) => p.terms).join(' ');
  for (const m of all.matchAll(/(\d{1,2})\s?%\s*(?:off|discount|rabatt)/gi)) if (!termsText.includes(`${m[1]}%`) && !termsText.includes(`${m[1]} %`)) warnings.push(`Percentage not in the promotion terms: ${m[0]}`);
  return warnings;
}

// ---- Suggestions from the open nights in Elev8 ----

const short = (name) => String(name || '').replace(/^The R Villa\s+/i, '').toLowerCase();

/** Open nights per property of the SM Manager from Elev8's upcoming gaps. Several units of a property are added up. */
export function matchGaps(results, props, days) {
  const out = [];
  for (const p of props) {
    const needle = String(p.key || '').toLowerCase() || short(p.name);
    const hits = (results || []).filter((r) => String(r.listing_name || '').toLowerCase().includes(needle));
    if (!hits.length) continue;
    const open = hits.reduce((a, r) => a + (Number(r.unbooked_nights) || 0), 0);
    out.push({
      property_key: p.key,
      name: p.name,
      guests: p.guests ?? null,
      units: hits.length,
      open_nights: open,
      share: Math.min(1, open / (days * hits.length)),
      first_gap_date: hits.map((r) => r.first_gap_date).filter(Boolean).sort()[0] || null
    });
  }
  return out;
}

/**
 * Ideas for promotions where many nights are free. Each idea names a kind and a benefit (the texts are written in Orbit),
 * a stay window, a last booking day and a minimum stay. The team decides, enters the code made in Elev8 and the terms.
 */
export function suggest(gaps, today, days = 60) {
  const out = [];
  for (const g of gaps) {
    const base = { property_key: g.property_key, name: g.name, units: g.units, open_nights: g.open_nights, share: Math.round(g.share * 100) / 100, first_gap_date: g.first_gap_date, days };
    const from = (n) => (g.first_gap_date && g.first_gap_date > addDays(today, n) ? g.first_gap_date : addDays(today, n));
    const big = (g.guests ?? 0) >= 6;
    if (g.share >= 0.75) {
      out.push({ ...base, id: `${g.property_key}-short_notice`, type: 'short_notice', benefit: 'early_checkin', min_nights: null, stay_from: from(2), stay_to: addDays(today, 45), book_until: addDays(today, 21) });
    } else if (g.share >= 0.5) {
      out.push({ ...base, id: `${g.property_key}-long_stay`, type: 'long_stay', benefit: big ? 'transfer_van' : 'transfer_car', min_nights: 5, stay_from: from(7), stay_to: addDays(today, days), book_until: addDays(today, 28) });
    } else if (g.share >= 0.3) {
      out.push({ ...base, id: `${g.property_key}-extras`, type: 'extras', benefit: 'late_checkout', min_nights: 3, stay_from: from(3), stay_to: addDays(today, days), book_until: addDays(today, 14) });
    }
    if (g.share >= 0.5 && g.guests != null && g.guests <= 4) {
      out.push({ ...base, id: `${g.property_key}-couples`, type: 'couples', benefit: 'romantic', min_nights: 5, stay_from: from(7), stay_to: addDays(today, days), book_until: addDays(today, 28) });
    }
  }
  return out.sort((a, b) => b.share - a.share || b.open_nights - a.open_nights);
}
