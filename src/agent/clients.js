import { HttpError } from '../util.js';

const GHL = 'https://services.leadconnectorhq.com';

// PriceLabs listings of villas that are not in PRICELABS_LISTINGS (yet). The variable wins when it names the villa. Without these two
// the assistant had no price for Bratan and Tambora and sent the guest to the team.
const PRICE_FALLBACK = {
  bratan: '60e9b31b-1313-45b9-9c61-13f9f5cc8cf4___7f7206ac-8595-40c4-8fca-c1394d350745',
  tambora: 'a34cc21d-f853-488e-ba11-a42902a6b0aa___254a15a0-f81a-45a1-8bed-60b445933f81'
};

export function priceIds() {
  let env = {};
  try {
    env = JSON.parse(process.env.PRICELABS_LISTINGS || '{}') || {};
  } catch {
    env = {};
  }
  return { ...PRICE_FALLBACK, ...env };
}

export const agentConfig = () => ({
  // Tolerant on purpose: True, "true" or a stray space must not keep the agent off.
  enabled: /^(true|1|yes|on)$/i.test(String(process.env.AGENT_ENABLED || '').replace(/["'\s]/g, '')),
  webhook_secret_set: Boolean(process.env.AGENT_WEBHOOK_SECRET),
  anthropic_key_set: Boolean(process.env.ANTHROPIC_API_KEY),
  elev8_token_set: Boolean(process.env.ELEV8_MCP_TOKEN),
  pricelabs_key_set: Boolean(process.env.PRICELABS_API_KEY),
  pricelabs_villas: Object.keys(priceIds()),
  auto_send: process.env.AGENT_AUTO_SEND === 'true',
  model: process.env.AGENT_MODEL || 'claude-sonnet-5-5'
});

/** One Claude call with tools. */
export async function callModel({ system, messages, tools }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new HttpError(409, 'ANTHROPIC_API_KEY is not set');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: process.env.AGENT_MODEL || 'claude-sonnet-5-5', max_tokens: 1500, system, tools, messages }),
    signal: AbortSignal.timeout(90000)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

// ---- Elev8 (MCP over HTTP, read-only tools) ----
async function mcpRpc(url, token, body, sessionId) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  });
  const sid = res.headers.get('mcp-session-id') || sessionId;
  const text = await res.text();
  if (!res.ok) throw new Error(`Elev8 ${res.status}: ${text.slice(0, 200)}`);
  let json = null;
  if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
    const line = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean).pop();
    json = line ? JSON.parse(line) : null;
  } else if (text) {
    json = JSON.parse(text);
  }
  return { json, sid };
}

/** Call one Elev8 tool and return its parsed JSON result. */
export async function elev8Tool(name, args) {
  const url = process.env.ELEV8_MCP_URL || 'https://mcp.elev8-suite.com';
  const token = process.env.ELEV8_MCP_TOKEN;
  if (!token) throw new Error('ELEV8_MCP_TOKEN is not set');
  const init = await mcpRpc(url, token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'sm-engine-agent', version: '1.0' } } });
  await mcpRpc(url, token, { jsonrpc: '2.0', method: 'notifications/initialized' }, init.sid).catch(() => {});
  const call = await mcpRpc(url, token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }, init.sid);
  if (call.json?.error) throw new Error(`Elev8: ${JSON.stringify(call.json.error).slice(0, 200)}`);
  const result = call.json?.result;
  const text = result?.content?.find((c) => c.type === 'text')?.text;
  if (result?.isError) throw new Error(`Elev8: ${String(text || 'tool error').slice(0, 200)}`);
  return result?.structuredContent ?? (text ? JSON.parse(text) : null);
}

// ---- PriceLabs Customer API ----
export async function pricelabsRows(listingId, dateFrom, dateTo) {
  const key = process.env.PRICELABS_API_KEY;
  if (!key) throw new Error('PRICELABS_API_KEY is not set');
  const res = await fetch('https://api.pricelabs.co/v1/listing_prices', {
    method: 'POST',
    headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ listings: [{ id: listingId, pms: 'channex', dateFrom, dateTo }] }),
    signal: AbortSignal.timeout(30000)
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`PriceLabs ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
  const item = Array.isArray(json) ? json[0] : json;
  return { currency: item?.currency || '', rows: item?.data || [] };
}

/** Base price of a PriceLabs listing (the base in the listing settings) and its currency. */
export async function pricelabsBase(listingId) {
  const key = process.env.PRICELABS_API_KEY;
  if (!key) throw new Error('PRICELABS_API_KEY is not set');
  const res = await fetch(`https://api.pricelabs.co/v1/listings/${encodeURIComponent(listingId)}?pms=channex`, {
    headers: { 'X-API-Key': key, Accept: 'application/json' },
    signal: AbortSignal.timeout(30000)
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`PriceLabs ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
  const item = Array.isArray(json?.listings) ? json.listings[0] : Array.isArray(json) ? json[0] : json;
  return { base: Number(item?.base) || 0, currency: String(item?.currency || '').toUpperCase() };
}

// ---- GHL conversations (Instagram DMs) ----
const ghlHeaders = () => ({ Authorization: `Bearer ${process.env.GHL_API_TOKEN}`, Version: '2021-04-15', 'Content-Type': 'application/json', Accept: 'application/json' });

export async function findConversation(contactId) {
  const url = `${GHL}/conversations/search?locationId=${encodeURIComponent(process.env.GHL_LOCATION_ID)}&contactId=${encodeURIComponent(contactId)}`;
  const res = await fetch(url, { headers: ghlHeaders(), signal: AbortSignal.timeout(30000) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GHL conversation search ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
  return (json.conversations || [])[0] || null;
}

/** Recent messages, oldest first. */
export async function getThread(conversationId, limit = 20) {
  const res = await fetch(`${GHL}/conversations/${encodeURIComponent(conversationId)}/messages?limit=${limit}`, { headers: ghlHeaders(), signal: AbortSignal.timeout(30000) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GHL messages ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
  const list = json?.messages?.messages ?? json?.messages ?? [];
  return (Array.isArray(list) ? list : [])
    .map((m) => ({ id: m.id, direction: m.direction, body: m.body || '', type: m.messageType || m.type || '', at: m.dateAdded || '' }))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

export async function sendInstagram(contactId, message) {
  const res = await fetch(`${GHL}/conversations/messages`, { method: 'POST', headers: ghlHeaders(), body: JSON.stringify({ type: 'IG', contactId, message }), signal: AbortSignal.timeout(30000) });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, messageId: json.messageId || json.id || null, response: res.ok ? undefined : json };
}
