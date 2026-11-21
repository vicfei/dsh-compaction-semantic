# dsh-compaction-semantic V1 — design

> Decision-complete design for the semantic tool-result pruner. Every open
> question from [S1](analysis-official-pruner.md),
> [S1b](analysis-cc-codex-compaction.md) and
> [spike #2](spike2-four-questions.md) is resolved here with rationale.
> Status: awaiting owner review; implementation issues open on approval.
> Date: 2026-11-21.

## 1. Goal / non-goals

**Goal**: replace the *decision* in tool-result pruning with calibrated
judgment — kept spans stay **verbatim**, drops are **scattered** (relevance
lives in the middle too) — mounted with zero flags, zero uninstalls, never
more brittle than stock.

**Non-goals (V1)**: replacing the LLM summarizer (that is V2's
`summarize()` engine hook); touching any event class other than
`tool/result`; judging content the host re-injects anyway (the survival
layer, S1b §3.4); metrics dashboards.

## 2. Architecture

```
DSH agent loop — preStep()
  └─ agent/pre-step  (awaited waterfall, dsh-agent-loop:909)
      ├─ [1st, prepend:true]  dsh-compaction-semantic
      │     guards → candidates → state → judge (1 batched request)
      │     → rewrite via official protocol → next()
      └─ [inner] compaction-basic pressure listener
            measures the ALREADY-pruned surface → official deterministic
            pruner catches leftovers → LLM summary only if still over
```

Mount is exactly the spike-#2-confirmed shape:
`ctx.on("agent/pre-step", onPreStep, { prepend: true })`. We define **no
service** at all (the same-name registration class of failure is
structurally impossible for us), touch no engine internals, and hold the
chain only for the duration of one judge request (~≤2.5 s, and only when
over-budget candidates exist — zero overhead otherwise).

## 3. Module layout (TypeScript, Node ≥ 22)

```
src/
  index.ts        entry: listener registration, config schema (schemastery)
  config.ts       schema + resolution (unknown-key rejection, official-pruner style)
  candidates.ts   surface walk → over-budget tool/results + pins
  spans.ts        text → judgment spans (paragraph-bounded, merged, capped)
  state.ts        judgment state builder (current ask + recent asks + goal,
                  staged truncation ≤ maxStateTokens)
  judge.ts        one batched request; strict response validation; circuit breaker
  providers/      typesafe.ts | openrouter.ts | openai.ts | off.ts
  rewrite.ts      verdict application: scattered keep, verbatim, invariants
  protocol.ts     session.append wrappers — byte-for-byte the official shapes
tests/            hermetic (node:test; no network, no live DSH)
```

## 4. Candidate selection (`candidates.ts`)

Walk `session.surface.nodes` → `eventAt(seq)`; a `tool/result` is a
**candidate** iff (Unicode code points, text blocks only):

1. content > `thresholdChars` (**8192 — same default as the official
   pruner**, so our layer and the official layer agree on what counts as
   over-budget);
2. best-case savings > `minSavingsChars` (**2048** — never spend a judgment
   request on small wins);
3. not **pinned**:
   - within the newest `preserveRecentNodes` surface nodes (**40** — node-count
     anchor, not turn-anchored: no turn parsing dependency in V1; tunable);
   - tool name in `neverPruneTools` (user list — the CC microcompaction
     MCP-state bug lesson: tools whose results act as durable state get an
     explicit exemption);
4. per-step cap: at most `maxJudgeResultsPerStep` (**8**) results judged per
   step — the rest simply stay for the official deterministic pass
   (graceful tiering, no cliff).

Note: unlike Claude Code there is no "first message" to pin — the system
prompt / user seed are not `tool/result` events on the surface.

## 5. Span splitting (`spans.ts`)

Each candidate's text blocks split into **spans**:

- boundaries at blank-line groups (paragraph-ish); adjacent segments merge
  until ≈ `spanTargetChars` (**1200**); hard max 2000 (never split
  mid-paragraph unless a single paragraph exceeds the max);
- non-text blocks (images, structured blocks) pass through **untouched and
  unjudged** — conservative default: if we can't read it, we keep it.

Judgment unit = span. Verdict unit = span. Kept span text is **byte-equal**
to the original (verbatim is the product promise; rewriting is
summarization, which is the thing we replace).

## 6. Judgment state (`state.ts`)

One shared state per request (the `jev-test-filter` request shape — proven
by the only shipped semantic-compaction implementation):

- `current_ask`: the pre-step payload's `messages` (claimed inbox — the NEW
  user input this step is about; first-class, free);
