// Weekly grid (ISO weekday: 1 = Monday). Agreed with the client; edit here to change the plan.
export const WEEK = {
  1: { format: 'reel', pillar: 'villa_spotlight' },
  2: { format: 'carousel', pillar: 'which_villa_for' },
  3: { format: 'single', pillar: 'design_details' },
  4: { format: 'reel', pillar: 'neighbourhood' },
  5: { format: 'carousel', pillar: 'workation_or_book_direct' },
  6: { format: 'reel', pillar: 'villa_spotlight' },
  7: { format: 'carousel', pillar: 'villa_spotlight' }
};

export const PILLARS = {
  villa_spotlight: 'One villa, one angle: the view, the pool or a walk through the rooms. Put the reader inside one moment of the stay, calm, specific and visual.',
  which_villa_for: 'Match villas to groups, for example couples, families or friends travelling together. One slide per villa: the headline paints the moment that group would love, the sub line names the villa. Use guest numbers and size from the facts.',
  design_details: 'A single design detail: light, materials, bathroom, kitchen or pool. Quiet mood, almost no text, one feeling the reader can sense.',
  neighbourhood: 'The area around the villa. Use only the area facts provided, never invent places or distances.',
  workation: 'Working from a villa: desk, WiFi, view, longer stays. Only for properties that have a workspace in the facts.',
  book_direct: 'Why booking direct is better: best rate guaranteed, no platform in between, direct contact with the team. No invented discounts.'
};

export const RULES = [
  'Write in English and speak to the reader directly with "you". Warm, short sentences. No filler words like "leverage", "world-class", "unlock" or "seamless".',
  'Write feelings, not feature lists. Never string amenities together in a row. Open with a moment the reader can step into, for example waking up, the first swim or a long dinner, and let one or two facts appear inside that moment.',
  'Make the reader imagine being there: present tense, concrete and visual. Describe what they would see or do, using only what the photo descriptions show.',
  'Facts stay strict. Use only the facts provided and what the photo descriptions show. Never invent amenities, distances, prices, discounts, review quotes, weather, sounds, smells, staff or services.',
  'Headlines on slides: 3 to 8 words, no more than 70 characters. Each one is a small feeling or image, not a label. Not "Private pool" but "Slow mornings by your own pool".',
  'Never claim a number of bedrooms or guests that is not in the facts. Use numbers only where they help the picture, for example room for all of you.',
  'The call to action is to book direct on the website. Instagram and TikTok captions end with "Link in bio". Facebook captions never mention the bio and never contain a URL: the booking link is added automatically.'
];

export function isoWeekday(d) {
  const day = d.getUTCDay();
  return day === 0 ? 7 : day;
}

export function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
}

export function slotFor(date) {
  const slot = { ...WEEK[isoWeekday(date)] };
  if (slot.pillar === 'workation_or_book_direct') {
    slot.pillar = isoWeek(date) % 2 === 0 ? 'workation' : 'book_direct';
  }
  return slot;
}

export const COPY_SCHEMA = {
  hook: 'Reel only: opening line, max 60 characters, a moment or feeling that makes the viewer picture themselves there',
  subhook: 'Reel only: small line under the hook, optional',
  lines: 'One entry per photo in the given order: { headline (max 70 characters, a feeling or image, not a label), sub (optional, max 60, may carry the plain fact such as the villa name) }. For the first photo of a reel use the hook instead.',
  endCard: '{ title, subtitle } for the last slide or reel end card. The website address is added automatically',
  captions: '{ instagram, facebook, tiktok }. Instagram: 2 to 4 short paragraphs. The first line is a scene or feeling that stops the scroll. The middle invites the reader into the place, with facts only inside the scene and never as a list. The last line is the call to action. Facebook: slightly longer, same warmth, no URL and no mention of the bio. TikTok: one short hook line plus one sentence.',
  hashtags: 'Array of 5 to 8 relevant hashtags for Instagram, without the # sign',
  altTexts: 'Array with one alt text per photo, max 120 characters each, describing only what the photo shows'
};
