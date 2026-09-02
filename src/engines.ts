import { randomId } from "./db.js";
import { estimateEntryExecution, liveEntryParity, takerFeeUsd } from "./liveExecution.js";
import { categoryEligibility, signalTargetPositionSize, walletCopyPositionSize } from "./tradingPolicy.js";
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

export interface SignalDropDiagnostics {
  totalTrades: number;
  buyTrades: number;
  scoredBuyTrades: number;
  groupedMarkets: number;
  emittedSignals: number;
  tradeCandidates: number;
  watchlist: number;
  dropReasons: Record<string, number>;
  sourceRejectReasons: Record<string, number>;
}

export interface SignalGenerationResult {
  signals: TradeSignal[];
  diagnostics: SignalDropDiagnostics;
}

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
  return generateSignalsWithDiagnostics(market, books, trades, scores, config).signals;
}

export function generateSignalsWithDiagnostics(
  market: MarketSnapshot,
  books: OrderBookSnapshot[],
  trades: WalletTrade[],
  scores: WalletScore[],
  config: BotConfig
): SignalGenerationResult {
  const now = Date.now();
  const maxSourceBuyAgeMs = config.maxSourceBuyAgeMs ?? 0;
  const diagnostics = emptySignalDiagnostics();
  const marketCategory = inferMarketCategory(market);
  const categoryPolicy = categoryEligibility(marketCategory, config);
  if (!categoryPolicy.eligible) {
    addDiagnosticDrop(diagnostics, categoryPolicy.reason);
    return { signals: [], diagnostics };
  }
  const scoreByWallet = new Map(scores.map((score) => [score.wallet.toLowerCase(), score]));
  const grouped = new Map<string, WalletTrade[]>();
  for (const trade of trades) {
    diagnostics.totalTrades += 1;
    if (trade.side !== "BUY") {
      addDiagnosticDrop(diagnostics, "non-buy trade");
      continue;
    }
    diagnostics.buyTrades += 1;
    const score = scoreByWallet.get(trade.wallet.toLowerCase());
    if (!score) {
      addDiagnosticDrop(diagnostics, "wallet not scored");
      continue;
    }
    const minSourceScore = config.paperMode && (config.paperExplorationEnabled === true || config.paperProbationTradingEnabled === true)
      ? Math.min(config.minWalletScore, config.paperProbationMinWalletScore ?? config.minWalletScore)
      : config.minWalletScore;
    if (score.score < minSourceScore) {
      addDiagnosticDrop(diagnostics, "wallet score below minimum");
      continue;
    }
    diagnostics.scoredBuyTrades += 1;
    const sourceBuyAgeLimitMs = maxSourceBuyAgeForScore(score, config, maxSourceBuyAgeMs);
    if (sourceBuyAgeLimitMs > 0 && now - trade.timestamp > sourceBuyAgeLimitMs) {
      addDiagnosticDrop(diagnostics, "source buy stale");
      continue;
    }
    const sourceReject = sourceTradeRejectionReason(score, config);
    if (sourceReject && !sourceRejectAllowsPaperExploration(sourceReject, score, config)) {
      addDiagnosticDrop(diagnostics, `source rejected: ${sourceReject}`);
      diagnostics.sourceRejectReasons[sourceReject] = (diagnostics.sourceRejectReasons[sourceReject] ?? 0) + 1;
      continue;
    }
    const key = `${trade.marketId}:${trade.outcome}`;
    const list = grouped.get(key) ?? [];
    list.push(trade);
    grouped.set(key, list);
  }
  diagnostics.groupedMarkets = grouped.size;

  const signals: TradeSignal[] = [];
  for (const [key, alignedTrades] of grouped) {
    const [marketId, outcome] = key.split(":");
    if (marketId !== market.id && marketId !== market.conditionId) {
      addDiagnosticDrop(diagnostics, "group market mismatch", alignedTrades.length);
      continue;
    }
    const alignedWallets = [...new Set(alignedTrades.map((trade) => trade.wallet.toLowerCase()))];
    if (!sourceAlignmentIsTradeable(alignedWallets, scoreByWallet, marketCategory, config)) {
      addDiagnosticDrop(diagnostics, "source alignment failed", alignedTrades.length);
      continue;
    }

    const tokenId = tokenForOutcome(market, outcome) ?? alignedTrades.find((trade) => trade.tokenId)?.tokenId;
    if (!tokenId) {
      addDiagnosticDrop(diagnostics, "missing token id", alignedTrades.length);
      continue;
    }
    const book = books.find((candidate) => candidate.tokenId === tokenId);
    const limitPrice = book?.bestAsk ?? alignedTrades[alignedTrades.length - 1]?.price ?? 0;
    if (limitPrice <= 0) {
      addDiagnosticDrop(diagnostics, "missing entry price", alignedTrades.length);
      continue;
    }
    const sourceBuyTimestamp = Math.max(...alignedTrades.map((trade) => trade.timestamp));

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
    const executionConfig: BotConfig = {
      ...config,
      liveExecutionFeeRatePct: market.feesEnabled === false
        ? 0
        : market.takerFeeRate ?? config.liveExecutionFeeRatePct ?? 0
    };
    const targetPositionSizeUsd = walletCopyPositionSize(executionConfig);
    const executableEstimate = estimateEntryExecution({
      book,
      sizeUsd: targetPositionSizeUsd,
      referencePrice: limitPrice,
      config: executionConfig
    });
    const expectedLiveExecutableReturnPct = averageDefined(alignedWallets.map((wallet) =>
      scoreByWallet.get(wallet)?.liveExecutableShadowAvgReturnPct
    ));
    const sourceSellRealizedRatio = averageDefined(alignedWallets.map((wallet) =>
      scoreByWallet.get(wallet)?.sourceSellRealizedRatio
    ));
    const parity = config.liveParityGateEnabled
      ? liveEntryParity({
          estimate: executableEstimate,
          expectedReturnPct: expectedLiveExecutableReturnPct,
          sourceSellRealizedRatio,
          config: executionConfig
        })
      : { passed: true, reason: "live parity gate disabled" };
    const exploration = paperExplorationEligible({
      parityPassed: parity.passed,
      estimate: executableEstimate,
      confidence,
      sourceSellRealizedRatio,
      config
    });
    const walletLeadTradingEnabled = config.walletLeadTradingEnabled !== false;
    const parityStatus = !walletLeadTradingEnabled
      ? "FAIL"
      : config.liveParityGateEnabled ? (parity.passed ? "PASS" : exploration ? "UNKNOWN" : "FAIL") : "UNKNOWN";
    const minCandidateConfidence = exploration
      ? paperExplorationMinConfidence(config)
      : config.minSignalConfidence;
    const decision = walletLeadTradingEnabled && withinEntryBand && confidence >= minCandidateConfidence && (parity.passed || exploration)
      ? "TRADE_CANDIDATE"
      : "WATCHLIST";

    signals.push({
      id: randomId("sig"),
      decision,
      marketId: market.id,
      conditionId: market.conditionId,
      tokenId,
      outcome,
      side: "BUY",
      confidence,
      limitPrice,
      alignedWallets,
      reason: !walletLeadTradingEnabled
        ? `research lead only: ${alignedWallets.length} scored wallet(s) bought ${outcome} in ${marketCategory}; direct wallet-copy promotion is disabled`
        : parity.passed
        ? `${alignedWallets.length} scored wallet(s) bought ${outcome} in ${marketCategory}`
        : exploration
          ? `paper exploration: live gate not proven yet; ${parity.reason}`
          : `live parity failed: ${parity.reason}`,
      createdAt: now,
      sourceBuyTimestamp,
      botDetectedTimestamp: now,
      expectedEntryPrice: executableEstimate.averageFillPrice ?? limitPrice,
      expectedLiveExecutableReturnPct,
      entryBookDepth: executableEstimate.bookDepth,
      entryDepthMultiple: executableEstimate.depthMultiple,
      maxEntrySlippage: executableEstimate.slippage,
      sourceSellRealizedRatio,
      parityStatus,
      parityReason: walletLeadTradingEnabled ? parity.reason : "wallet activity is research-only; an independent strategy must pass validation",
      signalOrigin: "WALLET_LEAD",
      targetPositionSizeUsd
    });
  }
  const sorted = signals.sort((a, b) => b.confidence - a.confidence);
  diagnostics.emittedSignals = sorted.length;
  diagnostics.tradeCandidates = sorted.filter((signal) => signal.decision === "TRADE_CANDIDATE").length;
  diagnostics.watchlist = sorted.filter((signal) => signal.decision === "WATCHLIST").length;
  return { signals: sorted, diagnostics };
}

