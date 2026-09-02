import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { BotDatabase } from "../src/db.js";
import { normalizeCryptoReferenceMessage, normalizeMarketStreamMessage } from "../src/clients.js";
import { includeCompleteNegativeRiskGraphs, includeCompleteThresholdLadderGroups, selectExecutionResearchUniverse } from "../src/research/executionUniverse.js";
import { CompressedMarketTapeWriter, readCompressedMarketTape } from "../src/research/marketTape.js";
import { CrossMarketSensitivityReplay } from "../src/research/crossMarketSensitivity.js";
import { mergeMarketStreamBook } from "../src/orderBookDelta.js";
import { executionPolicyEnabled } from "../src/research/executionPolicy.js";
import {
  buildBinaryPairArbitrageCandidate,
  buildMakerPairCandidate,
  buildNegRiskArbitrageCandidate,
  buildThresholdLadderArbitrageCandidate,
  ExecutionResearchCoordinator
} from "../src/research/executionShadowEngines.js";
import type { BotConfig, ExecutionResearchCandidate, ExecutionResearchResult, MarketSnapshot, OrderBookSnapshot } from "../src/types.js";

const config = {
  makerResearchQuoteShares: 10,
  makerResearchMinPairEdge: 0.01,
  makerResearchQuoteTtlMs: 30_000,
  makerResearchMinHedgeDepthMultiple: 3,
  makerResearchMaxHedgeLossPct: 0.02,
  pairedResearchShares: 10,
  pairedResearchMinNetEdge: 0.005,
  liveExecutionFeeRatePct: 0.07,
  executionResearchPolicyVersion: "execution-test-v1"
} as BotConfig;

test("failed execution policies can be frozen independently without disabling arbitrage observation", () => {
  const frozen = { ...config, executionResearchEnabled: true, makerResearchEnabled: false, crossMarketResearchEnabled: false };
  assert.equal(executionPolicyEnabled(frozen, "MAKER_PAIR"), false);
  assert.equal(executionPolicyEnabled(frozen, "CROSS_MARKET_LATENCY"), false);
  assert.equal(executionPolicyEnabled(frozen, "BINARY_PAIR_ARB"), true);
  assert.equal(executionPolicyEnabled(frozen, "THRESHOLD_LADDER_ARB"), true);
  assert.equal(executionPolicyEnabled({ ...frozen, executionResearchEnabled: false }, "BINARY_PAIR_ARB"), false);
});

test("execution universe prioritizes rewarded and negative-risk markets without trading category gates", () => {
  const ordinary = market({ id: "ordinary", volume24h: 10_000, liquidity: 5_000 });
  const rewarded = market({ id: "rewarded", volume24h: 10, rewardsDailyRate: 50, rewardsMinSize: 10, rewardsMaxSpread: 0.03 });
  const negRisk = market({ id: "neg", volume24h: 20, negRisk: true });
  const inactive = market({ id: "inactive", active: false, volume24h: 1_000_000 });
  const selected = selectExecutionResearchUniverse([ordinary, rewarded, negRisk, inactive], { limit: 3, minVolume24h: 1_000 });
  assert.deepEqual(new Set(selected.map((entry) => entry.market.id)), new Set(["ordinary", "rewarded", "neg"]));
  assert.equal(selected.some((entry) => entry.market.id === "inactive"), false);
  assert.ok(selected.find((entry) => entry.market.id === "rewarded")!.reasons.some((reason) => /rewards/.test(reason)));
});

test("execution universe reserves admission for short-horizon crypto latency markets", () => {
  const now = Date.now();
  const latency = market({
    id: "latency",
    question: "Will Bitcoin be above $60,000 tomorrow?",
    volume24h: 1,
    endDate: new Date(now + 12 * 60 * 60_000).toISOString()
  });
  const selected = selectExecutionResearchUniverse([latency], { limit: 1, minVolume24h: 1_000 });
  assert.equal(selected[0]?.market.id, "latency");
  assert.ok(selected[0]?.reasons.includes("short-horizon crypto reference market"));
});

test("execution universe admits negative-risk events only as complete standard graphs", () => {
  const base = selectExecutionResearchUniverse([market({ id: "base" })], { limit: 5, minVolume24h: 0 });
  const graph = [0, 1, 2].map((index) => market({
    id: `graph-${index}`,
    eventId: "complete-event",
    eventMarketCount: 3,
    negRisk: true,
    clobTokenIds: [`yes-${index}`, `no-${index}`]
  }));
  const selected = includeCompleteNegativeRiskGraphs(base, [graph], 5);
  assert.deepEqual(selected.slice(0, 3).map((entry) => entry.market.id).sort(), ["graph-0", "graph-1", "graph-2"]);
  const incomplete = includeCompleteNegativeRiskGraphs(base, [graph.slice(0, 2)], 5);
  assert.deepEqual(incomplete.map((entry) => entry.market.id), ["base"]);
});

