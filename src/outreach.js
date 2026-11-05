import { HttpError } from './util.js';

// Venue outreach through GHL (WhatsApp Business). The engine only prepares the contact and sets a tag; the message and the
// reminder after two days are sent by a GHL workflow (trigger: tag added). Template variables read GHL contact fields,
// so every venue must exist as a contact first, with the right tags and fields.
//
// Tags: vendor, venue-partner, venue-<category>, whatsapp-optin (only when the venue agreed to WhatsApp messages).
// Workflow trigger: venue-outreach-send. Reminder stops when venue-photos-received is set.
// The venue token and link are custom contact fields (created on first sync when the token may do it).
// Landline numbers are not blocked: they can be WhatsApp numbers too. A message that was not delivered is read back
// from the GHL conversation (deliveryStatus) so the app can mark it.

const BASE = 'https://services.leadconnectorhq.com';
export const TAGS = { send: 'venue-outreach-send', received: 'venue-photos-received', optin: 'whatsapp-optin' };
const FIELD_DEFS = [
  ['venue_token', 'Venue Token'],
  ['venue_link', 'Venue Link']
];

const configured = () => Boolean(process.env.GHL_API_TOKEN && process.env.GHL_LOCATION_ID);
const headers = () => ({ Authorization: `Bearer ${process.env.GHL_API_TOKEN}`, Version: '2021-07-28', 'Content-Type': 'application/json', Accept: 'application/json' });

async function ghl(method, path, body) {
  if (!configured()) throw new HttpError(409, 'GHL_API_TOKEN and GHL_LOCATION_ID are not set');
  const res = await fetch(`${BASE}${path}`, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const m = json?.message ?? json?.error ?? res.statusText;
    throw new HttpError(502, `GHL ${res.status} on ${method} ${path.split('?')[0]}: ${(Array.isArray(m) ? m.join('; ') : String(m)).slice(0, 300)}`);
  }
  return json;
}

/** Ids of the venue fields. With create, missing ones are created (needs the custom field scope on the GHL token). */
async function fieldIds({ create = false } = {}) {
  const loc = process.env.GHL_LOCATION_ID;
  const list = (await ghl('GET', `/locations/${loc}/customFields?model=contact`)).customFields || [];
  const out = {};
  for (const [key, name] of FIELD_DEFS) {
    let f = list.find((x) => String(x.fieldKey || '').endsWith(`.${key}`));
    if (!f && create) {
      const r = await ghl('POST', `/locations/${loc}/customFields`, { name, dataType: 'TEXT', model: 'contact' });
      f = r.customField || r;
    }
    if (f?.id) out[key] = f.id;
  }
  return out;
}

/** International format. Indonesian local numbers (0812 ..., also landlines like 0361 ...) become +62812 ... */
export function e164(raw) {
  let d = String(raw || '').replace(/[^\d+]/g, '');
  if (!d) return null;
  if (d.startsWith('+')) d = `+${d.slice(1).replace(/\D/g, '')}`;
  else if (d.startsWith('00')) d = `+${d.slice(2)}`;
  else if (d.startsWith('0')) d = `+62${d.slice(1)}`;
  else if (d.startsWith('62')) d = `+${d}`;
  else if (d.startsWith('8')) d = `+62${d}`;
  else return null;
  const n = d.length - 1;
  return n >= 8 && n <= 15 ? d : null;
}

/** Category tag (venue-<category>) from the venue name. Order matters: the first match wins. */
export function categoryOf(name) {
  const n = String(name || '').toLowerCase();
  if (/beach club|beachfront|la brisa/.test(n)) return 'beach-club';
  if (/cowork|thehub|argil|tribal/.test(n)) return 'coworking';
  if (/padel|\bgym\b|fitness|crossfit|f45|\bmma\b|muay|fight|boxing|boulder|climb|equestrian|golf|skate|amplitude|\bfit\b|body craft|the block|rite /.test(n)) return 'fitness';
  if (/\bspa\b|massage|yoga|wellness|studio|pilates|the path/.test(n)) return 'wellness';
  if (/cafe|coffee|brunch|eatery|bakers?\b/.test(n)) return 'cafe';
  if (/warung|restaurant|trattoria|kitchen|bistro|\bbar\b|wine|chef|taphouse|pub\b/.test(n)) return 'restaurant';
  return '';
}