function isTradeableSource(score: WalletScore, config: BotConfig): boolean {
  return sourceTradeRejectionReason(score, config) === undefined;
}

function sourceTradeRejectionReason(score: WalletScore, config: BotConfig): string | undefined {
  if (score.flags.includes("RESEARCH_DO_NOT_COPY")) return "wallet research classified source edge as non-copyable";
  // A leaderboard research hit is an observation target, not an immediate
  // promotion. Only source-timestamped evidence from the current epoch adds the
  // durable proof flag.
  if (score.flags.includes("RESEARCH_SHADOW_ONLY") && !score.flags.includes("DURABLE_LIVE_EXECUTABLE_SHADOW")) {
    return "research directional candidate awaits forward shadow proof";
  }
  if (score.flags.includes("SHADOW_COPY_UNDERPERFORMS") || score.flags.includes("SHADOW_NEGATIVE_PNL")) return "negative shadow copy";
  if (config.blockPaperUnderperformers !== false) {
    const paperFills = score.paperFilledOrders ?? 0;
    const minPaperFills = config.minPaperFillsForTrading ?? 3;
    const minPaperPnl = config.minPaperPnlForTrading ?? -3;
    const minPaperReturn = config.minPaperAvgReturnPctForTrading ?? -0.02;
    if (paperFills >= minPaperFills && ((score.paperPnl ?? 0) <= minPaperPnl || (score.paperAvgReturnPct ?? 0) <= minPaperReturn)) {
      return "negative paper copy";
    }
    if (score.flags.includes("PAPER_COPY_UNDERPERFORMS") && paperFills >= minPaperFills) return "negative paper copy";
  }
  if (score.flags.includes("SHADOW_MOSTLY_FALLBACK_MARKS")) return "shadow edge uses fallback marks";
  if (score.flags.includes("NO_SELL_HISTORY")) return "no sell history";
  if (score.flags.includes("LIVE_EXECUTABLE_SHADOW_NEGATIVE")) return "negative live-executable shadow";
  const knownBadLiveExecSample = config.paperProbationKnownBadLiveExecTrades ?? config.minLiveExecutableShadowTradesForTrading ?? 3;
  if ((score.liveExecutableShadowSimulated ?? 0) >= knownBadLiveExecSample &&
    (score.liveExecutableShadowPnl ?? 0) <= (config.minLiveExecutableShadowPnlForTrading ?? 0)) {
    return "negative live-executable shadow";
  }
  const sourceSellRatio = score.sourceSellRealizedRatio ?? 0;
  if (score.flags.includes("LOW_SELL_HISTORY") && sourceSellRatio < (config.minSourceSellRealizedRatio ?? 0.35)) return "sell history below source-sell threshold";
  if (score.flags.includes("LOW_SOURCE_SELL_REALIZATION") && sourceSellRatio < (config.minSourceSellRealizedRatio ?? 0.35)) return "source-sell realization below threshold";
  if (score.flags.includes("LOW_LIVE_EXECUTABLE_SHADOW_RATE") && !hasLiveExecutableProof(score, config)) {
    if (isPaperProbationSource(score, config)) return undefined;
    return "live-executable proof below threshold";
  }
  if (score.flags.includes("ILLIQUID_EARLY_ENTRY_RISK")) return "illiquid early entry risk";
  if ((score.shadowSimulated ?? 0) >= 20) {
    if ((score.shadowRealized ?? 0) < Math.max(8, Math.ceil((score.shadowSimulated ?? 0) * 0.2))) return "realized shadow sample too low";
    if ((score.shadowPnl ?? 0) <= 0 || (score.shadowAvgReturnPct ?? 0) <= 0) return "shadow pnl not positive";
    if ((config.liveParityGateEnabled || score.sourceSellRealizedRatio !== undefined) &&
      (score.sourceSellRealizedRatio ?? 0) < (config.minSourceSellRealizedRatio ?? 0.35)) return "source-sell ratio below threshold";
  }
  if (!hasLiveExecutableProof(score, config)) {
    if (isPaperProbationSource(score, config)) return undefined;
    return "live-executable proof below threshold";
  }

  const isDiscoveredOrProbation =
    score.label === "discovered" ||
    score.label?.startsWith("discovered-") ||
    score.flags.includes("DISCOVERY_LOW_SCORE") ||
    score.flags.includes("WEAK_EVIDENCE");
  if (!isDiscoveredOrProbation || config.requireShadowProofForDiscovered === false) return undefined;
  if (isPaperProbationSource(score, config)) return undefined;

  const minTrades = config.minShadowTradesForPromotion ?? 20;
  const minPnl = config.minShadowPnlForPromotion ?? 0;
  const minCategoryConsistency = config.minCategoryConsistencyForPromotion ?? 55;
  const minCopyability = config.minCopyabilityForPromotion ?? config.minWalletScore;
  const simulated = score.shadowSimulated ?? 0;
  const pnl = score.shadowPnl ?? 0;
  const realized = score.shadowRealized ?? 0;
  const realizedRatio = simulated > 0 ? realized / simulated : 0;
  const proven = score.flags.includes("SHADOW_PROVEN_COPYABLE");
  const categoryOk = (score.categoryConsistencyScore ?? 0) >= minCategoryConsistency;
  const copyabilityOk = (score.copyabilityScore ?? score.score) >= minCopyability;
  const evidenceOk = (score.sampleConfidence ?? 0) >= 0.55;
  if (!proven) return "discovered source lacks proven shadow flag";
  if (simulated < minTrades) return "discovered source shadow sample too low";
  if (realizedRatio < 0.2) return "discovered source realized ratio too low";
  if (pnl <= minPnl) return "discovered source shadow pnl too low";
  if (!categoryOk) return "category consistency below promotion threshold";
  if (!copyabilityOk) return "copyability below promotion threshold";
  if (!evidenceOk) return "sample confidence below promotion threshold";
  return undefined;
}

