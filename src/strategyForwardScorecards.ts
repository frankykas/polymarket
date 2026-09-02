import { CRYPTO_THRESHOLD_STRATEGY_ID } from "./agents/cryptoThresholdStrategyAgent.js";
import { MACRO_CPI_STRATEGY_ID } from "./agents/macroCpiStrategyAgent.js";
import { loadBotConfig, loadRuntimeEnv } from "./config.js";
import { BotDatabase } from "./db.js";
import type { StrategyForwardScorecard } from "./types.js";

const config = loadBotConfig();
const env = loadRuntimeEnv();
const db = new BotDatabase(env.dbPath, config.performanceStartAt);

try {
  const positionSizeUsd = config.independentModelFlatPositionSize ?? config.minPositionSize;
  const scorecards: StrategyForwardScorecard[] = [
    db.getStrategyForwardScorecard({
      strategyId: CRYPTO_THRESHOLD_STRATEGY_ID,
      cluster: "CRYPTO_THRESHOLD",
      since: config.cryptoThresholdForwardPolicyStartAt ?? 0,
      policyVersion: config.cryptoThresholdForwardPolicyVersion ?? "crypto-unfrozen",
      positionSizeUsd,
      minResolvedTrades: config.cryptoThresholdForwardMinResolvedTrades ?? 30,
      minReturnPct: config.cryptoThresholdForwardMinReturnPct ?? 0.05
    }),
    db.getStrategyForwardScorecard({
      strategyId: MACRO_CPI_STRATEGY_ID,
      cluster: "MACRO_RELEASE",
      since: config.macroCpiForwardPolicyStartAt ?? 0,
      policyVersion: config.macroCpiForwardPolicyVersion ?? "macro-cpi-unfrozen",
      positionSizeUsd,
      minResolvedTrades: config.macroCpiForwardMinResolvedTrades ?? 30,
      minReturnPct: config.macroCpiForwardMinReturnPct ?? 0.05
    })
  ];
  if (process.argv.includes("--json")) console.log(JSON.stringify(scorecards, null, 2));
  else console.log(scorecards.map(formatScorecard).join("\n\n"));
} finally {
  db.close();
}

function formatScorecard(scorecard: StrategyForwardScorecard): string {
  return [
    `${scorecard.cluster} forward scorecard: ${scorecard.policyVersion}`,
    `Forward start: ${new Date(scorecard.since).toISOString()}`,
    `Selected: ${scorecard.uniqueCandidates} unique`,
    `Executed: ${scorecard.executedCandidates}; closed paper: ${scorecard.closedPaperPositions}`,
    `Resolved: ${scorecard.resolved}; W-L ${scorecard.wins}-${scorecard.losses}; win rate ${(scorecard.winRate * 100).toFixed(1)}%`,
    `Settlement: $${scorecard.settlementPnl.toFixed(2)} (${(scorecard.settlementReturnPct * 100).toFixed(2)}%)`,
    `Overseer paper exits: $${scorecard.paperPnl.toFixed(2)} (${(scorecard.paperReturnPct * 100).toFixed(2)}%)`,
    `Brier: model ${formatOptional(scorecard.modelBrierScore)} vs market ${formatOptional(scorecard.marketBrierScore)}`,
    `Research gate: ${scorecard.researchPromotionEligible ? "PASSED" : "BLOCKED"} - ${scorecard.researchPromotionReason}`,
    `Experimental paper: ${scorecard.experimentalPaperEligible ? "ELIGIBLE" : "BLOCKED"}`,
    `Standard paper: ${scorecard.standardPaperEligible ? "ELIGIBLE" : "BLOCKED"}`,
    `Promotion: ${scorecard.promotionEligible ? "ELIGIBLE" : "NOT ELIGIBLE"} - ${scorecard.promotionReason}`
  ].join("\n");
}

function formatOptional(value: number | undefined): string {
  return value === undefined ? "n/a" : value.toFixed(4);
}