const addTags = (contactId, tags) => ghl('POST', `/contacts/${contactId}/tags`, { tags });
const removeTags = (contactId, tags) => ghl('DELETE', `/contacts/${contactId}/tags`, { tags });

/**
 * Create or update the venues as GHL contacts (upsert by phone or email). One call per venue is isolated: a failing venue
 * does not stop the others. A venue the caller marks with skip (for example a shared phone number) is not touched, because
 * GHL would merge two venues with the same number into one contact.
 */
export async function syncVenues(venues) {
  if (!Array.isArray(venues) || venues.length < 1 || venues.length > 40) throw new HttpError(400, 'venues must contain 1 to 40 items');
  const loc = process.env.GHL_LOCATION_ID;
  let ids;
  try {
    ids = await fieldIds({ create: true });
  } catch (e) {
    throw new HttpError(409, `The venue fields could not be read or created (${e.message}). Create two text contact fields in GHL by hand: Venue Token and Venue Link.`);
  }
  const missing = FIELD_DEFS.filter(([k]) => !ids[k]).map(([, n]) => n);
  if (missing.length) throw new HttpError(409, `Missing contact fields in GHL: ${missing.join(', ')}. Create them as text fields.`);

  const results = [];
  for (const v of venues) {
    const id = v.id;
    if (v.skip) {
      results.push({ id, ok: false, skipped: String(v.skip) });
      continue;
    }
    const phone = v.phone ? e164(v.phone) : null;
    if (!phone && !v.email) {
      results.push({ id, ok: false, skipped: 'no_contact' });
      continue;
    }
    try {
      const body = {
        locationId: loc,
        firstName: String(v.contactName || '').trim() || `${v.spotName} team`,
        companyName: v.spotName,
        source: 'Venue portal',
        ...(phone ? { phone } : {}),
        ...(v.email ? { email: v.email } : {}),
        ...(v.website ? { website: v.website } : {}),
        customFields: [
          { id: ids.venue_token, field_value: v.token, fieldValue: v.token },
          { id: ids.venue_link, field_value: v.link, fieldValue: v.link }
        ]
      };
      const r = await ghl('POST', '/contacts/upsert', body);
      const contactId = r.contact?.id || r.id;
      if (!contactId) throw new HttpError(502, 'GHL answered without a contact id');
      const category = categoryOf(v.spotName);
      // Tags are added, never replaced: workflow tags that GHL set earlier stay.
      await addTags(contactId, ['vendor', 'venue-partner', ...(category ? [`venue-${category}`] : []), ...(v.optIn ? [TAGS.optin] : [])]);
      results.push({ id, ok: true, contactId, isNew: Boolean(r.new), category, phone });
    } catch (e) {
      results.push({ id, ok: false, error: String(e.message || e).slice(0, 300) });
    }
  }
  return { results };
}

/** Add or remove the opt-in tag. */
export async function setOptIn(contactId, value) {
  if (!contactId) throw new HttpError(400, 'contactId is required');
  if (value) await addTags(contactId, [TAGS.optin]);
  else await removeTags(contactId, [TAGS.optin]).catch(() => {});
  return { ok: true };
}

/** Start the GHL workflow: adding the trigger tag sends the template; the workflow sends the reminder after two days. */
export async function sendOutreach({ contactId, optIn }) {
  if (!contactId) throw new HttpError(400, 'contactId is required');
  if (optIn !== true) throw new HttpError(409, 'The venue has not agreed to WhatsApp messages (opt-in).');
  await addTags(contactId, [TAGS.optin]);
  await removeTags(contactId, [TAGS.send, TAGS.received]).catch(() => {}); // a fresh round: trigger again, reminder possible again
  await addTags(contactId, [TAGS.send]);
  return { ok: true, contactId, tag: TAGS.send };
}