function hasLiveExecutableProof(score: WalletScore, config: BotConfig): boolean {
  if (!config.liveParityGateEnabled) return true;
  const minTrades = config.minLiveExecutableShadowTradesForTrading ?? 8;
  const minPnl = config.minLiveExecutableShadowPnlForTrading ?? 0;
  const minReturn = config.liveExecutableMinReturnPct ?? 0.03;
  const minWinRate = config.minLiveExecutableShadowWinRateForTrading ?? 0.45;
  return (score.liveExecutableShadowSimulated ?? 0) >= minTrades &&
    (score.liveExecutableShadowPnl ?? 0) > minPnl &&
    (score.liveExecutableShadowAvgReturnPct ?? 0) > minReturn &&
    (score.liveExecutableShadowWinRate ?? 0) >= minWinRate &&
    (score.sourceSellRealizedRatio ?? 0) >= (config.minSourceSellRealizedRatio ?? 0.35);
}

function isPaperProbationSource(score: WalletScore, config: BotConfig): boolean {
  if (!config.paperMode || (config.paperProbationTradingEnabled !== true && config.paperExplorationEnabled !== true)) return false;
  if (score.flags.some((flag) => [
    "SHADOW_COPY_UNDERPERFORMS",
    "SHADOW_NEGATIVE_PNL",
    "LIVE_EXECUTABLE_SHADOW_NEGATIVE",
    "PAPER_COPY_UNDERPERFORMS",
    "SHADOW_MOSTLY_FALLBACK_MARKS",
    "NO_SELL_HISTORY",
    "ILLIQUID_EARLY_ENTRY_RISK",
    "RESEARCH_DO_NOT_COPY"
  ].includes(flag))) return false;

  const knownBadSample = config.paperProbationKnownBadLiveExecTrades ?? config.minLiveExecutableShadowTradesForTrading ?? 3;
  const liveN = score.liveExecutableShadowSimulated ?? 0;
  if (liveN >= knownBadSample && (score.liveExecutableShadowPnl ?? 0) <= (config.minLiveExecutableShadowPnlForTrading ?? 0)) return false;

  const minWalletScore = config.paperProbationMinWalletScore ?? Math.max(config.minWalletScore, 72);
  const minCopyability = config.paperProbationMinCopyabilityScore ?? Math.max(config.minCopyabilityForPromotion ?? config.minWalletScore, 70);
  const minSampleConfidence = config.paperProbationMinSampleConfidence ?? 0.55;
  const minRecentTrades = config.paperProbationMinRecentTrades ?? 1;
  if (score.score < minWalletScore) return false;
  if ((score.copyabilityScore ?? score.score) < minCopyability) return false;
  if ((score.sampleConfidence ?? 0) < minSampleConfidence) return false;
  if ((score.recentTradeCount ?? 0) < minRecentTrades) return false;

  const ratio = score.sourceSellRealizedRatio;
  const minRatio = config.paperProbationMinSourceSellRatio ?? config.paperExplorationMinSourceSellRealizedRatio ?? 0.25;
  if (ratio !== undefined && ratio < minRatio) return false;
  return true;
}

