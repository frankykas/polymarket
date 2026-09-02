import { createHash } from "node:crypto";
import { takerFeeUsd } from "../liveExecution.js";
import type { BotDatabase } from "../db.js";
import { EXECUTION_RESEARCH_STRATEGIES, executionPolicyVersion } from "./executionPolicy.js";
import type {
  BotConfig,
  CryptoReferenceTick,
  ExecutionResearchCandidate,
  ExecutionResearchResult,
  MarketSnapshot,
  MarketStreamUpdate,
  OrderBookSnapshot,
  PriceLevel
} from "../types.js";

interface MakerLegState {
  tokenId: string;
  price: number;
  shares: number;
  queueAhead: number;
  tradedAfterQueue: number;
  filledAt?: number;
}

interface ActiveMakerQuote {
  candidate: ExecutionResearchCandidate;
  market: MarketSnapshot;
  legs: [MakerLegState, MakerLegState];
  economicCompletedAt?: number;
  markoutAt?: number;
  requotes: number;
}

interface MakerInventoryLot {
  candidate: ExecutionResearchCandidate;
  market: MarketSnapshot;
  leg: MakerLegState;
  openedAt: number;
}

interface MakerHedgeRefreshState {
  requestedAt: number;
  completed: boolean;
  timer: ReturnType<typeof setTimeout>;
}

interface ActiveCrossTrade {
  candidate: ExecutionResearchCandidate;
  market: MarketSnapshot;
  tokenId: string;
  requestedSizeUsd: number;
  entryNotBefore: number;
  entryDeadline: number;
  holdMs: number;
  shares?: number;
  entryPrice?: number;
  entryFee?: number;
  enteredAt?: number;
  exitsAt?: number;
}

interface PendingBinaryArbitrage {
  candidate: ExecutionResearchCandidate;
  market: MarketSnapshot;
  observedAskPrices: [number, number];
  shares: number;
  executeNotBefore: number;
  executeDeadline: number;
}

interface PendingThresholdLadderArbitrage {
  candidate: ExecutionResearchCandidate;
  markets: [MarketSnapshot, MarketSnapshot];
  tokenIds: [string, string];
  observedAskPrices: [number, number];
  shares: number;
  executeNotBefore: number;
  executeDeadline: number;
}

export interface ThresholdLadderSpec {
  asset: "BTC" | "ETH";
  direction: "ABOVE" | "BELOW";
  threshold: number;
}

export interface ExecutionResearchCycleSummary {
  universeMarkets: number;
  activeMakerQuotes: number;
  makerInventoryLots: number;
  makerInventoryShares: number;
  activeBinaryArbitrages: number;
  thresholdLadderMarkets: number;
  thresholdLadderEvents: number;
  activeThresholdLadderArbitrages: number;
  activeCrossTrades: number;
  candidatesInserted: number;
  resultsInserted: number;
}

export class ExecutionResearchCoordinator {
  private markets = new Map<string, MarketSnapshot>();
  private tokenToMarket = new Map<string, MarketSnapshot>();
  private books = new Map<string, OrderBookSnapshot>();
  private activeMaker = new Map<string, ActiveMakerQuote>();
  private makerInventory = new Map<string, MakerInventoryLot[]>();
  private makerHedgeRefreshes = new Map<string, MakerHedgeRefreshState>();
  private activeBinary = new Map<string, PendingBinaryArbitrage>();
  private activeThresholdLadders = new Map<string, PendingThresholdLadderArbitrage>();
  private activeCross = new Map<string, ActiveCrossTrade>();
  private referenceHistory = new Map<CryptoReferenceTick["symbol"], CryptoReferenceTick[]>();
  private cooldowns = new Map<string, number>();
  private insertedCandidates = 0;
  private insertedResults = 0;

  constructor(
    private db: BotDatabase,
    private config: BotConfig,
    private refreshOrderBook?: (tokenId: string, marketId?: string) => Promise<OrderBookSnapshot | undefined>
  ) {
    const restored = this.db.getExecutionResearchState<Array<[string, MakerInventoryLot[]]>>(this.makerStateKey());
    if (Array.isArray(restored)) this.makerInventory = new Map(restored);
    this.reconcileInterruptedCandidates();
  }

  private reconcileInterruptedCandidates(now = Date.now()): void {
    const inventoryCandidateIds = new Set([...this.makerInventory.values()].flat().map((lot) => lot.candidate.id));
    for (const strategy of EXECUTION_RESEARCH_STRATEGIES) {
      const policyVersion = executionPolicyVersion(this.config, strategy);
      const unresolved = this.db.getExpiredUnresolvedExecutionResearchCandidates({ strategy, policyVersion, expiredBefore: now });
      for (const candidate of unresolved) {
        if (inventoryCandidateIds.has(candidate.id)) continue;
        this.insertResult(makeResult(candidate, "EXPIRED", 0, 0, 0, now, undefined, {
          reason: "collector process ended before the prospective observation was resolved",
          execution: "PROCESS_BOUNDARY_CANCEL",
          capitalAtRisk: false
        }));
      }
    }
  }

  setUniverse(markets: MarketSnapshot[]): void {
    this.markets = new Map(markets.map((market) => [market.id, market]));
    this.tokenToMarket.clear();
    for (const market of markets) {
      for (const tokenId of market.clobTokenIds) this.tokenToMarket.set(tokenId, market);
      const lots = this.makerInventory.get(market.id);
      if (lots) for (const lot of lots) lot.market = market;
    }
  }

  marketForToken(tokenId: string): MarketSnapshot | undefined {
    return this.tokenToMarket.get(tokenId);
  }

  onMarketUpdate(update: MarketStreamUpdate, mergedBook: OrderBookSnapshot): void {
    if (this.config.executionResearchEnabled === false) return;
    const market = this.tokenToMarket.get(update.tokenId);
    if (!market) return;
    this.books.set(update.tokenId, mergedBook);
    this.maybeExecuteBinary(update.receivedAt);
    this.maybeExecuteThresholdLadders(update.receivedAt);
    this.maybeEnterCross(update.tokenId, update.receivedAt);
    if (update.trade) this.applyMakerTrade(update, market);
    this.settleExpired(update.receivedAt);
    this.maybeOpenMaker(market, update.receivedAt);
    this.maybeRecordBinaryArbitrage(market, update.receivedAt);
    if (market.eventId) this.maybeRecordThresholdLadderArbitrage(market.eventId, update.receivedAt);
    if (market.negRisk && market.eventId) this.maybeRecordNegRiskArbitrage(market.eventId, update.receivedAt);
  }

  onReferenceTick(tick: CryptoReferenceTick): void {
    if (this.config.executionResearchEnabled === false) return;
    const history = this.referenceHistory.get(tick.symbol) ?? [];
    history.push(tick);
    const cutoff = tick.receivedAt - 10_000;
    while (history.length > 0 && history[0].receivedAt < cutoff) history.shift();
    this.referenceHistory.set(tick.symbol, history);
    this.settleExpired(tick.receivedAt);
    if (this.config.crossMarketResearchEnabled === false) return;
    const moveWindowMs = this.config.crossMarketMoveWindowMs ?? 2_000;
    const baseline = [...history].reverse().find((item) => item.receivedAt <= tick.receivedAt - moveWindowMs);
    if (!baseline) return;
    const moveBps = ((tick.price / baseline.price) - 1) * 10_000;
    if (Math.abs(moveBps) < (this.config.crossMarketMoveThresholdBps ?? 8)) return;
    const signalCooldownKey = `cross-signal:${tick.symbol}`;
    if ((this.cooldowns.get(signalCooldownKey) ?? 0) > tick.receivedAt) return;
    const choices = [...this.markets.values()]
      .map((market) => this.buildCrossMarketChoice(market, tick, moveBps))
      .filter((choice): choice is NonNullable<typeof choice> => Boolean(choice))
      .sort((left, right) => right.score - left.score);
    const selected: typeof choices = [];
    const eventKeys = new Set<string>();
    for (const choice of choices) {
      const eventKey = choice.market.eventId ?? choice.market.id;
      if (eventKeys.has(eventKey)) continue;
      selected.push(choice);
      eventKeys.add(eventKey);
      if (selected.length >= (this.config.crossMarketMaxMarketsPerSignal ?? 2)) break;
    }
    for (const choice of selected) this.openCrossMarket(choice, tick, moveBps);
    if (selected.length > 0) this.cooldowns.set(signalCooldownKey, tick.receivedAt + (this.config.crossMarketSignalCooldownMs ?? 60_000));
  }

  tick(now = Date.now()): void {
    this.settleExpired(now);
  }

