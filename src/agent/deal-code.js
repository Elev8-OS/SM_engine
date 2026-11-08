// One-time promo code for a price Lea agreed with a guest. The code gives a percentage discount, so the booking page
// (which converts currencies with its own rates) shows the agreed price in any currency.
// The percentage is worked out here from the real price, never by the model, and the 10% limit of the negotiation rule is enforced here too.
import crypto from 'node:crypto';
import { NEGOTIATE_MAX_PCT } from './negotiation.js';
import { bookingLink, DM_UTM, isDate, nightsBetween } from './tools.js';

export const dealCodesOn = (env = process.env) => String(env.DEAL_CODES || '').toLowerCase() === 'on';
const SITE = (env = process.env) => env.DEAL_CODE_WEBSITE || 'www.elevate-villas.com';
const PER_DAY = (env = process.env) => Math.max(1, Number(env.DEAL_CODES_PER_DAY) || 10);
// The code is valid until the next day at the latest.
const VALID_DAYS = 1;
// Rounding of the guest's price may push the discount a hair above 10%: up to this it is clamped to 10, beyond it the team decides.
const TOLERANCE_PCT = 0.1;

export const DEAL_TOOL = {
  name: 'create_deal_code',
  description:
    'Creates a one-time promo code that gives the agreed price on the booking page, and returns the booking link with the code already in it. Call it only after the guest has accepted a concrete price that check_budget allowed, never to offer a discount. The server works out the percentage and refuses anything beyond the limit. Share the returned booking_link exactly and follow its note.',
  input_schema: {
    type: 'object',
    properties: {
      villa: { type: 'string', description: 'Villa key from list_villas' },
      check_in: { type: 'string', description: 'YYYY-MM-DD' },
      check_out: { type: 'string', description: 'YYYY-MM-DD, the departure day' },
      adults: { type: 'integer', description: 'Number of adults, at least 1' },
      children: { type: 'integer', description: 'Number of children, 0 or more' },
      agreed_price: { type: 'number', description: 'The price the guest accepted, in the currency of currency' },
      basis: { type: 'string', enum: ['total', 'per_night'], description: 'Whether agreed_price is for the whole stay or per night' },
      currency: { type: 'string', description: '3-letter code of agreed_price and of the link, for example IDR' },
      guest_name: { type: 'string', description: "The guest's first name (from the guest name line or the chat). It goes into the code, for example LEA-ANNA. Leave it out when you do not know a real name." }
    },
    required: ['villa', 'check_in', 'check_out', 'adults', 'children', 'agreed_price', 'basis', 'currency'],
    additionalProperties: false
  }
};

