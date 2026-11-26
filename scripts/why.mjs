#!/usr/bin/env node
// ledger-why — the decision trail for one surface node (issue #7):
//   node scripts/why.mjs [LEDGER_PATH] <seq>
// Default ledger: ~/.dsh/compaction-ledger.ndjson. Absence is meaningful: no
// record = nothing was judged there (judge off / zero candidates = stock).
import { why } from "../lib/ledger.js";

const args = process.argv.slice(2);
let seq = args.pop();
const ledgerPath = args[0] ?? "";
if (!seq || !/^\d+$/.test(seq)) {
  console.error("usage: node scripts/why.mjs [LEDGER_PATH] <seq>   (seq = the surface node's event seq)");
  process.exit(2);
}
console.log(why(ledgerPath, seq));
