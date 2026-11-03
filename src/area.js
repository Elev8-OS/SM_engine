import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Area facts per villa (src/area/<key>.json), taken from the Elev8 area guide.
// They give the copywriter real places with honest distances, and check the finished copy.
// Prices, star ratings and opening hours are not stored here and must not appear in posts.

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'area');
const WALKABLE = 15; // longer than this is not presented as a walk

let cache = null;
function load() {
  if (cache) return cache;
  cache = new Map();
  let files = [];
  try {
    files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return cache; // no area files: everything works as before
  }
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      if (d.key && Array.isArray(d.spots)) cache.set(d.key, d);
    } catch (e) {
      console.error('Area file unreadable:', f, e.message);
    }
  }
  return cache;
}

export const areaFor = (key) => load().get(key) || null;

/** How far a spot is, in words the copywriter may use. */
export function how(s) {
  if (s.walkMin && s.walkMin <= WALKABLE) return `${s.walkMin} min on foot`;
  if (s.scooterMin) return `about ${s.scooterMin} min by scooter`;
  if (s.distanceKm) return `about ${s.distanceKm} km away, by scooter or Grab`;
  if (s.walkMin) return 'a short scooter or Grab ride, not a walk';
  return s.where ? `in ${s.where}, by scooter or Grab` : 'nearby';
}

const rank = (s) => (s.walkMin && s.walkMin <= WALKABLE ? s.walkMin : 1000);

/**
 * Lines for the prompt, empty for villas without an area file.
 * all=true (neighbourhood posts) lists every spot, otherwise only the closest few.
 */
export function areaPromptBlock(properties, { all = false, max = 8 } = {}) {
  const lines = [];
  const seen = new Set();
  for (const p of properties || []) {
    const a = areaFor(p.key);
    if (!a || seen.has(a.key)) continue;
    seen.add(a.key);
    const spots = [...a.spots].sort((x, y) => rank(x) - rank(y));
    const use = all ? spots : spots.filter((s) => s.walkMin && s.walkMin <= WALKABLE).slice(0, max);
    lines.push('', `AREA around ${p.name || a.key} (verified, from the Elev8 area guide). Use only these places, with the distance as written, and add no prices, star ratings or opening hours:`);
    for (const s of use) lines.push(`- ${s.name} (${s.kind}): ${how(s)}${s.note ? `. ${s.note}` : ''}`);
    if (a.honest?.length) {
      lines.push('Honest about the area (never contradict):');
      for (const h of a.honest) lines.push(`- ${h}`);
    }
    if (all && a.seasons?.length) {
      lines.push('Seasons (only for posts about the time of year):');
      for (const s of a.seasons) lines.push(`- ${s}`);
    }
  }
  return lines;
}

/** Warnings about area claims the area facts do not support. Never throws. */
export function checkArea(copy, plan) {
  const areas = (plan?.properties || []).map((p) => areaFor(p.key)).filter(Boolean);
  if (!areas.length) return [];
  const { warnings: _w, ...rest } = copy || {};
  const text = JSON.stringify(rest);
  const out = [];
  if (/\b(IDR|Rp\.?|rupiah)\b/i.test(text)) out.push('Area check: prices in rupiah do not belong in a post');
  if (/\b\d(?:[.,]\d)?\s*(?:stars?|\/\s*5)\b|★/i.test(text)) out.push('Area check: star ratings of places do not belong in a post');
  if (/\b(?:swim(?:ming)?|dip)\s+in\s+the\s+(?:ocean|sea)\b|\b(?:ocean|sea)\s+swim(?:s|ming)?\b/i.test(text)) out.push('Area check: the sea at Pererenan is not for swimming. Remove the swimming-in-the-sea line');
  const known = new Set(areas.flatMap((a) => a.spots).filter((s) => s.walkMin && s.walkMin <= WALKABLE).map((s) => s.walkMin));
  for (const m of text.matchAll(/(\d+)\s*-?\s*min(?:ute)?s?(?:\s+(?:on foot|by foot)|[\s-]+walk(?:ing)?)/gi)) {
    if (!known.has(Number(m[1]))) out.push(`Area check: "${m[0]}" is not in the area facts (known walks: ${[...known].sort((a, b) => a - b).join(', ')} min)`);
  }
  return [...new Set(out)];
}
