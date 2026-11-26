# dsh-compaction-semantic V2 — design: the keep/drop compaction engine

> Decision-complete design for replacing the LLM prose summarizer with
> per-message keep/drop. Every mount/contract question is resolved against the
> **host 0.2.2-rc.1 closure** (facts with file:line evidence in §2).
> Status: awaiting owner review; implementation issue follows on approval.
> Date: 2026-11-26. Prerequisite already shipped: the decision ledger (#8).

## 1. Goal / non-goals

**Goal**: `summarize()` — the engine's sole customization hook — answers with
**verbatim-kept messages and dropped ones**, never LLM prose. The checkpoint
that replaces the compacted range is assembled from bytes that were already in
the conversation. Fail-closed to the stock prose summary on any judgment
failure (the summarizer, not the turn, is what we replace).

**Non-goals**: touching trigger policy, range selection, retention tail, or
the durable transaction (all stay stock — that machinery is correct and
load-bearing); judging the retain tail (it is kept verbatim by design);
tool-result pre-pruning (that is V1, unchanged, and runs before us in the same
pipeline); a second LLM call (the judge is the only model we add — the stock
path's `ctx.llm.stream` call disappears when we answer).

## 2. Spike facts (host 0.2.2-rc.1, `dsh-compaction-basic@0.2.2-rc.1`)

| # | fact | evidence |
|---|---|---|
| 1 | `async summarize(input, agent, signal)` is **the sole subclass customization hook** — the doc comment says so verbatim ("Override this sole hook for a template or remote summarizer") | `dsh-compaction-basic/lib/index.js:907-921` |
| 2 | the engine registers as Cordis service **`"compaction"`**, one per context, exposed as `ctx.compaction` | `dsh-compaction/lib/index.js:169-172` ("Load one implementation per context as `ctx.compaction`"), `super(ctx, "compaction")` |
| 3 | dispatch to the hook is **dynamic through the instance**: `regionDependencies()` binds `summarize: (…) => this.summarize(…)` | `:1030-1040` — an instance-level wrap is equivalent to subclassing |
| 4 | the transaction: `compaction/start` → summarize → `assertWholeSurfaceUnchanged` (deep-equal re-measure) → commit (`frameSummary` wraps OUR blocks in `CHECKPOINT_PREAMBLE` + `<compacted-summary>` tags, one replacement user message) → `compaction/end`; every failure writes exactly one `compaction/end` with the error chain | `compactSurfaceRegion` `:456-520`, `summarizeCompaction` `:582-606` |
| 5 | **the invariant, priced**: framed summary tokens (`meter.estimateMessage`) must be **<** `prepared.shadowedRouteTokenCount` or the engine throws "summary is not smaller than the shadowed content" | `summarizeCompaction :603-605` — tokens, not chars, and the framed overhead counts |
| 6 | summarize errors go to the **`compaction/summary-error` waterfall** (`recover`); a listener returning `true` re-prepares and retries once, `false` rethrows | `:582-598`, `regionDependencies.recover` |
| 7 | `input` = the **replayed conversation prefix** `{messages, tools}` (system, tools, leading messages) — NOT the raw surface events; `agent` carries `agent.session` for surface access | `prepareCompaction` `:568+`, `summarizeWithLlm` doc `:283-291` |
| 8 | our return contract: `{summary: text-only blocks, …}` — `summaryText()` (text-only, no images) is applied INSIDE the stock path, so the override must self-filter; extra fields are spread through | `:327-334`, `:599-606` |
| 9 | range selection (retain tail by tokens, tool-pairing balance, system head excluded) is stock and upstream of us | `selectCompactableRange :404-435` |
| 10 | one wrap covers every trigger: pressure, context-overflow, model-switch, and manual `/compact` all funnel through `compactIfNeeded`/`compactNow` → the same hook | `:923-1025` |

## 3. Mount

```
plugin apply(ctx)
  └─ inject: ["compaction", "tokenMeter"]           ← module-level exports
      ├─ guard: judge.provider === "off" → never wrap (stock, zero footprint)
      ├─ guard: typeof ctx.compaction?.summarize !== "function" → warn once, no wrap
      ├─ guard: ctx.compaction.__csWrapped → idempotent (no double wrap on re-apply)
      └─ const stock = engine.summarize.bind(engine)
         engine.summarize = wrapped            ← instance-level; dynamic dispatch (:1030)
                                          makes this equal to the subclass hook
```

No same-name service is registered → no shadowing error (the V1 shape-A dead
end). The wrap survives for the process lifetime; a profile re-apply hits the
idempotence guard. The V1 pre-step listener is untouched and still armed — V2
sits after V1 in the same pipeline (prune first, then judge what remains).

## 4. The wrapped summarize

```
wrapped(input, agent, signal):
  try:
    if breaker.tripped or candidates(input) == 0: return stock(...)
    state     = buildState({ messages: input.messages, session: agent.session, config })
    questions = one per message (excerpt = first 200 chars), capped at engine.maxMessages
    verdicts  = await judgeOnce({ config, state, questions })          ← ONE batched request
    kept      = messages with p_keep >= dropThreshold (keep-on-doubt, same threshold as V1)
    # the invariant, self-enforced (fact 5 — the engine throws otherwise):
    shadowed  = Σ ctx.tokenMeter.estimateMessage(m) for m in input.messages
    while estimate(framed(kept)) >= shadowed and a droppable kept message exists:
        drop the lowest-p_keep kept message                    ← deterministic shrink
    if estimate(framed(kept)) >= shadowed: return stock(...)    # judgment could not shrink — prose might
    summary = kept messages rendered as text blocks:
              text parts byte-equal; non-text parts (tool-calls, images) rendered
              as fenced text — a user-message checkpoint may carry text only (fact 8)
    ledger.append({ kind: "engine", messages: N, kept: [...], dropped: [...],
                    tokensShadowed, tokensFramed, judge: {...} })
    return { summary, engine: "dsh-compaction-semantic", keptMessages, droppedMessages }
  catch (anything):
    breaker.fail(); ledger nothing (absence = no judgment)
    return stock(input, agent, signal)                           ← fail-closed to prose
```

**Verbatim semantics**: every kept message's text lands byte-equal inside the
checkpoint; structure is flattened (quoted blocks), which is the only shape a
replacement user message may take. Prior `<compacted-summary>` checkpoints
inside the range are judged like any other message — still-true facts keep,
stale ones drop (the stock instruction's merge rule, executed by judgment
instead of prose).

**The framing is stock** (fact 4): `CHECKPOINT_PREAMBLE` + tags wrap our
blocks engine-side; we never touch the transaction, the markers, or the
stability assertions. Surface mutation during our await would trip
`assertWholeSurfaceUnchanged` exactly as for the stock summarizer — we mutate
nothing.

**Self-enforced invariant before return** (fact 5): the framed estimate — our
blocks plus the fixed preamble/tag overhead — must be strictly below the
shadowed estimate. The shrink loop is deterministic (lowest confidence first);
if judgment cannot shrink the range, we hand the decision back to the stock
prose summarizer rather than fail the compaction.

## 5. Config (extends the strict validator; unknown keys still reject)

```yaml
engine:
  enabled: true          # false = wrap nothing even with a judge configured
  maxMessages: 24        # per batched judge request; oldest-beyond-cap judged last-won? no — capped, keep-on-doubt for the unjudged tail
  minSavingsTokens: 512  # below this estimated saving, skip judgment → stock (small wins are not worth a checkpoint)
```

`dropThreshold`, `judge.*`, `ledger.*` are shared with V1 — one judge, one
ledger, one breaker per session.

## 6. Ledger event (kind: "engine")

`{kind:"engine", at, session, messages: N, kept: [{i, p_keep, fingerprint}], dropped: [...],
tokensShadowed, tokensFramed, judge: {provider, model, latencyMs, questions}, stock: false}`.
The fingerprint (first 80 chars of the message text) correlates a verdict to
the conversation by eye; the engine does not hand us the range seqs or the
compaction id (fact 7 — we see the replayed prefix only), and inventing a
correlation would be dishonest. `why.mjs` grows an engine-decision renderer.
Stock fallbacks record nothing — absence stays the equivalence proof.

## 7. Test plan

**Hermetic (fake engine instance + fake meter + fake fetch, no network):**
1. wrap guards: off-provider never wraps; missing summarize warns and skips;
   double-apply wraps once.
2. the happy path: N messages → one batched request → kept verbatim in the
   returned blocks (byte-equal text), dropped absent.
3. the shrink loop: adversarial verdicts (all keep) with a tight shadowed
   estimate → falls back to stock, records nothing.
4. fail-closed: judge error mid-flight → stock called, breaker advances.
5. text-only return: image/tool-call content in kept messages renders as text.
6. ledger: exactly one kind:"engine" event with the right shape.

**Live (mock judge, host 0.2.2-rc.1, pressure-forced with a small
`thresholdRatio`):** a long session crosses the threshold → V1 prunes tool
results → the engine compacts → the checkpoint lands as
`<compacted-summary>` with byte-equal kept text (grep the session event log) →
`compaction/start`+`compaction/end` markers present → a post-compaction turn
recalls a fact from a KEPT message (and honestly fails to recall one we
dropped). Judge off: compaction still happens (stock prose) with zero engine
ledger events.

## 8. A/B harness (the honest metric — ships with the engine, same PR series)

Same recorded sessions replayed through two profiles: stock (prose) vs
semantic (keep/drop). After each compaction, probe **recall of
stale-but-load-bearing facts** (identifiers, paths, numbers, error strings —
exact-match grading) plus tokens reclaimed. Numbers ship as measured,
including a semantic loss if there is one. Corpus per the owner ruling
(2026-11-26): synthetic sessions primary, a few real dev sessions after owner
review. Deliverables: `scripts/ab/` runner + `eval/` results table.

## 9. PR breakdown

1. **PR-engine**: §3-§6 + hermetic tests 1-6 + the live smoke of §7.
2. **PR-ab**: §8 runner + first measured table (synthetic corpus).
3. **PR-release**: 0.2.0 train (V1 fixes + ledger + engine), README/awesome refresh.

## 10. Risks / honest notes

- `input.messages` arrives in provider format (fact 7); the flattener needs
  one live dump to pin the exact block shapes — first implementation step,
  same as V1's deriveEventMessage lesson (a fallback, not an assumption).
- The stock path's KV-cache reuse disappears when we answer (no auxiliary LLM
  prefix at all) — that is the point, but it means compaction latency becomes
  judge latency, not model summarization latency.
- `compactNow` (manual `/compact`) also routes through us; a user asking for
  `/compact` gets keep/drop when the judge is on. Intended, documented.
- If upstream renames the hook or the service, the host-contract CI gate
  (#6) catches `Service "toolResultPruner"`/`pruneSession`; this design adds
  TWO more assertions to that gate: `super(ctx, "compaction")` and the
  `summarize:` dynamic-dispatch binding.
