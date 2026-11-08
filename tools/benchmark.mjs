import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { reservedGroups } from "../lib/groups.js";

const engine = await import(process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])) : "../lib/engine.js");
const ledgers = Array.from({ length: 1_000 }, (_, i) => ({
  id: "l-" + i, name: "Account " + i, groupId: i % 2 ? "g-sales" : "g-bank", opening: { dc: "Dr", paise: 0 }
}));
const company = { id: "bench", name: "Benchmark", booksFrom: "2026-04-01", groups: reservedGroups(), ledgers };
const vouchers = Array.from({ length: 10_000 }, (_, i) => ({
  id: "v-" + i, type: "Receipt", number: "RCT-" + (i + 1),
  date: i % 3 === 0 ? "2026-04-01" : "2026-06-01",
  narration: "Daily receipt", lines: [
    { ledgerId: ledgers[(i * 2) % 1_000].id, dc: "Dr", paise: 100 + i },
    { ledgerId: ledgers[(i * 2 + 1) % 1_000].id, dc: "Cr", paise: 100 + i }
  ]
}));
for (const [name, args] of [
  ["trialBalance", ["2026-05-01", "2026-06-30"]],
  ["profitAndLoss", ["2026-05-01", "2026-06-30"]],
  ["balanceSheet", ["2026-06-30"]]
]) {
  const run = () => engine[name](company, vouchers, ...args);
  const digest = createHash("sha256").update(JSON.stringify(run())).digest("hex");
  const times = Array.from({ length: 5 }, () => {
    const start = performance.now();
    run();
    return performance.now() - start;
  }).sort((a, b) => a - b);
  console.log(JSON.stringify({ name, medianMs: Number(times[2].toFixed(3)), digest }));
}
