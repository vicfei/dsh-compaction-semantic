// Config resolution (design §9) — official-pruner convention: unknown keys
// reject at load, bounds validate fail-fast. provider:"off" + defaults
// degrade to exactly stock behavior.

const KEYS = new Set(["thresholdChars", "minSavingsChars", "preserveRecentNodes", "maxJudgeResultsPerStep",
  "spanTargetChars", "dropThreshold", "neverPruneTools", "state", "judge", "ledger", "engine"]);
const STATE_KEYS = new Set(["maxStateTokens", "recentAsks"]);
const JUDGE_KEYS = new Set(["provider", "model", "baseUrl", "apiKeyCredential", "timeoutMs", "maxConsecutiveFailures"]);
const LEDGER_KEYS = new Set(["path"]);
const ENGINE_KEYS = new Set(["enabled", "maxMessages", "minSavingsTokens", "targetFactor"]);

export const DEFAULTS = Object.freeze({
  thresholdChars: 8192,
  minSavingsChars: 2048,
  preserveRecentNodes: 40,
  maxJudgeResultsPerStep: 8,
  spanTargetChars: 1200,
  dropThreshold: 0.25,
  neverPruneTools: [],
  state: { maxStateTokens: 25000, recentAsks: 5 },
  judge: { provider: "off", model: "jev-latest", baseUrl: "", apiKeyCredential: "", timeoutMs: 2500, maxConsecutiveFailures: 3 },
  ledger: { path: "" },   // "" = ~/.dsh/compaction-ledger.ndjson · "off" = no ledger
  engine: { enabled: true, maxMessages: 24, minSavingsTokens: 512, targetFactor: 0 },   // V2: the summarize() wrap; targetFactor 0 = the built-in ladder
});

export class ConfigError extends Error {}

function posInt(name, v) { if (!Number.isInteger(v) || v <= 0) throw new ConfigError(`${name} must be a positive integer`); }
function frac(name, v) { if (!(v > 0 && v < 1)) throw new ConfigError(`${name} must be in (0,1)`); }

export function resolveConfig(raw = {}) {
  for (const k of Object.keys(raw)) if (!KEYS.has(k)) throw new ConfigError(`unknown key "${k}"`);
  const c = structuredClone(DEFAULTS);
  for (const k of ["thresholdChars", "minSavingsChars", "maxJudgeResultsPerStep", "spanTargetChars"])
    if (raw[k] !== undefined) posInt(k, raw[k]), c[k] = raw[k];
  if (raw.preserveRecentNodes !== undefined) {
    if (!Number.isInteger(raw.preserveRecentNodes) || raw.preserveRecentNodes < 0)
      throw new ConfigError("preserveRecentNodes must be a non-negative integer (0 disables the recent pin)");
    c.preserveRecentNodes = raw.preserveRecentNodes;
  }
  if (raw.dropThreshold !== undefined) frac("dropThreshold", raw.dropThreshold), c.dropThreshold = raw.dropThreshold;
  if (raw.neverPruneTools !== undefined) {
    if (!Array.isArray(raw.neverPruneTools) || !raw.neverPruneTools.every((t) => typeof t === "string"))
      throw new ConfigError("neverPruneTools must be string[]");
    c.neverPruneTools = raw.neverPruneTools;
  }
  for (const [k, allowed] of [["state", STATE_KEYS], ["judge", JUDGE_KEYS], ["ledger", LEDGER_KEYS], ["engine", ENGINE_KEYS]]) {
    if (raw[k] === undefined) continue;
    if (typeof raw[k] !== "object") throw new ConfigError(`${k} must be an object`);
    for (const kk of Object.keys(raw[k])) if (!allowed.has(kk)) throw new ConfigError(`${k}.${kk} unknown`);
    Object.assign(c[k], raw[k]);
  }
  if (typeof c.ledger.path !== "string") throw new ConfigError("ledger.path must be a string (a file path, or \"off\" to disable)");
  if (typeof c.engine.enabled !== "boolean") throw new ConfigError("engine.enabled must be a boolean");
  posInt("engine.maxMessages", c.engine.maxMessages);
  posInt("engine.minSavingsTokens", c.engine.minSavingsTokens);
  if (c.engine.targetFactor !== 0 && !(c.engine.targetFactor > 0 && c.engine.targetFactor < 1)) throw new ConfigError("engine.targetFactor must be in (0,1), or 0 for the built-in ladder");
  posInt("state.maxStateTokens", c.state.maxStateTokens);
  posInt("state.recentAsks", c.state.recentAsks);
  if (!["typesafe", "openrouter", "openai", "off"].includes(c.judge.provider))
    throw new ConfigError(`judge.provider must be typesafe|openrouter|openai|off`);
  posInt("judge.timeoutMs", c.judge.timeoutMs);
  posInt("judge.maxConsecutiveFailures", c.judge.maxConsecutiveFailures);
  if (c.judge.provider !== "off" && !c.judge.baseUrl && c.judge.provider === "openai")
    throw new ConfigError("judge.baseUrl is required for the openai provider");
  return Object.freeze(c);
}
