# ROADMAP — dsh-compaction-semantic

North star: make DSH context compaction *judgment-driven* — keep what the
task needs verbatim, drop the rest — with the official deterministic behavior
as the always-available floor (fail-closed, never more brittle than stock).

## Milestones

### S1 · Mount-mechanism deep read ✅ (2026-11-21)
Reverse-read the shipped `@deepseek-ai/dsh@0.2.1-rc.5` closure:
- pruner = Cordis Service `"toolResultPruner"`, optional call-time name
  lookup by `BasicCompactionEngine`; prune runs **before** LLM summary and
  can eliminate it
- **critical constraint**: engine calls `pruneSession` without `await` →
  async judge must hook earlier (`agent/pre-step` listener priority), not
  shadow the service
- replay-safe mutation protocol (shadow-price event + replace surfaceOp) is
  the only contract to borrow
→ [docs/analysis-official-pruner.md](docs/analysis-official-pruner.md)

### S1b · Cross-harness compaction analysis ✅ (2026-11-21)
Claude Code (microcompaction/auto/manual tiers, PreCompact instruct-or-block,
function-hooks full replacement) vs Codex (single-tier summary, no compaction
hook, AGENTS.md instruction mount) — confirmed: no harness ships semantic
judgment; DSH's service slot + typed replay protocol is the strongest host
surface. V1 adopts fast-jev-compaction's battle-tested defaults (pinned head
+ recent window, staged state truncation into ~25k tokens, verbatim keeps).
→ [docs/analysis-cc-codex-compaction.md](docs/analysis-cc-codex-compaction.md)

### V1 · Semantic tool-result pruner — **implementation merged 2026-11-22 (PR #3, 16 tests green)**; live smoke on a real host + npm 0.1.0 remain open
- [x] **Design** — [docs/design-v1.md](docs/design-v1.md): decision-complete
      (mount = prepend listener only, no services defined; candidates with
      pins + savings floor + per-step cap; paragraph-bounded spans; shared
      state via payload `messages` + surface walks; one batched typed
      request; keep-on-doubt at P<0.25; provider matrix incl. air-gapped
      `openai` JSON judge; official protocol byte-for-byte; full fail-closed
      matrix; hermetic + live test plan; 5-PR breakdown awaiting approval)
- [x] Spike #2 four questions — answered statically with file:line evidence
      ([docs/spike2-four-questions.md](docs/spike2-four-questions.md)):
      `prepend: true` + waterfall holds the async chain (mount confirmed);
      same-name service shadowing is a **hard registration error** (shape A
      dead); official pruner + engine ship in the `dsh-base` core bundle
      (coexist — install = one bundles entry); judgment state =
      `messages` payload + surface `user/message`/`goal/change` + `goals`
      service + `tokenMeter`
- [x] config + prepend listener + candidates + spans + state + judge + rewriter — merged (PR1-PR4 series)
      (payload shape; our log before the engine's)
- [x] ~~PR2~~ (folded)
- [x] ~~PR3~~ (folded) (typesafe/openrouter/openai-json/off; contract
      suites; credential-store keys; circuit breaker)
- [x] ~~PR4~~ (folded) (shadow-before-replace,
      sourceEventSeqs) + fail-closed matrix
- [ ] PR5 live smokes (mock-judge session: rewrite + engine skips summary +
      replay recovers; judge-off ≡ stock) + install docs (bundles landmine
      on first screen) + npm `dsh-compaction-semantic` 0.1.0 +
      awesome-dsh-plugin submission

### V2 · Keep/drop compaction engine (after V1 proves the request shape)
- [ ] `summarize()`-hook engine: per-message keep/drop instead of LLM prose
      summary, checkpoint framing honored (strictly-smaller invariant)
- [ ] A/B harness: same sessions through official vs semantic, measure
      recall of stale-but-load-bearing facts (the honest metric)

## Discipline
- Fail-closed: judge unavailable in any mode ≡ official behavior, no new
  error classes upward, never block a turn on judgment.
- Kept content is verbatim — rewriting is summarization, which is the thing
  we replace.
- Evidence-first: adoption claims cite measured downloads/stars, not
  differentiation arguments.
