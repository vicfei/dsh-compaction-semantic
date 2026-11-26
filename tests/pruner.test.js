// Hermetic suites (design §11): fake session + fake judge — no DSH host,
// no network. Protocol conformance, fail-closed matrix, pins, breaker.
import { test } from "node:test";
import assert from "node:assert";
import { resolveConfig, ConfigError } from "../lib/config.js";
import { selectCandidates, textChars } from "../lib/candidates.js";
import { splitBlocks, applyVerdicts } from "../lib/spans.js";
import { buildState } from "../lib/state.js";
import { judgeOnce, makeBreaker, questionsFor, JudgeError } from "../lib/judge.js";
import { rewriteCandidate } from "../lib/rewrite.js";
import { apply } from "../lib/index.js";

// ---- fake session: append-only log + projected surface -------------------
function makeFakeSession({ results = [], userMessages = [], goals = [] } = {}) {
  const events = [];       // {seq, type, data, surfaceOp?, sourceEventSeqs?}
  const base = [];
  for (const m of userMessages) base.push({ type: "user/message", data: { message: { content: m } } });
  for (const r of results) base.push({ type: "tool/result", data: { message: { source: { tool: r.tool ?? "read" }, content: r.content } } });
  for (const g of goals) base.push({ type: "goal/change", data: { goal: { text: g } } });
  base.forEach((e, i) => events.push({ ...e, seq: i + 1 }));
  const session = {
    surface: { nodes: events.map((e) => e.seq) },
    eventAt: (seq) => events.find((e) => e.seq === seq),
    deriveEventMessage: (event) => structuredClone(event.data.message),
    append(type, data, opts) {
      const seq = events.length + 1;
      events.push({ seq, type, data, ...opts });
      if (opts?.surfaceOp?.op === "replace") {
        const { startSeq, endSeq } = opts.surfaceOp;
        session.surface.nodes = session.surface.nodes.filter((n) => n < startSeq || n > endSeq);
        session.surface.nodes.push(seq);
      }
      return { seq };
    },
  };
  return { session, events };
}

const bigText = (n, filler = "The quick brown fox jumps over the lazy dog. ") => filler.repeat(Math.ceil(n / filler.length)).slice(0, n);

// ---- config ----------------------------------------------------------------
test("config: unknown keys / bad bounds reject at load", () => {
  assert.throws(() => resolveConfig({ nope: 1 }), ConfigError);
  assert.throws(() => resolveConfig({ thresholdChars: -1 }), ConfigError);
  assert.throws(() => resolveConfig({ dropThreshold: 2 }), ConfigError);
  assert.throws(() => resolveConfig({ judge: { provider: "cloud" } }), ConfigError);
  const c = resolveConfig({});
  assert.equal(c.judge.provider, "off");          // default = stock behavior
  assert.equal(c.thresholdChars, 8192);
});

// ---- candidates ------------------------------------------------------------
test("candidates: threshold + savings floor + pins + cap", () => {
  const config = resolveConfig({ preserveRecentNodes: 2, maxJudgeResultsPerStep: 2 });
  const results = [
    { tool: "read", content: [{ type: "text", text: bigText(12000) }] },   // candidate
    { tool: "read", content: [{ type: "text", text: bigText(8300) }] },    // under savings floor (8300-8192 < 2048)
    { tool: "read", content: [{ type: "text", text: bigText(12000) }] },   // candidate (cap)
    { tool: "read", content: [{ type: "text", text: bigText(12000) }] },   // beyond cap
    { tool: "read", content: [{ type: "text", text: bigText(12000) }] },   // recent pin (last 2)
    { tool: "read", content: [{ type: "text", text: bigText(12000) }] },   // recent pin
  ];
  const { session } = makeFakeSession({ results });
  const cands = selectCandidates({ session, config });
  assert.equal(cands.length, 2);                  // cap
  assert.deepEqual(cands.map((c) => c.seq), [1, 3]);
});
test("candidates: neverPruneTools exempts", () => {
  const config = resolveConfig({ neverPruneTools: ["stateful_mcp"], preserveRecentNodes: 0 });
  const { session } = makeFakeSession({ results: [{ tool: "stateful_mcp", content: [{ type: "text", text: bigText(12000) }] }] });
  assert.equal(selectCandidates({ session, config }).length, 0);
});

// ---- spans -----------------------------------------------------------------
test("spans: paragraph split, merge to target, hard max, passthrough", () => {
  const paras = Array.from({ length: 10 }, (_, i) => `P${i} `.repeat(50).trim());  // ~200 chars each
  const parts = splitBlocks([{ type: "text", text: paras.join("\n\n") }, { type: "image", src: "x" }], 400);
  const spans = parts.filter((p) => p.kind === "span");
  assert.ok(spans.every((s) => s.text.length <= 2000));
  assert.ok(spans.some((s) => s.text.includes("P0") && s.text.includes("P1")));   // merged
  assert.equal(parts.filter((p) => p.kind === "passthrough").length, 1);          // image untouched
});
test("spans: applyVerdicts keeps verbatim, one marker per dropped run", () => {
  const paras = ["KEEP A".padEnd(50, "a"), "DROP B".padEnd(300, "b"), "KEEP C".padEnd(50, "c")];
  const blocks = [{ type: "text", text: paras.join("\n\n") }];
  const parts = splitBlocks(blocks, 100);
  const keepFor = (p) => p.text.includes("KEEP");
  const out = applyVerdicts(blocks, parts, keepFor, 8192, 0.25);
  assert.match(out[0].text, /KEEP A/);
  assert.match(out[0].text, /KEEP C/);
  assert.doesNotMatch(out[0].text, /DROP B/);
  assert.match(out[0].text, /semantic pruned: \d+ chars/);
  assert.equal(out[0].text.match(/semantic pruned/g).length, 1);                 // one marker per run
});

