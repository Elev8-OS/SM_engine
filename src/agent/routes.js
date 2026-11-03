import crypto from 'node:crypto';
import { q, dbEnabled } from '../db.js';
import { HttpError } from '../util.js';
import { factsFor } from '../facts.js';
import { runAgent } from './run.js';
import { TOOLS, systemPrompt, availabilityFrom, priceSummary, isDate, nightsBetween } from './tools.js';
import { villaView, linkResult, withFees } from './villas.js';
import { convert } from './currency.js';
import { readGuest, whyEmpty } from './read.js';
import { loadSettings, saveSettings, settingsView, mayAutoSend } from './settings.js';
import { notifyConfigured, buildMail, sendMail } from './notify.js';
import { callModel, elev8Tool, pricelabsRows, findConversation, getThread, sendInstagram, agentConfig, priceIds } from './clients.js';

let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = q(`create table if not exists inquiries (
      id serial primary key,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      dedupe_key text unique,
      contact_id text,
      contact_name text,
      conversation_id text,
      guest_message text,
      thread jsonb,
      draft text,
      needs_human boolean not null default false,
      reason text,
      intent text,
      language text,
      status text not null default 'new',
      trace jsonb,
      sent_message_id text,
      error text
    )`)
      .then(() => q('create index if not exists inquiries_status_idx on inquiries (status, created_at desc)'))
      .then(() => q('alter table inquiries add column if not exists notified_at timestamptz'))
      .then(() => q('alter table inquiries add column if not exists auto_sent boolean not null default false'))
      .then(() => q("create table if not exists agent_settings (key text primary key, value jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now())"))
      .then(() => q('create table if not exists webhook_debug (id serial primary key, created_at timestamptz not null default now(), note text, keys text, body text)'))
      .catch((e) => {
        schemaReady = null;
        throw e;
      });
  }
  return schemaReady;
}

const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
const today = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const MULTI_UNIT = new Set(['apartments', 'merapi']);

