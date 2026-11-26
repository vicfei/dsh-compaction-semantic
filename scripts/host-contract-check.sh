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
echo "HOST CONTRACT HOLDS against @deepseek-ai/dsh@$PIN"
