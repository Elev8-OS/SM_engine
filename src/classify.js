import { q } from './db.js';
import { HttpError } from './util.js';
import { compareRoutes } from './compare-sources.js';

// Automatic villa and category for Instagram posts that did not come out of the engine (older or manual posts).
// Villa: found by name in the caption and hashtags. Category: a small model call, with simple rules as the fallback.
export const PILLAR_KEYS = ['villa_spotlight', 'which_villa_for', 'design_details', 'neighbourhood', 'workation', 'book_direct', 'other'];

const shortName = (name) => String(name || '').replace(/^The R (Villa|Apartments?)\s+/i, '').trim().toLowerCase();

/** Keys of the properties named in a text, in the order of the property list. */
export function detectVillas(text, props) {
  const lower = String(text || '').toLowerCase();
  const words = ` ${lower.replace(/[^a-z0-9äöüéèà]+/g, ' ')} `;
  const out = [];
  for (const p of props) {
    const names = new Set([String(p.key || '').toLowerCase(), shortName(p.name)].filter((n) => n && n.length >= 4));
    const hit = [...names].some((n) => (n.length >= 5 ? lower.includes(n) : words.includes(` ${n} `)));
    if (hit) out.push(p.key);
  }
  return out;
}

/** Category from keywords. The fallback when no model answer is available. */
export function pillarByRules(caption, villas = []) {
  const t = String(caption || '').toLowerCase();
  if (!t.trim()) return 'other';
  if (/book direct|direct booking|best rate|skip the (platform|middle)|no platform/.test(t)) return 'book_direct';
  if (/workation|work from|remote work|digital nomad|laptop|co-?working|\bdesk\b|wi-?fi/.test(t)) return 'workation';
  if (villas.length >= 2 || /(perfect|ideal|great) for (couples|families|friends|groups)|which villa/.test(t)) return 'which_villa_for';
  if (/neighbo(u)?rhood|around the corner|minutes? (from|to|away)|walk to|caf[eé]|restaurant|warung|beach club/.test(t)) return 'neighbourhood';
  if (t.length < 400 && /design|detail|texture|material|handmade|\btile|bathroom|kitchen/.test(t)) return 'design_details';
  if (villas.length === 1) return 'villa_spotlight';
  return 'other';
}

const SYSTEM = [
  'You sort Instagram posts of a Bali villa brand into one category. Answer only through the tool.',
  'villa_spotlight: one villa, its view, pool or rooms. which_villa_for: matches villas to groups (couples, families, friends) or shows several villas.',
  'design_details: one design detail such as light, materials, bathroom, kitchen. neighbourhood: the area around the villa, cafes, beaches, places.',
  'workation: working from the villa. book_direct: why to book direct, best rate. other: team, guests, events, offers, reposts, anything that fits none of these.'
].join('\n');

const TOOL = {
  name: 'classify',
  description: 'The category of the post',
  input_schema: { type: 'object', properties: { pillar: { type: 'string', enum: PILLAR_KEYS } }, required: ['pillar'] }
};

/** One small model call. Returns a category or null when it cannot answer. Never throws. */
export async function pillarByModel(caption, villaKeys = [], { fetchFn = fetch } = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !String(caption || '').trim()) return null;
  try {
    const res = await fetchFn('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.CLASSIFY_MODEL || 'claude-haiku-5-5',
        max_tokens: 150,
        system: SYSTEM,
        tools: [TOOL],
        tool_choice: { type: 'tool', name: 'classify' },
        messages: [{ role: 'user', content: `Villas named: ${villaKeys.join(', ') || 'none'}\nCaption:\n${String(caption).slice(0, 1500)}` }]
      }),
      signal: AbortSignal.timeout(30000)
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return null;
    const p = json.content?.find((c) => c.type === 'tool_use')?.input?.pillar;
    return PILLAR_KEYS.includes(p) ? p : null;
  } catch {
    return null;
  }
}

/** Classifies posts that have no match in the engine and have not been classified yet. Returns how many were done. */
export async function classifyNew({ limit = 40, fetchFn = fetch } = {}) {
  const props = await q('select key, name from properties');
  const rows = await q('select media_id, caption from post_insights where post_id is null and classified_at is null order by posted_at desc nulls last limit $1', [limit]);
  let n = 0;
  for (const r of rows) {
    const villas = detectVillas(r.caption, props);
    const model = await pillarByModel(r.caption, villas, { fetchFn });
    const pillar = model ?? pillarByRules(r.caption, villas);
    // With several villas named the post belongs to none of them in particular
    await q("update post_insights set villa_key = $2, pillar = $3, classified_by = $4, classified_at = now() where media_id = $1", [r.media_id, villas.length === 1 ? villas[0] : null, pillar, model ? 'model' : 'rules']);
    n++;
  }
  return n;
}

export function classifyRoutes(app, needDb, ah) {
  compareRoutes(app, needDb, ah); // automatic against by hand (compare-sources.js), registered here with the post assignment it builds on
  // Classify what is still open, now
  app.post('/stats/posts/classify', needDb, ah(async (_req, res) => res.json({ classified: await classifyNew({ limit: 100 }) })));
  // Correct one post by hand. A manual choice is never overwritten.
  app.put('/stats/posts/:mediaId/class', needDb, ah(async (req, res) => {
    const mediaId = String(req.params.mediaId);
    const pillar = req.body?.pillar;
    const villa = req.body?.villa ? String(req.body.villa).toLowerCase() : null;
    if (!PILLAR_KEYS.includes(pillar)) throw new HttpError(400, `pillar must be one of ${PILLAR_KEYS.join(', ')}`);
    if (villa && !(await q('select 1 from properties where key = $1', [villa])).length) throw new HttpError(400, `Unknown villa '${villa}'`);
    await q("update post_insights set villa_key = $2, pillar = $3, classified_by = 'manual', classified_at = now() where media_id = $1", [mediaId, villa, pillar]);
    res.json({ mediaId, villa, pillar });
  }));
}
