import test from "node:test";
import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { DecisionCouncil } from "../src/agents/decisionCouncil.js";
import { MarketIntelligenceAgent } from "../src/agents/marketIntelligenceAgent.js";
import { applyMicrostructureToQuality, MicrostructureAgent } from "../src/agents/microstructureAgent.js";
import { DataClient, GammaClient } from "../src/clients.js";
import { BotDatabase } from "../src/db.js";
import { OverseerAgent } from "../src/agents/overseerAgent.js";
import { RiskMitigationAgent } from "../src/agents/riskMitigationAgent.js";
import { mergeScores, selectDedicatedWeatherMarkets } from "../src/agents/signalAgent.js";
import { WalletIntelligenceAgent } from "../src/agents/walletIntelligenceAgent.js";
import { buildAdminDashboardReadModel, buildDashboardReadModel } from "../src/dashboard/readModel.js";
import {
  PaperExecutionEngine,
  applyPaperPerformanceToScore,
  applyShadowPerformanceToScore,
  decideExit,
  decideRisk,
  calculateDynamicPositionSize,
  discoverWallets,
  evaluateMarketQuality,
  generateSignals,
  generateSignalsWithDiagnostics,
  scoreWallet
} from "../src/engines.js";
import { AgentEventWriter } from "../src/events/eventWriter.js";
import { copyDelayPriceMovePct, estimateTapeExecutableShadow, takerFeeUsd } from "../src/liveExecution.js";
import { buildStrategyProfiles } from "../src/profiles/profiles.js";
import { publicWalletPreviews } from "../src/public/readModels.js";
import {
  runShadowBacktest,
  summarizeShadowBacktest,
  summarizeShadowPerformanceByWallet,
  summarizeShadowPerformanceByWalletAndCategory
} from "../src/shadowBacktest.js";
import { TelegramAlerts } from "../src/telegram.js";
import type { BotConfig, DailyCoreScorecard, MarketSnapshot, OrderBookSnapshot, ShadowTrade, TradeSignal, WalletScore, WalletTrade } from "../src/types.js";
import { inferMarketCategory } from "../src/walletIntelligence.js";
import { applyWalletResearchToScore, buildWalletResearchReport } from "../src/agents/walletResearchAgent.js";
import { clustersFor } from "../src/agents/strategyResearchAgent.js";
import { evaluateWeatherCandidatePolicy, parseWeatherMarket, probabilityForBucket } from "../src/agents/weatherStrategyAgent.js";
import { rankAndDiversifyCandidates } from "../src/candidateRanking.js";
import { categoryEligibility, isProspectiveWalletTrade, walletCopyPositionSize } from "../src/tradingPolicy.js";
import { excludeIneligibleShadowTrades } from "../src/shadowValidation.js";

const config: BotConfig = {
  paperMode: true,
  bankroll: 200,
  minPositionSize: 2,
  maxPositionSize: 5,
  maxOpenExposure: 25,
  reserveCashPct: 0.2,
  maxDailyLoss: 10,
  maxLossStreak: 3,
  maxTradesPerDay: 25,
  minSignalConfidence: 75,
  minWalletScore: 60,
  minAlignedWallets: 1,
  maxSpread: 0.08,
  minLiquidity: 1000,
  minOrderBookDepth: 50,
  minTimeToResolutionHours: 12,
  maxTimeToResolutionHours: 720,
  limitOrderTtlMs: 120000,
  takeProfitPct: 0.18,
  stopLossPct: 0.08,
  volumeSpikeMultiplier: 3,
  spreadExitThreshold: 0.12,
  priceReversalPct: 0.06,
  maxPositionHoldHours: 72,
  scanIntervalMs: 60000,
  walletActivityLimit: 100,
  marketScanLimit: 150,
  maxWatchedMarkets: 40,
  discoveryEnabled: true,
  discoveryMarketLimit: 40,
  discoveryTradesPerMarket: 100,
  minDiscoveryTrades: 5,
  minDiscoveryVolume: 50,
  maxDiscoveredWallets: 25,
  autoTrackDiscoveredWallets: true,
  shadowBacktestEnabled: true,
  shadowCandidateMinScore: 35,
  minShadowTradesForPromotion: 20,
  minShadowPnlForPromotion: 0,
  requireShadowProofForDiscovered: true,
  shadowCopyDelayMs: 30000,
  shadowMaxEntryPriceMovePct: 0.05,
  shadowPositionSize: 5,
  shadowHistoryLimit: 500,
  deepHistoryEnabled: true,
  deepHistoryWalletLimit: 8,
  deepHistoryPages: 3,
  deepHistoryPageSize: 100,
  resolutionBackfillLimit: 120
};

test("unknown shadow categories cannot bypass an explicit category allowlist", () => {
  const trade = { category: undefined } as ShadowTrade;
  assert.equal(excludeIneligibleShadowTrades([trade], {
    ...config,
    categoryTradingGateEnabled: true,
    allowedMarketCategories: []
  }).length, 0);
  assert.equal(excludeIneligibleShadowTrades([trade], {
    ...config,
    categoryTradingGateEnabled: true,
    allowedMarketCategories: ["other"]
  }).length, 1);
});

test("live and shadow share category eligibility and wallet-copy size", () => {
  const parityConfig: BotConfig = {
    ...config,
    minPositionSize: 5,
    maxPositionSize: 25,
    shadowPositionSize: 15,
    walletCopyFlatPositionSize: 10,
    blockedMarketCategories: ["sports"],
    allowedMarketCategories: ["politics", "other"]
  };
  assert.equal(walletCopyPositionSize(parityConfig), 10);
  assert.equal(categoryEligibility("politics", parityConfig).eligible, true);
  assert.equal(categoryEligibility("sports", parityConfig).eligible, false);
  assert.equal(categoryEligibility("crypto", parityConfig).eligible, false);
  assert.equal(categoryEligibility("politics", { ...parityConfig, allowedMarketCategories: [], categoryTradingGateEnabled: true }).eligible, false);
});

test("forward shadow evidence excludes deep-history backfill", () => {
  const since = 1_000_000;
  const forwardConfig: BotConfig = { ...config, performanceStartAt: since, forwardObservationMaxLagMs: 300_000 };
  const baseTrade: WalletTrade = {
    wallet: "0xforward",
    marketId: "m1",
    outcome: "YES",
    side: "BUY",
    price: 0.5,
    size: 100,
    timestamp: since + 60_000
  };
  assert.equal(isProspectiveWalletTrade({ ...baseTrade, observedAt: since + 120_000 }, forwardConfig), true);
  assert.equal(isProspectiveWalletTrade({ ...baseTrade, observedAt: since + 600_001 }, forwardConfig), false);
  assert.equal(isProspectiveWalletTrade(baseTrade, forwardConfig), false);
});

test("wallet-copy risk uses the frozen live-shadow parity size", () => {
  const decision = decideRisk(sampleSignal({
    decision: "TRADE_CANDIDATE",
    signalOrigin: "WALLET_LEAD",
    targetPositionSizeUsd: 10,
    confidence: 90
  }), { approved: true, score: 90, reasons: [] }, {
    openExposure: 0,
    dailyPnl: 0,
    lossStreak: 0,
    tradesToday: 0
  }, { ...config, minPositionSize: 5, maxPositionSize: 25, maxOpenExposure: 50, walletCopyFlatPositionSize: 10 });
  assert.equal(decision.decision, "APPROVE");
  assert.equal(decision.positionSize, 10);
  assert.equal(decision.sizingMethod, "SHADOW_PARITY_FLAT");
});

