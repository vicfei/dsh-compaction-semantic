// Rewriter (design §8): apply verdicts, assert invariants, commit through
// the official replay-safe protocol — shadow-price event FIRST, then the
// replacement tool/result with surfaceOp replace + sourceEventSeqs.

import { splitBlocks, applyVerdicts } from "./spans.js";
import { textChars } from "./candidates.js";

export const PRUNE_EVENT = "compaction/prune";

export function rewriteCandidate({ session, candidate, verdicts, config, tokenMeter }) {
  // host 0.2.2: deriveEventMessage's content can sit elsewhere — fall back to
  // the event's own message blocks (same fallback as spanParts in index.js)
  let message = null;
  try { message = session.deriveEventMessage?.(candidate.event); } catch { /* best-effort */ }
  const blocks = message?.content ?? candidate.event?.data?.message?.content ?? [];
  const parts = splitBlocks(blocks, config.spanTargetChars);
  const keepFor = (p) => {
    const p_keep = verdicts.get(`${candidate.seq}:${p.blockIndex}:${p.index}`);
    if (p_keep === undefined) return true;                          // unjudged → keep (conservative)
    return p_keep >= config.dropThreshold;                          // keep-on-doubt
  };
  const content = applyVerdicts(blocks, parts, keepFor, config.thresholdChars, config.dropThreshold);
  if (content === null) return { pruned: false };

  // invariant (the one that matters): strictly smaller. Reaching the threshold
  // is NOT this pruner's job — judgment keeps load-bearing content, and what
  // stays over budget is the engine's to summarize (prune runs before it).
  // Found live 2026-11-26: the old `after > thresholdChars → refuse` rule made
  // every partial-drop refuse silently — the deterministic pruner's contract
  // applied to a judgment-driven one.
  const before = textChars(blocks), after = textChars(content);
  if (after >= before) return { pruned: false, invariantViolation: true };

  // protocol: ① shadow-price FIRST ② replacement with surfaceOp replace
  const estimate = tokenMeter?.estimateMessage?.(message ?? candidate.event?.data?.message) ?? Math.ceil(before / 4);
  session.append(PRUNE_EVENT, {
    shadowedRange: { start: candidate.seq, end: candidate.seq },
    shadowedSeqs: [candidate.seq],
    shadowedTokenCount: estimate,
  });
  const replacement = session.append("tool/result", {
    ...candidate.event.data,
    message: freeze({ ...(message ?? candidate.event?.data?.message ?? {}), content }),
  }, {
    surfaceOp: { op: "replace", startSeq: candidate.seq, endSeq: candidate.seq },
    sourceEventSeqs: [candidate.seq],
  });
  return { pruned: true, originalSeq: candidate.seq, replacementSeq: replacement.seq, charsBefore: before, charsAfter: after };
}

const frozen = new WeakSet();
function freeze(message) {
  if (!frozen.has(message)) Object.freeze(message);
  Object.values(message).forEach((v) => { if (v && typeof v === "object") freeze(v); });
  frozen.add(message);
  return message;
}
