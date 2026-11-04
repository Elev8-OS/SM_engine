import { q } from './db.js';
import { HttpError } from './util.js';
import { factsFor } from './facts.js';
import { cleanPromo, problem, isLive, matchGaps, suggest } from './promo-rules.js';
import { competitorRoutes } from './competitors.js';

// Promotions ("Aktionen"): codes created by hand in Elev8. The team enters the code and its terms in the SM Manager,
// the post generator and Lea use only what is active here. Writing codes into Elev8 by API comes later.

let ready = null;
export function ensurePromoSchema() {
  if (!ready) {
    ready = q(`create table if not exists promos (
      id serial primary key,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      property_key text not null,
      title text not null,
      code text not null default '',
      terms text not null default '',
      stay_from date,
      stay_to date,
      book_until date,
      min_nights int,
      status text not null default 'draft',
      source text not null default 'manual',
      suggestion_id text,
      note text not null default ''
    )`)
      .then(() => q('create index if not exists promos_status_idx on promos (status)'))
      .catch((e) => {
        ready = null;
        throw e;
      });
  }
  return ready;
}

// Dates come back as YYYY-MM-DD text, not as JS dates
const COLS = `id, created_at, updated_at, property_key, title, code, terms, stay_from::text as stay_from, stay_to::text as stay_to, book_until::text as book_until, min_nights, status, source, suggestion_id, note`;
const today = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

/** Promotions that are running on a day (default today, Bali time). */
export async function livePromos(day = today()) {
  await ensurePromoSchema();
  const rows = await q(`select ${COLS} from promos where status = 'active'`);
  return rows.filter((p) => isLive(p, day));
}

/** Running promotions for these villas, plus those for all villas. */
export async function livePromosFor(keys, day = today()) {
  return (await livePromos(day)).filter((p) => p.property_key === 'all' || keys.includes(p.property_key));
}

const bad = (e) => new HttpError(400, String(e.message || e));

async function checkVilla(key) {
  if (key === 'all') return;
  const rows = await q('select 1 from properties where key = $1', [key]);
  if (!rows.length) throw new HttpError(400, `Unknown villa '${key}'`);
}

export function promoRoutes(app, needDb, ah) {
  app.get('/promos', needDb, ah(async (_req, res) => {
    await ensurePromoSchema();
    const day = today();
    const rows = await q(`select ${COLS} from promos order by (status = 'active') desc, id desc limit 200`);
    res.json({ today: day, promos: rows.map((p) => ({ ...p, live: isLive(p, day) })) });
  }));

  // Ideas from the open nights in Elev8. They change nothing: the team adopts one and enters the code.
  app.get('/promos/suggestions', needDb, ah(async (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 60, 14), 120);
    const day = today();
    try {
      const { elev8Tool } = await import('./agent/clients.js');
      const r = await elev8Tool('get_upcoming_gaps', { days_ahead: days });
      const props = (await q('select key, name, guests from properties where active order by key')).map((p) => ({ ...p, guests: factsFor(p.key)?.guestsMax ?? p.guests }));
      res.json({ today: day, days, suggestions: suggest(matchGaps(r?.results, props, days), day, days) });
    } catch (e) {
      res.json({ today: day, days, suggestions: [], error: String(e.message || e).slice(0, 200) });
    }
  }));

  app.post('/promos', needDb, ah(async (req, res) => {
    await ensurePromoSchema();
    let clean;
    try {
      clean = cleanPromo(req.body || {}, { create: true });
    } catch (e) {
      throw bad(e);
    }
    const p = { status: 'draft', code: '', terms: '', note: '', stay_from: null, stay_to: null, book_until: null, min_nights: null, suggestion_id: null, ...clean };
    const err = problem(p);
    if (err) throw new HttpError(400, err);
    await checkVilla(p.property_key);
    const source = req.body?.source === 'suggestion' ? 'suggestion' : 'manual';
    const rows = await q(
      `insert into promos (property_key, title, code, terms, stay_from, stay_to, book_until, min_nights, status, source, suggestion_id, note)
       values ($1,$2,$3,$4,$5::date,$6::date,$7::date,$8,$9,$10,$11,$12) returning ${COLS}`,
      [p.property_key, p.title, p.code, p.terms, p.stay_from, p.stay_to, p.book_until, p.min_nights, p.status, source, p.suggestion_id, p.note]
    );
    res.status(201).json(rows[0]);
  }));

  app.put('/promos/:id', needDb, ah(async (req, res) => {
    await ensurePromoSchema();
    const id = Number(req.params.id);
    const [old] = await q(`select ${COLS} from promos where id = $1`, [id]);
    if (!old) throw new HttpError(404, 'Promotion not found');
    let clean;
    try {
      clean = cleanPromo(req.body || {});
    } catch (e) {
      throw bad(e);
    }
    const p = { ...old, ...clean };
    const err = problem(p);
    if (err) throw new HttpError(400, err);
    if (clean.property_key) await checkVilla(p.property_key);
    const rows = await q(
      `update promos set property_key=$2, title=$3, code=$4, terms=$5, stay_from=$6::date, stay_to=$7::date, book_until=$8::date, min_nights=$9, status=$10, note=$11, updated_at=now()
       where id = $1 returning ${COLS}`,
      [id, p.property_key, p.title, p.code, p.terms, p.stay_from, p.stay_to, p.book_until, p.min_nights, p.status, p.note]
    );
    res.json({ ...rows[0], live: isLive(rows[0], today()) });
  }));

  app.delete('/promos/:id', needDb, ah(async (req, res) => {
    await ensurePromoSchema();
    await q('delete from promos where id = $1', [Number(req.params.id)]);
    res.json({ id: Number(req.params.id), deleted: true });
  }));

  // Benchmark of other providers' Instagram accounts
  competitorRoutes(app, needDb, ah);
}
