// Rewriter (design §8): apply verdicts, assert invariants, commit through
// the official replay-safe protocol — shadow-price event FIRST, then the
// replacement tool/result with surfaceOp replace + sourceEventSeqs.

import { splitBlocks, applyVerdicts } from "./spans.js";
import { textChars } from "./candidates.js";

export const PRUNE_EVENT = "compaction/prune";

export function rewriteCandidate({ session, candidate, verdicts, config, tokenMeter }) {
  const message = session.deriveEventMessage(candidate.event);
  const parts = splitBlocks(message.content, config.spanTargetChars);
  const keepFor = (p) => {
    const p_keep = verdicts.get(`${candidate.seq}:${p.blockIndex}:${p.index}`);
    if (p_keep === undefined) return true;                          // unjudged → keep (conservative)
    return p_keep >= config.dropThreshold;                          // keep-on-doubt
  };
  const content = applyVerdicts(message.content, parts, keepFor, config.thresholdChars, config.dropThreshold);
  if (content === null) return { pruned: false };

  // invariants (official pruner's own rules): smaller + within threshold
  const before = textChars(message.content), after = textChars(content);
  if (after >= before || after > config.thresholdChars) return { pruned: false, invariantViolation: true };

  // protocol: ① shadow-price FIRST ② replacement with surfaceOp replace
  const estimate = tokenMeter?.estimateMessage?.(message) ?? Math.ceil(before / 4);
  session.append(PRUNE_EVENT, {
    shadowedRange: { start: candidate.seq, end: candidate.seq },
    shadowedSeqs: [candidate.seq],
    shadowedTokenCount: estimate,
  });
  const replacement = session.append("tool/result", {
    ...candidate.event.data,
    message: freeze({ ...message, content }),
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
