import { createHash } from "node:crypto";
import { CRYPTO_THRESHOLD_STRATEGY_ID } from "./agents/cryptoThresholdStrategyAgent.js";
import { MACRO_CPI_STRATEGY_ID } from "./agents/macroCpiStrategyAgent.js";
import { computeCleanWalkForward } from "./cleanWalkForward.js";
import { loadBotConfig, loadRuntimeEnv } from "./config.js";
import { BotDatabase } from "./db.js";
import { evaluateLaunchControl } from "./launchControl.js";
import { liveShadowPolicyVersion } from "./tradingPolicy.js";
import { EXECUTION_RESEARCH_STRATEGIES, executionPolicyStartAt, executionPolicyVersion } from "./research/executionPolicy.js";
import type { DailyCoreScorecard, DailyScorecardSnapshot, ExecutionResearchStrategy } from "./types.js";

const config = loadBotConfig();
const env = loadRuntimeEnv();
const db = new BotDatabase(env.dbPath, config.performanceStartAt);

try {
  const now = Date.now();
  const snapshotDate = new Date(now).toISOString().slice(0, 10);
  const policyFingerprint = createPolicyFingerprint();
  const positionSizeUsd = config.independentModelFlatPositionSize ?? config.minPositionSize;
  const cleanWalkForward = computeCleanWalkForward(db, config, {
    walletLimit: Number(process.env.WALK_FORWARD_WALLET_LIMIT || 60),
    historyLimit: Number(process.env.WALK_FORWARD_HISTORY_LIMIT || 1500),
    now
  });
  const macroCpi = db.getStrategyForwardScorecard({
    strategyId: MACRO_CPI_STRATEGY_ID,
    cluster: "MACRO_RELEASE",
    since: config.macroCpiForwardPolicyStartAt ?? 0,
    policyVersion: config.macroCpiForwardPolicyVersion ?? "macro-cpi-unfrozen",
    positionSizeUsd,
    minResolvedTrades: config.macroCpiForwardMinResolvedTrades ?? 30,
    minReturnPct: config.macroCpiForwardMinReturnPct ?? 0.05
  });
  const cryptoThreshold = db.getStrategyForwardScorecard({
    strategyId: CRYPTO_THRESHOLD_STRATEGY_ID,
    cluster: "CRYPTO_THRESHOLD",
    since: config.cryptoThresholdForwardPolicyStartAt ?? 0,
    policyVersion: config.cryptoThresholdForwardPolicyVersion ?? "crypto-unfrozen",
    positionSizeUsd,
    minResolvedTrades: config.cryptoThresholdForwardMinResolvedTrades ?? 30,
    minReturnPct: config.cryptoThresholdForwardMinReturnPct ?? 0.05
  });
  const weather = db.getWeatherForwardScorecard({
    since: config.weatherForwardPolicyStartAt ?? 0,
    policyVersion: config.weatherForwardPolicyVersion ?? "weather-unfrozen",
    positionSizeUsd,
    minResolvedTrades: config.weatherForwardMinResolvedTrades ?? 30,
    minReturnPct: config.weatherForwardMinReturnPct ?? 0.05
  });
  const executionStrategies: ExecutionResearchStrategy[] = EXECUTION_RESEARCH_STRATEGIES;
  const executionResearch = Object.fromEntries(executionStrategies.map((strategy) => [strategy, db.getExecutionResearchScorecard({
    strategy,
    policyVersion: executionPolicyVersion(config, strategy),
    since: executionPolicyStartAt(config, strategy),
    minResolved: config.executionResearchMinResolved ?? 200,
    minDistinctMarkets: config.executionResearchMinDistinctMarkets ?? 30,
    minReturnPct: config.executionResearchMinReturnPct ?? 0.02,
    minWinRate: config.executionResearchMinWinRate ?? 0.55
  })])) as Record<ExecutionResearchStrategy, ReturnType<BotDatabase["getExecutionResearchScorecard"]>>;
  const macroValidation = db.getLatestStrategyBacktests().find((item) =>
    item.cluster === "MACRO_RELEASE" && item.testKind === "WALK_FORWARD_PROBABILITY"
  );
  const cryptoValidation = db.getLatestStrategyBacktests().find((item) =>
    item.cluster === "CRYPTO_THRESHOLD" && item.testKind === "WALK_FORWARD_PROBABILITY"
  );
  const weatherValidation = db.getLatestStrategyBacktests().find((item) =>
    item.cluster === "WEATHER_FORECASTING" && item.testKind !== "DATA_AVAILABILITY"
  );
  const walkForwardPassed = macroValidation?.passed === true;
  const cleanForwardPositive = macroCpi.resolved > 0 && macroCpi.settlementPnl > 0;
  const researchPromotionEligible = walkForwardPassed && macroCpi.researchPromotionEligible;
  const experimentalPaperEligible = macroCpi.experimentalPaperEligible;
  const standardPaperEligible = macroCpi.standardPaperEligible;
  const actualPaper = db.getPerformanceReport();
  const launch = evaluateLaunchControl({
    lanes: [
      {
        strategyId: "weather_ensemble_fair_value_v2",
        label: "Weather forecasting",
        cluster: "WEATHER_FORECASTING",
        validationPassed: weatherValidation?.passed === true,
        scorecard: weather
      },
      {
        strategyId: MACRO_CPI_STRATEGY_ID,
        label: "Scheduled CPI",
        cluster: "MACRO_RELEASE",
        validationPassed: macroValidation?.passed === true,
        scorecard: macroCpi
      },
      {
        strategyId: CRYPTO_THRESHOLD_STRATEGY_ID,
        label: "Crypto thresholds",
        cluster: "CRYPTO_THRESHOLD",
        validationPassed: cryptoValidation?.passed === true,
        scorecard: cryptoThreshold
      }
    ],
    actualPaper,
    paperMode: config.paperMode,
    liveExecutionCodeReady: false,
    liveCredentialsConfigured: false,
    now
  });
  const liveReady = launch.liveCanaryEligible && launch.selectedLane?.strategyId === MACRO_CPI_STRATEGY_ID;
  const stage = liveReady
    ? "LIVE_READY"
    : standardPaperEligible
      ? "STANDARD_PAPER"
      : experimentalPaperEligible
        ? "EXPERIMENTAL_PAPER"
        : "RESEARCH";
  const scorecard: DailyCoreScorecard = {
    schemaVersion: 4,
    snapshotDate,
    createdAt: now,
    policyFingerprint,
    actualPaper,
    cleanWalkForward,
    forwardShadow: db.getForwardShadowScorecard(
      config.performanceStartAt ?? 0,
      liveShadowPolicyVersion(config),
      {
        blocked: config.blockedMarketCategories,
        allowed: config.allowedMarketCategories,
        enforceAllowlist: config.categoryTradingGateEnabled === true
      }
    ),
    independentStrategies: { macroCpi, cryptoThreshold, weather },
    executionResearch,
    primaryResearch: {
      cluster: "MACRO_RELEASE",
      stage,
      walkForwardPassed,
      cleanForwardPositive,
      researchPromotionEligible,
      experimentalPaperEligible,
      standardPaperEligible,
      liveReady,
      promotionEligible: standardPaperEligible,
      reason: !walkForwardPassed
        ? `CPI walk-forward validation has not passed: ${macroValidation?.reason ?? "no validation result"}`
        : !macroCpi.researchPromotionEligible
          ? `CPI clean research-forward gate has not passed: ${macroCpi.researchPromotionReason}`
          : !macroCpi.standardPaperEligible
            ? `CPI is eligible for experimental paper, but standard-paper gate has not passed: ${macroCpi.promotionReason}`
            : !liveReady
              ? "CPI standard-paper gate passed; live readiness still requires positive strategy and actual paper P&L"
              : "CPI walk-forward, clean research-forward, standard-paper, and live-readiness gates passed"
    },
    livePromotionGate: {
      passed: launch.liveCanaryEligible,
      reason: launch.liveCanaryEligible
        ? `${launch.selectedLane?.label ?? "selected strategy"} passed evidence, paper, execution, and operator launch gates`
        : `${launch.blockers.join("; ")}. Next: ${launch.nextMilestone}`,
      selectedStrategyId: launch.selectedLane?.strategyId,
      selectedCluster: launch.selectedLane?.cluster,
      selectedStage: launch.selectedLane?.stage,
      strategyEvidencePassed: launch.strategyEvidencePassed,
      paperCanaryEligible: launch.paperCanaryEligible,
      liveExecutionCodeReady: launch.liveExecutionCodeReady,
      blockers: launch.blockers,
      nextMilestone: launch.nextMilestone
    }
  };
  const snapshot: DailyScorecardSnapshot = {
    id: `daily-core:${snapshotDate}:${policyFingerprint}`,
    snapshotDate,
    policyFingerprint,
    scorecard,
    createdAt: now
  };
  const inserted = db.saveDailyScorecardSnapshot(snapshot);
  console.log(JSON.stringify({ inserted, snapshot }, null, 2));
} finally {
  db.close();
}

