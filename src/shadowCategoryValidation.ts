import { loadBotConfig, loadRuntimeEnv } from "./config.js";
import { BotDatabase } from "./db.js";
import { loadShadowValidationDataset, runShadowDataset, summarizeExecutableShadow } from "./shadowValidation.js";
import { walletCopyPositionSize } from "./tradingPolicy.js";
import type { MarketCategory, ShadowTrade } from "./types.js";

const config = loadBotConfig();
const env = loadRuntimeEnv();
const db = new BotDatabase(env.dbPath, config.performanceStartAt);

try {
  const dataset = loadShadowValidationDataset(db, {
    walletLimit: Math.max(60, config.replayAuditWalletLimit ?? 25),
    historyLimit: Math.max(1000, config.shadowHistoryLimit)
  });
  const timestamps = dataset.observedTrades.map((trade) => trade.timestamp).sort((a, b) => a - b);
  if (timestamps.length < 2) {
    console.log("Retrospective Category Walk-Forward Validation\nInsufficient source history.");
    process.exit(0);
  }
  const split = timestamps[Math.max(1, Math.min(timestamps.length - 1, Math.floor(timestamps.length * 0.75)))];
  const train = runShadowDataset(dataset, config, { before: split, stripResolution: true });
  const test = runShadowDataset(dataset, config, { since: split, stripResolution: true });
  const categories: MarketCategory[] = ["politics", "sports", "crypto", "macro", "company", "culture", "weather", "other"];
  const minTrades = config.minLiveExecutableShadowTradesForTrading ?? 30;
  const minReturn = config.liveExecutableMinReturnPct ?? 0;
  const minWinRate = config.minLiveExecutableShadowWinRateForTrading ?? 0;
  const minSellRatio = config.minSourceSellRealizedRatio ?? 0;

  console.log("Retrospective Category Walk-Forward Validation");
  console.log(`Shared wallet-copy size: $${walletCopyPositionSize(config).toFixed(2)}`);
  console.log(`Train: before ${new Date(split).toISOString()} | test: ${new Date(split).toISOString()} onward`);
  console.log("Resolved outcomes are stripped so current resolution state cannot leak into either period.");
  console.log("This is source-time historical evidence and may include backfilled observations; it cannot promote a live strategy.");
  console.log("");
  console.log("category   trainN  trainPnL  trainAvg    testN   testPnL   testAvg  testWin  sell%  result");
  console.log("------------------------------------------------------------------------------------------");
  const qualified: MarketCategory[] = [];
  for (const category of categories) {
    const trainMetrics = summarizeExecutableShadow(forCategory(train, category));
    const testMetrics = summarizeExecutableShadow(forCategory(test, category));
    const hardBlocked = (config.blockedMarketCategories ?? []).includes(category);
    const passed = !hardBlocked &&
      trainMetrics.executable >= minTrades && testMetrics.executable >= minTrades &&
      trainMetrics.pnl > 0 && trainMetrics.avgReturnPct > minReturn &&
      testMetrics.pnl > 0 && testMetrics.avgReturnPct > minReturn &&
      testMetrics.winRate >= minWinRate && testMetrics.sourceSellRatio >= minSellRatio;
    if (passed) qualified.push(category);
    console.log([
      category.padEnd(10),
      String(trainMetrics.executable).padStart(6),
      money(trainMetrics.pnl).padStart(9),
      pct(trainMetrics.avgReturnPct).padStart(9),
      String(testMetrics.executable).padStart(8),
      money(testMetrics.pnl).padStart(9),
      pct(testMetrics.avgReturnPct).padStart(9),
      pct(testMetrics.winRate).padStart(8),
      pct(testMetrics.sourceSellRatio).padStart(6),
      (passed ? "PASS" : hardBlocked ? "BLOCKED" : "FAIL").padStart(8)
    ].join(" "));
  }
  console.log("");
  console.log(`Promotion-qualified categories: ${qualified.join(", ") || "none"}`);
  console.log(`Gate: >=${minTrades} executable trades in both periods, positive P&L, >${pct(minReturn)} average return, >=${pct(minWinRate)} win rate, and >=${pct(minSellRatio)} source-sell ratio.`);
  console.log("This validates category direction under the tape execution model; live-paper parity remains a separate required gate.");
} finally {
  db.close();
}

function forCategory(trades: ShadowTrade[], category: MarketCategory): ShadowTrade[] {
  return trades.filter((trade) => (trade.category ?? "other") === category);
}

function money(value: number): string {
  return `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