- `recent_asks`: last `recentAsks` (**5**) `user/message` events from the
  surface walk;
- `goal`: latest `goal/change` payload text (surface events, not the
  `goals` service — replay-safe and dependency-free; service switch is a
  V1.1 option if event payloads prove too thin);
- staged truncation to fit `maxStateTokens` (**25k**, fast-jev-compaction's
  battle-tested budget): per-item head+tail abridge → oldest-first collapse
  to one-line notes (`t12 Read file_path=src/a.ts → ok 480ch`). Budget is
  soft; counting is chars/4 (documented imprecision — tokenMeter prices
  messages, not arbitrary strings).

The spans are NOT in the state — they are the questions.

## 7. Judge (`judge.ts` + `providers/`)

**One batched request per step**: every span of every candidate in a single
call. Questions are typed noul — "Keep this span in context for the current
task?" — one per span, sharing the state above.

Providers:

| id | endpoint | notes |
|---|---|---|
| `typesafe` | `POST {baseUrl\|https://api.typesafe.ai}/v1/systemone`, model `jev-latest` | native typed protocol |
| `openrouter` | `https://openrouter.ai/api/alpha/decisions`, model `typesafe/jev-1.13` | same typed protocol, OpenRouter key only |
| `openai` | any OpenAI-compatible `baseUrl` + model | JSON-mode prompt: output `{span_id, keep, p_keep}[]`, temperature 0 — the air-gapped path (intranet DeepSeek deployments, family requirement) |
| `off` | — | plugin inert; listener returns after the candidate check |

**Decision rule — keep on doubt.** Drop a span iff `P(keep) <
dropThreshold` (**0.25**). The asymmetry is deliberate: over-keeping costs
chars the official deterministic pruner trims anyway (safety net exists);
wrongly dropping load-bearing info is the catastrophic direction
(recoverable out-of-band via `sourceEventSeqs`, but gone from context).

**Response validation is strict**: verdict count must equal span count,
ids must match, probabilities in range — any mismatch discards the whole
response (treated as failure). Never act on partial judgments.

**Discipline**: `judge.timeoutMs` (**2500**, AbortController); key via the
DSH **credential store** (`ctx.credentials`, referenced by name — never env
or yml, family + ecosystem discipline); failures trip a session circuit
breaker (`maxConsecutiveFailures` **3** → inert for the rest of the
session, one warn log) so a dead provider never becomes a per-step tax.

## 8. Rewrite (`rewrite.ts` + `protocol.ts`)

Per candidate with ≥1 dropped span, apply verdicts and commit through the
**official protocol, byte-for-byte** (S1 §3 — the only contract we borrow):

1. build pruned content: kept spans verbatim; each **contiguous dropped
   run** collapses to one marker
   `"\n\n[... semantic pruned: N chars (dsh-compaction-semantic) ...]\n\n"`
   (one marker per run, official marker pattern, in-band audit trail that
   names the pruner);
