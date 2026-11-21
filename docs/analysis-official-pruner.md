# Deep read: how the official `dsh-compaction-tool-result-pruner` mounts (and where a semantic version plugs in)

> Evidence base: the shipped `@deepseek-ai/dsh@0.2.1-rc.5` npm closure on this
> machine, reverse-read file-by-file (no upstream docs consulted — the code is
> the contract). All `file:line` references resolve inside that closure.
> Date: 2026-11-21. Author: vicfei (window wren-w2, spike #1).

## 0. TL;DR

1. The official pruner is a **Cordis `Service` named `"toolResultPruner"`** —
   194 lines, fully synchronous, no lifecycle wiring of its own. It never hooks
   an event; it sits there and waits to be **called by name**.
2. The caller is `BasicCompactionEngine` (`dsh-compaction-basic`, 1027 lines):
   it resolves `this.ctx.get("toolResultPruner")` — an **optional,
   call-time, name-based service lookup** — on both compaction trigger paths
   (step-boundary pressure and context-overflow recovery). Pruning runs
   **before** the LLM summary; if pruning alone brings the session back under
   threshold, **no summary runs at all**.
3. **Critical constraint discovered:** both call sites invoke
   `prune.pruneSession(session)` **without `await`**, then immediately
   re-measure. The service contract is de-facto *synchronous*. An async
   semantic judge cannot simply shadow the service — it must either stay
   synchronous (no Jev) or hook earlier (see §6, insertion point C).
4. Session mutation is a **replay-safe protocol**: append a
   `compaction/prune` shadow-price event, then append a replacement
   `tool/result` with `surfaceOp: replace` — the log stays append-only, the
   surface is rewritten, the original stays recoverable. A semantic pruner
   reuses this protocol unchanged and changes **only the keep/drop decision**.
5. The content policy is pure character arithmetic: keep `headChars` (4096) +
   a fixed marker + `tailChars` (1024) of anything over `thresholdChars`
   (8192), sliced by Unicode code points. This is precisely the "amputate the
   contiguous middle, ignore relevance" behavior the viral compaction work
   (`fast-jev-compaction`, 8k★ in one day on its original repo) exists to
   replace.

## 1. Package graph and responsibilities

| Package | Size | Role |
|---|---|---|
| `@deepseek-ai/dsh-compaction` | 175 lines | The contract: `CompactionEngine` base **Service named `"compaction"`** (`dsh-compaction/lib/index.js:171`), compaction event vocabulary, replay/validation helpers. No strategy. |
| `@deepseek-ai/dsh-compaction-basic` | 1027 lines | The shipped strategy: `BasicCompactionEngine extends CompactionEngine`, `static inject = ["llm", "tokenMeter", "sessions"]` (`:801`). Config: `thresholdRatio / headroomTokens / retainRatio / retainTokens / summarizationProvider / summarizationModel / maxTokens / compactionRetries / maxOverflowRetries / modelPolicies / auto`. Doc comment: **"`summarize()` is the sole subclass customization hook"** (`:795`). |
| `@deepseek-ai/dsh-compaction-tool-result-pruner` | 194 lines | `ToolResultPruner extends Service`, **registered name `"toolResultPruner"`**, `static inject = ["tokenMeter"]`, config `thresholdChars / headChars / tailChars`. Description: *"Replay-safe model-free head/middle/tail pruning for tool-result surface nodes."* |

The pruner's `peerDependencies` include `dsh-compaction` (the contract), but
the dependency direction at runtime is inverted: the **engine** consumes the
**pruner**, optionally, by name.

## 2. Trigger paths (who calls `pruneSession`, when)

Both live in `BasicCompactionEngine.compactIfNeeded(agent, trigger, signal)`
(`dsh-compaction-basic/lib/index.js:910-960`):

### Path A — step-boundary pressure (auto compaction)

Registered at `ctx.on("agent/pre-step", …)` (`:839`): between agent steps,

1. `meter.measure(session)` — estimate total tokens.
2. If below `thresholdTokens` (derived from the model's context window,
   `headroomTokens`, reserved completion) → **return, nothing happens**.
3. `const prune = this.ctx.get("toolResultPruner")` (`:926`) — **optional**;
   `undefined` if no such service is loaded.
4. If present: `prune.pruneSession(agent.session)` (`:943`) → **re-measure**.
   If now below threshold → **done: no LLM summary this round**.
5. Still above → `selectCompactableRange` (respects `retainTokens` tail and
   tool-call/result pairing balance, `:420-436`) → `compactRegion` → LLM
   summary, retried up to `compactionRetries`.

Step-pressure failures are caught and logged
(`"step compaction failed: …; continuing the turn"`, `:851`) — compaction is
best-effort on this path; the turn proceeds.

### Path B — context-overflow recovery

Hooked at `ctx.on("agent/request-error")` (`:861`) for provider-confirmed
overflow. Bypasses threshold/tail policies: prune first (`:929`), re-measure,
then force **one** `compactRegion` regardless.

### Order-of-operations consequence

**Pruning precedes and can replace summarization.** Every token reclaimed by
the pruner is a token the summarizer doesn't have to launder into prose. A
better pruner directly reduces how often the LLM-summary compaction runs —
the exact intervention the mass-pain evidence points at.

## 3. The replay-safe mutation protocol (what a replacement must honor)

`pruneSession` (`dsh-compaction-tool-result-pruner/lib/index.js:137-191`),
per over-budget `tool/result` event on `session.surface.nodes`:

```js
session.append("compaction/prune", {
    shadowedRange: { start: seq, end: seq },
    shadowedSeqs: [seq],
    shadowedTokenCount: this.ctx.tokenMeter.estimateMessage(original),
});                                     // ① shadow-price FIRST
const replacement = session.append("tool/result", {
    ...event.data, message: freezeMessage({ ...original, content }),
}, {
    surfaceOp: { op: "replace", startSeq: seq, endSeq: seq },
    sourceEventSeqs: [seq],             // ② recoverable original
});
```

Invariants worth keeping verbatim:

- **①-before-②**: the shadow event precedes the replacement so pure consumers
  can subtract the shadowed tokens without per-node state.
- **Append-only log, rewritten surface**: replay can recover the original via
  `sourceEventSeqs`; "replacement must be smaller and within threshold" is
  asserted (`:122`).
- Failures of `pruneSession` on path A degrade to a warn + turn continues; a
  replacement must be **no more brittle than the official one** (fail-closed
  to the deterministic policy, never throw new classes of errors upward).

## 4. The deterministic content policy (the thing we replace)

`pruneContent` (`:91-124`): count Unicode code points of `text` blocks only
(non-text passes through in order); if total > `thresholdChars`, keep the
first `headChars` + `"\n\n[... tool result middle pruned ...]\n\n"` + the last
`tailChars`. Slicing is surrogate-safe. Zero context, zero judgment: a
10 KB tool result keeps its first 4 KB and last 1 KB whether the task cares
about the head, the middle, or nothing.

## 5. The `summarize()` side (for completeness)

`compactRegion` brackets the span with `compaction/start` (`:469`) and
`compaction/end` (`:484`), asserts surface stability (whole-surface or
selected-span strict equality, `:611-630`), then `commitCompactionBody`
appends a `compaction/summary` + a `user/message` checkpoint whose framed
token count must be **strictly smaller** than the shadowed span (`:600`).
The summary is LLM-generated prose — the second half of the mass pain
(verbatim loss). Replacing it means replacing the whole engine service, a
much larger contract (§6-D).

## 6. Insertion points for a semantic pruner, ranked

**A. Same-name service replacement (obvious, blocked by sync).** Define a
`Service` named `"toolResultPruner"` implementing
`{ measureContent, pruneContent, pruneSession }`, don't load the official
package. Engine picks it up at call time. **Blocked in the naive form**: both
call sites don't `await` (`:929`, `:943`), so an async judgment floats and the
immediate re-measure races it.

**B. Sync-only semantic (weak).** Keep everything synchronous: no network —
at best heuristic relevance (recency, tool type, section markers). This is
"smarter determinism", not judgment. Not the product.

**C. Hook earlier with listener priority (recommended v1 shape).** Register
our own `ctx.on("agent/pre-step")` listener **ordered before** the engine's**
(dsh's event emitter supports listener priority — exact knob to confirm in
spike #2). Our listener runs the async judge batch (one request: shared
state = recent user asks + plan; one typed question per tool-result span —
the `jev-test-filter` request shape, ~300 ms), commits keep/drop rewrites
**using the official protocol of §3**, and returns. By the time the engine's
own listener measures, the surface is already semantically pruned; the
official deterministic pruner (if still loaded) then only catches whatever
remains over `thresholdChars` — harmless second line. Fail-closed: judge
unavailable/timeout/error → skip entirely (official behavior unchanged).
**The §3 protocol is the only contract we borrow; no engine code.**

**D. Replace the `"compaction"` engine service (v2).** The engine itself is a
name-resolved Service — a keep/drop engine that replaces LLM summarization
with per-message keep/drop (the full `fast-jev-compaction` thesis) subclasses
`BasicCompactionEngine`, overrides `summarize()` (the designed sole hook) or
`compactRegion` internals. Large surface: bracketing, stability assertions,
checkpoint framing, retry policy. v2, only after v1 proves the request shape
on real sessions.

## 7. Config surface for the semantic version (draft)

```yaml
- id: dsh-compaction-semantic
  config:
    thresholdChars: 8192      # same default as official; below this we never judge
    minSavingsChars: 2048     # don't burn a judgment request on small wins
    judge:
      provider: typesafe      # typesafe | openrouter | llm-fallback | off
      model: jev-latest
      timeoutMs: 2500         # over this → fail-closed skip
      batchSpans: true        # one request for all over-budget results
    keep:
      scatter: true           # keep scattered relevant spans, not contiguous ends
      verbatim: true          # never rewrite kept text
```

## 8. Open questions for spike #2 (hello-world probe, no semantics)

1. **Listener priority**: confirm the exact dsh/cordis ordering knob that
   puts our `agent/pre-step` listener ahead of the engine's (registered at
   `dsh-compaction-basic:839`), and that an async listener correctly delays
   the next listener (cordis `next()` semantics — the engine's listener takes
   `(…, next)`, so a prior async listener that awaits before calling `next()`
   should hold the chain; verify).