function sourceRejectAllowsPaperExploration(reason: string, score: WalletScore, config: BotConfig): boolean {
  if (reason !== "live-executable proof below threshold") return false;
  return isPaperProbationSource(score, config);
}

function maxSourceBuyAgeForScore(score: WalletScore, config: BotConfig, defaultMaxAgeMs: number): number {
  if (!isPaperProbationSource(score, config)) return defaultMaxAgeMs;
  const explorationMaxAgeMs = config.paperExplorationMaxSourceBuyAgeMs ?? defaultMaxAgeMs;
  return Math.max(defaultMaxAgeMs, explorationMaxAgeMs);
}

function paperExplorationEligible(input: {
  parityPassed: boolean;
  estimate: ReturnType<typeof estimateEntryExecution>;
  confidence: number;
  sourceSellRealizedRatio?: number;
  config: BotConfig;
}): boolean {
  if (input.parityPassed || !input.config.paperMode ||
    (input.config.paperExplorationEnabled !== true && input.config.paperProbationTradingEnabled !== true)) return false;
  const useProbationThresholds = input.config.paperProbationTradingEnabled === true;
  const minConfidence = paperExplorationMinConfidence(input.config);
  const minSourceSellRatio = useProbationThresholds
    ? input.config.paperProbationMinSourceSellRatio ?? input.config.paperExplorationMinSourceSellRealizedRatio ?? input.config.minSourceSellRealizedRatio ?? 0.35
    : input.config.paperExplorationMinSourceSellRealizedRatio ?? input.config.minSourceSellRealizedRatio ?? 0.35;
  const minDepth = useProbationThresholds
    ? input.config.paperProbationEntryDepthMultiple ?? input.config.paperExplorationEntryDepthMultiple ?? input.config.entryBookDepthMultiple ?? 3
    : input.config.paperExplorationEntryDepthMultiple ?? input.config.entryBookDepthMultiple ?? 3;
  const maxEntrySlippage = useProbationThresholds
    ? input.config.paperProbationMaxEntrySlippage ?? input.config.maxEntrySlippage ?? 0.03
    : input.config.maxEntrySlippage ?? 0.03;
  return input.confidence >= minConfidence &&
    input.estimate.executable &&
    input.estimate.depthMultiple >= minDepth &&
    input.estimate.slippage <= maxEntrySlippage &&
    (input.sourceSellRealizedRatio ?? 0) >= minSourceSellRatio;
}