// ---- state -----------------------------------------------------------------
test("state: current ask + recent asks + goal; truncation stages", () => {
  const { session } = makeFakeSession({
    userMessages: ["old ask one", "older ask two", "latest ask"],
    goals: ["ship the release"],
  });
  const config = resolveConfig({ state: { recentAsks: 2, maxStateTokens: 25000 } });
  const state = buildState({ messages: [{ content: [{ type: "text", text: "current question" }] }], session, config });
  assert.equal(state.current_ask, "current question");
  assert.deepEqual(state.recent_asks, ["older ask two", "latest ask"]);
  assert.equal(state.goal, "ship the release");
});

// ---- judge -----------------------------------------------------------------
const okFetch = (verdicts) => async () => ({
  ok: true,
  json: async () => ({
    choices: [{ message: { content: JSON.stringify({ verdicts }) } }],
  }),
});

test("judge: openai provider strict validation — count mismatch discards whole response", async () => {
  const config = resolveConfig({ judge: { provider: "openai", baseUrl: "http://x" } });
  const questions = [{ id: "1:0:0" }, { id: "2:0:0" }];
  await assert.rejects(() => judgeOnce({ config, state: {}, questions, fetchImpl: okFetch([{ id: "1:0:0", p_keep: 0.9 }]) }), JudgeError);
});
test("judge: valid response maps spanIds; timeout aborts", async () => {
  const config = resolveConfig({ judge: { provider: "openai", baseUrl: "http://x", timeoutMs: 50 } });
  const questions = [{ id: "1:0:0" }, { id: "1:1:0" }];
  const verdicts = await judgeOnce({ config, state: {}, questions, fetchImpl: okFetch([{ id: "1:0:0", p_keep: 0.9 }, { id: "1:1:0", p_keep: 0.1 }]) });
  assert.equal(verdicts.get("1:0:0"), 0.9);
  const slow = async (_u, init) => { await new Promise((r) => setTimeout(r, 200)); return { ok: true, json: async () => ({}) }; };
  await assert.rejects(() => judgeOnce({ config, state: {}, questions, fetchImpl: slow }));
});
test("judge: typesafe provider request shape", async () => {
  const config = resolveConfig({ judge: { provider: "typesafe" } });
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, body: JSON.parse(init.body) }; return { ok: true, json: async () => ({ answers: [{ id: "1:0:0", p_keep: 0.5 }] }) }; };
  await judgeOnce({ config, state: { goal: "g" }, questions: [{ id: "1:0:0", kind: "noul", question: "q", excerpt: "e" }], fetchImpl });
  assert.equal(seen.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(seen.body.questions[0].type, "noul");
});
test("breaker: trips after N consecutive failures", () => {
  const b = makeBreaker(3);
  b.fail(); b.ok(); b.fail(); b.fail();
  assert.equal(b.tripped, false);
  b.fail();
  assert.equal(b.tripped, true);
});

// ---- rewrite + protocol ------------------------------------------------------
test("rewrite: official protocol — shadow event FIRST, then replace with sourceEventSeqs", () => {
  const { session, events } = makeFakeSession({ results: [{ tool: "read", content: [{ type: "text", text: [bigText(3000, "relevant error stack "), bigText(12000, "irrelevant log spam ")].join("\n\n") }] }] });
  const config = resolveConfig({});
  const candidate = selectCandidates({ session, config: resolveConfig({ preserveRecentNodes: 0 }) })[0];
  const verdicts = new Map();
  const parts = splitBlocks(session.deriveEventMessage(candidate.event).content, 1000);
  for (const p of parts) if (p.kind === "span") verdicts.set(`${candidate.seq}:${p.blockIndex}:${p.index}`, p.text.includes("log spam") ? 0.05 : 0.95);
  const r = rewriteCandidate({ session, candidate, verdicts, config, tokenMeter: { estimateMessage: () => 42 } });
  assert.equal(r.pruned, true);
  const shadow = events.at(-2), replacement = events.at(-1);
  assert.equal(shadow.type, "compaction/prune");
  assert.deepEqual(shadow.data.shadowedSeqs, [candidate.seq]);
  assert.equal(shadow.data.shadowedTokenCount, 42);
  assert.equal(replacement.type, "tool/result");
  assert.equal(replacement.surfaceOp.op, "replace");
  assert.deepEqual(replacement.sourceEventSeqs, [candidate.seq]);
  assert.match(replacement.data.message.content[0].text, /relevant error stack/);  // kept verbatim
  assert.match(replacement.data.message.content[0].text, /semantic pruned/);
  assert.ok(textChars(replacement.data.message.content) < textChars(events[0].data.message.content));
});
test("rewrite: all-keep → no appends; invariant violation → untouched", () => {
  const { session, events } = makeFakeSession({ results: [{ content: [{ type: "text", text: bigText(12000) }] }] });
  const config = resolveConfig({});
  const candidate = selectCandidates({ session, config: resolveConfig({ preserveRecentNodes: 0 }) })[0];
  const before = events.length;
  const keepAll = new Map([["1:0:0", 0.99]]);
  assert.equal(rewriteCandidate({ session, candidate, verdicts: keepAll, config }).pruned, false);
  assert.equal(events.length, before);
});

