import { randomId } from "./db.js";
import { applyPaperPerformanceToScore, applyShadowPerformanceToScore, calculateShadowScoreImpact, discoverWallets, inferMarketCategory, scoreDiscoveredWallet, scoreWallet } from "./walletIntelligence.js";
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

export { applyPaperPerformanceToScore, applyShadowPerformanceToScore, calculateShadowScoreImpact, discoverWallets, inferMarketCategory, scoreDiscoveredWallet, scoreWallet };

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
    if (Number.isFinite(hours) && config.maxTimeToResolutionHours > 0 && hours > config.maxTimeToResolutionHours) {
      reasons.push(`too far from resolution; capital lockup risk (${Math.round(hours)}h)`);
    }
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
    if (!isTradeableSource(score, config)) continue;
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

    const marketCategory = inferMarketCategory(market);
    const walletComponent = Math.min(40, alignedWallets.length * 20);
    const scoreComponent = Math.min(
      35,
      alignedWallets.reduce((sum, wallet) => sum + (scoreByWallet.get(wallet)?.score ?? 0), 0) / alignedWallets.length * 0.35
    );
    // Prefer mid-priced outcomes symmetrically: extreme longshots are noise-dominated
    // and extreme favorites have terrible asymmetry (risk a dollar to make a cent).
    const priceComponent = Math.max(0, 25 - Math.abs(limitPrice - 0.5) * 40);
    const categoryShadowComponent = alignedWallets.reduce((sum, wallet) => {
      const impact = scoreByWallet.get(wallet)?.shadowCategoryImpacts?.[marketCategory] ?? 0;
      return sum + Math.max(-8, Math.min(8, impact));
    }, 0) / alignedWallets.length;
    const confidence = Math.round(Math.min(100, Math.max(0, walletComponent + scoreComponent + priceComponent + categoryShadowComponent)));

    // Hard price band: below/above these the copy has no realistic edge, so it can
    // watchlist but never becomes a tradable candidate regardless of confidence.
    const minEntryPrice = config.minEntryPrice ?? 0.08;
    const maxEntryPrice = config.maxEntryPrice ?? 0.92;
    const withinEntryBand = limitPrice >= minEntryPrice && limitPrice <= maxEntryPrice;

    signals.push({
      id: randomId("sig"),
      decision: withinEntryBand && confidence >= config.minSignalConfidence ? "TRADE_CANDIDATE" : "WATCHLIST",
      marketId: market.id,
      conditionId: market.conditionId,
      tokenId,
      outcome,
      side: "BUY",
      confidence,
      limitPrice,
      alignedWallets,
      reason: `${alignedWallets.length} scored wallet(s) bought ${outcome} in ${marketCategory}`,
      createdAt: Date.now()
    });
  }
  return signals.sort((a, b) => b.confidence - a.confidence);
}

