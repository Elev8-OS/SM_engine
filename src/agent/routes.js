import crypto from 'node:crypto';
import { q, dbEnabled } from '../db.js';
import { HttpError } from '../util.js';
import { factsFor } from '../facts.js';
import { runAgent } from './run.js';
import { TOOLS, systemPrompt, availabilityFrom, priceSummary, isDate, nightsBetween } from './tools.js';
import { villaView, linkResult, withFees, maxGuests } from './villas.js';
import { areaGuide } from './area-guide.js';
import { categoryOf, categoryRow, categoryRows, categoryAvailability, categoryPrices, enrich } from './multiunit.js';
import { convert } from './currency.js';
import { budgetCheck } from './negotiation.js';
import { DEAL_TOOL, dealCodesOn, createDealCode } from './deal-code.js';
import { livePromos, promoRoutes } from '../promos.js';
import { readGuest, whyEmpty } from './read.js';
import { loadSettings, saveSettings, settingsView, mayAutoSend } from './settings.js';
import { notifyConfigured, buildMail, sendMail } from './notify.js';
import { callModel, elev8Tool, pricelabsRows, sendInstagram, agentConfig, priceIds } from './clients.js';
import { waSettings, channelOf, isOurNumber, windowOpen, findLatestConversation, getThreadFull, sendWhatsApp, NOT_READABLE, UNREADABLE_REPLY, WA_PROMPT_NOTE, swapUtm } from './whatsapp.js';

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
      .then(() => q("alter table inquiries add column if not exists channel text not null default 'instagram'"))
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
// The apartments (three categories) and Merapi (rooms) are worked out in multiunit.js: free when at least one unit is free, the lowest price.

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
  // The apartments come as three categories (list_villas shows them): the old collective key is answered with the way out.
  if (k === 'apartments') throw new Error("The apartments are split into apt-studio, apt-mezzanine and apt-plunge. Use list_villas and pick the category that fits the guests.");
  const cat = categoryRow(k);
  if (cat) return cat;
  const rows = await q('select * from properties where key = $1', [k]);
  if (!rows.length) throw new Error(`Unknown villa '${key}'. Use list_villas.`);
  return enrich(rows[0]);
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

