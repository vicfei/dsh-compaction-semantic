// Compaction ledger (issue #7, V2 instrumentation-first): every judged
// keep/drop decision as ONE append-only ndjson event. The trust surface
// ("what did you delete from my context?") and the A/B instrument both read
// here — the ledger ships BEFORE the keep/drop engine on purpose.
//
// Silence is meaningful: no event = no judgment happened (judge off, breaker
// tripped, zero candidates) — stock equivalence is proven by absence, not by
// a "did nothing" record. Failures that abort a turn never reach a decision
// and so never write.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export const DEFAULT_LEDGER_PATH = () => path.join(os.homedir(), ".dsh", "compaction-ledger.ndjson");

export function appendLedger(ledgerPath, entry) {
  const file = ledgerPath && ledgerPath !== "off" ? ledgerPath : DEFAULT_LEDGER_PATH();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
  return file;
}

export function readLedger(ledgerPath) {
  const file = ledgerPath && ledgerPath !== "off" ? ledgerPath : DEFAULT_LEDGER_PATH();
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

// The decision trail for one surface node, as a human-readable block.
export function why(ledgerPath, seq) {
  const hits = readLedger(ledgerPath).filter((e) => String(e.seq) === String(seq));
  if (hits.length === 0) {
    return `no ledger decisions for seq ${seq} — either nothing was judged, or the judge was off (absence = stock behavior)`;
  }
  return hits.map((e) => {
    if (e.kind === "engine") {
      const lines = [
        `## engine decision · ${e.at} · session ${e.session} · outcome ${e.outcome}`,
        `judge ${e.judge.provider}/${e.judge.model ?? "?"} · ${e.judge.questions} message(s) in ${e.judge.latencyMs}ms`,
        e.outcome === "kept-verbatim"
          ? `messages ${e.messages} · kept ${e.keptCount} · dropped ${e.droppedCount} · est. tokens ${e.tokensPrefix} prefix, target ${e.tokensTarget}, framed ${e.tokensFramed}`
          : `messages ${e.messages} · prefix ${e.tokensPrefix} est. tokens, target ${e.tokensTarget} (stock prose took over)`,
      ];
      if (e.kept) lines.push(...e.kept.map((k) => `  KEEP msg[${k.i}] p_keep=${k.p_keep} "${k.fingerprint}…"`));
      return lines.join("\n");
    }
    const lines = [
      `## seq ${e.seq} · ${e.at} · session ${e.session} · tool ${e.tool ?? "?"}`,
      `judge ${e.judge.provider}/${e.judge.model} · ${e.judge.questions} span(s) in ${e.judge.latencyMs}ms · committed=${e.committed}${e.invariantViolation ? " (invariant violation — kept original)" : ""}`,
      e.committed ? `chars ${e.charsBefore} -> ${e.charsAfter}` : `chars ${e.charsBefore} (unchanged)`,
      "spans:",
      ...e.spans.map((s) => `  ${s.kept ? "KEEP" : "DROP"} ${s.id} p_keep=${s.p_keep}`),
    ];
    return lines.join("\n");
  }).join("\n\n");
}
