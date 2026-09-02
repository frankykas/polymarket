import { loadBotConfig, loadRuntimeEnv } from "./config.js";
import { BotDatabase } from "./db.js";

// One-shot backfill: rewrite stored live-executable shadow results under the
// current tape model. Run this after any change to the live-execution model,
// otherwise the live gate keeps reading evidence produced by the old one.
const config = loadBotConfig();
const env = loadRuntimeEnv();
const db = new BotDatabase(env.dbPath);
const apply = process.argv.includes("--apply");

try {
  const before = db.getShadowBacktestReport();
  console.log("Live-Executable Shadow Recompute");
  console.log(`Database: ${env.dbPath}`);
  console.log(`Mode: ${apply ? "APPLY" : "DRY RUN (pass --apply to write)"}`);
  console.log("");
  console.log("Before");
  console.log(`  Executable trades: ${before.liveExecutableSimulated}`);
  console.log(`  Executable PnL: $${(before.liveExecutablePnl ?? 0).toFixed(2)}`);
  console.log(`  Executable avg return: ${((before.liveExecutableAvgReturnPct ?? 0) * 100).toFixed(2)}%`);
  console.log(`  Executable win rate: ${((before.liveExecutableWinRate ?? 0) * 100).toFixed(1)}%`);

  if (!apply) {
    console.log("");
    console.log("No rows written. Re-run with --apply to rewrite them.");
  } else {
    const result = db.recomputeLiveExecutableShadow(config);
    const after = db.getShadowBacktestReport();
    console.log("");
    console.log("After");
    console.log(`  Rows scanned: ${result.scanned} | rewritten: ${result.updated} | newly missed: ${result.nowMissed}`);
    console.log(`  Executable trades: ${after.liveExecutableSimulated}`);
    console.log(`  Executable PnL: $${(after.liveExecutablePnl ?? 0).toFixed(2)}`);
    console.log(`  Executable avg return: ${((after.liveExecutableAvgReturnPct ?? 0) * 100).toFixed(2)}%`);
    console.log(`  Executable win rate: ${((after.liveExecutableWinRate ?? 0) * 100).toFixed(1)}%`);
    console.log("");
    console.log("Wallet scores refresh on the next scan cycle; run `npm run readiness` after that.");
  }
} finally {
  db.close();
}
