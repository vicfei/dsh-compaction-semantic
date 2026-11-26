// V2 keep/drop compaction engine (docs/design-v2.md, issue #10): wraps
// ctx.compaction.summarize — the engine's sole customization hook — so the
// checkpoint that replaces the compacted range is assembled from VERBATIM-KEPT
// messages instead of LLM prose. Every failure falls back to the stock prose
// summarizer: we replace the summarizer, never the turn.
//
// Contract (spike facts, host 0.2.2-rc.1, design §2):
// - input = {messages: provider-format [{role, content: blocks}], tools}; we
//   judge messages only (tools re-attach engine-side).
// - return {summary: text-only blocks}; the engine frames them and enforces
//   estimateMessage(framed) < shadowedRouteTokenCount — we self-enforce the
//   same invariant BEFORE returning, with a deterministic shrink loop, and
//   hand the decision back to stock when judgment cannot shrink.
import { buildState } from "./state.js";
import { judgeOnce, questionsFor, JudgeError } from "./judge.js";
import { appendLedger } from "./ledger.js";

// The engine frames our blocks engine-side as THREE+ blocks: preamble+open
// tag, our content, close tag (closure: frameSummary). Price the framed
// checkpoint EXACTLY that way — a single-block estimate undershot the real
// framing by ~30 tokens and failed the invariant by a hair (found live:
// 790 >= 778).
const SUMMARY_OPEN_TAG = "<compacted-summary>";
const SUMMARY_CLOSE_TAG = "</compacted-summary>";
const CHECKPOINT_PREAMBLE = "This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.";

// A message as one text block: its text parts byte-equal; non-text parts
// fenced (a user-message checkpoint is text-only — spike fact 8).
export function flattenMessage(message) {
  const blocks = Array.isArray(message?.content) ? message.content
    : typeof message?.content === "string" ? [{ type: "text", text: message.content }] : [];
  const parts = [];
  for (const b of blocks) {
    if (b?.type === "text") parts.push(b.text);
    else parts.push("```\n" + JSON.stringify(b ?? null) + "\n```");   // tool-calls, images — rendered, not dropped silently
  }
  return { role: message?.role ?? "?", text: sanitizeText(parts.join("\n")) };
}

// Verbatim means verbatim — except byte-broken sequences that were never valid
// text: lone surrogates (a `head -c` mid-character cut) fail the session
// log's serializability check and fail the WHOLE compaction (found live:
// 'compaction/summary carries non-JSON-serializable data'). Replace only
// those with U+FFFD; every valid character rides byte-equal.
export function sanitizeText(text) {
  return String(text)
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "\uFFFD")
    .replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "$1\uFFFD");
}

// The engine's invariant prices the COMPACTED RANGE; the hook only hands us
// the whole replayed prefix, so our own Σ-estimate can overshoot the range
// badly after V1 pruned inside it (found live: framed 2327 >= shadowed 758).
// The engine's own error message carries the authoritative number — listen on
// its summary-error waterfall, learn it, return true for exactly ONE retry;
// the second pass shrinks against the true basis. This is the retry path the
// waterfall exists for.
// The engine's invariant prices the COMPACTED RANGE; the hook only hands us
// the whole replayed prefix, and the range can be far smaller (V1 pruned
// inside it — found live: framed 2327 >= shadowed 778). We cannot read the
// range or the engine's priced basis from the hook. So: per session, target
// framed ≤ Σ(prefix) × 0.9 / 2^(attempt-1); every rejection halves the target
// on the next pressure attempt (the host retries compaction across steps),
// and the fourth attempt hands the range to the stock prose summarizer.
// Deterministic, no host-internal APIs, converges in ≤3 tries.
function makeShadowedBasis(say) {
  const attempts = new WeakMap();   // session -> attempt number (1-based)
  return {
    basis(session, prefixSum, factor0) {
      const n = attempts.get(session) ?? 1;
      // attempt 1 targets 25% of the prefix: the compacted range is a prefix
      // SLICE (V1 may have pruned inside it and the retain tail is replayed
      // too), so Σ(prefix) overstates the invariant basis badly — measured
      // live at 33%. 25% passes on the first attempt there; drops are ordered
      // by confidence, so a tighter target only sheds low-confidence keeps.
      const factor = factor0 > 0 && n === 1 ? factor0 : [0.25, 0.12, 0.06][n - 1] ?? 0;
      const target = Math.max(64, Math.floor(prefixSum * factor));
      return { target, attempt: n };
    },
    rejected(session, say2 = say) {
      const n = attempts.get(session) ?? 1;
      attempts.set(session, n + 1);
      say2(`engine rejected our framing (attempt ${n}) — next attempt targets a tighter framing`);
    },
    reset(session) { attempts.delete(session); },
  };
}