test("Gamma market discovery follows keyset pagination beyond the legacy 100-market cap", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: URL[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requestedUrls.push(url);
    const secondPage = url.searchParams.get("after_cursor") === "page-2";
    const count = secondPage ? 50 : 100;
    const offset = secondPage ? 100 : 0;
    return new Response(JSON.stringify({
      markets: Array.from({ length: count }, (_, index) => ({
        id: `market-${offset + index}`,
        question: `Market ${offset + index}`,
        active: true,
        closed: false,
        archived: false,
        clobTokenIds: ["yes", "no"],
        outcomes: ["YES", "NO"]
      })),
      next_cursor: secondPage ? undefined : "page-2"
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const markets = await new GammaClient("https://gamma.example").getMarkets(150);
    assert.equal(markets.length, 150);
    assert.equal(requestedUrls.length, 2);
    assert.equal(requestedUrls[0]?.pathname, "/markets/keyset");
    assert.equal(requestedUrls[1]?.searchParams.get("after_cursor"), "page-2");
    assert.equal(requestedUrls[1]?.searchParams.get("limit"), "50");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gamma dedicated weather discovery uses upcoming event search and returns complete ladders", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl: URL | undefined;
  globalThis.fetch = (async (input: string | URL | Request) => {
    requestedUrl = new URL(String(input));
    return new Response(JSON.stringify({
      events: [{
        id: "weather-event",
        slug: "temperature-city-date",
        title: "Highest temperature in Test City on August 19?",
        markets: [0, 1].map((index) => ({
          id: `weather-${index}`,
          question: `Will the highest temperature in Test City be ${20 + index}°C on August 19?`,
          active: true,
          closed: false,
          archived: false,
          acceptingOrders: true,
          clobTokenIds: [`yes-${index}`, `no-${index}`],
          outcomes: ["Yes", "No"]
        }))
      }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const markets = await new GammaClient("https://gamma.example").getWeatherMarkets({
      eventLimit: 80,
      endDateMin: Date.parse("2026-08-18T00:00:00Z"),
      endDateMax: Date.parse("2026-08-21T00:00:00Z")
    });
    assert.equal(markets.length, 2);
    assert.ok(markets.every((entry) => entry.eventId === "weather-event" && entry.eventMarketCount === 2));
    assert.equal(requestedUrl?.pathname, "/events/keyset");
    assert.equal(requestedUrl?.searchParams.get("title_search"), "highest temperature");
    assert.equal(requestedUrl?.searchParams.get("order"), "endDate");
    assert.equal(requestedUrl?.searchParams.get("end_date_min"), "2026-08-18T00:00:00.000Z");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dedicated weather admission prioritizes complete validated-station events", () => {
  const weather = (eventId: string, station: string, volume24h: number, bucket: number): MarketSnapshot => ({
    ...market,
    id: `${eventId}-${bucket}`,
    eventId,
    question: `Will the highest temperature in ${station} be ${20 + bucket}°C on August 19?`,
    endDate: "2026-08-19T12:00:00Z",
    volume24h,
    raw: { description: `Resolution uses ${station} Airport Station` }
  });
  const selected = selectDedicatedWeatherMarkets([
    weather("unvalidated", "LFPB", 10_000, 0),
    weather("unvalidated", "LFPB", 10_000, 1),
    weather("validated", "KATL", 10, 0),
    weather("validated", "KATL", 10, 1)
  ], new Set(["KATL"]), 1, Date.parse("2026-08-18T00:00:00Z"));
  assert.equal(selected.length, 2);
  assert.ok(selected.every((entry) => entry.eventId === "validated"));
});

test("Gamma terminal outcome prices override stale active and unresolved flags", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    markets: [{
      id: "terminal-market",
      question: "Resolved market",
      active: true,
      closed: false,
      resolved: false,
      acceptingOrders: true,
      clobTokenIds: ["yes", "no"],
      outcomes: ["YES", "NO"],
      outcomePrices: ["0.001", "0.999"]
    }]
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    const resolved = (await new GammaClient("https://gamma.example").getMarkets(1))[0];
    assert.equal(resolved.winningOutcome, "NO");
    assert.equal(resolved.resolved, true);
    assert.equal(resolved.active, false);
    assert.equal(resolved.closed, true);
    assert.equal(resolved.acceptingOrders, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gamma event discovery labels a complete sibling graph", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    id: "event-1",
    slug: "complete-event",
    markets: [0, 1, 2].map((index) => ({
      id: `market-${index}`,
      question: `Outcome ${index}`,
      active: true,
      closed: false,
      acceptingOrders: true,
      negRisk: true,
      clobTokenIds: [`yes-${index}`, `no-${index}`],
      outcomes: ["YES", "NO"]
    }))
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    const markets = await new GammaClient("https://gamma.example").getEventMarkets("event-1");
    assert.equal(markets.length, 3);
    assert.ok(markets.every((market) => market.eventId === "event-1" && market.eventMarketCount === 3));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Data API research requests include leaderboard periods and explicit trade role", async () => {
  const originalFetch = globalThis.fetch;
  const urls: URL[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url);
    if (url.pathname === "/v1/leaderboard") {
      return new Response(JSON.stringify([{ rank: "3", proxyWallet: "0x1111111111111111111111111111111111111111", userName: "research", pnl: 12, vol: 100 }]), { status: 200 });
    }
    return new Response(JSON.stringify([{ proxyWallet: "0x1111111111111111111111111111111111111111", side: "BUY", conditionId: "m1", asset: "yes", size: 20, price: 0.5, timestamp: 1000, outcome: "Yes" }]), { status: 200 });
  }) as typeof fetch;
  try {
    const client = new DataClient("https://data.example");
    const leaderboard = await client.getTraderLeaderboard({ category: "WEATHER", period: "MONTH", limit: 10 });
    const trades = await client.getWalletTradesByRole("0x1111111111111111111111111111111111111111", 100, false);
    assert.equal(leaderboard[0]?.category, "WEATHER");
    assert.equal(leaderboard[0]?.period, "MONTH");
    assert.equal(trades.length, 1);
    assert.equal(urls[0]?.searchParams.get("timePeriod"), "MONTH");
    assert.equal(urls[1]?.searchParams.get("takerOnly"), "false");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("wallet research identifies maker edge and blocks direct copy scoring", () => {
  const wallet = "0x1111111111111111111111111111111111111111";
  const allTrades: WalletTrade[] = Array.from({ length: 10 }, (_, index) => ({
    wallet,
    marketId: `weather-${index % 3}`,
    tokenId: `token-${index}`,
    outcome: "YES",
    side: index < 8 ? "BUY" : "SELL",
    price: 0.5,
    size: 40,
    timestamp: 1000 + index,
    raw: { transactionHash: `all-${index}`, title: "Will global temperature be hottest on record?" }
  }));
  const takerTrades = allTrades.slice(0, 2);
  const closed = Array.from({ length: 40 }, (_, index) => ({
    wallet,
    marketId: `closed-${index}`,
    title: "Will global temperature be hottest on record?",
    outcome: "YES",
    avgPrice: 0.5,
    totalBought: 100,
    realizedPnl: index < 28 ? 10 : -5,
    timestamp: 2000 + index
  }));
  const report = buildWalletResearchReport({
    wallet,
    name: "weather-research",
    entries: [
      { rank: 2, wallet, name: "weather-research", pnl: 100, volume: 1000, category: "WEATHER", period: "WEEK" },
      { rank: 1, wallet, name: "weather-research", pnl: 200, volume: 2000, category: "WEATHER", period: "MONTH" },
      { rank: 8, wallet, name: "weather-research", pnl: 500, volume: 5000, category: "WEATHER", period: "ALL" }
    ]
  }, allTrades, takerTrades, closed, 3000);
  assert.equal(report.archetype, "MAKER_SPECIALIST");
  assert.equal(report.recommendation, "MODEL_EDGE_ONLY");
  assert.equal(report.estimatedMakerShare, 0.8);
  assert.ok(report.patterns.some((pattern) => pattern.includes("weather/climate")));
  const adjusted = applyWalletResearchToScore({
    wallet,
    score: 90,
    copyabilityScore: 88,
    tradeCount: 100,
    recentTradeCount: 10,
    reliability: "HIGH",
    flags: [],
    updatedAt: 3000
  }, report);
  assert.ok(adjusted.flags.includes("RESEARCH_DO_NOT_COPY"));
  assert.ok((adjusted.copyabilityScore ?? 100) < 88);
});

test("wallet lead score and directional classification do not depend on observed bet size", () => {
  const wallet = "0x2222222222222222222222222222222222222222";
  const makeTrades = (size: number): WalletTrade[] => Array.from({ length: 40 }, (_, index) => ({
    wallet,
    marketId: `climate-${index}`,
    tokenId: `token-${index}`,
    outcome: "YES",
    side: "BUY",
    price: 0.5,
    size,
    timestamp: 1000 + index,
    raw: { transactionHash: `tx-${index}`, title: "Will this month be the hottest on record?" }
  }));
  const closed = Array.from({ length: 40 }, (_, index) => ({
    wallet,
    marketId: `closed-${index}`,
    title: "Will this month be the hottest on record?",
    outcome: "YES",
    avgPrice: 0.5,
    totalBought: 100,
    realizedPnl: index < 28 ? 10 : -5,
    timestamp: 2000 + index
  }));
  const candidate = {
    wallet,
    name: "size-independent-lead",
    entries: [
      { rank: 2, wallet, pnl: 100, volume: 1000, category: "WEATHER" as const, period: "WEEK" as const },
      { rank: 1, wallet, pnl: 200, volume: 2000, category: "WEATHER" as const, period: "MONTH" as const },
      { rank: 8, wallet, pnl: 500, volume: 5000, category: "WEATHER" as const, period: "ALL" as const }
    ]
  };
  const small = buildWalletResearchReport(candidate, makeTrades(1), makeTrades(1), closed, 3000);
  const large = buildWalletResearchReport(candidate, makeTrades(100), makeTrades(100), closed, 3000);
  assert.equal(small.archetype, "DIRECTIONAL_SPECIALIST");
  assert.equal(small.recommendation, "SHADOW_DIRECTIONAL");
  assert.equal(small.copyableAt10Rate, 0);
  assert.equal(large.copyableAt10Rate, 1);
  assert.equal(small.researchScore, large.researchScore);
  assert.ok(small.executionCompatibilityScore < large.executionCompatibilityScore);
});

const market: MarketSnapshot = {
  id: "m1",
  conditionId: "c1",
  question: "Will test pass?",
  active: true,
  closed: false,
  archived: false,
  acceptingOrders: true,
  endDate: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
  liquidity: 2500,
  volume24h: 5000,
  clobTokenIds: ["yes-token", "no-token"],
  outcomes: ["YES", "NO"],
  outcomePrices: [0.52, 0.48]
};

const book: OrderBookSnapshot = {
  tokenId: "yes-token",
  marketId: "m1",
  bids: [{ price: 0.51, size: 100 }],
  asks: [{ price: 0.53, size: 100 }],
  bestBid: 0.51,
  bestAsk: 0.53,
  spread: 0.02,
  depth: 200,
  timestamp: Date.now()
};

test("wallet scoring flags low-sample wallets and scores active wallets higher", () => {
  const trades: WalletTrade[] = Array.from({ length: 20 }, (_, index) => ({
    wallet: "0xabc",
    marketId: `m${index % 3}`,
    outcome: "YES",
    side: index < 10 ? "BUY" : "SELL",
    price: index < 10 ? 0.45 : 0.58,
    size: 10,
    timestamp: Date.now() + index * 60_000
  }));
  const score = scoreWallet({ address: "0xabc", enabled: true }, trades);
  assert.equal(score.reliability, "HIGH");
  assert.equal(score.flags.includes("LOW_SAMPLE"), false);
});

test("wallet scoring uses market context for configured wallet resolved stats", () => {
  const trades: WalletTrade[] = [
    {
      wallet: "0xconfigured",
      marketId: "resolved-config",
      outcome: "YES",
      side: "BUY",
      price: 0.5,
      size: 10,
      timestamp: Date.now()
    },
    {
      wallet: "0xconfigured",
      marketId: "sports-config",
      outcome: "YES",
      side: "BUY",
      price: 0.5,
      size: 10,
      timestamp: Date.now() + 60_000
    },
    {
      wallet: "0xconfigured",
      marketId: "sports-config",
      outcome: "YES",
      side: "SELL",
      price: 0.6,
      size: 10,
      timestamp: Date.now() + 120_000
    }
  ];
  const score = scoreWallet({ address: "0xconfigured", enabled: true }, trades, Date.now(), [
    { ...market, id: "resolved-config", resolved: true, winningOutcome: "YES" },
    { ...market, id: "sports-config", question: "Will the NBA team win tonight?" }
  ]);
  assert.equal(score.resolvedMarkets, 1);
  assert.equal(score.resolvedWins, 1);
  assert.equal(score.dominantCategory, "sports");
});


test("wallet discovery ranks active repeat traders and filters tiny samples", () => {
  const trades: WalletTrade[] = [
    ...Array.from({ length: 8 }, (_, index) => ({
      wallet: "0xgood",
      marketId: `m${index % 3}`,
      outcome: "YES",
      side: index < 6 ? "BUY" as const : "SELL" as const,
      price: index < 6 ? 0.4 : 0.6,
      size: 25,
      timestamp: Date.now() + index * 1000
    })),
    {
      wallet: "0xtiny",
      marketId: "m1",
      outcome: "YES",
      side: "BUY",
      price: 0.5,
      size: 1,
      timestamp: Date.now()
    }
  ];
  const wallets = discoverWallets(trades, config);
  assert.equal(wallets.length, 1);
  assert.equal(wallets[0].address, "0xgood");
  assert.ok(wallets[0].score > 35);
  assert.ok(wallets[0].copyabilityScore > 20);
  assert.equal(wallets[0].dominantCategory, "other");
  assert.ok(wallets[0].sampleConfidence > 0);
  assert.ok(wallets[0].winRateApprox > 0);
  assert.ok(wallets[0].avgReturnPctApprox > 0);
  assert.ok(wallets[0].avgHoldMinutesApprox >= 0);
  assert.equal(wallets[0].openPositionCount, 0);
});

test("wallet discovery can include open position previews", () => {
  const trades: WalletTrade[] = Array.from({ length: 6 }, (_, index) => ({
    wallet: "0xpositions",
    marketId: `m${index % 2}`,
    outcome: "YES",
    side: "BUY",
    price: 0.5,
    size: 20,
    timestamp: Date.now() + index * 1000
  }));
  const wallets = discoverWallets(trades, config, Date.now(), [{
    wallet: "0xpositions",
    marketId: "m1",
    outcome: "YES",
    size: 40,
    currentValue: 28,
    cashPnl: 8,
    percentPnl: 0.4
  }]);
  assert.equal(wallets[0].openPositionCount, 1);
  assert.equal(wallets[0].openPositionValue, 28);
  assert.equal(wallets[0].openPositionPnlApprox, 8);
});

test("wallet discovery caps tiny perfect win-rate samples", () => {
  const looseConfig = { ...config, minDiscoveryTrades: 1, minDiscoveryVolume: 1 };
  const trades: WalletTrade[] = [
    {
      wallet: "0xtinywinner",
      marketId: "m1",
      outcome: "YES",
      side: "BUY",
      price: 0.4,
      size: 30,
      timestamp: Date.now()
    },
    {
      wallet: "0xtinywinner",
      marketId: "m1",
      outcome: "YES",
      side: "SELL",
      price: 0.6,
      size: 10,
      timestamp: Date.now() + 60_000
    },
    {
      wallet: "0xtinywinner",
      marketId: "m2",
      outcome: "YES",
      side: "BUY",
      price: 0.4,
      size: 30,
      timestamp: Date.now() + 120_000
    }
  ];
  const wallets = discoverWallets(trades, looseConfig);
  assert.equal(wallets.length, 1);
  assert.ok(wallets[0].score <= 45);
  assert.ok(wallets[0].sampleConfidence < 0.2);
  assert.ok(wallets[0].flags.includes("WEAK_EVIDENCE"));
});

test("wallet discovery infers dominant market category", () => {
  const trades: WalletTrade[] = Array.from({ length: 8 }, (_, index) => ({
    wallet: "0xpolitics",
    marketId: "election-market",
    outcome: "YES",
    side: index < 4 ? "BUY" as const : "SELL" as const,
    price: index < 4 ? 0.4 : 0.58,
    size: 20,
    timestamp: Date.now() + index * 60_000
  }));
  const wallets = discoverWallets(trades, config, Date.now(), [], [{
    ...market,
    id: "election-market",
    question: "Will a Republican win the presidential election?"
  }]);
  assert.equal(wallets[0].dominantCategory, "politics");
  assert.ok(wallets[0].categoryConsistencyScore > 0);
});

test("wallet discovery attributes resolved market outcomes when available", () => {
  const trades: WalletTrade[] = [
    {
      wallet: "0xresolved",
      marketId: "resolved-win",
      outcome: "YES",
      side: "BUY",
      price: 0.4,
      size: 10,
      timestamp: Date.now()
    },
    {
      wallet: "0xresolved",
      marketId: "resolved-loss",
      outcome: "NO",
      side: "BUY",
      price: 0.4,
      size: 10,
      timestamp: Date.now() + 60_000
    },
    ...Array.from({ length: 4 }, (_, index) => ({
      wallet: "0xresolved",
      marketId: `open-${index}`,
      outcome: "YES",
      side: "BUY" as const,
      price: 0.5,
      size: 30,
      timestamp: Date.now() + (index + 2) * 60_000
    }))
  ];
  const wallets = discoverWallets(trades, config, Date.now(), [], [
    { ...market, id: "resolved-win", resolved: true, winningOutcome: "YES" },
    { ...market, id: "resolved-loss", resolved: true, winningOutcome: "YES" }
  ]);
  assert.equal(wallets[0].resolvedMarkets, 2);
  assert.equal(wallets[0].resolvedWins, 1);
  assert.equal(wallets[0].resolvedLosses, 1);
  assert.equal(wallets[0].resolvedWinRate, 0.5);
});

test("market quality rejects wide spread and low liquidity", () => {
  const bad = evaluateMarketQuality({ ...market, liquidity: 10 }, [{ ...book, spread: 0.2, depth: 10 }], config);
  assert.equal(bad.approved, false);
  assert.match(bad.reasons.join(" "), /liquidity/);
  assert.match(bad.reasons.join(" "), /spread/);
});

test("market quality rejects far-dated capital lockup markets", () => {
  const farDated = evaluateMarketQuality({
    ...market,
    endDate: new Date(Date.now() + 900 * 60 * 60 * 1000).toISOString()
  }, [book], config);
  assert.equal(farDated.approved, false);
  assert.match(farDated.reasons.join(" "), /capital lockup/);
});

test("market quality can allow longer paper-exploration horizons", () => {
  const longerDatedMarket = {
    ...market,
    endDate: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
  };
  const liveReadyQuality = evaluateMarketQuality(longerDatedMarket, [book], { ...config, maxTimeToResolutionHours: 504 });
  const explorationQuality = evaluateMarketQuality(longerDatedMarket, [book], { ...config, maxTimeToResolutionHours: 2880 });

  assert.equal(liveReadyQuality.approved, false);
  assert.equal(explorationQuality.approved, true);
});

test("microstructure agent downgrades stale and thin order books", () => {
  const agent = new MicrostructureAgent();
  const staleThinBook: OrderBookSnapshot = {
    ...book,
    asks: [{ price: 0.65, size: 1 }],
    bestAsk: 0.65,
    spread: 0.14,
    depth: 2,
    timestamp: Date.now() - 180_000
  };
  const report = agent.review(market, [staleThinBook], config);
  const quality = applyMicrostructureToQuality(evaluateMarketQuality(market, [book], config), report);
  assert.equal(report.state, "STALE");
  assert.equal(quality.approved, false);
  assert.match(quality.reasons.join(" "), /microstructure/);
});

test("wallet intelligence penalizes clustered low-evidence source alignment", () => {
  const agent = new WalletIntelligenceAgent();
  const signal = sampleSignal({ alignedWallets: ["0xa", "0xb"], confidence: 84 });
  const scores: WalletScore[] = [
    { wallet: "0xa", score: 70, copyabilityScore: 55, sampleConfidence: 0.2, tradeCount: 3, recentTradeCount: 3, reliability: "LOW", flags: [], updatedAt: Date.now() },
    { wallet: "0xb", score: 72, copyabilityScore: 58, sampleConfidence: 0.2, tradeCount: 4, recentTradeCount: 4, reliability: "LOW", flags: [], updatedAt: Date.now() }
  ];
  const trades: WalletTrade[] = [
    { wallet: "0xa", marketId: "m1", outcome: "YES", side: "BUY", price: 0.52, size: 5, timestamp: Date.now() },
    { wallet: "0xb", marketId: "m1", outcome: "YES", side: "BUY", price: 0.53, size: 5, timestamp: Date.now() + 10_000 }
  ];
  const report = agent.reviewSignal(signal, scores, trades);
  assert.equal(report.state, "WEAK_EVIDENCE");
  assert.ok(report.clusterPenalty > 0);
  assert.ok(report.confidenceModifier < 0);
});

test("decision council rejects when intelligence and microstructure disagree with raw signal", () => {
  const walletAgent = new WalletIntelligenceAgent();
  const marketAgent = new MarketIntelligenceAgent();
  const council = new DecisionCouncil();
  const microAgent = new MicrostructureAgent();
  const signal = sampleSignal({ confidence: 88, createdAt: Date.now() - 3 * 60 * 60 * 1000 });
  const scores: WalletScore[] = [
    { wallet: "0xabc", score: 82, copyabilityScore: 80, sampleConfidence: 0.8, tradeCount: 20, recentTradeCount: 6, reliability: "HIGH", flags: [], updatedAt: Date.now() }
  ];
  const staleReport = microAgent.review(market, [{ ...book, timestamp: Date.now() - 180_000 }], config);
  const walletReport = walletAgent.reviewSignal(signal, scores, [], Date.now());
  const marketBrief = marketAgent.review({ market, signal, books: [], scores, walletIntelligence: walletReport });
  const decision = council.review({
    signal,
    quality: applyMicrostructureToQuality(evaluateMarketQuality(market, [book], config), staleReport),
    riskState: { openExposure: 0, dailyPnl: 0, lossStreak: 0, tradesToday: 0 },
    config,
    marketIntelligence: marketBrief,
    microstructure: staleReport,
    walletIntelligence: walletReport
  });
  assert.equal(decision.consensus, "REJECT");
  assert.ok(decision.votes.some((vote) => vote.agent === "Microstructure Agent" && vote.vote === "REJECT"));
});

test("signal generation creates candidate when a scored wallet aligns", () => {
  const trades: WalletTrade[] = [{
    wallet: "0xabc",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    side: "BUY",
    price: 0.52,
    size: 10,
    timestamp: Date.now()
  }];
  const signals = generateSignals(market, [book], trades, [{
    wallet: "0xabc",
    score: 95,
    tradeCount: 10,
    recentTradeCount: 5,
    reliability: "HIGH",
    flags: [],
    updatedAt: Date.now()
  }], config);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].decision, "TRADE_CANDIDATE");
});

test("wallet activity stays research-only when direct wallet trading is disabled", () => {
  const trades: WalletTrade[] = [{
    wallet: "0xabc",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    side: "BUY",
    price: 0.52,
    size: 100,
    timestamp: Date.now()
  }];
  const signals = generateSignals(market, [book], trades, [{
    wallet: "0xabc",
    score: 95,
    tradeCount: 10,
    recentTradeCount: 5,
    reliability: "HIGH",
    flags: [],
    updatedAt: Date.now()
  }], { ...config, walletLeadTradingEnabled: false });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].decision, "WATCHLIST");
  assert.match(signals[0].reason, /research lead only/);
  assert.equal(signals[0].parityStatus, "FAIL");
});

test("wallet research non-copyable classification is a hard source gate", () => {
  const trades: WalletTrade[] = [{
    wallet: "0xabc",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    side: "BUY",
    price: 0.52,
    size: 100,
    timestamp: Date.now()
  }];
  const result = generateSignalsWithDiagnostics(market, [book], trades, [{
    wallet: "0xabc",
    score: 99,
    copyabilityScore: 99,
    tradeCount: 100,
    recentTradeCount: 20,
    reliability: "HIGH",
    flags: ["RESEARCH_DO_NOT_COPY"],
    updatedAt: Date.now()
  }], { ...config, paperExplorationEnabled: true });
  assert.equal(result.signals.length, 0);
  assert.equal(result.diagnostics.sourceRejectReasons["wallet research classified source edge as non-copyable"], 1);
});

test("wallet research directional candidate remains shadow-only until forward proof", () => {
  const trades: WalletTrade[] = [{
    wallet: "0xabc",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    side: "BUY",
    price: 0.52,
    size: 100,
    timestamp: Date.now()
  }];
  const base: WalletScore = {
    wallet: "0xabc",
    score: 99,
    copyabilityScore: 99,
    tradeCount: 100,
    recentTradeCount: 20,
    reliability: "HIGH",
    flags: ["RESEARCH_DIRECTIONAL_CANDIDATE", "RESEARCH_SHADOW_ONLY"],
    updatedAt: Date.now()
  };
  const blocked = generateSignalsWithDiagnostics(market, [book], trades, [base], {
    ...config,
    paperExplorationEnabled: true
  });
  assert.equal(blocked.signals.length, 0);
  assert.equal(blocked.diagnostics.sourceRejectReasons["research directional candidate awaits forward shadow proof"], 1);

  const proven = generateSignalsWithDiagnostics(market, [book], trades, [{
    ...base,
    flags: [...base.flags, "DURABLE_LIVE_EXECUTABLE_SHADOW", "SHADOW_PROVEN_COPYABLE"],
    liveExecutableShadowSimulated: 30,
    liveExecutableShadowPnl: 10,
    liveExecutableShadowAvgReturnPct: 0.1,
    liveExecutableShadowWinRate: 0.6,
    sourceSellRealizedRatio: 0.6
  }], {
    ...config,
    liveParityGateEnabled: true,
    minLiveExecutableShadowTradesForTrading: 30,
    minLiveExecutableShadowPnlForTrading: 0,
    liveExecutableMinReturnPct: 0.03,
    minLiveExecutableShadowWinRateForTrading: 0.55,
    minSourceSellRealizedRatio: 0.5
  });
  assert.equal(proven.signals.length, 1);
});

test("signal generation keeps extreme-priced copies off the trade candidate path", () => {
  const scores: WalletScore[] = [{
    wallet: "0xabc",
    score: 95,
    tradeCount: 10,
    recentTradeCount: 5,
    reliability: "HIGH",
    flags: [],
    updatedAt: Date.now()
  }];
  const favouriteBook: OrderBookSnapshot = { ...book, tokenId: "yes-token", bestAsk: 0.97, bestBid: 0.96, spread: 0.01 };
  const favouriteTrade: WalletTrade = {
    wallet: "0xabc", marketId: "m1", tokenId: "yes-token", outcome: "YES", side: "BUY", price: 0.97, size: 10, timestamp: Date.now()
  };
  const favourite = generateSignals(market, [favouriteBook], [favouriteTrade], scores, config)[0];
  assert.equal(favourite.decision, "WATCHLIST");

  const longshotBook: OrderBookSnapshot = { ...book, tokenId: "yes-token", bestAsk: 0.04, bestBid: 0.03, spread: 0.01 };
  const longshotTrade: WalletTrade = {
    wallet: "0xabc", marketId: "m1", tokenId: "yes-token", outcome: "YES", side: "BUY", price: 0.04, size: 10, timestamp: Date.now()
  };
  const longshot = generateSignals(market, [longshotBook], [longshotTrade], scores, config)[0];
  assert.equal(longshot.decision, "WATCHLIST");
});

test("signal generation requires shadow proof for discovered probation wallets", () => {
  const trade: WalletTrade = {
    wallet: "0xprobation", marketId: "m1", tokenId: "yes-token", outcome: "YES", side: "BUY", price: 0.52, size: 10, timestamp: Date.now()
  };
  const unproven: WalletScore = {
    wallet: "0xprobation",
    label: "discovered",
    score: 100,
    copyabilityScore: 100,
    categoryConsistencyScore: 70,
    sampleConfidence: 0.82,
    shadowSimulated: 25,
    shadowRealized: 10,
    shadowPnl: 12,
    shadowAvgReturnPct: 0.04,
    tradeCount: 40,
    recentTradeCount: 10,
    reliability: "HIGH",
    flags: [],
    updatedAt: Date.now()
  };
  assert.equal(generateSignals(market, [book], [trade], [unproven], config).length, 0);

  const proven: WalletScore = {
    ...unproven,
    flags: ["SHADOW_PROVEN_COPYABLE"]
  };
  const signals = generateSignals(market, [book], [trade], [proven], config);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].decision, "TRADE_CANDIDATE");
});

test("signal generation blocks wallets that underperform in shadow copy", () => {
  const trade: WalletTrade = {
    wallet: "0xbadcopy", marketId: "m1", tokenId: "yes-token", outcome: "YES", side: "BUY", price: 0.52, size: 10, timestamp: Date.now()
  };
  const badCopy: WalletScore = {
    wallet: "0xbadcopy",
    score: 91,
    copyabilityScore: 91,
    shadowSimulated: 60,
    shadowRealized: 20,
    shadowPnl: -30,
    tradeCount: 300,
    recentTradeCount: 20,
    reliability: "HIGH",
    flags: ["SHADOW_COPY_UNDERPERFORMS", "SHADOW_NEGATIVE_PNL"],
    updatedAt: Date.now()
  };
  assert.equal(generateSignals(market, [book], [trade], [badCopy], config).length, 0);
});

test("signal generation blocks stale-mark and no-sell source edges", () => {
  const trade: WalletTrade = {
    wallet: "0xstaleedge", marketId: "m1", tokenId: "yes-token", outcome: "YES", side: "BUY", price: 0.52, size: 10, timestamp: Date.now()
  };
  const base: WalletScore = {
    wallet: "0xstaleedge",
    score: 96,
    copyabilityScore: 96,
    categoryConsistencyScore: 80,
    sampleConfidence: 0.9,
    shadowSimulated: 60,
    shadowRealized: 1,
    shadowPnl: 50,
    tradeCount: 300,
    recentTradeCount: 20,
    reliability: "HIGH",
    flags: ["SHADOW_PROVEN_COPYABLE"],
    updatedAt: Date.now()
  };
  assert.equal(generateSignals(market, [book], [trade], [{ ...base, flags: ["SHADOW_PROVEN_COPYABLE", "SHADOW_MOSTLY_FALLBACK_MARKS"] }], config).length, 0);
  assert.equal(generateSignals(market, [book], [trade], [{ ...base, flags: ["SHADOW_PROVEN_COPYABLE", "NO_SELL_HISTORY"] }], config).length, 0);
});

test("signal generation blocks negative paper-copy sources", () => {
  const trade: WalletTrade = {
    wallet: "0xpaperbad",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    side: "BUY",
    price: 0.52,
    size: 10,
    timestamp: Date.now()
  };
  const source: WalletScore = {
    wallet: "0xpaperbad",
    score: 96,
    copyabilityScore: 96,
    shadowSimulated: 40,
    shadowRealized: 20,
    shadowPnl: 20,
    shadowAvgReturnPct: 0.06,
    sourceSellRealizedRatio: 0.45,
    liveExecutableShadowAvgReturnPct: 0.07,
    liveExecutableShadowPnl: 16,
    liveExecutableShadowSimulated: 18,
    liveExecutableShadowWinRate: 0.61,
    paperFilledOrders: 5,
    paperPnl: -4,
    paperAvgReturnPct: -0.05,
    paperScoreImpact: -4,
    tradeCount: 120,
    recentTradeCount: 12,
    reliability: "HIGH",
    flags: ["SHADOW_PROVEN_COPYABLE", "PAPER_COPY_UNDERPERFORMS"],
    updatedAt: Date.now()
  };
  const result = generateSignalsWithDiagnostics(market, [book], [trade], [source], {
    ...config,
    liveParityGateEnabled: true,
    blockPaperUnderperformers: true,
    minPaperFillsForTrading: 3,
    minPaperPnlForTrading: -3,
    minPaperAvgReturnPctForTrading: -0.02
  });
  assert.equal(result.signals.length, 0);
  assert.equal(result.diagnostics.sourceRejectReasons["negative paper copy"], 1);
});

test("signal generation requires two sources unless one source has strong realized shadow proof", () => {
  const strictConfig = { ...config, minAlignedWallets: 2 };
  const trade: WalletTrade = {
    wallet: "0xsolo",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    side: "BUY",
    price: 0.52,
    size: 10,
    timestamp: Date.now()
  };
  const weakSolo: WalletScore = {
    wallet: "0xsolo",
    score: 95,
    copyabilityScore: 95,
    shadowSimulated: 40,
    shadowRealized: 5,
    shadowPnl: 20,
    shadowAvgReturnPct: 0.06,
    tradeCount: 100,
    recentTradeCount: 10,
    reliability: "HIGH",
    flags: ["SHADOW_PROVEN_COPYABLE"],
    updatedAt: Date.now()
  };
  assert.equal(generateSignals(market, [book], [trade], [weakSolo], strictConfig).length, 0);

  const strongSolo: WalletScore = {
    ...weakSolo,
    shadowRealized: 12,
    sourceSellRealizedRatio: 0.55,
    shadowCategoryImpacts: { other: 2 }
  };
  assert.equal(generateSignals(market, [book], [trade], [strongSolo], strictConfig).length, 0);
  const singleSourceEnabledConfig = { ...strictConfig, allowSingleSourceSignals: true };
  assert.equal(generateSignals(market, [book], [trade], [strongSolo], singleSourceEnabledConfig)[0]?.decision, "TRADE_CANDIDATE");

  const secondTrade: WalletTrade = { ...trade, wallet: "0xsecond" };
  const twoSource = generateSignals(market, [book], [trade, secondTrade], [
    { ...weakSolo, wallet: "0xsolo", shadowRealized: 8 },
    { ...weakSolo, wallet: "0xsecond", reliability: "MEDIUM", shadowRealized: 8 }
  ], strictConfig);
  assert.equal(twoSource[0]?.alignedWallets.length, 2);
});

test("live parity gate requires executable return, source-sell proof, and entry depth", () => {
  const parityConfig: BotConfig = {
    ...config,
    liveParityGateEnabled: true,
    entryOrderPolicy: "FOK",
    maxEntrySlippage: 0.03,
    liveExecutableMinReturnPct: 0.03,
    minSourceSellRealizedRatio: 0.35,
    entryBookDepthMultiple: 3
  };
  const trade: WalletTrade = {
    wallet: "0xparity",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    side: "BUY",
    price: 0.52,
    size: 10,
    timestamp: 1000
  };
  const strong: WalletScore = {
    wallet: "0xparity",
    score: 96,
    copyabilityScore: 96,
    shadowSimulated: 40,
    shadowRealized: 20,
    shadowPnl: 20,
    shadowAvgReturnPct: 0.06,
    sourceSellRealizedRatio: 0.45,
    liveExecutableShadowAvgReturnPct: 0.07,
    liveExecutableShadowPnl: 16,
    liveExecutableShadowSimulated: 18,
    liveExecutableShadowWinRate: 0.61,
    tradeCount: 120,
    recentTradeCount: 12,
    reliability: "HIGH",
    flags: ["SHADOW_PROVEN_COPYABLE"],
    updatedAt: Date.now()
  };
  const passed = generateSignals(market, [book], [trade], [strong], parityConfig)[0];
  assert.equal(passed.decision, "TRADE_CANDIDATE");
  assert.equal(passed.parityStatus, "PASS");
  assert.ok((passed.entryDepthMultiple ?? 0) >= 3);

  const weakSource = generateSignals(market, [book], [trade], [{
    ...strong,
    sourceSellRealizedRatio: 0.1,
    liveExecutableShadowAvgReturnPct: 0.01
  }], parityConfig);
  assert.equal(weakSource.length, 0);

  const shallowBook: OrderBookSnapshot = { ...book, asks: [{ price: 0.53, size: 8 }], depth: 58 };
  const weak = generateSignals(market, [shallowBook], [trade], [strong], parityConfig)[0];
  assert.equal(weak.decision, "WATCHLIST");
  assert.equal(weak.parityStatus, "FAIL");
  assert.match(weak.reason, /live parity failed/);
});

test("source metric gates can override old low-rate flags when config is loosened", () => {
  const looseLiveConfig: BotConfig = {
    ...config,
    liveParityGateEnabled: true,
    entryOrderPolicy: "FOK",
    minSourceSellRealizedRatio: 0.3,
    liveExecutableMinReturnPct: 0.03,
    entryBookDepthMultiple: 3,
    maxEntrySlippage: 0.03
  };
  const trade: WalletTrade = {
    wallet: "0xloosened",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    side: "BUY",
    price: 0.52,
    size: 10,
    timestamp: Date.now()
  };
  const formerlyFlagged: WalletScore = {
    wallet: "0xloosened",
    score: 95,
    copyabilityScore: 95,
    shadowSimulated: 40,
    shadowRealized: 20,
    shadowPnl: 20,
    shadowAvgReturnPct: 0.06,
    sourceSellRealizedRatio: 0.31,
    liveExecutableShadowSimulated: 12,
    liveExecutableShadowPnl: 4,
    liveExecutableShadowAvgReturnPct: 0.04,
    liveExecutableShadowWinRate: 0.58,
    tradeCount: 100,
    recentTradeCount: 10,
    reliability: "HIGH",
    flags: ["SHADOW_PROVEN_COPYABLE", "LOW_SOURCE_SELL_REALIZATION", "LOW_LIVE_EXECUTABLE_SHADOW_RATE"],
    updatedAt: Date.now()
  };
  const signal = generateSignals(market, [book], [trade], [formerlyFlagged], looseLiveConfig)[0];
  assert.equal(signal?.decision, "TRADE_CANDIDATE");

  const negative = generateSignals(market, [book], [trade], [{
    ...formerlyFlagged,
    flags: [...formerlyFlagged.flags, "LIVE_EXECUTABLE_SHADOW_NEGATIVE"]
  }], looseLiveConfig);
  assert.equal(negative.length, 0);
});

test("paper exploration can collect evidence from strong unproven sources", () => {
  const explorationConfig: BotConfig = {
    ...config,
    paperExplorationEnabled: true,
    liveParityGateEnabled: true,
    entryOrderPolicy: "FOK",
    maxEntrySlippage: 0.03,
    paperExplorationMinConfidence: 75,
    paperExplorationMinSourceSellRealizedRatio: 0.25,
    paperExplorationEntryDepthMultiple: 3
  };
  const trade: WalletTrade = {
    wallet: "0xexplore",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    side: "BUY",
    price: 0.52,
    size: 40,
    timestamp: Date.now()
  };
  const strongUnproven: WalletScore = {
    wallet: "0xexplore",
    label: "discovered",
    score: 88,
    copyabilityScore: 86,
    categoryConsistencyScore: 74,
    sampleConfidence: 0.72,
    sourceSellRealizedRatio: 0.31,
    tradeCount: 80,
    recentTradeCount: 10,
    reliability: "HIGH",
    flags: ["SHADOW_PROVEN_COPYABLE"],
    updatedAt: Date.now()
  };

  const signal = generateSignals(market, [book], [trade], [strongUnproven], explorationConfig)[0];
  assert.equal(signal?.decision, "TRADE_CANDIDATE");
  assert.equal(signal.parityStatus, "UNKNOWN");
  assert.match(signal.reason, /paper exploration/);
});

test("paper exploration blocks sources once live-exec evidence is negative", () => {
  const explorationConfig: BotConfig = {
    ...config,
    paperExplorationEnabled: true,
    liveParityGateEnabled: true,
    entryOrderPolicy: "FOK",
    maxEntrySlippage: 0.03,
    paperExplorationMinConfidence: 75,
    paperExplorationMinSourceSellRealizedRatio: 0.25,
    paperExplorationEntryDepthMultiple: 3,
    paperProbationKnownBadLiveExecTrades: 3
  };
  const trade: WalletTrade = {
    wallet: "0xbadlive",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    side: "BUY",
    price: 0.52,
    size: 40,
    timestamp: Date.now()
  };
  const knownBad: WalletScore = {
    wallet: "0xbadlive",
    label: "discovered",
    score: 92,
    copyabilityScore: 90,
    categoryConsistencyScore: 80,
    sampleConfidence: 0.8,
    sourceSellRealizedRatio: 0.7,
    liveExecutableShadowSimulated: 3,
    liveExecutableShadowPnl: -0.5,
    liveExecutableShadowAvgReturnPct: -0.01,
    liveExecutableShadowWinRate: 0,
    tradeCount: 100,
    recentTradeCount: 12,
    reliability: "HIGH",
    flags: ["SHADOW_PROVEN_COPYABLE"],
    updatedAt: Date.now()
  };

  const result = generateSignalsWithDiagnostics(market, [book], [trade], [knownBad], explorationConfig);
  assert.equal(result.signals.length, 0);
  assert.equal(result.diagnostics.sourceRejectReasons["negative live-executable shadow"], 1);
});

test("score merging keeps configured overrides ahead of discovered scores", () => {
  const audited: WalletScore = {
    wallet: "0xscout",
    label: "discovered",
    score: 42,
    copyabilityScore: 50,
    tradeCount: 80,
    recentTradeCount: 3,
    reliability: "LOW",
    flags: ["LOW_LIVE_EXECUTABLE_SHADOW_RATE"],
    updatedAt: Date.now()
  };
  const scout: WalletScore = {
    ...audited,
    label: "paper-exploration",
    score: 78,
    copyabilityScore: 82,
    reliability: "HIGH",
    flags: ["PAPER_EXPLORATION_SCOUT"]
  };

  const merged = mergeScores([scout], [audited]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].label, "paper-exploration");
  assert.equal(merged[0].score, 78);
  assert.ok(merged[0].flags.includes("PAPER_EXPLORATION_SCOUT"));
});

test("signal diagnostics explain stale buys and source-gate rejections", () => {
  const diagConfig: BotConfig = {
    ...config,
    liveParityGateEnabled: true,
    maxSourceBuyAgeMs: 60_000,
    minSourceSellRealizedRatio: 0.3,
    liveExecutableMinReturnPct: 0.03
  };
  const now = Date.now();
  const staleTrade: WalletTrade = {
    wallet: "0xstale",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    side: "BUY",
    price: 0.52,
    size: 10,
    timestamp: now - 120_000
  };
  const rejectedTrade: WalletTrade = {
    ...staleTrade,
    wallet: "0xnegative",
    timestamp: now
  };
  const result = generateSignalsWithDiagnostics(market, [book], [staleTrade, rejectedTrade], [
    {
      wallet: "0xstale",
      score: 90,
      tradeCount: 20,
      recentTradeCount: 5,
      reliability: "HIGH",
      flags: [],
      updatedAt: now
    },
    {
      wallet: "0xnegative",
      score: 90,
      liveExecutableShadowSimulated: 10,
      liveExecutableShadowPnl: -1,
      liveExecutableShadowAvgReturnPct: -0.01,
      sourceSellRealizedRatio: 0.8,
      tradeCount: 20,
      recentTradeCount: 5,
      reliability: "HIGH",
      flags: ["LIVE_EXECUTABLE_SHADOW_NEGATIVE"],
      updatedAt: now
    }
  ], diagConfig);
  assert.equal(result.signals.length, 0);
  assert.equal(result.diagnostics.dropReasons["source buy stale"], 1);
  assert.equal(result.diagnostics.sourceRejectReasons["negative live-executable shadow"], 1);
});

test("signal generation ignores stale source buys when a freshness window is configured", () => {
  const freshConfig: BotConfig = { ...config, maxSourceBuyAgeMs: 60_000 };
  const now = Date.now();
  const score: WalletScore = {
    wallet: "0xfreshness",
    score: 95,
    tradeCount: 20,
    recentTradeCount: 5,
    reliability: "HIGH",
    flags: [],
    updatedAt: now
  };
  const oldTrade: WalletTrade = {
    wallet: "0xfreshness",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    side: "BUY",
    price: 0.52,
    size: 10,
    timestamp: now - 120_000
  };
  const recentTrade: WalletTrade = { ...oldTrade, timestamp: now - 10_000 };

  assert.equal(generateSignals(market, [book], [oldTrade], [score], freshConfig).length, 0);
  assert.equal(generateSignals(market, [book], [recentTrade], [score], freshConfig)[0]?.decision, "TRADE_CANDIDATE");
});

test("paper exploration can use a wider source-buy freshness window", () => {
  const now = Date.now();
  const explorationConfig: BotConfig = {
    ...config,
    liveParityGateEnabled: true,
    paperExplorationEnabled: true,
    maxSourceBuyAgeMs: 60_000,
    paperExplorationMaxSourceBuyAgeMs: 5 * 60_000,
    paperExplorationMinConfidence: 75,
    paperExplorationMinSourceSellRealizedRatio: 0.25,
    paperExplorationEntryDepthMultiple: 3,
    entryOrderPolicy: "FOK",
    maxEntrySlippage: 0.03
  };
  const score: WalletScore = {
    wallet: "0xpaperfresh",
    label: "paper-exploration",
    score: 88,
    copyabilityScore: 86,
    sampleConfidence: 0.9,
    sourceSellRealizedRatio: 0.5,
    tradeCount: 80,
    recentTradeCount: 8,
    reliability: "HIGH",
    flags: ["PAPER_EXPLORATION_SCOUT"],
    updatedAt: now
  };
  const trade: WalletTrade = {
    wallet: "0xpaperfresh",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    side: "BUY",
    price: 0.52,
    size: 40,
    timestamp: now - 2 * 60_000
  };

  const strictResult = generateSignalsWithDiagnostics(market, [book], [trade], [score], {
    ...explorationConfig,
    paperExplorationEnabled: false
  });
  assert.equal(strictResult.signals.length, 0);
  assert.equal(strictResult.diagnostics.dropReasons["source buy stale"], 1);

  const explorationSignal = generateSignals(market, [book], [trade], [score], explorationConfig)[0];
  assert.equal(explorationSignal?.decision, "TRADE_CANDIDATE");
  assert.equal(explorationSignal.parityStatus, "UNKNOWN");
});

test("paper exploration candidate uses the paper confidence floor", () => {
  const explorationConfig: BotConfig = {
    ...config,
    minSignalConfidence: 74,
    liveParityGateEnabled: true,
    paperExplorationEnabled: true,
    paperExplorationMinConfidence: 64,
    paperExplorationMinSourceSellRealizedRatio: 0.25,
    paperExplorationEntryDepthMultiple: 3,
    entryOrderPolicy: "FOK",
    maxEntrySlippage: 0.03
  };
  const lowerAskBook: OrderBookSnapshot = {
    ...book,
    asks: [{ price: 0.34, size: 200 }],
    bestAsk: 0.34,
    spread: 0.01
  };
  const score: WalletScore = {
    wallet: "0xpaperfloor",
    label: "paper-exploration",
    score: 72,
    copyabilityScore: 70,
    sampleConfidence: 0.9,
    sourceSellRealizedRatio: 0.7,
    tradeCount: 80,
    recentTradeCount: 8,
    reliability: "HIGH",
    flags: ["PAPER_EXPLORATION_SCOUT"],
    updatedAt: Date.now()
  };
  const trade: WalletTrade = {
    wallet: "0xpaperfloor",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    side: "BUY",
    price: 0.34,
    size: 40,
    timestamp: Date.now()
  };

  const signal = generateSignals(market, [lowerAskBook], [trade], [score], explorationConfig)[0];

  assert.equal(signal?.confidence, 64);
  assert.equal(signal.decision, "TRADE_CANDIDATE");
  assert.equal(signal.parityStatus, "UNKNOWN");
});

test("shadow scoring demotes wallets that lose money when copied", () => {
  const winner = applyShadowPerformanceToScore({
    wallet: "0xwin", score: 65, copyabilityScore: 65, tradeCount: 40, recentTradeCount: 6,
    reliability: "MEDIUM", flags: [], sampleConfidence: 0.8, updatedAt: Date.now()
  }, {
    wallet: "0xwin", total: 40, simulated: 40, realized: 20, marked: 18, fallback: 2, pnl: 30,
    realizedPnl: 25, wins: 26, losses: 14, winRate: 0.65, avgReturnPct: 0.06, realizedAvgReturnPct: 0.08
  });
  const loser = applyShadowPerformanceToScore({
    wallet: "0xlose", score: 82, copyabilityScore: 82, tradeCount: 400, recentTradeCount: 20,
    reliability: "HIGH", flags: [], sampleConfidence: 0.9, updatedAt: Date.now()
  }, {
    wallet: "0xlose", total: 60, simulated: 60, realized: 25, marked: 30, fallback: 5, pnl: -40,
    realizedPnl: -35, wins: 18, losses: 42, winRate: 0.3, avgReturnPct: -0.05, realizedAvgReturnPct: -0.07
  });
  // The high-volume whale that copies badly should fall below the mid-tier copier.
  assert.ok((loser.shadowScoreImpact ?? 0) < 0);
  assert.ok(loser.flags.includes("SHADOW_COPY_UNDERPERFORMS"));
  assert.ok(loser.flags.includes("SHADOW_NEGATIVE_PNL"));
  assert.ok(winner.flags.includes("SHADOW_PROVEN_COPYABLE"));
  assert.ok(loser.score < winner.score + 15);
  assert.ok(winner.score > 65);
});

test("shadow scoring prefers realized source exits over stale marked edge", () => {
  const base: WalletScore = {
    wallet: "0xedge",
    score: 65,
    copyabilityScore: 65,
    tradeCount: 80,
    recentTradeCount: 8,
    reliability: "MEDIUM",
    flags: [],
    sampleConfidence: 0.9,
    updatedAt: Date.now()
  };
  const realized = applyShadowPerformanceToScore(base, {
    wallet: "0xedge",
    total: 40,
    simulated: 40,
    realized: 18,
    marked: 12,
    fallback: 2,
    pnl: 35,
    realizedPnl: 32,
    wins: 24,
    losses: 16,
    winRate: 0.6,
    avgReturnPct: 0.07,
    realizedAvgReturnPct: 0.1
  });
  const staleMarked = applyShadowPerformanceToScore(base, {
    wallet: "0xedge",
    total: 40,
    simulated: 40,
    realized: 2,
    marked: 34,
    fallback: 4,
    pnl: 35,
    realizedPnl: -4,
    wins: 22,
    losses: 18,
    winRate: 0.55,
    avgReturnPct: 0.07,
    realizedAvgReturnPct: -0.04
  });
  assert.ok((realized.shadowScoreImpact ?? 0) > (staleMarked.shadowScoreImpact ?? 0));
  assert.ok(realized.flags.includes("SHADOW_PROVEN_COPYABLE"));
  assert.equal(staleMarked.flags.includes("SHADOW_PROVEN_COPYABLE"), false);
});

test("risk vetoes exposure and approves healthy candidates", () => {
  const signal = sampleSignal();
  const quality = evaluateMarketQuality(market, [book], config);
  const approved = decideRisk(signal, quality, { openExposure: 0, dailyPnl: 0, lossStreak: 0, tradesToday: 0 }, config);
  assert.equal(approved.decision, "APPROVE");
  const rejected = decideRisk(signal, quality, { openExposure: 25, dailyPnl: 0, lossStreak: 0, tradesToday: 0 }, config);
  assert.equal(rejected.decision, "REJECT");
  const reserveConfig = { ...config, maxOpenExposure: 200 };
  const reserveRejected = decideRisk(signal, quality, { openExposure: 160, dailyPnl: 0, lossStreak: 0, tradesToday: 0 }, reserveConfig);
  assert.equal(reserveRejected.decision, "REJECT");
  assert.equal(reserveRejected.reason, "reserve cash protected");
  const dustRejected = decideRisk(signal, quality, { openExposure: 24.5, dailyPnl: 0, lossStreak: 0, tradesToday: 0 }, config);
  assert.equal(dustRejected.decision, "REJECT");
  assert.equal(dustRejected.reason, "remaining exposure below minimum position size");
});

test("paper execution fills limit orders against executable asks", () => {
  const executor = new PaperExecutionEngine();
  const order = executor.createOrder(sampleSignal(), { decision: "APPROVE", positionSize: 5, reason: "ok", profile: "Conservative" }, config);
  const simulated = executor.simulate(order, book);
  assert.equal(simulated.order.status, "FILLED");
  assert.equal(simulated.order.profile, "Conservative");
  assert.ok(simulated.fill);
  assert.ok(simulated.position);
  assert.equal(simulated.position.profile, "Conservative");
});

test("paper execution charges the market taker fee and creates immutable round trips", () => {
  const executor = new PaperExecutionEngine();
  const risk = { decision: "APPROVE" as const, positionSize: 5, reason: "ok", profile: "Conservative" as const };
  const firstOrder = executor.createOrder(sampleSignal({ id: "sig_fee_1" }), risk, config, undefined, 0.05);
  const secondOrder = executor.createOrder(sampleSignal({ id: "sig_fee_2" }), risk, config, undefined, 0.05);
  const first = executor.simulate(firstOrder, book);
  const second = executor.simulate(secondOrder, book);

  assert.equal(takerFeeUsd(100, 0.5, 0.05), 1.25);
  assert.ok((first.fill?.feeUsd ?? 0) > 0);
  assert.equal(first.position?.realizedPnl, -(first.fill?.feeUsd ?? 0));
  assert.notEqual(first.position?.id, second.position?.id);
});

test("sports metadata is classified and can be blocked before signal creation", () => {
  const sportsMarket: MarketSnapshot = {
    ...market,
    id: "sports-market",
    question: "Who wins this match?",
    raw: { sportsMarketType: "moneyline", gameStartTime: new Date().toISOString() }
  };
  assert.equal(inferMarketCategory(sportsMarket), "sports");
  const result = generateSignalsWithDiagnostics(sportsMarket, [book], [{
    wallet: "0xabc",
    marketId: sportsMarket.id,
    tokenId: "yes-token",
    outcome: "YES",
    side: "BUY",
    price: 0.52,
    size: 10,
    timestamp: Date.now()
  }], [{
    wallet: "0xabc",
    score: 90,
    tradeCount: 20,
    recentTradeCount: 5,
    reliability: "HIGH",
    flags: [],
    updatedAt: Date.now()
  }], { ...config, blockedMarketCategories: ["sports"] });
  assert.equal(result.signals.length, 0);
  assert.equal(result.diagnostics.dropReasons["blocked market category: sports"], 1);
});

test("FOK paper execution rejects partial entry fills", () => {
  const executor = new PaperExecutionEngine();
  const fokConfig: BotConfig = { ...config, entryOrderPolicy: "FOK", maxEntrySlippage: 0 };
  const thinBook: OrderBookSnapshot = {
    ...book,
    asks: [{ price: 0.53, size: 1 }],
    depth: 101
  };
  const order = executor.createOrder(sampleSignal(), { decision: "APPROVE", positionSize: 5, reason: "ok" }, fokConfig);
  const simulated = executor.simulate(order, thinBook);
  assert.equal(simulated.order.status, "EXPIRED");
  assert.equal(simulated.order.missedReason, "partial fill rejected by FOK");
  assert.equal(simulated.fill, undefined);
  assert.equal(simulated.position, undefined);
});

test("paper execution models FOK sell exits with executable liquidity", () => {
  const executor = new PaperExecutionEngine();
  const position = {
    id: "Aggressive:m1:yes-token",
    profile: "Aggressive" as const,
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    size: 10,
    avgEntryPrice: 0.5,
    currentPrice: 0.52,
    realizedPnl: 0,
    openedAt: Date.now(),
    updatedAt: Date.now(),
    status: "OPEN" as const
  };
  const exitConfig: BotConfig = { ...config, exitOrderPolicy: "FOK", maxExitSlippage: 0.02, orderTickSize: 0.01 };
  const order = executor.createExitOrder(position, exitConfig, 0.52);
  assert.equal(order.side, "SELL");
  assert.equal(order.price, 0.5);

  const filled = executor.simulate(order, { ...book, bids: [{ price: 0.51, size: 10 }], bestBid: 0.51 });
  assert.equal(filled.order.status, "FILLED");
  assert.equal(filled.fill?.side, "SELL");
  assert.equal(filled.fill?.price, 0.51);

  const missed = executor.simulate(order, { ...book, bids: [{ price: 0.51, size: 9 }], bestBid: 0.51 });
  assert.equal(missed.order.status, "EXPIRED");
  assert.equal(missed.order.missedReason, "partial fill rejected by FOK");
});

test("FAK paper execution expires zero-fill orders and cancels partial remainder", () => {
  const executor = new PaperExecutionEngine();
  const exitConfig: BotConfig = { ...config, exitOrderPolicy: "FAK", maxExitSlippage: 0.02, orderTickSize: 0.01 };
  const position = {
    id: "Aggressive:m1:yes-token",
    profile: "Aggressive" as const,
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    size: 10,
    avgEntryPrice: 0.5,
    currentPrice: 0.52,
    realizedPnl: 0,
    openedAt: Date.now(),
    updatedAt: Date.now(),
    status: "OPEN" as const
  };
  const order = executor.createExitOrder(position, exitConfig, 0.52);
  const noFill = executor.simulate(order, { ...book, bids: [], bestBid: undefined });
  assert.equal(noFill.order.status, "EXPIRED");
  assert.equal(noFill.order.missedReason, "insufficient executable liquidity");

  const partial = executor.simulate(order, { ...book, bids: [{ price: 0.51, size: 4 }], bestBid: 0.51 });
  assert.equal(partial.order.status, "PARTIAL");
  assert.equal(partial.order.remainingSize, 0);
  assert.equal(partial.order.partialFillReason, "unfilled remainder cancelled by FAK");
  assert.equal(partial.fill?.size, 4);
});

test("paper execution supports urgent sell slippage overrides", () => {
  const executor = new PaperExecutionEngine();
  const position = {
    id: "Aggressive:m1:yes-token",
    profile: "Aggressive" as const,
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    size: 10,
    avgEntryPrice: 0.5,
    currentPrice: 0.44,
    realizedPnl: 0,
    openedAt: Date.now(),
    updatedAt: Date.now(),
    status: "OPEN" as const
  };
  const normal = executor.createExitOrder(position, { ...config, exitOrderPolicy: "FAK", maxExitSlippage: 0.02, orderTickSize: 0.01 }, 0.44);
  const urgent = executor.createExitOrder(position, { ...config, exitOrderPolicy: "FAK", maxExitSlippage: 0.02, orderTickSize: 0.01 }, 0.44, undefined, 0.08);
  assert.equal(normal.price, 0.42);
  assert.equal(urgent.price, 0.36);
});

test("paper execution uses token tick size overrides for entry and exit rounding", () => {
  const executor = new PaperExecutionEngine();
  const signal = sampleSignal({ limitPrice: 0.531 });
  const entry = executor.createOrder(signal, { decision: "APPROVE", positionSize: 5, reason: "ok" }, {
    ...config,
    entryOrderPolicy: "FOK",
    maxEntrySlippage: 0.002,
    orderTickSize: 0.01
  }, 0.005);
  assert.equal(entry.price, 0.535);

  const exit = executor.createExitOrder({
    id: "p_tick",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    size: 10,
    avgEntryPrice: 0.5,
    currentPrice: 0.527,
    realizedPnl: 0,
    openedAt: Date.now(),
    updatedAt: Date.now(),
    status: "OPEN"
  }, {
    ...config,
    exitOrderPolicy: "FOK",
    maxExitSlippage: 0.002,
    orderTickSize: 0.01
  }, 0.527, 0.005);
  assert.equal(exit.price, 0.525);
});

test("database rolls paper orders and positions into profile performance", () => {
  const path = "data/test-profile-performance.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch {
      // test cleanup is best effort
    }
  }
  const db = new BotDatabase(path);
  const executor = new PaperExecutionEngine();
  const order = executor.createOrder(sampleSignal(), { decision: "APPROVE", positionSize: 5, reason: "ok", profile: "Aggressive" }, config);
  const simulated = executor.simulate(order, book);
  db.saveRiskDecision({ decision: "APPROVE", positionSize: 5, reason: "ok", profile: "Aggressive" });
  db.savePaperOrder(simulated.order);
  assert.ok(simulated.position);
  db.savePosition({
    ...simulated.position,
    currentPrice: 0.65,
    realizedPnl: (0.65 - simulated.position.avgEntryPrice) * simulated.position.size,
    status: "CLOSED"
  });

  const profiles = db.getProfilePerformanceReports(10000);
  const aggressive = profiles.find((profile) => profile.profile === "Aggressive");
  const conservative = profiles.find((profile) => profile.profile === "Conservative");
  assert.equal(aggressive?.paperOrders, 1);
  assert.equal(aggressive?.closedPositions, 1);
  assert.ok((aggressive?.realizedPnl ?? 0) > 0);
  assert.equal(conservative?.paperOrders, 0);
  db.close();
});

test("performance epoch resets displayed PnL and risk counters without deleting history", () => {
  const path = "data/test-performance-epoch.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch {
      // test cleanup is best effort
    }
  }
  const now = Date.now();
  const epoch = now - 1_000;
  const db = new BotDatabase(path, epoch);
  db.savePosition({
    id: "old-position",
    profile: "Aggressive",
    marketId: "old-market",
    tokenId: "old-token",
    outcome: "YES",
    size: 10,
    avgEntryPrice: 0.5,
    currentPrice: 0,
    realizedPnl: -5,
    openedAt: now - 10_000,
    updatedAt: now - 500,
    status: "CLOSED"
  });
  db.savePosition({
    id: "new-position",
    profile: "Aggressive",
    marketId: "new-market",
    tokenId: "new-token",
    outcome: "YES",
    size: 10,
    avgEntryPrice: 0.5,
    currentPrice: 0.3,
    realizedPnl: -2,
    openedAt: now - 500,
    updatedAt: now - 100,
    status: "CLOSED"
  });
  for (const [id, createdAt, marketId, tokenId] of [
    ["old-order", now - 10_000, "old-market", "old-token"],
    ["new-order", now - 500, "new-market", "new-token"]
  ] as const) {
    db.savePaperOrder({
      id,
      signalId: `${id}-signal`,
      profile: "Aggressive",
      marketId,
      tokenId,
      outcome: "YES",
      side: "BUY",
      price: 0.5,
      size: 10,
      remainingSize: 0,
      status: "FILLED",
      createdAt,
      expiresAt: createdAt + 60_000,
      executionPolicy: "FOK"
    });
    db.saveFill({ id: `${id}-fill`, orderId: id, marketId, tokenId, side: "BUY", price: 0.5, size: 10, timestamp: createdAt });
    db.saveSignal(sampleSignal({ id: `${id}-signal`, marketId, tokenId, createdAt }));
  }

  const report = db.getPerformanceReport();
  assert.equal(report.performanceStartAt, epoch);
  assert.equal(report.closedPositions, 1);
  assert.equal(report.realizedPnl, -2);
  assert.equal(report.paperOrders, 1);
  assert.equal(report.paperFills, 1);
  assert.equal(report.signals, 1);
  assert.equal(db.getDailyRealizedPnl(), -2);
  assert.equal(db.getTradesToday(now), 1);
  assert.equal(db.getLossStreak(), 1);
  assert.equal(db.getPaperTradeLedger(500).length, 2);
  db.close();
});

