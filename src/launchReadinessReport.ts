import { CRYPTO_THRESHOLD_STRATEGY_ID } from "./agents/cryptoThresholdStrategyAgent.js";
import { MACRO_CPI_STRATEGY_ID } from "./agents/macroCpiStrategyAgent.js";
import { loadBotConfig, loadRuntimeEnv } from "./config.js";
import { BotDatabase } from "./db.js";
import { evaluateLaunchControl, type LaunchLaneInput } from "./launchControl.js";

export const WEATHER_STRATEGY_ID = "weather_ensemble_fair_value_v2";

const config = loadBotConfig();
const env = loadRuntimeEnv();
const db = new BotDatabase(env.dbPath, config.performanceStartAt);

try {
  const positionSizeUsd = config.independentModelFlatPositionSize ?? config.minPositionSize;
  const validations = db.getLatestStrategyBacktests();
  const lanes: LaunchLaneInput[] = [
    {
      strategyId: WEATHER_STRATEGY_ID,
      label: "Weather forecasting",
      cluster: "WEATHER_FORECASTING",
      validationPassed: validations.some((row) => row.cluster === "WEATHER_FORECASTING" && row.passed),
      scorecard: db.getWeatherForwardScorecard({
        since: config.weatherForwardPolicyStartAt ?? 0,
        policyVersion: config.weatherForwardPolicyVersion ?? "weather-unfrozen",
        positionSizeUsd,
        minResolvedTrades: config.weatherForwardMinResolvedTrades ?? 30,
        minReturnPct: config.weatherForwardMinReturnPct ?? 0.05
      })
    },
    {
      strategyId: MACRO_CPI_STRATEGY_ID,
      label: "Scheduled CPI",
      cluster: "MACRO_RELEASE",
      validationPassed: validations.some((row) => row.cluster === "MACRO_RELEASE" && row.testKind === "WALK_FORWARD_PROBABILITY" && row.passed),
      scorecard: db.getStrategyForwardScorecard({
        strategyId: MACRO_CPI_STRATEGY_ID,
        cluster: "MACRO_RELEASE",
        since: config.macroCpiForwardPolicyStartAt ?? 0,
        policyVersion: config.macroCpiForwardPolicyVersion ?? "macro-cpi-unfrozen",
        positionSizeUsd,
        minResolvedTrades: config.macroCpiForwardMinResolvedTrades ?? 30,
        minReturnPct: config.macroCpiForwardMinReturnPct ?? 0.05
      })
    },
    {
      strategyId: CRYPTO_THRESHOLD_STRATEGY_ID,
      label: "Crypto thresholds",
      cluster: "CRYPTO_THRESHOLD",
      validationPassed: validations.some((row) => row.cluster === "CRYPTO_THRESHOLD" && row.testKind === "WALK_FORWARD_PROBABILITY" && row.passed),
      scorecard: db.getStrategyForwardScorecard({
        strategyId: CRYPTO_THRESHOLD_STRATEGY_ID,
        cluster: "CRYPTO_THRESHOLD",
        since: config.cryptoThresholdForwardPolicyStartAt ?? 0,
        policyVersion: config.cryptoThresholdForwardPolicyVersion ?? "crypto-unfrozen",
        positionSizeUsd,
        minResolvedTrades: config.cryptoThresholdForwardMinResolvedTrades ?? 30,
        minReturnPct: config.cryptoThresholdForwardMinReturnPct ?? 0.05
      })
    }
  ];
  const report = evaluateLaunchControl({
    lanes,
    actualPaper: db.getPerformanceReport(),
    paperMode: config.paperMode,
    // This repository intentionally contains no authenticated order-posting
    // path yet. These become true only after a separate security review.
    liveExecutionCodeReady: false,
    liveCredentialsConfigured: false
  });
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else {
    console.log("PMarke Launch Readiness");
    console.log(`Live canary: ${report.liveCanaryEligible ? "ELIGIBLE" : "BLOCKED"}`);
    console.log(`Selected research lane: ${report.selectedLane?.label ?? "none"} (${report.selectedLane?.stage ?? "n/a"})`);
    for (const lane of report.lanes) {
      console.log(`${lane.label}: ${lane.stage}; ${lane.resolved} resolved; settlement ${money(lane.settlementPnl)}; paper ${money(lane.paperPnl)}; ${lane.blocker}`);
    }
    console.log("Blockers:");
    for (const blocker of report.blockers) console.log(`- ${blocker}`);
    console.log(`Next milestone: ${report.nextMilestone}`);
  }
} finally {
  db.close();
}

function money(value: number): string {
  return `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;
}
