import test from "node:test";
import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { DecisionCouncil } from "../src/agents/decisionCouncil.js";
import { MarketIntelligenceAgent } from "../src/agents/marketIntelligenceAgent.js";
import { applyMicrostructureToQuality, MicrostructureAgent } from "../src/agents/microstructureAgent.js";
import { BotDatabase } from "../src/db.js";
import { RiskMitigationAgent } from "../src/agents/riskMitigationAgent.js";
import { WalletIntelligenceAgent } from "../src/agents/walletIntelligenceAgent.js";
import { buildAdminDashboardReadModel, buildDashboardReadModel } from "../src/dashboard/readModel.js";
import {
  PaperExecutionEngine,
  applyPaperPerformanceToScore,
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
import { TelegramAlerts } from "../src/telegram.js";
import type { BotConfig, MarketSnapshot, OrderBookSnapshot, TradeSignal, WalletScore, WalletTrade } from "../src/types.js";

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
  db.savePaperEntry({ ...simulated.position, currentPrice: 0.65 });

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
  db.savePaperEntry({ ...simulated.position, currentPrice: 0.65 });

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
  const profit = decideExit(position, { ...book, bestBid: 0.6 }, config, { trackedWalletReducing: true, volumeSpike: true });
  assert.equal(profit.decision, "FULL_EXIT");
  const stale = decideExit({
    ...position,
    openedAt: Date.now() - 73 * 60 * 60 * 1000
  }, { ...book, bestBid: 0.5 }, config);
  assert.equal(stale.decision, "FULL_EXIT");
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

  // Cooldown blocks re-entry only after a losing close of the same token.
  assert.equal(db.isMarketInStopCooldown("m1", "yes-token", 3_600_000, 5000), false);
  db.savePosition({ ...entered, realizedPnl: -0.3, status: "CLOSED", updatedAt: 4000 });
  assert.equal(db.isMarketInStopCooldown("m1", "yes-token", 3_600_000, 5000), true);
  assert.equal(db.isMarketInStopCooldown("m1", "yes-token", 3_600_000, 4000 + 3_600_001), false);
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
