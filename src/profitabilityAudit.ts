import { CRYPTO_THRESHOLD_STRATEGY_ID } from "./agents/cryptoThresholdStrategyAgent.js";
import { MACRO_CPI_STRATEGY_ID } from "./agents/macroCpiStrategyAgent.js";
import { computeCleanWalkForward } from "./cleanWalkForward.js";
import { loadBotConfig, loadRuntimeEnv } from "./config.js";
import { BotDatabase } from "./db.js";
import { EXECUTION_RESEARCH_STRATEGIES, executionPolicyEnabled, executionPolicyStartAt, executionPolicyVersion } from "./research/executionPolicy.js";
import type { ExecutionResearchScorecard, ExecutionResearchStrategy, StrategyBacktestResult, StrategyForwardScorecard, WeatherForwardScorecard } from "./types.js";

type LaneStage = "FAILED_POLICY" | "RESEARCH" | "FORWARD_VALIDATION" | "EXPERIMENTAL_PAPER" | "STANDARD_PAPER";

interface ProfitabilityLane {
  lane: string;
  stage: LaneStage;
  evidence: string;
  blocker: string;
  nextAction: string;
}

const config = loadBotConfig();
const env = loadRuntimeEnv();
const db = new BotDatabase(env.dbPath, config.performanceStartAt);

try {
  const actualPaper = db.getPerformanceReport();
  const cleanWalkForward = computeCleanWalkForward(db, config, {
    walletLimit: Number(process.env.WALK_FORWARD_WALLET_LIMIT || 60),
    historyLimit: Number(process.env.WALK_FORWARD_HISTORY_LIMIT || 1500)
  });
  const positionSizeUsd = config.independentModelFlatPositionSize ?? config.minPositionSize;
  const crypto = db.getStrategyForwardScorecard({
    strategyId: CRYPTO_THRESHOLD_STRATEGY_ID,
    cluster: "CRYPTO_THRESHOLD",
    since: config.cryptoThresholdForwardPolicyStartAt ?? 0,
    policyVersion: config.cryptoThresholdForwardPolicyVersion ?? "crypto-unfrozen",
    positionSizeUsd,
    minResolvedTrades: config.cryptoThresholdForwardMinResolvedTrades ?? 30,
    minReturnPct: config.cryptoThresholdForwardMinReturnPct ?? 0.05
  });
  const macro = db.getStrategyForwardScorecard({
    strategyId: MACRO_CPI_STRATEGY_ID,
    cluster: "MACRO_RELEASE",
    since: config.macroCpiForwardPolicyStartAt ?? 0,
    policyVersion: config.macroCpiForwardPolicyVersion ?? "macro-cpi-unfrozen",
    positionSizeUsd,
    minResolvedTrades: config.macroCpiForwardMinResolvedTrades ?? 30,
    minReturnPct: config.macroCpiForwardMinReturnPct ?? 0.05
  });
  const weather = db.getWeatherForwardScorecard({
    since: config.weatherForwardPolicyStartAt ?? 0,
    policyVersion: config.weatherForwardPolicyVersion ?? "weather-unfrozen",
    positionSizeUsd,
    minResolvedTrades: config.weatherForwardMinResolvedTrades ?? 30,
    minReturnPct: config.weatherForwardMinReturnPct ?? 0.05
  });
  const validations = db.getLatestStrategyBacktests();
  const executionPolicies = db.getExecutionResearchPolicyWindows();
  const execution = executionPolicies.map((window) => db.getExecutionResearchScorecard({
    strategy: window.strategy,
    policyVersion: window.policyVersion,
    since: window.firstObservedAt,
    minResolved: config.executionResearchMinResolved ?? 200,
    minDistinctMarkets: config.executionResearchMinDistinctMarkets ?? 30,
    minReturnPct: config.executionResearchMinReturnPct ?? 0.02,
    minWinRate: config.executionResearchMinWinRate ?? 0.55
  }));
  for (const strategy of EXECUTION_RESEARCH_STRATEGIES) {
    const policyVersion = executionPolicyVersion(config, strategy);
    if (execution.some((scorecard) => scorecard.strategy === strategy && scorecard.policyVersion === policyVersion)) continue;
    execution.push(db.getExecutionResearchScorecard({
      strategy,
      policyVersion,
      since: executionPolicyStartAt(config, strategy),
      minResolved: config.executionResearchMinResolved ?? 200,
      minDistinctMarkets: config.executionResearchMinDistinctMarkets ?? 30,
      minReturnPct: config.executionResearchMinReturnPct ?? 0.02,
      minWinRate: config.executionResearchMinWinRate ?? 0.55
    }));
  }
  const lanes: ProfitabilityLane[] = [
    {
      lane: "Delayed wallet copying",
      stage: cleanWalkForward.passed ? "FORWARD_VALIDATION" : "FAILED_POLICY",
      evidence: `${cleanWalkForward.allTestSources.executable} OOS executable copies, ${money(cleanWalkForward.allTestSources.pnl)}, ${pct(cleanWalkForward.allTestSources.avgReturnPct)} average return`,
      blocker: cleanWalkForward.reason,
      nextAction: "Keep wallets as hypothesis/discovery leads; do not admit wallet-following entries."
    },
    modelLane("Scheduled CPI", macro, validation(validations, "MACRO_RELEASE"), "Collect the new point-in-time official nowcast blend prospectively; do not backfill vintages."),
    modelLane("Crypto thresholds", crypto, validation(validations, "CRYPTO_THRESHOLD"), "Replace the losing volatility benchmark model before collecting paper entries."),
    weatherLane(weather, validation(validations, "WEATHER_FORECASTING")),
    ...execution.map(executionLane)
  ];
  const promotable = lanes.filter((lane) => lane.stage === "STANDARD_PAPER");
  const report = {
    generatedAt: Date.now(),
    verdict: promotable.length > 0
      ? `${promotable.length} strategy lane(s) passed standard-paper promotion.`
      : "No strategy currently has a validated profitable edge; entries must remain gated.",
    actualPaper: {
      pnlUsd: actualPaper.totalPnl,
      closedPositions: actualPaper.closedPositions,
      winRate: actualPaper.winRate
    },
    lanes,
    executionPolicies: execution
  };
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else {
    console.log("Profitability Control-Plane Audit");
    console.log(`Verdict: ${report.verdict}`);
    console.log(`Actual paper: ${money(actualPaper.totalPnl)} | ${actualPaper.closedPositions} closed | ${pct(actualPaper.winRate)} win rate`);
    console.log("");
    for (const lane of lanes) {
      console.log(`${lane.lane}: ${lane.stage}`);
      console.log(`  Evidence: ${lane.evidence}`);
      console.log(`  Blocker: ${lane.blocker}`);
      console.log(`  Next: ${lane.nextAction}`);
    }
  }
} finally {
  db.close();
}

