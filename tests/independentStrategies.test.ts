import test from "node:test";
import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { BotDatabase } from "../src/db.js";
import {
  evaluateCryptoThresholdPolicy,
  parseCryptoThresholdMarket,
  walkForwardCryptoCalibration
} from "../src/agents/cryptoThresholdStrategyAgent.js";
import {
  evaluateMacroCpiPolicy,
  blendCpiForecastWithNowcast,
  forecastCpiDistribution,
  forecastCpiDistributionV2,
  parseMacroCpiMarket,
  probabilityForCpiBucket,
  walkForwardCpiCalibration
} from "../src/agents/macroCpiStrategyAgent.js";
import { parseClevelandFedNowcastHtml } from "../src/research/macroNowcast.js";
import type { BotConfig, MarketSnapshot, WeatherOpportunity, WeatherTournamentObservation } from "../src/types.js";
import { rankAndDiversifyResearchSelections } from "../src/candidateRanking.js";
import {
  estimateWeatherExecutableBuy,
  selectUnattemptedWeatherValidationSpecs,
  selectWeatherValidationSpecs,
  summarizeForecastErrors
} from "../src/agents/weatherStrategyAgent.js";
import {
  buildWeatherTournamentReport,
  selectWeatherTournamentObservations,
  WEATHER_TOURNAMENT_VERSION
} from "../src/weatherStrategyTournament.js";

const policyConfig = {
  cryptoThresholdMinEntryPrice: 0.2,
  cryptoThresholdMaxEntryPrice: 0.8,
  cryptoThresholdMinProbabilityEdge: 0.08,
  cryptoThresholdMaxProbabilityEdge: 0.3,
  cryptoThresholdMinTimeToResolutionHours: 2,
  cryptoThresholdMaxTimeToResolutionHours: 36,
  macroCpiMinEntryPrice: 0.2,
  macroCpiMaxEntryPrice: 0.8,
  macroCpiMinProbabilityEdge: 0.08,
  macroCpiMaxProbabilityEdge: 0.3,
  macroCpiMinTimeToReleaseHours: 2,
  macroCpiMaxTimeToReleaseHours: 168
} as BotConfig;

test("weather validation prioritizes the most represented resolution stations", () => {
  const spec = (stationCode: string, targetDate: string) => ({
    city: stationCode,
    stationCode,
    targetDate,
    unit: "C" as const,
    bucket: "EXACT" as const,
    lower: 20,
    upper: 20
  });
  const selected = selectWeatherValidationSpecs([
    spec("RARE", "2026-08-17"),
    spec("BUSY", "2026-08-17"),
    spec("BUSY", "2026-08-18"),
    spec("MEDI", "2026-08-17"),
    spec("MEDI", "2026-08-18"),
    spec("MEDI", "2026-08-19")
  ], 2);
  assert.deepEqual(selected.map((item) => item.stationCode), ["MEDI", "BUSY"]);
});

test("weather validation immediately expands to stations missing from the current cache window", () => {
  const spec = (stationCode: string) => ({
    city: stationCode,
    stationCode,
    targetDate: "2026-08-18",
    unit: "C" as const,
    bucket: "EXACT" as const,
    lower: 20,
    upper: 20
  });
  const missing = selectUnattemptedWeatherValidationSpecs([
    spec("EDDM"),
    spec("LFPB"),
    spec("eglc"),
    spec("KLAX"),
    spec("KLGA")
  ], new Set(["EDDM", "EGLC"]));
  assert.deepEqual(missing.map((item) => item.stationCode), ["LFPB", "KLAX", "KLGA"]);
});

test("weather station validation uses an MAE confidence bound instead of sample count alone", () => {
  const stable = summarizeForecastErrors([0.5, -0.8, 1.1, -1.2, 0.7, -0.9, 1.4, -1.1, 0.6, -0.7, 1.0, -1.3]);
  assert.equal(stable.sampleSize, 12);
  assert.ok(stable.maeUpper95C < 3);
  assert.equal(stable.passed, true);

  const noisy = summarizeForecastErrors([0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6]);
  assert.ok(noisy.maeUpper95C > 3);
  assert.equal(noisy.passed, false);
  assert.equal(summarizeForecastErrors(Array(11).fill(0.2)).passed, false);
});