2. **Service shadowing legality**: what happens today if two services named
   `toolResultPruner` are both loaded (priority? last-wins? error?) — decides
   whether deployment shape A is usable as fallback.
3. **Activation**: is the official pruner on by default in a stock profile
   (bundles list), or opt-in? Affects our install instructions.
4. **Session access at pre-step**: the exact surface shape for "recent user
   asks + plan" (the judgment `state`) from `agent.session` inside the
   pre-step hook.

## 9. Why this is the right first product (mass-pain evidence recap)

- `fast-jev-compaction` original repo: **8,002★ in one day** (2026-09-17→18,
  then dormant; maintained fork carries 236 weekly downloads) — the loudest
  pain signal in the entire cross-harness JEV dataset.
- The pain is harness-universal (every long-session agent user), and DSH's
  shipped answer is *character arithmetic* — the exact policy the viral work
  explicitly criticizes ("amputate the middle by age", "keep scattered
  relevant spans, retain verbatim").
- DSH leaves the slot open on purpose: the pruner is a name-resolved optional
   service, and the engine already prefers pruning over summarizing.

## Colophon

Clean-room reverse read of shipped code; no upstream code copied. The
borrowed elements (§3 protocol, config names) are API-level facts required
for interoperability. This document is the spike-#1 deliverable of
[vicfei/dsh-compaction-semantic](https://github.com/vicfei/dsh-compaction-semantic) — product charter in the [README](../README.md), plan in the [ROADMAP](../ROADMAP.md).
