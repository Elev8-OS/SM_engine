import { q } from './db.js';
import { HttpError } from './util.js';
import { factsFor } from './facts.js';
import { cleanPromo, isLive, matchGaps, suggest } from './promo-rules.js';
import { competitorRoutes } from './competitors.js';
import { startPromoMirror, runMirror, lastMirror, activatePromo, runPlan, lastPlan, autopilotOn } from './promo-elev8.js';

// Promotions ("Aktionen"). Codes are created in two places only:
//   - by a person in Elev8: they are mirrored here at once (promo-elev8.js), their status follows Elev8;
//   - by the engine itself: it proposes promotions (drafts with the reasoning), and when one is switched on (by a person, or by the
//     engine with PROMO_AUTOPILOT=on) it creates the code in Elev8.
// Nobody creates a code in the SM Manager by hand. Several promotions can be active at the same time, and one code can be for several
// villas: the rows of such a code (one per villa) share the same code and are shown and switched on together.
// The post generator, the WhatsApp catalog and Lea use only what is active here.

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

// The content of a promotion (villa, code, terms, dates) is never changed here: it comes from Elev8 or from the engine.
const CONTENT_FIELDS = ['property_key', 'title', 'code', 'terms', 'stay_from', 'stay_to', 'book_until', 'min_nights'];

// A round of the planner on one short line per proposal, for a quick look: code, number of villas, benefit, minimum stay, cost share.
const brief = (r) => ({
  at: r.at,
  dry: r.dry,
  autopilot: r.autopilot,
  n: r.proposed?.length ?? 0,
  proposed: (r.proposed || []).map((p) => `${p.code} ${(p.keys || []).length}v ${p.benefit} min${p.min_nights ?? '-'} ${Math.round((p.cost_share || 0) * 100)}%`).join(' | '),
  skipped: (r.skipped || []).map((s) => String(s).replace(/^The R /, '').slice(0, 90)),
  errors: r.errors
});

export function promoRoutes(app, needDb, ah) {
  // Mirror of the codes of Elev8 (every 5 minutes) and the planner of the engine.
  startPromoMirror({ ensureSchema: ensurePromoSchema });

  app.get('/promos', needDb, ah(async (_req, res) => {
    await ensurePromoSchema();
    const day = today();
    const rows = await q(`select ${COLS} from promos order by (status = 'active') desc, (status = 'draft') desc, id desc limit 300`);
    res.json({ today: day, autopilot: autopilotOn(), promos: rows.map((p) => ({ ...p, live: isLive(p, day) })) });
  }));

  // The last run of the mirror of Elev8 codes, and a run on demand.
  app.get('/promos/mirror', needDb, ah(async (_req, res) => res.json(lastMirror() || { at: null, note: 'No run since the start yet' })));
  app.post('/promos/mirror', needDb, ah(async (_req, res) => res.json(await runMirror({ ensureSchema: ensurePromoSchema }))));

  // The planner of the engine. GET shows the last round; GET ?dry=1 plays a round and shows what it would propose (nothing is stored
  // or created); GET ?run=1 stores a round now (?replace=1 drops the open proposals of the engine first: drafts, nothing in Elev8).
  // POST runs a round that stores the proposals (?dry=1 plays it only). ?brief=1 shortens the answer to one line per proposal.
  app.get('/promos/plan', needDb, ah(async (req, res) => {
    const short = String(req.query.brief || '') === '1';
    if (String(req.query.run || '') === '1') {
      await ensurePromoSchema();
      if (String(req.query.replace || '') === '1') await q("delete from promos where source = 'engine' and status = 'draft'");
      const r = await runPlan({ ensureSchema: ensurePromoSchema });
      return res.json(short ? brief(r) : r);
    }
    if (String(req.query.dry || '') === '1') {
      const r = await runPlan({ ensureSchema: ensurePromoSchema, dry: true });
      return res.json(short ? brief(r) : r);
    }
    const last = lastPlan();
    res.json({ autopilot: autopilotOn(), last: short && last ? brief(last) : last });
  }));
  app.post('/promos/plan', needDb, ah(async (req, res) => res.json(await runPlan({ ensureSchema: ensurePromoSchema, dry: String(req.query.dry || '') === '1' }))));

  // Ideas from the open nights in Elev8 (what the planner starts from). They change nothing.
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

  // Codes cannot be created by hand any more.
  app.post('/promos', needDb, ah(async () => {
    throw new HttpError(403, 'Codes are not created in the SM Manager. Create a code in Elev8 (it appears here within minutes), or let the engine propose one.');
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
      throw new HttpError(400, String(e.message || e));
    }
    const changed = CONTENT_FIELDS.filter((k) => k in clean && String(clean[k] ?? '') !== String(old[k] ?? ''));
    if (changed.length) throw new HttpError(409, `${old.source === 'elev8' ? `This promotion comes from Elev8 (code ${old.code}). Change it there.` : 'The engine decides the content of a promotion.'} Not changed here: ${changed.join(', ')}.`);
    const next = clean.status;
    if (next && next !== old.status) {
      if (old.source === 'elev8') throw new HttpError(409, `The status of ${old.code} follows Elev8. Switch the code on or off there.`);
      if (old.source === 'engine') {
        if (next === 'active') {
          // Creates the code in Elev8 (once, for all villas of the code). If that fails nothing changes here.
          try {
            const row = await activatePromo(id, { ensureSchema: ensurePromoSchema });
            return res.json({ ...row, live: isLive(row, today()) });
          } catch (e) {
            throw new HttpError(502, String(e.message || e).slice(0, 400));
          }
        }
        if (next !== 'ended' || old.status !== 'draft') throw new HttpError(409, 'A proposal of the engine can be switched on or rejected.');
      } else if (next !== 'ended') {
        throw new HttpError(409, 'This promotion was entered by hand. It can only be ended, new codes are created in Elev8.');
      }
    }
    const rows = await q(`update promos set status = $2, note = $3, updated_at = now() where id = $1 returning ${COLS}`, [id, next ?? old.status, clean.note ?? old.note]);
    res.json({ ...rows[0], live: isLive(rows[0], today()) });
  }));

  app.delete('/promos/:id', needDb, ah(async (req, res) => {
    await ensurePromoSchema();
    const id = Number(req.params.id);
    const [old] = await q('select source, status, code from promos where id = $1', [id]);
    if (old?.source === 'elev8') throw new HttpError(409, `This promotion comes from Elev8 (code ${old.code}). It is ended there.`);
    if (old?.source === 'engine' && old.status !== 'draft') throw new HttpError(409, 'Only a proposal can be removed.');
    // Several villas share one code: the rows of the same proposal go together.
    if (old?.source === 'engine' && old.code) await q("delete from promos where source = 'engine' and status = 'draft' and code = $1", [old.code]);
    else await q('delete from promos where id = $1', [id]);
    res.json({ id, deleted: true });
  }));

  // Benchmark of other providers' Instagram accounts
  competitorRoutes(app, needDb, ah);
}