test("execution universe reserves complete same-event crypto threshold ladders", () => {
  const base = selectExecutionResearchUniverse([
    market({ id: "high-volume-1", volume24h: 1_000_000 }),
    market({ id: "high-volume-2", volume24h: 900_000 })
  ], { limit: 2, minVolume24h: 0 });
  const endDate = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  const ladder = [58_000, 60_000, 62_000].map((threshold) => market({
    id: `btc-${threshold}`,
    eventId: "btc-threshold-event",
    question: `Will Bitcoin be above $${threshold.toLocaleString("en-US")} tomorrow?`,
    endDate,
    volume24h: 1,
    clobTokenIds: [`yes-${threshold}`, `no-${threshold}`]
  }));
  const selected = includeCompleteThresholdLadderGroups(base, ladder, 4);
  assert.deepEqual(new Set(selected.slice(0, 3).map((entry) => entry.market.id)), new Set(ladder.map((item) => item.id)));
  assert.ok(selected.slice(0, 3).every((entry) => entry.reasons.includes("complete same-event threshold ladder")));
});

test("market and reference websocket messages retain exchange and receive timestamps", () => {
  const receivedAt = 2_000;
  const updates = normalizeMarketStreamMessage({
    event_type: "price_change",
    timestamp: 1,
    market: "condition",
    price_changes: [
      { asset_id: "yes", price: "0.48", size: "25", side: "BUY", best_bid: "0.48", best_ask: "0.50" },
      { asset_id: "no", price: "0.51", size: "0", side: "SELL", best_bid: "0.49", best_ask: "0.51" }
    ]
  }, receivedAt);
  assert.equal(updates.length, 2);
  assert.equal(updates[0].eventType, "PRICE_CHANGE");
  assert.equal(updates[0].exchangeTimestamp, 1_000);
  assert.equal(updates[0].receivedAt, receivedAt);
  assert.deepEqual(updates[0].bookDelta, { price: 0.48, size: 25, side: "BUY" });
  assert.deepEqual(updates[1].bookDelta, { price: 0.51, size: 0, side: "SELL" });
  assert.equal(updates[0].lastTradePrice, undefined);
  const trade = normalizeMarketStreamMessage({ event_type: "last_trade_price", asset_id: "yes", price: "0.48", size: "12", side: "SELL" }, receivedAt)[0];
  assert.deepEqual(trade.trade, { price: 0.48, size: 12, side: "SELL" });
  const reference = normalizeCryptoReferenceMessage({ stream: "btcusdt@bookTicker", data: { s: "BTCUSDT", b: "60000", a: "60002" } }, receivedAt);
  assert.equal(reference?.price, 60_001);
  assert.equal(reference?.receivedAt, receivedAt);
});

test("price-change deltas preserve and update executable order-book depth", () => {
  const previous = book("yes", 0.48, 0.50, 30, 40);
  const updated = mergeMarketStreamBook(previous, {
    tokenId: "yes",
    bestBid: 0.49,
    bestAsk: 0.50,
    bookDelta: { price: 0.49, size: 20, side: "BUY" },
    timestamp: 2_000
  });
  assert.deepEqual(updated.bids, [{ price: 0.49, size: 20 }, { price: 0.48, size: 30 }]);
  assert.deepEqual(updated.asks, [{ price: 0.50, size: 40 }]);
  const removed = mergeMarketStreamBook(updated, {
    tokenId: "yes",
    bestBid: 0.48,
    bookDelta: { price: 0.49, size: 0, side: "BUY" },
    timestamp: 3_000
  });
  assert.deepEqual(removed.bids, [{ price: 0.48, size: 30 }]);
});

test("compressed tape uses immutable process segments that remain independently valid", async () => {
  const directory = "data/test-market-tape";
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const first = new CompressedMarketTapeWriter(directory, 2);
  first.recordMarket(market({ id: "m1" }), Date.parse("2026-08-15T12:00:00Z"));
  first.recordReference({ symbol: "BTCUSDT", bid: 1, ask: 3, price: 2, receivedAt: Date.parse("2026-08-15T12:00:01Z") });
  await first.close();
  const second = new CompressedMarketTapeWriter(directory, 2);
  second.recordReference({ symbol: "ETHUSDT", bid: 2, ask: 4, price: 3, receivedAt: Date.parse("2026-08-15T12:00:02Z") });
  await second.close();
  const files = readdirSync(directory).filter((name) => name.endsWith(".jsonl.gz")).sort();
  assert.equal(files.length, 2);
  const records = files
    .flatMap((name) => readCompressedMarketTape(`${directory}/${name}`))
    .sort((a, b) => a.receivedAt - b.receivedAt);
  assert.deepEqual(records.map((record) => record.recordType), ["MARKET_METADATA", "CRYPTO_REFERENCE", "CRYPTO_REFERENCE"]);
});

test("maker candidate models queue ahead and excludes rewards from base edge", () => {
  const target = market({ id: "maker", clobTokenIds: ["yes", "no"] });
  const quote = buildMakerPairCandidate(target, [
    book("yes", 0.47, 0.51, 25, 30),
    book("no", 0.48, 0.52, 30, 30)
  ], config, 1_000);
  assert.ok(quote);
  assert.ok(Math.abs(quote.candidate.expectedNetEdgeUsd - 0.5) < 1e-9);
  assert.deepEqual(quote.candidate.details.queueAhead, [25, 30]);
  assert.equal(quote.candidate.details.rewardsExcluded, true);
  assert.equal((quote.candidate.details.hedgeScenarios as Array<{ depthMultiple: number }>)[0].depthMultiple, 3);
});

