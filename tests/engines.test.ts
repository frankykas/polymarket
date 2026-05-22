import test from "node:test";
import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { BotDatabase } from "../src/db.js";
import {
  PaperExecutionEngine,
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
  autoTrackDiscoveredWallets: true
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
  const trades: WalletTrade[] = Array.from({ length: 10 }, (_, index) => ({
    wallet: "0xabc",
    marketId: `m${index % 3}`,
    outcome: "YES",
    side: "BUY",
    price: 0.5,
    size: 10,
    timestamp: Date.now()
  }));
  const score = scoreWallet({ address: "0xabc", enabled: true }, trades);
  assert.equal(score.reliability, "HIGH");
  assert.equal(score.flags.includes("LOW_SAMPLE"), false);
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
  assert.ok(wallets[0].score > 50);
  assert.ok(wallets[0].copyabilityScore > 40);
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

test("public wallet previews do not expose wallet addresses", () => {
  const previews = publicWalletPreviews([{
    address: "0xprivate",
    score: 90,
    copyabilityScore: 88,
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
