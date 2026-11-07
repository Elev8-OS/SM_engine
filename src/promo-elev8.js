import { q, dbEnabled } from './db.js';
import { normaliseCode, matchGaps, suggest } from './promo-rules.js';
import { factsFor } from './facts.js';
import { usdRates } from './fx.js';
import { convertAmount } from './wacatalog-core.js';

// Promo codes: Elev8 (the booking website) and the engine, kept in line.
//
// 1. Mirror. Every code that is active in Elev8 is mirrored into the promotions of the SM Manager and is active there at once
//    (checked every 5 minutes). Elev8 is the only place where a person creates a code. Code, terms and dates of a mirrored
//    promotion cannot be changed in the SM Manager, and its status follows Elev8. Codes that are expired, switched off, used up,
//    single-use vouchers (personal text) or look like test codes (PROMO_MIRROR_SKIP_PATTERN) are not mirrored.
// 2. Planner. The engine proposes promotions itself, from the open nights of each property. It only offers what fits the property
//    (a romantic package is never offered for a shared villa), only what exists for that property in Elev8, and only what is
//    affordable: the cost of the benefit may not be more than PROMO_MAX_COST_SHARE (10 %) of the cheapest booking the promotion
//    allows. If a benefit is too dear for a short stay, the engine asks for a longer minimum stay; if even seven nights are not
//    enough, it does not offer it. Several promotions can run at the same time, up to PROMO_MAX_PER_VILLA (4) per property, as long
//    as they give different things. A proposal is a draft with its reasoning. With PROMO_AUTOPILOT=on the engine switches its
//    proposals on by itself; otherwise a person switches a proposal on in the SM Manager.
// 3. Writing. When a proposal is switched on, the engine creates the code in Elev8 (create_promo_code) and checks that it
//    arrived. From then on it is a mirrored promotion. Elev8 offers no tool to change or switch off a code, so the engine never
//    does: that is done in Elev8.

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,23}$/;
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const today = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const on = (v) => /^(true|1|yes|on)$/i.test(String(v || '').replace(/["'\s]/g, ''));
const off = (v) => /^(off|false|0|no)$/i.test(String(v || '').replace(/["'\s]/g, ''));
const num = (v, d) => (Number(v) > 0 ? Number(v) : d);

// ---------------------------------------------------------------------------------------------------------------------------
// Mirror of the codes of Elev8

/** "2026-12-20 to 2027-01-02" -> { from, to }. Anything else is an open window. */
export function parseWindow(s) {
  const m = /(\d{4}-\d{2}-\d{2})\s*(?:to|-|\u2013)\s*(\d{4}-\d{2}-\d{2})/.exec(String(s || ''));
  return m && isDate(m[1]) && isDate(m[2]) ? { from: m[1], to: m[2] } : { from: null, to: null };
}

/** Minimum nights written in the terms ("min. 3 nights", "minimum 3 night stay"). Null when the text names none. */
export function minNightsFrom(text) {
  const m = /\bmin(?:imum|\.)?\s*(?:of\s*)?(\d{1,2})[\s-]*nights?\b/i.exec(String(text || ''));
  const n = m ? Number(m[1]) : null;
  return n >= 1 && n <= 60 ? n : null;
}

/** One line that says what the code gives, from the structured fields of Elev8. */
export function benefitLine(e) {
  if (e.discount_kind === 'percentage' && Number(e.percentage_discount) > 0) return `${Number(e.percentage_discount)}% discount`;
  if (e.discount_kind === 'fixed_amount' && Number(e.discount_amount) > 0) return `${Number(e.discount_amount)} ${String(e.currency || '').trim()} discount`.replace(/\s+discount$/, ' discount');
  if (e.discount_kind === 'free_upsell' && e.grants) {
    const [category, item] = String(e.grants).split(' / ').map((s) => s.trim());
    return item ? `Free: ${item} (${category.replace(/\s+/g, ' ')})` : `Free: ${category}`;
  }
  return '';
}

/** Terms text for Lea and the posts: the benefit line, then the description of Elev8 on one line, at most 1000 characters. */
export function termsFor(e) {
  const desc = String(e.description || '').replace(/\s+/g, ' ').trim();
  const text = [benefitLine(e), desc].filter(Boolean).join('. ').replace(/\.\s*\./g, '.') || 'Promotion code';
  return text.length > 1000 ? `${text.slice(0, 990).replace(/\s+\S*$/, '')}...` : text;
}

/**
 * Properties a code does not apply to, when the description says so. "only for private villas, not valid for the sharing villa
 * (Merapi)" leaves out the shared villa and the apartments.
 */
export function exclusionsFor(description) {
  const d = String(description || '');
  return /private villa/i.test(d) && /not valid for[^.\n]*\b(sharing|shared|merapi)\b/i.test(d) ? ['merapi', 'apartments'] : [];
}

const matchesListing = (text, key) => (key === 'apartments' ? /apartment/i.test(text) : text.toLowerCase().includes(String(key).toLowerCase()));
const skipRe = () => {
  try {
    return new RegExp(process.env.PROMO_MIRROR_SKIP_PATTERN || '^(test|testing|check|demo)', 'i');
  } catch {
    return /^(test|testing|check|demo)/i;
  }
};

/**
 * One code of Elev8 as promotions of the SM Manager. Returns { skip } for a code that is not mirrored, else
 * { code, ended, expired, rows }: ended = switched off or used up in Elev8, expired = a window has passed.
 * propKeys: the keys of the properties of the SM Manager.
 */
export function mapElev8Promo(e, propKeys, day = today(), testRe = skipRe()) {
  const code = normaliseCode(e?.promo_code);
  if (!CODE_RE.test(code)) return { code, skip: 'code cannot be used in the SM Manager' };
  if (testRe.test(code) || testRe.test(String(e.name || ''))) return { code, skip: 'looks like a test code, not mirrored' };
  const quota = Number(e.quota);
  if (quota > 0 && quota <= 1) return { code, skip: 'single-use voucher, not mirrored' };
  const book = parseWindow(e.booking_windows);
  const stay = parseWindow(e.stay_windows);
  const remaining = e.remaining_quota === null || e.remaining_quota === undefined || e.remaining_quota === '' ? null : Number(e.remaining_quota);
  const ended = e.status !== 'active' || (remaining !== null && remaining <= 0);
  const expired = Boolean((book.to && day > book.to) || (stay.to && day > stay.to));
  const listings = String(e.listings || '').trim();
  let keys = null; // null: all properties
  if (listings) {
    keys = propKeys.filter((k) => matchesListing(listings, k));
    if (!keys.length) return { code, skip: 'its listings are not known in the SM Manager' };
  } else {
    const out = exclusionsFor(e.description);
    if (out.length) keys = propKeys.filter((k) => !out.includes(k));
  }
  const common = { title: String(e.name || code).slice(0, 120), code, terms: termsFor(e), stay_from: stay.from, stay_to: stay.to, book_until: book.to, min_nights: minNightsFrom(e.description) };
  const rows = keys === null ? [{ ...common, external_id: `elev8:${code}`, property_key: 'all' }] : keys.map((k) => ({ ...common, external_id: `elev8:${code}:${k}`, property_key: k }));
  return { code, ended, expired, rows };
}

let schemaReady = null;
function ensureExtras() {
  schemaReady ??= (async () => {
    await q('alter table promos add column if not exists external_id text');
    await q('alter table promos add column if not exists spec jsonb');
    await q('create unique index if not exists promos_external_id_idx on promos (external_id) where external_id is not null');
  })().catch((err) => {
    schemaReady = null;
    throw err;
  });
  return schemaReady;
}

const ROW = `id, created_at, updated_at, property_key, title, code, terms, stay_from::text as stay_from, stay_to::text as stay_to, book_until::text as book_until, min_nights, status, source, suggestion_id, note`;

/** Reads the codes of Elev8 and brings the mirrored promotions in line. Returns what it did. */
export async function mirrorElev8Promos({ ensureSchema }) {
  await ensureSchema();
  await ensureExtras();
  const day = today();
  const { elev8Tool } = await import('./agent/clients.js');
  const r = await elev8Tool('list_promo_codes', { website: '' });
  const list = r?.results;
  if (!Array.isArray(list)) throw new Error('Elev8 returned no list of promo codes');
  const propKeys = (await q('select key from properties')).map((x) => x.key);
  const out = { at: new Date().toISOString(), seen: list.length, created: [], updated: [], ended: [], skipped: [] };
  const wanted = [];
  for (const e of list) {
    const m = mapElev8Promo(e, propKeys, day);
    if (m.skip) {
      out.skipped.push(`${m.code || e.promo_code}: ${m.skip}`);
      continue;
    }
    const status = m.ended || m.expired ? 'ended' : 'active';
    for (const row of m.rows) {
      wanted.push(row.external_id);
      const [ex] = await q('select id, status from promos where external_id = $1', [row.external_id]);
      if (ex) {
        // Everything follows Elev8, the status too.
        const upd = await q(
          `update promos set property_key = $2, title = $3, code = $4, terms = $5, stay_from = $6::date, stay_to = $7::date, book_until = $8::date, min_nights = $9, status = $10, source = 'elev8', updated_at = now()
           where id = $1 and (property_key, title, code, terms, stay_from, stay_to, book_until, min_nights, status, source) is distinct from ($2::text, $3::text, $4::text, $5::text, $6::date, $7::date, $8::date, $9::int, $10::text, 'elev8'::text) returning id`,
          [ex.id, row.property_key, row.title, row.code, row.terms, row.stay_from, row.stay_to, row.book_until, row.min_nights, status]
        );
        if (upd.length) (status === 'ended' && ex.status !== 'ended' ? out.ended : out.updated).push(`${row.code} (${row.property_key})`);
        continue;
      }
      if (status === 'ended') {
        out.skipped.push(`${m.code}: ${m.ended ? 'switched off or used up' : 'a window has passed'}, not mirrored`);
        continue;
      }
      // A legacy promotion with the same code is taken over, so it does not appear twice.
      const [adopt] = await q("select id from promos where upper(code) = $1 and external_id is null and source <> 'elev8' and property_key = $2 limit 1", [row.code, row.property_key]);
      if (adopt) {
        await q(
          `update promos set external_id = $2, source = 'elev8', title = $3, terms = $4, stay_from = $5::date, stay_to = $6::date, book_until = $7::date, min_nights = $8, status = 'active', updated_at = now() where id = $1`,
          [adopt.id, row.external_id, row.title, row.terms, row.stay_from, row.stay_to, row.book_until, row.min_nights]
        );
        out.updated.push(`${row.code} (${row.property_key}, taken over)`);
        continue;
      }
      await q(
        `insert into promos (property_key, title, code, terms, stay_from, stay_to, book_until, min_nights, status, source, suggestion_id, note, external_id)
         values ($1,$2,$3,$4,$5::date,$6::date,$7::date,$8,'active','elev8',null,$9,$10)`,
        [row.property_key, row.title, row.code, row.terms, row.stay_from, row.stay_to, row.book_until, row.min_nights, `From Elev8 (code ${row.code}). Change or switch it off there.`, row.external_id]
      );
      out.created.push(`${row.code} (${row.property_key})`);
    }
  }
  // Mirrored promotions whose code is gone from Elev8 (or is no longer mirrored, for example a test code) end here.
  const gone = await q("update promos set status = 'ended', updated_at = now() where source = 'elev8' and external_id is not null and status <> 'ended' and not (external_id = any($1::text[])) returning code, property_key", [wanted]);
  for (const g of gone) out.ended.push(`${g.code} (${g.property_key}, no longer mirrored)`);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------
// What the engine may offer, and for which kind of property

// Each benefit names the service in Elev8 (type and item) that the code gives away, and the wording for the guest.
export const BENEFITS = {
  early_checkin: { upsellType: 'Early Check-in', item: /^2 hours?$/i, label: 'Complimentary early check-in (2 hours)' },
  late_checkout: { upsellType: 'Late Check-out', item: /^2 hours?$/i, label: 'Complimentary late check-out (2 hours)' },
  transfer_car: { upsellType: 'Airport Transport', item: /7-?seater/i, label: 'Complimentary one-way airport transfer (7-seater car, up to 4 guests)' },
  transfer_van: { upsellType: 'Airport Transport', item: /hiace/i, label: 'Complimentary one-way airport transfer (Toyota Hiace, for larger groups)' },
  spa: { upsellType: 'SPA', item: /balinese full body/i, label: 'Complimentary Balinese full-body massage in the villa' },
  breakfast: { upsellType: 'Private Chef', item: /^floating breakfast the american$/i, label: 'Complimentary floating breakfast for two' },
  romantic: { upsellType: 'Misc', upsellName: /romantic escape/i, item: /./, label: 'Complimentary Romantic Escape package' }
};

// What a benefit is, regardless of the exact item: two promotions of the same group give the same thing.
const GROUP = { early_checkin: 'early', late_checkout: 'late', transfer_car: 'transfer', transfer_van: 'transfer', spa: 'spa', breakfast: 'breakfast', romantic: 'romantic' };

/** The group of a benefit written in the terms of a promotion (from Elev8 or from the engine), or ''. */
export function groupOfText(text) {
  const t = String(text || '');
  if (/early check-?in/i.test(t)) return 'early';
  if (/late check-?out/i.test(t)) return 'late';
  if (/airport (?:transfer|transport)/i.test(t)) return 'transfer';
  if (/romantic/i.test(t)) return 'romantic';
  if (/massage|\bspa\b/i.test(t)) return 'spa';
  if (/breakfast/i.test(t)) return 'breakfast';
  return '';
}

// What fits which kind of property, best first. A romantic package does not fit a shared villa, a minibus does not fit a couple's villa.
export const FIT = {
  villa_small: ['romantic', 'spa', 'breakfast', 'late_checkout', 'early_checkin', 'transfer_car'], // up to 4 guests
  villa_large: ['transfer_van', 'late_checkout', 'early_checkin', 'spa'], // 5 guests and more
  apartment: ['early_checkin', 'late_checkout', 'spa', 'transfer_car'],
  shared: ['early_checkin', 'late_checkout', 'transfer_car']
};

/** The kind of a property of the SM Manager: villa_small, villa_large, apartment or shared. */
export function kindOf(key, guests) {
  if (key === 'merapi') return 'shared';
  if (key === 'apartments') return 'apartment';
  return Number(guests) >= 5 ? 'villa_large' : 'villa_small';
}

const ALTERNATIVES = { romantic: ['spa', 'late_checkout'], transfer_van: ['late_checkout', 'early_checkin'], transfer_car: ['late_checkout', 'early_checkin'], spa: ['late_checkout'], breakfast: ['late_checkout'] };
const FALLBACK = ['late_checkout', 'early_checkin', 'transfer_car'];

/** The benefits to try for a wish, best first: the wish itself when it fits, then what fits instead. */
export function candidates(wanted, kind) {
  const allowed = FIT[kind] || [];
  const order = [wanted, ...(ALTERNATIVES[wanted] || FALLBACK)];
  return order.filter((b, i) => allowed.includes(b) && order.indexOf(b) === i);
}

const TYPE_REASON = {
  short_notice: 'Most nights are still open at short notice, so a small extra can tip a quick decision.',
  long_stay: 'Half of the nights are open. A transfer rewards stays of five nights or more.',
  extras: 'A third of the nights are open. A small extra helps the dates that are still free.',
  couples: 'Many nights are open and the property suits couples.'
};

/** The text the guest reads in Elev8 (500 characters at most). */
export function guestTerms({ benefit, min_nights, stay_from, stay_to, book_until }) {
  const parts = [`Thank you for booking directly with us! You are entitled to: ${BENEFITS[benefit].label.replace(/^Complimentary /, '')}.`];
  if (min_nights) parts.push(`Valid for stays of at least ${min_nights} nights.`);
  const win = [stay_from && stay_to ? `stays from ${stay_from} to ${stay_to}` : stay_to ? `stays until ${stay_to}` : '', book_until ? `book by ${book_until}` : ''].filter(Boolean).join(', ');
  if (win) parts.push(`Valid for ${win}.`);
  parts.push('Non-transferable, no cash value, not combinable with other promotions or discounted rates.');
  return parts.join(' ').slice(0, 500);
}

/**
 * Does a promotion pay for itself? The cost of the benefit may not be more than `share` (10 %) of the cheapest booking it allows:
 * minNights (or `assumed` nights when there is no minimum) at the cheapest nightly rate. If it is too dear for that, the
 * minimum stay is raised to the shortest stay where it fits; if that takes more than `cap` nights the promotion is not offered.
 * Pure. cost and nightly in the same currency.
 */
export function costCheck({ cost, nightly, minNights = null, share = 0.1, assumed = 2, cap = 7 }) {
  if (!(cost > 0) || !(nightly > 0)) return { ok: false, why: 'no price to check the cost against' };
  const nights = minNights || assumed;
  if (cost <= share * nightly * nights) return { ok: true, minNights, nights, ratio: cost / (nightly * nights), raised: false };
  const need = Math.ceil(cost / (share * nightly));
  if (need > cap) return { ok: false, why: `the cost would be more than ${Math.round(share * 100)} % of a booking up to ${cap} nights` };
  return { ok: true, minNights: Math.max(need, minNights || 0), nights: need, ratio: cost / (nightly * need), raised: true };
}

/**
 * Proposals from the suggestions (open nights per property). Pure: no network. Several promotions may run at the same time, also
 * for one property, up to maxPerVilla engine promotions per property and maxOpen in all, as long as they give different things:
 * a benefit that a running or proposed promotion for the same dates already gives (same group) is not proposed again.
 * Only a benefit that fits the kind of property is proposed. After the main idea of a property, further fitting benefits follow
 * for the same open dates, until maxPerVilla is reached.
 * props: { key, name, guests }. existing: promotions that are not ended { property_key, source, status, stay_from, stay_to, terms }.
 */
export function planProposals({ suggestions, props, existing, maxOpen = 40, maxPerVilla = 4 }) {
  const proposals = [];
  const skipped = [];
  const live = existing.filter((p) => p.status === 'draft' || p.status === 'active');
  const engineOpen = (key) => live.filter((p) => p.source === 'engine' && (!key || p.property_key === key)).length;
  let open = engineOpen();
  const overlaps = (p, from, to) => (!p.stay_to || !from || p.stay_to >= from) && (!p.stay_from || !to || p.stay_from <= to);
  const offered = (key, from, to) => new Set(live.filter((p) => (p.property_key === 'all' || p.property_key === key) && overlaps(p, from, to)).map((p) => groupOfText(p.terms)).filter(Boolean));
  const roundCount = new Map();
  const roundGroups = new Map();
  const filled = new Set();
  const count = (key) => engineOpen(key) + (roundCount.get(key) || 0);
  for (const s of suggestions) {
    const prop = props.find((p) => p.key === s.property_key);
    if (!prop) continue;
    const kind = kindOf(prop.key, prop.guests);
    if (kind === 'shared' && s.type === 'couples') continue; // a shared villa is not sold to couples as a package
    if (count(prop.key) >= maxPerVilla) {
      skipped.push(`${prop.name}: ${maxPerVilla} engine promotions are open already`);
      continue;
    }
    if (open >= maxOpen) {
      skipped.push(`${prop.name}: limit of ${maxOpen} open engine promotions reached`);
      continue;
    }
    const fitting = candidates(s.benefit, kind);
    if (!fitting.length) {
      skipped.push(`${prop.name}: no benefit fits this property`);
      continue;
    }
    const already = offered(prop.key, s.stay_from, s.stay_to);
    const proposedHere = roundGroups.get(prop.key) || new Set();
    const options = fitting.filter((b) => !already.has(GROUP[b]) && !proposedHere.has(GROUP[b]));
    const base = { property_key: prop.key, name: prop.name, kind, stay_from: s.stay_from, stay_to: s.stay_to, book_until: s.book_until };
    const nights = `${Math.min(s.open_nights, s.days * Math.max(s.units, 1))} of ${s.days * Math.max(s.units, 1)} nights are free in the next ${s.days} days (${Math.round(s.share * 100)} %).`;
    if (options.length) {
      proposedHere.add(GROUP[options[0]]);
      roundGroups.set(prop.key, proposedHere);
      roundCount.set(prop.key, (roundCount.get(prop.key) || 0) + 1);
      open += 1;
      proposals.push({ ...base, options, type: s.type, min_nights: s.min_nights, reason: `${nights} ${TYPE_REASON[s.type] || ''}`.trim() });
    } else {
      skipped.push(`${prop.name}: the main idea is offered for these dates already`);
    }
    // Further extras for the same dates: guests value different things, and each one is cheap.
    if (!filled.has(prop.key)) {
      filled.add(prop.key);
      for (const b of FIT[kind] || []) {
        if (count(prop.key) >= maxPerVilla || open >= maxOpen) break;
        if (already.has(GROUP[b]) || (roundGroups.get(prop.key) || new Set()).has(GROUP[b])) continue;
        const set = roundGroups.get(prop.key) || new Set();
        set.add(GROUP[b]);
        roundGroups.set(prop.key, set);
        roundCount.set(prop.key, (roundCount.get(prop.key) || 0) + 1);
        open += 1;
        proposals.push({ ...base, options: [b], type: 'extras', min_nights: null, reason: `${nights} A further extra for the same open dates: guests value different things.` });
      }
    }
  }
  return { proposals, skipped };
}

const ABBR = { early_checkin: 'EARLY', late_checkout: 'LATE', transfer_car: 'RIDE', transfer_van: 'VAN', spa: 'SPA', breakfast: 'BRKFST', romantic: 'ROMANCE' };

/** A code that is not taken yet: VILLA-BENEFIT-MMDD, 24 characters at most. */
export function makeCode(key, benefit, day, taken) {
  const base = `${String(key).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)}-${ABBR[benefit] || 'GIFT'}-${day.slice(5, 7)}${day.slice(8, 10)}`;
  let code = base;
  for (let i = 0; taken.has(code) && i < 20; i++) code = `${base}${String.fromCharCode(66 + i)}`;
  return code;
}

// A property of the SM Manager that is several units in Elev8: how to find its listings.
const UNITS = { apartments: { query: 'apartment', test: /apartment/i }, merapi: { query: 'merapi', test: /merapi/i } };

/**
 * The service in Elev8 behind a benefit for a property, or null. Only guest-facing services count (not the internal ones).
 * A villa is one listing in Elev8. The apartments and the shared villa are several: then every unit must offer the service, with
 * the same name and item, because the code names the service by its name for all of them.
 * cache: a Map that keeps the services of a property for one planner round (the answer of Elev8 is large).
 */
export async function resolveBenefit(key, benefit, cache = new Map()) {
  const def = BENEFITS[benefit];
  if (!def) return null;
  const multi = UNITS[key];
  if (!cache.has(key)) {
    const { elev8Tool } = await import('./agent/clients.js');
    cache.set(key, elev8Tool('get_listing_upsells', { listing_id: '', listing_name: multi ? multi.query : key, listing_tag: '' }));
  }
  const r = await cache.get(key);
  let rows = (r?.results || []).filter((x) => x.item_status === 1);
  if (multi) rows = rows.filter((x) => multi.test.test(`${x.listing_name} ${x.internal_name}`));
  const ids = [...new Set(rows.map((x) => x.listing_id))];
  if (!ids.length || (!multi && ids.length !== 1)) return null;
  const offers = (x) => !x.is_internal && String(x.upsell_type).toLowerCase() === def.upsellType.toLowerCase() && def.item.test(String(x.item_title)) && (!def.upsellName || def.upsellName.test(String(x.upsell_name)));
  const hits = ids.map((id) => rows.find((x) => x.listing_id === id && offers(x)));
  if (hits.some((h) => !h)) return null;
  const h0 = hits[0];
  if (multi && !hits.every((h) => String(h.upsell_name).trim() === String(h0.upsell_name).trim() && String(h.item_title).trim() === String(h0.item_title).trim())) return null;
  return {
    listings: ids,
    // one listing: the ids, which are exact. Several: the names, which are the same for all of them.
    upsell: multi ? h0.upsell_name : h0.upsell_id,
    upsell_item: multi ? h0.item_title : h0.item_id,
    upsell_name: String(h0.upsell_name).trim(),
    item_title: String(h0.item_title).trim(),
    price: h0.item_price,
    currency: h0.currency
  };
}

// The PriceLabs listings (channex ids) of the properties that are not in PRICELABS_LISTINGS (the same ones as in wacatalog.js).
const PL_EXTRA = {
  bratan: ['60e9b31b-1313-45b9-9c61-13f9f5cc8cf4___7f7206ac-8595-40c4-8fca-c1394d350745'],
  tambora: ['a34cc21d-f853-488e-ba11-a42902a6b0aa___254a15a0-f81a-45a1-8bed-60b445933f81'],
  apartments: ['49f64992-d0c0-4566-9edf-fe7ce185f36b___78adf636-26dc-4ea6-a9b1-c0acfd17d5ae', '15a053e0-d4b8-491f-ae5b-fefcda8f8493___8c95568b-d972-40dc-99e3-4aa7c487ac86', '1ed9c430-09bd-497e-816f-ca5837296b3f___4de7f331-6ebc-44ab-bfdb-92f6f405cd1d'],
  merapi: ['afa397b2-7857-42f2-afe7-76f44e2372a4___05e77a25-1600-48b4-b984-5369062a9d0b', 'afa397b2-7857-42f2-afe7-76f44e2372a4___d92c422a-c8af-4679-913c-adc3a0d94c74']
};

/** The cheapest nightly rate of a property in a window, in USD (what PriceLabs pushes to the channels), or null. */
async function cheapestNightUsd(key, from, to, cache) {
  const ck = `${key}|${from}|${to}`;
  if (cache.has(ck)) return cache.get(ck);
  const { priceIds, pricelabsRows } = await import('./agent/clients.js');
  const ids = PL_EXTRA[key] || [priceIds()[key]].filter(Boolean);
  let best = null;
  let cur = 'CHF';
  for (const id of ids) {
    const r = await pricelabsRows(id, from, to);
    cur = String(r.currency || cur).toUpperCase();
    for (const x of r.rows || []) {
      if (x.unbookable) continue;
      const p = x.user_price > 0 ? x.user_price : x.price;
      if (p > 0 && (best === null || p < best)) best = p;
    }
  }
  let usd = null;
  if (best !== null) {
    const fx = cur === 'USD' ? { rates: {} } : await usdRates([cur]);
    usd = convertAmount(best, cur, 'USD', fx.rates);
  }
  cache.set(ck, usd);
  return usd;
}

/** What the service costs, in USD (the price of the service in Elev8 stands for the cost). */
async function costUsd(resolved) {
  const cur = String(resolved.currency || 'USD').toUpperCase();
  const fx = cur === 'USD' ? { rates: {} } : await usdRates([cur]);
  return convertAmount(Number(resolved.price), cur, 'USD', fx.rates);
}

export const autopilotOn = () => on(process.env.PROMO_AUTOPILOT);
const QUOTA = 100;
const PER_GUEST = 1;

let lastPlanResult = null;
let planBusy = false;
export const lastPlan = () => lastPlanResult;

/**
 * The planner: reads the open nights, proposes promotions, checks each benefit exists in Elev8 and pays for itself, stores the
 * proposals as drafts (source engine) with their reasoning. With dry true nothing is stored. With PROMO_AUTOPILOT=on the
 * proposals are switched on at once, which creates the codes in Elev8.
 */
export async function runPlan({ ensureSchema, dry = false }) {
  if (planBusy) return { error: 'The planner is running already', ...(lastPlanResult || {}) };
  planBusy = true;
  const out = { at: new Date().toISOString(), dry, autopilot: autopilotOn(), proposed: [], activated: [], skipped: [], errors: [] };
  try {
    await ensureSchema();
    await ensureExtras();
    const day = today();
    const days = 60;
    const { elev8Tool } = await import('./agent/clients.js');
    const gaps = await elev8Tool('get_upcoming_gaps', { days_ahead: days });
    const props = (await q('select key, name, guests from properties where active order by key')).map((p) => ({ ...p, guests: factsFor(p.key)?.guestsMax ?? p.guests }));
    const suggestions = suggest(matchGaps(gaps?.results, props, days), day, days);
    const existing = await q("select property_key, source, status, stay_from::text as stay_from, stay_to::text as stay_to, terms from promos where status <> 'ended'");
    const maxOpen = num(process.env.PROMO_MAX_OPEN, 40);
    const maxPerVilla = num(process.env.PROMO_MAX_PER_VILLA, 4);
    const share = num(process.env.PROMO_MAX_COST_SHARE, 0.1);
    const { proposals, skipped } = planProposals({ suggestions, props, existing, maxOpen, maxPerVilla });
    out.skipped.push(...skipped);
    const taken = new Set((await q('select upper(code) as c from promos')).map((x) => x.c));
    try {
      const codes = await elev8Tool('list_promo_codes', { website: '' });
      for (const c of codes?.results || []) taken.add(normaliseCode(c.promo_code));
    } catch {
      // without the list of Elev8 codes the planner stops: a code that exists there must not be created again
      throw new Error('The codes of Elev8 could not be read, nothing is proposed');
    }
    const upsells = new Map();
    const nightly = new Map();
    const chosenGroups = new Map();
    for (const p of proposals) {
      const groups = chosenGroups.get(p.property_key) || new Set();
      let pick = null;
      let nightUsd = null;
      try {
        nightUsd = await cheapestNightUsd(p.property_key, p.stay_from || day, p.stay_to || day, nightly);
      } catch (e) {
        out.skipped.push(`${p.name}: cheapest rate not readable (${String(e.message || e).slice(0, 80)})`);
        continue;
      }
      for (const b of p.options) {
        if (groups.has(GROUP[b])) continue;
        const resolved = await resolveBenefit(p.property_key, b, upsells);
        if (!resolved) {
          out.skipped.push(`${p.name}: ${b} does not exist for this property in Elev8 (for the apartments and the shared villa every unit must offer it)`);
          continue;
        }
        const cost = await costUsd(resolved);
        const chk = costCheck({ cost, nightly: nightUsd, minNights: p.min_nights, share });
        if (!chk.ok) {
          out.skipped.push(`${p.name}: ${b} is not offered, ${chk.why}`);
          continue;
        }
        pick = { b, resolved, chk, cost };
        break;
      }
      if (!pick) continue;
      groups.add(GROUP[pick.b]);
      chosenGroups.set(p.property_key, groups);
      const { b: chosen, resolved, chk, cost } = pick;
      const minNights = chk.minNights ?? p.min_nights ?? null;
      const code = makeCode(p.property_key, chosen, day, taken);
      taken.add(code);
      const terms = `${BENEFITS[chosen].label}. ${guestTerms({ benefit: chosen, ...p, min_nights: minNights })}`.slice(0, 1000);
      const costText = `Cost about USD ${Math.round(cost)}: ${(chk.ratio * 100).toFixed(1)} % of a ${chk.nights}-night booking at the cheapest rate (about USD ${Math.round(nightUsd * chk.nights)})${chk.raised ? `, so the minimum stay is ${minNights} nights` : ''}.`;
      const item = { code, property_key: p.property_key, name: p.name, benefit: chosen, label: BENEFITS[chosen].label, listings: resolved.listings.length, stay_from: p.stay_from, stay_to: p.stay_to, book_until: p.book_until, min_nights: minNights, cost_usd: Math.round(cost * 100) / 100, cost_share: Math.round(chk.ratio * 1000) / 1000, reason: `${p.reason} Offer: ${BENEFITS[chosen].label}. ${costText}` };
      out.proposed.push(item);
      if (dry) continue;
      const rows = await q(
        `insert into promos (property_key, title, code, terms, stay_from, stay_to, book_until, min_nights, status, source, suggestion_id, note, spec)
         values ($1,$2,$3,$4,$5::date,$6::date,$7::date,$8,'draft','engine',null,$9,$10::jsonb) returning id`,
        [p.property_key, `${p.name}: ${BENEFITS[chosen].label.replace(/^Complimentary /, '')}`.slice(0, 120), code, terms, p.stay_from, p.stay_to, p.book_until, minNights, item.reason.slice(0, 500), JSON.stringify({ benefit: chosen, kind: p.kind, quota: QUOTA, perGuest: PER_GUEST, type: p.type, cost_usd: item.cost_usd, cost_share: item.cost_share })]
      );
      item.id = rows[0].id;
      if (autopilotOn()) {
        try {
          await activatePromo(rows[0].id, { ensureSchema });
          out.activated.push(code);
        } catch (e) {
          out.errors.push(`${code}: ${String(e.message || e).slice(0, 200)}`);
        }
      }
    }
  } catch (e) {
    out.errors.push(String(e.message || e).slice(0, 300));
    console.error('promo planner failed:', e.message);
  } finally {
    planBusy = false;
    lastPlanResult = out;
  }
  return out;
}

/**
 * Switches an engine proposal on: creates the code in Elev8, checks that it arrived, and turns the promotion into a mirrored one.
 * Elev8 makes the code redeemable at once and has no tool to remove it, so a failure before the check leaves the proposal a draft.
 */
export async function activatePromo(id, { ensureSchema }) {
  await ensureSchema();
  await ensureExtras();
  const [p] = await q(`select ${ROW}, spec from promos where id = $1`, [id]);
  if (!p) throw new Error('Promotion not found');
  if (p.source !== 'engine' || p.status !== 'draft') throw new Error('Only a draft proposal of the engine can be switched on');
  const spec = p.spec || {};
  if (!BENEFITS[spec.benefit]) throw new Error('The proposal has no benefit');
  if (p.book_until && p.book_until < today()) throw new Error('The last booking day has passed');
  // Checked again now: the service must still exist for this property in Elev8.
  const resolved = await resolveBenefit(p.property_key, spec.benefit);
  if (!resolved) throw new Error(`The benefit ${spec.benefit} is not available for this property in Elev8 any more`);
  const { elev8Tool } = await import('./agent/clients.js');
  const before = await elev8Tool('list_promo_codes', { website: '' });
  if ((before?.results || []).some((c) => normaliseCode(c.promo_code) === p.code)) throw new Error(`The code ${p.code} exists in Elev8 already`);
  await elev8Tool('create_promo_code', {
    website: process.env.ELEV8_PROMO_WEBSITE || 'www.elevate-villas.com',
    promo_code: p.code,
    name: p.title.slice(0, 100),
    description: guestTerms({ benefit: spec.benefit, ...p }),
    discount_kind: 3,
    discount_amount: 0,
    percentage_discount: 0,
    currency: '',
    upsell: resolved.upsell,
    upsell_item: resolved.upsell_item,
    listings: resolved.listings,
    quota: spec.quota || QUOTA,
    quota_per_user: spec.perGuest || PER_GUEST,
    booking_from_date: today(),
    booking_until_date: p.book_until || '',
    stay_from_date: p.stay_from || '',
    stay_until_date: p.stay_to || ''
  });
  // The check: the code must be in the list of Elev8 now.
  const after = await elev8Tool('list_promo_codes', { website: '' });
  if (!(after?.results || []).some((c) => normaliseCode(c.promo_code) === p.code)) throw new Error(`Elev8 did not confirm the code ${p.code}. Look in Elev8 before trying again.`);
  await q("update promos set source = 'elev8', external_id = $2, status = 'active', spec = spec || $3::jsonb, updated_at = now() where id = $1", [id, `elev8:${p.code}:${p.property_key}`, JSON.stringify({ created: new Date().toISOString(), resolved })]);
  await runMirror({ ensureSchema });
  const [row] = await q(`select ${ROW} from promos where id = $1`, [id]);
  return row;
}

let timer = null;
let planTimer = null;
let last = null;
let busy = false;

/** Runs the mirror once now and returns the result. */
export async function runMirror({ ensureSchema }) {
  if (busy) return { error: 'The mirror is running already', ...(last || {}) };
  busy = true;
  try {
    last = await mirrorElev8Promos({ ensureSchema });
  } catch (e) {
    last = { at: new Date().toISOString(), error: String(e.message || e).slice(0, 300) };
    console.error('promo mirror failed:', e.message);
  } finally {
    busy = false;
  }
  return last;
}

export const lastMirror = () => last;

/**
 * The mirror runs half a minute after the start, then every 5 minutes. The planner runs two minutes after the start and then checks
 * every 3 hours; it makes a new round at most once in 20 hours (PROMO_PLANNER=off stops it).
 */
export function startPromoMirror({ ensureSchema }) {
  if (!timer && !off(process.env.ELEV8_PROMO_MIRROR)) {
    const run = () => {
      if (dbEnabled()) runMirror({ ensureSchema }).catch(() => {});
    };
    setTimeout(run, 30000).unref();
    timer = setInterval(run, 5 * 60 * 1000);
    timer.unref();
  }
  if (!planTimer && !off(process.env.PROMO_PLANNER)) {
    const plan = async () => {
      try {
        if (!dbEnabled()) return;
        await ensureSchema();
        await ensureExtras();
        const [recent] = await q("select max(created_at) as at from promos where source in ('engine') or spec is not null");
        if (recent?.at && Date.now() - new Date(recent.at).getTime() < 20 * 3600 * 1000) return;
        await runPlan({ ensureSchema });
      } catch (e) {
        console.error('promo planner failed:', e.message);
      }
    };
    setTimeout(plan, 120000).unref();
    planTimer = setInterval(plan, 3 * 3600 * 1000);
    planTimer.unref();
  }
}
