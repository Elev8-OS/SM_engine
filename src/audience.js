import { q } from './db.js';
import { elev8Tool } from './agent/clients.js';

// Audience planner (phase 1: recommends only, spends nothing).
// Combines Elev8 guest origins, booking lead times and free nights with typical school-holiday windows.

const DAY = 86400000;
const TAG = process.env.AUDIENCE_TAG || 'indonesia';
const TTL = 6 * 3600 * 1000;

// country: [code, languages]. Names are translated in the UI.
const COUNTRIES = {
  AUSTRALIA: ['AU', ['en']], 'UNITED KINGDOM OF GREAT BRITAIN AND NORTHERN IRELAND': ['GB', ['en']], FRANCE: ['FR', ['fr']], GERMANY: ['DE', ['de']],
  'UNITED STATES OF AMERICA': ['US', ['en']], NETHERLANDS: ['NL', ['nl', 'en']], SWITZERLAND: ['CH', ['de', 'fr']], 'RUSSIAN FEDERATION': ['RU', ['ru']],
  INDONESIA: ['ID', ['id']], TURKEY: ['TR', ['tr', 'en']], UKRAINE: ['UA', ['uk', 'ru']], CANADA: ['CA', ['en', 'fr']], 'SAUDI ARABIA': ['SA', ['ar', 'en']],
  BELGIUM: ['BE', ['nl', 'fr']], ITALY: ['IT', ['it']], SINGAPORE: ['SG', ['en']], CHINA: ['CN', ['zh']], 'NEW ZEALAND': ['NZ', ['en']], NORWAY: ['NO', ['no']],
  AUSTRIA: ['AT', ['de']], SPAIN: ['ES', ['es']], DENMARK: ['DK', ['da']], ROMANIA: ['RO', ['ro']], INDIA: ['IN', ['en']], KAZAKHSTAN: ['KZ', ['ru']],
  'UNITED ARAB EMIRATES': ['AE', ['ar', 'en']], 'HONG KONG': ['HK', ['en']], MALAYSIA: ['MY', ['en']], JAPAN: ['JP', ['ja']], 'KOREA (REPUBLIC OF)': ['KR', ['ko']],
  SWEDEN: ['SE', ['sv']], POLAND: ['PL', ['pl']], PORTUGAL: ['PT', ['pt']], QATAR: ['QA', ['ar', 'en']], IRELAND: ['IE', ['en']], 'SOUTH AFRICA': ['ZA', ['en']],
  LITHUANIA: ['LT', ['lt']], 'TAIWAN, PROVINCE OF CHINA': ['TW', ['zh']], MEXICO: ['MX', ['es']], COLOMBIA: ['CO', ['es']], IRAN: ['IR', ['fa']]
};
// Used only when the country (residence) is blank.
const NATIONALITY = {
  AUSTRALIAN: 'AUSTRALIA', 'BRITISH, UK': 'UNITED KINGDOM OF GREAT BRITAIN AND NORTHERN IRELAND', FRENCH: 'FRANCE', GERMAN: 'GERMANY', AMERICAN: 'UNITED STATES OF AMERICA',
  'DUTCH, NETHERLANDIC': 'NETHERLANDS', SWISS: 'SWITZERLAND', RUSSIAN: 'RUSSIAN FEDERATION', INDONESIAN: 'INDONESIA', TURKISH: 'TURKEY', UKRAINIAN: 'UKRAINE', CANADIAN: 'CANADA',
  ITALIAN: 'ITALY', AUSTRIAN: 'AUSTRIA', SPANISH: 'SPAIN', 'NEW ZEALAND, NZ': 'NEW ZEALAND', NORWEGIAN: 'NORWAY', SINGAPOREAN: 'SINGAPORE', CHINESE: 'CHINA', BELGIAN: 'BELGIUM'
};
const CODE_BY_NAME = Object.fromEntries(Object.entries(COUNTRIES).map(([n, [c, l]]) => [c, { code: c, languages: l, name: n }]));

