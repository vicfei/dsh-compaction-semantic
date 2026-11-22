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

- **V1 — semantic tool-result pruner** (design complete:
  [docs/design-v1.md](docs/design-v1.md)): an `agent/pre-step` hook
  (prepend) that batches **one judgment request** over all over-budget tool
  results, applies **scattered keep/drop at span granularity** (kept spans
  byte-equal), and commits through the official replay-safe protocol.
  Keep-on-doubt; provider-pluggable incl. an air-gapped OpenAI-compatible
  judge; every failure mode fails closed to stock behavior.
- **V2 — keep/drop compaction engine**: replace the summarizer with per-message
  keep/drop (the full thesis), riding the designed `summarize()` hook.

Read the mount-mechanism deep read — how the official pruner attaches, the
synchronous-call constraint that shapes V1, and the two insertion points:
[docs/analysis-official-pruner.md](docs/analysis-official-pruner.md).
The cross-harness companion analysis — how Claude Code (three tiers +
PreCompact/function hooks) and Codex (single tier, no hook, AGENTS.md
mount) implement compaction, and why DSH is the best-positioned host:
[docs/analysis-cc-codex-compaction.md](docs/analysis-cc-codex-compaction.md).
Spike #2 resolved all four mount questions statically (`prepend: true` +
waterfall holds the async chain; same-name service shadowing is a hard
error; the official pruner ships in the stock core bundle; the judgment
state is directly reachable at pre-step):
[docs/spike2-four-questions.md](docs/spike2-four-questions.md).

## Status

Spike #1 (this analysis) delivered 2026-11-21. See [ROADMAP.md](ROADMAP.md).

> **Agent self-install** — paste this into your DeepSeek Harness agent:
> `Install dsh-compaction-semantic from https://github.com/vicfei/dsh-compaction-semantic into this profile: run `+"`dsh plugin --profile <name> add dsh-compaction-semantic`"+` AND add it to the profile's dsh.profile.bundles list (judge stays off until you configure it — stock behavior is untouched).`

Not affiliated with DeepSeek, TypeSafe, or any upstream. MIT.
