import { computeCleanWalkForward } from "./cleanWalkForward.js";
import { loadBotConfig, loadRuntimeEnv } from "./config.js";
import { BotDatabase } from "./db.js";
import type { WalkForwardMetrics } from "./types.js";

const config = loadBotConfig();
const env = loadRuntimeEnv();
const db = new BotDatabase(env.dbPath, config.performanceStartAt);

try {
  const report = computeCleanWalkForward(db, config, {
    walletLimit: Number(process.env.WALK_FORWARD_WALLET_LIMIT || 60),
    historyLimit: Number(process.env.WALK_FORWARD_HISTORY_LIMIT || 1500)
  });
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else {
    console.log("Retrospective Source-Time Walk-Forward Validation");
    console.log(`Wallets: ${report.wallets} | markets: ${report.markets} | train rows: ${report.trainRows} | test rows: ${report.testRows}`);
    if (report.splitAt) console.log(`Train before ${new Date(report.splitAt).toISOString()} | test through ${new Date((report.endAt ?? report.splitAt) - 1).toISOString()}`);
    console.log(`Gate-passing training sources: ${report.promotedSources}`);
    printResult("Gate-passing OOS", report.gatePassingOos);
    printResult("All test sources", report.allTestSources);
    console.log(`Verdict: ${report.passed ? "PASS" : "FAIL"} - ${report.reason}`);
    console.log("Resolved outcomes are stripped from both periods. This is a retrospective robustness test; immutable first-observed forward evidence is reported separately.");
  }
} finally {
  db.close();
}

function printResult(label: string, result: WalkForwardMetrics): void {
  console.log(`${label}: exec=${result.executable}, pnl=$${result.pnl.toFixed(2)}, avg=${pct(result.avgReturnPct)}, win=${pct(result.winRate)}, source-sell=${pct(result.sourceSellRatio)}`);
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
