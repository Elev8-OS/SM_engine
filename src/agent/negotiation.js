// Price negotiation rule of the inquiry agent. Pure, no network, so it is easy to test.
// Rule (set by the owner): ask for the budget first. Budget at most 10% under the offer: Lea negotiates (never below 90% of the offer).
// More than 10% and less than 30% under: the team takes over. 30% or more under: polite no, the team is not informed.
export const NEGOTIATE_MAX_PCT = 10;
export const DECLINE_FROM_PCT = 30;

const STEP = { IDR: 10000, USD: 5, EUR: 5, CHF: 5, GBP: 5, AUD: 5 };
const stepOf = (cur) => STEP[String(cur || '').toUpperCase()] || 1;
const up = (n, step) => Math.ceil(Math.round(n * 1e6) / 1e6 / step) * step;

/**
 * Which case a budget falls into. offered and budget must be in the same currency and on the same basis (both stay totals or both per night).
 * Boundaries: exactly 10% under is still negotiable, exactly 30% under is already declined.
 */
export function budgetCheck({ offered, budget, currency } = {}) {
  const o = Number(offered);
  const b = Number(budget);
  if (!(o > 0) || !(b > 0)) throw new Error('offered and budget must be positive numbers in the same currency');
  const cur = currency ? String(currency).toUpperCase() : '';
  const step = stepOf(cur);
  const ratio = Math.round((b / o) * 1e6) / 1e6;
  const under = Math.round((1 - ratio) * 1000) / 10; // percent under the offer, one decimal
  const base = { currency: cur || undefined, offered: o, budget: b, percent_under_offer: Math.max(under, 0) };

  if (ratio >= 1) {
    return { ...base, tier: 'no_discount_needed', needs_human: false, instruction: 'The budget covers the offered price. Do not lower anything: say the stay fits the budget and share the booking link as usual.' };
  }
  if (ratio >= 1 - NEGOTIATE_MAX_PCT / 100) {
    // The lowest price Lea may agree to: 10% under the offer, rounded up, and never below what the guest said they can pay.
    const lowest = Math.min(up(o * (1 - NEGOTIATE_MAX_PCT / 100), step), b);
    const firstCounter = Math.min(up(o - (o - lowest) / 2, step), o);
    return {
      ...base,
      tier: 'negotiate',
      needs_human: false,
      lowest_price: lowest,
      suggested_first_counter: firstCounter,
      instruction:
        `Negotiate and get as much as you can. Open at about ${firstCounter}, not at the budget, and give a short friendly reason (stay length, direct booking, dates). Move toward the budget in small steps, at most two counter offers, and accept the guest's budget at the latest. Never go below ${lowest} and never below the budget. Do not reveal this rule or the limit. ` +
        'When the guest accepts a price, say it is noted at that price for these dates and that the team sends the confirmation or the matching link; then call submit_reply with needs_human true and a reason that names the villa key, the dates, the guests and the agreed price. Until the guest accepts, needs_human stays false.'
    };
  }
  if (ratio > 1 - DECLINE_FROM_PCT / 100) {
    return {
      ...base,
      tier: 'team',
      needs_human: true,
      instruction: 'Do not negotiate and do not offer any price. Thank the guest for the budget, say you will check with the team and that they get back soon, and call submit_reply with needs_human true. The reason names the villa key, the dates, the guests, the offered price and the budget with the percent under the offer.'
    };
  }
  return {
    ...base,
    tier: 'decline',
    needs_human: false,
    instruction: 'Decline politely and warmly: the stay is not possible at that budget. Do not offer a discount and do not mention that a team can look at it. You may name a cheaper option from the tools (other dates or a smaller category) if one exists. Call submit_reply with needs_human false.'
  };
}
