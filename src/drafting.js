import { q } from './db.js';
import { HttpError } from './util.js';

// Automatic drafting: the Make scenario calls /plan/next once a day with no date and no villa. Whether that creates a post is decided
// here, by a switch the team sets in the SM Manager (default: off), and for the day LEAD days ahead. A call that names a date or a
// villa is a manual run and always goes through. The reasons the team gave when rejecting posts flow into the next briefs.
export const DEFAULT_LEAD_DAYS = 7;
const BALI_MS = 8 * 3600 * 1000;

/** Today in Bali as a date at 00:00 UTC. */
export function baliDay(now = Date.now()) {
  const b = new Date(now + BALI_MS);
  return new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()));
}

/** The day an automatic run plans for: today in Bali plus the lead days. */
export function autoDate(leadDays = DEFAULT_LEAD_DAYS, now = Date.now()) {
  const d = baliDay(now);
  d.setUTCDate(d.getUTCDate() + leadDays);
  return d;
}

/** Cleans a settings update. Throws a readable error. */
export function cleanSettings(body = {}) {
  const out = {};
  if ('enabled' in body) out.enabled = body.enabled === true || body.enabled === 'true';
  if ('leadDays' in body) {
    const n = Number(body.leadDays);
    if (!Number.isInteger(n) || n < 0 || n > 21) throw new Error('leadDays must be a whole number from 0 to 21');
    out.leadDays = n;
  }
  return out;
}

/** The notes the team wrote when rejecting posts: cleaned, without duplicates, at most max. */
export function feedbackItems(rows, max = 8) {
  const seen = new Set();
  const out = [];
  for (const r of rows || []) {
    const text = String(r.feedback || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push({ text, format: r.format || null, pillar: r.pillar || null });
    if (out.length >= max) break;
  }
  return out;
}

/** Lines for the writing brief. Empty when there is no feedback. */
export function feedbackPromptBlock(items) {
  if (!items || !items.length) return [];
  return [
    '',
    'TEAM FEEDBACK on earlier posts that were rejected. Learn from it and apply it where it fits this post. Ignore notes that are not about how a post should be written or look:',
    ...items.map((i) => `- (${[i.format, i.pillar].filter(Boolean).join(', ') || 'post'}) ${i.text}`)
  ];
}

/** Reasons given for rejected posts in the last 90 days, newest first. Never throws: no feedback is better than no post. */
export async function recentFeedback() {
  try {
    const rows = await q("select feedback, format, pillar from posts where status = 'rejected' and coalesce(trim(feedback), '') <> '' and updated_at > now() - interval '90 days' order by updated_at desc limit 40");
    return feedbackItems(rows);
  } catch {
    return [];
  }
}

let ready = null;
function ensure() {
  ready ??= q(`create table if not exists drafting_settings (
    id int primary key,
    enabled boolean not null default false,
    lead_days int not null default 7,
    last_run_at timestamptz,
    last_result text,
    updated_at timestamptz not null default now()
  )`)
    .then(() => q('insert into drafting_settings (id) values (1) on conflict do nothing'))
    .catch((e) => {
      ready = null;
      throw e;
    });
  return ready;
}

export async function getDrafting() {
  await ensure();
  const [r] = await q('select * from drafting_settings where id = 1');
  return { enabled: r.enabled, leadDays: r.lead_days, lastRunAt: r.last_run_at, lastResult: r.last_result, nextDate: autoDate(r.lead_days).toISOString().slice(0, 10) };
}

export async function setDrafting(body) {
  await ensure();
  let c;
  try {
    c = cleanSettings(body);
  } catch (e) {
    throw new HttpError(400, e.message);
  }
  if ('enabled' in c) await q('update drafting_settings set enabled = $1, updated_at = now() where id = 1', [c.enabled]);
  if ('leadDays' in c) await q('update drafting_settings set lead_days = $1, updated_at = now() where id = 1', [c.leadDays]);
  return getDrafting();
}

export async function noteRun(text) {
  await ensure();
  await q('update drafting_settings set last_run_at = now(), last_result = $1 where id = 1', [String(text).slice(0, 300)]);
}

/** The scheduled run: returns { skipped, reason } or { day }. A day whose slot already has a post is skipped, not planned twice. */
export async function resolveAutoRun() {
  const s = await getDrafting();
  if (!s.enabled) {
    await noteRun('Skipped: automatic drafting is switched off');
    return { skipped: true, reason: 'Automatic drafting is switched off' };
  }
  const day = autoDate(s.leadDays);
  const date = day.toISOString().slice(0, 10);
  const { slotFor } = await import('./strategy.js');
  const slot = slotFor(day);
  const taken = await q("select id from posts where plan_date = $1 and format = $2 and status <> 'rejected' limit 1", [date, slot.format]);
  if (taken.length) {
    await noteRun(`Skipped: ${date} already has a ${slot.format} (post ${taken[0].id})`);
    return { skipped: true, reason: `${date} already has a ${slot.format} (post ${taken[0].id})` };
  }
  return { day };
}

export function draftingRoutes(app, needDb, ah) {
  app.get('/drafting', needDb, ah(async (_req, res) => res.json(await getDrafting())));
  app.put('/drafting', needDb, ah(async (req, res) => res.json(await setDrafting(req.body || {}))));
}
