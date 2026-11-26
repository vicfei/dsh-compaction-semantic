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

## Install & verify the mount (live-verified 2026-11-26, host 0.2.2-rc.1)

```bash
dsh plugin --profile <name> add dsh-compaction-semantic
# the bundles-list landmine: plugin add installs but does NOT activate —
# add "dsh-compaction-semantic" to package.json → dsh.profile.bundles by hand
```

The bundle's own `cordis.patch.yml` inserts the plugin row (`- insert:` —
top-level rows are config overrides of *existing* rows and silently no-op);
the row's `name` is the **module specifier** the loader resolves from the
profile's `node_modules`. Verify the mount two ways:

```bash
dsh --profile <name> --dump-config | grep -A3 dsh-compaction-semantic   # the row is in the composed tree
dsh --profile <name> "hi" 2>&1 | grep "semantic pruner armed"           # the plugin's own proof, every boot
```

Since 2026-11-26 the plugin prints that arming line (and each prune summary,
and each fail-closed transition) to **stderr** — `ctx.logger` feeds a
structured buffer that never reaches the terminal, which is why the first
live check saw nothing. Dev landmine: pnpm `file:` installs are hard-linked —
editing the source repo and `git checkout`-ing it back leaves the broken copy
in the profile's `.pnpm` store; re-sync (or reinstall) before re-testing.

## The keep/drop engine (V2) — `summarize()` answers with verbatim content

When a judge is configured, the plugin also wraps the host compaction engine's
sole customization hook (`ctx.compaction.summarize`): instead of an LLM-written
prose checkpoint, the replacement is assembled from **verbatim-kept messages**
(the judge scores each message; low-confidence ones drop, ordered by confidence
then size). Kept text rides byte-equal inside the stock checkpoint framing —
live-verified end to end on host 0.2.2-rc.1: a pressure-forced compaction
committed clean, and the checkpoint carried the task's load-bearing identifier
verbatim. Judge off → the wrap never installs (stock prose, zero footprint);
any judgment failure → the stock summarizer takes the range (fail-closed).
Decisions land in the ledger as `kind: "engine"` events.

Honest internals, all found live: the engine's strictly-smaller invariant
prices the **compacted range**, not the replayed prefix the hook receives —
the wrap targets a shrinking fraction of the prefix (25% → 12% → 6%, then
hands the range to stock), converging across the host's own pressure retries;
the framed estimate mirrors the engine's exact three-block framing; kept text
is verbatim except byte-broken surrogates (a mid-character shell cut), which
sanitize to U+FFFD — they would otherwise fail the session log's
serializability check and lose the whole compaction.

## The compaction ledger — every decision is evidence (V2, 2026-11-26)

Each judged keep/drop writes **one append-only ndjson event** — the trust
surface ("what did you delete from my context?") and the A/B instrument in
one file. Default `~/.dsh/compaction-ledger.ndjson`; `ledger.path` in the
config overrides, `ledger.path: "off"` disables.

```jsonc
{"at":"…","v":1,"session":"session-5cb915bf-…","seq":22,"tool":"read",
 "spans":[{"id":"22:0:0","p_keep":0.02,"kept":false}, …10 spans, 4 kept],
 "committed":true,"charsBefore":9065,"charsAfter":3669,
 "judge":{"provider":"openai","model":"jev-latest","latencyMs":13,"questions":10}}
```

Read the trail for one node:

```bash
node scripts/why.mjs [LEDGER_PATH] <seq>     # KEEP/DROP per span, with p_keep, chars, judge latency
```

Silence is meaningful: **no event = no judgment happened** (judge off, breaker
tripped, zero candidates) — stock equivalence is proven by absence, not by a
"did nothing" record. Uncommitted decisions (e.g. an invariant refusal) record
with `committed: false`. The ledger never breaks a turn: an append failure
prints to stderr and the pruning proceeds.

## Status

Spike #1 (this analysis) delivered 2026-11-21. See [ROADMAP.md](ROADMAP.md).

> **Agent self-install** — paste this into your DeepSeek Harness agent:
> `Install dsh-compaction-semantic from https://github.com/vicfei/dsh-compaction-semantic into this profile: run `+"`dsh plugin --profile <name> add dsh-compaction-semantic`"+` AND add it to the profile's dsh.profile.bundles list (judge stays off until you configure it — stock behavior is untouched).`

Not affiliated with DeepSeek, TypeSafe, or any upstream. MIT.