test("paper entries merge into one tracked position and dashboard capital", () => {
  const path = "data/test-paper-capital.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch {
      // test cleanup is best effort
    }
  }
  const db = new BotDatabase(path);
  const first = db.savePaperEntry({
    id: "Conservative:m1:yes-token",
    profile: "Conservative",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    size: 10,
    avgEntryPrice: 0.5,
    currentPrice: 0.52,
    realizedPnl: 0,
    openedAt: 1000,
    updatedAt: 1000,
    status: "OPEN"
  });
  const second = db.savePaperEntry({
    ...first,
    size: 5,
    avgEntryPrice: 0.6,
    currentPrice: 0.62,
    openedAt: 2000,
    updatedAt: 2000
  });

  const report = db.getPerformanceReport();
  const dashboard = buildDashboardReadModel(db, 200);
  assert.equal(report.openPositions, 1);
  assert.equal(second.size, 15);
  assert.equal(Number(second.avgEntryPrice.toFixed(4)), 0.5333);
  assert.equal(Number(report.openCost.toFixed(2)), 8);
  assert.equal(Number(report.openValue.toFixed(2)), 9.3);
  assert.equal(Number(dashboard.capital.availableCash.toFixed(2)), 192);
  assert.equal(Number(dashboard.positions[0]?.entryCost.toFixed(2)), 8);
  db.close();
});