test("maker candidate rejects unsafe one-leg hedge depth and loss", () => {
  const target = market({ id: "maker-unsafe", clobTokenIds: ["yes", "no"] });
  const shallow = buildMakerPairCandidate(target, [
    book("yes", 0.47, 0.51, 25, 30),
    book("no", 0.48, 0.52, 30, 20)
  ], config, 1_000);
  assert.equal(shallow, undefined);
  const lossy = buildMakerPairCandidate(target, [
    book("yes", 0.45, 0.65, 25, 40),
    book("no", 0.45, 0.65, 30, 40)
  ], config, 1_000);
  assert.equal(lossy, undefined);
});

test("maker candidate rejects wide, extreme, and unsynchronized complementary books", () => {
  const target = market({ id: "maker-coherence", clobTokenIds: ["yes", "no"] });
  const wide = buildMakerPairCandidate(target, [
    book("yes", 0.012, 0.013, 20_000, 2_000),
    book("no", 0.001, 0.999, 20_000, 2_000)
  ], config, 1_000);
  assert.equal(wide, undefined);

  const extremeEdge = buildMakerPairCandidate(target, [
    book("yes", 0.05, 0.06, 100, 100),
    book("no", 0.10, 0.11, 100, 100)
  ], config, 1_000);
  assert.equal(extremeEdge, undefined);

  const unsynchronized = buildMakerPairCandidate(target, [
    { ...book("yes", 0.47, 0.51, 100, 100), timestamp: 1_000 },
    { ...book("no", 0.48, 0.52, 100, 100), timestamp: 2_001 }
  ], config, 2_001);
  assert.equal(unsynchronized, undefined);
});

test("binary and negative-risk arbitrage require executable all-leg profit after fees", () => {
  const binary = market({ id: "binary", clobTokenIds: ["yes", "no"], feesEnabled: true, takerFeeRate: 0.07 });
  const paired = buildBinaryPairArbitrageCandidate(binary, [
    book("yes", 0.43, 0.45, 20, 20),
    book("no", 0.43, 0.45, 20, 20)
  ], config, 2_000);
  assert.ok(paired && paired.result.pnlUsd > 0 && paired.result.pnlUsd < 1);

  const books = new Map<string, OrderBookSnapshot>();
  const markets = [0, 1, 2].map((index) => {
    const tokenId = `yes-${index}`;
    books.set(tokenId, book(tokenId, 0.23, 0.25, 20, 20));
    return market({
      id: `outcome-${index}`,
      eventId: "event",
      negRisk: true,
      clobTokenIds: [tokenId, `no-${index}`],
      outcomes: ["YES", "NO"],
      raw: { events: [{ markets: [{}, {}, {}] }] }
    });
  });
  const negRisk = buildNegRiskArbitrageCandidate(markets, books, config, 2_000);
  assert.ok(negRisk);
  assert.equal(negRisk.candidate.details.completeNamedGraph, true);
  assert.equal(negRisk.result.pnlUsd, 2.10625);
  assert.equal(buildNegRiskArbitrageCandidate(markets.map((item) => ({ ...item, raw: undefined })), books, config, 2_000), undefined);
  assert.equal(buildNegRiskArbitrageCandidate(markets.map((item, index) => index === 0 ? { ...item, negRiskAugmented: true } : item), books, config, 2_000), undefined);
});

test("threshold ladder arbitrage requires a same-event monotonic guaranteed-payout pair", () => {
  const endDate = "2026-08-17T16:00:00.000Z";
  const lower = market({
    id: "btc-64k",
    eventId: "btc-aug-17",
    question: "Will the price of Bitcoin be above $64,000 on August 17?",
    endDate,
    clobTokenIds: ["lower-yes", "lower-no"],
    feesEnabled: false
  });
  const higher = market({
    id: "btc-66k",
    eventId: "btc-aug-17",
    question: "Will the price of Bitcoin be above $66,000 on August 17?",
    endDate,
    clobTokenIds: ["higher-yes", "higher-no"],
    feesEnabled: false
  });
  const books = new Map<string, OrderBookSnapshot>([
    ["lower-yes", book("lower-yes", 0.43, 0.45, 40, 40)],
    ["lower-no", book("lower-no", 0.54, 0.56, 40, 40)],
    ["higher-yes", book("higher-yes", 0.54, 0.56, 40, 40)],
    ["higher-no", book("higher-no", 0.43, 0.45, 40, 40)]
  ]);
  const built = buildThresholdLadderArbitrageCandidate([lower, higher], books, config, 1_000);
  assert.ok(built);
  assert.deepEqual(built.tokenIds, ["lower-yes", "higher-no"]);
  assert.equal(built.candidate.strategy, "THRESHOLD_LADDER_ARB");
  assert.ok(Math.abs(built.candidate.expectedNetEdgeUsd - 1) < 1e-9);
  assert.equal(built.candidate.details.guaranteedPayoutPerShare, 1);

  const differentEvent = { ...higher, eventId: "another-event" };
  assert.equal(buildThresholdLadderArbitrageCandidate([lower, differentEvent], books, config, 1_000), undefined);
  books.set("higher-no", book("higher-no", 0.54, 0.56, 40, 40));
  assert.equal(buildThresholdLadderArbitrageCandidate([lower, higher], books, config, 1_000), undefined);
});