  getSummary(): ExecutionResearchCycleSummary {
    const ladderGroups = new Map<string, Set<number>>();
    for (const market of this.markets.values()) {
      const spec = parseThresholdLadderMarket(market);
      if (!spec || !market.eventId) continue;
      const key = `${market.eventId}:${spec.asset}:${spec.direction}`;
      const thresholds = ladderGroups.get(key) ?? new Set<number>();
      thresholds.add(spec.threshold);
      ladderGroups.set(key, thresholds);
    }
    const eligibleLadderGroups = [...ladderGroups.values()].filter((thresholds) => thresholds.size >= 2);
    return {
      universeMarkets: this.markets.size,
      activeMakerQuotes: this.activeMaker.size,
      makerInventoryLots: [...this.makerInventory.values()].reduce((sum, lots) => sum + lots.length, 0),
      makerInventoryShares: [...this.makerInventory.values()].flat().reduce((sum, lot) => sum + lot.leg.shares, 0),
      activeBinaryArbitrages: this.activeBinary.size,
      thresholdLadderMarkets: eligibleLadderGroups.reduce((sum, thresholds) => sum + thresholds.size, 0),
      thresholdLadderEvents: eligibleLadderGroups.length,
      activeThresholdLadderArbitrages: this.activeThresholdLadders.size,
      activeCrossTrades: this.activeCross.size,
      candidatesInserted: this.insertedCandidates,
      resultsInserted: this.insertedResults
    };
  }

  private maybeOpenMaker(market: MarketSnapshot, now: number): void {
    if (this.config.makerResearchEnabled === false) return;
    if (this.activeMaker.has(market.id)) return;
    const books = booksForMarket(market, this.books);
    const quote = buildMakerPairCandidate(market, books, this.config, now, this.makerInventoryPosition(market.id));
    if (!quote || !this.insertCandidate(quote.candidate)) return;
    this.activeMaker.set(market.id, quote);
  }

  private applyMakerTrade(update: MarketStreamUpdate, market: MarketSnapshot): void {
    const active = this.activeMaker.get(market.id);
    const trade = update.trade;
    if (!active || !trade || active.economicCompletedAt || trade.side !== "SELL") return;
    const leg = active.legs.find((candidate) => candidate.tokenId === update.tokenId);
    if (!leg || leg.shares <= 0 || leg.filledAt || trade.price > leg.price) return;
    let remaining = trade.size;
    if (leg.queueAhead > 0) {
      const consumed = Math.min(leg.queueAhead, remaining);
      leg.queueAhead -= consumed;
      remaining -= consumed;
    }
    leg.tradedAfterQueue += remaining;
    if (leg.tradedAfterQueue >= leg.shares) leg.filledAt = update.receivedAt;
    if (leg.filledAt !== undefined) {
      this.processMakerFills(active, update.receivedAt);
      this.activeMaker.delete(market.id);
    }
  }

  private maybeRecordBinaryArbitrage(market: MarketSnapshot, now: number): void {
    const key = `binary:${market.id}`;
    if (this.activeBinary.has(key) || (this.cooldowns.get(key) ?? 0) > now) return;
    const built = buildBinaryPairArbitrageCandidate(market, booksForMarket(market, this.books), this.config, now);
    if (!built || !this.insertCandidate(built.candidate)) return;
    const latencyMs = this.config.binaryArbExecutionLatencyMs ?? 250;
    const timeoutMs = Math.max(250, this.config.binaryArbExecutionTimeoutMs ?? 2_000);
    const askPrices = built.candidate.details.askPrices as [number, number];
    this.activeBinary.set(key, {
      candidate: built.candidate,
      market,
      observedAskPrices: askPrices,
      shares: built.candidate.details.shares as number,
      executeNotBefore: now + latencyMs,
      executeDeadline: now + latencyMs + timeoutMs
    });
    this.cooldowns.set(key, now + 5 * 60_000);
  }

  private maybeExecuteBinary(now: number): void {
    for (const [key, pending] of this.activeBinary) {
      if (now < pending.executeNotBefore || (now < pending.executeDeadline && !this.binaryBooksReady(pending))) continue;
      const result = this.evaluateBinaryExecution(pending, now);
      if (!result && now < pending.executeDeadline) continue;
      this.insertResult(result ?? makeResult(pending.candidate, "NO_FILL", 0, 0, 0, now, undefined, {
        reason: "no post-latency executable pair before timeout"
      }));
      this.activeBinary.delete(key);
    }
  }

  private binaryBooksReady(pending: PendingBinaryArbitrage): boolean {
    return pending.market.clobTokenIds.every((tokenId) => {
      const book = this.books.get(tokenId);
      return book !== undefined && book.timestamp >= pending.executeNotBefore;
    });
  }

  private evaluateBinaryExecution(pending: PendingBinaryArbitrage, now: number): ExecutionResearchResult | undefined {
    const books = pending.market.clobTokenIds.map((tokenId) => this.books.get(tokenId));
    if (books.some((book) => !book?.bestAsk)) return undefined;
    const ordered = books as [OrderBookSnapshot, OrderBookSnapshot];
    const maxAgeMs = this.config.binaryArbMaxBookAgeMs ?? 1_000;
    const depthMultiple = this.config.binaryArbMinDepthMultiple ?? 2;
    const fresh = ordered.map((book) => now - book.timestamp >= 0 && now - book.timestamp <= maxAgeMs);
    const fillable = ordered.map((book, index) => fresh[index]
      && book.timestamp >= pending.executeNotBefore
      && book.bestAsk! <= pending.observedAskPrices[index] + 1e-9
      && topLevelSize(book.asks, book.bestAsk!) >= pending.shares * depthMultiple);
    if (!fillable[0] && !fillable[1]) return undefined;
    const fillPrices: [number, number] = [
      fillable[0] ? ordered[0].bestAsk! : Number.NaN,
      fillable[1] ? ordered[1].bestAsk! : Number.NaN
    ];
    const firstFilled = fillable[0] ? 0 : 1;
    if (!(fillable[0] && fillable[1])) {
      const missing = firstFilled === 0 ? 1 : 0;
      const hedgeBook = ordered[missing];
      if (!fresh[missing] || hedgeBook.timestamp < pending.executeNotBefore || !hedgeBook.bestAsk || topLevelSize(hedgeBook.asks, hedgeBook.bestAsk) < pending.shares) {
        const feeRate = pending.market.feesEnabled === false ? 0 : pending.market.takerFeeRate ?? this.config.liveExecutionFeeRatePct ?? 0;
        const filledFee = takerFeeUsd(pending.shares, fillPrices[firstFilled], feeRate);
        const capital = pending.shares * fillPrices[firstFilled] + filledFee;
        return makeResult(pending.candidate, "HEDGE_MISS", -capital, capital, 1, now, undefined, {
          reason: "one FOK leg filled and the opposite hedge was unavailable",
          fillPrices,
          fillable,
          observedAskPrices: pending.observedAskPrices
        });
      }
      fillPrices[missing] = hedgeBook.bestAsk;
    }
    const feeRate = pending.market.feesEnabled === false ? 0 : pending.market.takerFeeRate ?? this.config.liveExecutionFeeRatePct ?? 0;
    const fees = fillPrices.reduce((sum, price) => sum + takerFeeUsd(pending.shares, price, feeRate), 0);
    const capital = pending.shares * (fillPrices[0] + fillPrices[1]) + fees;
    const pnl = pending.shares - capital;
    return makeResult(pending.candidate, "COMPLETE", pnl, capital, 2, now, undefined, {
      execution: fillable[0] && fillable[1] ? "POST_LATENCY_BATCHED_FOK" : "ONE_LEG_FILL_PLUS_TAKER_HEDGE",
      fillPrices,
      fillable,
      fees,
      observedAskPrices: pending.observedAskPrices
    });
  }

  private maybeRecordThresholdLadderArbitrage(eventId: string, now: number): void {
    const key = `threshold-ladder:${eventId}`;
    if (this.activeThresholdLadders.has(key) || (this.cooldowns.get(key) ?? 0) > now) return;
    const eventMarkets = [...this.markets.values()].filter((market) => market.eventId === eventId);
    const built = buildThresholdLadderArbitrageCandidate(eventMarkets, this.books, this.config, now);
    if (!built || !this.insertCandidate(built.candidate)) return;
    const latencyMs = this.config.thresholdLadderExecutionLatencyMs ?? 250;
    const timeoutMs = Math.max(250, this.config.thresholdLadderExecutionTimeoutMs ?? 2_000);
    this.activeThresholdLadders.set(key, {
      candidate: built.candidate,
      markets: built.markets,
      tokenIds: built.tokenIds,
      observedAskPrices: built.askPrices,
      shares: built.shares,
      executeNotBefore: now + latencyMs,
      executeDeadline: now + latencyMs + timeoutMs
    });
    this.cooldowns.set(key, now + 5 * 60_000);
  }