test("database reports paper order health and source paper performance", () => {
  const path = "data/test-order-health.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch {
      // test cleanup is best effort
    }
  }
  const db = new BotDatabase(path);
  const signal = { ...sampleSignal(), id: "sig_order_health", alignedWallets: ["0xsource"] };
  const executor = new PaperExecutionEngine();
  const order = executor.createOrder(signal, { decision: "APPROVE", positionSize: 5, reason: "ok", profile: "Aggressive" }, config);
  const simulated = executor.simulate(order, book);
  assert.ok(simulated.fill);
  assert.ok(simulated.position);
  db.saveSignal(signal);
  db.savePaperOrder(simulated.order);
  db.saveFill(simulated.fill);
  const position = db.savePaperEntry({ ...simulated.position, currentPrice: 0.65 });
  db.recordPaperEntryParity(signal, simulated.order, simulated.fill, position);

  const health = db.getOrderHealthReport(config.minPositionSize);
  const exposure = db.getExposureHealthReport(config.maxOpenExposure, config.bankroll, config.reserveCashPct);
  const sourcePerformance = db.getPaperSourcePerformance().get("0xsource");
  assert.equal(health.filledOrders, 1);
  assert.equal(health.dustFilledOrders, 0);
  assert.ok(health.avgFilledNotional >= config.minPositionSize);
  assert.equal(exposure.status, "AVAILABLE");
  assert.equal(exposure.activeExposureCap, 25);
  assert.ok((sourcePerformance?.pnl ?? 0) > 0);
  assert.equal(db.savePaperSourceFeedback(db.getPaperSourcePerformance().values()), 1);
  assert.equal(db.getPaperSourceFeedbackSummary().sources, 1);

  const adjusted = applyPaperPerformanceToScore({
    wallet: "0xsource",
    score: 65,
    copyabilityScore: 60,
    tradeCount: 20,
    recentTradeCount: 4,
    reliability: "MEDIUM",
    flags: [],
    updatedAt: Date.now()
  }, sourcePerformance);
  assert.ok(adjusted.score >= 65);
  db.close();
});

test("database exposes entry cooldown, open-position, daily trade, and loss-streak guards", () => {
  const path = "data/test-risk-guards.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch {
      // test cleanup is best effort
    }
  }
  const db = new BotDatabase(path);
  const now = Date.now();
  const signal = sampleSignal({
    id: "sig_guard",
    alignedWallets: ["0xsource"],
    createdAt: now - 1_000
  });
  db.saveSignal(signal);
  db.savePaperOrder({
    id: "ord_guard",
    signalId: signal.id,
    profile: "Aggressive",
    marketId: signal.marketId,
    tokenId: signal.tokenId,
    outcome: signal.outcome,
    side: "BUY",
    price: 0.5,
    size: 4,
    remainingSize: 0,
    status: "FILLED",
    createdAt: now - 1_000,
    expiresAt: now + 60_000
  });
  db.savePosition({
    id: "Aggressive:m1:yes-token",
    profile: "Aggressive",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    size: 4,
    avgEntryPrice: 0.5,
    currentPrice: 0.5,
    realizedPnl: 0,
    openedAt: now - 1_000,
    updatedAt: now - 1_000,
    status: "OPEN"
  });

  assert.equal(db.hasOpenPosition("m1", "yes-token", "Aggressive"), true);
  assert.equal(db.hasOpenPosition("m1", "yes-token", "Conservative"), false);
  assert.equal(db.isSourceEntryInCooldown(signal, "Aggressive", 60_000, now), true);
  assert.equal(db.isSourceEntryInCooldown({ ...signal, alignedWallets: ["0xother"] }, "Aggressive", 60_000, now), false);
  assert.equal(db.isSourceEntryInCooldown(signal, "Aggressive", 500, now), false);

  db.saveFill({ id: "fill_today", orderId: "ord_guard", marketId: "m1", tokenId: "yes-token", side: "BUY", price: 0.5, size: 4, timestamp: now });
  db.saveFill({ id: "fill_old", orderId: "ord_guard", marketId: "m1", tokenId: "yes-token", side: "BUY", price: 0.5, size: 4, timestamp: now - 48 * 60 * 60 * 1000 });
  assert.equal(db.getTradesToday(now), 1);

  db.savePosition({ id: "closed_win", marketId: "m2", tokenId: "tok2", outcome: "YES", size: 1, avgEntryPrice: 0.5, currentPrice: 0.6, realizedPnl: 0.1, openedAt: 1, updatedAt: 1, status: "CLOSED" });
  db.savePosition({ id: "closed_loss_1", marketId: "m3", tokenId: "tok3", outcome: "YES", size: 1, avgEntryPrice: 0.5, currentPrice: 0.4, realizedPnl: -0.1, openedAt: 2, updatedAt: 2, status: "CLOSED" });
  db.savePosition({ id: "closed_loss_2", marketId: "m4", tokenId: "tok4", outcome: "YES", size: 1, avgEntryPrice: 0.5, currentPrice: 0.4, realizedPnl: -0.1, openedAt: 3, updatedAt: 3, status: "CLOSED" });
  assert.equal(db.getLossStreak(), 2);
  db.close();
});

test("database selects top live-executable shadow wallets for active promotion", () => {
  const path = "data/test-live-exec-promotion.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch {
      // test cleanup is best effort
    }
  }
  const db = new BotDatabase(path);
  const base: WalletScore = {
    wallet: "0xlivegood",
    score: 92,
    copyabilityScore: 90,
    sourceSellRealizedRatio: 0.35,
    liveExecutableShadowSimulated: 12,
    liveExecutableShadowPnl: 10,
    liveExecutableShadowAvgReturnPct: 0.05,
    tradeCount: 100,
    recentTradeCount: 10,
    reliability: "HIGH",
    flags: ["SHADOW_PROVEN_COPYABLE"],
    updatedAt: Date.now()
  };
  db.saveWalletScore(base);
  db.saveWalletScore({
    ...base,
    wallet: "0xlivebetter",
    liveExecutableShadowPnl: 25,
    liveExecutableShadowAvgReturnPct: 0.08
  });
  db.saveWalletScore({
    ...base,
    wallet: "0xlivebad",
    liveExecutableShadowPnl: -5,
    liveExecutableShadowAvgReturnPct: -0.02
  });

  const promoted = db.getTopLiveExecutableWalletScores({
    limit: 5,
    minWalletScore: 68,
    minTrades: 8,
    minPnl: 0,
    minReturnPct: 0.03,
    minSourceSellRatio: 0.3
  });
  assert.deepEqual(promoted.map((score) => score.wallet), ["0xlivebetter", "0xlivegood"]);
  db.close();
});

test("database selects durable live-executable shadow winners from shadow trade history", () => {
  const path = "data/test-durable-live-exec-promotion.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch {
      // test cleanup is best effort
    }
  }
  const db = new BotDatabase(path);
  db.saveWalletScore({
    wallet: "0xdurablegood",
    score: 88,
    copyabilityScore: 86,
    tradeCount: 100,
    recentTradeCount: 5,
    reliability: "HIGH",
    flags: ["LOW_LIVE_EXECUTABLE_SHADOW_RATE"],
    updatedAt: Date.now()
  });
  db.saveWalletScore({
    wallet: "0xdurablebad",
    score: 95,
    copyabilityScore: 95,
    tradeCount: 100,
    recentTradeCount: 5,
    reliability: "HIGH",
    flags: [],
    updatedAt: Date.now()
  });
  db.saveShadowTrades([
    durableShadowTrade("good1", "0xdurablegood", 1.2, 0.12),
    durableShadowTrade("good2", "0xdurablegood", 1.3, 0.13),
    durableShadowTrade("good3", "0xdurablegood", 1.4, 0.14),
    durableShadowTrade("bad1", "0xdurablebad", -1, -0.1),
    durableShadowTrade("bad2", "0xdurablebad", -1, -0.1),
    durableShadowTrade("bad3", "0xdurablebad", -1, -0.1)
  ]);

  const promoted = db.getTopDurableLiveExecutableWalletScores({
    limit: 5,
    minWalletScore: 68,
    minTrades: 3,
    minPnl: 0,
    minReturnPct: 0.03,
    minSourceSellRatio: 0.3
  });
  assert.deepEqual(promoted.map((score) => score.wallet), ["0xdurablegood"]);
  assert.equal(promoted[0]?.liveExecutableShadowSimulated, 3);
  assert.ok((promoted[0]?.liveExecutableShadowPnl ?? 0) > 0);
  assert.ok(promoted[0]?.flags.includes("DURABLE_LIVE_EXECUTABLE_SHADOW"));
  const researchReport = buildWalletResearchReport({
    wallet: "0xdurablegood",
    entries: [
      { rank: 1, wallet: "0xdurablegood", pnl: 10, volume: 100, category: "WEATHER", period: "WEEK" },
      { rank: 1, wallet: "0xdurablegood", pnl: 20, volume: 200, category: "WEATHER", period: "MONTH" }
    ]
  }, [], [], [], 1001);
  db.saveWalletResearchReport(researchReport);
  const backfillExcluded = db.getTopDurableLiveExecutableWalletScores({
    limit: 5,
    minWalletScore: 68,
    minTrades: 1,
    minPnl: 0,
    minReturnPct: 0.03,
    minSourceSellRatio: 0.3
  });
  assert.deepEqual(backfillExcluded, []);
  db.saveShadowTrades([durableShadowTrade("good-forward", "0xdurablegood", 1.5, 0.15, { sourceTimestamp: 1002 })]);
  const afterObservation = db.getTopDurableLiveExecutableWalletScores({
    limit: 5,
    minWalletScore: 68,
    minTrades: 1,
    minPnl: 0,
    minReturnPct: 0.03,
    minSourceSellRatio: 0.3
  });
  assert.deepEqual(afterObservation.map((score) => score.wallet), ["0xdurablegood"]);
  const forwardOnly = db.getTopDurableLiveExecutableWalletScores({
    limit: 5,
    minWalletScore: 68,
    minTrades: 1,
    minPnl: 0,
    minReturnPct: 0.03,
    minSourceSellRatio: 0.3,
    sourceTimestampSince: 1001
  });
  assert.deepEqual(forwardOnly.map((score) => score.wallet), ["0xdurablegood"]);
  const blockedCategory = db.getTopDurableLiveExecutableWalletScores({
    limit: 5,
    minWalletScore: 68,
    minTrades: 1,
    minPnl: 0,
    minReturnPct: 0.03,
    minSourceSellRatio: 0.3,
    excludedCategories: ["other"]
  });
  assert.deepEqual(blockedCategory, []);
  db.close();
});