test("threshold ladder execution waits for post-latency books and records executable P&L", () => {
  const path = "data/test-threshold-ladder-research.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  const db = new BotDatabase(path);
  const policyVersion = "threshold-ladder-test-v1";
  const coordinator = new ExecutionResearchCoordinator(db, {
    ...config,
    executionResearchEnabled: true,
    makerResearchMinPairEdge: 1,
    thresholdLadderPolicyVersion: policyVersion,
    thresholdLadderExecutionLatencyMs: 250,
    thresholdLadderExecutionTimeoutMs: 2_000,
    thresholdLadderMaxBookAgeMs: 1_000,
    thresholdLadderMaxBookTimestampSkewMs: 500,
    thresholdLadderMinDepthMultiple: 2
  });
  const endDate = "2026-08-17T16:00:00.000Z";
  const lower = market({ id: "ladder-low", eventId: "ladder-event", question: "Will Bitcoin be above $64,000 on August 17?", endDate, clobTokenIds: ["low-yes", "low-no"], feesEnabled: false });
  const higher = market({ id: "ladder-high", eventId: "ladder-event", question: "Will Bitcoin be above $66,000 on August 17?", endDate, clobTokenIds: ["high-yes", "high-no"], feesEnabled: false });
  coordinator.setUniverse([lower, higher]);
  for (const [tokenId, bid, ask] of [
    ["low-yes", 0.43, 0.45], ["low-no", 0.54, 0.56],
    ["high-yes", 0.54, 0.56], ["high-no", 0.43, 0.45]
  ] as Array<[string, number, number]>) {
    coordinator.onMarketUpdate(streamBook(tokenId, 1_000), { ...book(tokenId, bid, ask, 40, 40), timestamp: 1_000 });
  }
  assert.equal(coordinator.getSummary().activeThresholdLadderArbitrages, 1);
  coordinator.onMarketUpdate(streamBook("low-yes", 1_300), { ...book("low-yes", 0.43, 0.45, 40, 40), timestamp: 1_300 });
  coordinator.onMarketUpdate(streamBook("high-no", 1_301), { ...book("high-no", 0.43, 0.45, 40, 40), timestamp: 1_301 });
  const scorecard = db.getExecutionResearchScorecard({
    strategy: "THRESHOLD_LADDER_ARB",
    policyVersion,
    since: 0,
    minResolved: 1,
    minDistinctMarkets: 2,
    minReturnPct: 0,
    minWinRate: 0
  });
  assert.equal(scorecard.economicOutcomes, 1);
  assert.equal(scorecard.completed, 1);
  assert.equal(scorecard.distinctMarkets, 2);
  assert.equal(scorecard.pnlUsd, 1);
  db.close();
});

test("binary arbitrage waits for post-latency books and accounts for a losing hedge", () => {
  const path = "data/test-binary-latency-research.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  const db = new BotDatabase(path);
  const coordinator = new ExecutionResearchCoordinator(db, {
    ...config,
    executionResearchEnabled: true,
    makerResearchMinPairEdge: 1,
    binaryArbPolicyVersion: "binary-latency-test-v2",
    binaryArbExecutionLatencyMs: 250,
    binaryArbExecutionTimeoutMs: 2_000,
    binaryArbMaxBookAgeMs: 1_000,
    binaryArbMinDepthMultiple: 2
  });
  const target = market({ id: "binary-latency", clobTokenIds: ["binary-yes", "binary-no"], feesEnabled: false });
  coordinator.setUniverse([target]);
  coordinator.onMarketUpdate(streamBook("binary-yes", 1_000), { ...book("binary-yes", 0.43, 0.45, 30, 30), timestamp: 1_000 });
  coordinator.onMarketUpdate(streamBook("binary-no", 1_000), { ...book("binary-no", 0.43, 0.45, 30, 30), timestamp: 1_000 });
  assert.equal(coordinator.getSummary().activeBinaryArbitrages, 1);
  coordinator.onMarketUpdate(streamBook("binary-yes", 1_300), { ...book("binary-yes", 0.43, 0.45, 30, 30), timestamp: 1_300 });
  assert.equal(coordinator.getSummary().activeBinaryArbitrages, 1);
  coordinator.onMarketUpdate(streamBook("binary-no", 1_301), { ...book("binary-no", 0.58, 0.60, 30, 30), timestamp: 1_301 });
  const scorecard = db.getExecutionResearchScorecard({
    strategy: "BINARY_PAIR_ARB",
    policyVersion: "binary-latency-test-v2",
    since: 0,
    minResolved: 1,
    minDistinctMarkets: 1,
    minReturnPct: 0,
    minWinRate: 0
  });
  assert.equal(scorecard.economicOutcomes, 1);
  assert.equal(scorecard.completed, 1);
  assert.ok(scorecard.pnlUsd < 0);
  db.close();
});