test("weather tournament freezes fixed-horizon incumbent and challenger observations without placing trades", () => {
  const now = Date.parse("2026-08-18T12:00:00Z");
  const opportunity = (overrides: Partial<WeatherOpportunity>): WeatherOpportunity => ({
    id: "weather-one",
    marketId: "market-no",
    tokenId: "token-no",
    outcome: "No",
    spec: {
      city: "Paris",
      stationCode: "LFPB",
      targetDate: "2026-08-19",
      unit: "C",
      bucket: "EXACT",
      lower: 25,
      upper: 25
    },
    fairProbability: 0.8,
    marketProbability: 0.55,
    marketMidProbability: 0.54,
    probabilityEdge: 0.25,
    expectedValuePct: 0.4,
    executableEntryPrice: 0.56,
    executableSizeUsd: 10,
    entryFeeUsd: 0,
    uncertainty: 0.2,
    agreement: 0.8,
    forecastSampleSize: 100,
    stationValidationPassed: true,
    resolutionTimestamp: now + 24 * 3_600_000,
    policyVersion: "weather-station-skill-v4",
    strategyEventKey: "weather:lfpb:2026-08-19",
    status: "WATCHLIST",
    reason: "test",
    createdAt: now,
    ...overrides
  });
  const selected = selectWeatherTournamentObservations({
    now,
    positionSizeUsd: 10,
    opportunities: [
      opportunity({}),
      opportunity({
        id: "weather-yes",
        marketId: "market-yes",
        tokenId: "token-yes",
        outcome: "Yes",
        fairProbability: 0.7,
        marketProbability: 0.4,
        marketMidProbability: 0.39,
        executableEntryPrice: 0.4,
        probabilityEdge: 0.3
      })
    ]
  });
  assert.equal(selected.length, 3);
  assert.equal(selected.find((row) => row.armId === "incumbent-no-h24")?.outcome, "No");
  assert.equal(selected.find((row) => row.armId === "two-sided-h24")?.outcome, "Yes");
  assert.ok(selected.every((row) => row.tournamentVersion === WEATHER_TOURNAMENT_VERSION));
});

test("weather tournament prices the full research size through executable ask depth", () => {
  const execution = estimateWeatherExecutableBuy({
    tokenId: "token",
    marketId: "market",
    timestamp: Date.now(),
    bestBid: 0.49,
    bestAsk: 0.5,
    depth: 100,
    bids: [{ price: 0.49, size: 100 }],
    asks: [{ price: 0.5, size: 10 }, { price: 0.51, size: 20 }]
  }, 10, 0.02);
  assert.ok(execution);
  assert.ok(execution.vwap > 0.5 && execution.vwap < 0.51);
  assert.equal(estimateWeatherExecutableBuy({
    tokenId: "thin",
    marketId: "market",
    timestamp: Date.now(),
    bestAsk: 0.5,
    depth: 1,
    bids: [],
    asks: [{ price: 0.5, size: 2 }]
  }, 10, 0.02), undefined);
});

test("weather tournament continues promising arms and kills jointly losing, underperforming arms at 30", () => {
  const observations = (won: boolean): WeatherTournamentObservation[] => Array.from({ length: 30 }, (_, index) => ({
    id: `obs-${won}-${index}`,
    tournamentVersion: WEATHER_TOURNAMENT_VERSION,
    armId: "incumbent-no-h24",
    armLabel: "Incumbent NO 24h",
    horizonHours: 24,
    horizonWindowHours: 1,
    stationCode: `K${String(index).padStart(3, "0")}`,
    targetDate: `2026-09-${String(index + 1).padStart(2, "0")}`,
    marketId: `market-${won}-${index}`,
    tokenId: `token-${index}`,
    outcome: "No",
    fairProbability: 0.8,
    marketProbability: 0.6,
    executableEntryPrice: 0.5,
    probabilityEdge: 0.3,
    expectedReturnPct: 0.6,
    positionSizeUsd: 10,
    entryFeeUsd: 0,
    uncertainty: 0.2,
    eligible: true,
    eligibilityReasons: [],
    resolutionTimestamp: Date.now() - 1,
    selectedAt: Date.now() - 2
  }));
  const winners = new Map(observations(true).map((row) => [row.marketId, "No"]));
  const promising = buildWeatherTournamentReport({
    observations: observations(true),
    marketForId: (marketId) => market({ id: marketId, winningOutcome: winners.get(marketId) })
  }).arms.find((arm) => arm.armId === "incumbent-no-h24");
  assert.equal(promising?.decision, "CONTINUE_TO_100");

  const losingRows = observations(false);
  const losing = buildWeatherTournamentReport({
    observations: losingRows,
    marketForId: (marketId) => market({ id: marketId, winningOutcome: "Yes" })
  }).arms.find((arm) => arm.armId === "incumbent-no-h24");
  assert.equal(losing?.decision, "KILL");
});

