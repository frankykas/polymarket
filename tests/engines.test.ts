import test from "node:test";
import assert from "node:assert/strict";
import {
  PaperExecutionEngine,
  decideExit,
  decideRisk,
  evaluateMarketQuality,
  generateSignals,
  scoreWallet
} from "../src/engines.js";
import type { BotConfig, MarketSnapshot, OrderBookSnapshot, TradeSignal, WalletTrade } from "../src/types.js";

const config: BotConfig = {
  paperMode: true,
  bankroll: 200,
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
  maxWatchedMarkets: 40
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