test("inventory-aware maker carries one leg and closes it with a later maker fill", () => {
  const path = "data/test-maker-inventory-research.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  const db = new BotDatabase(path);
  const makerConfig = {
    ...config,
    executionResearchEnabled: true,
    makerResearchPolicyVersion: "maker-inventory-test-v4",
    makerResearchQuoteTtlMs: 30_000,
    makerResearchMaxInventoryAgeMs: 300_000,
    makerResearchMaxInventoryShares: 20,
    makerResearchInventorySkewTicks: 1,
    makerResearchRequoteTicks: 2,
    makerResearchMaxBookAgeMs: 5_000,
    pairedResearchMinNetEdge: 1
  } as BotConfig;
  const coordinator = new ExecutionResearchCoordinator(db, makerConfig);
  const target = market({ id: "maker-inventory", clobTokenIds: ["maker-yes", "maker-no"], feesEnabled: false });
  coordinator.setUniverse([target]);
  coordinator.onMarketUpdate(streamBook("maker-yes", 1_000), { ...book("maker-yes", 0.47, 0.51, 25, 30), timestamp: 1_000 });
  coordinator.onMarketUpdate(streamBook("maker-no", 1_000), { ...book("maker-no", 0.48, 0.52, 30, 30), timestamp: 1_000 });
  coordinator.onMarketUpdate({ ...streamBook("maker-yes", 1_100), eventType: "LAST_TRADE", trade: { price: 0.47, size: 35, side: "SELL" } }, { ...book("maker-yes", 0.47, 0.51, 25, 30), timestamp: 1_100 });
  coordinator.tick(31_001);
  assert.equal(coordinator.getSummary().makerInventoryLots, 1);
  assert.equal(coordinator.getSummary().makerInventoryShares, 10);

  coordinator.onMarketUpdate(streamBook("maker-yes", 31_002), { ...book("maker-yes", 0.47, 0.51, 25, 30), timestamp: 31_002 });
  coordinator.onMarketUpdate(streamBook("maker-no", 31_003), { ...book("maker-no", 0.48, 0.52, 30, 30), timestamp: 31_003 });
  coordinator.onMarketUpdate({ ...streamBook("maker-no", 32_000), eventType: "LAST_TRADE", trade: { price: 0.49, size: 10, side: "SELL" } }, { ...book("maker-no", 0.48, 0.52, 30, 30), timestamp: 32_000 });
  coordinator.tick(62_000);
  const scorecard = db.getExecutionResearchScorecard({
    strategy: "MAKER_PAIR",
    policyVersion: "maker-inventory-test-v4",
    since: 0,
    minResolved: 1,
    minDistinctMarkets: 1,
    minReturnPct: 0,
    minWinRate: 0
  });
  assert.equal(scorecard.economicOutcomes, 1);
  assert.equal(scorecard.hedgeMisses, 0);
  assert.ok(scorecard.pnlUsd > 0);
  assert.equal(coordinator.getSummary().makerInventoryLots, 0);
  db.close();
});

test("forced maker hedge refreshes the executable CLOB book before scoring a miss", async () => {
  const path = "data/test-maker-fresh-hedge-research.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  const db = new BotDatabase(path);
  const policyVersion = "maker-fresh-hedge-test-v4.3";
  let refreshes = 0;
  const coordinator = new ExecutionResearchCoordinator(db, {
    ...config,
    executionResearchEnabled: true,
    makerResearchPolicyVersion: policyVersion,
    makerResearchQuoteTtlMs: 30_000,
    makerResearchMaxInventoryAgeMs: 1_000,
    makerResearchMaxBookAgeMs: 100,
    makerResearchHedgeRefreshTimeoutMs: 100,
    pairedResearchMinNetEdge: 1
  }, async (tokenId) => {
    refreshes += 1;
    return { ...book(tokenId, 0.48, 0.52, 100, 100), timestamp: Date.now() };
  });
  const target = market({ id: "maker-fresh-hedge", clobTokenIds: ["fresh-yes", "fresh-no"], feesEnabled: false });
  coordinator.setUniverse([target]);
  coordinator.onMarketUpdate(streamBook("fresh-yes", 1_000), { ...book("fresh-yes", 0.47, 0.51, 25, 30), timestamp: 1_000 });
  coordinator.onMarketUpdate(streamBook("fresh-no", 1_000), { ...book("fresh-no", 0.48, 0.52, 30, 30), timestamp: 1_000 });
  coordinator.onMarketUpdate({ ...streamBook("fresh-yes", 1_100), eventType: "LAST_TRADE", trade: { price: 0.47, size: 35, side: "SELL" } }, { ...book("fresh-yes", 0.47, 0.51, 25, 30), timestamp: 1_100 });
  coordinator.tick(2_101);
  await new Promise<void>((resolve) => setImmediate(resolve));

  const scorecard = db.getExecutionResearchScorecard({
    strategy: "MAKER_PAIR",
    policyVersion,
    since: 0,
    minResolved: 1,
    minDistinctMarkets: 1,
    minReturnPct: 0,
    minWinRate: 0
  });
  assert.equal(refreshes, 1);
  assert.equal(scorecard.completed, 1);
  assert.equal(scorecard.hedgeMisses, 0);
  assert.ok(scorecard.pnlUsd > 0);
  assert.equal(coordinator.getSummary().makerInventoryLots, 0);
  const raw = new DatabaseSync(path);
  const row = raw.prepare("SELECT json_extract(result_json, '$.details.freshBookRefreshUsed') AS refreshed FROM execution_research_results WHERE policy_version = ?").get(policyVersion) as { refreshed: number };
  assert.equal(row.refreshed, 1);
  raw.close();
  db.close();
});

