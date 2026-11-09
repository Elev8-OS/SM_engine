// WhatsApp for the sales assistant. The messages come in through GHL (the number is registered there), like the Instagram DMs.
//
// Safety first: the GHL account holds more than one WhatsApp number (software support, marketing). The assistant only answers
// messages that were sent TO the sales number (WA_AGENT_NUMBER), and only when WA_AGENT_ENABLED is on. Anything else is ignored.
// It starts as drafts for the team: automatic sending needs WA_AGENT_AUTO_SEND=on on top of the answer mode of the SM Manager.

import { productMessagesOn, productsInText, postProducts } from '../wacatalog-send.js';

const GHL = 'https://services.leadconnectorhq.com';

export const digits = (s) => String(s || '').replace(/\D/g, '');
const on = (v) => /^(true|1|yes|on)$/i.test(String(v || '').replace(/["'\s]/g, ''));

export function waSettings(env = process.env) {
  return { enabled: on(env.WA_AGENT_ENABLED), number: digits(env.WA_AGENT_NUMBER), autoSend: on(env.WA_AGENT_AUTO_SEND) };
}

/** Channel of a GHL message type (TYPE_INSTAGRAM, TYPE_WHATSAPP, ...). Empty when the assistant does not handle it. */
export function channelOf(type) {
  const t = String(type || '');
  if (/instagram/i.test(t)) return 'instagram';
  if (/whatsapp/i.test(t)) return 'whatsapp';
  return '';
}

/** Was this message sent to our sales number? GHL puts the receiving number in `to`. No number set means no. */
export const isOurNumber = (msg, number) => Boolean(number) && digits(msg?.to) === digits(number);

/** WhatsApp lets a business answer freely for 24 hours after the last message of the guest. Afterwards only a template is allowed. */
export function windowOpen(thread, now = Date.now(), hours = 24) {
  const last = [...(thread || [])].reverse().find((m) => m.direction === 'inbound' && channelOf(m.type) === 'whatsapp');
  const at = last?.at ? Date.parse(last.at) : NaN;
  return Number.isFinite(at) && now - at < hours * 3600000;
}

// GHL shows voice messages, photos and the like as this text.
export const NOT_READABLE = /message type is currently not supported/i;
export const UNREADABLE_REPLY = 'Hi, this is the virtual assistant of The R Villas Bali. I can only read text messages here. Could you write your question as text? Thank you.';

/** What the prompt says on top for WhatsApp. */
export const WA_PROMPT_NOTE = [
  'Channel: WhatsApp. The guest wrote to the sales number of The R Villas Bali, so you never need to ask for a phone number.',
  'Format: plain text in the language of the guest. At most 3 short paragraphs separated by a blank line. Put a booking link on a line of its own at the very end, with nothing after it.',
  'Promotion codes: a guest often arrives from an ad with a ready-made first message that carries a code (for example "Hi, I saw your offer, code ELEVATEDSTAY"). Look for the code in the active_promotions of list_villas. Only a code that is found there and whose terms fit the stay may be confirmed, and then it goes into build_booking_link as promo_code. A code that is not found, has expired or does not fit the stay: say so kindly, do not promise any discount, and hand over to the team if the guest insists. Without dates or guests yet, ask for them first and say that you will check the code for those dates.'
].join('\n');

/**
 * The booking links of the tools carry the Instagram tracking. For WhatsApp they carry WhatsApp tracking instead.
 * A link that carries a promotion code also gets utm_content=promo_<code>, so a campaign can be told apart afterwards.
 */
export function swapUtm(value) {
  const swapped = JSON.parse(JSON.stringify(value ?? null).replaceAll('utm_source=instagram', 'utm_source=whatsapp').replaceAll('utm_medium=dm', 'utm_medium=chat'));
  const tag = (v) => {
    if (Array.isArray(v)) return void v.forEach(tag);
    if (!v || typeof v !== 'object') return;
    if (typeof v.booking_link === 'string' && v.promo_code) {
      try {
        const u = new URL(v.booking_link);
        u.searchParams.set('utm_content', `promo_${String(v.promo_code).toLowerCase()}`);
        v.booking_link = u.toString();
      } catch {
        // keep the link as it is
      }
    }
    Object.values(v).forEach(tag);
  };
  tag(swapped);
  return swapped;
}

const headers = () => ({ Authorization: `Bearer ${process.env.GHL_API_TOKEN}`, Version: '2021-04-15', 'Content-Type': 'application/json', Accept: 'application/json' });

/** The conversation of the contact with the newest activity (a contact can have an Instagram and a WhatsApp conversation). */
export async function findLatestConversation(contactId) {
  const url = `${GHL}/conversations/search?locationId=${encodeURIComponent(process.env.GHL_LOCATION_ID)}&contactId=${encodeURIComponent(contactId)}`;
  const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(30000) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GHL conversation search ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
  return [...(json.conversations || [])].sort((a, b) => (b.lastMessageDate || 0) - (a.lastMessageDate || 0))[0] || null;
}

/** Recent messages, oldest first, with sender and receiver (the number the message was sent to). */
export async function getThreadFull(conversationId, limit = 20) {
  const res = await fetch(`${GHL}/conversations/${encodeURIComponent(conversationId)}/messages?limit=${limit}`, { headers: headers(), signal: AbortSignal.timeout(30000) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GHL messages ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
  const list = json?.messages?.messages ?? json?.messages ?? [];
  return (Array.isArray(list) ? list : [])
    .map((m) => ({ id: m.id, direction: m.direction, body: m.body || '', type: m.messageType || m.type || '', at: m.dateAdded || '', from: m.from || '', to: m.to || '' }))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

/** The phone number of a GHL contact (digits), or '' when there is none. */
export async function contactPhone(contactId) {
  const res = await fetch(`${GHL}/contacts/${encodeURIComponent(contactId)}`, { headers: { ...headers(), Version: '2021-07-28' }, signal: AbortSignal.timeout(30000) });
  const json = await res.json().catch(() => ({}));
  return res.ok ? digits(json?.contact?.phone) : '';
}

/**
 * After the text reply: the villa(s) the reply links to go into the chat as a product message (photo, title, price, a button).
 * Only with WA_PRODUCT_MESSAGES on, and never a reason for the text reply to fail: the result says what happened.
 * The message goes through the WhatsApp API of Meta, not through GHL, so GHL does not show it in the conversation.
 */
async function followWithProducts(contactId, message) {
  const ids = await productsInText(message);
  if (!ids.length) return { ok: true, skipped: 'no villa link in the reply' };
  const to = await contactPhone(contactId);
  if (!to) return { ok: false, error: 'the contact has no phone number' };
  // One villa: the card alone (photo, title, price). Several villas: a list, which needs a short text.
  const r = await postProducts(to, ids, ids.length > 1 ? 'Tap to see the photos and prices.' : '');
  if (!r.ok) console.error('WhatsApp product message not sent:', JSON.stringify(r).slice(0, 300));
  return r;
}

/** Send a WhatsApp message from the sales number. Only inside the 24-hour window; GHL answers with an error otherwise. */
export async function sendWhatsApp(contactId, message) {
  const { number } = waSettings();
  if (!number) throw new Error('WA_AGENT_NUMBER is not set');
  const res = await fetch(`${GHL}/conversations/messages`, { method: 'POST', headers: headers(), body: JSON.stringify({ type: 'WhatsApp', contactId, message, fromNumber: `+${number}` }), signal: AbortSignal.timeout(30000) });
  const json = await res.json().catch(() => ({}));
  const out = { ok: res.ok, status: res.status, messageId: json.messageId || json.id || null, response: res.ok ? undefined : json };
  if (res.ok && productMessagesOn()) out.products = await followWithProducts(contactId, message).catch((e) => ({ ok: false, error: String(e.message || e).slice(0, 200) }));
  return out;
}
