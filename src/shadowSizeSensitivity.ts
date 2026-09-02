import { loadBotConfig, loadRuntimeEnv } from "./config.js";
import { BotDatabase } from "./db.js";
import { excludeIneligibleShadowTrades, loadShadowValidationDataset, runShadowDataset, summarizeExecutableShadow } from "./shadowValidation.js";
import type { BotConfig } from "./types.js";

const baseConfig = loadBotConfig();
const env = loadRuntimeEnv();
const db = new BotDatabase(env.dbPath, baseConfig.performanceStartAt);
const sizes = [5, 10, 15];
const walletLimit = Number(process.env.SIZE_SENSITIVITY_WALLET_LIMIT || 60);
const historyLimit = Number(process.env.SIZE_SENSITIVITY_HISTORY_LIMIT || 1500);

try {
  const forwardSince = baseConfig.performanceStartAt ?? 0;
  const dataset = loadShadowValidationDataset(db, {
    activitySince: forwardSince,
    walletLimit,
    historyLimit
  });
  console.log("Shadow Size Sensitivity ($5 / $10 / $15)");
  console.log(`Wallets: ${dataset.histories.size} | markets: ${dataset.markets.length} | blocked categories retained: ${(baseConfig.blockedMarketCategories ?? []).join(", ") || "none"}`);
  console.log(`Forward boundary: ${forwardSince > 0 ? new Date(forwardSince).toISOString() : "all history"}`);
  console.log("");
  console.log("size".padEnd(8) + "cohort".padEnd(13) + "sim".padStart(7) + "exec".padStart(7) + "miss".padStart(7) + "win%".padStart(8) + "avgRet%".padStart(10) + "pnl".padStart(12));
  console.log("-".repeat(72));

  const rows: Array<{ size: number; cohort: string; executable: number; pnl: number; avgReturnPct: number; winRate: number }> = [];
  for (const size of sizes) {
    const config: BotConfig = { ...baseConfig, shadowPositionSize: size, walletCopyFlatPositionSize: size, minPositionSize: size, maxPositionSize: size };
    const all = runShadowDataset(dataset, config);
    for (const cohort of [
      { name: "historical", trades: all },
      { name: "post-epoch", trades: all.filter((trade) => trade.sourceTimestamp >= forwardSince) }
    ]) {
      const eligible = excludeIneligibleShadowTrades(cohort.trades, baseConfig);
      const summary = summarizeExecutableShadow(eligible);
      rows.push({ size, cohort: cohort.name, executable: summary.executable, pnl: summary.pnl, avgReturnPct: summary.avgReturnPct, winRate: summary.winRate });
      console.log(
        `$${size}`.padEnd(8) + cohort.name.padEnd(13) + String(summary.simulated).padStart(7) + String(summary.executable).padStart(7) + String(summary.missed).padStart(7) +
        (summary.winRate * 100).toFixed(1).padStart(8) + (summary.avgReturnPct * 100).toFixed(2).padStart(10) + `$${summary.pnl.toFixed(2)}`.padStart(12)
      );
    }
  }

  const forward = rows.filter((row) => row.cohort === "post-epoch" && row.executable > 0)
    .sort((a, b) => b.avgReturnPct - a.avgReturnPct || b.pnl - a.pnl);
  console.log("");
  if (forward.length === 0) {
    console.log("Forward winner: undetermined (no executable post-epoch observations yet). Keep $10 aligned with paper while evidence accrues.");
  } else if (forward[0].avgReturnPct <= 0 || forward.every((row) => row.pnl <= 0)) {
    const leastNegativeReturn = forward[0];
    const leastDollarLoss = [...forward].sort((a, b) => b.pnl - a.pnl)[0];
    console.log(`No profitable size: $${leastNegativeReturn.size} has the least-negative average return (${(leastNegativeReturn.avgReturnPct * 100).toFixed(2)}%), while $${leastDollarLoss.size} loses the fewest dollars ($${leastDollarLoss.pnl.toFixed(2)}). Keep $10 aligned with paper; do not promote any size.`);
  } else {
    const best = forward[0];
    console.log(`Forward winner by average executable return: $${best.size} (${(best.avgReturnPct * 100).toFixed(2)}%, $${best.pnl.toFixed(2)} P&L across ${best.executable} fills).`);
  }
  console.log("Post-epoch means source timestamp only; it can contain newly downloaded backfill and is not prospective promotion evidence.");
  console.log("Sports and every configured blocked category are excluded from performance comparisons; no promotion gate is relaxed.");
} finally {
  db.close();
}
