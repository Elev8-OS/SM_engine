// Booking in the chat. Lea creates the booking as an inquiry in Elev8 and sends the payment link; Elev8 confirms the booking when the guest has paid.
// Two tools, so that nothing is booked by accident:
//   prepare_booking  read only: the exact price from Elev8 (fees and taxes included, a deal code applied), what is still missing, and a note for the summary
//   create_booking   creates the inquiry. It is refused unless a complete prepare_booking happened in an EARLIER guest message (the guest has seen the summary
//                    and answered), the price has not changed, and the guest confirmed.
// The guest pays in the currency of the property (CHF), whatever currency the chat was quoted in.
// The phone number comes from the WhatsApp contact; on Instagram the guest is asked for it. Elev8 refuses a number without a country code.
import crypto from 'node:crypto';

export const bookingOn = (env = process.env) => /^(on|true|1|yes)$/i.test(String(env.BOOKING_IN_CHAT || '').replace(/["'\s]/g, ''));
const PER_DAY = (env) => Math.max(1, Number(env.BOOKINGS_PER_DAY) || 10);
// How long the payment link of Elev8 may live (hours). Elev8 may cap it lower; the answer of Elev8 wins.
const LINK_HOURS = (env) => Math.min(48, Math.max(1, Number(env.BOOKING_LINK_HOURS) || 24));
const PREVIEW_HOURS = 6;
const MAX_ATTEMPTS = 3;

const STAY_PROPS = {
  villa: { type: 'string', description: 'Villa key from list_villas (not merapi)' },
  check_in: { type: 'string', description: 'YYYY-MM-DD' },
  check_out: { type: 'string', description: 'YYYY-MM-DD, the departure day' },
  adults: { type: 'integer', description: 'Number of adults, at least 1' },
  children: { type: 'integer', description: 'Number of children, 0 or more' },
  promo_code: { type: 'string', description: 'Only the code that create_deal_code returned for this guest and stay. Leave it out otherwise.' },
  guest_first_name: { type: 'string', description: 'First name, as the guest wrote it' },
  guest_last_name: { type: 'string', description: 'Last name, as the guest wrote it' },
  guest_email: { type: 'string', description: 'Email address the guest gave you in this chat. Never guess or take one from elsewhere.' },
  guest_phone: { type: 'string', description: 'Phone number with country code (+41 ...). Only needed on Instagram: on WhatsApp it is taken from the chat, never ask for it there.' }
};

export const PREPARE_TOOL = {
  name: 'prepare_booking',
  description:
    'Step 1 of booking in the chat. Read only. Checks the stay with Elev8 and returns the exact total the guest will be charged (fees and taxes included, a deal code applied) and what is still missing (name, email, phone). Call it again with the details once the guest has sent them. Nothing is booked by this tool.',
  input_schema: { type: 'object', properties: STAY_PROPS, required: ['villa', 'check_in', 'check_out', 'adults', 'children'], additionalProperties: false }
};

export const BOOK_TOOL = {
  name: 'create_booking',
  description:
    'Step 2 of booking in the chat. Creates the booking as an inquiry in Elev8 and returns the payment link. Call it only after the guest saw the summary (prepare_booking said ready) and answered yes in a LATER message. The server refuses it otherwise, and when the price changed since the summary. The booking is confirmed only when the guest pays the link.',
  input_schema: {
    type: 'object',
    properties: {
      ...STAY_PROPS,
      guest_confirmed: { type: 'boolean', description: 'True only when the guest said yes to the summary (villa, dates, guests, total in CHF) in their last message' },
      confirmed_total: { type: 'number', description: 'The total in CHF you showed the guest, exactly as total of prepare_booking' }
    },
    required: ['villa', 'check_in', 'check_out', 'adults', 'children', 'guest_first_name', 'guest_last_name', 'guest_email', 'guest_confirmed', 'confirmed_total'],
    additionalProperties: false
  }
};

/** What the prompt says on top while booking in the chat is on. */
export const BOOKING_NOTE = (channel) =>
  [
    'Booking in the chat (switched on): when the guest wants to book, you create the booking yourself and send the payment link, instead of the booking page link. Only when check_availability says free and the guest wants to book now (not Merapi). Steps:',
    '1. Call prepare_booking with the stay (villa, dates, adults, children), plus promo_code only when create_deal_code returned a code for this stay.',
    channel === 'whatsapp'
      ? '2. It lists what is missing. Ask for it in ONE short message: first and last name and an email address. Never ask for a phone number here: it is taken from this chat.'
      : '2. It lists what is missing. Ask for it in ONE short message: first and last name, an email address and a phone number with country code (+41 ...).',
    '3. When prepare_booking says ready true, write the summary: villa, dates, number of guests and the total in CHF exactly as total (fees and taxes included). Say that the payment is taken in CHF at that amount by card (the guest\'s bank converts if the card is in another currency) and that the booking is confirmed only after the payment. You may add an approximate amount in the guest\'s currency with convert_currency. Then ask: shall I create the booking and send the payment link? Do not create it in this message.',
    '4. Only when the guest answers yes in a later message, call create_booking with the same data, guest_confirmed true and confirmed_total equal to that total.',
    '5. Put payment_url on a line of its own at the very end of the reply. Tell the guest to pay soon (and until when, if expires_at is given), that the dates are not held until the payment is made, and that the confirmation follows the payment. Never take card details in the chat and never name a unit.',
    'If a booking tool returns ok false, follow its note (usually: tell the guest the team will take care of the booking and hand over). Never create a second booking for the same stay.'
  ].join('\n');

const cleanName = (s) => String(s || '').normalize('NFC').replace(/[^\p{L}\p{M}'’. -]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40);
const hasLetter = (s) => /\p{L}/u.test(String(s || ''));
export const validEmail = (s) => {
  const e = String(s || '').trim();
  return e.length <= 120 && /^[^\s@<>()[\]]+@[^\s@<>()[\]]+\.[A-Za-z]{2,}$/.test(e);
};

/**
 * Phone number in E.164 (+ and 8 to 15 digits). Elev8 refuses a number without a country code, so a local number is never guessed.
 * trustCountryCode: the digits come from the WhatsApp contact (always with country code, only the plus is missing).
 */
export function normalizePhone(raw, { trustCountryCode = false } = {}) {
  let s = String(raw || '').trim().replace(/[\s().-]/g, '');
  if (!s) return { ok: false, reason: 'missing' };
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (s.startsWith('+')) {
    const d = s.slice(1);
    return /^[1-9]\d{7,14}$/.test(d) ? { ok: true, phone: `+${d}` } : { ok: false, reason: 'invalid' };
  }
  if (!/^\d+$/.test(s)) return { ok: false, reason: 'invalid' };
  if (s.startsWith('0')) return { ok: false, reason: 'no_country_code' };
  if (trustCountryCode && /^[1-9]\d{7,14}$/.test(s)) return { ok: true, phone: `+${s}` };
  return { ok: false, reason: 'no_country_code' };
}

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 20);
const near = (a, b) => Math.abs(Number(a) - Number(b)) <= 1;
const row = (sql, params, deps) => deps.q(sql, params).then((r) => r[0]);
const SELECT = 'select value, extract(epoch from (now() - updated_at))::int as age_s from agent_settings where key = $1';
const UPSERT = 'insert into agent_settings (key, value, updated_at) values ($1, $2, now()) on conflict (key) do update set value = excluded.value, updated_at = now()';

async function readStay(input, deps) {
  const p = await deps.villa(input.villa);
  if (deps.unsupported(p.key)) return { ok: false, out: { ok: false, note: `Booking in the chat is not available for ${p.name} yet. Share the booking link instead.` } };
  const { ci, co } = deps.checkDates(input);
  const adults = Number(input.adults);
  const children = Number(input.children ?? 0);
  if (!Number.isInteger(adults) || adults < 1 || !Number.isInteger(children) || children < 0) return { ok: false, out: { ok: false, note: 'adults must be at least 1 and children 0 or more.' } };
  const max = deps.maxGuests(p);
  if (max && adults + children > max) return { ok: false, out: { ok: false, note: `${p.name} sleeps up to ${max} guests. Do not create a booking for it.` } };
  const promo = input.promo_code ? String(input.promo_code).replace(/\s+/g, '').toUpperCase() : '';
  if (promo && !(await deps.promoKnown(promo, p.key))) return { ok: false, out: { ok: false, note: 'That code is not a deal code you created for this guest. Leave promo_code out.' } };
  return { ok: true, p, stay: { ci, co, adults, children, promo } };
}

/** First and last name, email and phone of the guest, and what is still missing. The WhatsApp number comes from the chat. */
async function guestDetails(input, ctx, deps) {
  const first = cleanName(input.guest_first_name);
  const last = cleanName(input.guest_last_name);
  const email = String(input.guest_email || '').trim();
  let phone = '';
  let phoneFrom = '';
  if (ctx.channel === 'whatsapp' && ctx.contactId) {
    const n = normalizePhone(await deps.contactPhone(ctx.contactId).catch(() => ''), { trustCountryCode: true });
    if (n.ok) {
      phone = n.phone;
      phoneFrom = 'whatsapp';
    }
  }
  let phoneProblem = '';
  if (!phone) {
    const n = normalizePhone(input.guest_phone);
    if (n.ok) {
      phone = n.phone;
      phoneFrom = 'guest';
    } else phoneProblem = n.reason;
  }
  const missing = [];
  if (!hasLetter(first)) missing.push('first_name');
  if (!hasLetter(last)) missing.push('last_name');
  if (!validEmail(email)) missing.push('email');
  if (!phone) missing.push(phoneProblem === 'no_country_code' || phoneProblem === 'invalid' ? 'phone_with_country_code (the number given has no valid country code)' : 'phone_with_country_code');
  return { first, last, email, phone, phoneFrom, missing };
}

const stayKey = (ctx, p, st) => sha([ctx.contactId || '-', p.key, st.ci, st.co, st.adults, st.children, st.promo].join('|'));

async function priceStay(p, st, deps, fail) {
  const found = await deps.resolveStay(p, st);
  if (!found.ok) return { err: { ok: false, note: `Elev8 cannot book these dates (${found.reason}). Do not create a booking. Tell the guest in your own words, offer other dates or another villa, or hand over if it is unclear.` } };
  const quote = found.quote;
  const total = Number(quote.total_price);
  if (!(total > 0) || !quote.currency) return { err: fail('Elev8 returned no usable price.') };
  // A code that Elev8 does not apply must never be promised: the price would be wrong. (On 9 Nov 2026 get_quote ignored every code, even an invented one.)
  // The guest is not handed over: the link with the code that create_deal_code made works on the booking page.
  if (st.promo && !(Number(quote.discounts_total) > 0 || Number(quote.promo_discount) > 0)) return { err: { ok: false, no_chat_booking_with_code: true, note: `The booking system does not apply the code ${st.promo} to a booking made in the chat, so the price would be wrong. Do not create a booking. Share the booking_link that create_deal_code returned instead (the code is already in it) and follow its note. Do not hand over to the team because of this.` } };
  return { found, quote, total };
}

/** Step 1. Read only (it only keeps a note that the summary was ready). */
export async function prepareBooking(input, ctx, deps, { force = false } = {}) {
  const env = deps.env || process.env;
  const fail = (note) => ({ ok: false, note: `${note} Tell the guest the team will take care of the booking and hand over to the team (needs_human true).` });
  try {
    if (!force && !bookingOn(env)) return fail('Booking in the chat is switched off.');
    const s = await readStay(input, deps);
    if (!s.ok) return s.out;
    const priced = await priceStay(s.p, s.stay, deps, fail);
    if (priced.err) return priced.err;
    const { quote, total } = priced;
    const g = await guestDetails(input, ctx, deps);
    const ready = g.missing.length === 0;
    if (ready) {
      // Remember that a complete summary was possible in this message. The first one counts: asking again later does not move it.
      const key = `bookprev:${stayKey(ctx, s.p, s.stay)}`;
      const prev = await row(SELECT, [key], deps);
      const keep = prev?.age_s <= PREVIEW_HOURS * 3600 && near(prev.value?.total, total) && Number(prev.value?.inquiry_id) <= Number(ctx.inquiryId ?? 0);
      if (!keep) await deps.q(UPSERT, [key, JSON.stringify({ inquiry_id: Number(ctx.inquiryId ?? 0), total, currency: quote.currency })]);
    }
    return {
      ok: true,
      ready,
      missing: g.missing,
      villa: s.p.name,
      check_in: s.stay.ci,
      check_out: s.stay.co,
      nights: Number(quote.nights) || undefined,
      adults: s.stay.adults,
      children: s.stay.children,
      total,
      currency: quote.currency,
      accommodation_total: quote.accommodation_total,
      fees_total: quote.fees_total,
      taxes_total: quote.taxes_total,
      discounts_total: quote.discounts_total,
      phone_known: Boolean(g.phone),
      phone_from: g.phoneFrom || undefined,
      note: ready
        ? `Write the summary now: ${s.p.name}, ${s.stay.ci} to ${s.stay.co}, ${s.stay.adults} adults${s.stay.children ? ` and ${s.stay.children} children` : ''}, total ${total} ${quote.currency} (fees and taxes included), paid in ${quote.currency}. Ask the guest to confirm. Do not call create_booking in this message.`
        : `Ask the guest, in one short message, for: ${g.missing.join(', ')}. ${ctx.channel === 'whatsapp' ? 'Do not ask for a phone number unless it is listed as missing.' : ''} Then call prepare_booking again with the details.`
    };
  } catch (e) {
    return fail(String(e.message || e).slice(0, 160));
  }
}

const field = (o, keys) => keys.map((k) => o?.[k]).find((v) => v !== undefined && v !== null && v !== '');

/** Step 2. Creates the inquiry in Elev8. Never throws: a problem comes back as a note for the model. */
export async function createBooking(input, ctx, deps, { force = false, testOnly = false } = {}) {
  const env = deps.env || process.env;
  const fail = (note) => ({ ok: false, note: `${note} Tell the guest the team will take care of the booking and hand over to the team (needs_human true). Do not send a booking link of your own.` });
  try {
    if (!force && !bookingOn(env)) return fail('Booking in the chat is switched off.');
    if (!force && input.guest_confirmed !== true) return { ok: false, note: 'The guest has not confirmed. Show the summary and wait for the guest to say yes.' };
    const s = await readStay(input, deps);
    if (!s.ok) return s.out;
    const { p, stay } = s;
    const g = await guestDetails(input, ctx, deps);
    if (g.missing.length) return { ok: false, note: `Details are missing: ${g.missing.join(', ')}. Ask the guest for them.` };
    const priced = await priceStay(p, stay, deps, fail);
    if (priced.err) return priced.err;
    const { found, quote, total } = priced;
    if (!force && !near(input.confirmed_total, total)) return { ok: false, note: `The price is now ${total} ${quote.currency}, not what you showed. Call prepare_booking again, show the guest the new total and ask again.` };

    const key = stayKey(ctx, p, stay);
    if (!force) {
      const prev = await row(SELECT, [`bookprev:${key}`], deps);
      const ok = prev && prev.age_s <= PREVIEW_HOURS * 3600 && near(prev.value?.total, total) && Number(prev.value?.inquiry_id) < Number(ctx.inquiryId ?? 0);
      if (!ok) return { ok: false, note: 'The guest has not confirmed a summary with these details and this price in an earlier message. Call prepare_booking, show the summary, and create the booking only after the guest says yes in a later message.' };
    }

    // The same stay of the same guest is booked once. A link that is still valid is handed out again; an expired one gets a new attempt.
    const base = `book:${testOnly ? 'test-' : ''}${key}`;
    const prevBook = await row(SELECT, [base], deps);
    let attempt = 1;
    if (prevBook?.value?.payment_url) {
      const hours = Number(prevBook.value.valid_hours) || LINK_HOURS(env);
      if (prevBook.age_s < hours * 3600 * 0.9) return bookedAnswer({ ...prevBook.value, reused: true }, p, stay, total, quote.currency);
      attempt = (Number(prevBook.value.attempt) || 1) + 1;
      if (attempt > MAX_ATTEMPTS) return fail('This stay was booked and its payment link expired several times.');
    }
    if (!force) {
      const [{ n }] = await deps.q("select count(*)::int as n from agent_settings where key like 'book:%' and updated_at > now() - interval '24 hours'");
      if (n >= PER_DAY(env)) return fail('The daily limit of bookings in the chat is reached.');
    }

    const hours = testOnly ? 1 : LINK_HOURS(env);
    const args = {
      listing_name: found.listingName,
      check_in_date: stay.ci,
      check_out_date: stay.co,
      number_of_adults: stay.adults,
      number_of_children: stay.children,
      first_name: g.first,
      last_name: g.last,
      email: g.email,
      phone: g.phone,
      expiry_hours: hours,
      idempotency_key: `lea-${testOnly ? 'test-' : ''}${key}${attempt > 1 ? `-${attempt}` : ''}`,
      special_requests: `Booked in the chat with the virtual assistant (${ctx.channel || 'chat'}).`,
      ...(stay.promo ? { promo_code: stay.promo } : {})
    };
    let res;
    try {
      res = await deps.elev8('create_reservation_inquiry', args);
    } catch (e) {
      return fail(`The booking could not be created (${String(e.message || e).replace(/^Elev8:\s*/, '').slice(0, 140)}).`);
    }
    const url = field(res, ['payment_url', 'paymentUrl', 'payment_link_url', 'payment_link']) || field(res?.reservation, ['payment_url']);
    if (!url || !/^https:\/\//.test(String(url))) return fail('The booking was created but Elev8 returned no payment link.');
    const saved = {
      payment_url: String(url),
      reservation: String(field(res, ['reservation_id', 'booking_reference', 'reservation_number', 'id']) ?? field(res?.reservation, ['id', 'reference']) ?? ''),
      expires_at: field(res, ['payment_link_expires_at', 'expires_at', 'expiry']) || null,
      valid_hours: hours,
      attempt,
      total,
      currency: quote.currency,
      villa: p.key,
      check_in: stay.ci,
      check_out: stay.co,
      test: testOnly
    };
    await deps.q(UPSERT, [base, JSON.stringify(saved)]);
    return bookedAnswer(saved, p, stay, total, quote.currency);
  } catch (e) {
    return fail(String(e.message || e).slice(0, 160));
  }
}

function bookedAnswer(saved, p, stay, total, currency) {
  const until = saved.expires_at ? ` The link works until ${saved.expires_at}: tell the guest.` : '';
  return {
    ok: true,
    reused: Boolean(saved.reused),
    villa: p.name,
    check_in: stay.ci,
    check_out: stay.co,
    total,
    currency,
    reservation: saved.reservation || undefined,
    payment_url: saved.payment_url,
    expires_at: saved.expires_at || undefined,
    note:
      `Share payment_url exactly, on a line of its own at the very end of the reply, with nothing after it. Tell the guest, in the guest's language and in your own words: (1) this is the secure payment page for ${p.name}, ${stay.ci} to ${stay.co}, ${total} ${currency}; (2) the booking is confirmed automatically once the payment is complete, and only then; (3) please pay soon, until then the dates are not held;${until} (4) the payment is taken in ${currency}. ` +
      `${saved.reused ? 'This is the link created earlier for this stay: do not say a new booking was made. ' : ''}` +
      'Never name a unit. Call submit_reply with needs_human false and a short reason that names the booking, the villa, the dates and the total.'
  };
}