2. invariants asserted before commit (official pruner's own rules):
   replacement is smaller, text code-points within `thresholdChars` — any
   violation discards that result's rewrite (keep original), log, continue;
3. `session.append("compaction/prune", { shadowedRange, shadowedSeqs,
   shadowedTokenCount: tokenMeter.estimateMessage(original) })` **first**;
4. `session.append("tool/result", { …event.data, message:
   freezeMessage({…original, content}) }, { surfaceOp: { op: "replace", …
   }, sourceEventSeqs: [seq] })` second.

These are plain session mutations exactly like the official pruner's — no
`compaction/start`/`end` bracket is created, so the engine's
"active compaction" assertions are untouched. (Flagged as a
live-smoke must-verify anyway — hello-world smoke confirms no bracket
interference.)

## 9. Config surface (cordis.patch.yml)

```yaml
- id: dsh-compaction-semantic
  config:
    thresholdChars: 8192
    minSavingsChars: 2048
    preserveRecentNodes: 40
    maxJudgeResultsPerStep: 8
    spanTargetChars: 1200
    dropThreshold: 0.25
    neverPruneTools: []
    state: { maxStateTokens: 25000, recentAsks: 5 }
    judge:
      provider: typesafe      # typesafe | openrouter | openai | off
      model: jev-latest
      baseUrl: ""
      apiKeyCredential: ""    # DSH credential-store reference
      timeoutMs: 2500
      maxConsecutiveFailures: 3
```

Unknown keys rejected at load (official-pruner convention); bounds
validated fail-fast. Defaults are chosen so that `provider: off` + stock
values degrade to exactly stock behavior.

## 10. Fail-closed matrix

| failure | behavior |
|---|---|
| provider `off` | listener exits after candidate count — zero requests, zero appends |
| no candidates this step | no request (the common case — zero added latency) |
| judge timeout / HTTP error / malformed response | skip step entirely; failure counter++; breaker at 3 → inert for session, one warn |
| verdict/span count or id mismatch | whole response discarded = failure (never partial) |
| rewrite invariant violation | that result keeps its original; log; other results proceed |
| `session.append` throws | abort remaining rewrites this step; log error; **`next()` still called** — never block a turn |
| step abort signal during judge | abandon; `next()` (upstream abort governs) |

Every row: the turn proceeds; official pruner + engine untouched
downstream.

## 11. Test plan

**Hermetic** (node:test, no network, no live DSH):
config matrix; candidate selection (threshold/savings/pins/neverPrune/cap);
span splitting (boundaries/merge/hard-max/non-text passthrough); state
staged truncation order + budget fit; judge contract tests against fake
providers (ok / timeout / malformed / partial); rewriter byte-equality of
kept spans, marker-per-run, invariants; **protocol conformance against a
fake session** (shadow-before-replace ordering, `sourceEventSeqs`,
`surfaceOp` shape); every fail-closed row; breaker state machine.

**Live smoke** (dev box, recorded in PR):
1. hello-world: prepend listener logs payload shape + proves our listener
   logs before the engine's (spike-#2 runtime confirmation);
2. seeded long session, judge = mock provider (deterministic verdicts):
   surface rewritten, engine skips summary, **replay recovers the
   originals** via `sourceEventSeqs`;
3. judge `off`: behavior identical to stock (byte-diff of session logs
   where feasible).

## 12. Packaging

npm `dsh-compaction-semantic` (name locked 0.0.1); TS, ESM, Node ≥ 22,
strict `files` whitelist; no bin. Install docs lead with the **landmine**:
`dsh plugin add` installs but does NOT append to `dsh.profile.bundles` —
the manual bundles step is in the README's first screen (dsh-research
landmine register). MIT, clean-room: no upstream code; the protocol shapes
are API-level facts required for interoperability.

## 13. Work breakdown (issues open on design approval)

1. **PR1** scaffold + config + hello-world prepend listener + live smoke #1
2. **PR2** candidates + spans + state (hermetic suites)
3. **PR3** judge + providers (hermetic contract suites)
4. **PR4** rewriter + protocol conformance + fail-closed matrix
5. **PR5** live smoke #2/#3 + README install docs + npm 0.1.0 train

## 14. Decisions register (open questions → rulings)

| question | ruling | rationale |
|---|---|---|
| same-name service replacement? | **no** — listener only | spike #2 Q2: registration throws; listener needs nothing uninstalled |
| preserve anchor | node-count (40) | no turn-parsing dependency in V1; tunable |
| goal source | surface `goal/change` events | replay-safe, zero injects; service switch deferred to V1.1 |
| keep/drop asymmetry | drop only below P(keep) 0.25 | wrong drop is the catastrophic direction; over-keep has the deterministic safety net |
| request granularity | one batched request per step | latency + cost; the proven jev-test-filter shape |
| span target | ~1200 chars, paragraph-bounded | judgment quality vs request size; hard max 2000 |
| keys | DSH credential store only | family + ecosystem discipline (never env/yml) |
| service names defined | none | the collision class of failure cannot occur |
| LLM-as-judge path | `openai` provider (JSON mode) | air-gapped family deployments must work without TypeSafe/OpenRouter |