  private maybeExecuteThresholdLadders(now: number): void {
    for (const [key, pending] of this.activeThresholdLadders) {
      if (now < pending.executeNotBefore || (now < pending.executeDeadline && !this.thresholdLadderBooksReady(pending))) continue;
      const result = this.evaluateThresholdLadderExecution(pending, now);
      if (!result && now < pending.executeDeadline) continue;
      this.insertResult(result ?? makeResult(pending.candidate, "NO_FILL", 0, 0, 0, now, undefined, {
        reason: "no post-latency executable threshold pair before timeout"
      }));
      this.activeThresholdLadders.delete(key);
    }
  }

  private thresholdLadderBooksReady(pending: PendingThresholdLadderArbitrage): boolean {
    return pending.tokenIds.every((tokenId) => {
      const book = this.books.get(tokenId);
      return book !== undefined && book.timestamp >= pending.executeNotBefore;
    });
  }

  private evaluateThresholdLadderExecution(pending: PendingThresholdLadderArbitrage, now: number): ExecutionResearchResult | undefined {
    const books = pending.tokenIds.map((tokenId) => this.books.get(tokenId));
    if (books.some((book) => !book?.bestAsk)) return undefined;
    const ordered = books as [OrderBookSnapshot, OrderBookSnapshot];
    const maxAgeMs = this.config.thresholdLadderMaxBookAgeMs ?? 1_000;
    const maxSkewMs = this.config.thresholdLadderMaxBookTimestampSkewMs ?? 500;
    const depthMultiple = this.config.thresholdLadderMinDepthMultiple ?? 2;
    const fresh = ordered.map((book) => now - book.timestamp >= 0 && now - book.timestamp <= maxAgeMs);
    if (Math.abs(ordered[0].timestamp - ordered[1].timestamp) > maxSkewMs) return undefined;
    const fillable = ordered.map((book, index) => fresh[index]
      && book.timestamp >= pending.executeNotBefore
      && book.bestAsk! <= pending.observedAskPrices[index] + 1e-9
      && topLevelSize(book.asks, book.bestAsk!) >= pending.shares * depthMultiple);
    if (!fillable[0] && !fillable[1]) return undefined;
    const fillPrices: [number, number] = [
      fillable[0] ? ordered[0].bestAsk! : Number.NaN,
      fillable[1] ? ordered[1].bestAsk! : Number.NaN
    ];
    const firstFilled = fillable[0] ? 0 : 1;
    if (!(fillable[0] && fillable[1])) {
      const missing = firstFilled === 0 ? 1 : 0;
      const hedgeBook = ordered[missing];
      if (!fresh[missing] || hedgeBook.timestamp < pending.executeNotBefore || !hedgeBook.bestAsk || topLevelSize(hedgeBook.asks, hedgeBook.bestAsk) < pending.shares) {
        const filledMarket = pending.markets[firstFilled];
        const feeRate = filledMarket.feesEnabled === false ? 0 : filledMarket.takerFeeRate ?? this.config.liveExecutionFeeRatePct ?? 0;
        const filledFee = takerFeeUsd(pending.shares, fillPrices[firstFilled], feeRate);
        const capital = pending.shares * fillPrices[firstFilled] + filledFee;
        return makeResult(pending.candidate, "HEDGE_MISS", -capital, capital, 1, now, undefined, {
          reason: "one threshold FOK leg filled and the paired hedge was unavailable",
          fillPrices,
          fillable,
          observedAskPrices: pending.observedAskPrices
        });
      }
      fillPrices[missing] = hedgeBook.bestAsk;
    }
    const fees = fillPrices.reduce((sum, price, index) => {
      const market = pending.markets[index];
      const rate = market.feesEnabled === false ? 0 : market.takerFeeRate ?? this.config.liveExecutionFeeRatePct ?? 0;
      return sum + takerFeeUsd(pending.shares, price, rate);
    }, 0);
    const capital = pending.shares * (fillPrices[0] + fillPrices[1]) + fees;
    const pnl = pending.shares - capital;
    return makeResult(pending.candidate, "COMPLETE", pnl, capital, 2, now, undefined, {
      execution: fillable[0] && fillable[1] ? "POST_LATENCY_CROSS_MARKET_FOK" : "ONE_LEG_FILL_PLUS_THRESHOLD_HEDGE",
      guaranteedPayoutPerShare: 1,
      fillPrices,
      fillable,
      fees,
      observedAskPrices: pending.observedAskPrices
    });
  }

  private maybeRecordNegRiskArbitrage(eventId: string, now: number): void {
    const key = `neg-risk:${eventId}`;
    if ((this.cooldowns.get(key) ?? 0) > now) return;
    const markets = [...this.markets.values()].filter((market) => market.eventId === eventId);
    const candidate = buildNegRiskArbitrageCandidate(markets, this.books, this.config, now);
    if (!candidate || !this.insertCandidate(candidate.candidate)) return;
    this.cooldowns.set(key, now + 5 * 60_000);
    this.insertResult(candidate.result);
  }

  private buildCrossMarketChoice(market: MarketSnapshot, tick: CryptoReferenceTick, moveBps: number): {
    market: MarketSnapshot;
    tokenId: string;
    predictedOutcome: string;
    book: OrderBookSnapshot;
    score: number;
  } | undefined {
    const parsed = cryptoDirection(market.question);
    if (!parsed || parsed.symbol !== tick.symbol || !isShortHorizonMarket(market, tick.receivedAt)) return undefined;
    const key = `cross:${market.id}`;
    if (this.activeCross.has(key) || (this.cooldowns.get(key) ?? 0) > tick.receivedAt) return undefined;
    const predictedYes = Math.sign(moveBps) === parsed.yesDirection;
    const desiredOutcome = market.outcomes.some((outcome) => /^(up|down)$/i.test(outcome))
      ? (moveBps > 0 ? "UP" : "DOWN")
      : (predictedYes ? "YES" : "NO");
    const outcomeIndex = market.outcomes.findIndex((outcome) => outcome.toUpperCase() === desiredOutcome);
    const tokenId = market.clobTokenIds[outcomeIndex];
    const book = tokenId ? this.books.get(tokenId) : undefined;
    if (!book?.bestAsk || book.bestBid === undefined) return undefined;
    const minPrice = this.config.crossMarketMinEntryPrice ?? 0.1;
    const maxPrice = this.config.crossMarketMaxEntryPrice ?? 0.9;
    if (book.bestAsk < minPrice || book.bestAsk > maxPrice) return undefined;
    const spread = book.bestAsk - book.bestBid;
    if (spread < 0 || spread > (this.config.crossMarketMaxSpread ?? 0.03)) return undefined;
    if (tick.receivedAt - book.timestamp < 0 || tick.receivedAt - book.timestamp > (this.config.crossMarketMaxBookAgeMs ?? 2_000)) return undefined;
    const requestedSizeUsd = this.config.crossMarketResearchSizeUsd ?? 10;
    const requestedShares = requestedSizeUsd / book.bestAsk;
    const depthMultiple = topLevelSize(book.asks, book.bestAsk) / requestedShares;
    if (depthMultiple < (this.config.crossMarketMinDepthMultiple ?? 3)) return undefined;
    const score = (1 - Math.abs(0.5 - book.bestAsk)) * 100 - spread * 1_000 + Math.min(20, depthMultiple);
    return { market, tokenId, predictedOutcome: desiredOutcome, book, score };
  }