test("crypto parser accepts only Binance daily close-above thresholds", () => {
  const now = Date.parse("2026-08-11T12:00:00Z");
  const parsed = parseCryptoThresholdMarket(market({
    question: "Will the price of Bitcoin be above $64,000 on August 12?",
    endDate: "2026-08-12T16:00:00Z",
    raw: { description: "Resolved using the Binance 1 minute candle and its final \"Close\" price." }
  }), now);
  assert.deepEqual(parsed, {
    asset: "Bitcoin",
    symbol: "BTCUSDT",
    threshold: 64_000,
    targetTimestamp: Date.parse("2026-08-12T16:00:00Z")
  });
  assert.equal(parseCryptoThresholdMarket(market({
    question: "Will Bitcoin reach $64,000 by August 12?",
    endDate: "2026-08-12T16:00:00Z",
    raw: { description: "Binance 1 minute candle final \"Close\" price" }
  }), now), undefined);
});

test("crypto walk-forward validation is rolling and policy rejects extreme claims", () => {
  const history = Array.from({ length: 2_200 }, (_, index) => ({
    timestamp: Date.UTC(2026, 0, 1) + index * 3_600_000,
    close: 60_000 * Math.exp(index * 0.00001 + Math.sin(index / 17) * 0.002 + Math.sin(index / 83) * 0.01)
  }));
  const result = walkForwardCryptoCalibration(history);
  assert.ok(result && result.sampleSize >= 150);
  assert.ok(Number.isFinite(result.modelBrier));
  assert.equal(evaluateCryptoThresholdPolicy({ marketProbability: 0.5, probabilityEdge: 0.15, hours: 12 }, policyConfig).passed, true);
  assert.equal(evaluateCryptoThresholdPolicy({ marketProbability: 0.05, probabilityEdge: 0.7, hours: 60 }, policyConfig).passed, false);
});

test("scheduled CPI parser uses the official release timestamp rather than Gamma endDate", () => {
  const now = Date.parse("2026-08-11T12:00:00Z");
  const description = [
    "This market is about the seasonally adjusted Consumer Price Index (CPI) published by the Bureau of Labor Statistics (BLS).",
    "This market will resolve to the one-month change in July 2026.",
    "The CPI report is currently scheduled to be released on August 12, 2026, at 8:30 AM ET."
  ].join(" ");
  const parsed = parseMacroCpiMarket(market({
    question: "Will monthly inflation increase by 0.1% or more in July?",
    endDate: "2026-08-12T03:59:00Z",
    raw: { description }
  }), now);
  assert.deepEqual(parsed, {
    metric: "HEADLINE_MOM",
    bucket: "AT_LEAST",
    targetValue: 0.1,
    referenceYear: 2026,
    referenceMonth: 7,
    releaseTimestamp: Date.parse("2026-08-12T12:30:00Z")
  });
  assert.equal(parseMacroCpiMarket(market({
    question: "Will the Eurozone annual inflation be 2.0%?",
    endDate: "2026-08-12T03:59:00Z",
    raw: { description: description.replace("Bureau of Labor Statistics (BLS)", "Eurostat") }
  }), now), undefined);
});

test("CPI forecasts and walk-forward probabilities are finite and forward-only", () => {
  const observations = Array.from({ length: 84 }, (_, index) => ({
    period: `${2019 + Math.floor(index / 12)}-M${String(index % 12 + 1).padStart(2, "0")}`,
    timestamp: Date.UTC(2019 + Math.floor(index / 12), index % 12, 1),
    headlineMom: 0.2 + Math.sin(index / 5) * 0.08
  }));
  const distribution = forecastCpiDistribution(observations.slice(0, 60).map((row) => row.headlineMom), "HEADLINE_MOM");
  assert.ok(distribution && distribution.sampleSize > 0 && distribution.sigma > 0);
  const probability = probabilityForCpiBucket(distribution, { bucket: "EXACT", targetValue: 0.2 });
  assert.ok(probability >= 0 && probability <= 1);
  const result = walkForwardCpiCalibration(observations, "HEADLINE_MOM");
  assert.ok(result && result.sampleSize >= 150);
  assert.ok(Number.isFinite(result.modelBrier));
  const nested = forecastCpiDistributionV2(observations.slice(0, 60).map((row) => row.headlineMom), "HEADLINE_MOM");
  assert.ok(nested?.modelName);
  assert.ok(result && Object.values(result.modelUsage).reduce((sum, count) => sum + count, 0) > 0);
  assert.equal(evaluateMacroCpiPolicy({ marketProbability: 0.5, probabilityEdge: 0.15, hours: 24 }, policyConfig).passed, true);
});