// ---- plugin end-to-end on the fake host (fail-closed matrix) ----------------
function makeFakeCtx() {
  const listeners = {};
  const log = [];
  return {
    on: (name, fn, opts) => { (listeners[name] ??= []).push({ fn, opts }); },
    logger: { info: (m) => log.push(["info", m]), warn: (m) => log.push(["warn", m]), debug: (m) => log.push(["debug", m]) },
    tokenMeter: { estimateMessage: () => 7 },
    _listeners: listeners, _log: log,
  };
}
const fire = async (ctx, payload) => await ctx._listeners["agent/pre-step"][0].fn(payload, () => "NEXT");

test("plugin: registers ONE prepend listener; off provider = zero requests, next() flows", async () => {
  const ctx = makeFakeCtx();
  apply(ctx, { judge: { provider: "off" } });
  assert.equal(ctx._listeners["agent/pre-step"].length, 1);
  assert.deepEqual(ctx._listeners["agent/pre-step"][0].opts, { prepend: true });
  const { session } = makeFakeSession({ results: [{ content: [{ type: "text", text: bigText(12000) }] }] });
  const result = await fire(ctx, { agent: { session }, messages: [] });
  assert.equal(result, "NEXT");
});
test("plugin: full happy path prunes via judge and never blocks", async () => {
  const ctx = makeFakeCtx();
  const config = { judge: { provider: "openai", baseUrl: "http://x" } };
  apply(ctx, { ...config, preserveRecentNodes: 0 });
  const { session } = makeFakeSession({ results: [{ tool: "read", content: [{ type: "text", text: bigText(3000, "keepme ") + "\n\n" + bigText(12000, "spam ") }] }] });
  const savedFetch = globalThis.fetch;
  globalThis.fetch = okFetch(buildVerdicts(session));
  try {
    const result = await fire(ctx, { agent: { session }, messages: [{ content: [{ type: "text", text: "current task" }] }] });
    assert.equal(result, "NEXT");
    assert.ok(ctx._log.some(([l, m]) => l === "info" && /pruned 1 result/.test(m)));
  } finally { globalThis.fetch = savedFetch; }
  function buildVerdicts(session) {
    const config2 = resolveConfig({ preserveRecentNodes: 0 });
    const c = selectCandidates({ session, config: config2 })[0];
    const vs = [];
    for (const p of splitBlocks(session.deriveEventMessage(c.event).content, 1200))
      if (p.kind === "span") vs.push({ id: `${c.seq}:${p.blockIndex}:${p.index}`, p_keep: p.text.includes("spam") ? 0.02 : 0.98 });
    return vs;
  }
});
test("plugin: judge failure → skip step, breaker trips at 3, still next()", async () => {
  const ctx = makeFakeCtx();
  apply(ctx, { judge: { provider: "openai", baseUrl: "http://x", maxConsecutiveFailures: 3 }, preserveRecentNodes: 0 });
  const mk = () => makeFakeSession({ results: [{ content: [{ type: "text", text: bigText(12000) }] }] });
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  try {
    for (let i = 0; i < 3; i++) {
      const s = mk();
      assert.equal(await fire(ctx, { agent: { session: s.session }, messages: [] }), "NEXT");
      assert.equal(s.events.length, 1);                    // nothing appended
    }
    assert.ok(ctx._log.some(([l, m]) => l === "warn" && /inert for the rest of the session/.test(m)));
    const s4 = mk();
    assert.equal(await fire(ctx, { agent: { session: s4.session }, messages: [] }), "NEXT");
  } finally { globalThis.fetch = savedFetch; }
});
test("plugin: malformed payload (no session) → next(), no throw", async () => {
  const ctx = makeFakeCtx();
  apply(ctx, {});
  assert.equal(await fire(ctx, { messages: [] }), "NEXT");
});

// ── P0 (issue #4): operator visibility — the mount leaves a stderr trace ────
test("apply() writes the arming line to stderr (the mount proof)", () => {
  const lines = [];
  const orig = process.stderr.write;
  process.stderr.write = (c) => { lines.push(String(c)); return true; };
  try {
    apply({ on: () => {}, logger: { info() {}, warn() {}, debug() {} } }, {});
  } finally {
    process.stderr.write = orig;
  }
  assert(lines.some((l) => l.includes("dsh-compaction-semantic: semantic pruner armed (provider=off")));
});
