// Judge client (design §7): one batched request per step, strict response
// validation (never partial), timeout, session circuit breaker. Providers:
// typesafe | openrouter | openai (JSON judge) | off. Injectable fetch for
// hermetic tests. Keys arrive via the DSH credential store resolver at the
// plugin layer; nothing here touches env or yml.

export class JudgeError extends Error {}

export function questionsFor(candidatesWithSpans) {
  const qs = [];
  for (const c of candidatesWithSpans)
    for (const p of c.parts)
      if (p.kind === "span")
        qs.push({ id: `${c.seq}:${p.blockIndex}:${p.index}`, kind: "noul",
                  question: "Keep this span in context for the current task?",
                  excerpt: p.text.slice(0, 200) });
  return qs;
}

export async function judgeOnce({ config, state, questions, fetchImpl = globalThis.fetch, AbortSignalCtor = AbortSignal }) {
  const { provider, model, timeoutMs } = config.judge;
  if (provider === "off") return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (provider === "typesafe" || provider === "openrouter") {
      const base = provider === "typesafe"
        ? (config.judge.baseUrl || "https://api.typesafe.ai")
        : (config.judge.baseUrl || "https://openrouter.ai/api");
      const path = provider === "typesafe" ? "/v1/systemone" : "/alpha/decisions";
      const res = await fetchImpl(base + path, {
        method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config._apiKey ?? ""}` },
        body: JSON.stringify({ model, state, questions: questions.map((q) => ({ type: q.kind, question: q.question, context: q.excerpt, id: q.id })) }),
      });
      if (!res.ok) throw new JudgeError(`HTTP ${res.status}`);
      const data = await res.json();
      const answers = data.answers ?? data.decisions ?? [];
      return validate(answers, questions);
    }
    // openai-compatible JSON judge (air-gapped path)
    const res = await fetchImpl((config.judge.baseUrl || "") + "/chat/completions", {
      method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config._apiKey ?? ""}` },
      body: JSON.stringify({
        model, temperature: 0, response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "You are a calibrated keep/drop judge for context pruning. Answer with JSON {\"verdicts\":[{\"id\":\"...\",\"p_keep\":0..1}]}. Keep on doubt: p_keep is the probability the span is still needed for the current task. Decide per span independently." },
          { role: "user", content: JSON.stringify({ state, questions }) },
        ],
      }),
    });
    if (!res.ok) throw new JudgeError(`HTTP ${res.status}`);
    const data = await res.json();
    const inner = JSON.parse(data.choices[0].message.content);
    return validate(inner.verdicts ?? [], questions);
  } finally { clearTimeout(timer); }
}

function validate(answers, questions) {
  const byId = new Map(answers.map((a) => [a.id ?? a.question_id, a]));
  if (byId.size !== questions.length) throw new JudgeError(`verdict count mismatch (${byId.size} vs ${questions.length}) — whole response discarded`);
  const out = new Map();
  for (const q of questions) {
    const a = byId.get(q.id);
    if (!a) throw new JudgeError(`missing verdict for ${q.id}`);
    const p = Number(a.p_keep ?? a.probability ?? a.p);
    if (!Number.isFinite(p) || p < 0 || p > 1) throw new JudgeError(`invalid p_keep for ${q.id}`);
    out.set(q.id, p);
  }
  return out;                                                        // Map<spanId, p_keep>
}

// Circuit breaker (design §7): N consecutive failures → inert for the session.
export function makeBreaker(maxFailures) {
  let consecutive = 0, tripped = false;
  return {
    get tripped() { return tripped; },
    ok() { consecutive = 0; },
    fail() { if (++consecutive >= maxFailures) tripped = true; },
  };
}
