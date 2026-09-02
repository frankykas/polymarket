import { loadBotConfig, loadRuntimeEnv } from "./config.js";
import { BotDatabase } from "./db.js";
import { EXECUTION_RESEARCH_STRATEGIES, executionPolicyStartAt, executionPolicyVersion } from "./research/executionPolicy.js";
import type { ExecutionResearchScorecard, ExecutionResearchStrategy } from "./types.js";

const config = loadBotConfig();
const env = loadRuntimeEnv();
const db = new BotDatabase(env.dbPath, config.performanceStartAt);
const strategies: ExecutionResearchStrategy[] = EXECUTION_RESEARCH_STRATEGIES;

try {
  const scorecards = strategies.map((strategy) => db.getExecutionResearchScorecard({
    strategy,
    policyVersion: executionPolicyVersion(config, strategy),
    since: executionPolicyStartAt(config, strategy),
    minResolved: config.executionResearchMinResolved ?? 200,
    minDistinctMarkets: config.executionResearchMinDistinctMarkets ?? 30,
    minReturnPct: config.executionResearchMinReturnPct ?? 0.02,
    minWinRate: config.executionResearchMinWinRate ?? 0.55
  }));
  if (process.argv.includes("--json")) console.log(JSON.stringify(scorecards, null, 2));
  else console.log(scorecards.map(formatScorecard).join("\n\n"));
} finally {
  db.close();
}

function formatScorecard(scorecard: ExecutionResearchScorecard): string {
  return [
    `${scorecard.strategy}: ${scorecard.policyVersion}`,
    `Prospective candidates: ${scorecard.candidates}; resolved: ${scorecard.resolved}; economic outcomes: ${scorecard.economicOutcomes}; completed/hedged round trips: ${scorecard.completed}; hedge misses: ${scorecard.hedgeMisses}; no-fill: ${scorecard.noFill}`,
    `Breadth: ${scorecard.distinctEvents} events / ${scorecard.distinctMarkets} markets`,
    `Net P&L excluding rewards/rebates: $${scorecard.pnlUsd.toFixed(2)} on $${scorecard.capitalUsd.toFixed(2)} (${(scorecard.returnPct * 100).toFixed(2)}%)`,
    `Wins/losses: ${scorecard.wins}/${scorecard.losses}; win rate ${(scorecard.winRate * 100).toFixed(1)}%`,
    `Median resolution latency: ${scorecard.medianLatencyMs === undefined ? "n/a" : `${scorecard.medianLatencyMs}ms`}`,
    `5m adverse-selection markout: ${scorecard.averageAdverseSelection5m === undefined ? "n/a" : `$${scorecard.averageAdverseSelection5m.toFixed(4)}`}`,
    `Promotion: ${scorecard.promotionEligible ? "ELIGIBLE" : "BLOCKED"} - ${scorecard.promotionReason}`
  ].join("\n");
}