test("Cleveland Fed CPI nowcasts are parsed and stored as immutable vintages", () => {
  const fetchedAt = Date.parse("2026-08-16T16:00:00Z");
  const html = `
    <table><caption>Inflation, month-over-month percent change</caption><tbody>
      <tr><td>August 2026</td><td>0.35</td><td>0.20</td><td>0.34</td><td>0.27</td><td>08/14</td></tr>
    </tbody></table>
    <table><caption>Inflation, year-over-year percent change</caption><tbody>
      <tr><td>August 2026</td><td>3.36</td><td>2.38</td><td>3.73</td><td>3.34</td><td>08/14</td></tr>
    </tbody></table>`;
  const [vintage] = parseClevelandFedNowcastHtml(html, fetchedAt);
  assert.equal(vintage.referencePeriod, "2026-M08");
  assert.equal(vintage.headlineMom, 0.35);
  assert.equal(vintage.coreYoy, 2.38);
  assert.equal(vintage.sourceUpdatedAt, Date.parse("2026-08-14T12:00:00Z"));
  const blended = blendCpiForecastWithNowcast({ point: 0.2, sigma: 0.1, sampleSize: 48 }, 0.35, "HEADLINE_MOM", 0.7);
  assert.ok(blended.point > 0.3 && blended.sigma >= 0.1);

  const path = "data/test-macro-vintages.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(`${path}${suffix}`); } catch { /* best effort */ }
  }
  const db = new BotDatabase(path);
  assert.equal(db.saveMacroForecastVintage(vintage), true);
  assert.equal(db.saveMacroForecastVintage(vintage), false);
  assert.deepEqual(db.getLatestMacroForecastVintage("2026-M08"), vintage);
  db.close();
});

test("research selection ranking freezes one no-trade CPI prediction per release", () => {
  const base = {
    id: "research-one",
    decision: "WATCHLIST" as const,
    marketId: "macro-one",
    tokenId: "yes-token",
    outcome: "YES" as const,
    side: "BUY" as const,
    confidence: 80,
    limitPrice: 0.5,
    alignedWallets: [],
    reason: "research",
    createdAt: 1,
    signalOrigin: "INDEPENDENT_MODEL" as const,
    strategyId: "macro_us_cpi_nested_v2",
    strategyEventKey: "macro:us-cpi:2026-M07",
    researchEligible: true,
    marketProbability: 0.5,
    probabilityEdge: 0.2,
    modelUncertainty: 0.2,
    modelAgreement: 0.8,
    entryBookDepth: 100
  };
  const firstMarket = market({ id: "macro-one" });
  const secondMarket = market({ id: "macro-two" });
  const ranked = rankAndDiversifyResearchSelections([
    { market: firstMarket, books: [], signal: base },
    { market: secondMarket, books: [], signal: { ...base, id: "research-two", marketId: "macro-two", probabilityEdge: 0.3 } }
  ]);
  assert.equal(ranked.selected.length, 1);
  assert.equal(ranked.skipped.length, 1);
  assert.equal(ranked.selected[0].signal.id, "research-two");
});

