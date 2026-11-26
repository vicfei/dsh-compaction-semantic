// Span splitting (design §5): paragraph-bounded, merged to ~spanTargetChars,
// hard max 2000. Non-text blocks pass through untouched and unjudged.

export const HARD_MAX = 2000;

export function splitBlocks(blocks, spanTargetChars = 1200) {
  const out = [];
  let spanSeq = 0;
  const tag = (p) => ({ ...p, index: spanSeq++ });
  for (let bi = 0; bi < (blocks || []).length; bi++) {
    const block = blocks[bi];
    if (block?.type !== "text") { out.push({ kind: "passthrough", blockIndex: bi }); continue; }
    const paragraphs = String(block.text).split(/\n\s*\n/);
    let buf = "", bufStart = 0;
    const flush = (endIdx) => {
      if (buf.length) out.push(tag({ kind: "span", blockIndex: bi, text: buf, paraStart: bufStart, paraEnd: endIdx }));
      buf = "";
    };
    paragraphs.forEach((p, pi) => {
      if (buf.length === 0) bufStart = pi;
      if (p.length > HARD_MAX) {
        // single monster paragraph: hard-split at max (never silent)
        let rest = p;
        while (rest.length > HARD_MAX) {
          flush(pi);
          out.push(tag({ kind: "span", blockIndex: bi, text: rest.slice(0, HARD_MAX), paraStart: pi, paraEnd: pi, hardSplit: true }));
          rest = rest.slice(HARD_MAX);
        }
        buf = rest;
        bufStart = pi;
        return;
      }
      if (buf.length && buf.length + p.length > spanTargetChars) { flush(pi); bufStart = pi; }
      buf = buf.length ? `${buf}\n\n${p}` : p;
    });
    flush(paragraphs.length);
  }
  return out;
}

// Apply verdicts back to blocks: kept span text byte-equal; each contiguous
// dropped run collapses to one marker. Returns null when nothing is dropped.
export function applyVerdicts(blocks, parts, keepFor, threshold, dropThreshold) {
  const droppedAny = parts.some((p) => p.kind === "span" && !keepFor(p));
  if (!droppedAny) return null;
  const byBlock = new Map();
  for (const p of parts) {
    if (!byBlock.has(p.blockIndex)) byBlock.set(p.blockIndex, []);
    byBlock.get(p.blockIndex).push(p);
  }
  const newBlocks = [];
  const markerOf = (chars) => `\n\n[... semantic pruned: ${chars} chars (dsh-compaction-semantic) ...]\n\n`;
  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi];
    if (block?.type !== "text") { newBlocks.push(block); continue; }
    const partsHere = byBlock.get(bi) ?? [];
    if (partsHere.length === 0 || partsHere.every((p) => p.kind !== "span")) { newBlocks.push(block); continue; }
    // Rebuild in SPAN order (found live 2026-11-26): paragraph-level rebuilding
    // could not express a dropped hard-split span — every hard-split span shares
    // one paragraph, so dropping one while keeping its neighbours rebuilt the
    // original text unchanged. A kept span's text is byte-equal by construction
    // (split joined paragraphs with the same separator it re-emits); a
    // contiguous dropped run collapses to one marker.
    let droppedChars = 0, markerInserted = false;
    const kept = [];
    const emitDropped = () => { if (!markerInserted) { kept.push(markerOf(0).trim()); markerInserted = true; } };
    for (const p of partsHere) {
      if (p.kind !== "span") continue;
      if (keepFor(p)) kept.push(p.text);
      else { droppedChars += p.text.length; emitDropped(); }
    }
    if (droppedChars === 0) { newBlocks.push(block); continue; }
    if (markerInserted) kept[kept.indexOf(markerOf(0).trim())] = markerOf(droppedChars).trim();
    const text = kept.join("\n\n");
    if (text.length) newBlocks.push({ ...block, text });
  }
  return newBlocks;
}