function paperExplorationMinConfidence(config: BotConfig): number {
  if (config.paperProbationTradingEnabled === true) {
    return config.paperProbationMinSignalConfidence ?? config.paperExplorationMinConfidence ?? config.minSignalConfidence;
  }
  return config.paperExplorationMinConfidence ?? config.minSignalConfidence;
}

function sourceAlignmentIsTradeable(
  alignedWallets: string[],
  scoreByWallet: Map<string, WalletScore>,
  marketCategory: ReturnType<typeof inferMarketCategory>,
  config: BotConfig
): boolean {
  if (alignedWallets.length >= config.minAlignedWallets) return true;
  if (alignedWallets.length !== 1) return false;
  if (config.allowSingleSourceSignals !== true) return false;
  const score = scoreByWallet.get(alignedWallets[0]);
  if (!score) return false;
  if (isPaperProbationSource(score, config)) return true;
  const categoryImpact = score.shadowCategoryImpacts?.[marketCategory] ?? 0;
  return score.reliability === "HIGH" &&
    score.flags.includes("SHADOW_PROVEN_COPYABLE") &&
    (score.shadowRealized ?? 0) >= Math.max(10, Math.ceil((score.shadowSimulated ?? 0) * 0.25)) &&
    (score.shadowPnl ?? 0) > 0 &&
    (score.shadowAvgReturnPct ?? 0) > 0 &&
    (score.sourceSellRealizedRatio ?? 0) >= (config.minSourceSellRealizedRatio ?? 0.35) &&
    hasLiveExecutableProof(score, config) &&
    (score.copyabilityScore ?? score.score) >= Math.max(config.minWalletScore, config.minCopyabilityForPromotion ?? config.minWalletScore) &&
    categoryImpact >= 0;
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
  if (signal.signalOrigin === "INDEPENDENT_MODEL" && (config.independentModelFlatPositionSize ?? 0) > 0) {
    const requested = Math.max(config.minPositionSize, config.independentModelFlatPositionSize ?? config.minPositionSize);
    const liquidityCap = Math.max(0, signal.entryBookDepth ?? 0) * Math.max(0, Math.min(1, config.maxBookDepthPct ?? 0.1));
    const positionSize = Math.min(requested, config.maxPositionSize, remainingExposure, liquidityCap || requested);
    if (positionSize < config.minPositionSize) return reject("REJECT", "flat experiment size is below the executable minimum");
    return {
      decision: positionSize + 0.005 < requested ? "REDUCE_SIZE" : "APPROVE",
      positionSize: Math.round(positionSize * 100) / 100,
      reason: "flat prospective experiment size; model probabilities are not Kelly-calibrated",
      sizingMethod: "EXPERIMENTAL_FLAT",
      liquidityCap,
      exposureCap: Math.round(remainingExposure * 100) / 100
    };
  }
  if (signal.signalOrigin !== "INDEPENDENT_MODEL") {
    const requested = signal.targetPositionSizeUsd ?? signalTargetPositionSize(signal, config);
    const positionSize = Math.min(requested, config.maxPositionSize, remainingExposure);
    if (positionSize + 0.005 < requested) return reject("REJECT", `fixed live/shadow parity size $${requested.toFixed(2)} exceeds remaining risk capacity`);
    return {
      decision: "APPROVE",
      positionSize: Math.round(positionSize * 100) / 100,
      reason: `fixed $${positionSize.toFixed(2)} live/shadow parity size`,
      sizingMethod: "SHADOW_PARITY_FLAT",
      exposureCap: Math.round(remainingExposure * 100) / 100
    };
  }
  if (config.dynamicSizingEnabled !== false && signal.signalOrigin === "INDEPENDENT_MODEL") {
    return calculateDynamicPositionSize(signal, state, config, remainingExposure);
  }
  const confidenceSize = signal.confidence >= 91 ? config.maxPositionSize : signal.confidence >= 81 ? Math.min(4, config.maxPositionSize) : config.minPositionSize;
  const positionSize = Math.min(config.maxPositionSize, Math.max(config.minPositionSize, confidenceSize), remainingExposure);
  if (positionSize < config.minPositionSize) return reject("REJECT", "position size below minimum");
  return {
    decision: positionSize < confidenceSize ? "REDUCE_SIZE" : "APPROVE",
    positionSize,
    reason: "risk checks passed"
  };
}