  private openCrossMarket(
    choice: { market: MarketSnapshot; tokenId: string; predictedOutcome: string; book: OrderBookSnapshot; score: number },
    tick: CryptoReferenceTick,
    moveBps: number
  ): void {
    const { market, tokenId, predictedOutcome, book } = choice;
    const holdMs = this.config.crossMarketHoldMs ?? 30_000;
    const entryLatencyMs = this.config.crossMarketEntryLatencyMs ?? 250;
    const entryTimeoutMs = this.config.crossMarketEntryTimeoutMs ?? 2_000;
    const requestedSizeUsd = this.config.crossMarketResearchSizeUsd ?? 10;
    const expectedShares = requestedSizeUsd / book.bestAsk!;
    const feeRate = market.feesEnabled === false ? 0 : market.takerFeeRate ?? this.config.liveExecutionFeeRatePct ?? 0;
    const expectedEntryFee = takerFeeUsd(expectedShares, book.bestAsk!, feeRate);
    const candidate: ExecutionResearchCandidate = {
      id: researchId("cross", market.id, tokenId, String(tick.receivedAt), book.bestAsk!.toFixed(4)),
      strategy: "CROSS_MARKET_LATENCY",
      policyVersion: executionPolicyVersion(this.config, "CROSS_MARKET_LATENCY"),
      eventKey: market.eventId ?? market.id,
      marketIds: [market.id],
      tokenIds: [tokenId],
      observedAt: tick.receivedAt,
      expiresAt: tick.receivedAt + entryLatencyMs + entryTimeoutMs + holdMs,
      notionalUsd: requestedSizeUsd + expectedEntryFee,
      expectedGrossEdgeUsd: 0,
      expectedNetEdgeUsd: 0,
      details: {
        symbol: tick.symbol,
        referencePrice: tick.price,
        referenceMoveBps: moveBps,
        moveWindowMs: this.config.crossMarketMoveWindowMs ?? 2_000,
        predictedOutcome,
        observedAsk: book.bestAsk,
        observedSpread: book.bestAsk! - book.bestBid!,
        requestedSizeUsd,
        expectedShares,
        expectedEntryFee,
        entryLatencyMs,
        entryTimeoutMs,
        holdMs,
        selectionScore: choice.score,
        baseRewardsExcluded: true
      }
    };
    if (!this.insertCandidate(candidate)) return;
    const key = `cross:${market.id}`;
    this.activeCross.set(key, {
      candidate,
      market,
      tokenId,
      requestedSizeUsd,
      entryNotBefore: tick.receivedAt + entryLatencyMs,
      entryDeadline: tick.receivedAt + entryLatencyMs + entryTimeoutMs,
      holdMs
    });
    this.cooldowns.set(key, tick.receivedAt + Math.max(holdMs * 2, this.config.crossMarketSignalCooldownMs ?? 60_000));
  }

  private maybeEnterCross(tokenId: string, now: number): void {
    for (const active of this.activeCross.values()) {
      if (active.tokenId !== tokenId || active.enteredAt !== undefined || now < active.entryNotBefore || now > active.entryDeadline) continue;
      const book = this.books.get(tokenId);
      if (!book?.bestAsk || book.bestBid === undefined) continue;
      const minPrice = this.config.crossMarketMinEntryPrice ?? 0.1;
      const maxPrice = this.config.crossMarketMaxEntryPrice ?? 0.9;
      const spread = book.bestAsk - book.bestBid;
      if (book.bestAsk < minPrice || book.bestAsk > maxPrice || spread < 0 || spread > (this.config.crossMarketMaxSpread ?? 0.03)) continue;
      const shares = active.requestedSizeUsd / book.bestAsk;
      if (topLevelSize(book.asks, book.bestAsk) < shares * (this.config.crossMarketMinDepthMultiple ?? 3)) continue;
      const feeRate = active.market.feesEnabled === false ? 0 : active.market.takerFeeRate ?? this.config.liveExecutionFeeRatePct ?? 0;
      active.shares = shares;
      active.entryPrice = book.bestAsk;
      active.entryFee = takerFeeUsd(shares, book.bestAsk, feeRate);
      active.enteredAt = now;
      active.exitsAt = now + active.holdMs;
    }
  }

  private settleExpired(now: number): void {
    this.maybeExecuteBinary(now);
    this.maybeExecuteThresholdLadders(now);
    for (const [marketId, active] of this.activeMaker) {
      if (active.economicCompletedAt === undefined && now >= active.candidate.expiresAt) {
        this.processMakerFills(active, now);
        this.activeMaker.delete(marketId);
      } else if (active.economicCompletedAt === undefined && this.shouldRequoteMaker(active, now)) {
        const refreshed = buildMakerPairCandidate(active.market, booksForMarket(active.market, this.books), this.config, now, this.makerInventoryPosition(marketId));
        this.insertResult(makeResult(active.candidate, "NO_FILL", 0, 0, 0, now, undefined, {
          reason: refreshed ? "maker quote cancelled and replaced after top-of-book move" : "maker quote cancelled after book left frozen policy gates",
          execution: "CANCEL_REQUOTE",
          requotes: active.requotes
        }));
        this.activeMaker.delete(marketId);
        if (refreshed) {
          refreshed.candidate.details.requoteOf = active.candidate.id;
          refreshed.candidate.details.requoteSequence = active.requotes + 1;
          if (this.insertCandidate(refreshed.candidate)) {
            refreshed.requotes = active.requotes + 1;
            this.activeMaker.set(marketId, refreshed);
          }
        }
      }
    }
    this.settleMakerInventory(now);
    for (const [key, active] of this.activeCross) {
      if (active.enteredAt === undefined) {
        if (now < active.entryDeadline) continue;
        this.insertResult(makeResult(active.candidate, "NO_FILL", 0, 0, 0, now, undefined, {
          reason: "no executable post-latency entry before timeout",
          entryLatencyMs: active.entryNotBefore - active.candidate.observedAt,
          entryTimeoutMs: active.entryDeadline - active.entryNotBefore
        }));
        this.activeCross.delete(key);
        continue;
      }
      if (now < active.exitsAt!) continue;
      const book = this.books.get(active.tokenId);
      const capital = active.shares! * active.entryPrice! + active.entryFee!;
      const freshEnough = book && now - book.timestamp >= 0 && now - book.timestamp <= (this.config.crossMarketMaxBookAgeMs ?? 2_000);
      const executableDepth = book?.bestBid !== undefined ? topLevelSize(book.bids, book.bestBid) : 0;
      if (!freshEnough || book?.bestBid === undefined || executableDepth < active.shares!) {
        this.insertResult(makeResult(active.candidate, "HEDGE_MISS", -capital, capital, 1, now, undefined, {
          reason: !freshEnough ? "exit book stale" : "insufficient executable exit depth",
          entryPrice: active.entryPrice,
          shares: active.shares,
          enteredAt: active.enteredAt,
          intendedExitAt: active.exitsAt,
          exitDepth: executableDepth
        }));
      } else {
        const feeRate = active.market.feesEnabled === false ? 0 : active.market.takerFeeRate ?? this.config.liveExecutionFeeRatePct ?? 0;
        const exitFee = takerFeeUsd(active.shares!, book.bestBid, feeRate);
        const pnl = active.shares! * (book.bestBid - active.entryPrice!) - active.entryFee! - exitFee;
        this.insertResult(makeResult(active.candidate, "COMPLETE", pnl, capital, 2, now, pnl, {
          entryPrice: active.entryPrice,
          exitPrice: book.bestBid,
          shares: active.shares,
          entryFee: active.entryFee,
          exitFee,
          enteredAt: active.enteredAt,
          intendedExitAt: active.exitsAt
        }));
      }
      this.activeCross.delete(key);
    }
  }

  private processMakerFills(active: ActiveMakerQuote, now: number): void {
    const filled = active.legs.filter((leg) => leg.filledAt !== undefined);
    if (filled.length === 0) {
      this.insertResult(makeResult(active.candidate, "NO_FILL", 0, 0, 0, now, undefined, {
        reason: "observation window expired behind queue",
        requotes: active.requotes
      }));
      return;
    }

    const remaining = [...filled];
    let closedPriorLots = 0;
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      const closingLeg = remaining[index];
      const lots = this.makerInventory.get(active.market.id) ?? [];
      const matchIndex = lots.findIndex((lot) => lot.leg.tokenId !== closingLeg.tokenId && Math.abs(lot.leg.shares - closingLeg.shares) < 1e-9);
      if (matchIndex < 0) continue;
      const [opening] = lots.splice(matchIndex, 1);
      const capital = opening.leg.shares * (opening.leg.price + closingLeg.price);
      const pnl = opening.leg.shares - capital;
      this.insertResult(makeResult(opening.candidate, "COMPLETE", pnl, capital, 2, now, undefined, {
        execution: "INVENTORY_CLOSED_BY_LATER_MAKER_FILL",
        openedAt: opening.openedAt,
        openingTokenId: opening.leg.tokenId,
        openingPrice: opening.leg.price,
        closingTokenId: closingLeg.tokenId,
        closingPrice: closingLeg.price,
        inventoryAgeMs: now - opening.openedAt
      }));
      if (lots.length > 0) this.makerInventory.set(active.market.id, lots);
      else this.makerInventory.delete(active.market.id);
      remaining.splice(index, 1);
      closedPriorLots += 1;
    }

