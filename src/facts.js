import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Fact sheets per villa (src/facts/<key>.json). They do three things:
// 1. give the copywriter verified facts, plus what is NOT available and what is NOT confirmed yet,
// 2. correct fields the copywriter would otherwise misread (a plot size is not living space),
// 3. check the finished copy and warn before anything is approved.
// Only fields written into the sheet reach the model. Door codes, WiFi data and guest data never do.
// status: "confirmed" = the owner confirmed it, "elev8" = taken from Elev8 and still to be confirmed, anything else is not used.

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'facts');
const USABLE = new Set(['confirmed', 'elev8']);

// Claims that are easy to invent. A claim passes only when a confirmed fact carries the same tag.
const TERMS = {
  bathtub: { label: 'bathtub', re: /\bbath ?tubs?\b|\bsoaking tubs?\b/i },
  hot_tub: { label: 'hot tub', re: /\bhot tubs?\b|\bjacuzzi\b|\bwhirlpool\b/i },
  bbq: { label: 'barbecue', re: /\bbbq\b|\bbarbecue\b|\bbarbeque\b|\bgrill\b/i },
  gym: { label: 'gym', re: /\bgym\b|\bfitness (room|area|studio|cent(er|re))\b/i },
  cinema: { label: 'cinema', re: /\bcinema\b|\bmovie room\b|\bhome theat(er|re)\b/i },
  sauna: { label: 'sauna', re: /\bsauna\b|\bsteam room\b/i },
  rooftop: { label: 'rooftop', re: /\broof ?top\b|\broof (terrace|deck)\b/i },
  rice_view: { label: 'rice field view', re: /\brice[- ]?(field|paddy|paddies|terrace)s?\b[^.!?\n]{0,30}\b(views?|overlook\w*|facing|backdrop)\b|\b(views?|overlook\w*|facing|wake up to|surrounded by|beyond)\b[^.!?\n]{0,25}\brice\b/i },
  sunset_view: { label: 'sunset view', re: /\bsunset views?\b|\bviews? (of|over|at) (the )?sunsets?\b|\bwatch(ing)? the sunset\b|\bsunsets? from\b/i },
  sea_view: { label: 'ocean view', re: /\b(ocean|sea)[- ]?views?\b|\bviews? (of|over) the (ocean|sea)\b/i },
  beach_near: { label: 'beach distance', re: /\b(steps|minutes?|mins?|walk(ing)?( distance)?)\b[^.!?\n]{0,20}\b(to|from) (the )?beach\b|\bbeach ?front\b|\b(near|close to|next to) (the )?beach\b/i },
  breakfast: { label: 'breakfast included', re: /\bbreakfast (is )?(included|inclusive)\b|\bincluding breakfast\b|\bcomplimentary breakfast\b|\bdaily breakfast\b/i },
  chef: { label: 'private chef', re: /\b(private|personal|in-?villa) chef\b/i },
  workspace: { label: 'workspace', re: /\bhome office\b|\bworkspace\b|\bworkation\b|\bwork from (the )?villa\b|\bdesk\b/i },
  pets: { label: 'pet friendly', re: /\bpet[- ]friendly\b|\bpets (are )?welcome\b|\bdog[- ]friendly\b|\bbring your (dog|pet)s?\b/i },
  secluded: { label: 'secluded', re: /\bsecluded\b|\bcompletely private\b|\bno neighbou?rs\b|\btotal privacy\b/i }
};

let cache = null;
function load() {
  if (cache) return cache;
  cache = new Map();
  let files = [];
  try {
    files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return cache; // no fact sheets: everything works as before
  }
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      if (d.key && Array.isArray(d.facts)) cache.set(d.key, d);
    } catch (e) {
      console.error('Fact sheet unreadable:', f, e.message);
    }
  }
  return cache;
}

export const factsFor = (key) => load().get(key) || null;
export const factKeys = () => [...load().keys()];

const confirmedTags = (f) => new Set(f.facts.filter((x) => x.status === 'confirmed').flatMap((x) => x.tags || []));
const termLabel = (t) => TERMS[t]?.label || String(t).replace(/_/g, ' ');

/** The property as the copywriter sees it: guest count and size taken from the sheet, plot and building size told apart. */
export function withFacts(p) {
  const f = factsFor(p.key);
  if (!f) return p;
  const out = { ...p, guests: f.guestsMax ?? p.guests, bedrooms: f.bedroomsText ?? p.bedrooms };
  delete out.sizeM2; // the old field does not say what the number measures
  if (f.plotM2) out.plotM2 = f.plotM2;
  if (f.buildingM2) out.buildingM2 = f.buildingM2;
  return out;
}

/** Lines for the prompt, empty for villas without a sheet. */
export function promptBlock(properties) {
  const lines = [];
  for (const p of properties || []) {
    const f = factsFor(p.key);
    if (!f) continue;
    lines.push('', `VERIFIED FACTS for ${f.name} (they win over anything above if they differ; add no details beyond them):`);
    for (const x of f.facts) if (USABLE.has(x.status)) lines.push(`- ${x.text}`);
    if (f.absent?.length) lines.push(`NOT AVAILABLE at ${f.name}, never claim: ${f.absent.map((a) => termLabel(a.term)).join(', ')}.`);
    if (f.open?.length) {
      lines.push(`NOT CONFIRMED for ${f.name}, do not state as fact:`);
      for (const x of f.open) lines.push(`- ${x}`);
    }
  }
  return lines;
}

/** Numbers the sheet allows, merged into the existing number check. */
export function factNumbers(plan) {
  const guests = new Set();
  const bedrooms = new Set();
  for (const p of plan?.properties || []) {
    const f = factsFor(p.key);
    if (!f) continue;
    if (f.guestsMax) guests.add(f.guestsMax);
    if (f.bedrooms) bedrooms.add(f.bedrooms);
  }
  return { guests, bedrooms };
}

function strings(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (k !== 'warnings') strings(x, out);
  return out;
}

/** Warnings about claims the sheets do not support. Never throws. */
export function checkFacts(copy, plan) {
  const props = (plan?.properties || []).map((p) => factsFor(p.key)).filter(Boolean);
  if (!props.length) return [];
  const text = strings(copy).join('\n');
  const names = props.map((f) => f.name).join(' / ');
  const out = [];
  for (const [id, t] of Object.entries(TERMS)) {
    if (!t.re.test(text)) continue;
    if (props.some((f) => confirmedTags(f).has(id))) continue;
    const lacking = props.filter((f) => (f.absent || []).some((a) => a.term === id));
    out.push(lacking.length ? `Fact check: "${t.label}" is mentioned, but ${lacking.map((f) => f.name).join(' and ')} does not have it` : `Fact check: "${t.label}" is not confirmed for ${names}. Confirm it or remove it`);
  }
  const known = props.flatMap((f) => [f.plotM2, f.buildingM2, f.livingM2]).filter(Boolean);
  for (const m of text.matchAll(/(\d[\d.,]*)\s*(?:m2|m²|sqm|sq\.? ?m|square met(?:er|re)s?)/gi)) {
    const n = Number(m[1].replace(/[.,]/g, ''));
    if (!known.includes(n)) {
      out.push(`Fact check: "${m[0]}" is not in the facts`);
      continue;
    }
    const around = text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60);
    if (props.some((f) => f.plotM2 === n) && !/plot|land|grounds|garden|compound/i.test(around)) out.push(`Fact check: "${m[0]}" is the plot size, not living space. Say "plot" or leave the size out`);
  }
  return [...new Set(out)];
}