export function wrapEngine(ctx, config, breaker, say) {
  const engineSvc = ctx.compaction;
  if (config.judge.provider === "off" || config.engine.enabled === false) return;   // zero footprint — stock
  if (typeof engineSvc?.summarize !== "function") {
    say("engine wrap skipped: no ctx.compaction.summarize on this host (stock summarizer stays)");
    return;
  }
  if (engineSvc.__csWrapped) return;                                                // idempotent on re-apply
  const stock = engineSvc.summarize.bind(engineSvc);
  const basis = makeShadowedBasis(say);
  const lastAnswer = new WeakMap();   // session -> the summary object we last returned

  engineSvc.summarize = async function csSemanticSummarize(input, agent, signal) {
    let dump = null;
    try {
      const messages = input?.messages ?? [];
      const meter = ctx.tokenMeter;
      if (breaker.tripped || messages.length === 0 || !meter?.estimateMessage) return stock(input, agent, signal);
      if ((basis.basis(agent?.session, 1).attempt) >= 4) { say("engine: three framings rejected — handing this range to the stock summarizer"); basis.reset(agent?.session); return stock(input, agent, signal); }
      const prefixSum = messages.reduce((n, m) => n + (meter.estimateMessage(m) || 0), 0);
      // a repeat call with the same input = our previous answer was rejected:
      // same Σ prefix, the engine retrying pressure on a later step
      if (lastAnswer.get(agent?.session) === input && prefixSum > 0) basis.rejected(agent?.session);
      const { target: shadowed, attempt } = basis.basis(agent?.session, prefixSum, config.engine.targetFactor);
      if (shadowed < config.engine.minSavingsTokens * 2) return stock(input, agent, signal);   // small range: prose is cheaper than a checkpoint question

      if (process.env.CS_DEBUG_SUMMARIZE_INPUT) {   // the shape pin from design §10, kept as a debug aid
        dump = messages.map((m) => ({ role: m.role, kinds: (Array.isArray(m.content) ? m.content : [m.content]).map((b) => b?.type ?? typeof b) }));
      }
      const flat = messages.map(flattenMessage).filter((m) => m.text.trim().length > 0);
      const judged = flat.slice(0, config.engine.maxMessages);
      const state = buildState({ messages: input.messages, session: agent?.session, config });
      const questions = judged.map((m, i) => ({ id: `m${i}`, kind: "noul",
        question: "Keep this whole message verbatim in context for the current task?",
        excerpt: m.text.slice(0, 200) }));
      const t0 = Date.now();
      const verdicts = await judgeOnce({ config, state, questions });
      const judgeMs = Date.now() - t0;
      breaker.ok();

      const pOf = (i) => verdicts?.get(`m${i}`);
      let keep = new Set(judged.map((_, i) => i).filter((i) => (pOf(i) ?? 1) >= config.dropThreshold));   // unjudged → keep (cap tail, keep-on-doubt)
      const framed = (idxs) => [{ type: "text", text: idxs.map((i) => flat[i].text).join("\n\n") }];
      const estimate = (idxs) => (meter.estimateMessage({ role: "user", content: [
        { type: "text", text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
        ...framed(idxs),
        { type: "text", text: SUMMARY_CLOSE_TAG },
      ] }) || 0);

      // the invariant, self-enforced (the engine throws on violation): drop the
      // lowest-confidence kept message until strictly smaller, else hand back to stock
      let droppedByLoop = 0;
      while (estimate([...keep]) >= shadowed && keep.size > 0) {
        // shed lowest confidence first; among equals, the LARGEST message
        // (most reclaim per shed, and confidence could not separate them)
        let worst = -1, worstKey = null;
        for (const i of keep) {
          const key = [(pOf(i) ?? 1), -flat[i].text.length];   // asc confidence, desc size
          if (worstKey === null || key < worstKey) { worstKey = key; worst = i; }
        }
        keep.delete(worst); droppedByLoop += 1;
      }
      if (estimate([...keep]) >= shadowed || keep.size === 0) {
        if (config.ledger.path !== "off") {
          try { appendLedger(config.ledger.path, { kind: "engine", at: new Date().toISOString(), v: 1,
            session: agent?.session?.id ?? "unknown", outcome: "stock-fallback-shrink", messages: messages.length,
            tokensPrefix: prefixSum, tokensTarget: shadowed, judge: { provider: config.judge.provider, latencyMs: judgeMs, questions: questions.length } }); } catch { /* recorder never breaks the turn */ }
        }
        basis.reset(agent?.session);
        return stock(input, agent, signal);          // judgment could not shrink — prose might
      }

      const summary = framed([...keep].sort((a, b) => a - b));
      if (config.ledger.path !== "off") {
        try { appendLedger(config.ledger.path, { kind: "engine", at: new Date().toISOString(), v: 1,
          session: agent?.session?.id ?? "unknown", outcome: "kept-verbatim", messages: messages.length,
          kept: judged.filter((_, i) => keep.has(i)).map((m) => ({ i: judged.indexOf(m), p_keep: pOf(judged.indexOf(m)), fingerprint: m.text.slice(0, 80) })),
          keptCount: keep.size, droppedCount: judged.length - keep.size + droppedByLoop,
          tokensPrefix: prefixSum, tokensTarget: shadowed, tokensFramed: estimate([...keep]),
          judge: { provider: config.judge.provider, model: config.judge.model, latencyMs: judgeMs, questions: questions.length },
          ...(dump ? { shapes: dump } : {}) }); } catch (e) { say(`ledger append failed: ${e.message}`); }
      }
      say(`engine: kept ${keep.size}/${judged.length} message(s) verbatim, attempt ${attempt} (~${prefixSum} prefix -> ~${estimate([...keep])} est. tokens)`);
      lastAnswer.set(agent?.session, input);
      // stock's event record reads provider/model from the result; mirror its
      // shape (found live: extra/absent fields mattered to the summary event)
      return { summary, provider: "dsh-compaction-semantic", model: config.judge.model };
    } catch (err) {
      if (err instanceof JudgeError || err.name === "AbortError" || err.name === "TypeError") breaker.fail();
      say(`engine judgment failed (${err.message}); falling back to the stock summarizer`);
      basis.reset(agent?.session);
      return stock(input, agent, signal);            // fail-closed: prose, never a failed compaction
    }
  };
  engineSvc.__csWrapped = true;
  say(`engine wrap armed: summarize() answers with verbatim keep/drop (provider=${config.judge.provider}, maxMessages=${config.engine.maxMessages})`);
}
