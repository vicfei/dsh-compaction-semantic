// Judgment state (design §6): current ask (payload messages) + recent user
// asks from the surface + latest goal — staged truncation into a soft token
// budget (chars/4, documented imprecision).

export function buildState({ messages = [], session, config }) {
  const recentAsks = [];
  const nodes = [...(session.surface?.nodes ?? [])].reverse();     // newest first
  for (const seq of nodes) {
    const e = session.eventAt(seq);
    if (e?.type === "user/message" && recentAsks.length < config.state.recentAsks) {
      const text = messageText(e);
      if (text) recentAsks.push(text.slice(0, 500));
    }
    if (recentAsks.length >= config.state.recentAsks) break;
  }
  let goal = null;
  for (const seq of nodes) {
    const e = session.eventAt(seq);
    if (e?.type === "goal/change") { goal = goalText(e); break; }
  }
  const currentAsk = (messages || []).map(messageText).filter(Boolean).join("\n").slice(0, 2000) || null;
  return truncateToBudget({ current_ask: currentAsk, recent_asks: recentAsks.reverse(), goal }, config.state.maxStateTokens);
}

function messageText(e) {
  const m = e?.data?.message ?? e?.data ?? e;   // event-shaped or payload-shaped
  const c = m?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((b) => b?.type === "text").map((b) => b.text).join(" ");
  return "";
}
function goalText(e) {
  const g = e?.data?.goal ?? e?.data;
  return (typeof g === "string" ? g : g?.text ?? g?.title ?? null)?.slice(0, 500) ?? null;
}

function truncateToBudget(state, maxTokens) {
  const budget = maxTokens * 4;                                     // chars/4 heuristic
  const est = () => JSON.stringify(state).length;
  // stage 1: abridge oldest recent asks head+tail
  if (est() > budget && state.recent_asks.length > 1) {
    state.recent_asks = state.recent_asks.map((a, i) =>
      i < state.recent_asks.length - 1 && a.length > 120 ? `${a.slice(0, 60)}…${a.slice(-40)}` : a);
  }
  // stage 2: collapse oldest asks to one-liners
  if (est() > budget && state.recent_asks.length > 2) {
    state.recent_asks = state.recent_asks.map((a, i) => i < state.recent_asks.length - 2 ? a.slice(0, 60) : a);
  }
  // stage 3: drop oldest asks entirely
  while (est() > budget && state.recent_asks.length > 1) state.recent_asks.shift();
  return state;
}
