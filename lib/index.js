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
function say(msg) {
  try { process.stderr.write(`dsh-compaction-semantic: ${msg}\n`); } catch { /* stderr closed — nothing to do */ }
}
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
        ctx.logger?.warn?.(`dsh-compaction-semantic: pre-step error (${err.message}); continuing the turn`);
      }
      return next();                                                 // NEVER block a turn
    }
  }, { prepend: true });

  say(`semantic pruner armed (provider=${config.judge.provider}, threshold=${config.thresholdChars})`);   // the mount proof — one line, every boot
  ctx.logger?.info?.(`dsh-compaction-semantic: semantic pruner armed (provider=${config.judge.provider}, threshold=${config.thresholdChars})`);
}

// span parts are recomputed identically here and in the rewriter (cheap, pure)
import { splitBlocks } from "./spans.js";
function spanParts(session, candidate, config) {
  const message = session.deriveEventMessage(candidate.event);
  return splitBlocks(message.content, config.spanTargetChars);
}
