// Plugin entry (design §2): ONE prepend listener on agent/pre-step; no
// services defined; holds the chain only for one batched judge request and
// only when over-budget candidates exist. Fail-closed everywhere — the
// turn always proceeds.

import { resolveConfig } from "./config.js";
import { selectCandidates } from "./candidates.js";
import { buildState } from "./state.js";
import { questionsFor, judgeOnce, makeBreaker, JudgeError } from "./judge.js";
import { rewriteCandidate } from "./rewrite.js";

export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig);
  const breaker = makeBreaker(config.judge.maxConsecutiveFailures);

  ctx.on("agent/pre-step", async (payload, next) => {
    try {
      const session = payload?.agent?.session;
      if (!session?.surface?.nodes || config.judge.provider === "off" || breaker.tripped) return next();

      const candidates = selectCandidates({ session, config });
      if (candidates.length === 0) return next();                    // zero-overhead common case

      // attach spans + gather questions for ONE batched request
      const state = buildState({ messages: payload.messages, session, config });
      const questions = questionsFor(candidates.map((c) => ({
        ...c, parts: spanParts(session, c, config),
      })));
      if (questions.length === 0) return next();

      const verdicts = await judgeOnce({ config, state, questions });
      breaker.ok();

      let charsRemoved = 0, prunedCount = 0;
      for (const c of candidates) {
        try {
          const parts = spanParts(session, c, config);
          const filtered = new Map([...verdicts].filter(([id]) => id.startsWith(`${c.seq}:`)));
          const r = rewriteCandidate({ session, candidate: c, verdicts: filtered, config, tokenMeter: ctx.tokenMeter, parts });
          if (r?.pruned) { prunedCount++; charsRemoved += r.charsBefore - r.charsAfter; }
        } catch (err) {                                              // per-result isolation
          ctx.logger?.warn?.(`dsh-compaction-semantic: rewrite failed for seq ${c.seq}: ${err.message}; keeping original`);
        }
      }
      if (prunedCount) ctx.logger?.info?.(`dsh-compaction-semantic: pruned ${prunedCount} result(s), ~${charsRemoved} chars reclaimed before engine compaction`);
      return next();                                                 // engine sees the pruned surface
    } catch (err) {
      if (err instanceof JudgeError || err.name === "AbortError" || err.name === "TypeError") {
        breaker.fail();
        const level = breaker.tripped ? "warn" : "debug";
        ctx.logger?.[level]?.(`dsh-compaction-semantic: judge unavailable (${err.message})${breaker.tripped ? " — inert for the rest of the session (fail-closed)" : ""}`);
      } else {
        ctx.logger?.warn?.(`dsh-compaction-semantic: pre-step error (${err.message}); continuing the turn`);
      }
      return next();                                                 // NEVER block a turn
    }
  }, { prepend: true });

  ctx.logger?.info?.(`dsh-compaction-semantic: semantic pruner armed (provider=${config.judge.provider}, threshold=${config.thresholdChars})`);
}

// span parts are recomputed identically here and in the rewriter (cheap, pure)
import { splitBlocks } from "./spans.js";
function spanParts(session, candidate, config) {
  const message = session.deriveEventMessage(candidate.event);
  return splitBlocks(message.content, config.spanTargetChars);
}
