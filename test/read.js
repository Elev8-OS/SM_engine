import assert from 'node:assert/strict';
import { readGuest, whyEmpty } from '../src/agent/read.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };
const wait = async () => {};
const row = (o = {}) => ({ created_at: '2026-11-03T12:56:56Z', contact_id: 'c1', conversation_id: null, guest_message: null, ...o });
const msg = (body, at, direction = 'inbound') => ({ id: body + at, direction, body, type: 'TYPE_INSTAGRAM', at });

await t('text there on the first try', async () => {
  const calls = { c: 0 };
  const r = await readGuest(row(), { wait, findConversation: async () => ({ id: 'cv' }), getThread: async () => { calls.c++; return [msg('Is Luwa free next week?', '2026-11-03T12:56:50Z')]; } });
  assert.equal(r.text, 'Is Luwa free next week?');
  assert.equal(r.tries, 1);
  assert.equal(calls.c, 1);
});
await t('empty body is retried until the text appears', async () => {
  let k = 0;
  const r = await readGuest(row(), { wait, findConversation: async () => ({ id: 'cv' }), getThread: async () => [msg(++k < 3 ? '' : 'Hello', '2026-11-03T12:56:50Z')] });
  assert.equal(r.text, 'Hello');
  assert.equal(r.tries, 3);
});
await t('conversation appears late', async () => {
  let k = 0;
  const r = await readGuest(row(), { wait, findConversation: async () => (++k < 2 ? null : { id: 'cv' }), getThread: async () => [msg('Hi', '2026-11-03T12:56:50Z')] });
  assert.equal(r.text, 'Hi');
  assert.equal(r.conversationId, 'cv');
});
await t('an older message is not taken for the new one', async () => {
  const r = await readGuest(row(), { wait, findConversation: async () => ({ id: 'cv' }), getThread: async () => [msg('🔥', '2026-09-19T13:24:12Z')] });
  assert.equal(r.text, '');
  assert.equal(r.stale, true);
  assert.equal(r.tries, 4);
  assert.match(whyEmpty(r), /older message/);
});
await t('an older message turns into the new one once it arrives', async () => {
  let k = 0;
  const r = await readGuest(row(), { wait, findConversation: async () => ({ id: 'cv' }), getThread: async () => (++k < 3 ? [msg('🔥', '2026-09-19T13:24:12Z')] : [msg('🔥', '2026-09-19T13:24:12Z'), msg('Villa Luwa next week?', '2026-11-03T12:56:55Z')]) });
  assert.equal(r.text, 'Villa Luwa next week?');
});
await t('team replies do not count as guest messages', async () => {
  const r = await readGuest(row(), { wait, findConversation: async () => ({ id: 'cv' }), getThread: async () => [msg('We have it', '2026-11-03T12:56:50Z', 'outbound')] });
  assert.equal(r.text, '');
});
await t('text from the webhook needs no waiting', async () => {
  let c = 0;
  const r = await readGuest(row({ guest_message: 'Hi' }), { wait, findConversation: async () => ({ id: 'cv' }), getThread: async () => { c++; return []; } });
  assert.equal(r.text, 'Hi');
  assert.equal(r.tries, 1);
});
await t('a redraft long after the first run still finds the message', async () => {
  const r = await readGuest(row({ created_at: '2026-11-03T12:56:56Z' }), { wait, findConversation: async () => ({ id: 'cv' }), getThread: async () => [msg('Villa Luwa?', '2026-11-03T12:56:55Z')] });
  assert.equal(r.text, 'Villa Luwa?');
});
await t('no conversation and attachment-only are explained', async () => {
  const a = await readGuest(row(), { wait, findConversation: async () => null, getThread: async () => [] });
  assert.match(whyEmpty(a), /No conversation found/);
  const b = await readGuest(row(), { wait, findConversation: async () => ({ id: 'cv' }), getThread: async () => [msg('', '2026-11-03T12:56:50Z')] });
  assert.match(whyEmpty(b), /no text/);
});
console.log(`\n${n} tests passed`);
