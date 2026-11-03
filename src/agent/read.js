// Reads the guest message of an inquiry from GHL.
// GHL fires the webhook before the message text is always readable (or before the message shows up in the
// conversation), so an empty answer is retried a few times instead of being taken as an empty message.
// A message older than the inquiry is never taken for the new one: it would get a reply to the wrong question.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function readGuest(row, { findConversation, getThread, wait = sleep, delays = [0, 3000, 6000, 12000], freshMinutes = 10 }) {
  const since = row.created_at ? new Date(row.created_at).getTime() - freshMinutes * 60000 : 0;
  let conversationId = row.conversation_id || null;
  let thread = [];
  let lastIn = null;
  let stale = false;
  let tries = 0;
  for (const d of delays) {
    if (d) await wait(d);
    tries++;
    conversationId = row.conversation_id || (await findConversation(row.contact_id))?.id || conversationId;
    thread = conversationId ? await getThread(conversationId) : [];
    const inbound = [...thread].reverse().find((m) => m.direction === 'inbound') || null;
    const at = inbound?.at ? Date.parse(inbound.at) : NaN;
    stale = Boolean(inbound && !Number.isNaN(at) && at < since);
    lastIn = stale ? null : inbound;
    if (row.guest_message || lastIn?.body) break;
  }
  return { conversationId, thread, lastIn, stale, tries, text: row.guest_message || lastIn?.body || '' };
}

/** Why no text was found, in words for the team. */
export function whyEmpty({ conversationId, thread, stale, tries }) {
  if (!conversationId) return `No conversation found in GHL for this contact (tried ${tries}x). Please open the message in GHL.`;
  if (stale) return `GHL shows only an older message so far (tried ${tries}x). Please open the message in GHL.`;
  return `The message has no text (photo, voice message, or not loaded in GHL yet; ${thread.length} messages seen, tried ${tries}x). Please open it in GHL.`;
}