// Typical recurring school-holiday windows (MM-DD). Rough guide values: they differ by region and year.
const HOLIDAYS = {
  AU: [['summer', '12-20', '01-28'], ['easter', '04-01', '04-20'], ['winter', '07-04', '07-20'], ['spring', '09-22', '10-06']],
  GB: [['christmas', '12-19', '01-04'], ['feb_half', '02-14', '02-22'], ['easter', '03-28', '04-12'], ['may_half', '05-25', '05-31'], ['summer', '07-22', '09-02'], ['oct_half', '10-24', '11-01']],
  FR: [['autumn', '10-19', '11-03'], ['christmas', '12-19', '01-04'], ['winter', '02-07', '03-10'], ['spring', '04-04', '05-05'], ['summer', '07-06', '09-01']],
  DE: [['christmas', '12-22', '01-06'], ['easter', '03-28', '04-12'], ['pentecost', '05-24', '06-05'], ['summer', '07-01', '09-12'], ['autumn', '10-12', '10-30']],
  CH: [['christmas', '12-20', '01-04'], ['winter', '02-07', '02-22'], ['spring', '04-04', '04-19'], ['summer', '07-04', '08-16'], ['autumn', '10-03', '10-18']],
  AT: [['christmas', '12-24', '01-06'], ['winter', '02-01', '02-14'], ['easter', '03-28', '04-06'], ['summer', '07-04', '09-06'], ['autumn', '10-26', '10-31']],
  NL: [['autumn', '10-17', '10-25'], ['christmas', '12-19', '01-03'], ['winter', '02-14', '02-22'], ['may_half', '04-25', '05-03'], ['summer', '07-04', '08-30']],
  US: [['thanksgiving', '11-24', '11-29'], ['christmas', '12-20', '01-03'], ['spring', '03-07', '03-22'], ['summer', '06-01', '08-15']],
  NZ: [['summer', '12-18', '02-01'], ['easter', '04-03', '04-19'], ['winter', '07-04', '07-19'], ['spring', '09-26', '10-11']],
  RU: [['christmas', '12-30', '01-11'], ['may_half', '04-30', '05-11'], ['summer', '06-01', '08-31'], ['autumn', '10-26', '11-04']],
  ID: [['summer', '06-20', '07-12'], ['christmas', '12-20', '01-03']],
  SG: [['christmas', '11-21', '01-01'], ['summer', '05-30', '06-28']]
};
const RESTRICTED = new Set(['RU']); // Meta does not deliver ads to Russia in practice

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const round1 = (x) => Math.round(x * 10) / 10;
const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

function resolveCountry(country, nationality) {
  const c = String(country || '').trim().toUpperCase();
  if (c) return COUNTRIES[c] ? CODE_BY_NAME[COUNTRIES[c][0]] : { code: 'OTHER', languages: [], name: 'OTHER' };
  const n = NATIONALITY[String(nationality || '').trim().toUpperCase()];
  return n ? CODE_BY_NAME[COUNTRIES[n][0]] : null; // null: unknown
}

export function marketsFromOrigins(rows) {
  const agg = new Map();
  let unknownBookings = 0;
  let total = 0;
  for (const r of rows || []) {
    const bookings = Number(r.booking_count) || 0;
    if (!bookings) continue;
    const stay = Number(r.avg_stay_nights) || 0;
    const group = Number(r.avg_group_size) || 0;
    const c = resolveCountry(r.country, r.nationality);
    if (!c) {
      unknownBookings += bookings;
      continue;
    }
    total += bookings;
    const m = agg.get(c.code) || { code: c.code, languages: c.languages, bookings: 0, nights: 0, groupSum: 0 };
    m.bookings += bookings;
    m.nights += bookings * stay;
    m.groupSum += bookings * group;
    agg.set(c.code, m);
  }
  const totalNights = [...agg.values()].reduce((a, m) => a + m.nights, 0) || 1;
  const markets = [...agg.values()]
    .filter((m) => m.code !== 'OTHER')
    .map((m) => ({
      code: m.code,
      languages: m.languages,
      bookings: m.bookings,
      bookingShare: m.bookings / (total || 1),
      nightsShare: m.nights / totalNights,
      avgStay: round1(m.nights / m.bookings),
      avgGroup: round1(m.groupSum / m.bookings)
    }))
    // Half bookings, half nights: long stayers must not crowd out everyone else.
    .map((m) => ({ ...m, weight: 0.5 * m.bookingShare + 0.5 * m.nightsShare }))
    .filter((m) => m.bookings >= 5 && m.bookingShare >= 0.015)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 8);
  const all = unknownBookings + total;
  return { markets, unknownShare: all ? unknownBookings / all : 0, totalBookings: all };
}