function createPolicyFingerprint(): string {
  const frozenPolicy = {
    scorecardSchemaVersion: 4,
    performanceStartAt: config.performanceStartAt ?? 0,
    walletLeadTradingEnabled: config.walletLeadTradingEnabled === true,
    liveShadowPolicyVersion: liveShadowPolicyVersion(config),
    blockedMarketCategories: config.blockedMarketCategories ?? [],
    allowedMarketCategories: config.allowedMarketCategories ?? [],
    categoryTradingGateEnabled: config.categoryTradingGateEnabled === true,
    walletCopyFlatPositionSize: config.walletCopyFlatPositionSize ?? config.shadowPositionSize,
    walletPromotion: {
      minTrades: config.minLiveExecutableShadowTradesForTrading,
      minPnl: config.minLiveExecutableShadowPnlForTrading,
      minReturn: config.liveExecutableMinReturnPct,
      minWinRate: config.minLiveExecutableShadowWinRateForTrading,
      minSourceSellRatio: config.minSourceSellRealizedRatio
    },
    macro: {
      policyVersion: config.macroCpiForwardPolicyVersion,
      policyStartAt: config.macroCpiForwardPolicyStartAt,
      minResolvedTrades: config.macroCpiForwardMinResolvedTrades,
      minReturnPct: config.macroCpiForwardMinReturnPct
    },
    weather: {
      policyVersion: config.weatherForwardPolicyVersion,
      policyStartAt: config.weatherForwardPolicyStartAt,
      minResolvedTrades: config.weatherForwardMinResolvedTrades,
      minReturnPct: config.weatherForwardMinReturnPct,
      validationStationLimit: config.weatherValidationStationLimit,
      validationLagDays: config.weatherValidationLagDays,
      validationVersion: 5
    },
    cryptoThreshold: {
      policyVersion: config.cryptoThresholdForwardPolicyVersion,
      policyStartAt: config.cryptoThresholdForwardPolicyStartAt,
      minResolvedTrades: config.cryptoThresholdForwardMinResolvedTrades,
      minReturnPct: config.cryptoThresholdForwardMinReturnPct
    },
    launchControl: {
      paperMode: config.paperMode,
      liveExecutionCodeReady: false,
      liveCredentialsConfigured: false
    },
    executionResearch: {
      makerResearchEnabled: config.makerResearchEnabled,
      crossMarketResearchEnabled: config.crossMarketResearchEnabled,
      marketScanLimit: config.marketScanLimit,
      universeLimit: config.executionResearchUniverseLimit,
      minVolume24h: config.executionResearchMinVolume24h,
      policies: Object.fromEntries(EXECUTION_RESEARCH_STRATEGIES
        .map((strategy) => [strategy, {
          policyVersion: executionPolicyVersion(config, strategy),
          policyStartAt: executionPolicyStartAt(config, strategy)
        }])),
      minResolved: config.executionResearchMinResolved,
      minDistinctMarkets: config.executionResearchMinDistinctMarkets,
      minReturnPct: config.executionResearchMinReturnPct,
      minWinRate: config.executionResearchMinWinRate,
      makerMinHedgeDepthMultiple: config.makerResearchMinHedgeDepthMultiple,
      makerMaxHedgeLossPct: config.makerResearchMaxHedgeLossPct,
      makerMaxPairEdge: config.makerResearchMaxPairEdge,
      makerQuotePriceBand: [config.makerResearchMinQuotePrice, config.makerResearchMaxQuotePrice],
      makerMaxLegSpread: config.makerResearchMaxLegSpread,
      makerMaxBookTimestampSkewMs: config.makerResearchMaxBookTimestampSkewMs,
      makerHedgeRefreshTimeoutMs: config.makerResearchHedgeRefreshTimeoutMs,
      thresholdLadder: {
        latencyMs: config.thresholdLadderExecutionLatencyMs,
        timeoutMs: config.thresholdLadderExecutionTimeoutMs,
        maxBookAgeMs: config.thresholdLadderMaxBookAgeMs,
        maxBookTimestampSkewMs: config.thresholdLadderMaxBookTimestampSkewMs,
        minDepthMultiple: config.thresholdLadderMinDepthMultiple
      }
    }
  };
  return createHash("sha256").update(JSON.stringify(frozenPolicy)).digest("hex").slice(0, 16);
}
