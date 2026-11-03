import { factsFor } from '../facts.js';
import { bookingLink, DM_UTM } from './tools.js';

const withUtm = (url) => (url ? `${url}${url.includes('?') ? '&' : '?'}utm_source=${DM_UTM.utm_source}&utm_medium=${DM_UTM.utm_medium}&utm_campaign=${DM_UTM.utm_campaign}` : null);
const USABLE = new Set(['confirmed', 'elev8']);

/** Max guests of a property: the fact sheet wins over the properties table. */
export const maxGuests = (p) => factsFor(p.key)?.guestsMax ?? p.guests ?? null;

/** One property as the agent sees it. A fact sheet, when there is one, replaces the table values it covers. */
export function villaView(p, multiUnit = false) {
  const f = factsFor(p.key);
  return {
    key: p.key,
    name: p.name,
    area: p.area,
    type: p.type,
    guests: f?.guestsMax ?? p.guests,
    // With a sheet the old size field is dropped: it does not say what the number measures.
    size_m2: f ? undefined : p.size_m2,
    plot_m2: f?.plotM2,
    bedrooms: f?.bedroomsText ?? p.bedrooms,
    bathrooms: f?.bathrooms,
    highlights: p.highlights,
    verified_facts: f ? f.facts.filter((x) => USABLE.has(x.status)).map((x) => x.text) : undefined,
    not_available: f?.absent?.length ? f.absent.map((a) => a.text) : undefined,
    uncertain_facts: f ? (f.open?.length ? f.open : undefined) : p.open_questions || undefined,
    booking_link: withUtm(p.url),
    note: multiUnit ? 'Several units. The team confirms availability and prices.' : undefined
  };
}

/** Result of the build_booking_link tool. Never throws: a problem is returned as a note the model can act on. */
export function linkResult(p, input, { multiUnit = false } = {}) {
  const adults = Number(input.adults);
  const children = Number(input.children ?? 0);
  const max = maxGuests(p);
  if (Number.isInteger(adults) && Number.isInteger(children) && max && adults + children > max) {
    return { ok: false, note: `${p.name} sleeps up to ${max} guests and this group is ${adults + children}. Do not send a link for it. Suggest a villa that fits the group or hand over to the team.` };
  }
  try {
    const url = bookingLink(p.url, { checkIn: input.check_in, checkOut: input.check_out, adults, children, currency: input.currency }, DM_UTM);
    return {
      ok: true,
      villa: p.name,
      check_in: input.check_in,
      check_out: input.check_out,
      adults,
      children,
      currency: input.currency ? String(input.currency).toUpperCase() : undefined,
      booking_link: url,
      note: multiUnit ? 'Several units. Say the team confirms which unit is free.' : 'Share this link exactly as it is.'
    };
  } catch (e) {
    return { ok: false, note: String(e.message || e) };
  }
}

/**
 * Adds the fees of a fact sheet (for example a cleaning fee) to a price summary.
 * total stays the accommodation; total_incl_fees is what to quote. A fee without an amount is ignored,
 * and a fee in another currency is not added but reported, so a wrong total is never quoted.
 */
export function withFees(summary, fees) {
  if (!summary?.ok) return summary;
  const usable = (fees || []).filter((f) => Number.isFinite(f.amount) && f.amount > 0);
  if (!usable.length) return summary;
  const other = usable.find((f) => f.currency && summary.currency && f.currency !== summary.currency);
  if (other) return { ...summary, fees_note: `A ${other.label || other.name} is set in ${other.currency}, the price is in ${summary.currency}. Say that the team confirms the fees.` };
  const list = usable.map((f) => ({ name: f.label || f.name, amount: Math.round(f.per === 'night' ? f.amount * summary.nights : f.amount), currency: summary.currency }));
  const feesTotal = list.reduce((a, f) => a + f.amount, 0);
  return { ...summary, fees: list, fees_total: feesTotal, total_incl_fees: summary.total + feesTotal, average_per_night_incl_fees: Math.round((summary.total + feesTotal) / summary.nights), note: `Quote total_incl_fees and say that it includes the ${list.map((f) => f.name).join(' and ')}.` };
}