export function calculateDynamicPositionSize(
  signal: TradeSignal,
  state: RiskState,
  config: BotConfig,
  remainingExposure = Math.max(0, Math.min(config.maxOpenExposure, config.bankroll * (1 - config.reserveCashPct)) - state.openExposure)
): RiskDecision {
  const probability = signal.fairProbability;
  const price = signal.marketProbability ?? signal.limitPrice;
  if (!(probability !== undefined && probability > price && price > 0 && price < 1)) {
    return reject("REJECT", "dynamic sizing requires positive model edge and valid binary price");
  }
  const fullKellyFraction = Math.max(0, Math.min(1, (probability - price) / (1 - price)));
  const fractionalKelly = fullKellyFraction * Math.max(0, Math.min(1, config.kellyFraction ?? 0.25));
  const uncertainty = Math.max(0, Math.min(1, signal.modelUncertainty ?? 1));
  const agreement = Math.max(0, Math.min(1, signal.modelAgreement ?? 0));
  const uncertaintyMultiplier = Math.max(0.15, (1 - uncertainty) * (0.5 + agreement * 0.5));
  const lossLimitUsage = state.dailyPnl < 0 ? Math.min(1, Math.abs(state.dailyPnl) / Math.max(0.01, config.maxDailyLoss)) : 0;
  const drawdownMultiplier = Math.max(0.15, (1 - lossLimitUsage * 0.75) * 0.75 ** Math.max(0, state.lossStreak));
  const bankrollCap = config.bankroll * Math.max(0, config.maxDynamicPositionPct ?? 0.05);
  const liquidityCap = Math.max(0, signal.entryBookDepth ?? 0) * Math.max(0, Math.min(1, config.maxBookDepthPct ?? 0.1));
  const desired = config.bankroll * fractionalKelly * uncertaintyMultiplier * drawdownMultiplier;
  const positionSize = Math.min(desired, bankrollCap, liquidityCap || desired, config.maxPositionSize, remainingExposure);
  if (positionSize < config.minPositionSize) {
    return {
      decision: "REJECT", positionSize: 0,
      reason: `fractional-Kelly size $${positionSize.toFixed(2)} below $${config.minPositionSize.toFixed(2)} minimum`,
      sizingMethod: "FRACTIONAL_KELLY", fullKellyFraction, fractionalKelly,
      liquidityCap, exposureCap: Math.round(remainingExposure * 100) / 100, drawdownMultiplier
    };
  }
  const capped = positionSize + 0.005 < desired;
  return {
    decision: capped ? "REDUCE_SIZE" : "APPROVE",
    positionSize: Math.round(positionSize * 100) / 100,
    reason: `fractional Kelly from ${(signal.probabilityEdge ?? 0) * 100}% probability edge; capped by bankroll, liquidity, exposure, and drawdown controls`,
    sizingMethod: "FRACTIONAL_KELLY", fullKellyFraction, fractionalKelly,
    liquidityCap, exposureCap: Math.round(remainingExposure * 100) / 100, drawdownMultiplier
  };
}