test("database open exposure uses entry cost and expires stale paper orders", () => {
  const path = "data/test-exposure-lifecycle.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch {
      // test cleanup is best effort
    }
  }
  const db = new BotDatabase(path);
  db.savePosition({
    id: "p_cost_basis",
    profile: "Aggressive",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    size: 10,
    avgEntryPrice: 0.5,
    currentPrice: 0.99,
    realizedPnl: 0,
    openedAt: 1000,
    updatedAt: 2000,
    status: "OPEN"
  });
  assert.equal(db.getOpenExposure(), 5);
  assert.equal(db.getExposureHealthReport(6).status, "AVAILABLE");

  db.savePaperOrder({
    id: "ord_stale",
    signalId: "sig_stale",
    profile: "Aggressive",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    side: "BUY",
    price: 0.5,
    size: 4,
    remainingSize: 4,
    status: "OPEN",
    createdAt: 1000,
    expiresAt: 2000
  });
  db.savePaperOrder({
    id: "ord_partial_stale",
    signalId: "sig_stale",
    profile: "Aggressive",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    side: "BUY",
    price: 0.5,
    size: 4,
    remainingSize: 2,
    status: "PARTIAL",
    createdAt: 1000,
    expiresAt: 2000
  });
  assert.equal(db.expireStalePaperOrders(2001), 2);
  const health = db.getOrderHealthReport(config.minPositionSize);
  assert.equal(health.openOrders, 0);
  assert.equal(health.partialOrders, 0);
  assert.equal(health.expiredOrders, 2);
  db.close();
});

test("performance report headlines executable PnL and flags no-bid positions", () => {
  const path = "data/test-executable-performance.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch {
      // test cleanup is best effort
    }
  }
  const db = new BotDatabase(path);
  db.savePosition({
    id: "p_no_bid",
    profile: "Aggressive",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    size: 10,
    avgEntryPrice: 0.1,
    currentPrice: 0.999,
    realizedPnl: 0,
    openedAt: 1000,
    updatedAt: 2000,
    status: "OPEN"
  });
  db.savePosition({
    id: "p_bid",
    profile: "Aggressive",
    marketId: "m2",
    tokenId: "bid-token",
    outcome: "YES",
    size: 10,
    avgEntryPrice: 0.5,
    currentPrice: 0.55,
    realizedPnl: 0,
    openedAt: 1000,
    updatedAt: 2000,
    status: "OPEN"
  });
  db.saveOrderBook({ ...book, tokenId: "yes-token", bestBid: undefined, bestAsk: 0.001, bids: [], asks: [{ price: 0.001, size: 10 }], timestamp: 3000 });
  db.saveOrderBook({ ...book, tokenId: "bid-token", bestBid: 0.52, bestAsk: 0.53, bids: [{ price: 0.52, size: 10 }], timestamp: 3000 });

  const report = db.getPerformanceReport();
  assert.equal(Number((report.storedUnrealizedPnl ?? 0).toFixed(2)), 9.49);
  assert.equal(Number(report.unrealizedPnl.toFixed(2)), -0.8);
  assert.equal(Number(report.totalPnl.toFixed(2)), -0.8);
  assert.equal(report.noBidOpenPositions, 1);
  assert.equal(db.getOpenPositions().find((position) => position.id === "p_no_bid")?.currentPrice, 0);
  db.close();
});

test("database records paper entry and exit parity metrics", () => {
  const path = "data/test-trade-parity.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch {
      // test cleanup is best effort
    }
  }
  const db = new BotDatabase(path);
  const executor = new PaperExecutionEngine();
  const signal = sampleSignal({
    id: "sig_parity",
    sourceBuyTimestamp: 1000,
    botDetectedTimestamp: 2000,
    expectedEntryPrice: 0.53,
    expectedLiveExecutableReturnPct: 0.06,
    sourceSellRealizedRatio: 0.5,
    entryBookDepth: 53,
    entryDepthMultiple: 10,
    parityStatus: "PASS",
    parityReason: "live parity passed"
  });
  const order = executor.createOrder(signal, { decision: "APPROVE", positionSize: 5, reason: "ok", profile: "Aggressive" }, {
    ...config,
    entryOrderPolicy: "FOK",
    maxEntrySlippage: 0.03
  });
  const simulated = executor.simulate(order, book);
  assert.ok(simulated.fill);
  assert.ok(simulated.position);
  db.saveSignal(signal);
  db.savePaperOrder(simulated.order);
  db.saveFill(simulated.fill);
  const position = db.savePaperEntry(simulated.position);
  db.recordPaperEntryParity(signal, simulated.order, simulated.fill, position);
  let metric = db.getRecentTradeParityMetrics(1)[0];
  assert.equal(metric.executionPolicy, "FOK");
  assert.equal(metric.actualEntry, simulated.fill.price);
  assert.equal(metric.sourceBuyTimestamp, 1000);

  const closed = { ...position, status: "CLOSED" as const, currentPrice: 0.65, realizedPnl: (0.65 - position.avgEntryPrice) * position.size };
  db.savePosition(closed);
  db.updateParityExit(closed, 0.64);
  metric = db.getRecentTradeParityMetrics(1)[0];
  assert.equal(metric.actualExit, 0.65);
  assert.equal(metric.shadowExpectedExit, 0.64);
  assert.ok((metric.exitSlippage ?? 0) < 0);
  db.close();
});

test("paper source attribution splits multi-source signal credit", () => {
  const path = "data/test-paper-source-attribution.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch {
      // test cleanup is best effort
    }
  }
  const db = new BotDatabase(path);
  const signal = { ...sampleSignal(), id: "sig_multi_source", confidence: 80, alignedWallets: ["0xsourcea", "0xsourceb"] };
  const executor = new PaperExecutionEngine();
  const order = executor.createOrder(signal, { decision: "APPROVE", positionSize: 5, reason: "ok", profile: "Aggressive" }, config);
  const simulated = executor.simulate(order, book);
  assert.ok(simulated.fill);
  assert.ok(simulated.position);
  db.saveSignal(signal);
  db.savePaperOrder(simulated.order);
  db.saveFill(simulated.fill);
  const position = db.savePaperEntry({ ...simulated.position, currentPrice: 0.65 });
  db.recordPaperEntryParity(signal, simulated.order, simulated.fill, position);

  const performance = db.getPaperSourcePerformance();
  const first = performance.get("0xsourcea");
  const second = performance.get("0xsourceb");
  assert.equal(first?.filledOrders, 0.5);
  assert.equal(second?.filledOrders, 0.5);
  assert.equal(Number((first?.pnl ?? 0).toFixed(4)), Number((second?.pnl ?? 0).toFixed(4)));
  assert.ok((first?.scoreImpact ?? 0) < 1);
  db.close();
});

test("database exposes intelligence trends, degradation, reconstructed source positions, and trade ledger", () => {
  const path = "data/test-intelligence-layer.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch {
      // test cleanup is best effort
    }
  }
  const db = new BotDatabase(path);
  const events = new AgentEventWriter(db);
  const signal = { ...sampleSignal(), id: "sig_intel", alignedWallets: ["0xintel"] };
  const executor = new PaperExecutionEngine();
  const order = executor.createOrder(signal, { decision: "APPROVE", positionSize: 5, reason: "ok", profile: "Aggressive" }, config);
  const simulated = executor.simulate(order, book);
  assert.ok(simulated.fill);
  assert.ok(simulated.position);

  db.saveMarket({ ...market, question: "Will Bitcoin rally?", slug: "bitcoin-rally" });
  db.saveSignal(signal);
  db.savePaperOrder(simulated.order);
  db.saveFill(simulated.fill);
  db.savePaperEntry({ ...simulated.position, currentPrice: 0.65 });
  db.savePosition({
    ...simulated.position,
    id: "closed-intel",
    currentPrice: 0.7,
    realizedPnl: 2,
    status: "CLOSED",
    updatedAt: Date.now() + 1
  });
  db.saveWalletTrades([
    { wallet: "0xintel", marketId: "m1", outcome: "YES", side: "BUY", price: 0.4, size: 10, timestamp: 1000 },
    { wallet: "0xintel", marketId: "m1", outcome: "YES", side: "SELL", price: 0.6, size: 5, timestamp: 2000 }
  ]);
  db.saveWalletScore({
    wallet: "0xintel",
    score: 80,
    copyabilityScore: 78,
    dominantCategory: "crypto",
    sampleConfidence: 0.8,
    tradeCount: 30,
    recentTradeCount: 4,
    reliability: "HIGH",
    flags: [],
    updatedAt: Date.now() - 10_000
  });
  db.saveWalletScore({
    wallet: "0xintel",
    score: 65,
    copyabilityScore: 62,
    dominantCategory: "crypto",
    sampleConfidence: 0.8,
    tradeCount: 31,
    recentTradeCount: 1,
    reliability: "MEDIUM",
    flags: [],
    updatedAt: Date.now()
  });
  db.saveShadowTrades(runShadowBacktest("0xintel", [{
    wallet: "0xintel",
    marketId: "m1",
    outcome: "YES",
    side: "BUY",
    price: 0.5,
    size: 10,
    timestamp: 1000
  }], [{ ...market, question: "Will Bitcoin rally?", slug: "bitcoin-rally", resolved: true, winningOutcome: "YES" }], config, Date.now()));
  events.write({
    type: "agent.cycle_completed",
    agent: "Signal Agent",
    visibility: "PUBLIC",
    message: "Trend event"
  });

  assert.ok(db.getPaperTradeLedger(config.bankroll, 10).some((entry) => entry.type === "EXIT" && entry.realizedPnl > 0));
  assert.ok(db.getShadowCategoryTrend(30).some((point) => point.category === "crypto"));
  assert.ok(db.getOrderHealthTrend(30).some((point) => point.fills > 0));
  assert.ok(db.getAgentThroughputTrend(30).some((point) => point.agent === "Signal Agent"));
  assert.equal(db.getWalletDegradationReport(30, 5)[0]?.status, "DEGRADING");
  assert.equal(db.getSourceCategorySummaries()[0]?.category, "crypto");
  assert.equal(db.getReconstructedSourcePositions(5)[0]?.status, "OPEN");
  db.close();
});

test("paper execution expires unfilled orders", () => {
  const executor = new PaperExecutionEngine();
  const order = executor.createOrder({ ...sampleSignal(), limitPrice: 0.4 }, { decision: "APPROVE", positionSize: 5, reason: "ok" }, config);
  const simulated = executor.simulate(order, book, order.expiresAt + 1);
  assert.equal(simulated.order.status, "EXPIRED");
});

test("exit engine triggers stop loss and take profit", () => {
  const position = {
    id: "p1",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    size: 10,
    avgEntryPrice: 0.5,
    currentPrice: 0.5,
    realizedPnl: 0,
    openedAt: Date.now(),
    updatedAt: Date.now(),
    status: "OPEN" as const
  };
  const stop = decideExit(position, { ...book, bestBid: 0.44 }, config);
  assert.equal(stop.decision, "FULL_EXIT");
  const executableProfit = decideExit(position, { ...book, bestBid: 0.61 }, { ...config, takeProfitAbs: 0.1 });
  assert.equal(executableProfit.decision, "FULL_EXIT");
  assert.match(executableProfit.reason, /take profit/);
  const profit = decideExit(position, { ...book, bestBid: 0.6 }, config, { trackedWalletReducing: true, volumeSpike: true });
  assert.equal(profit.decision, "FULL_EXIT");
  const stale = decideExit({
    ...position,
    openedAt: Date.now() - 73 * 60 * 60 * 1000
  }, { ...book, bestBid: 0.5 }, config);
  assert.equal(stale.decision, "FULL_EXIT");
});

test("exit engine treats no bid as no executable exit price", () => {
  const position = {
    id: "p-no-bid",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    size: 10,
    avgEntryPrice: 0.5,
    currentPrice: 0.999,
    realizedPnl: 0,
    openedAt: Date.now(),
    updatedAt: Date.now(),
    status: "OPEN" as const
  };
  const noBid = decideExit(position, { ...book, bids: [], bestBid: undefined, bestAsk: 0.001, spread: undefined }, config);
  assert.equal(noBid.decision, "FULL_EXIT");
  assert.match(noBid.reason, /no executable bid/);
});

test("exit engine uses absolute price stops so cheap longshots survive noise", () => {
  const longshot = {
    id: "p-longshot",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    size: 40,
    avgEntryPrice: 0.08,
    currentPrice: 0.08,
    realizedPnl: 0,
    openedAt: Date.now(),
    updatedAt: Date.now(),
    status: "OPEN" as const
  };
  const absConfig = { ...config, stopLossAbs: 0.06, takeProfitAbs: 0.1 };
  // A 0.074 bid is a 7.5% relative drop (would stop under the old rule) but only
  // 0.006 absolute, well inside noise, so it must hold.
  const noise = decideExit(longshot, { ...book, bestBid: 0.074, bestAsk: 0.09, spread: 0.016 }, absConfig);
  assert.equal(noise.decision, "HOLD");
  // A real 0.06 absolute drop still stops out.
  const realStop = decideExit(longshot, { ...book, bestBid: 0.02, bestAsk: 0.04, spread: 0.02 }, absConfig);
  assert.equal(realStop.decision, "FULL_EXIT");
  assert.match(realStop.reason, /stop loss/);
});

test("exit engine fully exits when the seeding source wallet sells", () => {
  const position = {
    id: "p-source",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    size: 10,
    avgEntryPrice: 0.5,
    currentPrice: 0.5,
    realizedPnl: 0,
    openedAt: Date.now(),
    updatedAt: Date.now(),
    status: "OPEN" as const
  };
  const followed = decideExit(position, { ...book, bestBid: 0.5, bestAsk: 0.52, spread: 0.02 }, config, {
    trackedWalletReducing: true
  });
  assert.equal(followed.decision, "FULL_EXIT");
  assert.match(followed.reason, /source wallet exiting/);
});

test("overseer records executable paper sell orders before closing positions", () => {
  const path = "data/test-overseer-sell-exit.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch {
      // test cleanup is best effort
    }
  }
  const db = new BotDatabase(path);
  const events = new AgentEventWriter(db);
  const overseer = new OverseerAgent(db, events, {
    ...config,
    stopLossAbs: 0.05,
    exitOrderPolicy: "FOK",
    maxExitSlippage: 0.02,
    orderTickSize: 0.01
  });
  db.savePosition({
    id: "Aggressive:m1:yes-token",
    profile: "Aggressive",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    size: 10,
    avgEntryPrice: 0.5,
    currentPrice: 0.5,
    realizedPnl: 0,
    openedAt: Date.now(),
    updatedAt: Date.now(),
    status: "OPEN"
  });

  const updates = overseer.monitor(new Map([["yes-token", { ...book, bids: [{ price: 0.44, size: 10 }], bestBid: 0.44 }]]));
  assert.equal(updates[0]?.closed, true);
  assert.equal(Number((updates[0]?.position.realizedPnl ?? 0).toFixed(2)), -0.6);
  assert.equal(db.getPerformanceReport().closedPositions, 1);
  assert.equal(db.getOrderHealthReport(config.minPositionSize).filledOrders, 1);
  db.close();
});

test("overseer uses urgent slippage for stop-loss exits", () => {
  const path = "data/test-overseer-urgent-exit.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch {
      // test cleanup is best effort
    }
  }
  const db = new BotDatabase(path);
  const events = new AgentEventWriter(db);
  const overseer = new OverseerAgent(db, events, {
    ...config,
    stopLossAbs: 0.05,
    exitOrderPolicy: "FAK",
    maxExitSlippage: 0.02,
    urgentExitSlippage: 0.08,
    orderTickSize: 0.01
  });
  db.savePosition({
    id: "Aggressive:m1:yes-token",
    profile: "Aggressive",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    size: 10,
    avgEntryPrice: 0.5,
    currentPrice: 0.5,
    realizedPnl: 0,
    openedAt: Date.now(),
    updatedAt: Date.now(),
    status: "OPEN"
  });

  const updates = overseer.monitor(new Map([["yes-token", {
    ...book,
    bestBid: 0.44,
    bids: [{ price: 0.39, size: 10 }]
  }]]));
  assert.equal(updates[0]?.closed, true);
  assert.equal(Number((updates[0]?.position.realizedPnl ?? 0).toFixed(2)), -1.1);
  const order = db.getLatestPaperExitOrder("Aggressive:m1:yes-token");
  assert.equal(order?.status, "FILLED");
  assert.equal(order?.price, 0.36);
  db.close();
});

test("overseer records partial FAK exits and reduces open position size", () => {
  const path = "data/test-overseer-partial-fak-exit.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch {
      // test cleanup is best effort
    }
  }
  const db = new BotDatabase(path);
  const events = new AgentEventWriter(db);
  const overseer = new OverseerAgent(db, events, {
    ...config,
    takeProfitAbs: 0.05,
    exitOrderPolicy: "FAK",
    maxExitSlippage: 0.02,
    orderTickSize: 0.01
  });
  db.savePosition({
    id: "Aggressive:m1:yes-token",
    profile: "Aggressive",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    size: 10,
    avgEntryPrice: 0.5,
    currentPrice: 0.5,
    realizedPnl: 0,
    openedAt: Date.now(),
    updatedAt: Date.now(),
    status: "OPEN"
  });

  const updates = overseer.monitor(new Map([["yes-token", { ...book, bids: [{ price: 0.56, size: 4 }], bestBid: 0.56 }]]));
  assert.equal(updates[0]?.closed, false);
  assert.equal(Number((updates[0]?.position.size ?? 0).toFixed(2)), 6);
  assert.equal(Number((updates[0]?.position.realizedPnl ?? 0).toFixed(2)), 0.24);
  assert.equal(db.getOpenPositions()[0]?.size, 6);
  assert.equal(db.getRecentAgentEvents(5).some((event) => event.type === "trade.exit_partial"), true);
  db.close();
});

test("overseer marks no-bid positions at zero and records missed FOK exits", () => {
  const path = "data/test-overseer-no-bid.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch {
      // test cleanup is best effort
    }
  }
  const db = new BotDatabase(path);
  const events = new AgentEventWriter(db);
  const overseer = new OverseerAgent(db, events, {
    ...config,
    exitOrderPolicy: "FOK",
    maxExitSlippage: 0.02,
    orderTickSize: 0.01
  });
  db.savePosition({
    id: "Aggressive:m1:yes-token",
    profile: "Aggressive",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    size: 10,
    avgEntryPrice: 0.5,
    currentPrice: 0.999,
    realizedPnl: 0,
    openedAt: Date.now(),
    updatedAt: Date.now(),
    status: "OPEN"
  });

  const updates = overseer.monitor(new Map([["yes-token", {
    ...book,
    bids: [],
    asks: [{ price: 0.001, size: 100 }],
    bestBid: undefined,
    bestAsk: 0.001,
    spread: undefined
  }]]));
  assert.equal(updates[0]?.closed, false);
  assert.match(updates[0]?.reason ?? "", /insufficient executable liquidity/);
  assert.equal(db.getOpenPositions()[0]?.currentPrice, 0);
  const health = db.getOrderHealthReport(config.minPositionSize);
  assert.equal(health.expiredOrders, 1);
  assert.equal(db.getRecentAgentEvents(5).some((event) => event.type === "source_exit.watchdog"), true);
  db.close();
});

test("overseer closes stale no-bid zombies at zero", () => {
  const path = "data/test-overseer-no-bid-zombie.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch {
      // test cleanup is best effort
    }
  }
  const db = new BotDatabase(path);
  const events = new AgentEventWriter(db);
  const overseer = new OverseerAgent(db, events, {
    ...config,
    exitOrderPolicy: "FAK",
    noBidPositionCloseAfterMs: 30 * 60 * 1000
  });
  db.savePosition({
    id: "Aggressive:m1:yes-token",
    profile: "Aggressive",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    size: 10,
    avgEntryPrice: 0.5,
    currentPrice: 0.999,
    realizedPnl: 0,
    openedAt: Date.now() - 31 * 60 * 1000,
    updatedAt: Date.now() - 31 * 60 * 1000,
    status: "OPEN"
  });

  const updates = overseer.monitor(new Map([["yes-token", {
    ...book,
    bids: [],
    asks: [{ price: 0.001, size: 100 }],
    bestBid: undefined,
    bestAsk: 0.001,
    spread: undefined
  }]]));
  assert.equal(updates[0]?.closed, true);
  assert.match(updates[0]?.reason ?? "", /no executable bid timeout/);
  assert.equal(db.getOpenPositions().length, 0);
  assert.equal(Number(db.getPerformanceReport().realizedPnl.toFixed(2)), -5);
  assert.equal(db.getOrderHealthReport(config.minPositionSize).totalOrders, 0);
  db.close();
});