    if (remaining.length === 2 && remaining[0].tokenId !== remaining[1].tokenId && Math.abs(remaining[0].shares - remaining[1].shares) < 1e-9) {
      const capital = remaining.reduce((sum, leg) => sum + leg.price * leg.shares, 0);
      const pnl = remaining[0].shares - capital;
      this.insertResult(makeResult(active.candidate, "COMPLETE", pnl, capital, 2, now, undefined, {
        execution: "SAME_QUOTE_TWO_SIDED_MAKER_FILL",
        requotes: active.requotes
      }));
      remaining.length = 0;
    }

    if (remaining.length === 1) {
      const lots = this.makerInventory.get(active.market.id) ?? [];
      lots.push({ candidate: active.candidate, market: active.market, leg: remaining[0], openedAt: remaining[0].filledAt ?? now });
      this.makerInventory.set(active.market.id, lots);
    } else if (remaining.length === 0 && closedPriorLots > 0) {
      // This candidate supplied only the closing fill. Its cash flow is already
      // accounted for in the opening candidate's economic result.
      this.insertResult(makeResult(active.candidate, "COMPLETE", 0, 0, filled.length, now, undefined, {
        execution: "CLOSING_FILL_ACCOUNTED_TO_OPENING_INVENTORY",
        closedPriorLots,
        requotes: active.requotes
      }));
    }
    this.persistMakerInventory(now);
  }

  private settleMakerInventory(now: number): void {
    const maxAgeMs = this.config.makerResearchMaxInventoryAgeMs ?? 5 * 60_000;
    const maxShares = this.config.makerResearchMaxInventoryShares ?? 20;
    for (const [marketId, lots] of [...this.makerInventory]) {
      const totalShares = lots.reduce((sum, lot) => sum + lot.leg.shares, 0);
      let runningShares = totalShares;
      for (const lot of [...lots].sort((a, b) => a.openedAt - b.openedAt)) {
        const resolved = lot.market.resolved === true || (lot.market.closed === true && lot.market.winningOutcome !== undefined);
        if (!resolved && now - lot.openedAt < maxAgeMs && runningShares <= maxShares) continue;
        const index = lot.market.clobTokenIds.indexOf(lot.leg.tokenId);
        const outcome = lot.market.outcomes[index];
        let settled = true;
        if (resolved && outcome) {
          const payout = outcome.toUpperCase() === String(lot.market.winningOutcome).toUpperCase() ? lot.leg.shares : 0;
          const capital = lot.leg.shares * lot.leg.price;
          this.insertResult(makeResult(lot.candidate, "COMPLETE", payout - capital, capital, 1, now, undefined, {
            execution: "INVENTORY_RESOLUTION",
            outcome,
            winningOutcome: lot.market.winningOutcome,
            inventoryAgeMs: now - lot.openedAt
          }));
        } else {
          settled = this.forceHedgeMakerLot(lot, now);
        }
        if (!settled) continue;
        const current = this.makerInventory.get(marketId) ?? [];
        const lotIndex = current.findIndex((item) => item.candidate.id === lot.candidate.id);
        if (lotIndex >= 0) current.splice(lotIndex, 1);
        if (current.length > 0) this.makerInventory.set(marketId, current);
        else this.makerInventory.delete(marketId);
        runningShares -= lot.leg.shares;
      }
    }
    this.persistMakerInventory(now);
  }

  private forceHedgeMakerLot(lot: MakerInventoryLot, now: number): boolean {
    const oppositeTokenId = lot.market.clobTokenIds.find((tokenId) => tokenId !== lot.leg.tokenId);
    const hedgeBook = oppositeTokenId ? this.books.get(oppositeTokenId) : undefined;
    const hedgeAsk = hedgeBook?.bestAsk;
    const fresh = hedgeBook !== undefined && now - hedgeBook.timestamp >= 0 && now - hedgeBook.timestamp <= (this.config.makerResearchMaxBookAgeMs ?? 2_000);
    const openingCapital = lot.leg.price * lot.leg.shares;
    const hasDepth = hedgeBook !== undefined && hedgeAsk !== undefined && topLevelSize(hedgeBook.asks, hedgeAsk) >= lot.leg.shares;
    if (!fresh || !hedgeAsk || !hasDepth) {
      const refreshState = this.makerHedgeRefreshes.get(lot.candidate.id);
      const refreshTimeoutMs = this.config.makerResearchHedgeRefreshTimeoutMs ?? 5_000;
      if (!refreshState && oppositeTokenId && this.refreshOrderBook) {
        const state = { requestedAt: now, completed: false } as MakerHedgeRefreshState;
        state.timer = setTimeout(() => this.settleMakerInventory(Date.now()), refreshTimeoutMs);
        state.timer.unref?.();
        this.makerHedgeRefreshes.set(lot.candidate.id, state);
        void Promise.resolve()
          .then(() => this.refreshOrderBook!(oppositeTokenId, lot.market.id))
          .then((book) => {
            if (book) this.books.set(oppositeTokenId, book);
          })
          .catch(() => undefined)
          .finally(() => {
            state.completed = true;
            this.settleMakerInventory(Date.now());
          });
        return false;
      }
      if (refreshState && !refreshState.completed && now - refreshState.requestedAt < refreshTimeoutMs) return false;
      if (refreshState) clearTimeout(refreshState.timer);
      this.makerHedgeRefreshes.delete(lot.candidate.id);
      this.insertResult(makeResult(lot.candidate, "HEDGE_MISS", -openingCapital, openingCapital, 1, now, undefined, {
        reason: !fresh ? "fresh forced-hedge book request failed or timed out" : "fresh forced-hedge book lacked full ask depth",
        inventoryAgeMs: now - lot.openedAt,
        refreshAttempted: Boolean(refreshState),
        refreshTimeoutMs
      }));
      return true;
    }
    const refreshState = this.makerHedgeRefreshes.get(lot.candidate.id);
    if (refreshState) clearTimeout(refreshState.timer);
    this.makerHedgeRefreshes.delete(lot.candidate.id);
    const feeRate = lot.market.feesEnabled === false ? 0 : lot.market.takerFeeRate ?? this.config.liveExecutionFeeRatePct ?? 0;
    const hedgeFee = takerFeeUsd(lot.leg.shares, hedgeAsk, feeRate);
    const capital = openingCapital + lot.leg.shares * hedgeAsk + hedgeFee;
    this.insertResult(makeResult(lot.candidate, "COMPLETE", lot.leg.shares - capital, capital, 2, now, undefined, {
      execution: "MAX_AGE_OR_INVENTORY_TAKER_HEDGE",
      openingPrice: lot.leg.price,
      hedgePrice: hedgeAsk,
      hedgeFee,
      inventoryAgeMs: now - lot.openedAt,
      freshBookRefreshUsed: Boolean(refreshState)
    }));
    return true;
  }

  private shouldRequoteMaker(active: ActiveMakerQuote, now: number): boolean {
    if (active.legs.some((leg) => leg.filledAt !== undefined)) return false;
    const tick = active.legs.map((leg) => this.books.get(leg.tokenId)?.tickSize).find((value) => value !== undefined) ?? 0.01;
    const threshold = tick * (this.config.makerResearchRequoteTicks ?? 2);
    return active.legs.some((leg) => {
      const book = this.books.get(leg.tokenId);
      const fresh = book !== undefined && now - book.timestamp >= 0 && now - book.timestamp <= (this.config.makerResearchMaxBookAgeMs ?? 2_000);
      return fresh && book.bestBid !== undefined && Math.abs(book.bestBid - leg.price) >= threshold - 1e-9;
    });
  }

  private makerInventoryPosition(marketId: string): { tokenId: string; shares: number } | undefined {
    const lots = this.makerInventory.get(marketId) ?? [];
    if (lots.length === 0) return undefined;
    const byToken = new Map<string, number>();
    for (const lot of lots) byToken.set(lot.leg.tokenId, (byToken.get(lot.leg.tokenId) ?? 0) + lot.leg.shares);
    const largest = [...byToken].sort((a, b) => b[1] - a[1])[0];
    return largest ? { tokenId: largest[0], shares: largest[1] } : undefined;
  }

  private persistMakerInventory(now: number): void {
    this.db.saveExecutionResearchState(this.makerStateKey(), [...this.makerInventory], now);
  }

  private makerStateKey(): string {
    return `maker-inventory:${executionPolicyVersion(this.config, "MAKER_PAIR")}`;
  }


  private insertCandidate(candidate: ExecutionResearchCandidate): boolean {
    const inserted = this.db.insertExecutionResearchCandidate(candidate);
    if (inserted) this.insertedCandidates += 1;
    return inserted;
  }

  private insertResult(result: ExecutionResearchResult): boolean {
    const inserted = this.db.insertExecutionResearchResult(result);
    if (inserted) this.insertedResults += 1;
    return inserted;
  }
}