function reject(decision: RiskDecision["decision"], reason: string): RiskDecision {
  return { decision, positionSize: 0, reason };
}

export class PaperExecutionEngine {
  createOrder(signal: TradeSignal, decision: RiskDecision, config: BotConfig, tickSizeOverride?: number, feeRateOverride?: number): PaperOrder {
    const executionPolicy = config.entryOrderPolicy ?? "FAK";
    const maxSlippage = config.maxEntrySlippage ?? 0;
    const tickSize = tickSizeOverride ?? config.orderTickSize ?? 0.01;
    const price = executionPolicy === "FOK"
      ? roundOrderPrice(Math.min(0.99, signal.limitPrice + maxSlippage), tickSize, "BUY")
      : signal.limitPrice;
    const size = decision.positionSize / price;
    const createdAt = Date.now();
    return {
      id: randomId("ord"),
      signalId: signal.id,
      profile: decision.profile,
      marketId: signal.marketId,
      tokenId: signal.tokenId,
      outcome: signal.outcome,
      side: signal.side,
      price,
      size,
      remainingSize: size,
      status: "OPEN",
      createdAt,
      expiresAt: createdAt + config.limitOrderTtlMs,
      executionPolicy,
      feeRate: feeRateOverride ?? config.liveExecutionFeeRatePct ?? 0
    };
  }

  createExitOrder(position: Position, config: BotConfig, referencePrice?: number, tickSizeOverride?: number, maxSlippageOverride?: number, feeRateOverride?: number): PaperOrder {
    const executionPolicy = config.exitOrderPolicy ?? "FAK";
    const maxSlippage = maxSlippageOverride ?? config.maxExitSlippage ?? config.maxEntrySlippage ?? 0;
    const tickSize = tickSizeOverride ?? config.orderTickSize ?? 0.01;
    const anchorPrice = referencePrice ?? position.currentPrice;
    const price = roundOrderPrice(Math.max(0.01, anchorPrice - maxSlippage), tickSize, "SELL");
    const createdAt = Date.now();
    return {
      id: randomId("exit"),
      signalId: `exit:${position.id}`,
      profile: position.profile,
      marketId: position.marketId,
      tokenId: position.tokenId,
      outcome: position.outcome,
      side: "SELL",
      price,
      size: position.size,
      remainingSize: position.size,
      status: "OPEN",
      createdAt,
      expiresAt: createdAt + config.limitOrderTtlMs,
      executionPolicy,
      feeRate: feeRateOverride ?? config.liveExecutionFeeRatePct ?? 0
    };
  }