test("overseer suppresses repeated exit misses during retry cooldown", () => {
  const path = "data/test-overseer-exit-retry-cooldown.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch {
      // test cleanup is best effort
    }
  }
  const db = new BotDatabase(path);
  const events = new AgentEventWriter(db);
  const overseer = new OverseerAgent(db, events, {
    ...config,
    exitOrderPolicy: "FAK",
    maxExitSlippage: 0.02,
    exitRetryCooldownMs: 5 * 60 * 1000,
    noBidPositionCloseAfterMs: 60 * 60 * 1000
  });
  db.savePosition({
    id: "Aggressive:m1:yes-token",
    profile: "Aggressive",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    size: 10,
    avgEntryPrice: 0.5,
    currentPrice: 0.999,
    realizedPnl: 0,
    openedAt: Date.now(),
    updatedAt: Date.now(),
    status: "OPEN"
  });
  const noBidBook = {
    ...book,
    bids: [],
    asks: [{ price: 0.001, size: 100 }],
    bestBid: undefined,
    bestAsk: 0.001,
    spread: undefined
  };

  const first = overseer.monitor(new Map([["yes-token", noBidBook]]));
  const second = overseer.monitor(new Map([["yes-token", noBidBook]]));
  assert.equal(first[0]?.closed, false);
  assert.match(first[0]?.reason ?? "", /insufficient executable liquidity/);
  assert.equal(second[0]?.closed, false);
  assert.match(second[0]?.reason ?? "", /exit retry cooling down/);
  const health = db.getOrderHealthReport(config.minPositionSize);
  assert.equal(health.totalOrders, 1);
  assert.equal(health.expiredOrders, 1);
  assert.equal(db.getRecentAgentEvents(10).some((event) => event.type === "trade.exit_suppressed"), true);
  db.close();
});

test("overseer suppresses exits when top-of-book has no fresh bid depth", () => {
  const path = "data/test-overseer-stale-depth-exit.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch {
      // test cleanup is best effort
    }
  }
  const db = new BotDatabase(path);
  const events = new AgentEventWriter(db);
  const overseer = new OverseerAgent(db, events, {
    ...config,
    takeProfitAbs: 0.05,
    exitOrderPolicy: "FAK",
    exitRetryCooldownMs: 0
  });
  db.savePosition({
    id: "Aggressive:m1:yes-token",
    profile: "Aggressive",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    size: 10,
    avgEntryPrice: 0.5,
    currentPrice: 0.5,
    realizedPnl: 0,
    openedAt: Date.now(),
    updatedAt: Date.now(),
    status: "OPEN"
  });

  const updates = overseer.monitor(new Map([["yes-token", {
    ...book,
    bestBid: 0.61,
    bids: [],
    bestAsk: 0.62,
    asks: [{ price: 0.62, size: 10 }],
    depth: 0
  }]]));
  assert.equal(updates[0]?.closed, false);
  assert.equal(updates[0]?.reason, "waiting for fresh executable bid depth");
  assert.equal(db.getOrderHealthReport(config.minPositionSize).totalOrders, 0);
  assert.equal(db.getRecentAgentEvents(10).some((event) =>
    event.type === "trade.exit_suppressed" &&
    JSON.stringify(event.payload ?? {}).includes("fresh executable bid depth")
  ), true);
  db.close();
});

test("database detects source-sell exits and stop-out cooldowns", () => {
  const path = "data/test-source-exit.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch {
      // test cleanup is best effort
    }
  }
  const db = new BotDatabase(path);
  const signal = { ...sampleSignal(), id: "sig_source_exit", alignedWallets: ["0xsource"] };
  const executor = new PaperExecutionEngine();
  const order = executor.createOrder(signal, { decision: "APPROVE", positionSize: 5, reason: "ok", profile: "Aggressive" }, config);
  const simulated = executor.simulate(order, book);
  assert.ok(simulated.position);
  db.saveSignal(signal);
  db.savePaperOrder(simulated.order);
  const entered = db.savePaperEntry({ ...simulated.position, openedAt: 1000, updatedAt: 1000 });

  // No source sell yet.
  assert.equal(db.getPositionSourceExit(entered).sourceSold, false);

  // Source sells the same outcome after entry.
  db.saveWalletTrades([
    { wallet: "0xsource", marketId: "m1", tokenId: "yes-token", outcome: "YES", side: "SELL", price: 0.6, size: 5, timestamp: 2000 }
  ]);
  const exit = db.getPositionSourceExit(entered);
  assert.equal(exit.sourceSold, true);
  assert.equal(exit.sellerCount, 1);
  assert.equal(exit.sourceCount, 1);
  const sourceWallets = db.getOpenPositionSourceWallets();
  assert.equal(sourceWallets[0]?.position.id, entered.id);
  assert.deepEqual(sourceWallets[0]?.wallets, ["0xsource"]);

  // Cooldown blocks re-entry only after a losing close of the same token.
  assert.equal(db.isMarketInStopCooldown("m1", "yes-token", 3_600_000, 5000), false);
  db.savePosition({ ...entered, realizedPnl: -0.3, status: "CLOSED", updatedAt: 4000 });
  assert.equal(db.isMarketInStopCooldown("m1", "yes-token", 3_600_000, 5000), true);
  assert.equal(db.isMarketInStopCooldown("m1", "yes-token", 3_600_000, 4000 + 3_600_001), false);
  db.close();
});

test("database builds parity scorecard with executable PnL and exit metrics", () => {
  const path = "data/test-parity-scorecard.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch {
      // test cleanup is best effort
    }
  }
  const db = new BotDatabase(path);
  const now = Date.now();
  db.savePosition({
    id: "p_scorecard",
    profile: "Aggressive",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    size: 10,
    avgEntryPrice: 0.5,
    currentPrice: 0.9,
    realizedPnl: -0.2,
    openedAt: now - 1_000,
    updatedAt: now - 1_000,
    status: "OPEN"
  });
  db.saveOrderBook({ ...book, tokenId: "yes-token", bids: [], bestBid: undefined, bestAsk: 0.001, asks: [{ price: 0.001, size: 10 }], timestamp: now });
  db.savePaperOrder({
    id: "ord_scorecard",
    signalId: "sig_scorecard",
    profile: "Aggressive",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    side: "BUY",
    price: 0.5,
    size: 10,
    remainingSize: 0,
    status: "FILLED",
    createdAt: now,
    expiresAt: now + 60_000,
    executionPolicy: "FOK"
  });
  db.saveFill({ id: "fill_scorecard", orderId: "ord_scorecard", marketId: "m1", tokenId: "yes-token", side: "BUY", price: 0.5, size: 10, timestamp: now });
  db.saveTradeParityMetric({
    id: "metric_scorecard",
    positionId: "p_scorecard",
    orderId: "ord_scorecard",
    signalId: "sig_scorecard",
    profile: "Aggressive",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    actualEntry: 0.5,
    actualExit: 0.4,
    entrySlippage: 0.01,
    exitSlippage: 0.02,
    entryDepthMultiple: 6,
    executionPolicy: "FOK",
    createdAt: now,
    updatedAt: now
  });
  db.saveExitDecision("p_scorecard", { decision: "FULL_EXIT", exitProbability: 100, reason: "take profit reached" });
  db.saveAgentEvent({
    id: "evt_scorecard",
    type: "source_exit.watchdog",
    agent: "Overseer Agent",
    visibility: "PRIVATE",
    message: "watchdog",
    payload: { checkedPositions: 2, sourceSoldPositions: 1 },
    createdAt: now
  });

  const scorecard = db.getParityScorecard(24);
  assert.equal(scorecard.filledOrders, 1);
  assert.equal(scorecard.buyFills, 1);
  assert.equal(scorecard.noBidOpenPositions, 1);
  assert.equal(Number(scorecard.executableTotalPnl.toFixed(2)), -5.2);
  assert.equal(Number(scorecard.storedTotalPnl.toFixed(2)), 3.8);
  assert.equal(scorecard.takeProfitExitAttempts, 1);
  assert.equal(scorecard.sourceSellDetections, 1);
  assert.equal(scorecard.avgEntryDepthMultiple, 6);
  db.close();
});

test("database builds live readiness verdict from executable parity", () => {
  const path = "data/test-live-readiness.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch {
      // test cleanup is best effort
    }
  }
  const db = new BotDatabase(path);
  const now = Date.now();
  db.savePosition({
    id: "p_readiness_open",
    profile: "Aggressive",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    size: 10,
    avgEntryPrice: 0.5,
    currentPrice: 0.9,
    realizedPnl: 0,
    openedAt: now,
    updatedAt: now,
    status: "OPEN"
  });
  db.savePosition({
    id: "p_readiness_closed",
    profile: "Aggressive",
    marketId: "m2",
    tokenId: "no-token",
    outcome: "NO",
    size: 10,
    avgEntryPrice: 0.6,
    currentPrice: 0.4,
    realizedPnl: -2,
    openedAt: now - 10_000,
    updatedAt: now,
    status: "CLOSED"
  });
  db.saveOrderBook({ ...book, tokenId: "yes-token", bids: [], bestBid: undefined, bestAsk: 0.001, asks: [{ price: 0.001, size: 10 }], timestamp: now });
  db.savePaperOrder({
    id: "ord_readiness_buy",
    signalId: "sig_readiness",
    profile: "Aggressive",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    side: "BUY",
    price: 0.5,
    size: 10,
    remainingSize: 0,
    status: "FILLED",
    createdAt: now,
    expiresAt: now + 60_000,
    executionPolicy: "FOK"
  });
  db.saveFill({ id: "fill_readiness_buy", orderId: "ord_readiness_buy", marketId: "m1", tokenId: "yes-token", side: "BUY", price: 0.5, size: 10, timestamp: now });
  db.savePaperOrder({
    id: "ord_readiness_miss",
    signalId: "sig_readiness_miss",
    profile: "Aggressive",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    side: "BUY",
    price: 0.5,
    size: 10,
    remainingSize: 10,
    status: "EXPIRED",
    createdAt: now,
    expiresAt: now + 60_000,
    executionPolicy: "FOK",
    missedReason: "insufficient executable liquidity"
  });
  db.savePaperOrder({
    id: "exit_readiness_miss",
    signalId: "exit:p_readiness_open",
    profile: "Aggressive",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    side: "SELL",
    price: 0.5,
    size: 10,
    remainingSize: 10,
    status: "EXPIRED",
    createdAt: now,
    expiresAt: now + 60_000,
    executionPolicy: "FAK",
    missedReason: "insufficient executable liquidity"
  });
  db.saveAgentEvent({
    id: "evt_readiness_watchdog",
    type: "source_exit.watchdog",
    agent: "Overseer Agent",
    visibility: "PRIVATE",
    message: "watchdog",
    payload: { checkedPositions: 4, sourceSoldPositions: 0, noBidPositions: 1 },
    createdAt: now
  });

  const report = db.getLiveReadinessReport(config, 24);
  assert.equal(report.status, "NOT_READY");
  assert.equal(report.metrics.noBidOpenPositions, 1);
  assert.equal(report.metrics.fokEntryMissRate, 0.5);
  assert.equal(report.metrics.exitMissRate, 1);
  assert.equal(Number(report.metrics.executableTotalPnl.toFixed(2)), -7);
  assert.ok(report.blockers.some((blocker) => blocker.includes("executable total PnL")));
  assert.ok(report.blockers.some((blocker) => blocker.includes("no executable bid")));
  db.close();
});

test("overseer closes stale no-book positions using cached or resolved prices", () => {
  const path = "data/test-overseer-no-book.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch {
      // test cleanup is best effort
    }
  }
  const db = new BotDatabase(path);
  const events = new AgentEventWriter(db);
  const agent = new OverseerAgent(db, events, { ...config, maxPositionHoldHours: 1 });
  db.saveMarket({ ...market, id: "resolved-market", resolved: true, winningOutcome: "YES" });
  db.savePosition({
    id: "p_resolved",
    profile: "Aggressive",
    marketId: "resolved-market",
    tokenId: "yes-token",
    outcome: "YES",
    size: 10,
    avgEntryPrice: 0.4,
    currentPrice: 0.55,
    realizedPnl: 0,
    openedAt: Date.now() - 2 * 60 * 60 * 1000,
    updatedAt: Date.now() - 2 * 60 * 60 * 1000,
    status: "OPEN"
  });
  db.savePosition({
    id: "p_cached",
    profile: "Aggressive",
    marketId: "unknown-book-market",
    tokenId: "missing-token",
    outcome: "YES",
    size: 5,
    avgEntryPrice: 0.5,
    currentPrice: 0.62,
    realizedPnl: 0,
    openedAt: Date.now() - 2 * 60 * 60 * 1000,
    updatedAt: Date.now() - 2 * 60 * 60 * 1000,
    status: "OPEN"
  });

  const updates = agent.monitor(new Map());
  assert.equal(updates.filter((update) => update.closed).length, 2);
  assert.equal(db.getOpenPositions().length, 0);
  const closed = db.getClosedPositions(10);
  assert.ok(closed.some((position) => position.id === "p_resolved" && position.currentPrice === 1));
  assert.ok(closed.some((position) => position.id === "p_cached" && position.currentPrice === 0.62));
  db.close();
});

test("weather hold-to-resolution positions ignore interim stop losses and close only on resolution", () => {
  const path = "data/test-weather-resolution-hold.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(`${path}${suffix}`); } catch { /* best effort */ }
  }
  const db = new BotDatabase(path);
  const events = new AgentEventWriter(db);
  const agent = new OverseerAgent(db, events, { ...config, stopLossAbs: 0.05, maxPositionHoldHours: 1 });
  const signalId = "sig_weather_hold";
  const orderId = "ord_weather_hold";
  const positionId = `Conservative:m-weather-hold:no-token:${orderId}`;
  db.saveSignal(sampleSignal({
    id: signalId,
    marketId: "m-weather-hold",
    tokenId: "no-token",
    outcome: "NO",
    signalOrigin: "INDEPENDENT_MODEL",
    strategyId: "weather_ensemble_fair_value_v2",
    policyVersion: "weather-station-skill-v5-resolution-hold",
    exitPolicy: "HOLD_TO_RESOLUTION"
  }));
  db.savePaperOrder({
    id: orderId,
    signalId,
    profile: "Conservative",
    marketId: "m-weather-hold",
    tokenId: "no-token",
    outcome: "NO",
    side: "BUY",
    price: 0.5,
    size: 10,
    remainingSize: 0,
    status: "FILLED",
    createdAt: Date.now() - 2 * 3_600_000,
    expiresAt: Date.now() - 2 * 3_600_000 + 60_000,
    executionPolicy: "FOK"
  });
  db.savePosition({
    id: positionId,
    profile: "Conservative",
    marketId: "m-weather-hold",
    tokenId: "no-token",
    outcome: "NO",
    size: 10,
    avgEntryPrice: 0.5,
    currentPrice: 0.5,
    realizedPnl: 0,
    openedAt: Date.now() - 2 * 3_600_000,
    updatedAt: Date.now() - 2 * 3_600_000,
    status: "OPEN"
  });
  db.saveMarket({ ...market, id: "m-weather-hold", outcomes: ["YES", "NO"], clobTokenIds: ["yes-token", "no-token"] });

  const interim = agent.monitor(new Map([["no-token", { ...book, tokenId: "no-token", bestBid: 0.2, bids: [{ price: 0.2, size: 100 }] }]]));
  assert.equal(interim[0]?.closed, false);
  assert.match(interim[0]?.reason ?? "", /hold-to-resolution/);
  assert.equal(db.getPositionEntryPolicy(positionId).exitPolicy, "HOLD_TO_RESOLUTION");

  db.saveMarket({
    ...market,
    id: "m-weather-hold",
    outcomes: ["YES", "NO"],
    clobTokenIds: ["yes-token", "no-token"],
    active: false,
    closed: true,
    resolved: true,
    acceptingOrders: false,
    winningOutcome: "NO"
  });
  const resolved = agent.monitor(new Map());
  assert.equal(resolved[0]?.closed, true);
  assert.equal(resolved[0]?.position.currentPrice, 1);
  assert.equal(resolved[0]?.position.realizedPnl, 5);
  db.close();
});

test("strategy profiles model conservative and aggressive risk boundaries", () => {
  const profiles = buildStrategyProfiles(config);
  const conservative = profiles.find((profile) => profile.name === "Conservative");
  const aggressive = profiles.find((profile) => profile.name === "Aggressive");
  assert.ok(conservative);
  assert.ok(aggressive);
  assert.equal(conservative.allowedRiskStates.includes("WARNING"), false);
  assert.equal(aggressive.allowedRiskStates.includes("WARNING"), true);
  assert.ok(conservative.minConfidence > aggressive.minConfidence);
});

test("risk agent persists detailed rejection context", () => {
  const path = "data/test-risk-details.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch {
      // test cleanup is best effort
    }
  }
  const db = new BotDatabase(path);
  const events = new AgentEventWriter(db);
  const agent = new RiskMitigationAgent(db, events, config, buildStrategyProfiles(config));
  const quality = evaluateMarketQuality({ ...market, liquidity: 10 }, [{ ...book, spread: 0.2, depth: 10 }], config);
  const decision = agent.decide(sampleSignal(), quality, { openExposure: 0, dailyPnl: 0, lossStreak: 0, tradesToday: 0 }, {
    sourceScores: [{
      wallet: "0xabc",
      score: 72,
      copyabilityScore: 74,
      shadowScoreImpact: 4,
      shadowPnl: 12,
      shadowSimulated: 30,
      shadowRealized: 12,
      categoryConsistencyScore: 70,
      sampleConfidence: 0.8,
      flags: ["SHADOW_PROVEN_COPYABLE"]
    }]
  });
  assert.equal(decision.decision, "REJECT");
  assert.match(decision.reason, /market quality failed/);
  const recent = db.getRecentRiskEvents(1)[0];
  assert.equal(recent.marketId, "m1");
  assert.equal(recent.confidence, 82);
  assert.equal(recent.riskState, "HIGH_RISK");
  assert.ok(recent.details?.marketQualityReasons?.some((reason) => reason.includes("liquidity")));
  assert.equal(recent.details?.sourceWalletCount, 1);
  assert.equal(recent.details?.entryPrice, sampleSignal().limitPrice);
  assert.equal(recent.details?.sourceScores?.[0]?.shadowPnl, 12);
  db.close();
});

test("agent event writer persists private and public events", () => {
  const path = "data/test-agent-events.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch {
      // test cleanup is best effort
    }
  }
  const db = new BotDatabase(path);
  const writer = new AgentEventWriter(db);
  writer.write({
    type: "signal.created",
    agent: "Signal Agent",
    visibility: "PUBLIC",
    message: "Public test",
    payload: { alignedSourceCount: 1 }
  });
  writer.write({
    type: "source.scored",
    agent: "Signal Agent",
    message: "Private test",
    payload: { wallet: "0xprivate" }
  });
  assert.equal(db.getRecentAgentEvents(10).length, 2);
  assert.equal(db.getRecentAgentEvents(10, "PUBLIC").length, 1);
  db.close();
});

test("database persists wallet trade history with dedupe", () => {
  const path = "data/test-wallet-history.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch {
      // test cleanup is best effort
    }
  }
  const db = new BotDatabase(path);
  const trade: WalletTrade = {
    wallet: "0xhistory",
    marketId: "m1",
    outcome: "YES",
    side: "BUY",
    price: 0.5,
    size: 10,
    timestamp: 123
  };
  assert.equal(db.saveWalletTrades([trade, trade]), 1);
  const history = db.getWalletTradeHistory("0xhistory", 10);
  assert.equal(history.length, 1);
  assert.equal(history[0].wallet, "0xhistory");
  db.close();
});

test("shadow backtest simulates delayed copy exits from source sell", () => {
  const trades: WalletTrade[] = [
    {
      wallet: "0xshadow",
      marketId: "m1",
      tokenId: "yes-token",
      outcome: "YES",
      side: "BUY",
      price: 0.5,
      size: 20,
      timestamp: 1000
    },
    {
      wallet: "0xshadow",
      marketId: "m1",
      tokenId: "yes-token",
      outcome: "YES",
      side: "SELL",
      price: 0.65,
      size: 20,
      timestamp: 1000 + config.shadowCopyDelayMs + 1000
    }
  ];
  const shadow = runShadowBacktest("0xshadow", trades, [market], config, 5000);
  assert.equal(shadow.length, 1);
  assert.equal(shadow[0].status, "SIMULATED");
  assert.ok(shadow[0].pnl > 0);
  assert.equal(shadow[0].exitReason, "source sell after detection");
});