export function leadStats(rows, villaKeys) {
  const villaRows = (rows || []).filter((r) => villaKeys.some((k) => String(r.listing_name || '').toLowerCase().includes(k)));
  const base = villaRows.length >= 30 ? villaRows : rows || [];
  const active = base.filter((r) => r.status === 1);
  const used = active.length ? active : base;
  const leads = used.map((r) => Math.round((new Date(r.check_in_date) - new Date(r.booked_at)) / DAY)).filter((n) => Number.isFinite(n) && n >= 0 && n < 730);
  const family = used.filter((r) => (r.number_of_childrens || 0) + (r.number_of_infants || 0) > 0).length;
  const channels = {};
  for (const r of used) {
    const lead = Math.round((new Date(r.check_in_date) - new Date(r.booked_at)) / DAY);
    if (!Number.isFinite(lead) || lead < 0 || lead > 730) continue;
    (channels[r.channel || '?'] ||= []).push(lead);
  }
  return {
    scope: villaRows.length >= 30 ? 'villas' : 'all',
    bookings: used.length,
    leadP25: pct(leads, 25),
    leadMedian: pct(leads, 50),
    leadP75: pct(leads, 75),
    familyShare: used.length ? family / used.length : 0,
    medianNights: pct(used.map((r) => Number(r.nights) || 0).filter(Boolean), 50),
    byChannel: Object.entries(channels).filter(([, v]) => v.length >= 15).map(([channel, v]) => ({ channel, bookings: v.length, leadMedian: pct(v, 50) })).sort((a, b) => b.bookings - a.bookings)
  };
}

export function nextWindow(code, todayMs, leadDays, horizonDays) {
  const defs = HOLIDAYS[code];
  if (!defs) return null;
  const y0 = new Date(todayMs).getUTCFullYear();
  const occ = [];
  for (const [name, from, to] of defs) {
    const [fm, fd] = from.split('-').map(Number);
    const [tm, td] = to.split('-').map(Number);
    for (const y of [y0 - 1, y0, y0 + 1]) {
      const start = Date.UTC(y, fm - 1, fd);
      const end = Date.UTC(tm < fm || (tm === fm && td < fd) ? y + 1 : y, tm - 1, td);
      if (end >= todayMs) occ.push({ name, start, end });
    }
  }
  occ.sort((a, b) => a.start - b.start);
  const w = occ[0];
  if (!w) return null;
  const adsStart = w.start - (leadDays ?? 45) * DAY;
  const status = todayMs >= w.start ? 'running' : todayMs >= adsStart ? 'now' : adsStart <= todayMs + horizonDays * DAY ? 'soon' : 'later';
  const inHorizon = w.start <= todayMs + horizonDays * DAY && w.end >= todayMs;
  return { name: w.name, start: iso(w.start), end: iso(w.end), adsStart: iso(Math.max(adsStart, todayMs)), daysUntil: Math.max(0, Math.ceil((w.start - todayMs) / DAY)), status, inHorizon };
}

// Travel inside the horizon is what fills the current gaps; later windows only matter for later gaps.
const timeFactor = (w) => (!w ? 0.5 : w.inHorizon ? (w.status === 'running' ? 0.6 : 1) : w.status === 'now' ? 0.5 : 0.3);
const angleFor = (m) => (m.avgStay >= 14 ? 'long_stay' : m.avgGroup >= 3 ? 'group' : m.avgStay <= 6 ? 'short_stay' : 'couple');

