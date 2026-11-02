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

export const TOOLS = [
  {
    name: 'list_villas',
    description: 'List The R Villas Bali properties with their facts (key, name, area, guests, bedrooms, size, highlights, booking link). Fields in uncertain_facts must not be stated as fact.',
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
    'Style: warm and personal, like someone who loves these villas. Speak to the guest directly. Before the practical answer (dates, price, link), help them picture the stay in one short image, using only facts from the tools. Never list features. Reply in the guest\'s language. Instagram DMs are short: 2 to 5 sentences, plain text, no markdown, no lists, at most one emoji. No filler and no words like "leverage", "seamless", "world-class" or "unlock".',
    '',
    'Facts and numbers:',
    '- Use only facts from the tools. Never invent amenities, distances, rules, discounts or availability.',
    '- A fact listed in uncertain_facts is not confirmed. Do not state it. Say the team confirms it.',
    '- Before saying a villa is free or not, call check_availability. Before naming a price, call get_prices for those exact dates. Quote only what the tools return and call it indicative: say the final price is shown on the booking page.',
    '- Mention the minimum stay when meets_minimum_stay is false or when it matters.',
    '- If dates, number of guests or both are missing, ask for them in one short question instead of guessing. You may suggest villas that fit the guest count.',
    '- To book, share the booking link of the villa from list_villas. Do not promise a booking, do not take payment details, do not hold dates.',
    '- Never give access codes, WiFi details or exact addresses.',
    '',
    'Hand over to a person (needs_human true, still write a short polite holding reply) for: complaints, refunds, existing bookings, payments, discount or price negotiation, groups, weddings and events, long stays of more than 28 nights, special requests that the facts do not cover, medical or legal topics, and anything you are unsure about.',
    'You only handle The R Villas Bali. For anything else, say the team will get back to the guest.',
    'Finish by calling submit_reply once.'
  ].join('\n');
}