test("maker requotes close the old immutable observation and create a new candidate", () => {
  const path = "data/test-maker-requote-research.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  const db = new BotDatabase(path);
  const policyVersion = "maker-requote-test-v4.2";
  const coordinator = new ExecutionResearchCoordinator(db, {
    ...config,
    executionResearchEnabled: true,
    makerResearchPolicyVersion: policyVersion,
    makerResearchQuoteTtlMs: 30_000,
    makerResearchRequoteTicks: 2,
    makerResearchMaxBookAgeMs: 5_000,
    makerResearchMaxBookTimestampSkewMs: 1_000,
    pairedResearchMinNetEdge: 1
  });
  const target = market({ id: "maker-requote", clobTokenIds: ["requote-yes", "requote-no"], feesEnabled: false });
  coordinator.setUniverse([target]);
  coordinator.onMarketUpdate(streamBook("requote-yes", 1_000), { ...book("requote-yes", 0.47, 0.51, 100, 100), timestamp: 1_000 });
  coordinator.onMarketUpdate(streamBook("requote-no", 1_000), { ...book("requote-no", 0.48, 0.52, 100, 100), timestamp: 1_000 });
  coordinator.onMarketUpdate(streamBook("requote-yes", 2_000), { ...book("requote-yes", 0.49, 0.51, 100, 100), timestamp: 2_000 });

  const scorecard = db.getExecutionResearchScorecard({
    strategy: "MAKER_PAIR",
    policyVersion,
    since: 0,
    minResolved: 1,
    minDistinctMarkets: 1,
    minReturnPct: 0,
    minWinRate: 0
  });
  assert.equal(scorecard.candidates, 2);
  assert.equal(scorecard.resolved, 1);
  assert.equal(scorecard.noFill, 1);
  assert.equal(scorecard.economicOutcomes, 0);
  assert.equal(coordinator.getSummary().activeMakerQuotes, 1);

  const raw = new DatabaseSync(path);
  const rows = raw.prepare("SELECT candidate_json FROM execution_research_candidates ORDER BY observed_at ASC").all() as Array<{ candidate_json: string }>;
  const first = JSON.parse(rows[0].candidate_json) as ExecutionResearchCandidate;
  const second = JSON.parse(rows[1].candidate_json) as ExecutionResearchCandidate;
  assert.deepEqual(first.details.quotePrices, [0.47, 0.48]);
  assert.deepEqual(second.details.quotePrices, [0.49, 0.48]);
  assert.equal(second.details.requoteOf, first.id);
  raw.close();
  db.close();
});

test("cross-market shadow records a prospective round trip after a reference move", () => {
  const path = "data/test-cross-market-research.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  const db = new BotDatabase(path);
  const coordinator = new ExecutionResearchCoordinator(db, {
    ...config,
    executionResearchEnabled: true,
    crossMarketMoveThresholdBps: 8,
    crossMarketHoldMs: 1_000,
    crossMarketMinDepthMultiple: 1,
    crossMarketEntryLatencyMs: 250,
    crossMarketEntryTimeoutMs: 2_000,
    crossMarketMaxBookAgeMs: 5_000
  });
  const target = market({
    id: "btc-hourly",
    eventId: "btc-event",
    endDate: new Date(60 * 60_000).toISOString(),
    clobTokenIds: ["btc-yes", "btc-no"]
  });
  coordinator.setUniverse([target]);
  coordinator.onMarketUpdate(streamBook("btc-yes", 1_000), book("btc-yes", 0.49, 0.51, 20, 20));
  coordinator.onMarketUpdate(streamBook("btc-no", 1_000), book("btc-no", 0.47, 0.50, 20, 20));
  coordinator.onReferenceTick({ symbol: "BTCUSDT", bid: 59_999, ask: 60_001, price: 60_000, receivedAt: 1_000 });
  coordinator.onReferenceTick({ symbol: "BTCUSDT", bid: 60_059, ask: 60_061, price: 60_060, receivedAt: 3_001 });
  coordinator.onMarketUpdate(streamBook("btc-yes", 3_500), book("btc-yes", 0.55, 0.57, 20, 20));
  coordinator.onMarketUpdate(streamBook("btc-yes", 4_501), book("btc-yes", 0.65, 0.66, 20, 20));
  const scorecard = db.getExecutionResearchScorecard({
    strategy: "CROSS_MARKET_LATENCY",
    policyVersion: "execution-test-v1",
    since: 0,
    minResolved: 1,
    minDistinctMarkets: 1,
    minReturnPct: 0,
    minWinRate: 0
  });
  assert.equal(scorecard.candidates, 1);
  assert.equal(scorecard.completed, 1);
  assert.ok(scorecard.pnlUsd > 0);
  db.close();
});