function validation(rows: StrategyBacktestResult[], cluster: StrategyBacktestResult["cluster"]): StrategyBacktestResult | undefined {
  return rows.find((row) => row.cluster === cluster && row.testKind !== "DATA_AVAILABILITY");
}

function modelLane(name: string, scorecard: StrategyForwardScorecard, backtest: StrategyBacktestResult | undefined, nextAction: string): ProfitabilityLane {
  const stage: LaneStage = scorecard.standardPaperEligible ? "STANDARD_PAPER"
    : scorecard.experimentalPaperEligible ? "EXPERIMENTAL_PAPER"
      : backtest?.passed ? "FORWARD_VALIDATION" : "RESEARCH";
  return {
    lane: name,
    stage,
    evidence: `walk-forward ${backtest?.passed ? "passed" : "failed/pending"}; ${scorecard.resolved} resolved forward selections; ${money(scorecard.settlementPnl)} settlement P&L`,
    blocker: scorecard.promotionReason,
    nextAction
  };
}

function weatherLane(scorecard: WeatherForwardScorecard, backtest: StrategyBacktestResult | undefined): ProfitabilityLane {
  const stage: LaneStage = scorecard.standardPaperEligible ? "STANDARD_PAPER"
    : scorecard.experimentalPaperEligible ? "EXPERIMENTAL_PAPER"
      : backtest?.passed ? "FORWARD_VALIDATION" : "FAILED_POLICY";
  return {
    lane: "Weather forecasting",
    stage,
    evidence: `${backtest?.sampleSize ?? 0} forecast-skill samples; ${scorecard.resolved} resolved forward selections; ${money(scorecard.settlementPnl)} settlement P&L`,
    blocker: scorecard.promotionReason,
    nextAction: backtest?.passed
      ? "Keep the frozen policy unchanged and collect settled immutable selections plus strategy-attributed paper execution P&L."
      : "Do not tune the failed frozen policy; redesign station bias/horizon calibration before a new policy version."
  };
}

function executionLane(scorecard: ExecutionResearchScorecard): ProfitabilityLane {
  const configuredPolicy = scorecard.policyVersion === executionPolicyVersion(config, scorecard.strategy);
  const active = configuredPolicy && executionPolicyEnabled(config, scorecard.strategy);
  const failed = scorecard.economicOutcomes > 0 && scorecard.returnPct < 0;
  return {
    lane: `${scorecard.strategy} (${scorecard.policyVersion}${active ? ", active" : configuredPolicy ? ", frozen" : ""})`,
    stage: scorecard.promotionEligible ? "FORWARD_VALIDATION" : failed ? "FAILED_POLICY" : "FORWARD_VALIDATION",
    evidence: `${scorecard.candidates} candidates, ${scorecard.economicOutcomes} economic outcomes, ${scorecard.hedgeMisses} hedge misses, ${money(scorecard.pnlUsd)} on ${money(scorecard.capitalUsd)} (${pct(scorecard.returnPct)})`,
    blocker: scorecard.promotionReason,
    nextAction: executionNextAction(scorecard, active)
  };
}

function executionNextAction(scorecard: ExecutionResearchScorecard, active: boolean): string {
  if (!active) return "Preserve this frozen historical policy for comparison; do not collect more outcomes or merge it into an active scorecard.";
  if (scorecard.strategy === "MAKER_PAIR") {
    return "Collect inventory-aware fills and audit inventory age, maker closes, forced hedges, and restart-restored lots before any promotion.";
  }
  if (scorecard.strategy === "BINARY_PAIR_ARB") {
    return "Collect post-latency paired-FOK outcomes including one-leg hedge losses; the old same-snapshot profit is not promotion evidence.";
  }
  if (scorecard.strategy === "THRESHOLD_LADDER_ARB") {
    return "Collect post-latency monotonic threshold pairs across distinct markets; count partial execution and hedge failure against P&L.";
  }
  if (scorecard.strategy === "CROSS_MARKET_LATENCY") {
    return "Use the bounded tape sensitivity and untouched holdout to select a challenger, then freeze a separate prospective policy.";
  }
  return "Collect only complete-graph, executable all-leg outcomes and keep one-leg/partial execution risk in P&L.";
}

function money(value: number): string {
  return `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}
