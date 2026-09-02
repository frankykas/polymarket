import { loadBotConfig, loadRuntimeEnv } from "./config.js";
import { BotDatabase } from "./db.js";

const config = loadBotConfig();
const env = loadRuntimeEnv();
const db = new BotDatabase(env.dbPath, config.performanceStartAt);

try {
  const scorecard = db.getWeatherForwardScorecard({
    since: config.weatherForwardPolicyStartAt ?? 0,
    policyVersion: config.weatherForwardPolicyVersion ?? "weather-unfrozen",
    positionSizeUsd: config.independentModelFlatPositionSize ?? config.minPositionSize,
    minResolvedTrades: config.weatherForwardMinResolvedTrades ?? 30,
    minReturnPct: config.weatherForwardMinReturnPct ?? 0.05
  });
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(scorecard, null, 2));
  } else {
    console.log([
      `Weather forward scorecard: ${scorecard.policyVersion}`,
      `Forward start: ${new Date(scorecard.since).toISOString()}`,
      `Selected: ${scorecard.uniqueCandidates} unique (${scorecard.observations} observations)` ,
      `Executed: ${scorecard.executedCandidates}; closed paper: ${scorecard.closedPaperPositions}`,
      `Resolved: ${scorecard.resolved}; W-L ${scorecard.wins}-${scorecard.losses}; win rate ${(scorecard.winRate * 100).toFixed(1)}%`,
      `Settlement: $${scorecard.settlementPnl.toFixed(2)} (${(scorecard.settlementReturnPct * 100).toFixed(2)}%)`,
      `Overseer paper exits: $${scorecard.paperPnl.toFixed(2)} (${(scorecard.paperReturnPct * 100).toFixed(2)}%)`,
      `Brier: model ${formatOptional(scorecard.modelBrierScore)} vs market ${formatOptional(scorecard.marketBrierScore)}`,
      `Promotion: ${scorecard.promotionEligible ? "ELIGIBLE" : "NOT ELIGIBLE"} - ${scorecard.promotionReason}`
    ].join("\n"));
  }
} finally {
  db.close();
}

function formatOptional(value: number | undefined): string {
  return value === undefined ? "n/a" : value.toFixed(4);
}
