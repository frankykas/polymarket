import { randomId } from "./db.js";
import { discoverWallets, scoreDiscoveredWallet, scoreWallet } from "./walletIntelligence.js";
import type {
  BotConfig,
  ExitDecision,
  MarketQuality,
  MarketSnapshot,
  OrderBookSnapshot,
  PaperFill,
  PaperOrder,
  Position,
  RiskDecision,
  Side,
  TradeSignal,
  WalletScore,
  WalletTrade
} from "./types.js";

export { discoverWallets, scoreDiscoveredWallet, scoreWallet };

export function evaluateMarketQuality(
  market: MarketSnapshot,
  books: OrderBookSnapshot[],
  config: BotConfig,
  now = Date.now()
): MarketQuality {
  const reasons: string[] = [];
  if (!market.active || market.closed || market.archived || !market.acceptingOrders) reasons.push("market is not tradable");
  if (market.liquidity < config.minLiquidity) reasons.push(`liquidity ${market.liquidity} below ${config.minLiquidity}`);
  if (market.endDate) {
    const hours = (Date.parse(market.endDate) - now) / 3_600_000;
    if (Number.isFinite(hours) && hours < config.minTimeToResolutionHours) reasons.push("too close to resolution");
  }
  const validBooks = books.filter((book) => book.bestBid !== undefined && book.bestAsk !== undefined);
  if (validBooks.length === 0) reasons.push("missing usable order book");
  for (const book of validBooks) {
    if ((book.spread ?? 1) > config.maxSpread) reasons.push(`spread ${book.spread?.toFixed(4)} above ${config.maxSpread}`);
    if (book.depth < config.minOrderBookDepth) reasons.push(`depth ${book.depth} below ${config.minOrderBookDepth}`);
  }

  const spreadScore = validBooks.length
    ? Math.max(0, 35 - Math.min(...validBooks.map((book) => book.spread ?? 1)) * 350)
    : 0;
  const liquidityScore = Math.min(35, (market.liquidity / config.minLiquidity) * 20);
  const depthScore = validBooks.length ? Math.min(30, Math.max(...validBooks.map((book) => book.depth)) / config.minOrderBookDepth * 10) : 0;
  return {
    approved: reasons.length === 0,
    score: Math.round(Math.max(0, Math.min(100, spreadScore + liquidityScore + depthScore))),
    reasons
  };
}

export function generateSignals(
  market: MarketSnapshot,
  books: OrderBookSnapshot[],
  trades: WalletTrade[],
  scores: WalletScore[],
  config: BotConfig
): TradeSignal[] {
  const scoreByWallet = new Map(scores.map((score) => [score.wallet.toLowerCase(), score]));
  const grouped = new Map<string, WalletTrade[]>();
  for (const trade of trades) {
    const score = scoreByWallet.get(trade.wallet.toLowerCase());
    if (!score || score.score < config.minWalletScore || trade.side !== "BUY") continue;
    const key = `${trade.marketId}:${trade.outcome}`;
    const list = grouped.get(key) ?? [];
    list.push(trade);
    grouped.set(key, list);
  }

  const signals: TradeSignal[] = [];
  for (const [key, alignedTrades] of grouped) {
    const [marketId, outcome] = key.split(":");
    if (marketId !== market.id && marketId !== market.conditionId) continue;
    const alignedWallets = [...new Set(alignedTrades.map((trade) => trade.wallet.toLowerCase()))];
    if (alignedWallets.length < config.minAlignedWallets) continue;

    const tokenId = tokenForOutcome(market, outcome) ?? alignedTrades.find((trade) => trade.tokenId)?.tokenId;
    if (!tokenId) continue;
    const book = books.find((candidate) => candidate.tokenId === tokenId);
    const limitPrice = book?.bestAsk ?? alignedTrades[alignedTrades.length - 1]?.price ?? 0;
    if (limitPrice <= 0) continue;

    const walletComponent = Math.min(40, alignedWallets.length * 20);
    const scoreComponent = Math.min(
      35,
      alignedWallets.reduce((sum, wallet) => sum + (scoreByWallet.get(wallet)?.score ?? 0), 0) / alignedWallets.length * 0.35
    );
    const priceComponent = Math.max(0, 25 - Math.max(0, limitPrice - 0.5) * 20);
    const confidence = Math.round(Math.min(100, walletComponent + scoreComponent + priceComponent));

    signals.push({
      id: randomId("sig"),
      decision: confidence >= config.minSignalConfidence ? "TRADE_CANDIDATE" : "WATCHLIST",
      marketId: market.id,
      conditionId: market.conditionId,
      tokenId,
      outcome,
      side: "BUY",
      confidence,
      limitPrice,
      alignedWallets,
      reason: `${alignedWallets.length} scored wallet(s) bought ${outcome}`,
      createdAt: Date.now()
    });
  }
  return signals.sort((a, b) => b.confidence - a.confidence);
}

export interface RiskState {
  openExposure: number;
  dailyPnl: number;
  lossStreak: number;
  tradesToday: number;
}