/** First string or number value under a key matching re, searched a few levels deep. */
function findKey(obj, re, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 3) return null;
  for (const [k, v] of Object.entries(obj)) {
    if (re.test(k) && (typeof v === 'string' || typeof v === 'number') && String(v).trim()) return String(v).trim();
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const r = findKey(v, re, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

/** Pull the guest message out of whatever shape the GHL workflow webhook sends. */
export function extractInbound(b) {
  const m = b.message && typeof b.message === 'object' ? b.message : {};
  // GHL's default 'Customer Replied' webhook sends only { id, name, email, phone }: id is the contact id, the text comes from the thread.
  const idIsContact = typeof b.id === 'string' && /^[A-Za-z0-9]{16,32}$/.test(b.id) && !b.messageId;
  const channel = String(m.type ?? m.messageType ?? b.channel ?? b.messageType ?? b.message_type ?? '');
  return {
    contactId: b.contact_id ?? b.contactId ?? b.contact?.id ?? findKey(b, /^contact_?id$/i) ?? (idIsContact ? b.id : null),
    contactName: b.full_name ?? b.contact_name ?? b.contact?.name ?? ([b.first_name, b.last_name].filter(Boolean).join(' ') || b.name || null),
    conversationId: b.conversation_id ?? b.conversationId ?? m.conversationId ?? findKey(b, /^conversation_?id$/i),
    messageId: m.id ?? b.message_id ?? b.messageId ?? findKey(b, /^message_?id$/i),
    text: String(typeof b.message === 'string' ? b.message : m.body ?? b.body ?? b.text ?? b.customData?.message ?? findKey(b, /^(message_?body|last_?message|text|body)$/i) ?? '').trim(),
    // A purely numeric code is not a name, so it is not used to filter.
    channel: /[a-z]/i.test(channel) ? channel : ''
  };
}

async function villa(key) {
  const k = String(key || '').toLowerCase();
  const rows = await q('select * from properties where key = $1', [k]);
  if (!rows.length) throw new Error(`Unknown villa '${key}'. Use list_villas.`);
  return rows[0];
}

function checkDates(input) {
  const { check_in: ci, check_out: co } = input;
  if (!isDate(ci) || !isDate(co)) throw new Error('check_in and check_out must be YYYY-MM-DD');
  if (ci < today()) throw new Error('check_in is in the past');
  const n = nightsBetween(ci, co).length;
  if (n < 1) throw new Error('check_out must be after check_in');
  if (n > 60) throw new Error('Stays over 60 nights are handled by the team');
  return { ci, co };
}

/** The tools the model may call. All read-only. */
export async function execute(name, input) {
  if (name === 'list_villas') {
    const rows = await q('select key, name, area, type, guests, size_m2, bedrooms, url, highlights, open_questions from properties order by key');
    return rows.map((p) => villaView(p, MULTI_UNIT.has(p.key)));
  }
  if (name === 'convert_currency') return convert(input);
  if (name === 'build_booking_link') {
    const p = await villa(input.villa);
    checkDates(input);
    return linkResult(p, input, { multiUnit: MULTI_UNIT.has(p.key) });
  }
  if (name === 'check_availability' || name === 'get_prices') {
    const p = await villa(input.villa);
    const { ci, co } = checkDates(input);
    if (MULTI_UNIT.has(p.key)) return { available: null, ok: false, note: 'Several units. The team confirms.' };
    if (name === 'check_availability') {
      const short = p.name.replace(/^The R Villa\s+/i, '');
      const to = new Date(Date.parse(`${co}T00:00:00Z`) + 30 * 86400000).toISOString().slice(0, 10);
      const res = await elev8Tool('get_blocked_dates', { from_date: ci, to_date: to, listing_name: short, listing_tag: '' });
      const hit = (res?.results || []).find((r) => `${r.internal_name} ${r.listing_name}`.toLowerCase().includes(short.toLowerCase()));
      if (!hit) return { available: null, note: 'No calendar found for this villa. The team confirms.' };
      return availabilityFrom(hit, ci, co);
    }
    const id = priceIds()[p.key];
    if (!id) return { ok: false, note: 'No price source for this villa yet. The team confirms the price.' };
    const { currency, rows } = await pricelabsRows(id, ci, co);
    // Fees of the fact sheet (for example a cleaning fee) are added once an amount is stored there.
    return withFees(priceSummary(rows, ci, co, currency), factsFor(p.key)?.fees);
  }
  throw new Error(`Unknown tool ${name}`);
}

function transcript(thread, latest) {
  const lines = (thread || []).slice(-12).map((m) => `${m.direction === 'inbound' ? 'Guest' : 'Team'}: ${m.body}`.trim()).filter((l) => l.length > 7);
  return [lines.length ? `Conversation so far (oldest first):\n${lines.join('\n')}\n` : '', `Latest guest message:\n${latest}`].join('\n');
}

async function sendRow(id, message) {
  const [row] = await q('select * from inquiries where id = $1', [id]);
  if (!row) throw new HttpError(404, 'Inquiry not found');
  if (row.status === 'sent') throw new HttpError(409, 'Already sent');
  const text = String(message ?? row.draft ?? '').trim();
  if (!text) throw new HttpError(400, 'There is no text to send');
  const r = await sendInstagram(row.contact_id, text);
  if (!r.ok) {
    await q("update inquiries set error = $2, updated_at = now() where id = $1", [id, `GHL send ${r.status}: ${JSON.stringify(r.response).slice(0, 300)}`]);
    throw new HttpError(502, `GHL did not accept the message (${r.status})`);
  }
  await q("update inquiries set status = 'sent', draft = $2, sent_message_id = $3, error = null, updated_at = now() where id = $1", [id, text, r.messageId]);
  return { id, status: 'sent', messageId: r.messageId };
}

/** Mail the team once when an inquiry needs a person or failed. Never throws. */
async function notifyIfNeeded(id) {
  try {
    if (!notifyConfigured()) return;
    const [row] = await q('select * from inquiries where id = $1', [id]);
    if (!row || row.notified_at || !(row.status === 'failed' || (row.status === 'draft_ready' && row.needs_human))) return;
    const r = await sendMail(buildMail(row));
    if (r.ok) await q('update inquiries set notified_at = now() where id = $1', [id]);
    else console.error('notify failed', JSON.stringify(r).slice(0, 300));
  } catch (e) {
    console.error('notify error', e.message);
  }
}

/**
 * Reads the guest message, lets Lea write the reply and saves it as a draft.
 * With auto true (a message that just arrived) the answer mode of the SM Manager may send it by itself.
 * A redraft pressed by a person never sends on its own.
 */
export async function processInquiry(id, { auto = false } = {}) {
  const [row] = await q('select * from inquiries where id = $1', [id]);
  if (!row) return;
  try {
    // The text is read with a few retries: GHL fires the webhook before the message is always readable.
    const read = await readGuest(row, { findConversation, getThread });
    const { conversationId, thread, lastIn, text: guestText } = read;
    if (lastIn?.type && !/instagram/i.test(lastIn.type)) {
      await q("update inquiries set status = 'ignored', conversation_id = $2, error = 'Not an Instagram message', updated_at = now() where id = $1", [id, conversationId]);
      return;
    }
    if (!guestText) {
      // Not silently ignored: the team is told to look at it in GHL, with the reason.
      await q("update inquiries set status = 'failed', conversation_id = $2, thread = $3, error = $4, updated_at = now() where id = $1", [id, conversationId, JSON.stringify(thread.slice(-12)), whyEmpty(read)]);
      await notifyIfNeeded(id);
      return;
    }
    const history = lastIn && lastIn.body === guestText ? thread.filter((m) => m !== lastIn) : thread;
    const result = await runAgent({ system: systemPrompt(today()), userText: transcript(history, guestText), tools: TOOLS, callModel, execute });
    const needsHuman = result.needs_human || !result.reply;
    await q(
      `update inquiries set conversation_id = $2, guest_message = $3, thread = $4, draft = $5, needs_human = $6, reason = $7, intent = $8, language = $9, trace = $10, status = 'draft_ready', error = null, updated_at = now() where id = $1`,
      [id, conversationId, guestText, JSON.stringify(thread.slice(-12)), result.reply, needsHuman, result.reason, result.intent, result.language, JSON.stringify(result.trace)]
    );
    // Answer mode set in the SM Manager: always approve, always automatic, or automatic inside a time window.
    // A reply that needs a person is never sent by itself.
    if (auto && mayAutoSend(await loadSettings(q), { reply: result.reply, needs_human: needsHuman })) {
      await sendRow(id);
      await q('update inquiries set auto_sent = true where id = $1', [id]);
    }
    await notifyIfNeeded(id);
  } catch (e) {
    console.error('inquiry failed', id, e.message);
    await q("update inquiries set status = 'failed', error = $2, updated_at = now() where id = $1", [id, String(e.message || e).slice(0, 500)]).catch(() => {});
    await notifyIfNeeded(id);
  }
}

async function webhook(req, res) {
  const cfg = agentConfig();
  if (!cfg.enabled || !process.env.AGENT_WEBHOOK_SECRET) return res.status(503).json({ error: 'The agent is not enabled' });
  const given = Buffer.from(String(req.get('x-webhook-secret') || req.query.token || ''));
  const want = Buffer.from(process.env.AGENT_WEBHOOK_SECRET);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return res.status(401).json({ error: 'Invalid secret' });
  if (!dbEnabled()) return res.status(503).json({ error: 'DATABASE_URL is not configured' });
  await ensureSchema();
  const inb = extractInbound(req.body || {});
  // Keep the last raw webhooks for a while so a changed GHL payload can be diagnosed.
  q('insert into webhook_debug (note, keys, body) values ($1,$2,$3)', [inb.contactId ? 'ok' : 'no contact id', Object.keys(req.body || {}).join(','), JSON.stringify(req.body || {}).slice(0, 3000)])
    .then(() => q('delete from webhook_debug where id < (select max(id) - 30 from webhook_debug)'))
    .catch(() => {});
  if (!inb.contactId) return res.status(400).json({ error: 'contact id missing in the webhook body' });
  if (inb.channel && !/insta|^ig$/i.test(inb.channel)) return res.json({ ok: true, ignored: 'not an Instagram message' });
  const key = inb.messageId || `${inb.contactId}:${sha(inb.text)}:${Math.floor(Date.now() / 60000)}`;
  const rows = await q(
    `insert into inquiries (dedupe_key, contact_id, contact_name, conversation_id, guest_message, status) values ($1,$2,$3,$4,$5,'new') on conflict (dedupe_key) do nothing returning id`,
    [key, inb.contactId, inb.contactName, inb.conversationId, inb.text || null]
  );
  if (!rows.length) return res.json({ ok: true, duplicate: true });
  res.json({ ok: true, id: rows[0].id });
  processInquiry(rows[0].id, { auto: true }).catch((e) => console.error('inquiry failed', e.message));
}

export function agentPublic(app) {
  // Public (secret in header or ?token=): GHL workflow webhook for new Instagram messages.
  app.post('/agent/webhook', (req, res, next) => webhook(req, res).catch(next));
}

export function agentPrivate(app, needDb, ah) {
  app.get('/agent/status', ah(async (_req, res) => res.json({ ...agentConfig(), notify_configured: notifyConfigured() })));

  // How Lea answers (always approve, always automatic, time window), set in the SM Manager.
  app.get('/agent/settings', needDb, ah(async (_req, res) => {
    await ensureSchema();
    res.json(settingsView(await loadSettings(q)));
  }));
  app.put('/agent/settings', needDb, ah(async (req, res) => {
    await ensureSchema();
    try {
      res.json(settingsView(await saveSettings(q, req.body || {})));
    } catch (e) {
      throw new HttpError(400, String(e.message || e));
    }
  }));

  // Sends a sample notification to the configured address(es), to check the mail path.
  app.get('/agent/notify-test', ah(async (_req, res) => {
    const mail = buildMail({ contact_name: 'Test', created_at: new Date(), status: 'draft_ready', guest_message: 'Das ist eine Test-Nachricht.', reason: 'Testmail der Engine', draft: 'Hi, hier ist Lea. Das ist ein Testentwurf.' });
    res.json(await sendMail(mail));
  }));

  app.get('/agent/inquiries', needDb, ah(async (req, res) => {
    await ensureSchema();
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const rows = req.query.status
      ? await q('select id, created_at, updated_at, contact_name, guest_message, draft, needs_human, reason, intent, language, status, error, auto_sent from inquiries where status = $1 order by id desc limit $2', [req.query.status, limit])
      : await q('select id, created_at, updated_at, contact_name, guest_message, draft, needs_human, reason, intent, language, status, error, auto_sent from inquiries order by id desc limit $1', [limit]);
    res.json({ inquiries: rows });
  }));

  app.get('/agent/debug', needDb, ah(async (_req, res) => {
    await ensureSchema();
    res.json({ webhooks: await q('select id, created_at, note, keys, body from webhook_debug order by id desc limit 5') });
  }));

  app.get('/agent/inquiries/:id', needDb, ah(async (req, res) => {
    await ensureSchema();
    const [row] = await q('select * from inquiries where id = $1', [Number(req.params.id)]);
    if (!row) throw new HttpError(404, 'Inquiry not found');
    res.json(row);
  }));

  // Approve: sends the draft, or the edited text in body.message.
  app.post('/agent/inquiries/:id/send', needDb, ah(async (req, res) => {
    await ensureSchema();
    res.json(await sendRow(Number(req.params.id), req.body?.message));
  }));

  app.post('/agent/inquiries/:id/dismiss', needDb, ah(async (req, res) => {
    await ensureSchema();
    await q("update inquiries set status = 'dismissed', updated_at = now() where id = $1 and status <> 'sent'", [Number(req.params.id)]);
    res.json({ id: Number(req.params.id), status: 'dismissed' });
  }));

  app.post('/agent/inquiries/:id/redraft', needDb, ah(async (req, res) => {
    await ensureSchema();
    await q("update inquiries set status = 'new', error = null, updated_at = now() where id = $1 and status <> 'sent'", [Number(req.params.id)]);
    res.json({ id: Number(req.params.id), status: 'new' });
    processInquiry(Number(req.params.id)).catch(() => {}); // never automatic: a person asked for a new draft
  }));

  // Try the agent on a typed message. Stores nothing and sends nothing.
  app.post('/agent/test', needDb, ah(async (req, res) => {
    const message = String(req.body?.message || '').trim();
    if (!message) throw new HttpError(400, 'message is required');
    const result = await runAgent({ system: systemPrompt(today()), userText: transcript([], message), tools: TOOLS, callModel, execute });
    res.json(result);
  }));
}