/** The tools the model may call. All read-only, except create_deal_code, which only exists while DEAL_CODES is on. */
export async function execute(name, input) {
  if (name === 'list_villas') {
    const rows = await q('select key, name, area, type, guests, size_m2, bedrooms, url, highlights, open_questions from properties order by key');
    // Promotions the team set live in the SM Manager: Lea sees them per villa and may offer only these.
    const promos = await livePromos();
    // The collective row "apartments" is replaced by its three categories; Merapi keeps its row, with the page and the notes of its rooms.
    const all = [...rows.filter((p) => p.key !== 'apartments').map(enrich), ...categoryRows()].sort((a, b) => a.key.localeCompare(b.key));
    return all.map((p) => villaView(p, false, promos.filter((x) => x.property_key === 'all' || x.property_key === (p.promoKey ?? p.key))));
  }
  if (name === 'convert_currency') return convert(input);
  if (name === 'area_guide') return areaGuide(await villa(input.villa), input.topic);
  if (name === 'check_budget') return budgetCheck({ ...input, dealCodes: dealCodesOn() });
  if (name === 'create_deal_code') return createDealCode(input, dealDeps());
  if (name === 'build_booking_link') {
    const p = await villa(input.villa);
    checkDates(input);
    return linkResult(p, input, { multiUnit: Boolean(categoryOf(p.key)), promos: input.promo_code ? await livePromos() : [] });
  }
  if (name === 'check_availability' || name === 'get_prices') {
    const p = await villa(input.villa);
    const { ci, co } = checkDates(input);
    // Apartments and Merapi: several units, see multiunit.js.
    const cat = categoryOf(p.key);
    if (cat) return name === 'check_availability' ? categoryAvailability(cat, ci, co) : withFees(await categoryPrices(cat, ci, co), factsFor(p.key)?.fees);
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

/** The tools Lea may use: the deal code tool only while the switch DEAL_CODES is on. */
const agentTools = () => (dealCodesOn() ? [...TOOLS, DEAL_TOOL] : TOOLS);

/** What createDealCode needs from the engine: villa lookup, the same price Lea quotes, the conversion, Elev8 and the database. */
function dealDeps() {
  return {
    villa,
    // Apartment categories work (the code covers every unit); Merapi (rooms) is left to the team.
    unsupported: (key) => categoryOf(key)?.kind === 'room',
    maxGuests,
    checkDates,
    quote: (i) => execute('get_prices', i),
    convert,
    // The exact name in Elev8 the code is limited to. A villa is one listing. The units of an apartment category are separate rows in Elev8 that share one listing id,
    // and a code tied to one of those rows is refused on the booking page of another (seen on 8 Nov 2026), so categories get no restriction (null):
    // the code stays safe through its single use, its one day of validity and the dates of the stay.
    listingNames: async (p, ci) => {
      const to = new Date(Date.parse(`${ci}T00:00:00Z`) + 2 * 86400000).toISOString().slice(0, 10);
      const cat = categoryOf(p.key);
      if (cat) return null;
      const short = p.name.replace(/^The R Villa\s+/i, '');
      const res = await elev8Tool('get_blocked_dates', { from_date: ci, to_date: to, listing_name: short, listing_tag: '' });
      const hits = (res?.results || []).filter((r) => `${r.internal_name} ${r.listing_name}`.toLowerCase().includes(short.toLowerCase()));
      return hits.length === 1 ? [hits[0].listing_name] : [];
    },
    elev8: elev8Tool,
    q,
    today
  };
}

/** The tools for one channel: the booking links carry the tracking of that channel. */
const executeFor = (channel) => async (name, input) => {
  const out = await execute(name, input);
  return channel === 'whatsapp' ? swapUtm(out) : out;
};

/** The system prompt for one channel. */
function promptFor(channel) {
  const base = systemPrompt(today());
  if (channel !== 'whatsapp') return base;
  return `${base.replace('You answer Instagram direct messages.', 'You answer WhatsApp messages.')}\n${WA_PROMPT_NOTE}`;
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
  const whatsapp = row.channel === 'whatsapp';
  if (whatsapp && !waSettings().enabled) throw new HttpError(409, 'The WhatsApp assistant is switched off (WA_AGENT_ENABLED)');
  const r = whatsapp ? await sendWhatsApp(row.contact_id, text) : await sendInstagram(row.contact_id, text);
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

/** An inquiry that is not ours (another channel, another WhatsApp number): ignored, and the personal data is not kept. */
async function ignoreInquiry(id, channel, why) {
  await q("update inquiries set status = 'ignored', channel = $2, conversation_id = null, contact_name = null, guest_message = null, thread = null, error = $3, updated_at = now() where id = $1", [id, channel || 'instagram', why]);
}

/**
 * Reads the guest message, lets Lea write the reply and saves it as a draft.
 * With auto true (a message that just arrived) the answer mode of the SM Manager may send it by itself.
 * A redraft pressed by a person never sends on its own.
 * Instagram and WhatsApp (the sales number only, and only when switched on) are handled; anything else is ignored.
 */
export async function processInquiry(id, { auto = false } = {}) {
  const [row] = await q('select * from inquiries where id = $1', [id]);
  if (!row) return;
  try {
    const wa = waSettings();
    // The text is read with a few retries: GHL fires the webhook before the message is always readable.
    const read = await readGuest(row, { findConversation: findLatestConversation, getThread: getThreadFull });
    const { conversationId, thread, lastIn, text: guestText } = read;
    const channel = lastIn?.type ? channelOf(lastIn.type) : 'instagram';
    if (!channel) {
      await ignoreInquiry(id, '', 'Not an Instagram or WhatsApp message');
      return;
    }
    if (channel === 'whatsapp') {
      if (!wa.enabled) return void (await ignoreInquiry(id, channel, 'The WhatsApp assistant is switched off'));
      if (!isOurNumber(lastIn, wa.number)) return void (await ignoreInquiry(id, channel, 'WhatsApp message to another number'));
    }
    if (!guestText) {
      // Not silently ignored: the team is told to look at it in GHL, with the reason.
      await q("update inquiries set status = 'failed', channel = $2, conversation_id = $3, thread = $4, error = $5, updated_at = now() where id = $1", [id, channel, conversationId, JSON.stringify(thread.slice(-12)), whyEmpty(read)]);
      await notifyIfNeeded(id);
      return;
    }
    // Only the messages of this channel count as conversation (a WhatsApp phone conversation can hold SMS too).
    const sameChannel = thread.filter((m) => !m.type || channelOf(m.type) === channel);
    const history = lastIn && lastIn.body === guestText ? sameChannel.filter((m) => m.id !== lastIn.id) : sameChannel;
    // Voice messages and photos cannot be read: a fixed polite reply for a person to send, no model call.
    const unreadable = channel === 'whatsapp' && NOT_READABLE.test(guestText);
    const result = unreadable
      ? { reply: UNREADABLE_REPLY, needs_human: true, reason: 'Voice message, photo or another message the assistant cannot read', intent: 'other', language: 'en', trace: [] }
      : await runAgent({ system: promptFor(channel), userText: transcript(history, guestText), tools: agentTools(), callModel, execute: executeFor(channel) });
    let needsHuman = result.needs_human || !result.reply;
    let reason = result.reason;
    // A WhatsApp reply outside the 24-hour window would be refused: a template is needed, so a person decides.
    if (channel === 'whatsapp' && !windowOpen(thread)) {
      needsHuman = true;
      reason = `Outside the 24-hour WhatsApp window: only an approved template can be sent. ${reason || ''}`.trim();
    }
    await q(
      `update inquiries set channel = $2, conversation_id = $3, guest_message = $4, thread = $5, draft = $6, needs_human = $7, reason = $8, intent = $9, language = $10, trace = $11, status = 'draft_ready', error = null, updated_at = now() where id = $1`,
      [id, channel, conversationId, guestText, JSON.stringify(sameChannel.slice(-12)), result.reply, needsHuman, reason, result.intent, result.language, JSON.stringify(result.trace || [])]
    );
    // Answer mode set in the SM Manager: always approve, always automatic, or automatic inside a time window.
    // A reply that needs a person is never sent by itself. On WhatsApp automatic sending needs WA_AGENT_AUTO_SEND on top.
    const modeOk = mayAutoSend(await loadSettings(q), { reply: result.reply, needs_human: needsHuman });
    if (auto && modeOk && (channel !== 'whatsapp' || wa.autoSend)) {
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
  if (inb.channel) {
    const ch = channelOf(inb.channel) || (/^ig$/i.test(inb.channel) ? 'instagram' : '');
    if (!ch || (ch === 'whatsapp' && !waSettings().enabled)) return res.json({ ok: true, ignored: 'channel not handled' });
  }
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
  // Public (secret in header or ?token=): GHL workflow webhook for new Instagram and WhatsApp messages.
  app.post('/agent/webhook', (req, res, next) => webhook(req, res).catch(next));
}

export function agentPrivate(app, needDb, ah) {
  app.get('/agent/status', ah(async (_req, res) => {
    const wa = waSettings();
    res.json({ ...agentConfig(), notify_configured: notifyConfigured(), whatsapp: { enabled: wa.enabled, number_set: Boolean(wa.number), auto_send: wa.autoSend } });
  }));

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
    const cols = 'id, created_at, updated_at, channel, contact_name, guest_message, draft, needs_human, reason, intent, language, status, error, auto_sent';
    const rows = req.query.status
      ? await q(`select ${cols} from inquiries where status = $1 order by id desc limit $2`, [req.query.status, limit])
      : await q(`select ${cols} from inquiries order by id desc limit $1`, [limit]);
    res.json({ inquiries: rows });
  }));

  // Which area guides Lea reads for a property and what she finds for a topic. Sends nothing.
  app.get('/agent/area-test', ah(async (req, res) => {
    res.json(await areaGuide(await villa(req.query.villa), String(req.query.topic || '')));
  }));

  // Deal code check for a stay and an agreed price. Without create=1 it only shows what would be created and writes nothing.
  // create=1&confirm=1 creates a real one-time code (also while DEAL_CODES is off, so it can be tried first); add test=1 for a code that is already expired.
  app.get('/agent/deal-code-test', needDb, ah(async (req, res) => {
    await ensureSchema();
    const b = req.query;
    const input = { villa: b.villa, check_in: b.check_in, check_out: b.check_out, adults: Number(b.adults || 2), children: Number(b.children || 0), agreed_price: Number(b.agreed), basis: b.basis === 'per_night' ? 'per_night' : 'total', currency: b.currency || 'IDR' };
    const create = b.create === '1' && b.confirm === '1';
    res.json(await createDealCode(input, dealDeps(), { dryRun: !create, force: true, testOnly: b.test === '1' }));
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

  // Try the agent on a typed message. Stores nothing and sends nothing. body.channel 'whatsapp' tries the WhatsApp prompt and links.
  app.post('/agent/test', needDb, ah(async (req, res) => {
    const message = String(req.body?.message || '').trim();
    if (!message) throw new HttpError(400, 'message is required');
    const channel = req.body?.channel === 'whatsapp' ? 'whatsapp' : 'instagram';
    const result = await runAgent({ system: promptFor(channel), userText: transcript([], message), tools: agentTools(), callModel, execute: executeFor(channel) });
    res.json(result);
  }));

  // Promotions ("Aktionen") the team enters in the SM Manager
  promoRoutes(app, needDb, ah);
}