export function buildMakerPairCandidate(
  market: MarketSnapshot,
  books: OrderBookSnapshot[],
  config: Pick<BotConfig,
    | "makerResearchQuoteShares"
    | "makerResearchMinPairEdge"
    | "makerResearchMaxPairEdge"
    | "makerResearchMinQuotePrice"
    | "makerResearchMaxQuotePrice"
    | "makerResearchMaxLegSpread"
    | "makerResearchMaxBookTimestampSkewMs"
    | "makerResearchQuoteTtlMs"
    | "makerResearchMinHedgeDepthMultiple"
    | "makerResearchMaxHedgeLossPct"
    | "makerResearchMaxInventoryShares"
    | "makerResearchInventorySkewTicks"
    | "makerResearchMinTimeToEndMs"
    | "makerResearchMaxBookAgeMs"
    | "liveExecutionFeeRatePct"
    | "executionResearchPolicyVersion"
    | "makerResearchPolicyVersion"
  >,
  now: number,
  inventory?: { tokenId: string; shares: number }
): ActiveMakerQuote | undefined {
  if (books.length !== 2 || market.clobTokenIds.length !== 2) return undefined;
  const ordered = market.clobTokenIds.map((tokenId) => books.find((book) => book.tokenId === tokenId));
  if (ordered.some((book) => !book?.bestBid || !book.bestAsk || book.bestAsk <= book.bestBid)) return undefined;
  const [first, second] = ordered as [OrderBookSnapshot, OrderBookSnapshot];
  const maxBookAgeMs = config.makerResearchMaxBookAgeMs ?? 2_000;
  if ([first, second].some((book) => now - book.timestamp < 0 || now - book.timestamp > maxBookAgeMs)) return undefined;
  const bookTimestampSkewMs = Math.abs(first.timestamp - second.timestamp);
  const maxBookTimestampSkewMs = config.makerResearchMaxBookTimestampSkewMs ?? 1_000;
  if (bookTimestampSkewMs > maxBookTimestampSkewMs) return undefined;
  const legSpreads: [number, number] = [first.bestAsk! - first.bestBid!, second.bestAsk! - second.bestBid!];
  const maxLegSpread = config.makerResearchMaxLegSpread ?? 0.05;
  if (legSpreads.some((spread) => spread < 0 || spread > maxLegSpread)) return undefined;
  const endAt = market.endDate ? Date.parse(market.endDate) : Number.NaN;
  if (Number.isFinite(endAt) && endAt - now < (config.makerResearchMinTimeToEndMs ?? 60 * 60_000)) return undefined;
  const shares = config.makerResearchQuoteShares ?? 10;
  const tick = first.tickSize ?? second.tickSize ?? 0.01;
  const skew = tick * (config.makerResearchInventorySkewTicks ?? 1);
  const quotePrices: [number, number] = [first.bestBid!, second.bestBid!];
  if (inventory?.shares && inventory.tokenId === first.tokenId) {
    quotePrices[0] = roundToTick(Math.max(tick, first.bestBid! - skew), tick);
    quotePrices[1] = roundToTick(Math.min(second.bestAsk! - tick, second.bestBid! + skew), tick);
  } else if (inventory?.shares && inventory.tokenId === second.tokenId) {
    quotePrices[0] = roundToTick(Math.min(first.bestAsk! - tick, first.bestBid! + skew), tick);
    quotePrices[1] = roundToTick(Math.max(tick, second.bestBid! - skew), tick);
  }
  if (quotePrices[0] <= 0 || quotePrices[1] <= 0 || quotePrices[0] >= first.bestAsk! || quotePrices[1] >= second.bestAsk!) return undefined;
  const minQuotePrice = config.makerResearchMinQuotePrice ?? 0.05;
  const maxQuotePrice = config.makerResearchMaxQuotePrice ?? 0.95;
  if (quotePrices.some((price) => price < minQuotePrice || price > maxQuotePrice)) return undefined;
  const pairEdge = 1 - quotePrices[0] - quotePrices[1];
  const minPairEdge = config.makerResearchMinPairEdge ?? 0.01;
  const maxPairEdge = config.makerResearchMaxPairEdge ?? 0.08;
  if (pairEdge < minPairEdge || pairEdge > maxPairEdge) return undefined;
  const feeRate = market.feesEnabled === false ? 0 : market.takerFeeRate ?? config.liveExecutionFeeRatePct ?? 0;
  const hedgeScenarios = [
    makerHedgeScenario(quotePrices[0], second, shares, feeRate),
    makerHedgeScenario(quotePrices[1], first, shares, feeRate)
  ];
  const minHedgeDepthMultiple = config.makerResearchMinHedgeDepthMultiple ?? 3;
  const maxHedgeLossPct = config.makerResearchMaxHedgeLossPct ?? 0.02;
  if (hedgeScenarios.some((scenario) =>
    scenario.depthMultiple < minHedgeDepthMultiple || scenario.returnPct < -maxHedgeLossPct
  )) return undefined;
  const maxInventoryShares = config.makerResearchMaxInventoryShares ?? 20;
  const legs: [MakerLegState, MakerLegState] = [first, second].map((book, index) => ({
    tokenId: book.tokenId,
    price: quotePrices[index],
    shares: inventory && inventory.shares >= maxInventoryShares && inventory.tokenId === book.tokenId ? 0 : shares,
    queueAhead: queueAheadAtPrice(book.bids, quotePrices[index]),
    tradedAfterQueue: 0
  })) as [MakerLegState, MakerLegState];
  if (legs.every((leg) => leg.shares <= 0)) return undefined;
  const candidate: ExecutionResearchCandidate = {
    id: researchId("maker", market.id, quotePrices[0].toFixed(4), quotePrices[1].toFixed(4), String(now)),
    strategy: "MAKER_PAIR",
    policyVersion: config.makerResearchPolicyVersion ?? config.executionResearchPolicyVersion ?? "maker-unfrozen",
    eventKey: market.eventId ?? market.id,
    marketIds: [market.id],
    tokenIds: market.clobTokenIds,
    observedAt: now,
    expiresAt: now + (config.makerResearchQuoteTtlMs ?? 30_000),
    notionalUsd: legs.reduce((sum, leg) => sum + leg.shares * leg.price, 0),
    expectedGrossEdgeUsd: shares * pairEdge,
    expectedNetEdgeUsd: shares * pairEdge,
    details: {
      quotePrices: legs.map((leg) => leg.price),
      queueAhead: legs.map((leg) => leg.queueAhead),
      quoteShares: shares,
      inventoryTokenId: inventory?.tokenId,
      inventoryShares: inventory?.shares ?? 0,
      inventorySkewTicks: config.makerResearchInventorySkewTicks ?? 1,
      maxInventoryShares,
      maxBookAgeMs,
      bookAgesMs: [now - first.timestamp, now - second.timestamp],
      bookTimestampSkewMs,
      maxBookTimestampSkewMs,
      legSpreads,
      maxLegSpread,
      pairEdge,
      minPairEdge,
      maxPairEdge,
      minQuotePrice,
      maxQuotePrice,
      hedgeScenarios,
      minHedgeDepthMultiple,
      maxHedgeLossPct,
      rebatesExcluded: true,
      rewardsExcluded: true
    }
  };
  return { candidate, market, legs, requotes: 0 };
}

function makerHedgeScenario(makerPrice: number, oppositeBook: OrderBookSnapshot, shares: number, feeRate: number) {
  const hedgePrice = oppositeBook.bestAsk!;
  const hedgeFee = takerFeeUsd(shares, hedgePrice, feeRate);
  const capitalUsd = shares * (makerPrice + hedgePrice) + hedgeFee;
  const pnlUsd = shares - capitalUsd;
  return {
    makerPrice,
    hedgePrice,
    hedgeFee,
    depthMultiple: topLevelSize(oppositeBook.asks, hedgePrice) / shares,
    returnPct: capitalUsd > 0 ? pnlUsd / capitalUsd : -1
  };
}