/** Photos arrived: the reminder in the workflow checks this tag and stays silent. */
export async function photosReceived(contactId) {
  if (!contactId) throw new HttpError(400, 'contactId is required');
  await addTags(contactId, [TAGS.received]);
  return { ok: true };
}

const STATUS_OK = ['delivered', 'read'];
const STATUS_BAD = ['failed', 'undelivered', 'error', 'rejected'];
const newest = (list) => [...list].sort((a, b) => String(b.dateAdded || '').localeCompare(String(a.dateAdded || '')))[0] || null;

/**
 * What happened to the latest outbound WhatsApp message of each contact, read from its GHL conversation.
 * status: read, delivered, sent (on its way or not confirmed), failed (not delivered), none (no outbound WhatsApp message found).
 * replied: the venue wrote back. A failing contact does not stop the others.
 */
export async function deliveryStatus(contactIds) {
  if (!Array.isArray(contactIds) || contactIds.length < 1 || contactIds.length > 12) throw new HttpError(400, 'contactIds must contain 1 to 12 items');
  const loc = process.env.GHL_LOCATION_ID;
  const results = [];
  for (const contactId of contactIds) {
    try {
      const found = await ghl('GET', `/conversations/search?locationId=${encodeURIComponent(loc)}&contactId=${encodeURIComponent(contactId)}`);
      const conv = (found.conversations || [])[0];
      if (!conv) {
        results.push({ contactId, status: 'none' });
        continue;
      }
      const json = await ghl('GET', `/conversations/${conv.id}/messages?limit=40`);
      const raw = json?.messages?.messages ?? json?.messages ?? [];
      const wa = (Array.isArray(raw) ? raw : []).filter((m) => /whatsapp/i.test(String(m.messageType || m.type || '')));
      const out = newest(wa.filter((m) => m.direction === 'outbound'));
      if (!out) {
        results.push({ contactId, status: 'none' });
        continue;
      }
      const s = String(out.status || '').toLowerCase();
      const status = STATUS_OK.includes(s) ? s : STATUS_BAD.includes(s) ? 'failed' : 'sent';
      const err = out.error?.message ?? out.errorMessage ?? out.meta?.error?.message ?? out.meta?.errorMessage ?? out.meta?.reason ?? '';
      results.push({ contactId, status, at: out.dateAdded || null, error: status === 'failed' ? String(err || '').slice(0, 300) : '', replied: wa.some((m) => m.direction === 'inbound') });
    } catch (e) {
      results.push({ contactId, status: 'error', error: String(e.message || e).slice(0, 200) });
    }
  }
  return { results };
}

/** Which GHL account the contacts go to, and whether the fields exist. */
export async function outreachStatus() {
  if (!configured()) return { configured: false };
  const loc = process.env.GHL_LOCATION_ID;
  const out = { configured: true, locationId: loc, location: null, fields: {}, tags: TAGS, error: null };
  try {
    const l = await ghl('GET', `/locations/${loc}`);
    out.location = l.location?.name ?? l.name ?? null;
  } catch (e) {
    out.error = e.message;
  }
  try {
    const ids = await fieldIds();
    out.fields = { venue_token: Boolean(ids.venue_token), venue_link: Boolean(ids.venue_link) };
  } catch (e) {
    out.error = out.error || e.message;
  }
  return out;
}

export function outreachRoutes(app, ah) {
  app.get('/outreach/status', ah(async (_req, res) => res.json(await outreachStatus())));
  app.post('/outreach/sync', ah(async (req, res) => res.json(await syncVenues(req.body?.venues))));
  app.post('/outreach/optin', ah(async (req, res) => res.json(await setOptIn(req.body?.contactId, Boolean(req.body?.value)))));
  app.post('/outreach/send', ah(async (req, res) => res.json(await sendOutreach(req.body || {}))));
  app.post('/outreach/photos-received', ah(async (req, res) => res.json(await photosReceived(req.body?.contactId))));
  app.post('/outreach/delivery', ah(async (req, res) => res.json(await deliveryStatus(req.body?.contactIds))));
}
