// How Lea answers: always with approval, always automatically, or automatically inside a time window.
// The window is in the hours a person is not around, for example 22:00 to 08:00; outside it replies wait for approval.
// A reply that needs a person (complaint, payment, group, ...) is never sent automatically, whatever is set here.

export const MODES = ['review', 'auto', 'window'];
export const ZONES = { 'Europe/Zurich': 'Zürich', 'Asia/Makassar': 'Bali' };
export const DEFAULT_WINDOW = { from: 22, to: 8, tz: 'Europe/Zurich' };

/** Hour of the day (0-23) in a time zone. */
export function hourIn(tz, date = new Date()) {
  const part = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: tz }).formatToParts(date).find((p) => p.type === 'hour');
  return Number(part?.value);
}

/** Is the hour inside [from, to)? A window like 22 to 8 runs over midnight. */
export function inWindow(hour, from, to) {
  if (from === to) return false;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

const hour = (v, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 23) throw new Error(`${name} must be a whole hour from 0 to 23`);
  return n;
};

/** Validated settings. Throws a readable error for anything that does not make sense. */
export function normalise(input) {
  const mode = input.mode;
  if (!MODES.includes(mode)) throw new Error(`mode must be one of ${MODES.join(', ')}`);
  const from = hour(input.from, 'from');
  const to = hour(input.to, 'to');
  const tz = input.tz;
  if (!ZONES[tz]) throw new Error(`tz must be one of ${Object.keys(ZONES).join(', ')}`);
  if (mode === 'window' && from === to) throw new Error('The window needs different start and end hours');
  return { mode, from, to, tz };
}

/** Should a reply that is ready go out by itself right now? */
export function autoNow(settings, date = new Date()) {
  if (settings.mode === 'auto') return true;
  if (settings.mode === 'window') return inWindow(hourIn(settings.tz, date), settings.from, settings.to);
  return false;
}

/** Final decision for one reply: a person is needed, or there is nothing to send, means never automatic. */
export function mayAutoSend(settings, result, date = new Date()) {
  if (!result || result.needs_human || !String(result.reply || '').trim()) return false;
  return autoNow(settings, date);
}

export function settingsView(settings, date = new Date()) {
  return { ...settings, zones: ZONES, autoNow: autoNow(settings, date), hourNow: hourIn(settings.tz, date) };
}

// ---- storage (a key/value row in Postgres) ----

export async function loadSettings(q, env = process.env) {
  // Until someone saves a choice, the old switch in the environment decides.
  const base = { mode: env.AGENT_AUTO_SEND === 'true' ? 'auto' : 'review', ...DEFAULT_WINDOW };
  const rows = await q("select value, updated_at from agent_settings where key = 'reply'");
  if (!rows.length) return { ...base, stored: false };
  try {
    return { ...normalise({ ...base, ...rows[0].value }), stored: true, updatedAt: rows[0].updated_at };
  } catch {
    return { ...base, stored: false };
  }
}

export async function saveSettings(q, input, env = process.env) {
  const current = await loadSettings(q, env);
  const next = normalise({ ...current, ...input });
  await q("insert into agent_settings (key, value, updated_at) values ('reply', $1, now()) on conflict (key) do update set value = excluded.value, updated_at = now()", [JSON.stringify(next)]);
  return { ...next, stored: true };
}