test("cross-market sensitivity replays executable USD-sized round trips", () => {
  const replay = new CrossMarketSensitivityReplay([{ thresholdBps: 2, holdMs: 5_000, sizeUsd: 5 }], 0.07);
  replay.process({
    schemaVersion: 1,
    recordType: "MARKET_METADATA",
    receivedAt: 1_000,
    marketId: "btc",
    question: "Will Bitcoin be above $60,000 tomorrow?",
    endDate: new Date(12 * 60 * 60_000).toISOString(),
    tokenIds: ["yes", "no"],
    outcomes: ["YES", "NO"],
    volume24h: 10_000,
    liquidity: 10_000,
    feesEnabled: true,
    takerFeeRate: 0.07
  });
  for (const tokenId of ["yes", "no"]) replay.process({
    schemaVersion: 1,
    recordType: "MARKET_STREAM",
    eventType: "BOOK",
    receivedAt: 2_000,
    tokenId,
    bestBid: tokenId === "yes" ? 0.49 : 0.47,
    bestAsk: tokenId === "yes" ? 0.51 : 0.50,
    bids: [{ price: tokenId === "yes" ? 0.49 : 0.47, size: 100 }],
    asks: [{ price: tokenId === "yes" ? 0.51 : 0.50, size: 100 }]
  });
  replay.process({ schemaVersion: 1, recordType: "CRYPTO_REFERENCE", symbol: "BTCUSDT", bid: 59_999, ask: 60_001, price: 60_000, receivedAt: 1_000 });
  replay.process({ schemaVersion: 1, recordType: "CRYPTO_REFERENCE", symbol: "BTCUSDT", bid: 60_029, ask: 60_031, price: 60_030, receivedAt: 3_001 });
  replay.process({
    schemaVersion: 1,
    recordType: "MARKET_STREAM",
    eventType: "PRICE_CHANGE",
    receivedAt: 3_500,
    tokenId: "yes",
    bestBid: 0.49,
    bestAsk: 0.51,
    bookDelta: { price: 0.49, size: 100, side: "BUY" }
  });
  replay.process({
    schemaVersion: 1,
    recordType: "MARKET_STREAM",
    eventType: "PRICE_CHANGE",
    receivedAt: 8_500,
    tokenId: "yes",
    bestBid: 0.55,
    bestAsk: 0.57,
    bookDelta: { price: 0.55, size: 100, side: "BUY" }
  });
  replay.process({ schemaVersion: 1, recordType: "CRYPTO_REFERENCE", symbol: "BTCUSDT", bid: 60_029, ask: 60_031, price: 60_030, receivedAt: 9_000 });
  const report = replay.report();
  assert.equal(report.recordsWithOutcomes, 1);
  assert.equal(report.training[0].outcomes, 1);
  assert.ok(report.training[0].pnlUsd > 0);
});

