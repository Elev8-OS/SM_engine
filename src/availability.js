// Availability posts: a Facebook post for a villa that is really free for a stretch of nights.
// The free stretches come from Elev8 (blocked dates per listing, read-only). A stretch is the complement of the blocked ranges.
// Only single villas are used: the key is read from the Elev8 internal name ("ID - LUWA| ..."), rooms and apartments are skipped.

const DAY = 86400000;
const ms = (s) => Date.parse(`${s}T00:00:00Z`);
const iso = (t) => new Date(t).toISOString().slice(0, 10);

export const AVAILABILITY = { minLead: 2, maxLead: 21, minNights: 3, maxPerWeek: 2, repeatDays: 7 };
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "ID - LUWA| 5BR Pool ..." gives "luwa". Anything that does not follow the pattern gives null. */
export function keyOf(internalName) {
  const m = /^\s*ID\s*-\s*([A-Za-z0-9]+)\s*\|/.exec(String(internalName || ''));
  return m ? m[1].toLowerCase() : null;
}

/**
 * Free stretches of one listing between from and to (both inclusive, YYYY-MM-DD).
 * Blocked ranges and dates with unknown availability both count as not free.
 * Returns { checkIn, checkOut, nights, openStart, openEnd } with checkOut as the day after the last free night.
 * openStart / openEnd tell whether the stretch touches the edge of the read range (then the free time may go on beyond it).
 */
export function freeWindows(listing, from, to) {
  const a = ms(from);
  const b = ms(to);
  const busy = [];
  for (const r of listing?.blocked_ranges || []) busy.push([ms(r.start), ms(r.end)]);
  for (const d of listing?.unknown_dates || []) busy.push([ms(String(d).slice(0, 10)), ms(String(d).slice(0, 10))]);
  busy.sort((x, y) => x[0] - y[0]);
  const out = [];
  let cursor = a;
  const push = (start, endIncl) => {
    if (endIncl < start) return;
    out.push({ checkIn: iso(start), checkOut: iso(endIncl + DAY), nights: Math.round((endIncl - start) / DAY) + 1, openStart: start === a, openEnd: endIncl === b });
  };
  for (const [s, e] of busy) {
    if (e < cursor) continue;
    push(cursor, Math.min(s - DAY, b));
    cursor = Math.max(cursor, e + DAY);
    if (cursor > b) break;
  }
  if (cursor <= b) push(cursor, b);
  return out;
}

/**
 * All usable windows of the portfolio: a villa key, the dates and a score.
 * A window is usable when it starts at least minLead and at most maxLead days from today and has at least minNights nights.
 * A stretch that starts after a booking and ends before the next one (a real gap) comes first, then the earliest check-in.
 */
export function candidateWindows(results, { today, ...opt } = {}) {
  const o = { ...AVAILABILITY, ...opt };
  const t0 = ms(today);
  const from = iso(t0);
  const to = iso(t0 + (o.maxLead + 14) * DAY);
  const out = [];
  for (const l of results || []) {
    const key = keyOf(l.internal_name);
    if (!key) continue;
    for (const raw of freeWindows(l, from, to)) {
      // A guest cannot arrive before minLead: clip the start, the stretch may begin earlier than that.
      const start = Math.max(ms(raw.checkIn), t0 + o.minLead * DAY);
      const w = { ...raw, checkIn: iso(start), nights: Math.round((ms(raw.checkOut) - start) / DAY) };
      const lead = Math.round((start - t0) / DAY);
      if (lead > o.maxLead || w.nights < o.minNights) continue;
      out.push({ key, ...w, lead, gap: !w.openStart && !w.openEnd });
    }
  }
  return out.sort((x, y) => Number(y.gap) - Number(x.gap) || x.lead - y.lead || x.key.localeCompare(y.key));
}

/** Picks the first window whose villa is allowed and not used lately. */
export function pickWindow(windows, { allowed, recentKeys = [] } = {}) {
  const skip = new Set(recentKeys);
  return windows.find((w) => (!allowed || allowed.has(w.key)) && !skip.has(w.key)) || null;
}

/** "5 Dec" */
export function shortDate(d) {
  const t = new Date(`${d}T00:00:00Z`);
  return `${t.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][t.getUTCMonth()]}`;
}

export function availabilityPromptBlock(a) {
  if (!a) return [];
  return [
    '',
    'AVAILABILITY (the only dates and offer you may use):',
    `- Free from ${shortDate(a.checkIn)} (check-in) to ${shortDate(a.checkOut)} (check-out), ${a.nights} nights. Write the dates like "${shortDate(a.checkIn)}".`,
    '- Name only these dates. No other date, no price, no discount, no promo code, no "last chance", "only" or "hurry". The post invites, it does not pressure.',
    '- Do not claim the villa is "fully booked around" these dates or that it is rare. State the free dates and paint one moment of the stay.'
  ];
}

const MONTH_RE = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*';
const PRESSURE = /\b(last (chance|minute|call)|hurry|only \d+ (nights?|days?|spots?|left)|almost gone|selling fast|don'?t miss)\b|\b\d+ ?%|\bdiscount\b|\bpromo\b|\bsale\b/i;
const MONEY = /\b(idr|usd|eur|chf|rp)\b ?\d|[$€] ?\d|\d ?(idr|usd|eur|chf)\b/i;

/** Warnings for an availability post: dates outside the window, prices, discounts and pressure wording. */
export function checkAvailability(copy, plan) {
  const a = plan?.availability;
  if (!a) return [];
  const warnings = [];
  const text = Object.values(copy?.captions || {}).join(' ') + ' ' + JSON.stringify(copy?.lines || []);
  const year = Number(a.checkIn.slice(0, 4));
  const lo = ms(a.checkIn);
  const hi = ms(a.checkOut);
  const found = new Set();
  const re1 = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b`, 'gi');
  const re2 = new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gi');
  for (const m of text.matchAll(re1)) found.add(`${m[1]}|${m[2].toLowerCase()}`);
  for (const m of text.matchAll(re2)) found.add(`${m[2]}|${m[1].toLowerCase()}`);
  for (const f of found) {
    const [day, mon] = f.split('|');
    const m = MONTHS.indexOf(mon);
    const t = [year - 1, year, year + 1].map((y) => Date.UTC(y, m, Number(day))).sort((x, y) => Math.abs(x - lo) - Math.abs(y - lo))[0];
    if (t < lo || t > hi) warnings.push(`Date outside the free window: ${day} ${mon} (free ${shortDate(a.checkIn)} to ${shortDate(a.checkOut)})`);
  }
  if (MONEY.test(text)) warnings.push('Availability posts must not name a price');
  if (PRESSURE.test(text)) warnings.push('Availability posts must not use discount or pressure wording');
  return warnings;
}
