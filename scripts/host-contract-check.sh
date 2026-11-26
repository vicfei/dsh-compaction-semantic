#!/usr/bin/env bash
# Host-contract gate (P0.3): the three load-bearing facts from the S1 deep
# read (docs/analysis-official-pruner.md), asserted against a PINNED dsh
# closure. If upstream changes any of them, this goes red BEFORE users do.
set -euo pipefail
PIN="${DSH_PIN:-0.2.2-rc.1}"
DIR="$(mktemp -d)"
trap 'rm -rf "$DIR"' EXIT
cd "$DIR"
npm install --no-save --no-audit --no-fund --silent "@deepseek-ai/dsh@$PIN" >/dev/null 2>&1
B="$DIR/node_modules/@deepseek-ai"
fail() { echo "HOST-CONTRACT BROKEN: $1" >&2; exit 1; }

# 1. the engine resolves the pruner as an OPTIONAL name-based service and
#    calls pruneSession WITHOUT await (the constraint that shapes V1's mount)
python3 - "$B/dsh-compaction-basic/lib/index.js" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
call = re.search(r'this\.ctx\.get\("toolResultPruner"\)\?\.pruneSession\(agent\.session\);', src)
assert call, "optional-chain pruneSession call gone"
line = src[:call.start()].count("\n") + 1
print(f"fact 1 ok: optional pruneSession call without await (line {line})")
PY

# 2. the official pruner registers as a Cordis Service named "toolResultPruner"
grep -q 'super(ctx, "toolResultPruner")' "$B/dsh-compaction-tool-result-pruner/lib/index.js" \
  || fail 'pruner no longer registers as Service "toolResultPruner"'
echo 'fact 2 ok: pruner = Service "toolResultPruner"'

# 3. the replay-safe protocol still commits through a surfaceOp replace
grep -q 'surfaceOp:' "$B/dsh-compaction-tool-result-pruner/lib/index.js" \
  || fail "pruner no longer writes a surfaceOp (replay-safety contract)"
echo 'fact 3 ok: replay-safe surfaceOp replace present'
# 4. the compaction engine registers as service "compaction" (ctx.compaction — the V2 wrap target)
grep -q 'super(ctx, "compaction")' "$B/dsh-compaction/lib/index.js" \
  || fail "engine no longer registers as Service \"compaction\" (the V2 wrap target)"
echo 'fact 4 ok: engine = Service "compaction"'
# 5. summarize dispatch is dynamic through the instance (an instance wrap IS the subclass hook)
grep -q 'summarize: (input, owner, abort) => this.summarize' "$B/dsh-compaction-basic/lib/index.js" \
  || fail "summarize no longer dispatches through the instance (the V2 wrap assumption)"
echo 'fact 5 ok: summarize dispatch is dynamic through the instance'
# 6. the checkpoint framing constants (our exact-framing estimate mirrors them)
grep -q 'const SUMMARY_OPEN_TAG = "<compacted-summary>"' "$B/dsh-compaction-basic/lib/index.js" \
  || fail "checkpoint open tag changed (our exact framing estimate would drift)"
grep -q 'const CHECKPOINT_PREAMBLE = "This is an automatically generated checkpoint' "$B/dsh-compaction-basic/lib/index.js" \
  || fail "checkpoint preamble changed (our exact framing estimate would drift)"
echo 'fact 6 ok: checkpoint framing constants unchanged'
echo "HOST CONTRACT HOLDS against @deepseek-ai/dsh@$PIN"