test("execution candidates and results are immutable and promotion uses only prospective completed rows", () => {
  const path = "data/test-execution-research.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  const db = new BotDatabase(path);
  const candidate: ExecutionResearchCandidate = {
    id: "candidate",
    strategy: "BINARY_PAIR_ARB",
    policyVersion: "execution-test-v1",
    eventKey: "event",
    marketIds: ["market"],
    tokenIds: ["yes", "no"],
    observedAt: 1_000,
    expiresAt: 1_000,
    notionalUsd: 9,
    expectedGrossEdgeUsd: 1,
    expectedNetEdgeUsd: 0.8,
    details: {}
  };
  const result: ExecutionResearchResult = {
    id: "result",
    candidateId: candidate.id,
    strategy: candidate.strategy,
    policyVersion: candidate.policyVersion,
    eventKey: candidate.eventKey,
    status: "COMPLETE",
    pnlUsd: 0.8,
    capitalUsd: 9.2,
    returnPct: 0.8 / 9.2,
    filledLegs: 2,
    latencyMs: 0,
    resolvedAt: 1_000,
    details: {}
  };
  assert.equal(db.insertExecutionResearchCandidate(candidate), true);
  assert.equal(db.insertExecutionResearchCandidate(candidate), false);
  assert.equal(db.insertExecutionResearchResult(result), true);
  const unresolvedCandidate = { ...candidate, id: "candidate-unresolved", eventKey: "event-unresolved", marketIds: ["market-unresolved"] };
  assert.equal(db.insertExecutionResearchCandidate(unresolvedCandidate), true);
  const prePolicyCandidate = { ...candidate, id: "candidate-pre-policy", observedAt: 500 };
  const postPolicyResult = { ...result, id: "result-pre-policy", candidateId: prePolicyCandidate.id, resolvedAt: 2_000 };
  assert.equal(db.insertExecutionResearchCandidate(prePolicyCandidate), true);
  assert.equal(db.insertExecutionResearchResult(postPolicyResult), true);
  const scorecard = db.getExecutionResearchScorecard({
    strategy: candidate.strategy,
    policyVersion: candidate.policyVersion,
    since: 999,
    minResolved: 1,
    minDistinctMarkets: 1,
    minReturnPct: 0.02,
    minWinRate: 0.5
  });
  assert.equal(scorecard.promotionEligible, true);
  assert.equal(scorecard.completed, 1);
  assert.equal(scorecard.economicOutcomes, 1);
  assert.equal(scorecard.hedgeMisses, 0);
  assert.equal(scorecard.distinctMarkets, 1);
  const breadthGate = db.getExecutionResearchScorecard({
    strategy: candidate.strategy,
    policyVersion: candidate.policyVersion,
    since: 999,
    minResolved: 1,
    minDistinctMarkets: 2,
    minReturnPct: 0.02,
    minWinRate: 0.5
  });
  assert.equal(breadthGate.promotionEligible, false);
  assert.match(breadthGate.promotionReason, /distinct markets/);

  const hedgeCandidate = { ...candidate, id: "candidate-hedge-miss", eventKey: "event-hedge", marketIds: ["market-hedge"], observedAt: 1_500 };
  const hedgeResult: ExecutionResearchResult = {
    ...result,
    id: "result-hedge-miss",
    candidateId: hedgeCandidate.id,
    eventKey: hedgeCandidate.eventKey,
    status: "HEDGE_MISS",
    pnlUsd: -5,
    capitalUsd: 5,
    returnPct: -1,
    filledLegs: 1,
    resolvedAt: 2_000
  };
  assert.equal(db.insertExecutionResearchCandidate(hedgeCandidate), true);
  assert.equal(db.insertExecutionResearchResult(hedgeResult), true);
  const lossInclusive = db.getExecutionResearchScorecard({
    strategy: candidate.strategy,
    policyVersion: candidate.policyVersion,
    since: 999,
    minResolved: 1,
    minDistinctMarkets: 1,
    minReturnPct: 0.02,
    minWinRate: 0.5
  });
  assert.equal(lossInclusive.completed, 1);
  assert.equal(lossInclusive.hedgeMisses, 1);
  assert.equal(lossInclusive.economicOutcomes, 2);
  assert.equal(lossInclusive.pnlUsd, -4.2);
  assert.equal(lossInclusive.promotionEligible, false);
  db.close();
  const raw = new DatabaseSync(path);
  assert.throws(() => raw.prepare("DELETE FROM execution_research_candidates WHERE id = ?").run(candidate.id), /append-only/);
  assert.throws(() => raw.prepare("UPDATE execution_research_results SET pnl_usd = 999 WHERE id = ?").run(result.id), /append-only/);
  raw.close();
});

test("collector restart resolves expired unobserved candidates without inventing capital at risk", () => {
  const path = "data/test-execution-restart-reconciliation.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  const db = new BotDatabase(path);
  const policyVersion = "maker-restart-test-v4.2";
  const candidate: ExecutionResearchCandidate = {
    id: "interrupted-maker-candidate",
    strategy: "MAKER_PAIR",
    policyVersion,
    eventKey: "event",
    marketIds: ["market"],
    tokenIds: ["yes", "no"],
    observedAt: 1,
    expiresAt: 2,
    notionalUsd: 9.5,
    expectedGrossEdgeUsd: 0.5,
    expectedNetEdgeUsd: 0.5,
    details: {}
  };
  db.insertExecutionResearchCandidate(candidate);
  new ExecutionResearchCoordinator(db, { ...config, makerResearchPolicyVersion: policyVersion });
  const scorecard = db.getExecutionResearchScorecard({
    strategy: "MAKER_PAIR",
    policyVersion,
    since: 0,
    minResolved: 1,
    minDistinctMarkets: 1,
    minReturnPct: 0,
    minWinRate: 0
  });
  assert.equal(scorecard.resolved, 1);
  assert.equal(scorecard.economicOutcomes, 0);
  assert.equal(scorecard.noFill, 1);
  const raw = new DatabaseSync(path);
  const row = raw.prepare("SELECT status, capital_usd FROM execution_research_results WHERE candidate_id = ?").get(candidate.id) as { status: string; capital_usd: number };
  assert.equal(row.status, "EXPIRED");
  assert.equal(row.capital_usd, 0);
  raw.close();
  db.close();
});

function market(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    id: "market",
    question: "Will Bitcoin be above $60,000?",
    active: true,
    closed: false,
    archived: false,
    acceptingOrders: true,
    liquidity: 10_000,
    volume24h: 10_000,
    clobTokenIds: ["yes", "no"],
    outcomes: ["YES", "NO"],
    outcomePrices: [0.5, 0.5],
    ...overrides
  };
}

function book(tokenId: string, bestBid: number, bestAsk: number, bidSize: number, askSize: number): OrderBookSnapshot {
  return {
    tokenId,
    bids: [{ price: bestBid, size: bidSize }],
    asks: [{ price: bestAsk, size: askSize }],
    bestBid,
    bestAsk,
    spread: bestAsk - bestBid,
    depth: bidSize + askSize,
    timestamp: 1_000
  };
}

function streamBook(tokenId: string, receivedAt: number) {
  return {
    eventType: "BOOK" as const,
    tokenId,
    conditionId: "btc-hourly",
    receivedAt
  };
}
