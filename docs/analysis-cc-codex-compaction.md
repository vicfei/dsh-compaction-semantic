# How Claude Code and Codex implement context compaction (and how third-party semantic compaction mounts on each)

> Companion to [analysis-official-pruner.md](analysis-official-pruner.md) (the
> DSH deep read). Evidence base: official docs where reachable, the shipped
> plugin ecosystem's own wiring instructions, and community source analyses —
> provenance flagged per claim. Date: 2026-11-21. Author: vicfei (window
> wren-w2, spike #1b).

## 0. TL;DR

| | Claude Code | Codex | DSH (from spike #1) |
|---|---|---|---|
| Compaction model | **three tiers**: microcompaction (tool-result clearing) → auto-compact (LLM summary) → `/compact` | **one tier**: auto summary at limit + `/compact` | **two stages**: deterministic tool-result pruner → LLM summary engine |
| Tool-result clearing | age-based, `[Old tool result content cleared]` marker, **cache-preserving, zero model calls** | inside the summary (oldest turns summarized wholesale) | char-threshold head/tail slicing (8192/4096/1024) |
| Judgment anywhere | none natively — all deterministic or LLM-prose | none natively | none natively |
| Compaction extension point | **PreCompact hook** (block or inject summary instructions) + **function hooks** (early access, full replacement) | **none** — hooks list has no compaction event | optional name-resolved `toolResultPruner` service + priority listener chain |
| Third-party semantic mount | replace compaction via early-access **function hooks** (plugin) | **AGENTS.md instruction** — teach the agent to call the compaction CLI itself | service name + earlier `agent/pre-step` listener (our V1) |
| Replay/recovery | cleared content saved to disk with preview ("lossless in spirit") | no scroll-back past a compaction (top user complaint) | append-only log + `sourceEventSeqs` — strongest of the three |

**The headline: no harness ships semantic judgment in compaction — all three
are either deterministic arithmetic or LLM prose summaries. The difference is
the mounting surface a third party gets, and DSH's is the most deliberate.**

## 1. Claude Code — the three-tier system

### 1.1 Microcompaction (the lightest tier, runs continuously)

Automatically clears **old tool results** from the context window while
keeping recent ones, substituting a marker (`[Old tool result content
cleared]`). Community source analyses (Troy Hua's memory write-up; "what we
can learn from the Claude Code source") report the mechanics:

- clearing happens via a **`cache_edits` API path that preserves the prompt
  cache prefix** when the cache is warm (content-cleared edits otherwise) —
  so it costs essentially **zero model calls**;
- cleared content is **saved to disk with a preview**, full content
  recoverable — "lossless in spirit";
- selection is **age/recency-based**: old = cleared, recent = kept. This is
  the same policy family as DSH's deterministic pruner, and exactly the
  policy the viral semantic work criticizes: the *byte budget goes to
  whatever is recent, not whatever matters*.
- Known failure mode (GitHub bug report, May 2026): it **silently clears MCP
  tool results** that some agents treat as durable state, with no opt-out
  for a tool to mark its results as memory — evidence that "which tool
  results survive" is a real decision, not an accounting detail.

### 1.2 Auto-compaction (at threshold) and 1.3 manual `/compact`

When the session nears the context limit, CC summarizes the conversation
history (typically reclaiming 60–70%), guided by an internal structured
summary format; `/compact` runs the same machinery on demand at a task
boundary. First message / CLAUDE.md are always re-injected. This is the
LLM-prose tier — verbatim loss by design.

### 1.4 Extension points (official hooks)

From the hooks reference (`code.claude.com/docs/en/hooks`):

- **`PreCompact`** — fires before compaction; matcher distinguishes
  `manual` (`/compact`) vs `auto`. Can **block** the compaction (exit 2 /
  `decision: block`), and — the interesting half — **the hook's stdout
  becomes instructions for the compaction summary**. So the official,
  stable customization surface is *prompting the summarizer*, not replacing
  the strategy.
- **`PostCompact`** — after compaction (cannot block); observability tail.
- **`SessionStart` with the `compact` matcher** — fires again *after*
  compaction; the canonical re-injection point (`additionalContext` at the
  start of the conversation). Community pattern: pair PreCompact backup +
  SessionStart restore.
- **`InstructionsLoaded`** fires with `compact` as a load reason — rules
  files reload post-compaction.

### 1.5 The full-replacement path: function hooks (early access)

`fast-jev-compaction` (maintained fork, 236 weekly downloads) documents the
only known way to *take over* CC compaction: **function hooks, an
early-access Claude Code feature (2.1.274+)**, opt-in via
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in settings env, then install as a
plugin from a marketplace. Result per its README: *"From then on `/compact`
(and auto-compaction) goes through Jev: the toast reads
`fast-jev-compaction: kept …`"*. Its algorithm (from the README's "How it
works"):

1. pair every `tool_use` with its `tool_result` by `tool_use_id`; the first
   message and the newest `preserveRecentMessages` messages are **pinned**;
2. build one **state**: the whole conversation oldest-first, tool results
   replaced by short notes (`ok, 4213 chars (omitted)`), tool inputs and
   texts included verbatim, nothing summarized;
3. fit the state into `maxStateTokens` (25k default) by **staged
   truncation**, each stage only if still over: tool inputs → 1000/200/60
   chars; long texts abridged head+tail, oldest non-pinned first; old
   non-pinned messages collapsed to a note; old tool calls reduced to one
   line each;
4. one judgment request: **keep/drop per message** — kept content stays
   **verbatim**, no summary is ever written.

Note the request shape: it is exactly the `jev-test-filter` shape (one shared
state, one typed question per item, one round trip) — the same shape our V1
borrows.

## 2. Codex — one tier, no hook, mount by instruction

### 2.1 Native mechanism

Codex auto-compacts when the context limit is hit (surfaced as *"Context
automatically compacted"*), and `/compact` runs it on demand. **Older turns
are replaced by a summary**; there is no separate tool-result clearing tier,
no disable flag, and **no scroll-back to pre-compaction history** — the top
user complaint, alongside post-compaction task regression (agent resumes
already-finished work; openai/codex issue #11444) and intermittent
compaction failures looping. All three complaints are the same pain:
*deterministic-or-prose compaction throws away the wrong things, and the
user can't even audit what was lost.*

### 2.2 Extension surface: none for compaction

Codex's hooks framework (10 lifecycle events: SessionStart/Stop,
PreToolUse/PostToolUse, UserPrompt, Stop, …) has **no compaction event**.
Accordingly, `fast-jev-compaction`'s installer wires Codex via
**AGENTS.md** — `npx jev-setup codex` writes agent instructions that teach
the model itself to run the `jev-compact` CLI (keep/drop judgment over the
transcript) **before** native compaction triggers, i.e. the agent performs
its own semantic pre-compaction on request. It works only as well as
instruction-following works — the weakest of the three mounting surfaces,
but the only one Codex offers.

## 3. What this means for dsh-compaction-semantic

1. **The thesis is confirmed cross-harness**: three vendors, zero semantic
   judgment in shipped compaction. Every "keep what matters" implementation
   in existence is third-party. The product's opening is real and unclaimed
   by any harness vendor.
2. **DSH is the best-positioned host** — deliberately or not:
   - Claude Code: full replacement requires an **early-access flag**
     (function hooks) and a plugin marketplace round-trip;
   - Codex: no hook at all — semantic compaction is an agent *habit*, not a
     mechanism;
   - DSH: the pruner slot is an **optional, name-resolved service** behind a
     **typed, replay-safe protocol**, with a listener-priority chain that
     lets async judgment run ahead of the engine (spike #1). Our V1 needs no
     flags, no marketplace, no instruction-following.
3. **Design confirmations for V1**:
   - CC microcompaction's *disk-save + recoverable* behavior mirrors DSH's
     `sourceEventSeqs` replay — keep that property sacred.
   - fast-jev-compaction's **pinned head + pinned recent window** and its
     **staged state truncation** (fit the judgment state into ~25k tokens
     without summarizing) are battle-tested defaults to adopt verbatim.
   - Its **MCP-tool-result bug** warns us: tool identity matters — a
     semantic pruner should treat a tool result as a candidate for *content*
     pruning, never silently delete state a tool contract depends on. Our
     per-span keep/drop keeps call/result pairing intact (we only rewrite
     `tool/result` content, pairing is untouched by the §3 protocol).
   - Codex's *no scroll-back* complaint validates the audit angle: our
     shadow events make every drop inspectable (`compaction/prune` +
     `sourceEventSeqs`).

## 4. Source provenance

- Claude Code hooks semantics: `code.claude.com/docs/en/hooks` (PreCompact /
  PostCompact / SessionStart `compact` matcher / InstructionsLoaded) —
  official docs, fetched 2026-11-21. The platform compaction overview page
  (`platform.claude.com/docs/en/build-with-claude/compaction`) region-blocks
  this research host; its content was cross-read via search summaries —
  tier structure and 60–70% reclamation claims are consistent across both.
- Microcompaction internals (`cache_edits`, disk save, MCP bug): community
  source analyses ("what we can all learn from the Claude Code source",
  Troy Hua's memory write-up, claudelog.com) + GitHub bug report (May 2026)
  — secondary sources, flagged as such.
- Codex behavior: openai/codex issue #11444 + user reports (auto-compaction
  message, no scroll-back, task regression) — secondary, consistent.
- fast-jev-compaction wiring + algorithm: the maintained fork's README on
  npm (function-hooks opt-in env, marketplace install, `jev-setup codex`
  → AGENTS.md, "How it works" numbered algorithm) — primary source for the
  only shipped semantic-compaction implementation.

Clean-room analysis; no upstream code copied.
