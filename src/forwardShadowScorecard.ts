import { loadBotConfig, loadRuntimeEnv } from "./config.js";
import { BotDatabase } from "./db.js";
import { liveShadowPolicyVersion, walletCopyPositionSize } from "./tradingPolicy.js";

const config = loadBotConfig();
const env = loadRuntimeEnv();
const db = new BotDatabase(env.dbPath, config.performanceStartAt);

try {
  const since = config.performanceStartAt ?? 0;
  const policyVersion = liveShadowPolicyVersion(config);
  const report = db.getForwardShadowScorecard(since, policyVersion, {
    blocked: config.blockedMarketCategories,
    allowed: config.allowedMarketCategories,
    enforceAllowlist: config.categoryTradingGateEnabled === true
  });
  console.log("Forward-Only Shadow Scorecard");
  console.log(`Since source timestamp: ${since > 0 ? new Date(since).toISOString() : "all history"}`);
  console.log(`Policy: ${policyVersion}`);
  console.log(`Wallet-copy categories: ${config.categoryTradingGateEnabled === true ? (config.allowedMarketCategories ?? []).join(", ") || "none" : "all non-blocked"}`);
  console.log(`Shared wallet-copy size: $${walletCopyPositionSize(config).toFixed(2)}`);
  console.log(`Rows: ${report.total} | simulated: ${report.simulated} | skipped: ${report.skipped}`);
  console.log(`Executable: ${report.liveExecutableSimulated ?? 0} | missed: ${report.missed}`);
  console.log(`Executable P&L: $${(report.liveExecutablePnl ?? 0).toFixed(2)} | avg return: ${((report.liveExecutableAvgReturnPct ?? 0) * 100).toFixed(2)}% | win: ${((report.liveExecutableWinRate ?? 0) * 100).toFixed(1)}%`);
  console.log("");
  console.log("Categories");
  for (const category of report.categories) {
    console.log(`- ${category.category}: simulated=${category.simulated}, exec=${category.liveExecutableSimulated}, pnl=$${category.liveExecutablePnl.toFixed(2)}, avg=${(category.liveExecutableAvgReturnPct * 100).toFixed(2)}%, win=${(category.liveExecutableWinRate * 100).toFixed(1)}%`);
  }
  if (report.missedReasons.length > 0) {
    console.log("");
    console.log("Miss reasons");
    for (const item of report.missedReasons) console.log(`- ${item.reason}: ${item.count}`);
  }
  console.log("");
  console.log("Only category-eligible source trades first observed after the epoch, within the configured observation lag, are included. Historical backfill is excluded.");
} finally {
  db.close();
}