export function buildBinaryPairArbitrageCandidate(
  market: MarketSnapshot,
  books: OrderBookSnapshot[],
  config: Pick<BotConfig,
    | "pairedResearchShares"
    | "pairedResearchMinNetEdge"
    | "liveExecutionFeeRatePct"
    | "executionResearchPolicyVersion"
    | "binaryArbPolicyVersion"
    | "binaryArbExecutionLatencyMs"
    | "binaryArbExecutionTimeoutMs"
    | "binaryArbMaxBookAgeMs"
    | "binaryArbMinDepthMultiple"
    | "crossMarketEntryTimeoutMs"
  >,
  now: number
): { candidate: ExecutionResearchCandidate; result: ExecutionResearchResult } | undefined {
  if (books.length !== 2 || market.clobTokenIds.length !== 2) return undefined;
  const ordered = market.clobTokenIds.map((tokenId) => books.find((book) => book.tokenId === tokenId));
  if (ordered.some((book) => !book?.bestAsk)) return undefined;
  const [first, second] = ordered as [OrderBookSnapshot, OrderBookSnapshot];
  const maxBookAgeMs = config.binaryArbMaxBookAgeMs ?? 1_000;
  if ([first, second].some((book) => now - book.timestamp < 0 || now - book.timestamp > maxBookAgeMs)) return undefined;
  const minDepthMultiple = config.binaryArbMinDepthMultiple ?? 2;
  const shares = Math.min(
    config.pairedResearchShares ?? 10,
    topLevelSize(first.asks, first.bestAsk!) / minDepthMultiple,
    topLevelSize(second.asks, second.bestAsk!) / minDepthMultiple
  );
  if (!(shares > 0)) return undefined;
  const rate = market.feesEnabled === false ? 0 : market.takerFeeRate ?? config.liveExecutionFeeRatePct ?? 0;
  const fees = takerFeeUsd(shares, first.bestAsk!, rate) + takerFeeUsd(shares, second.bestAsk!, rate);
  const grossPnl = shares * (1 - first.bestAsk! - second.bestAsk!);
  const netPnl = grossPnl - fees;
  if (netPnl / shares < (config.pairedResearchMinNetEdge ?? 0.005)) return undefined;
  const capital = shares * (first.bestAsk! + second.bestAsk!) + fees;
  const candidate: ExecutionResearchCandidate = {
    id: researchId("binary-arb", market.id, first.bestAsk!.toFixed(4), second.bestAsk!.toFixed(4), String(Math.floor(now / 60_000))),
    strategy: "BINARY_PAIR_ARB",
    policyVersion: config.binaryArbPolicyVersion ?? config.executionResearchPolicyVersion ?? "binary-arb-unfrozen",
    eventKey: market.eventId ?? market.id,
    marketIds: [market.id],
    tokenIds: market.clobTokenIds,
    observedAt: now,
    expiresAt: now + (config.binaryArbExecutionLatencyMs ?? 250) + Math.max(250, config.binaryArbExecutionTimeoutMs ?? 2_000),
    notionalUsd: capital,
    expectedGrossEdgeUsd: grossPnl,
    expectedNetEdgeUsd: netPnl,
    details: {
      askPrices: [first.bestAsk, second.bestAsk],
      shares,
      fees,
      execution: "POST_LATENCY_BATCHED_FOK",
      executionLatencyMs: config.binaryArbExecutionLatencyMs ?? 250,
      maxBookAgeMs,
      minDepthMultiple
    }
  };
  return { candidate, result: makeResult(candidate, "COMPLETE", netPnl, capital, 2, now) };
}

/**
 * A monotonic threshold pair has a deterministic minimum $1 payout. For
 * ABOVE markets, YES(lower) + NO(higher) pays at least $1 in every state. For
 * BELOW markets, NO(lower) + YES(higher) has the same property.
 */
export function buildThresholdLadderArbitrageCandidate(
  markets: MarketSnapshot[],
  books: Map<string, OrderBookSnapshot>,
  config: Pick<BotConfig,
    | "pairedResearchShares"
    | "pairedResearchMinNetEdge"
    | "liveExecutionFeeRatePct"
    | "executionResearchPolicyVersion"
    | "thresholdLadderPolicyVersion"
    | "thresholdLadderExecutionLatencyMs"
    | "thresholdLadderExecutionTimeoutMs"
    | "thresholdLadderMaxBookAgeMs"
    | "thresholdLadderMaxBookTimestampSkewMs"
    | "thresholdLadderMinDepthMultiple"
  >,
  now: number
): {
  candidate: ExecutionResearchCandidate;
  markets: [MarketSnapshot, MarketSnapshot];
  tokenIds: [string, string];
  askPrices: [number, number];
  shares: number;
} | undefined {
  const parsed = markets
    .map((market) => ({ market, spec: parseThresholdLadderMarket(market) }))
    .filter((item): item is { market: MarketSnapshot; spec: ThresholdLadderSpec } => Boolean(item.spec))
    .filter((item) => item.market.eventId && item.market.active && !item.market.closed && !item.market.resolved && item.market.acceptingOrders);
  const choices: Array<{
    candidate: ExecutionResearchCandidate;
    markets: [MarketSnapshot, MarketSnapshot];
    tokenIds: [string, string];
    askPrices: [number, number];
    shares: number;
  }> = [];
  for (let leftIndex = 0; leftIndex < parsed.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < parsed.length; rightIndex += 1) {
      const pair = [parsed[leftIndex], parsed[rightIndex]].sort((left, right) => left.spec.threshold - right.spec.threshold);
      const lower = pair[0];
      const higher = pair[1];
      if (lower.spec.threshold === higher.spec.threshold || lower.spec.asset !== higher.spec.asset || lower.spec.direction !== higher.spec.direction) continue;
      if (!lower.market.eventId || lower.market.eventId !== higher.market.eventId) continue;
      const lowerEnd = lower.market.endDate ? Date.parse(lower.market.endDate) : Number.NaN;
      const higherEnd = higher.market.endDate ? Date.parse(higher.market.endDate) : Number.NaN;
      if (!Number.isFinite(lowerEnd) || !Number.isFinite(higherEnd) || Math.abs(lowerEnd - higherEnd) > 60_000) continue;
      const lowerOutcome = lower.spec.direction === "ABOVE" ? "YES" : "NO";
      const higherOutcome = lower.spec.direction === "ABOVE" ? "NO" : "YES";
      const lowerToken = tokenForOutcome(lower.market, lowerOutcome);
      const higherToken = tokenForOutcome(higher.market, higherOutcome);
      if (!lowerToken || !higherToken) continue;
      const orderedBooks = [books.get(lowerToken), books.get(higherToken)];
      if (orderedBooks.some((book) => !book?.bestAsk)) continue;
      const [lowerBook, higherBook] = orderedBooks as [OrderBookSnapshot, OrderBookSnapshot];
      const maxBookAgeMs = config.thresholdLadderMaxBookAgeMs ?? 1_000;
      if ([lowerBook, higherBook].some((book) => now - book.timestamp < 0 || now - book.timestamp > maxBookAgeMs)) continue;
      const timestampSkewMs = Math.abs(lowerBook.timestamp - higherBook.timestamp);
      const maxTimestampSkewMs = config.thresholdLadderMaxBookTimestampSkewMs ?? 500;
      if (timestampSkewMs > maxTimestampSkewMs) continue;
      const minDepthMultiple = config.thresholdLadderMinDepthMultiple ?? 2;
      const shares = Math.min(
        config.pairedResearchShares ?? 10,
        topLevelSize(lowerBook.asks, lowerBook.bestAsk!) / minDepthMultiple,
        topLevelSize(higherBook.asks, higherBook.bestAsk!) / minDepthMultiple
      );
      if (!(shares > 0)) continue;
      const askPrices: [number, number] = [lowerBook.bestAsk!, higherBook.bestAsk!];
      const feeRates: [number, number] = [lower.market, higher.market].map((market) =>
        market.feesEnabled === false ? 0 : market.takerFeeRate ?? config.liveExecutionFeeRatePct ?? 0
      ) as [number, number];
      const fees = takerFeeUsd(shares, askPrices[0], feeRates[0]) + takerFeeUsd(shares, askPrices[1], feeRates[1]);
      const grossPnl = shares * (1 - askPrices[0] - askPrices[1]);
      const netPnl = grossPnl - fees;
      if (netPnl / shares < (config.pairedResearchMinNetEdge ?? 0.005)) continue;
      const capital = shares * (askPrices[0] + askPrices[1]) + fees;
      const latencyMs = config.thresholdLadderExecutionLatencyMs ?? 250;
      const timeoutMs = Math.max(250, config.thresholdLadderExecutionTimeoutMs ?? 2_000);
      const candidate: ExecutionResearchCandidate = {
        id: researchId("threshold-ladder", lower.market.eventId, lower.market.id, higher.market.id, askPrices[0].toFixed(4), askPrices[1].toFixed(4), String(Math.floor(now / 60_000))),
        strategy: "THRESHOLD_LADDER_ARB",
        policyVersion: config.thresholdLadderPolicyVersion ?? config.executionResearchPolicyVersion ?? "threshold-ladder-unfrozen",
        eventKey: lower.market.eventId,
        marketIds: [lower.market.id, higher.market.id],
        tokenIds: [lowerToken, higherToken],
        observedAt: now,
        expiresAt: now + latencyMs + timeoutMs,
        notionalUsd: capital,
        expectedGrossEdgeUsd: grossPnl,
        expectedNetEdgeUsd: netPnl,
        details: {
          asset: lower.spec.asset,
          direction: lower.spec.direction,
          lowerThreshold: lower.spec.threshold,
          higherThreshold: higher.spec.threshold,
          outcomes: [lowerOutcome, higherOutcome],
          askPrices,
          shares,
          fees,
          guaranteedPayoutPerShare: 1,
          execution: "POST_LATENCY_CROSS_MARKET_FOK",
          executionLatencyMs: latencyMs,
          executionTimeoutMs: timeoutMs,
          maxBookAgeMs,
          timestampSkewMs,
          maxTimestampSkewMs,
          minDepthMultiple,
          rewardsExcluded: true,
          rebatesExcluded: true
        }
      };
      choices.push({ candidate, markets: [lower.market, higher.market], tokenIds: [lowerToken, higherToken], askPrices, shares });
    }
  }
  return choices.sort((left, right) => right.candidate.expectedNetEdgeUsd - left.candidate.expectedNetEdgeUsd)[0];
}

