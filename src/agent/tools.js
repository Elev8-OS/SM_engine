// Pure helpers and tool definitions for the inquiry agent. No network here, so they are easy to test.
const DAY = 86400000;

export const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** Nights of a stay as YYYY-MM-DD, check-out night excluded. */
export function nightsBetween(checkIn, checkOut) {
  const out = [];
  for (let t = Date.parse(`${checkIn}T00:00:00Z`); t < Date.parse(`${checkOut}T00:00:00Z`); t += DAY) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** Decide availability from one Elev8 listing result (blocked_ranges with an exclusive end). */
export function availabilityFrom(listing, checkIn, checkOut) {
  const nights = nightsBetween(checkIn, checkOut);
  const blocked = listing?.blocked_ranges || [];
  const unknown = new Set(listing?.unknown_dates || []);
  const conflicts = nights.filter((n) => blocked.some((b) => n >= b.start && n < b.end_exclusive));
  const nearby = blocked.slice(0, 8).map((b) => ({ blocked_from: b.start, free_again_from: b.end_exclusive }));
  if (conflicts.length) return { available: false, blocked_nights: conflicts.length, of_nights: nights.length, blocked_periods_in_window: nearby };
  if (nights.some((n) => unknown.has(n))) return { available: null, note: 'Some of these dates are not verified. The team confirms.' };
  return { available: true, nights: nights.length };
}

/** Sum the nightly prices of a stay from PriceLabs rows. Uses the price pushed to channels, else the recommendation. */
export function priceSummary(rows, checkIn, checkOut, currency) {
  const byDate = new Map((rows || []).map((r) => [r.date, r]));
  const nights = nightsBetween(checkIn, checkOut);
  const per = nights.map((d) => {
    const r = byDate.get(d);
    if (!r || r.unbookable) return null;
    const p = r.user_price > 0 ? r.user_price : r.price;
    return p > 0 ? p : null;
  });
  if (!nights.length || per.some((p) => p === null)) return { ok: false, note: 'No price available for some of these nights. The team confirms.' };
  const total = per.reduce((a, b) => a + b, 0);
  const first = byDate.get(checkIn);
  const minStay = first?.min_stay > 0 ? first.min_stay : null;
  return {
    ok: true,
    currency,
    nights: nights.length,
    total: Math.round(total),
    average_per_night: Math.round(total / nights.length),
    minimum_stay_nights: minStay,
    meets_minimum_stay: minStay === null || nights.length >= minStay,
    check_in_allowed: first ? first.check_in !== false : true,
    check_out_allowed: byDate.get(checkOut) ? byDate.get(checkOut).check_out !== false : true,
    indicative: true
  };
}

// Query parameters the booking page reads. Dates are YYYY-MM-DD.
export const BOOKING_PARAMS = { checkIn: 'check_in_date', checkOut: 'check_out_date', adults: 'number_of_adult', children: 'number_of_children' };
// Currency the booking page should open in. Only sent when the guest asked for one (the page default is CHF).
export const CURRENCY_PARAM = 'currency';
// Promo code the booking page should prefill. Only a code that is active for this villa and fits the stay.
export const PROMO_PARAM = 'promo_code';
export const DM_UTM = { utm_source: 'instagram', utm_medium: 'dm', utm_campaign: 'agent' };

/** Booking page link of a villa with the stay already filled in. Throws a readable error on bad input. */
export function bookingLink(baseUrl, { checkIn, checkOut, adults, children = 0, currency, promo } = {}, extra = {}) {
  if (!baseUrl) throw new Error('This villa has no booking page yet. The team shares the link.');
  if (!isDate(checkIn) || !isDate(checkOut)) throw new Error('check_in and check_out must be YYYY-MM-DD');
  if (checkOut <= checkIn) throw new Error('check_out must be after check_in');
  const a = Number(adults);
  const c = Number(children ?? 0);
  if (!Number.isInteger(a) || a < 1 || a > 30) throw new Error('adults must be a whole number of at least 1');
  if (!Number.isInteger(c) || c < 0 || c > 20) throw new Error('children must be a whole number, 0 or more');
  const cur = currency ? String(currency).toUpperCase() : '';
  if (cur && !/^[A-Z]{3}$/.test(cur)) throw new Error('currency must be a 3-letter code, for example IDR');
  const code = promo ? String(promo).replace(/\s+/g, '').toUpperCase() : '';
  if (code && !/^[A-Z0-9][A-Z0-9_-]{2,23}$/.test(code)) throw new Error('promo_code is not a valid code');
  const u = new URL(baseUrl);
  u.searchParams.set(BOOKING_PARAMS.checkIn, checkIn);
  u.searchParams.set(BOOKING_PARAMS.checkOut, checkOut);
  u.searchParams.set(BOOKING_PARAMS.adults, String(a));
  u.searchParams.set(BOOKING_PARAMS.children, String(c));
  if (cur) u.searchParams.set(CURRENCY_PARAM, cur);
  if (code) u.searchParams.set(PROMO_PARAM, code);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  return u.toString();
}

export const TOOLS = [
  {
    name: 'list_villas',
    description: 'List The R Villas Bali properties with their facts (key, name, area, guests, bedrooms, size, highlights, booking link, active_promotions). Fields in uncertain_facts must not be stated as fact.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'check_availability',
    description: 'Check whether a villa is free for a stay. Always call this before saying anything about availability. check_out is the departure day.',
    input_schema: {
      type: 'object',
      properties: { villa: { type: 'string', description: 'Villa key from list_villas, e.g. samalas' }, check_in: { type: 'string', description: 'YYYY-MM-DD' }, check_out: { type: 'string', description: 'YYYY-MM-DD' } },
      required: ['villa', 'check_in', 'check_out'],
      additionalProperties: false
    }
  },
  {
    name: 'get_prices',
    description: 'Indicative total and average nightly price for a stay, plus the minimum stay. Only these numbers may be quoted. Call check_availability first.',
    input_schema: {
      type: 'object',
      properties: { villa: { type: 'string' }, check_in: { type: 'string', description: 'YYYY-MM-DD' }, check_out: { type: 'string', description: 'YYYY-MM-DD' } },
      required: ['villa', 'check_in', 'check_out'],
      additionalProperties: false
    }
  },
  {
    name: 'build_booking_link',
    description: 'Booking link of a villa with the stay already filled in (check-in, check-out, adults, children). Use it instead of the plain booking_link once the villa, both dates and the guest numbers are known from the guest. Never guess a value. Share the returned booking_link exactly as it is.',
    input_schema: {
      type: 'object',
      properties: {
        villa: { type: 'string', description: 'Villa key from list_villas' },
        check_in: { type: 'string', description: 'YYYY-MM-DD' },
        check_out: { type: 'string', description: 'YYYY-MM-DD, the departure day' },
        adults: { type: 'integer', description: 'Number of adults (13 and older), at least 1' },
        children: { type: 'integer', description: 'Number of children (2 to 12). 0 only if the guest said so or the group is clearly adults only.' },
        currency: { type: 'string', description: 'Only when the guest asked for prices in a currency other than CHF: its 3-letter code, for example IDR, EUR or USD. The booking page then opens in that currency. Leave it out otherwise.' },
        promo_code: { type: 'string', description: 'Only a code from active_promotions of this villa whose terms fit this stay and that you offered or the guest asked about. It is checked and goes into the link. Leave it out otherwise.' }
      },
      required: ['villa', 'check_in', 'check_out', 'adults', 'children'],
      additionalProperties: false
    }
  },
  {
    name: 'convert_currency',
    description: 'Converts an amount between currencies with a current exchange rate. Use it whenever you quote a price in another currency than the one get_prices returned, for example when a guest asks for IDR, EUR or USD. Never convert in your head. The result is indicative: say "about".',
    input_schema: {
      type: 'object',
      properties: { amount: { type: 'number', description: 'The amount to convert, for example the total from get_prices' }, from: { type: 'string', description: '3-letter code of the amount, for example CHF' }, to: { type: 'string', description: '3-letter code the guest asked for, for example IDR' } },
      required: ['amount', 'from', 'to'],
      additionalProperties: false
    }
  },
  {
    name: 'submit_reply',
    description: 'Finish with the reply to send to the guest. Call this exactly once, last.',
    input_schema: {
      type: 'object',
      properties: {
        reply: { type: 'string', description: 'The Instagram DM text, in the guest language. Plain text, no markdown.' },
        needs_human: { type: 'boolean', description: 'True when a person must handle or check this before anything is sent.' },
        reason: { type: 'string', description: 'Why a human is needed, or a one-line note for the team. Empty when not needed.' },
        intent: { type: 'string', enum: ['availability', 'price', 'info', 'booking', 'complaint', 'other'] },
        language: { type: 'string', description: 'Language of the reply, e.g. en, de, id' }
      },
      required: ['reply', 'needs_human', 'intent'],
      additionalProperties: false
    }
  }
];

export function systemPrompt(today) {
  const name = process.env.AGENT_NAME || 'Lea';
  return [
    `You are ${name}, the virtual Sales Assistant of The R Villas Bali, a portfolio of private villas in Pererenan, Canggu and Sanur that guests book direct. You answer Instagram direct messages.`,
    `Never claim to be a human. In the first reply of a conversation (no earlier lines from the team), introduce yourself in one short sentence, for example "Hi, ${name} here, the virtual Sales Assistant of The R Villas Bali." If a guest asks whether they are talking to a person or a bot, say clearly that you are ${name}, a virtual assistant, and that a team member can step in.`,
    `Today is ${today} (Bali time). Resolve relative dates like "next weekend" against it and state the exact dates back to the guest.`,
    '',
    'Style: short, correct and empathic. Answer the question directly in 1 to 3 sentences. Show in a few words that you understand what the guest wants (their trip, their group, their wish), then give the dates, price or link. No scene painting, no feature lists, no long explanations. Reply in the guest\'s language. Plain text, no markdown, at most one emoji. No filler and no words like "leverage", "seamless", "world-class" or "unlock".',
    '',
    'Facts and numbers:',
    '- Use only facts from the tools. Never invent amenities, distances, rules, discounts or availability.',
    '- A fact listed in uncertain_facts is not confirmed. Do not state it. Say the team confirms it.',
    '- Before saying a villa is free or not, call check_availability. Before naming a price, call get_prices for those exact dates. Quote only what the tools return and call it indicative: say the final price is shown on the booking page.',
    '- Prices are in the currency get_prices returns, usually CHF. If the guest asks for another currency (IDR, EUR, USD ...), call convert_currency for each amount you quote, say "about" and that the booking page shows the final price in the chosen currency. Name the original CHF amount too, so the guest can check it. Never convert in your head.',
    '- Mention the minimum stay when meets_minimum_stay is false or when it matters.',
    '- If dates, number of guests or both are missing, ask for them in one short question instead of guessing. Ask for adults and children together ("how many adults and how many children?"). You may suggest villas that fit the guest count.',
    '- A group larger than the villa sleeps (guests in list_villas) does not fit: say so and suggest a villa that does, or hand over to the team.',
    '- To book, share a booking link. Once the villa, check-in, check-out, the number of adults and the number of children are all known from the guest, call build_booking_link and share exactly the link it returns, because it opens the booking page with the stay already filled in. If the guest asked for a currency other than CHF, pass it as currency (3-letter code, for example IDR) so the page opens in that currency. Otherwise share the booking_link from list_villas. Never guess a date or a number for the link; if only the number of children is unclear, ask. Check availability first and do not send a link for dates that are not available: offer other dates or another villa.',
    '- Promotions: a villa may list active_promotions (code, terms, stay window, minimum nights, last booking day). You may offer one when the stay fits its terms and it helps the guest decide: at most once per conversation, in the words of the terms. Never invent, extend or combine offers and never promise a discount. If the guest asks for a discount and no active promotion fits, hand over to the team. When you share a promotion, call build_booking_link with its promo_code.',
    '- Do not promise a booking, do not take payment details, do not hold dates.',
    '- Never give access codes, WiFi details or exact addresses.',
    '',
    'Hand over to a person (needs_human true, still write a short polite holding reply) for: complaints, refunds, existing bookings, payments, discount or price negotiation, groups, weddings and events, long stays of more than 28 nights, special requests that the facts do not cover, medical or legal topics, and anything you are unsure about.',
    'You only handle The R Villas Bali. For anything else, say the team will get back to the guest.',
    'Finish by calling submit_reply once.'
  ].join('\n');
}
