// Candidate selection (design §4): surface walk → over-budget tool/results
// with pins (newest nodes, neverPruneTools) and per-step cap. Text measured
// in Unicode code points (official pruner convention).

const codePoints = (s) => Array.from(s).length;

export function textChars(blocks) {
  let n = 0;
  for (const b of blocks || []) if (b?.type === "text") n += codePoints(b.text);
  return n;
}

export function selectCandidates({ session, config, now = () => new Date() }) {
  const nodes = [...(session.surface?.nodes ?? [])];
  const recentFrom = Math.max(0, nodes.length - config.preserveRecentNodes);
  const out = [];
  for (let i = 0; i < nodes.length; i++) {
    const event = session.eventAt(nodes[i]);
    if (event?.type !== "tool/result") continue;
    if (i >= recentFrom) continue;                                    // pin: newest N nodes
    const tool = event.data?.message?.source?.tool ?? event.data?.tool;
    if (config.neverPruneTools.includes(tool)) continue;              // pin: exempt tools
    const blocks = event.data?.message?.content ?? [];
    const chars = textChars(blocks);
    if (chars <= config.thresholdChars) continue;                     // under budget
    if (chars - config.thresholdChars < config.minSavingsChars) continue; // never judge small wins
    out.push({ seq: nodes[i], event, chars, tool });
    if (out.length >= config.maxJudgeResultsPerStep) break;           // graceful tiering
  }
  return out;
}