test("immutable research selections settle without paper orders and unlock only experimental paper", () => {
  const path = "data/test-macro-research-forward.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(`${path}${suffix}`); } catch { /* best effort */ }
  }
  const db = new BotDatabase(path);
  db.saveMarket(market({ id: "macro-resolved", active: false, closed: true, resolved: true, winningOutcome: "YES", feesEnabled: false }));
  db.saveStrategyBacktest({
    id: "macro-validation-pass",
    hypothesisId: "hypothesis_macro_scheduled_releases",
    cluster: "MACRO_RELEASE",
    testKind: "WALK_FORWARD_PROBABILITY",
    independentFromLeadWallets: true,
    sampleSize: 200,
    passed: true,
    metrics: { validationVersion: 3 },
    reason: "test pass",
    createdAt: 1_000
  });
  db.saveStrategyOpportunity({
    id: "macro-research-opportunity",
    signalId: "macro-research-signal",
    strategyId: "macro_us_cpi_nested_v2",
    cluster: "MACRO_RELEASE",
    marketId: "macro-resolved",
    tokenId: "yes-token",
    outcome: "YES",
    spec: { metric: "HEADLINE_MOM" },
    fairProbability: 0.7,
    marketProbability: 0.5,
    probabilityEdge: 0.2,
    expectedValuePct: 0.4,
    uncertainty: 0.2,
    agreement: 0.8,
    modelSampleSize: 48,
    modelVersion: "nested-walk-forward-v2",
    modelName: "AR1",
    policyVersion: "macro-v2",
    strategyEventKey: "macro:us-cpi:2026-M07",
    researchEligible: true,
    status: "RESEARCH_QUALIFIED",
    reason: "test",
    createdAt: 2_000
  });
  assert.equal(db.markStrategyOpportunityResearchSelected("macro-research-signal"), true);
  assert.equal(db.markStrategyOpportunityResearchSelected("macro-research-signal"), false);
  assert.equal(db.getForwardSelections(1)[0].selectionStage, "RESEARCH");
  const scorecard = db.getStrategyForwardScorecard({
    strategyId: "macro_us_cpi_nested_v2",
    cluster: "MACRO_RELEASE",
    since: 1_500,
    policyVersion: "macro-v2",
    positionSizeUsd: 5,
    minResolvedTrades: 1,
    minReturnPct: 0.05
  });
  assert.equal(scorecard.resolved, 1);
  assert.equal(scorecard.settlementPnl, 5);
  assert.equal(scorecard.executedCandidates, 0);
  assert.equal(scorecard.researchPromotionEligible, true);
  assert.equal(scorecard.experimentalPaperEligible, true);
  assert.equal(scorecard.standardPaperEligible, false);
  assert.equal(scorecard.promotionEligible, false);
  db.close();
});

test("generic forward scorecard records a strategy event only once across repeated scans", () => {
  const path = "data/test-independent-forward.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(`${path}${suffix}`); } catch { /* best effort */ }
  }
  const db = new BotDatabase(path);
  db.saveMarket(market({ id: "crypto-resolved", active: false, closed: true, resolved: true, winningOutcome: "YES" }));
  for (const signalId of ["signal-one", "signal-two"]) {
    db.saveStrategyOpportunity({
      id: `opp-${signalId}`,
      signalId,
      strategyId: "crypto_close_threshold_empirical_v1",
      cluster: "CRYPTO_THRESHOLD",
      marketId: "crypto-resolved",
      tokenId: "yes-token",
      outcome: "YES",
      spec: { symbol: "BTCUSDT", threshold: 64_000 },
      fairProbability: 0.65,
      marketProbability: 0.5,
      probabilityEdge: 0.15,
      expectedValuePct: 0.3,
      uncertainty: 0.2,
      agreement: 0.8,
      modelSampleSize: 100,
      policyVersion: "v1",
      strategyEventKey: "crypto:BTCUSDT:one-close",
      status: "CANDIDATE",
      reason: "test",
      createdAt: signalId === "signal-one" ? 2_000 : 3_000
    });
    db.markStrategyOpportunitySelected(signalId);
  }
  const scorecard = db.getStrategyForwardScorecard({
    strategyId: "crypto_close_threshold_empirical_v1",
    cluster: "CRYPTO_THRESHOLD",
    since: 1_000,
    policyVersion: "v1",
    positionSizeUsd: 5,
    minResolvedTrades: 1,
    minReturnPct: 0.05
  });
  assert.equal(scorecard.observations, 1);
  assert.equal(scorecard.uniqueCandidates, 1);
  assert.equal(scorecard.resolved, 1);
  assert.equal(scorecard.wins, 1);
  db.close();
});

function market(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    id: "market-1",
    question: "test",
    active: true,
    closed: false,
    archived: false,
    acceptingOrders: true,
    liquidity: 10_000,
    volume24h: 1_000,
    clobTokenIds: ["yes-token", "no-token"],
    outcomes: ["Yes", "No"],
    outcomePrices: [0.5, 0.5],
    ...overrides
  };
}
