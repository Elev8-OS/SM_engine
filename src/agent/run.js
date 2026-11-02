/** The tool loop. callModel and execute are injected so it can be tested without network. */
function normalise(input) {
  const i = input || {};
  return {
    reply: String(i.reply || '').trim(),
    needs_human: Boolean(i.needs_human),
    reason: String(i.reason || ''),
    intent: String(i.intent || 'other'),
    language: String(i.language || '')
  };
}

export async function runAgent({ system, userText, tools, callModel, execute, maxSteps = 6 }) {
  const trace = [];
  const messages = [{ role: 'user', content: userText }];
  for (let step = 0; step < maxSteps; step++) {
    const res = await callModel({ system, messages, tools });
    const blocks = res.content || [];
    const uses = blocks.filter((b) => b.type === 'tool_use');
    const submit = uses.find((u) => u.name === 'submit_reply');
    if (submit) return { ...normalise(submit.input), trace };
    if (!uses.length) {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      return { reply: text, needs_human: true, reason: 'The assistant did not finish with a structured reply. Please check.', intent: 'other', language: '', trace };
    }
    messages.push({ role: 'assistant', content: blocks });
    const results = [];
    for (const u of uses) {
      let out;
      try {
        out = await execute(u.name, u.input || {});
      } catch (e) {
        out = { error: String(e.message || e).slice(0, 300) };
      }
      trace.push({ tool: u.name, input: u.input, output: out });
      results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out).slice(0, 6000) });
    }
    messages.push({ role: 'user', content: results });
  }
  return { reply: '', needs_human: true, reason: 'The assistant needed too many steps. Please handle this one.', intent: 'other', language: '', trace };
}
