import test from "node:test";
import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { BotDatabase } from "../src/db.js";
import { buildAdminDashboardReadModel, buildDashboardReadModel } from "../src/dashboard/readModel.js";
import {
  PaperExecutionEngine,
  applyShadowPerformanceToScore,
  decideExit,
  decideRisk,
  discoverWallets,
  evaluateMarketQuality,
  generateSignals,
  scoreWallet
} from "../src/engines.js";
import { AgentEventWriter } from "../src/events/eventWriter.js";
import { buildStrategyProfiles } from "../src/profiles/profiles.js";
import { publicWalletPreviews } from "../src/public/readModels.js";
import {
  runShadowBacktest,
  summarizeShadowBacktest,
  summarizeShadowPerformanceByWallet,
  summarizeShadowPerformanceByWalletAndCategory
} from "../src/shadowBacktest.js";
import type { BotConfig, MarketSnapshot, OrderBookSnapshot, TradeSignal, WalletTrade } from "../src/types.js";

const config: BotConfig = {
  paperMode: true,
  bankroll: 200,
  minPositionSize: 2,
  maxPositionSize: 5,
  maxOpenExposure: 25,
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
  limitOrderTtlMs: 120000,
  takeProfitPct: 0.18,
  stopLossPct: 0.08,
  volumeSpikeMultiplier: 3,
  spreadExitThreshold: 0.12,
  priceReversalPct: 0.06,
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
  shadowCopyDelayMs: 30000,
  shadowMaxEntryPriceMovePct: 0.05,
  shadowPositionSize: 5,
  shadowHistoryLimit: 500
};

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

test("risk vetoes exposure and approves healthy candidates", () => {
  const signal = sampleSignal();
  const quality = evaluateMarketQuality(market, [book], config);
  const approved = decideRisk(signal, quality, { openExposure: 0, dailyPnl: 0, lossStreak: 0, tradesToday: 0 }, config);
  assert.equal(approved.decision, "APPROVE");
  const rejected = decideRisk(signal, quality, { openExposure: 25, dailyPnl: 0, lossStreak: 0, tradesToday: 0 }, config);
  assert.equal(rejected.decision, "REJECT");
});

test("paper execution fills limit orders against executable asks", () => {
  const executor = new PaperExecutionEngine();
  const order = executor.createOrder(sampleSignal(), { decision: "APPROVE", positionSize: 5, reason: "ok" }, config);
  const simulated = executor.simulate(order, book);
  assert.equal(simulated.order.status, "FILLED");
  assert.ok(simulated.fill);
  assert.ok(simulated.position);
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
  const profit = decideExit(position, { ...book, bestBid: 0.6 }, config, { trackedWalletReducing: true, volumeSpike: true });
  assert.equal(profit.decision, "FULL_EXIT");
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
  assert.ok(JSON.stringify(admin).includes("0xsecret"));
  assert.equal(admin.walletScores[0]?.score, 82);
  assert.ok(admin.scoreHistory.length > 0);
  db.close();
});

function sampleSignal(): TradeSignal {
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
    createdAt: Date.now()
  };
}