function isTradeableSource(score: WalletScore, config: BotConfig): boolean {
  if (score.flags.includes("SHADOW_COPY_UNDERPERFORMS") || score.flags.includes("SHADOW_NEGATIVE_PNL")) return false;
  if (score.flags.includes("SHADOW_MOSTLY_FALLBACK_MARKS")) return false;
  if (score.flags.includes("NO_SELL_HISTORY") || score.flags.includes("LOW_SELL_HISTORY")) return false;
  if (score.flags.includes("ILLIQUID_EARLY_ENTRY_RISK")) return false;

  const isDiscoveredOrProbation =
    score.label === "discovered" ||
    score.label?.startsWith("discovered-") ||
    score.flags.includes("DISCOVERY_LOW_SCORE") ||
    score.flags.includes("WEAK_EVIDENCE");
  if (!isDiscoveredOrProbation || config.requireShadowProofForDiscovered === false) return true;

  const minTrades = config.minShadowTradesForPromotion ?? 20;
  const minPnl = config.minShadowPnlForPromotion ?? 0;
  const minCategoryConsistency = config.minCategoryConsistencyForPromotion ?? 55;
  const minCopyability = config.minCopyabilityForPromotion ?? config.minWalletScore;
  const simulated = score.shadowSimulated ?? 0;
  const pnl = score.shadowPnl ?? 0;
  const realized = score.shadowRealized ?? 0;
  const proven = score.flags.includes("SHADOW_PROVEN_COPYABLE");
  const categoryOk = (score.categoryConsistencyScore ?? 0) >= minCategoryConsistency;
  const copyabilityOk = (score.copyabilityScore ?? score.score) >= minCopyability;
  const evidenceOk = (score.sampleConfidence ?? 0) >= 0.55;
  return proven && simulated >= minTrades && realized > 0 && pnl > minPnl && categoryOk && copyabilityOk && evidenceOk;
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

  const reserveProtectedCap = config.bankroll * (1 - config.reserveCashPct);
  const activeExposureCap = Math.min(config.maxOpenExposure, reserveProtectedCap);
  if (state.openExposure >= activeExposureCap) return reject("REJECT", "reserve cash protected");

  const remainingExposure = Math.max(0, activeExposureCap - state.openExposure);
  if (remainingExposure < config.minPositionSize) return reject("REJECT", "remaining exposure below minimum position size");
  const confidenceSize = signal.confidence >= 91 ? config.maxPositionSize : signal.confidence >= 81 ? Math.min(4, config.maxPositionSize) : config.minPositionSize;
  const positionSize = Math.min(config.maxPositionSize, Math.max(config.minPositionSize, confidenceSize), remainingExposure);
  if (positionSize < config.minPositionSize) return reject("REJECT", "position size below minimum");
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
      profile: decision.profile,
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
      id: `${order.profile ?? "Shared"}:${order.marketId}:${order.tokenId}`,
      profile: order.profile,
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
  opts: { volumeSpike?: boolean; trackedWalletReducing?: boolean; sourceSellerCount?: number; sourceCount?: number; localHighPrice?: number } = {}
): ExitDecision {
  const current = book.bestBid ?? book.lastTradePrice ?? position.currentPrice;
  // Prediction-market prices are probabilities: a fixed *relative* stop is a
  // fraction of a cent on a 0.05 longshot but a huge move on a 0.90 favorite,
  // so noise stops every cheap position out. Use an absolute probability move.
  const priceMove = current - position.avgEntryPrice;
  const takeProfitMove = config.takeProfitAbs ?? position.avgEntryPrice * config.takeProfitPct;
  const stopLossMove = config.stopLossAbs ?? position.avgEntryPrice * config.stopLossPct;
  const pnlPct = position.avgEntryPrice > 0 ? priceMove / position.avgEntryPrice : 0;
  const reasons: string[] = [];
  let probability = 0;

  if (priceMove >= takeProfitMove) {
    probability += 35;
    reasons.push("take profit reached");
  }
  if (priceMove <= -stopLossMove) {
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
    // The seeding source wallet is selling the same outcome. The shadow-copy
    // backtest shows this is the profitable moment to exit, so follow it out
    // decisively rather than waiting for a price-based trigger.
    const sellerCount = opts.sourceSellerCount ?? 1;
    const sourceCount = Math.max(1, opts.sourceCount ?? sellerCount);
    const sellerRatio = sellerCount / sourceCount;
    probability += sellerCount >= 2 || sellerRatio >= 0.5 ? 100 : 85;
    reasons.push(sellerCount >= 2 ? `${sellerCount} source wallets exiting` : "source wallet exiting");
  }
  if (opts.localHighPrice && opts.localHighPrice > 0 && (opts.localHighPrice - current) / opts.localHighPrice >= config.priceReversalPct) {
    probability += 20;
    reasons.push("price reversed from local high");
  }
  if (config.maxPositionHoldHours > 0) {
    const holdHours = (Date.now() - position.openedAt) / 3_600_000;
    if (holdHours >= config.maxPositionHoldHours) {
      probability += 85;
      reasons.push("max hold time reached");
    } else if (holdHours >= config.maxPositionHoldHours * 0.5 && pnlPct < 0) {
      probability += 25;
      reasons.push("aging loser");
    }
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
