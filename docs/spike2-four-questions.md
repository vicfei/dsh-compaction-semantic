# Spike #2 — the four open questions, answered from the cordis/DSH source

> Follow-up to [analysis-official-pruner.md](analysis-official-pruner.md) §8.
> Method: static reverse-read of the shipped closure
> (`@deepseek-ai/dsh@0.2.1-rc.5`, `@deepseek-ai/cordis@4.0.5` fork) — every
> answer carries `file:line` evidence. Live runtime smoke is folded into the
> first V1 PR (the four answers are load-bearing for its design, and the
> static evidence is unambiguous). Date: 2026-11-21.

## Q1 — the listener-priority knob and the async `next()` chain: **both work exactly as V1 needs**

**Knob.** Cordis listener registration takes placement options:
`ctx.on(name, listener, { prepend: true })` → `register()` does
`options.prepend ? "unshift" : "push"` on the hook list
(`cordis/lib/index.js`, `EventsService.register`). Prepend puts our listener
at the **front** of the `agent/pre-step` list.

**Chain semantics.** `agent/pre-step` is dispatched as a **waterfall**:
`await this.dispatch.waterfall("agent/pre-step", { messages: claimed,
...position, signal }, <built-in>)` (`dsh-agent-loop/lib/index.js:909`).
Cordis waterfall composes listeners **outermost-first around the built-in
innermost callback**; the docstring is explicit: *"a listener that does not
call `next()` vetoes the rest of the chain, including the built-in
behavior"* (`cordis/lib/index.js:308-315`). Consequences:

- the engine's own `agent/pre-step` listener (`dsh-compaction-basic:839`)
  is **inner** to a prepended listener — it observes the surface only after
  our async judgment has committed;
- a prepended listener that **awaits before calling `next()` holds the
  chain** — and the whole dispatch is `await`ed by the agent loop, so async
  judgment time is properly accounted in the step;
- bonus capability (not needed by V1): not calling `next()` vetoes the step.

**V1 mount = `ctx.on("agent/pre-step", judgeThenRewrite, { prepend: true })`,
await the batched judgment, call `next()`.** No flags, no engine changes.

## Q2 — double same-name service: **hard error at registration; no shadowing, no priority, no last-wins**

`ctx.reflect.provide(name, value, check)` — which every `Service`
constructor calls (`cordis/lib/index.js:1782`) — throws on the second
registration of a name in the same isolation scope:

```js
if (this.store[key]) throw new Error(`service "${name}" has been registered at <${this.store[key].fiber.name}>`);
```

(`cordis/lib/index.js:800-815`.)

**Consequence:** deployment shape A (define our own `toolResultPruner`
while the official one is loaded) **crashes at load time** — it is not a
fallback. Same-name replacement is only possible with the official package
not loaded (the profile patch layer's `disables` could do it — invasive,
unnecessary). Combined with Q1, **the prepend-listener shape (C) is the
only viable async mount, and it needs nothing uninstalled**.

## Q3 — stock activation: **the official pruner ships in the core bundle of every stock profile**

Every stock profile's bundle list starts with `@deepseek-ai/dsh-base`
(e.g. `~/.dsh/profiles/theo/package.json`: `bundles:
["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", …]`). `dsh-base` is
a pure meta-bundle (`lib/index.js` is `export {}`) whose
`dependencies` — 95 packages — include both
`@deepseek-ai/dsh-compaction-basic` and
`@deepseek-ai/dsh-compaction-tool-result-pruner` at `0.2.1-rc.5` (plus
`dsh-compaction-image-offload`, `dsh-command-compact`).

**Consequences for install instructions:** the deterministic pruner and the
engine are always present — our plugin never ships either; it only adds
itself to the profile's `bundles` list (+ `cordis.patch.yml` config). The
official pruner remains loaded and keeps catching anything still over
`thresholdChars` after our semantic pass — the harmless second line by
design.

## Q4 — the judgment state at pre-step: **payload + session surface + a `goals` service**

The pre-step payload (fused with `agent` by `agentEvents()`,
`dsh-agent/lib/index.js:242` — every agent event payload gets the agent
injected):

```js
{ agent,          // the agent: .session (dsh-session), .id, …
  messages,       // claimed inbox messages — the NEW user input this step is about to process
  ...position,    // incl. turn
  signal }        // abort signal for the step
```

Building the judgment `state` ("recent user asks + plan"):

- **current ask** is free: `messages` *is* the claimed user input for this
  step — no history walk needed for the freshest intent;
- **recent history**: `agent.session.surface.nodes` → `eventAt(seq)` yields
  the typed surface events — vocabulary includes `user/message`,
  `assistant/message`, `assistant/attempt`, `tool/call`, `tool/result`,
  `goal/change`, `plan/mode` (typed event map, `typert.host.js`). Recent
  user asks = walk surface for `user/message` events;
- **goal/plan**: either read `goal/change` events off the surface, or
  inject the `goals` **service** (registered under name `"goals"`,
  `dsh-goal/lib/index.js:592`) for authoritative current-goal state;
- **token accounting**: `tokenMeter` is an injectable service (the engine
  and pruner both inject it) — V1 uses it to decide which results are worth
  judging (`minSavingsChars` floor, §7 of the pruner analysis).

## Scorecard and what's next

| Question | Verdict |
|---|---|
| Q1 priority + async chain | ✅ `prepend: true` + waterfall holds the chain — V1 mount confirmed |
| Q2 same-name shadowing | ❌ hard error — shape A dead; prepend-listener is the only async shape |
| Q3 stock activation | ✅ pruner + engine ship in `dsh-base` core — coexist, install = add bundle entry |
| Q4 judgment state | ✅ `messages` (current ask) + surface `user/message`/`goal/change` + `goals` service + `tokenMeter` |

All four resolved statically with file:line evidence; the first V1 PR opens
with a hello-world live smoke that exercises Q1/Q4 at runtime (log the
pre-step payload shape, verify our listener logs before the engine's) as
its first commit.