test("shadow backtest records live-executable source-sell PnL separately", () => {
  const liveConfig: BotConfig = {
    ...config,
    liveExecutableShadowEnabled: true,
    maxEntrySlippage: 0.03,
    maxExitSlippage: 0.03,
    orderTickSize: 0.01,
    liveExecutionFeeRatePct: 0
  };
  const sourceSellShadow = runShadowBacktest("0xshadow", [
    {
      wallet: "0xshadow",
      marketId: "m1",
      tokenId: "yes-token",
      outcome: "YES",
      side: "BUY",
      price: 0.5,
      size: 20,
      timestamp: 1000
    },
    {
      wallet: "0xshadow",
      marketId: "m1",
      tokenId: "yes-token",
      outcome: "YES",
      side: "SELL",
      price: 0.7,
      size: 20,
      timestamp: 1000 + config.shadowCopyDelayMs + 1000
    }
  ], [market], liveConfig, 5000);
  assert.equal(sourceSellShadow[0].liveExecutableStatus, "EXECUTABLE");
  assert.ok((sourceSellShadow[0].liveExecutablePnl ?? 0) > 0);
  const sourceSellPerformance = summarizeShadowPerformanceByWallet(sourceSellShadow).get("0xshadow");
  assert.equal(sourceSellPerformance?.sourceSellRealizedRatio, 1);
  assert.equal(sourceSellPerformance?.liveExecutableSimulated, 1);

  const markedSourceTrades: WalletTrade[] = [
    {
      wallet: "0xshadow",
      marketId: "m1",
      tokenId: "yes-token",
      outcome: "YES",
      side: "BUY",
      price: 0.5,
      size: 20,
      timestamp: 1000
    }
  ];
  const markedMarketTape: WalletTrade[] = [
    ...markedSourceTrades,
    {
      wallet: "0xother",
      marketId: "m1",
      tokenId: "yes-token",
      outcome: "YES",
      side: "BUY",
      price: 0.7,
      size: 5,
      timestamp: 1000 + config.shadowCopyDelayMs + 1000
    }
  ];
  // A buy the source never sold still counts as live-executable evidence: it is a
  // position we would have carried and closed on our own policy at the mark. Dropping
  // these left the executable set equal to the trades the source chose to close,
  // which is decided after our entry and cannot be traded on.
  const markedShadow = runShadowBacktest("0xshadow", markedSourceTrades, [market], liveConfig, 5000, markedMarketTape);
  assert.equal(markedShadow[0].exitReason, "latest observed mark");
  assert.equal(markedShadow[0].liveExecutableStatus, "EXECUTABLE");
});

test("one source sell cannot be credited to every buy in the leg", () => {
  // These wallets accumulate across many buys and close once. Matching each buy to
  // the first later sell independently credited that single exit to all of them and
  // produced 100% win rates on source-sell exits. FIFO matching must bound a sell to
  // the inventory it actually closes.
  const liveConfig: BotConfig = { ...config, liveExecutableShadowEnabled: true, orderTickSize: 0.01 };
  const leg = (side: "BUY" | "SELL", price: number, size: number, t: number): WalletTrade => ({
    wallet: "0xaccum", marketId: "m1", tokenId: "yes-token", outcome: "YES", side, price, size, timestamp: t
  });
  const delay = config.shadowCopyDelayMs;

  const shadow = runShadowBacktest("0xaccum", [
    leg("BUY", 0.30, 10, 1000),
    leg("BUY", 0.40, 10, 2000),
    leg("BUY", 0.50, 10, 3000),
    // One sell that only covers the first lot.
    leg("SELL", 0.90, 10, 4000 + delay)
  ], [market], liveConfig, 100000);

  const sourceSellExits = shadow.filter((t) => t.exitReason === "source sell after detection");
  assert.equal(sourceSellExits.length, 1, "a 10-share sell must close exactly one 10-share lot");
  assert.equal(sourceSellExits[0].sourcePrice, 0.30, "FIFO must close the oldest lot first");
  assert.equal(shadow.length, 3, "every buy still produces evidence");
});

test("live-executable shadow proof uses a tradable size when shadow size is below minimum", () => {
  const liveConfig: BotConfig = {
    ...config,
    minPositionSize: 10,
    shadowPositionSize: 4,
    liveExecutableShadowEnabled: true,
    maxEntrySlippage: 0.03,
    maxExitSlippage: 0.03,
    orderTickSize: 0.01,
    liveExecutionFeeRatePct: 0
  };
  const shadow = runShadowBacktest("0xshadow", [
    {
      wallet: "0xshadow",
      marketId: "m1",
      tokenId: "yes-token",
      outcome: "YES",
      side: "BUY",
      price: 0.5,
      size: 30,
      timestamp: 1000
    },
    {
      wallet: "0xshadow",
      marketId: "m1",
      tokenId: "yes-token",
      outcome: "YES",
      side: "SELL",
      price: 0.7,
      size: 30,
      timestamp: 1000 + config.shadowCopyDelayMs + 1000
    }
  ], [market], liveConfig, 5000);

  assert.equal(shadow[0].sizeUsd, 10);
  assert.equal(shadow[0].liveExecutableStatus, "EXECUTABLE");
  assert.notEqual(shadow[0].liveExecutableReason, "below min order size");
  assert.ok((shadow[0].liveExecutablePnl ?? 0) > 0);
});

test("shadow backtest can exit from resolved market outcome", () => {
  const trades: WalletTrade[] = [{
    wallet: "0xshadow",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    side: "BUY",
    price: 0.5,
    size: 20,
    timestamp: 1000
  }];
  const shadow = runShadowBacktest("0xshadow", trades, [{ ...market, resolved: true, winningOutcome: "YES" }], config, 5000);
  assert.equal(shadow[0].status, "SIMULATED");
  assert.equal(shadow[0].simulatedExitPrice, 1);
  assert.ok(summarizeShadowBacktest(shadow).pnl > 0);
});

test("shadow backtest marks to latest observed price when no exit exists", () => {
  const trades: WalletTrade[] = [
    {
      wallet: "0xshadow",
      marketId: "m1",
      tokenId: "yes-token",
      outcome: "YES",
      side: "BUY",
      price: 0.5,
      size: 20,
      timestamp: 1000
    },
    {
      wallet: "0xshadow",
      marketId: "m1",
      tokenId: "yes-token",
      outcome: "YES",
      side: "BUY",
      price: 0.58,
      size: 5,
      timestamp: 1000 + config.shadowCopyDelayMs + 1000
    }
  ];
  const shadow = runShadowBacktest("0xshadow", trades, [market], config, 5000);
  assert.equal(shadow[0].status, "SIMULATED");
  assert.equal(shadow[0].exitReason, "latest observed mark");
  assert.ok(shadow[0].pnl > 0);
});

test("shadow backtest can mark from broader market tape", () => {
  const sourceTrades: WalletTrade[] = [{
    wallet: "0xshadow",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    side: "BUY",
    price: 0.5,
    size: 20,
    timestamp: 1000
  }];
  const marketTape: WalletTrade[] = [
    ...sourceTrades,
    {
      wallet: "0xother",
      marketId: "m1",
      tokenId: "yes-token",
      outcome: "YES",
      side: "BUY",
      price: 0.62,
      size: 5,
      timestamp: 1000 + config.shadowCopyDelayMs + 1000
    }
  ];
  const shadow = runShadowBacktest("0xshadow", sourceTrades, [market], config, 5000, marketTape);
  assert.equal(shadow[0].status, "SIMULATED");
  assert.equal(shadow[0].simulatedExitPrice, 0.62);
});

test("shadow backtest falls back to source price when no later mark exists", () => {
  const shadow = runShadowBacktest("0xshadow", [{
    wallet: "0xshadow",
    marketId: "m1",
    outcome: "YES",
    side: "BUY",
    price: 0.5,
    size: 20,
    timestamp: 1000
  }], [market], config, 5000);
  assert.equal(shadow[0].status, "SIMULATED");
  assert.equal(shadow[0].exitReason, "source price fallback");
  assert.ok(shadow[0].pnl < 0);
});

test("shadow performance adjusts wallet source score", () => {
  const trades = runShadowBacktest("0xshadow", [
    {
      wallet: "0xshadow",
      marketId: "m1",
      tokenId: "yes-token",
      outcome: "YES",
      side: "BUY",
      price: 0.5,
      size: 20,
      timestamp: 1000
    },
    {
      wallet: "0xshadow",
      marketId: "m1",
      tokenId: "yes-token",
      outcome: "YES",
      side: "SELL",
      price: 0.7,
      size: 20,
      timestamp: 1000 + config.shadowCopyDelayMs + 1000
    }
  ], [market], config, 5000);
  const performance = summarizeShadowPerformanceByWallet(trades).get("0xshadow");
  const adjusted = applyShadowPerformanceToScore({
    wallet: "0xshadow",
    score: 60,
    copyabilityScore: 60,
    tradeCount: 20,
    recentTradeCount: 5,
    reliability: "MEDIUM",
    flags: [],
    sampleConfidence: 0.8,
    updatedAt: Date.now()
  }, performance);
  assert.ok((adjusted.shadowScoreImpact ?? 0) > 0);
  assert.ok(adjusted.score > 60);
  assert.equal(adjusted.shadowSimulated, 1);
});

test("category shadow performance can boost matching market signals", () => {
  const cryptoMarket = {
    ...market,
    question: "Will Bitcoin close above 100k?",
    slug: "bitcoin-close-above-100k"
  };
  const trades = [{
    wallet: "0xshadow",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    side: "BUY" as const,
    price: 0.5,
    size: 20,
    timestamp: 1000
  }, {
    wallet: "0xshadow",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    side: "SELL" as const,
    price: 0.75,
    size: 20,
    timestamp: 1000 + config.shadowCopyDelayMs + 1000
  }];
  const shadow = runShadowBacktest("0xshadow", trades, [cryptoMarket], config, 5000);
  const categoryPerformance = summarizeShadowPerformanceByWalletAndCategory(shadow).get("0xshadow:crypto");
  assert.equal(categoryPerformance?.category, "crypto");

  const plain = generateSignals(cryptoMarket, [book], [trades[0]], [{
    wallet: "0xshadow",
    score: 65,
    tradeCount: 30,
    recentTradeCount: 2,
    reliability: "MEDIUM",
    flags: [],
    updatedAt: Date.now()
  }], config)[0];
  const boosted = generateSignals(cryptoMarket, [book], [trades[0]], [{
    wallet: "0xshadow",
    score: 65,
    shadowCategoryImpacts: { crypto: 8 },
    tradeCount: 30,
    recentTradeCount: 2,
    reliability: "MEDIUM",
    flags: [],
    updatedAt: Date.now()
  }], config)[0];
  assert.ok(boosted.confidence > plain.confidence);
});

test("database stores shadow trades and reports aggregate performance", () => {
  const path = "data/test-shadow.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch {
      // test cleanup is best effort
    }
  }
  const db = new BotDatabase(path);
  const shadow = runShadowBacktest("0xshadow", [{
    wallet: "0xshadow",
    marketId: "m1",
    outcome: "YES",
    side: "BUY",
    price: 0.5,
    size: 20,
    timestamp: 1000
  }], [{ ...market, resolved: true, winningOutcome: "YES" }], config, 5000);
  assert.equal(db.saveShadowTrades(shadow), 1);
  const report = db.getShadowBacktestReport();
  assert.equal(report.total, 1);
  assert.equal(report.simulated, 1);
  assert.ok(report.pnl > 0);
  const excludedBackfill = db.getForwardShadowScorecard(1001);
  assert.equal(excludedBackfill.total, 0);
  db.saveShadowTrades([
    durableShadowTrade("forward", "0xshadow", 1.5, 0.15, { sourceTimestamp: 2000, category: "politics" })
  ]);
  const forward = db.getForwardShadowScorecard(1001);
  assert.equal(forward.total, 1);
  assert.equal(forward.liveExecutableSimulated, 1);
  assert.equal(forward.liveExecutablePnl, 1.5);
  assert.equal(forward.categories[0]?.category, "politics");
  db.close();
});

test("public wallet previews do not expose wallet addresses", () => {
  const previews = publicWalletPreviews([{
    address: "0xprivate",
    score: 90,
    copyabilityScore: 88,
    hotScore: 70,
    categoryConsistencyScore: 75,
    exitBehaviorScore: 65,
    sampleConfidence: 0.9,
    dominantCategory: "politics",
    resolvedMarkets: 3,
    resolvedWins: 2,
    resolvedLosses: 1,
    resolvedWinRate: 2 / 3,
    tradeCount: 30,
    buyCount: 20,
    sellCount: 10,
    uniqueMarkets: 8,
    totalVolume: 12000,
    avgTradeSize: 400,
    realizedPnlApprox: 200,
    profitFactorApprox: 2,
    winRateApprox: 0.62,
    avgReturnPctApprox: 0.1,
    maxDrawdownApprox: 0.08,
    avgHoldMinutesApprox: 180,
    openPositionCount: 2,
    openPositionValue: 500,
    openPositionPnlApprox: 40,
    flags: [],
    firstSeenAt: Date.now(),
    lastSeenAt: Date.now()
  }]);
  assert.equal("address" in previews[0], false);
  assert.equal(previews[0].volumeBand, "HIGH");
});

test("dashboard read model exposes public-safe summaries", () => {
  const path = "data/test-dashboard.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch {
      // test cleanup is best effort
    }
  }
  const db = new BotDatabase(path);
  db.saveDiscoveredWallet({
    address: "0xsecret",
    score: 82,
    copyabilityScore: 79,
    hotScore: 75,
    categoryConsistencyScore: 70,
    exitBehaviorScore: 65,
    sampleConfidence: 0.8,
    dominantCategory: "crypto",
    tradeCount: 44,
    buyCount: 24,
    sellCount: 20,
    uniqueMarkets: 12,
    totalVolume: 12000,
    avgTradeSize: 272,
    realizedPnlApprox: 150,
    profitFactorApprox: 2.1,
    winRateApprox: 0.62,
    avgReturnPctApprox: 0.07,
    maxDrawdownApprox: 0.08,
    avgHoldMinutesApprox: 90,
    openPositionCount: 2,
    openPositionValue: 80,
    openPositionPnlApprox: 6,
    resolvedMarkets: 4,
    resolvedWins: 3,
    resolvedLosses: 1,
    resolvedWinRate: 0.75,
    flags: [],
    firstSeenAt: 1000,
    lastSeenAt: 2000
  });
  db.saveWalletScore({
    wallet: "0xsecret",
    score: 82,
    copyabilityScore: 79,
    tradeCount: 44,
    recentTradeCount: 6,
    reliability: "HIGH",
    flags: [],
    updatedAt: 2000,
    shadowScoreImpact: 4
  });
  db.saveSignal({
    id: "sig_dash",
    decision: "TRADE_CANDIDATE",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    side: "BUY",
    confidence: 91,
    limitPrice: 0.56,
    alignedWallets: ["0xsecret"],
    reason: "dashboard test signal",
    createdAt: 3000
  });
  db.saveAgentEvent({
    id: "evt_dash",
    type: "source.scored",
    agent: "Signal Agent",
    visibility: "PUBLIC",
    message: "Source scored.",
    payload: { wallet: "0xsecret", score: 82 },
    createdAt: 4000
  });
  db.saveShadowTrades(runShadowBacktest("0xsecret", [{
    wallet: "0xsecret",
    marketId: "m1",
    outcome: "YES",
    side: "BUY",
    price: 0.5,
    size: 10,
    timestamp: 1000
  }], [{ ...market, question: "Will Ethereum rally?", slug: "ethereum-rally" }], config, 5000));

  const dashboard = buildDashboardReadModel(db);
  const admin = buildAdminDashboardReadModel(db);
  assert.equal(dashboard.wallets[0]?.sourceStrength, 79);
  assert.equal(dashboard.signals[0]?.alignedSourceCount, 1);
  assert.ok(!JSON.stringify(dashboard).includes("0xsecret"));
  assert.equal(dashboard.shadowCategories[0]?.category, "crypto");
  assert.ok(Array.isArray(dashboard.trends.shadowCategories));
  assert.ok(Array.isArray(dashboard.tradeLedger));
  assert.equal(dashboard.sourceCategories[0]?.category, "other");
  assert.ok(JSON.stringify(admin).includes("0xsecret"));
  assert.equal(admin.walletScores[0]?.score, 82);
  assert.ok(admin.scoreHistory.length > 0);
  db.close();
});

