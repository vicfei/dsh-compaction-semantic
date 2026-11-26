// Plugin entry (design §2): ONE prepend listener on agent/pre-step; no
// services defined; holds the chain only for one batched judge request and
// only when over-budget candidates exist. Fail-closed everywhere — the
// turn always proceeds.

import { resolveConfig } from "./config.js";

// Operator visibility (issue #4): ctx.logger feeds a structured buffer that
// never reaches the terminal, so the mount left no trace an operator could
// see. These one-liners go to stderr — same channel the host itself uses for
// boot warnings. One line at arm, one per prune, one per fail-closed
// transition; nothing else.
function sessionIdOf(payload) {
  // best-effort across host shapes; "unknown" is honest when absent
  return payload?.agent?.session?.id ?? payload?.agent?.sessionId ?? payload?.agent?.id
    ?? payload?.agent?.session?.header?.id ?? "unknown";
}

function say(msg) {
  try { process.stderr.write(`dsh-compaction-semantic: ${msg}\n`); } catch { /* stderr closed — nothing to do */ }
}
import { selectCandidates } from "./candidates.js";
import { buildState } from "./state.js";
import { questionsFor, judgeOnce, makeBreaker, JudgeError } from "./judge.js";
import { appendLedger } from "./ledger.js";
import { wrapEngine } from "./engine.js";
import { rewriteCandidate } from "./rewrite.js";

export const inject = ["tokenMeter", "compaction"];   // tokenMeter: rewrite() reports savings through it;
                                                      // compaction: the V2 engine wrap target (ctx.compaction)
                                                      // — cordis refuses both lookups without this declaration

export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig);
  const breaker = makeBreaker(config.judge.maxConsecutiveFailures);

  ctx.on("agent/pre-step", async (payload, next) => {
    try {
      const session = payload?.agent?.session;
      if (!session?.surface?.nodes || config.judge.provider === "off" || breaker.tripped) return next();

      let candidates = [];
      candidates = selectCandidates({ session, config });
      if (candidates.length === 0) return next();                    // zero-overhead common case

      // attach spans + gather questions for ONE batched request
      const state = buildState({ messages: payload.messages, session, config });
      const questions = questionsFor(candidates.map((c) => ({
        ...c, parts: spanParts(session, c, config),
      })));
      if (questions.length === 0) return next();

      const judgeT0 = Date.now();
      const verdicts = await judgeOnce({ config, state, questions });
      const judgeMs = Date.now() - judgeT0;
      breaker.ok();

      let charsRemoved = 0, prunedCount = 0;
      for (const c of candidates) {
        try {
          const parts = spanParts(session, c, config);
          const filtered = new Map([...verdicts].filter(([id]) => id.startsWith(`${c.seq}:`)));
          const r = rewriteCandidate({ session, candidate: c, verdicts: filtered, config, tokenMeter: ctx.tokenMeter, parts });
          if (config.ledger.path !== "off") {                              // the decision is evidence — record even an uncommitted one
            try {
              appendLedger(config.ledger.path, {
                at: new Date().toISOString(), v: 1, session: sessionIdOf(payload),
                seq: c.seq, tool: c.tool ?? null,
                spans: [...filtered].map(([id, p_keep]) => ({ id, p_keep, kept: p_keep >= config.dropThreshold })),
                committed: r?.pruned === true, invariantViolation: r?.invariantViolation === true,
                charsBefore: r?.charsBefore ?? c.chars ?? null, charsAfter: r?.charsAfter ?? null,
                judge: { provider: config.judge.provider, model: config.judge.model,
                         latencyMs: judgeMs, questions: questions.length },
              });
            } catch (err) { say(`ledger append failed: ${err.message}`); }   // never break the turn over the recorder
          }
          if (r?.pruned) { prunedCount++; charsRemoved += r.charsBefore - r.charsAfter; }
        } catch (err) {                                              // per-result isolation
          say(`rewrite failed for seq ${c.seq}: ${err.message}; keeping original`);   // never silent — this is the drop path
          ctx.logger?.warn?.(`dsh-compaction-semantic: rewrite failed for seq ${c.seq}: ${err.message}; keeping original`);
        }
      }
      if (prunedCount) {
        const m = `pruned ${prunedCount} result(s), ~${charsRemoved} chars reclaimed before engine compaction`;
        say(m);
        ctx.logger?.info?.(`dsh-compaction-semantic: ${m}`);
      }
      return next();                                                 // engine sees the pruned surface
    } catch (err) {
      if (err instanceof JudgeError || err.name === "AbortError" || err.name === "TypeError") {
        breaker.fail();
        const m = `judge unavailable (${err.message})${breaker.tripped ? " — inert for the rest of the session (fail-closed)" : ""}`;
        if (breaker.tripped) say(m);                                  // the fail-closed transition is operator-visible
        ctx.logger?.[breaker.tripped ? "warn" : "debug"]?.(`dsh-compaction-semantic: ${m}`);
      } else {
        say(`pre-step error (${err.message}); continuing the turn`);   // unexpected = a bug in us — visible, never silent
        ctx.logger?.warn?.(`dsh-compaction-semantic: pre-step error (${err.message}); continuing the turn`);
      }
      return next();                                                 // NEVER block a turn
    }
  }, { prepend: true });

  say(`semantic pruner armed (provider=${config.judge.provider}, threshold=${config.thresholdChars})`);   // the mount proof — one line, every boot
  wrapEngine(ctx, config, breaker, say);   // V2: summarize() answers with verbatim keep/drop (fails closed to stock)
  ctx.logger?.info?.(`dsh-compaction-semantic: semantic pruner armed (provider=${config.judge.provider}, threshold=${config.thresholdChars})`);
}

// span parts are recomputed identically here and in the rewriter (cheap, pure)
import { splitBlocks } from "./spans.js";
function spanParts(session, candidate, config) {
  // 0.2.1-rc.5 shaped deriveEventMessage(event) → {content: blocks}; on host
  // 0.2.2 the derived message can carry its content elsewhere — fall back to
  // the event's own message (same shape the candidate walk already read).
  let message = null;
  try { message = session.deriveEventMessage?.(candidate.event); } catch { /* derive is best-effort */ }
  const blocks = message?.content ?? candidate.event?.data?.message?.content ?? [];
  return splitBlocks(blocks, config.spanTargetChars);
}