/** The discount for an agreed price. offered and agreed are in the same currency, both for the whole stay. */
export function planDeal({ offered, agreed } = {}) {
  const o = Number(offered);
  const a = Number(agreed);
  if (!(o > 0) || !(a > 0)) return { ok: false, note: 'offered and agreed must be positive numbers' };
  if (a >= o) return { ok: false, note: 'The agreed price is not below the price shown. No code is needed: share the normal booking link.' };
  const pct = Math.round((1 - a / o) * 1e6) / 1e4; // percent, four decimals
  if (pct > NEGOTIATE_MAX_PCT + TOLERANCE_PCT) return { ok: false, note: `That is more than ${NEGOTIATE_MAX_PCT}% below the price shown. Do not confirm it: the team decides.`, percent_under_offer: pct };
  const clamped = pct > NEGOTIATE_MAX_PCT;
  const percent = clamped ? NEGOTIATE_MAX_PCT : Math.min(Math.ceil(pct * 100) / 100, NEGOTIATE_MAX_PCT);
  return { ok: true, percent, clamped, expected_price: Math.round(o * (1 - percent / 100)), offered: Math.round(o) };
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** LEA-XXXXXX, no look-alike characters. */
export function makeCode(bytes = crypto.randomBytes(6)) {
  return `LEA-${Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('')}`;
}

/** The part of a guest name that goes into the code: the first word of letters, upper case, without accents, at most 12 characters. Empty when there is none (a phone number, no name). */
export function nameToken(name) {
  const plain = String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const m = /[A-Za-z]{2,}/.exec(plain);
  return m ? m[0].toUpperCase().slice(0, 12) : '';
}

/** LEA-<NAME>; when that code exists already LEA-<NAME>2, LEA-<NAME>3 ...; LEA-XXXXXX when the guest has no usable name. taken(code) says whether a code exists. */
export async function codeFor(guestName, taken = async () => false, random = makeCode) {
  const token = nameToken(guestName);
  if (!token) return random();
  for (let i = 1; i <= 9; i++) {
    const code = `LEA-${token}${i === 1 ? '' : i}`;
    if (!(await taken(code))) return code;
  }
  return random();
}

/**
 * How a code is limited to an apartment group (1-3, 4-7, 8-11). In Elev8 the units of a group share one listing id, each unit is a row of its own,
 * and the rows of a group carry two listing names (for the mezzanines "8 - 11 Mezzanine" and "The R Pererenan Mezzanine Apartment w/ balcony").
 * create_promo_code wants a name that matches exactly one row and stores the listing name of that row. So one unit per distinct listing name is
 * named by its internal name, which is unique, and the code ends up with both names of the group (checked on 8 Nov 2026 with expired probe codes).
 */
export function unitListingRefs(rows, pick) {
  const byName = new Map();
  for (const r of [...(rows || [])].filter(pick).sort((a, b) => String(a.internal_name).localeCompare(String(b.internal_name), 'en', { numeric: true }))) {
    const name = String(r.listing_name || '').trim();
    if (name && r.internal_name && !byName.has(name)) byName.set(name, r.internal_name);
  }
  return [...byName.values()];
}

const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/**
 * Arguments of Elev8's create_promo_code: one use, the listing of the villa (null: every listing, used for apartment categories), valid until the next day at the latest.
 * The stay window runs from check-in to check-out: the booking page checks the whole stay against it, a window of the check-in day alone refuses a stay of several nights.
 */
export function promoArgs({ website, code, percent, listingNames, checkIn, checkOut, today, testOnly = false }) {
  // A test code is created already expired: it proves that creating works and can never be redeemed.
  const from = testOnly ? addDays(today, -2) : today;
  const until = testOnly ? addDays(today, -1) : addDays(today, VALID_DAYS) < checkIn ? addDays(today, VALID_DAYS) : checkIn;
  return {
    website,
    promo_code: code,
    name: `Lea ${code}`,
    description: 'Special direct-booking price for this stay. Single use, not combinable with other offers.',
    discount_kind: 1,
    percentage_discount: percent,
    discount_amount: 0,
    currency: '',
    upsell: '',
    upsell_item: '',
    quota: 1,
    quota_per_user: 1,
    listings: listingNames,
    booking_from_date: from,
    booking_until_date: until,
    stay_from_date: checkIn,
    stay_until_date: checkOut
  };
}

const keyOf = (v) => crypto.createHash('sha1').update(v).digest('hex').slice(0, 20);

/**
 * Orchestrates one deal code. deps are injected so the logic is testable without network:
 * villa(key), unsupported(key), maxGuests(p), checkDates(input), quote(input) -> price summary, convert({amount,from,to}),
 * listingNames(p, checkIn) -> the Elev8 listing name the code is limited to (a villa), or null for no restriction (apartment categories),
 * codeTaken(code) -> whether a code of ours exists already, elev8(name, args), q(sql, params), today(), env.
 * Never throws: a problem comes back as a note for the model. force skips the DEAL_CODES switch (manual test route).
 */
export async function createDealCode(input, deps, { dryRun = false, force = false, testOnly = false } = {}) {
  const env = deps.env || process.env;
  const fail = (note) => ({ ok: false, note: `${note} Say the team will send the code and hand over to the team (needs_human true) with the agreed price.` });
  try {
    if (!force && !dealCodesOn(env)) return fail('Deal codes are switched off.');
    const p = await deps.villa(input.villa);
    if (deps.unsupported(p.key)) return fail('Deal codes are not available for Merapi (rooms) yet.');
    const { ci, co } = deps.checkDates(input);
    const nights = nightsBetween(ci, co).length;
    const adults = Number(input.adults);
    const children = Number(input.children ?? 0);
    const max = deps.maxGuests(p);
    if (max && adults + children > max) return { ok: false, note: `${p.name} sleeps up to ${max} guests. Do not send a link for it.` };
    const cur = String(input.currency || '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(cur)) return fail('The currency is missing.');
    const agreedIn = Number(input.agreed_price);
    if (!(agreedIn > 0)) return fail('The agreed price is missing.');
    const agreed = input.basis === 'per_night' ? agreedIn * nights : agreedIn;

    // What the booking page asks for this stay: the same price Lea quoted (the PriceLabs price, stay total, with fees where a fact sheet has them), in the currency of the agreement.
    const price = await deps.quote({ villa: p.key, check_in: ci, check_out: co });
    if (!price?.ok) return fail('No price is available for these dates.');
    const offeredCHF = price.total_incl_fees ?? price.total;
    const conv = price.currency === cur ? { ok: true, converted: offeredCHF } : await deps.convert({ amount: offeredCHF, from: price.currency, to: cur });
    if (!conv.ok) return fail('The price could not be converted.');
    const plan = planDeal({ offered: conv.converted, agreed });
    if (!plan.ok) return plan.percent_under_offer ? fail(plan.note) : { ok: false, note: plan.note };

    const day = deps.today();
    const dedupe = `${testOnly ? 'deal-test' : 'deal'}:${keyOf([p.key, ci, co, Math.round(agreed), cur, adults, children].join('|'))}`;
    let code;
    let reused = false;
    if (!dryRun) {
      const [hit] = await deps.q("select value from agent_settings where key = $1 and updated_at > now() - interval '24 hours'", [dedupe]);
      if (hit?.value?.code && !testOnly) {
        code = hit.value.code;
        reused = true;
      }
      if (!code) {
        const [{ n }] = await deps.q("select count(*)::int as n from agent_settings where key like 'deal:%' and updated_at > now() - interval '24 hours'");
        if (n >= PER_DAY(env)) return fail('The daily limit of deal codes is reached.');
      }
    }
    const listingNames = await deps.listingNames(p, ci);
    // null means every listing; an empty list means the villa or the apartment group was not found.
    if (listingNames !== null && !listingNames?.length) return fail('The villa was not found in Elev8.');
    // The code carries the guest's name (LEA-ANNA). One that exists already, in our records or in Elev8, gets a number.
    const tried = new Set();
    const taken = async (c) => tried.has(c) || deps.codeTaken(c);
    code = code || (await codeFor(input.guest_name, taken));
    const argsFor = (c) => promoArgs({ website: SITE(env), code: c, percent: plan.percent, listingNames, checkIn: ci, checkOut: co, today: day, testOnly });
    let args = argsFor(code);
    if (dryRun) return { ok: true, dry_run: true, plan, offered_in_currency: Math.round(conv.converted), currency: cur, agreed_total: Math.round(agreed), nights, create_promo_code_args: args };

    if (!reused) {
      let created = false;
      let lastError = '';
      for (let attempt = 0; attempt < 3 && !created; attempt++) {
        try {
          await deps.elev8('create_promo_code', args);
          created = true;
        } catch (e) {
          lastError = String(e.message || e);
          // only a code that exists already is tried again, with the next name
          if (!/exist|unique|already|duplicate|taken/i.test(lastError)) break;
          tried.add(code);
          code = await codeFor(input.guest_name, taken);
          args = argsFor(code);
        }
      }
      if (!created) return fail(`The code could not be created (${lastError.slice(0, 120)}).`);
      await deps.q("insert into agent_settings (key, value, updated_at) values ($1, $2, now()) on conflict (key) do update set value = excluded.value, updated_at = now()", [dedupe, JSON.stringify({ code, villa: p.key, check_in: ci, check_out: co, percent: plan.percent, agreed: Math.round(agreed), currency: cur, test: testOnly })]);
    }
    if (testOnly) return { ok: true, test_only: true, promo_code: code, percent: plan.percent, note: 'Test code created already expired. It cannot be redeemed.' };
    const link = bookingLink(p.url, { checkIn: ci, checkOut: co, adults, children, currency: cur, promo: code }, DM_UTM);
    return {
      ok: true,
      villa: p.name,
      promo_code: code,
      percent_off: plan.percent,
      expected_price: plan.expected_price,
      currency: cur,
      single_use: true,
      valid_until: args.booking_until_date,
      booking_link: link,
      note:
        `Share booking_link exactly: the code ${code} is already in it. Tell the guest all of this, in the guest's language and in your own words: (1) the code works for this one booking only and is valid until ${args.booking_until_date}; (2) a booking is never confirmed without a completed payment; (3) until the payment is made, the villa can still be booked by someone else, so the dates are not held. ` +
        `The booking page should show about ${plan.expected_price} ${cur} for the stay (the page converts currencies with its own rate, so a small difference is possible: say "about"). ` +
        `${!listingNames || listingNames.length > 1 ? 'The code works for every unit of this category: the booking page shows which unit is free. Never name a unit. ' : ''}` +
        `${plan.clamped ? 'The limit was reached, so the price is the lowest allowed: use expected_price in your message. ' : ''}` +
        `Call submit_reply with needs_human false and a short reason that names the code, the villa, the dates and the agreed price.`
    };
  } catch (e) {
    return fail(String(e.message || e).slice(0, 160));
  }
}