export function parseThresholdLadderMarket(market: MarketSnapshot): ThresholdLadderSpec | undefined {
  const asset = /bitcoin|\bbtc\b/i.test(market.question)
    ? "BTC"
    : /ethereum|\beth\b/i.test(market.question)
      ? "ETH"
      : undefined;
  if (!asset) return undefined;
  const thresholdMatch = market.question.match(/\b(above|over|higher than|at least|below|under|lower than|at most)\s+\$?([\d,]+(?:\.\d+)?)/i);
  if (!thresholdMatch) return undefined;
  const threshold = Number(thresholdMatch[2].replace(/,/g, ""));
  if (!(threshold > 0)) return undefined;
  const direction = /above|over|higher|at least/i.test(thresholdMatch[1]) ? "ABOVE" : "BELOW";
  return { asset, direction, threshold };
}

export function buildNegRiskArbitrageCandidate(
  markets: MarketSnapshot[],
  books: Map<string, OrderBookSnapshot>,
  config: Pick<BotConfig, "pairedResearchShares" | "pairedResearchMinNetEdge" | "liveExecutionFeeRatePct" | "executionResearchPolicyVersion" | "negRiskArbPolicyVersion">,
  now: number
): { candidate: ExecutionResearchCandidate; result: ExecutionResearchResult } | undefined {
  if (markets.length < 3 || markets.some((market) => !market.negRisk || market.negRiskAugmented || /\bother\b|placeholder/i.test(market.question))) return undefined;
  const expectedCount = expectedEventOutcomeCount(markets[0]);
  // Buying every named YES leg is only a defined payout bundle when Gamma gave
  // us the complete event graph. An unknown or partial graph is not arbitrage.
  if (expectedCount === undefined || expectedCount !== markets.length) return undefined;
  const legs = markets.map((market) => {
    const yesIndex = market.outcomes.findIndex((outcome) => outcome.toUpperCase() === "YES");
    const tokenId = market.clobTokenIds[yesIndex];
    const book = tokenId ? books.get(tokenId) : undefined;
    return { market, tokenId, book };
  });
  if (legs.some((leg) => !leg.tokenId || !leg.book?.bestAsk)) return undefined;
  const shares = Math.min(config.pairedResearchShares ?? 10, ...legs.map((leg) => topLevelSize(leg.book!.asks, leg.book!.bestAsk!)));
  if (!(shares > 0)) return undefined;
  const askSum = legs.reduce((sum, leg) => sum + leg.book!.bestAsk!, 0);
  const fees = legs.reduce((sum, leg) => {
    const rate = leg.market.feesEnabled === false ? 0 : leg.market.takerFeeRate ?? config.liveExecutionFeeRatePct ?? 0;
    return sum + takerFeeUsd(shares, leg.book!.bestAsk!, rate);
  }, 0);
  const grossPnl = shares * (1 - askSum);
  const netPnl = grossPnl - fees;
  if (netPnl / shares < (config.pairedResearchMinNetEdge ?? 0.005)) return undefined;
  const capital = shares * askSum + fees;
  const eventKey = markets[0].eventId!;
  const candidate: ExecutionResearchCandidate = {
    id: researchId("neg-risk", eventKey, askSum.toFixed(5), String(Math.floor(now / 60_000))),
    strategy: "NEG_RISK_ARB",
    policyVersion: config.negRiskArbPolicyVersion ?? config.executionResearchPolicyVersion ?? "neg-risk-arb-unfrozen",
    eventKey,
    marketIds: markets.map((market) => market.id),
    tokenIds: legs.map((leg) => leg.tokenId!),
    observedAt: now,
    expiresAt: now,
    notionalUsd: capital,
    expectedGrossEdgeUsd: grossPnl,
    expectedNetEdgeUsd: netPnl,
    details: { askSum, shares, fees, legs: legs.length, execution: "ALL_LEGS_FOK", completeNamedGraph: true }
  };
  return { candidate, result: makeResult(candidate, "COMPLETE", netPnl, capital, legs.length, now) };
}

function booksForMarket(market: MarketSnapshot, books: Map<string, OrderBookSnapshot>): OrderBookSnapshot[] {
  return market.clobTokenIds.map((tokenId) => books.get(tokenId)).filter((book): book is OrderBookSnapshot => Boolean(book));
}

function tokenForOutcome(market: MarketSnapshot, outcome: "YES" | "NO"): string | undefined {
  const index = market.outcomes.findIndex((candidate) => candidate.toUpperCase() === outcome);
  return index >= 0 ? market.clobTokenIds[index] : undefined;
}

function topLevelSize(levels: PriceLevel[] | undefined, price: number): number {
  return levels?.find((level) => Math.abs(level.price - price) < 1e-9)?.size ?? 0;
}

function queueAheadAtPrice(levels: PriceLevel[] | undefined, price: number): number {
  return levels?.filter((level) => level.price >= price - 1e-9).reduce((sum, level) => sum + level.size, 0) ?? 0;
}

function roundToTick(value: number, tick: number): number {
  return Math.round(value / tick) * tick;
}

function makeResult(
  candidate: ExecutionResearchCandidate,
  status: ExecutionResearchResult["status"],
  pnlUsd: number,
  capitalUsd: number,
  filledLegs: number,
  resolvedAt: number,
  adverseSelection5m?: number,
  details: Record<string, unknown> = {}
): ExecutionResearchResult {
  return {
    id: researchId("result", candidate.id),
    candidateId: candidate.id,
    strategy: candidate.strategy,
    policyVersion: candidate.policyVersion,
    eventKey: candidate.eventKey,
    status,
    pnlUsd: roundMoney(pnlUsd),
    capitalUsd: roundMoney(capitalUsd),
    returnPct: capitalUsd > 0 ? pnlUsd / capitalUsd : 0,
    filledLegs,
    latencyMs: Math.max(0, resolvedAt - candidate.observedAt),
    adverseSelection5m,
    resolvedAt,
    details: { expectedNetEdgeUsd: candidate.expectedNetEdgeUsd, rewardsExcluded: true, rebatesExcluded: true, ...details }
  };
}

function expectedEventOutcomeCount(market: MarketSnapshot): number | undefined {
  if (market.eventMarketCount !== undefined) return market.eventMarketCount;
  const raw = market.raw as Record<string, unknown> | undefined;
  const events = Array.isArray(raw?.events) ? raw.events as Array<Record<string, unknown>> : [];
  const nested = events[0]?.markets;
  return Array.isArray(nested) ? nested.length : undefined;
}

function cryptoDirection(question: string): { symbol: CryptoReferenceTick["symbol"]; yesDirection: 1 | -1 } | undefined {
  const symbol = /bitcoin|\bbtc\b/i.test(question) ? "BTCUSDT" : /ethereum|\beth\b/i.test(question) ? "ETHUSDT" : undefined;
  if (!symbol) return undefined;
  if (/above|over|up|higher|increase|rise/i.test(question)) return { symbol, yesDirection: 1 };
  if (/below|under|down|lower|decrease|fall/i.test(question)) return { symbol, yesDirection: -1 };
  return undefined;
}

function isShortHorizonMarket(market: MarketSnapshot, now: number): boolean {
  if (!market.endDate) return false;
  const endsAt = Date.parse(market.endDate);
  if (!Number.isFinite(endsAt)) return false;
  const remaining = endsAt - now;
  return remaining > 0 && remaining <= 36 * 60 * 60_000;
}

function researchId(...parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
}

function roundMoney(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
