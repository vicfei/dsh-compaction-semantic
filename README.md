# dsh-compaction-semantic — semantic context compaction for DeepSeek Harness

**Keep what the task still needs; drop what it doesn't — by judgment, not by
character count.** The shipped DeepSeek Harness compaction answers a bloated
context with character arithmetic (keep the first 4,096 + last 1,024 code
points of any tool result over 8,192) and LLM-written summaries that launder
your error stacks into prose. This plugin replaces the *decision* with a
calibrated judge — kept content stays **verbatim**, drops are **scattered**
(relevance lives in the middle too), and every failure fails closed to the
official behavior.

English | [简体中文](README.zh-CN.md)

## Why (the pain is the most common one in agent use)

Every long agent session eventually hits compaction, and what users get is
"the oldest chit-chat survives the byte budget while the error stack from
three steps ago does not." The strongest pain signal in the entire
cross-harness dataset: the original `fast-jev-compaction` repository drew
**8,002 stars in a single day** (2026-09-17) for doing exactly this for
Claude Code — keep/drop by judgment, verbatim retention — then went dormant;
the maintained fork carries it on. DSH ships the *deterministic* pruner
(`dsh-compaction-tool-result-pruner`) but leaves the judgment slot open: the
engine resolves the pruner as an **optional, name-based service** and always
prunes *before* considering an LLM summary. That slot is this repo.

## What ships (plan)

- **V1 — semantic tool-result pruner**: an `agent/pre-step` hook that runs
  before the compaction engine's own listener, batches one judgment request
  over all over-budget tool results (shared state = recent user asks + plan;
  one typed question per span, ~300 ms class), and commits keep/drop
  rewrites through the official replay-safe protocol
  (`compaction/prune` shadow event → `tool/result` replace `surfaceOp`).
  Judge off / timeout / error → skip entirely, official behavior unchanged.
- **V2 — keep/drop compaction engine**: replace the summarizer with per-message
  keep/drop (the full thesis), riding the designed `summarize()` hook.

Read the mount-mechanism deep read — how the official pruner attaches, the
synchronous-call constraint that shapes V1, and the two insertion points:
[docs/analysis-official-pruner.md](docs/analysis-official-pruner.md).

## Status

Spike #1 (this analysis) delivered 2026-11-21. See [ROADMAP.md](ROADMAP.md).

Not affiliated with DeepSeek, TypeSafe, or any upstream. MIT.
