import { q, dbEnabled } from './db.js';
import { normaliseCode } from './promo-rules.js';

// Mirror of the promo codes of Elev8 (the booking website) in the promotions of the SM Manager ("Aktionen").
// Elev8 is the source for what a code is: code, benefit, terms, dates. The SM Manager decides whether the assistant and the
// posts use it. So:
//   - a new code arrives as a DRAFT and is switched on by a person in the SM Manager;
//   - code, terms and dates of a mirrored promotion cannot be edited in the SM Manager (change them in Elev8, they follow within the hour);
//   - a code that is switched off, used up or gone in Elev8 is set to "ended" here; it is never switched on again by itself;
//   - codes that are expired, switched off, used up or single-use vouchers are not mirrored (single-use vouchers hold personal text).
// Elev8 offers no tool to change or delete a code, so nothing is written back. ELEV8_PROMO_MIRROR=off stops the mirror.

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,23}$/;
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const today = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

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

/**
 * One code of Elev8 as promotions of the SM Manager. Returns { skip } for a code that is not mirrored, else
 * { code, ended, expired, rows }: ended = switched off or used up in Elev8, expired = a window has passed.
 * propKeys: the keys of the properties of the SM Manager.
 */
export function mapElev8Promo(e, propKeys, day = today()) {
  const code = normaliseCode(e?.promo_code);
  if (!CODE_RE.test(code)) return { code, skip: 'code cannot be used in the SM Manager' };
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
function ensureMirrorSchema() {
  schemaReady ??= (async () => {
    await q('alter table promos add column if not exists external_id text');
    await q('create unique index if not exists promos_external_id_idx on promos (external_id) where external_id is not null');
  })().catch((err) => {
    schemaReady = null;
    throw err;
  });
  return schemaReady;
}

/** Reads the codes of Elev8 and brings the mirrored promotions in line. Returns what it did. */
export async function mirrorElev8Promos({ ensureSchema }) {
  await ensureSchema();
  await ensureMirrorSchema();
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
    for (const row of m.rows) {
      wanted.push(row.external_id);
      const [ex] = await q('select id, status from promos where external_id = $1', [row.external_id]);
      if (ex) {
        // Facts follow Elev8. The status only moves to ended (or back to draft when Elev8 switched the code on again).
        const status = m.ended && ex.status !== 'ended' ? 'ended' : !m.ended && !m.expired && ex.status === 'ended' ? 'draft' : ex.status;
        const upd = await q(
          `update promos set property_key = $2, title = $3, code = $4, terms = $5, stay_from = $6::date, stay_to = $7::date, book_until = $8::date, min_nights = $9, status = $10, updated_at = now()
           where id = $1 and (property_key, title, code, terms, stay_from, stay_to, book_until, min_nights, status) is distinct from ($2::text, $3::text, $4::text, $5::text, $6::date, $7::date, $8::date, $9::int, $10::text) returning id`,
          [ex.id, row.property_key, row.title, row.code, row.terms, row.stay_from, row.stay_to, row.book_until, row.min_nights, status]
        );
        if (upd.length) (status !== ex.status && status === 'ended' ? out.ended : out.updated).push(`${row.code} (${row.property_key})`);
        continue;
      }
      if (m.ended || m.expired) {
        out.skipped.push(`${m.code}: ${m.ended ? 'switched off or used up' : 'a window has passed'}, not mirrored`);
        continue;
      }
      // A promotion entered by hand with the same code is taken over, with its status, so it does not appear twice.
      const [adopt] = await q("select id from promos where upper(code) = $1 and external_id is null and source <> 'elev8' and property_key = $2 limit 1", [row.code, row.property_key]);
      if (adopt) {
        await q(
          `update promos set external_id = $2, source = 'elev8', title = $3, terms = $4, stay_from = $5::date, stay_to = $6::date, book_until = $7::date, min_nights = $8, updated_at = now() where id = $1`,
          [adopt.id, row.external_id, row.title, row.terms, row.stay_from, row.stay_to, row.book_until, row.min_nights]
        );
        out.updated.push(`${row.code} (${row.property_key}, taken over)`);
        continue;
      }
      await q(
        `insert into promos (property_key, title, code, terms, stay_from, stay_to, book_until, min_nights, status, source, suggestion_id, note, external_id)
         values ($1,$2,$3,$4,$5::date,$6::date,$7::date,$8,'draft','elev8',null,$9,$10)`,
        [row.property_key, row.title, row.code, row.terms, row.stay_from, row.stay_to, row.book_until, row.min_nights, `From Elev8 (code ${row.code}). Change it there; switch it on here when the assistant and the posts may use it.`, row.external_id]
      );
      out.created.push(`${row.code} (${row.property_key})`);
    }
  }
  // Mirrored promotions whose code is gone from Elev8 (or no longer maps to this property) end here.
  const gone = await q("update promos set status = 'ended', updated_at = now() where source = 'elev8' and external_id is not null and status <> 'ended' and not (external_id = any($1::text[])) returning code, property_key", [wanted]);
  for (const g of gone) out.ended.push(`${g.code} (${g.property_key}, no longer in Elev8)`);
  return out;
}

let timer = null;
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

/** First run half a minute after the start, then every hour. */
export function startPromoMirror({ ensureSchema }) {
  if (timer || /^(off|false|0|no)$/i.test(String(process.env.ELEV8_PROMO_MIRROR || '').replace(/["'\s]/g, ''))) return;
  const run = () => {
    if (dbEnabled()) runMirror({ ensureSchema }).catch(() => {});
  };
  setTimeout(run, 30000).unref();
  timer = setInterval(run, 3600 * 1000);
  timer.unref();
}