export function buildPlan({ origins, reservations, gaps, villas, today, days }) {
  const todayMs = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const { markets: base, unknownShare, totalBookings } = marketsFromOrigins(origins);
  const lead = leadStats(reservations, villas.map((v) => v.key));
  const leadForAds = lead.leadP75 ?? 45;

  const markets = base.map((m) => {
    const win = nextWindow(m.code, todayMs, leadForAds, days);
    const factor = timeFactor(win);
    const restricted = RESTRICTED.has(m.code);
    return { ...m, window: win, adsPossible: !restricted, angle: angleFor(m), score: m.weight * factor };
  });
  const budgetPool = markets.filter((m) => m.adsPossible).slice().sort((a, b) => b.score - a.score).slice(0, 5);
  const poolSum = budgetPool.reduce((a, m) => a + m.score, 0) || 1;
  for (const m of markets) m.budgetShare = budgetPool.includes(m) ? Math.round((m.score / poolSum) * 100) : 0;

  const villaPlans = villas
    .map((v) => {
      const g = gaps.filter((x) => String(x.listing_name || '').toLowerCase().includes(v.key));
      if (!g.length) return null;
      const free = g.reduce((a, x) => a + (Number(x.unbooked_nights) || 0), 0);
      const firstGap = g.map((x) => x.first_gap_date).filter(Boolean).sort()[0] || null;
      const ratio = clamp(free / (days * g.length), 0, 1);
      const scored = markets
        .filter((m) => m.adsPossible)
        .map((m) => {
          const groupFactor = (v.guests || 0) >= 6 ? clamp(m.avgGroup / 2, 0.8, 1.3) : 1;
          return { m, s: m.score * groupFactor, groupFactor };
        })
        .sort((a, b) => b.s - a.s)
        .slice(0, 3);
      const sum = scored.reduce((a, x) => a + x.s, 0) || 1;
      return {
        key: v.key,
        name: v.name,
        guests: v.guests,
        freeNights: free,
        freeRatio: Math.round(ratio * 100),
        firstGap,
        priority: ratio >= 0.7 ? 'high' : ratio >= 0.4 ? 'medium' : 'low',
        topMarkets: scored.map(({ m, s, groupFactor }) => ({
          code: m.code,
          share: Math.round((s / sum) * 100),
          angle: m.angle,
          languages: m.languages,
          reasons: [
            { key: 'share', params: { pct: Math.round(m.bookingShare * 100) } },
            ...(m.window ? [{ key: m.window.inHorizon || m.window.status === 'running' ? `window_${m.window.status}` : 'window_beyond', params: { name: m.window.name, start: m.window.start, end: m.window.end, adsStart: m.window.adsStart } }] : [{ key: 'no_window', params: {} }]),
            { key: m.angle, params: { stay: m.avgStay, group: m.avgGroup } },
            ...(groupFactor > 1.05 ? [{ key: 'big_villa_group', params: { guests: v.guests, group: m.avgGroup } }] : [])
          ]
        }))
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.freeNights - a.freeNights);

  const notes = ['holidays_approx', 'all_channels', 'no_conversion_feedback', 'meta_decides'];
  if (unknownShare >= 0.05) notes.push('unknown_country');
  if (markets.some((m) => !m.adsPossible)) notes.push('restricted_ru');
  return {
    generatedAt: new Date().toISOString(),
    horizonDays: days,
    basis: { bookings: totalBookings, unknownShare: Math.round(unknownShare * 100), ...lead, familyShare: Math.round(lead.familyShare * 100) },
    markets: markets.map((m) => ({
      code: m.code,
      languages: m.languages,
      bookings: m.bookings,
      bookingShare: Math.round(m.bookingShare * 100),
      nightsShare: Math.round(m.nightsShare * 100),
      avgStay: m.avgStay,
      avgGroup: m.avgGroup,
      angle: m.angle,
      adsPossible: m.adsPossible,
      budgetShare: m.budgetShare,
      window: m.window
    })),
    villas: villaPlans,
    notes
  };
}

let cache = { at: 0, days: 0, data: null };

export async function audiencePlan({ days = 60, refresh = false } = {}) {
  days = clamp(Math.round(Number(days) || 60), 14, 120);
  if (!refresh && cache.data && cache.days === days && Date.now() - cache.at < TTL) return cache.data;
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const todayIso = iso(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const yearAgo = iso(Date.parse(todayIso) - 365 * DAY);
  const villas = await q('select key, name, guests from properties order by key');
  const [origins, reservations, gaps] = await Promise.all([
    elev8Tool('get_guest_origins_by_tag', { from_date: yearAgo, to_date: todayIso, listing_tag: TAG }),
    elev8Tool('get_reservations_by_period_by_tag', { date_field: 'check_in', from_date: yearAgo, to_date: todayIso, listing_tag: TAG }),
    elev8Tool('get_upcoming_gaps_by_tag', { days_ahead: days, listing_tag: TAG })
  ]);
  const data = buildPlan({ origins: origins?.results, reservations: reservations?.results, gaps: gaps?.results || [], villas, today: new Date(todayIso), days });
  cache = { at: Date.now(), days, data };
  return data;
}

export function audienceRoutes(app, needDb, ah) {
  app.get('/audience/plan', needDb, ah(async (req, res) => res.json(await audiencePlan({ days: req.query.days, refresh: req.query.refresh === '1' }))));
}