  simulate(order: PaperOrder, book: OrderBookSnapshot, now = Date.now()): { order: PaperOrder; fill?: PaperFill; position?: Position } {
    if (order.status === "FILLED" || order.status === "CANCELLED") return { order };
    if (now >= order.expiresAt) return { order: { ...order, status: order.remainingSize < order.size ? "PARTIAL" : "EXPIRED" } };

    const executable = executableFill(order.side, order.price, order.remainingSize, book);
    const policy = order.executionPolicy ?? "FAK";
    if (policy === "FOK" && executable.size < order.remainingSize) {
      return {
        order: {
          ...order,
          status: "EXPIRED",
          missedReason: executable.size > 0 ? "partial fill rejected by FOK" : "insufficient executable liquidity"
        }
      };
    }
    const liquidity = executable.size;
    if (liquidity <= 0) {
      return policy === "FAK"
        ? { order: { ...order, status: "EXPIRED", missedReason: "insufficient executable liquidity" } }
        : { order };
    }
    const fillSize = Math.min(order.remainingSize, liquidity);
    const remainingSize = policy === "FAK" ? 0 : Math.max(0, order.remainingSize - fillSize);
    const updatedOrder: PaperOrder = {
      ...order,
      remainingSize,
      status: fillSize < order.remainingSize ? "PARTIAL" : "FILLED",
      partialFillReason: fillSize < order.remainingSize ? "unfilled remainder cancelled by FAK" : order.partialFillReason
    };
    const fill: PaperFill = {
      id: randomId("fill"),
      orderId: order.id,
      marketId: order.marketId,
      tokenId: order.tokenId,
      side: order.side,
      price: executable.averagePrice ?? order.price,
      size: fillSize,
      feeUsd: takerFeeUsd(fillSize, executable.averagePrice ?? order.price, order.feeRate ?? 0),
      timestamp: now
    };
    const position: Position = {
      // One immutable position row per entry order. Deterministic market/token IDs
      // overwrote earlier round trips on re-entry and corrupted cumulative PnL.
      id: `${order.profile ?? "Shared"}:${order.marketId}:${order.tokenId}:${order.id}`,
      profile: order.profile,
      marketId: order.marketId,
      tokenId: order.tokenId,
      outcome: order.outcome,
      size: fillSize,
      avgEntryPrice: executable.averagePrice ?? order.price,
      currentPrice: book.bestBid ?? order.price,
      realizedPnl: -(fill.feeUsd ?? 0),
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
  const hasExecutableBid = book.bestBid !== undefined;
  const current = hasExecutableBid ? book.bestBid! : 0;
  // Prediction-market prices are probabilities: a fixed *relative* stop is a
  // fraction of a cent on a 0.05 longshot but a huge move on a 0.90 favorite,
  // so noise stops every cheap position out. Use an absolute probability move.
  const priceMove = current - position.avgEntryPrice;
  const takeProfitMove = config.takeProfitAbs ?? position.avgEntryPrice * config.takeProfitPct;
  const stopLossMove = config.stopLossAbs ?? position.avgEntryPrice * config.stopLossPct;
  const pnlPct = position.avgEntryPrice > 0 ? priceMove / position.avgEntryPrice : 0;
  const reasons: string[] = [];
  let probability = 0;

  if (!hasExecutableBid) {
    probability += 100;
    reasons.push("no executable bid");
  }
  if (priceMove >= takeProfitMove) {
    probability += 85;
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

function executableFill(side: Side, price: number, shares: number, book: OrderBookSnapshot): { size: number; averagePrice?: number } {
  const levels = side === "BUY"
    ? book.asks.filter((level) => level.price <= price).sort((a, b) => a.price - b.price)
    : book.bids.filter((level) => level.price >= price).sort((a, b) => b.price - a.price);
  let remaining = shares;
  let filled = 0;
  let notional = 0;
  for (const level of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, level.size);
    filled += take;
    notional += take * level.price;
    remaining -= take;
  }
  return { size: filled, averagePrice: filled > 0 ? notional / filled : undefined };
}

function averageDefined(values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined && Number.isFinite(value));
  return defined.length > 0 ? defined.reduce((sum, value) => sum + value, 0) / defined.length : undefined;
}

function emptySignalDiagnostics(): SignalDropDiagnostics {
  return {
    totalTrades: 0,
    buyTrades: 0,
    scoredBuyTrades: 0,
    groupedMarkets: 0,
    emittedSignals: 0,
    tradeCandidates: 0,
    watchlist: 0,
    dropReasons: {},
    sourceRejectReasons: {}
  };
}

function addDiagnosticDrop(diagnostics: SignalDropDiagnostics, reason: string, count = 1): void {
  diagnostics.dropReasons[reason] = (diagnostics.dropReasons[reason] ?? 0) + count;
}

function roundOrderPrice(price: number, tickSize: number, side: Side): number {
  if (!(tickSize > 0)) return price;
  const ticks = side === "BUY" ? Math.ceil(price / tickSize) : Math.floor(price / tickSize);
  return Math.max(0.01, Math.min(0.99, Number((ticks * tickSize).toFixed(4))));
}