test("telegram routes public alerts away from admin commands", async () => {
  const calls: Array<{ chat_id: string; text: string; reply_markup?: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const telegram = new TelegramAlerts({
      gammaApiUrl: "https://gamma.example",
      dataApiUrl: "https://data.example",
      clobApiUrl: "https://clob.example",
      clobWsUrl: "wss://clob.example",
      dbPath: ":memory:",
      telegramBotToken: "token",
      telegramAdminChatId: "admin-chat",
      telegramPublicChatId: "@public_channel"
    });

    await telegram.sendApproved({
      outcome: "YES",
      question: "Will routing work?",
      price: 0.51,
      size: 5,
      confidence: 88
    });
    await telegram.sendPaperEntry({
      outcome: "YES",
      marketId: "m1",
      price: 0.51,
      sizeUsd: 5,
      shares: 9.8,
      unrealizedPnl: 0,
      totalPnl: 1.25,
      equity: 201.25,
      availableCash: 195
    });
    await telegram.sendExit({
      outcome: "YES",
      marketId: "m1",
      reason: "take profit reached",
      price: 0.7,
      sizeUsd: 6.86,
      realizedPnl: 1.86,
      totalPnl: 2.4,
      equity: 202.4,
      availableCash: 202.4
    });
    await telegram.sendRejectedSummary({ rejected: 2, reasons: new Map([["too far from resolution; capital lockup risk (900h)", 2]]) });

    assert.equal(calls[0]?.chat_id, "@public_channel");
    assert.equal(calls[0]?.reply_markup, undefined);
    assert.match(calls[0]?.text, /BUY Signal Approved/);
    assert.match(calls[1]?.text, /Paper Trade Opened/);
    assert.match(calls[1]?.text, /Total PnL/);
    assert.match(calls[2]?.text, /Trade PnL/);
    assert.equal(calls[3]?.chat_id, "admin-chat");
    assert.ok(calls[3]?.reply_markup);
    assert.match(calls[3]?.text, /Risk Filter Summary/);
    assert.match(calls[3]?.text, /Capital Lockup/);
    assert.match(calls[3]?.text, /active, copyable opportunities/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function sampleSignal(overrides: Partial<TradeSignal> = {}): TradeSignal {
  return {
    id: "sig1",
    decision: "TRADE_CANDIDATE",
    marketId: "m1",
    conditionId: "c1",
    tokenId: "yes-token",
    outcome: "YES",
    side: "BUY",
    confidence: 82,
    limitPrice: 0.53,
    alignedWallets: ["0xabc"],
    reason: "test",
    createdAt: Date.now(),
    ...overrides
  };
}

function durableShadowTrade(
  id: string,
  wallet: string,
  livePnl: number,
  liveReturnPct: number,
  overrides: Partial<ShadowTrade> = {}
): ShadowTrade {
  return {
    id,
    wallet,
    marketId: "m1",
    category: "other",
    tokenId: "yes-token",
    outcome: "YES",
    sourceTimestamp: 1000,
    detectedAt: 2000,
    sourcePrice: 0.5,
    simulatedEntryPrice: 0.52,
    simulatedExitPrice: 0.7,
    sizeUsd: 10,
    pnl: livePnl,
    returnPct: liveReturnPct,
    liveExecutablePnl: livePnl,
    liveExecutableReturnPct: liveReturnPct,
    liveExecutableStatus: "EXECUTABLE",
    liveExecutableReason: "test",
    liveExecutableEntryPrice: 0.52,
    liveExecutableExitPrice: 0.7,
    liveExecutableEntrySlippage: 0.02,
    liveExecutableExitSlippage: 0.03,
    status: "SIMULATED",
    exitReason: "source sell after detection",
    forwardEligible: true,
    policyVersion: "live-shadow-parity-v1",
    createdAt: Date.now(),
    ...overrides
  };
}

test("weather parser honors the named station, date, unit, and terminal bucket", () => {
  const market: MarketSnapshot = {
    id: "weather-1", question: "Will the highest temperature in London be 26°C on August 10?",
    slug: "highest-temperature-in-london-on-august-10-2026-26c", active: true, closed: false,
    archived: false, acceptingOrders: true, liquidity: 10_000, volume24h: 5_000,
    outcomes: ["Yes", "No"], outcomePrices: [0.35, 0.65], clobTokenIds: ["yes", "no"],
    raw: { description: "This market resolves using https://www.wunderground.com/history/daily/gb/london/EGLC" }
  };
  const parsed = parseWeatherMarket(market, Date.UTC(2026, 7, 9));
  assert.deepEqual(parsed, {
    city: "London", stationCode: "EGLC", targetDate: "2026-08-10", unit: "C",
    bucket: "EXACT", lower: 26, upper: 26
  });
  const fair = probabilityForBucket([25.9, 26, 26.1, 30], parsed!, 0.5);
  assert.ok(fair > 0.45 && fair < 0.65);
});

test("wallet research clusters are model leads and not direct strategy proof", () => {
  const maker = buildWalletResearchReport({
    wallet: "0xmaker", entries: [{ rank: 1, wallet: "0xmaker", pnl: 1_000, volume: 10_000, category: "WEATHER", period: "MONTH" }]
  }, [
    { wallet: "0xmaker", marketId: "m", outcome: "YES", side: "BUY", price: 0.5, size: 30, timestamp: 1, raw: { transactionHash: "maker" } }
  ], [], [], 10);
  assert.deepEqual(clustersFor({ ...maker, archetype: "MAKER_SPECIALIST" }), ["MAKER_PRICING"]);
  assert.ok(clustersFor({ ...maker, archetype: "DIRECTIONAL_SPECIALIST" }).includes("WEATHER_FORECASTING"));
});

test("independent model signals use fractional Kelly with risk and liquidity caps", () => {
  const decision = calculateDynamicPositionSize(sampleSignal({
    signalOrigin: "INDEPENDENT_MODEL", alignedWallets: [], fairProbability: 0.7,
    marketProbability: 0.5, probabilityEdge: 0.2, modelUncertainty: 0.15,
    modelAgreement: 0.85, entryBookDepth: 1_000
  }), { openExposure: 0, dailyPnl: 0, lossStreak: 0, tradesToday: 0 }, {
    ...config, bankroll: 500, minPositionSize: 5, maxPositionSize: 25, maxOpenExposure: 50,
    reserveCashPct: 0.9, kellyFraction: 0.25, maxDynamicPositionPct: 0.05, maxBookDepthPct: 0.1
  });
  assert.equal(decision.sizingMethod, "FRACTIONAL_KELLY");
  assert.ok(decision.positionSize > 5 && decision.positionSize <= 25);
  assert.equal(decision.exposureCap, 50);
});

test("wallet intelligence accepts independently validated model origin without fake wallet alignment", () => {
  const report = new WalletIntelligenceAgent().reviewSignal(sampleSignal({
    signalOrigin: "INDEPENDENT_MODEL", alignedWallets: [], probabilityEdge: 0.14,
    modelAgreement: 0.9, modelUncertainty: 0.15, forecastSampleSize: 120
  }), [], []);
  assert.equal(report.state, "MODEL_INDEPENDENT");
  assert.ok(report.score >= 65);
  assert.equal(report.alignedWallets, 0);
});

test("live-executable tape model credits a realistic source edge instead of spending the slippage cap", () => {
  // Regression: the exit leg used to subtract the whole maxExitSlippage from every
  // source-sell exit, so a source that made 10% at 0.50 modelled as a ~2% copy and
  // fell under liveExecutableMinReturnPct. That starved hasLiveExecutableProof and
  // froze the live gate: no wallet could ever accumulate qualifying evidence.
  const tapeConfig: BotConfig = {
    ...config,
    orderTickSize: 0.01,
    maxEntrySlippage: 0.03,
    maxExitSlippage: 0.03,
    liveExecutableMinReturnPct: 0.03,
    minPositionSize: 10
  };
  const result = estimateTapeExecutableShadow({
    sourcePrice: 0.5,
    entryPrice: 0.5 * (1 + copyDelayPriceMovePct(tapeConfig)),
    exitPrice: 0.55,
    sourceBuySize: 10_000,
    sourceSellSize: 10_000,
    sizeUsd: 15,
    exitReason: "source sell after detection",
    config: tapeConfig
  });

  assert.equal(result.status, "EXECUTABLE");
  assert.ok(
    (result.returnPct ?? 0) > (tapeConfig.liveExecutableMinReturnPct ?? 0.03),
    `expected a 10% source win to clear the live-exec bar, got ${((result.returnPct ?? 0) * 100).toFixed(2)}%`
  );
});

test("live-executable tape model charges entry and exit the same expected move", () => {
  // The cap is a limit on the worst fill we would accept, not a per-trade fee, so
  // widening it must not make the modelled round trip more expensive.
  const tight: BotConfig = { ...config, orderTickSize: 0.01, maxEntrySlippage: 0.03, maxExitSlippage: 0.03, minPositionSize: 10 };
  const wide: BotConfig = { ...tight, maxExitSlippage: 0.1 };
  const inputs = {
    sourcePrice: 0.5,
    entryPrice: 0.5 * (1 + copyDelayPriceMovePct(tight)),
    exitPrice: 0.55,
    sourceBuySize: 10_000,
    sourceSellSize: 10_000,
    sizeUsd: 15,
    exitReason: "source sell after detection" as const
  };

  const tightResult = estimateTapeExecutableShadow({ ...inputs, config: tight });
  const wideResult = estimateTapeExecutableShadow({ ...inputs, config: wide });

  assert.equal(tightResult.pnl, wideResult.pnl);
  assert.equal(tightResult.entrySlippage, tightResult.exitSlippage);
  assert.ok((wideResult.exitSlippage ?? 0) < (wide.maxExitSlippage ?? 0.1));
});

test("live-executable tape model still rejects an exit that breaches the slippage cap", () => {
  const strict: BotConfig = { ...config, orderTickSize: 0.01, maxEntrySlippage: 0.03, maxExitSlippage: 0.005, minPositionSize: 10 };
  const result = estimateTapeExecutableShadow({
    sourcePrice: 0.8,
    entryPrice: 0.8,
    exitPrice: 0.8,
    sourceBuySize: 10_000,
    sourceSellSize: 10_000,
    sizeUsd: 15,
    exitReason: "source sell after detection",
    config: strict
  });

  assert.equal(result.status, "MISSED");
  assert.equal(result.reason, "exit slippage exceeds cap");
});

test("live-executable tape model does not charge a spread cross on resolution exits", () => {
  const tapeConfig: BotConfig = { ...config, orderTickSize: 0.01, maxEntrySlippage: 0.03, maxExitSlippage: 0.03, minPositionSize: 10 };
  const result = estimateTapeExecutableShadow({
    sourcePrice: 0.4,
    entryPrice: 0.4 * (1 + copyDelayPriceMovePct(tapeConfig)),
    exitPrice: 1,
    sourceBuySize: 10_000,
    sourceSellSize: 10_000,
    sizeUsd: 15,
    exitReason: "resolved market outcome",
    config: tapeConfig
  });

  assert.equal(result.status, "EXECUTABLE");
  assert.ok((result.exitPrice ?? 0) >= 0.99);
});

test("live-executable tape model scales exit cost with price instead of a flat haircut", () => {
  // A flat cap-sized haircut is a fraction of a cent on a 0.80 outcome but a fifth
  // of the position on a 0.15 one, which made cheap outcomes look structurally
  // unprofitable no matter how well the source traded.
  const tapeConfig: BotConfig = { ...config, orderTickSize: 0.01, maxEntrySlippage: 0.03, maxExitSlippage: 0.03, minPositionSize: 10 };
  const cheap = estimateTapeExecutableShadow({
    sourcePrice: 0.15,
    entryPrice: 0.15 * (1 + copyDelayPriceMovePct(tapeConfig)),
    exitPrice: 0.18,
    sourceBuySize: 10_000,
    sourceSellSize: 10_000,
    sizeUsd: 15,
    exitReason: "source sell after detection",
    config: tapeConfig
  });

  assert.equal(cheap.status, "EXECUTABLE");
  assert.ok((cheap.returnPct ?? 0) > 0, `a 20% source win at 0.15 should not model as a loss, got ${((cheap.returnPct ?? 0) * 100).toFixed(2)}%`);
});

test("recomputing live-executable shadow history rewrites results under the current model", () => {
  // The live gate reads stored live_executable_* columns, so a model change is
  // invisible to it until history is recomputed. Rows written under a model that
  // spent the whole exit cap must be repriced, not left to block the gate forever.
  const dbPath = "./data/test-liveexec-recompute.sqlite";
  try {
    unlinkSync(dbPath);
  } catch {
    // first run
  }
  const db = new BotDatabase(dbPath);
  const tapeConfig: BotConfig = {
    ...config,
    orderTickSize: 0.01,
    maxEntrySlippage: 0.03,
    maxExitSlippage: 0.03,
    liveExecutableMinReturnPct: 0.03,
    minPositionSize: 10
  };

  // A 10% source win stored the way the old model priced it: exit haircut by the
  // full cap, leaving the copy under the live-exec bar.
  db.saveShadowTrades([{
    id: "stale-model-row",
    wallet: "0xabc",
    marketId: "m1",
    tokenId: "t1",
    outcome: "Yes",
    sourceTimestamp: Date.now() - 60_000,
    detectedAt: Date.now() - 50_000,
    sourcePrice: 0.5,
    simulatedEntryPrice: 0.5 * (1 + copyDelayPriceMovePct(tapeConfig)),
    simulatedExitPrice: 0.55,
    sizeUsd: 15,
    pnl: 1.5,
    returnPct: 0.1,
    liveExecutablePnl: 0.29,
    liveExecutableReturnPct: 0.0196,
    liveExecutableStatus: "EXECUTABLE",
    liveExecutableReason: "live executable tape model",
    status: "SIMULATED",
    exitReason: "source sell after detection",
    createdAt: Date.now()
  }]);

  const before = db.getShadowBacktestReport();
  assert.ok((before.liveExecutableAvgReturnPct ?? 0) < (tapeConfig.liveExecutableMinReturnPct ?? 0.03));

  const result = db.recomputeLiveExecutableShadow(tapeConfig);
  assert.equal(result.scanned, 1);
  assert.equal(result.updated, 1);

  const after = db.getShadowBacktestReport();
  assert.ok(
    (after.liveExecutableAvgReturnPct ?? 0) > (tapeConfig.liveExecutableMinReturnPct ?? 0.03),
    `recompute should lift the stored edge above the live-exec bar, got ${((after.liveExecutableAvgReturnPct ?? 0) * 100).toFixed(2)}%`
  );
  assert.ok((after.liveExecutablePnl ?? 0) > (before.liveExecutablePnl ?? 0));
  db.close();
});

test("with paper exploration disabled an unproven source cannot become a trade candidate", () => {
  // Production configuration: the exploration/probation lane is off, so the live
  // gate is the only way in. A source that would have qualified as a scout must be
  // rejected outright for lacking live-executable proof rather than quietly
  // entering on relaxed paper thresholds.
  const strictConfig: BotConfig = {
    ...config,
    paperExplorationEnabled: false,
    paperProbationTradingEnabled: false,
    liveParityGateEnabled: true,
    entryOrderPolicy: "FOK",
    maxEntrySlippage: 0.03
  };
  const trade: WalletTrade = {
    wallet: "0xexplore",
    marketId: "m1",
    tokenId: "yes-token",
    outcome: "YES",
    side: "BUY",
    price: 0.52,
    size: 40,
    timestamp: Date.now()
  };
  const strongUnproven: WalletScore = {
    wallet: "0xexplore",
    label: "discovered",
    score: 88,
    copyabilityScore: 86,
    categoryConsistencyScore: 74,
    sampleConfidence: 0.72,
    sourceSellRealizedRatio: 0.31,
    tradeCount: 80,
    recentTradeCount: 10,
    reliability: "HIGH",
    flags: ["SHADOW_PROVEN_COPYABLE"],
    updatedAt: Date.now()
  };

  const result = generateSignalsWithDiagnostics(market, [book], [trade], [strongUnproven], strictConfig);
  assert.equal(result.signals.length, 0);
  assert.equal(result.diagnostics.sourceRejectReasons["live-executable proof below threshold"], 1);
});

test("exit decisions record the book they were decided against", () => {
  // Without this the Overseer evaluates every open position on every pass and keeps
  // no trace of the price that triggered the decision, so a stop-out cannot be
  // replayed against an alternative exit policy afterwards.
  const dbPath = "./data/test-exit-marks.sqlite";
  try {
    unlinkSync(dbPath);
  } catch {
    // first run
  }
  const db = new BotDatabase(dbPath);
  db.saveExitDecision("pos-1", { decision: "HOLD", exitProbability: 0, reason: "no exit trigger" }, {
    bestBid: 0.42,
    bestAsk: 0.44,
    entryPrice: 0.5,
    size: 20
  });

  const row = db.getExitEventMarks("pos-1")[0];
  assert.equal(row.bestBid, 0.42);
  assert.equal(row.entryPrice, 0.5);
  assert.equal(row.unrealizedPnl, 20 * (0.42 - 0.5));
  db.close();
});

test("generic event timestamps do not misclassify macro markets as sports", () => {
  const macroMarket: MarketSnapshot = {
    ...market,
    id: "macro-event",
    question: "Will the S&P 500 close above 7,000?",
    raw: { eventStartTime: "2026-08-12T14:30:00Z" }
  };
  assert.equal(inferMarketCategory(macroMarket), "macro");
});

test("frozen weather policy accepts only NO mid-price moderate-edge candidates", () => {
  const policyConfig: BotConfig = {
    ...config,
    weatherAllowedOutcomes: ["NO"],
    weatherMinEntryPrice: 0.4,
    weatherMaxEntryPrice: 0.7,
    weatherMinProbabilityEdge: 0.15,
    weatherMaxProbabilityEdge: 0.5
  };
  assert.equal(evaluateWeatherCandidatePolicy({ outcome: "NO", marketProbability: 0.55, probabilityEdge: 0.25 }, policyConfig).passed, true);
  assert.equal(evaluateWeatherCandidatePolicy({ outcome: "YES", marketProbability: 0.55, probabilityEdge: 0.25 }, policyConfig).passed, false);
  assert.equal(evaluateWeatherCandidatePolicy({ outcome: "NO", marketProbability: 0.2, probabilityEdge: 0.25 }, policyConfig).passed, false);
  assert.equal(evaluateWeatherCandidatePolicy({ outcome: "NO", marketProbability: 0.55, probabilityEdge: 0.7 }, policyConfig).passed, false);
});

test("candidate allocation ranks globally and keeps one exposure per event", () => {
  const baseIndependent = sampleSignal({
    signalOrigin: "INDEPENDENT_MODEL",
    strategyEventKey: "weather:eglc:2026-08-12",
    marketProbability: 0.7,
    probabilityEdge: 0.49,
    modelUncertainty: 0.25,
    modelAgreement: 0.7,
    entryBookDepth: 100
  });
  const better = {
    ...baseIndependent,
    id: "better",
    marketProbability: 0.55,
    limitPrice: 0.55,
    probabilityEdge: 0.3
  };
  const otherEvent = {
    ...better,
    id: "other",
    strategyEventKey: "weather:kjfk:2026-08-12"
  };
  const ranked = rankAndDiversifyCandidates([
    { market, books: [book], signal: baseIndependent },
    { market, books: [book], signal: better },
    { market: { ...market, id: "m2" }, books: [book], signal: otherEvent }
  ]);
  assert.deepEqual(ranked.selected.map((candidate) => candidate.signal.id), ["better", "other"]);
  assert.deepEqual(ranked.skipped.map((candidate) => candidate.signal.id), [baseIndependent.id]);
});

test("uncalibrated independent models use a flat experiment size instead of Kelly", () => {
  const independent = sampleSignal({
    signalOrigin: "INDEPENDENT_MODEL",
    fairProbability: 0.8,
    marketProbability: 0.5,
    probabilityEdge: 0.3,
    modelUncertainty: 0.1,
    modelAgreement: 0.9,
    entryBookDepth: 100
  });
  const decision = decideRisk(independent, { approved: true, score: 90, reasons: [] }, {
    openExposure: 0,
    dailyPnl: 0,
    lossStreak: 0,
    tradesToday: 0
  }, { ...config, independentModelFlatPositionSize: 3, dynamicSizingEnabled: true });
  assert.equal(decision.decision, "APPROVE");
  assert.equal(decision.positionSize, 3);
  assert.equal(decision.sizingMethod, "EXPERIMENTAL_FLAT");
});

test("weather forward scorecard excludes pre-policy, unselected, and wrong-policy rows", () => {
  const path = "data/test-weather-forward.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch {
      // test cleanup is best effort
    }
  }
  const db = new BotDatabase(path);
  db.saveMarket({
    ...market,
    id: "weather-resolved",
    resolved: true,
    active: false,
    closed: true,
    winningOutcome: "NO",
    feesEnabled: false
  });
  const save = (signalId: string, createdAt: number, policyVersion: string, selected: boolean) => {
    db.saveWeatherOpportunity({
      id: `opp-${signalId}`,
      signalId,
      marketId: "weather-resolved",
      tokenId: "no-token",
      outcome: "NO",
      spec: { city: "London", stationCode: "EGLC", targetDate: "2026-08-12", unit: "C", bucket: "EXACT", lower: 25, upper: 25 },
      fairProbability: 0.65,
      marketProbability: 0.5,
      probabilityEdge: 0.15,
      expectedValuePct: 0.3,
      uncertainty: 0.2,
      agreement: 0.8,
      forecastSampleSize: 51,
      policyVersion,
      strategyEventKey: `weather:eglc:${signalId}`,
      status: "CANDIDATE",
      reason: "test",
      createdAt
    });
    if (selected) db.markWeatherOpportunitySelected(signalId);
  };
  save("pre", 500, "v1", true);
  save("forward", 2_000, "v1", true);
  save("watchlist", 2_100, "v1", false);
  save("wrong-policy", 2_200, "v0", true);
  const scorecard = db.getWeatherForwardScorecard({
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
  assert.equal(scorecard.settlementPnl, 5);
  assert.equal(scorecard.promotionEligible, false);
  assert.match(scorecard.promotionReason, /walk-forward validation/);
  const immutableSelection = db.getForwardSelections(1)[0];
  db.close();
  const raw = new DatabaseSync(path);
  assert.throws(
    () => raw.prepare("DELETE FROM forward_selections WHERE id = ?").run(immutableSelection.id),
    /append-only/
  );
  raw.close();
});

test("weather immutable selection rejects a second candidate for the same station-date exposure", () => {
  const path = "data/test-weather-event-dedupe.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch {
      // test cleanup is best effort
    }
  }
  const db = new BotDatabase(path);
  const save = (signalId: string, marketId: string, tokenId: string) => db.saveWeatherOpportunity({
    id: `opp-${signalId}`,
    signalId,
    marketId,
    tokenId,
    outcome: "NO",
    spec: { city: "Milan", stationCode: "LIMC", targetDate: "2026-08-17", unit: "C", bucket: "EXACT", lower: 28, upper: 28 },
    fairProbability: 0.7,
    marketProbability: 0.5,
    probabilityEdge: 0.2,
    expectedValuePct: 0.4,
    uncertainty: 0.2,
    agreement: 0.8,
    forecastSampleSize: 51,
    policyVersion: "weather-v1",
    strategyEventKey: "weather:limc:2026-08-17",
    status: "CANDIDATE",
    reason: "test",
    createdAt: signalId === "first" ? 1_000 : 2_000
  });
  save("first", "milan-28", "no-28");
  save("second", "milan-29", "no-29");

  assert.equal(db.markWeatherOpportunitySelected("first"), true);
  assert.equal(db.markWeatherOpportunitySelected("second"), false);
  assert.equal(db.getForwardSelections(10).length, 1);
  db.close();
});

test("daily scorecards are insert-only and retain the first frozen verdict", () => {
  const path = "data/test-daily-scorecards.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch {
      // test cleanup is best effort
    }
  }
  const db = new BotDatabase(path);
  const scorecard = {
    schemaVersion: 1,
    snapshotDate: "2026-08-14",
    createdAt: 100,
    policyFingerprint: "policy-a",
    actualPaper: { totalPnl: 4 }
  } as DailyCoreScorecard;
  const snapshot = {
    id: "daily-core:2026-08-14:policy-a",
    snapshotDate: "2026-08-14",
    policyFingerprint: "policy-a",
    scorecard,
    createdAt: 100
  };
  assert.equal(db.saveDailyScorecardSnapshot(snapshot), true);
  assert.equal(db.saveDailyScorecardSnapshot({
    ...snapshot,
    scorecard: { ...scorecard, actualPaper: { ...scorecard.actualPaper, totalPnl: 999 } }
  }), false);
  assert.equal(db.getLatestDailyScorecardSnapshot()?.scorecard.actualPaper.totalPnl, 4);
  db.close();
  const raw = new DatabaseSync(path);
  assert.throws(
    () => raw.prepare("UPDATE daily_scorecard_snapshots SET scorecard_json = '{}' WHERE id = ?").run(snapshot.id),
    /append-only/
  );
  raw.close();
});