export function decideRisk(signal: TradeSignal, quality: MarketQuality, state: RiskState, config: BotConfig): RiskDecision {
  if (state.dailyPnl <= -config.maxDailyLoss) return reject("PAUSE_TRADING", "daily loss limit reached");
  if (state.lossStreak >= config.maxLossStreak) return reject("PAUSE_TRADING", "loss streak limit reached");
  if (state.tradesToday >= config.maxTradesPerDay) return reject("PAUSE_TRADING", "max trades per day reached");
  if (!quality.approved) return reject("REJECT", `market quality failed: ${quality.reasons.join("; ")}`);
  if (signal.decision !== "TRADE_CANDIDATE") return reject("REJECT", "signal is not a trade candidate");
  if (signal.confidence < config.minSignalConfidence) return reject("REJECT", "signal confidence too low");
  if (state.openExposure >= config.maxOpenExposure) return reject("REJECT", "max open exposure reached");

  const remainingExposure = Math.max(0, config.maxOpenExposure - state.openExposure);
  const confidenceSize = signal.confidence >= 91 ? config.maxPositionSize : signal.confidence >= 81 ? Math.min(4, config.maxPositionSize) : config.minPositionSize;
  const positionSize = Math.min(config.maxPositionSize, Math.max(config.minPositionSize, confidenceSize), remainingExposure);
  if (positionSize <= 0) return reject("REJECT", "no remaining exposure budget");
  return {
    decision: positionSize < confidenceSize ? "REDUCE_SIZE" : "APPROVE",
    positionSize,
    reason: "risk checks passed"
  };
}

function reject(decision: RiskDecision["decision"], reason: string): RiskDecision {
  return { decision, positionSize: 0, reason };
}

export class PaperExecutionEngine {
  createOrder(signal: TradeSignal, decision: RiskDecision, config: BotConfig): PaperOrder {
    const size = decision.positionSize / signal.limitPrice;
    const createdAt = Date.now();
    return {
      id: randomId("ord"),
      signalId: signal.id,
      marketId: signal.marketId,
      tokenId: signal.tokenId,
      outcome: signal.outcome,
      side: signal.side,
      price: signal.limitPrice,
      size,
      remainingSize: size,
      status: "OPEN",
      createdAt,
      expiresAt: createdAt + config.limitOrderTtlMs
    };
  }

  simulate(order: PaperOrder, book: OrderBookSnapshot, now = Date.now()): { order: PaperOrder; fill?: PaperFill; position?: Position } {
    if (order.status === "FILLED" || order.status === "CANCELLED") return { order };
    if (now >= order.expiresAt) return { order: { ...order, status: order.remainingSize < order.size ? "PARTIAL" : "EXPIRED" } };

    const liquidity = executableLiquidity(order.side, order.price, book);
    if (liquidity <= 0) return { order };
    const fillSize = Math.min(order.remainingSize, liquidity);
    const remainingSize = Math.max(0, order.remainingSize - fillSize);
    const updatedOrder: PaperOrder = {
      ...order,
      remainingSize,
      status: remainingSize === 0 ? "FILLED" : "PARTIAL"
    };
    const fill: PaperFill = {
      id: randomId("fill"),
      orderId: order.id,
      marketId: order.marketId,
      tokenId: order.tokenId,
      side: order.side,
      price: order.price,
      size: fillSize,
      timestamp: now
    };
    const position: Position = {
      id: `${order.marketId}:${order.tokenId}`,
      marketId: order.marketId,
      tokenId: order.tokenId,
      outcome: order.outcome,
      size: fillSize,
      avgEntryPrice: order.price,
      currentPrice: book.bestBid ?? order.price,
      realizedPnl: 0,
      openedAt: now,
      updatedAt: now,
      status: "OPEN"
    };
    return { order: updatedOrder, fill, position };
  }
}

export function decideExit(
  position: Position,
  book: OrderBookSnapshot,
  config: BotConfig,
  opts: { volumeSpike?: boolean; trackedWalletReducing?: boolean; localHighPrice?: number } = {}
): ExitDecision {
  const current = book.bestBid ?? book.lastTradePrice ?? position.currentPrice;
  const pnlPct = position.avgEntryPrice > 0 ? (current - position.avgEntryPrice) / position.avgEntryPrice : 0;
  const reasons: string[] = [];
  let probability = 0;

  if (pnlPct >= config.takeProfitPct) {
    probability += 35;
    reasons.push("take profit reached");
  }
  if (pnlPct <= -config.stopLossPct) {
    probability += 100;
    reasons.push("stop loss reached");
  }
  if ((book.spread ?? 0) >= config.spreadExitThreshold) {
    probability += 20;
    reasons.push("spread widened");
  }
  if (opts.volumeSpike) {
    probability += 20;
    reasons.push("volume spike");
  }
  if (opts.trackedWalletReducing) {
    probability += 35;
    reasons.push("tracked wallet reducing");
  }
  if (opts.localHighPrice && opts.localHighPrice > 0 && (opts.localHighPrice - current) / opts.localHighPrice >= config.priceReversalPct) {
    probability += 20;
    reasons.push("price reversed from local high");
  }
  if (book.depth < config.minOrderBookDepth) {
    probability += 15;
    reasons.push("liquidity deteriorated");
  }

  probability = Math.min(100, probability);
  return {
    decision: probability >= 85 ? "FULL_EXIT" : probability >= 55 ? "PARTIAL_EXIT" : "HOLD",
    exitProbability: probability,
    reason: reasons.length ? reasons.join("; ") : "no exit trigger"
  };
}

function tokenForOutcome(market: MarketSnapshot, outcome: string): string | undefined {
  const index = market.outcomes.findIndex((candidate) => candidate.toLowerCase() === outcome.toLowerCase());
  return index >= 0 ? market.clobTokenIds[index] : market.clobTokenIds[0];
}

function executableLiquidity(side: Side, price: number, book: OrderBookSnapshot): number {
  const levels = side === "BUY" ? book.asks.filter((level) => level.price <= price) : book.bids.filter((level) => level.price >= price);
  return levels.reduce((sum, level) => sum + level.size, 0);
}
