import type {
  BotConfig,
  DiscoveredWallet,
  MarketCategory,
  MarketSnapshot,
  PaperSourcePerformance,
  ShadowWalletPerformance,
  TrackedWallet,
  WalletPosition,
  WalletScore,
  WalletTrade
} from "./types.js";

interface WalletPerformance {
  realizedPnlApprox: number;
  profitFactorApprox: number;
  winRateApprox: number;
  avgReturnPctApprox: number;
  maxDrawdownApprox: number;
  avgHoldMinutesApprox: number;
  closedTradeCount: number;
  wins: number;
}

export function applyShadowPerformanceToScore(score: WalletScore, performance?: ShadowWalletPerformance): WalletScore {
  if (!performance || performance.simulated === 0) return score;
  const impact = calculateShadowScoreImpact(performance);
  const flags = [...score.flags];
  if (performance.simulated < 10) flags.push("SHADOW_LOW_SAMPLE");
  if (performance.fallback / performance.simulated > 0.75) flags.push("SHADOW_MOSTLY_FALLBACK_MARKS");
  if (impact <= -6) flags.push("SHADOW_COPY_UNDERPERFORMS");
  if (impact >= 6) flags.push("SHADOW_COPY_OUTPERFORMS");
  const adjustedScore = Math.round(clamp(score.score + impact, 0, 100));
  const adjustedCopyability = score.copyabilityScore === undefined
    ? undefined
    : Math.round(clamp(score.copyabilityScore + impact * 1.15, 0, 100));
  return {
    ...score,
    score: adjustedScore,
    copyabilityScore: adjustedCopyability,
    reliability: adjustedScore >= 70 && (score.sampleConfidence ?? 0) >= 0.65 ? "HIGH" : adjustedScore >= 55 ? "MEDIUM" : "LOW",
    flags,
    shadowTradeCount: performance.total,
    shadowSimulated: performance.simulated,
    shadowRealized: performance.realized,
    shadowPnl: performance.pnl,
    shadowAvgReturnPct: performance.avgReturnPct,
    shadowWinRate: performance.winRate,
    shadowScoreImpact: impact
  };
}

export function applyPaperPerformanceToScore(score: WalletScore, performance?: PaperSourcePerformance): WalletScore {
  if (!performance || performance.filledOrders === 0 || performance.scoreImpact === 0) return score;
  const flags = [...score.flags];
  if (performance.filledOrders < 10) flags.push("PAPER_LOW_SAMPLE");
  if (performance.scoreImpact <= -3) flags.push("PAPER_COPY_UNDERPERFORMS");
  if (performance.scoreImpact >= 3) flags.push("PAPER_COPY_OUTPERFORMS");
  const adjustedScore = Math.round(clamp(score.score + performance.scoreImpact, 0, 100));
  const adjustedCopyability = score.copyabilityScore === undefined
    ? undefined
    : Math.round(clamp(score.copyabilityScore + performance.scoreImpact * 1.2, 0, 100));
  return {
    ...score,
    score: adjustedScore,
    copyabilityScore: adjustedCopyability,
    reliability: adjustedScore >= 70 && (score.sampleConfidence ?? 0) >= 0.65 ? "HIGH" : adjustedScore >= 55 ? "MEDIUM" : "LOW",
    flags
  };
}

interface CategoryProfile {
  category: MarketCategory;
  tradeCount: number;
  uniqueMarkets: number;
  volume: number;
  performance: WalletPerformance;
  score: number;
}

export function discoverWallets(
  trades: WalletTrade[],
  config: BotConfig,
  now = Date.now(),
  positions: WalletPosition[] = [],
  markets: MarketSnapshot[] = []
): DiscoveredWallet[] {
  const categoryByMarket = buildCategoryIndex(markets);
  const resolutionByMarket = buildResolutionIndex(markets);
  const positionsByWallet = new Map<string, WalletPosition[]>();
  for (const position of positions) {
    const list = positionsByWallet.get(position.wallet) ?? [];
    list.push(position);
    positionsByWallet.set(position.wallet, list);
  }

  const byWallet = new Map<string, WalletTrade[]>();
  for (const trade of trades) {
    const list = byWallet.get(trade.wallet) ?? [];
    list.push(trade);
    byWallet.set(trade.wallet, list);
  }

  const discovered: DiscoveredWallet[] = [];
  for (const [address, walletTrades] of byWallet) {
    const sorted = [...walletTrades].sort((a, b) => a.timestamp - b.timestamp);
    const walletPositions = positionsByWallet.get(address) ?? [];
    const tradeCount = sorted.length;
    const totalVolume = sorted.reduce((sum, trade) => sum + trade.price * trade.size, 0);
    const uniqueMarkets = new Set(sorted.map((trade) => trade.marketId)).size;
    const buyCount = sorted.filter((trade) => trade.side === "BUY").length;
    const sellCount = sorted.filter((trade) => trade.side === "SELL").length;
    const performance = analyzeWalletPerformance(sorted);
    const resolvedStats = analyzeResolvedOutcomes(sorted, resolutionByMarket);
    const categoryProfiles = buildCategoryProfiles(sorted, categoryByMarket);
    const dominantProfile = categoryProfiles[0] ?? {
      category: "other" as MarketCategory,
      tradeCount: 0,
      uniqueMarkets: 0,
      volume: 0,
      performance: emptyPerformance(),
      score: 0
    };
    const recentTrades = sorted.filter((trade) => now - trade.timestamp <= 24 * 60 * 60 * 1000);
    const recentVolume = recentTrades.reduce((sum, trade) => sum + trade.price * trade.size, 0);
    const sampleConfidence = sampleConfidenceFor(tradeCount, performance.closedTradeCount);
    const exitBehaviorScore = scoreExitBehavior(sellCount, buyCount, performance.avgHoldMinutesApprox);
    const hotScore = scoreHotness(recentTrades.length, recentVolume, sorted[sorted.length - 1]?.timestamp ?? now, now);
    const flags = buildWalletFlags({
      tradeCount,
      totalVolume,
      uniqueMarkets,
      sellCount,
      performance,
      walletPositions,
      sampleConfidence,
      dominantProfile
    }, config);

    const overallScore = capByEvidence(scoreOverallReputation({
      tradeCount,
      totalVolume,
      uniqueMarkets,
      performance,
      sampleConfidence,
      exitBehaviorScore
    }), tradeCount, performance.closedTradeCount, sellCount);

    const copyabilityScore = Math.round(clamp(
      overallScore * 0.35 +
      dominantProfile.score * 0.35 +
      hotScore * 0.15 +
      exitBehaviorScore * 0.15 -
      copyabilityPenalty(flags, performance),
      0,
      100
    ));

    discovered.push({
      address,
      score: Math.round(overallScore),
      copyabilityScore,
      hotScore,
      categoryConsistencyScore: dominantProfile.score,
      exitBehaviorScore,
      sampleConfidence,
      dominantCategory: dominantProfile.category,
      tradeCount,
      buyCount,
      sellCount,
      uniqueMarkets,
      totalVolume,
      avgTradeSize: tradeCount > 0 ? totalVolume / tradeCount : 0,
      realizedPnlApprox: performance.realizedPnlApprox,
      profitFactorApprox: performance.profitFactorApprox,
      winRateApprox: performance.winRateApprox,
      avgReturnPctApprox: performance.avgReturnPctApprox,
      maxDrawdownApprox: performance.maxDrawdownApprox,
      avgHoldMinutesApprox: performance.avgHoldMinutesApprox,
      openPositionCount: walletPositions.length,
      openPositionValue: walletPositions.reduce((sum, position) => sum + position.currentValue, 0),
      openPositionPnlApprox: walletPositions.reduce((sum, position) => sum + position.cashPnl, 0),
      resolvedMarkets: resolvedStats.resolvedMarkets,
      resolvedWins: resolvedStats.resolvedWins,
      resolvedLosses: resolvedStats.resolvedLosses,
      resolvedWinRate: resolvedStats.resolvedWinRate,
      flags,
      firstSeenAt: sorted[0]?.timestamp ?? now,
      lastSeenAt: sorted[sorted.length - 1]?.timestamp ?? now
    });
  }

  return discovered
    .filter((wallet) => wallet.tradeCount >= config.minDiscoveryTrades && wallet.totalVolume >= config.minDiscoveryVolume)
    .sort((a, b) =>
      b.copyabilityScore - a.copyabilityScore ||
      b.categoryConsistencyScore - a.categoryConsistencyScore ||
      b.hotScore - a.hotScore ||
      b.totalVolume - a.totalVolume
    )
    .slice(0, config.maxDiscoveredWallets);
}

export function scoreWallet(wallet: TrackedWallet, trades: WalletTrade[], now = Date.now(), markets: MarketSnapshot[] = []): WalletScore {
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const recentTradeCount = trades.filter((trade) => trade.timestamp >= dayAgo).length;
  const tradeCount = trades.length;
  const uniqueMarkets = new Set(trades.map((trade) => trade.marketId)).size;
  const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp);
  const categoryProfiles = buildCategoryProfiles(sorted, buildCategoryIndex(markets));
  const dominantProfile = categoryProfiles[0];
  const resolvedStats = analyzeResolvedOutcomes(sorted, buildResolutionIndex(markets));
  const performance = analyzeWalletPerformance(sorted);
  const sampleConfidence = sampleConfidenceFor(tradeCount, performance.closedTradeCount);
  const recentTrades = sorted.filter((trade) => now - trade.timestamp <= 24 * 60 * 60 * 1000);
  const recentVolume = recentTrades.reduce((sum, trade) => sum + trade.price * trade.size, 0);
  const hotScore = scoreHotness(recentTrades.length, recentVolume, sorted[sorted.length - 1]?.timestamp ?? now, now);
  const exitBehaviorScore = scoreExitBehavior(
    trades.filter((trade) => trade.side === "SELL").length,
    trades.filter((trade) => trade.side === "BUY").length,
    performance.avgHoldMinutesApprox
  );
  const flags: string[] = [];
  if (tradeCount < 5) flags.push("LOW_SAMPLE");
  if (performance.closedTradeCount < 3) flags.push("LOW_CLOSED_SAMPLE");
  if (uniqueMarkets <= 1 && tradeCount > 5) flags.push("CONCENTRATED");
  if (recentTradeCount === 0) flags.push("STALE");
  if (performance.maxDrawdownApprox > 0.25) flags.push("HIGH_DRAWDOWN");

  const score = capByEvidence(scoreOverallReputation({
    tradeCount,
    totalVolume: trades.reduce((sum, trade) => sum + trade.price * trade.size, 0),
    uniqueMarkets,
    performance,
    sampleConfidence,
    exitBehaviorScore
  }), tradeCount, performance.closedTradeCount, trades.filter((trade) => trade.side === "SELL").length);

  return {
    wallet: wallet.address.toLowerCase(),
    label: wallet.label,
    score: Math.max(0, Math.min(100, Math.round(score))),
    copyabilityScore: Math.round(clamp(score * 0.5 + (dominantProfile?.score ?? 0) * 0.25 + hotScore * 0.1 + exitBehaviorScore * 0.15, 0, 100)),
    hotScore,
    categoryConsistencyScore: dominantProfile?.score,
    dominantCategory: dominantProfile?.category,
    sampleConfidence,
    resolvedMarkets: resolvedStats.resolvedMarkets,
    resolvedWins: resolvedStats.resolvedWins,
    resolvedLosses: resolvedStats.resolvedLosses,
    resolvedWinRate: resolvedStats.resolvedWinRate,
    tradeCount,
    recentTradeCount,
    reliability: score >= 70 && sampleConfidence >= 0.65 ? "HIGH" : score >= 55 ? "MEDIUM" : "LOW",
    flags,
    updatedAt: now
  };
}

export function scoreDiscoveredWallet(wallet: DiscoveredWallet, now = Date.now()): WalletScore {
  const flags = [...wallet.flags];
  if (wallet.score < 60) flags.push("DISCOVERY_LOW_SCORE");
  if (wallet.sampleConfidence < 0.55) flags.push("WEAK_EVIDENCE");
  return {
    wallet: wallet.address,
    label: "discovered",
    score: wallet.copyabilityScore,
    copyabilityScore: wallet.copyabilityScore,
    hotScore: wallet.hotScore,
    categoryConsistencyScore: wallet.categoryConsistencyScore,
    sampleConfidence: wallet.sampleConfidence,
    dominantCategory: wallet.dominantCategory,
    resolvedMarkets: wallet.resolvedMarkets,
    resolvedWins: wallet.resolvedWins,
    resolvedLosses: wallet.resolvedLosses,
    resolvedWinRate: wallet.resolvedWinRate,
    tradeCount: wallet.tradeCount,
    recentTradeCount: 0,
    reliability: wallet.copyabilityScore >= 70 && wallet.sampleConfidence >= 0.65 ? "HIGH" : wallet.copyabilityScore >= 55 ? "MEDIUM" : "LOW",
    flags,
    updatedAt: now
  };
}

function buildWalletFlags(input: {
  tradeCount: number;
  totalVolume: number;
  uniqueMarkets: number;
  sellCount: number;
  performance: WalletPerformance;
  walletPositions: WalletPosition[];
  sampleConfidence: number;
  dominantProfile: CategoryProfile;
}, config: BotConfig): string[] {
  const flags: string[] = [];
  if (input.tradeCount < config.minDiscoveryTrades) flags.push("LOW_TRADE_COUNT");
  if (input.tradeCount < 20) flags.push("UNDER_MIN_CATEGORY_SAMPLE");
  if (input.performance.closedTradeCount < 5) flags.push("LOW_CLOSED_SAMPLE");
  if (input.totalVolume < config.minDiscoveryVolume) flags.push("LOW_VOLUME");
  if (input.uniqueMarkets <= 1 && input.tradeCount >= config.minDiscoveryTrades) flags.push("SINGLE_MARKET");
  if (input.sellCount === 0) flags.push("NO_SELL_HISTORY");
  if (input.performance.realizedPnlApprox < 0) flags.push("NEGATIVE_REALIZED_APPROX");
  if (input.walletPositions.length === 0) flags.push("NO_OPEN_POSITION_PREVIEW");
  if (input.performance.avgHoldMinutesApprox < 1 && input.sellCount > 0) flags.push("VERY_FAST_TRADER");
  if (input.performance.maxDrawdownApprox > 0.25) flags.push("HIGH_DRAWDOWN");
  if (input.sampleConfidence < 0.5) flags.push("WEAK_EVIDENCE");
  if (input.dominantProfile.score < 50) flags.push("WEAK_CATEGORY_EDGE");
  return flags;
}

function buildCategoryProfiles(trades: WalletTrade[], categoryByMarket: Map<string, MarketCategory>): CategoryProfile[] {
  const byCategory = new Map<MarketCategory, WalletTrade[]>();
  for (const trade of trades) {
    const category = categoryByMarket.get(trade.marketId) ?? categoryByMarket.get(trade.conditionId ?? "") ?? "other";
    const list = byCategory.get(category) ?? [];
    list.push(trade);
    byCategory.set(category, list);
  }
  return [...byCategory.entries()].map(([category, categoryTrades]) => {
    const performance = analyzeWalletPerformance(categoryTrades);
    const tradeCount = categoryTrades.length;
    const uniqueMarkets = new Set(categoryTrades.map((trade) => trade.marketId)).size;
    const volume = categoryTrades.reduce((sum, trade) => sum + trade.price * trade.size, 0);
    return {
      category,
      tradeCount,
      uniqueMarkets,
      volume,
      performance,
      score: scoreCategoryConsistency(tradeCount, uniqueMarkets, performance)
    };
  }).sort((a, b) => b.score - a.score || b.volume - a.volume);
}

function scoreOverallReputation(input: {
  tradeCount: number;
  totalVolume: number;
  uniqueMarkets: number;
  performance: WalletPerformance;
  sampleConfidence: number;
  exitBehaviorScore: number;
}): number {
  const winLowerBound = wilsonLowerBound(input.performance.wins, input.performance.closedTradeCount);
  const sampleScore = input.sampleConfidence * 22;
  const breadthScore = clamp(input.uniqueMarkets / 8, 0, 1) * 12;
  const volumeScore = clamp(Math.log10(Math.max(1, input.totalVolume)) / 5, 0, 1) * 10;
  const returnScore = clamp((input.performance.avgReturnPctApprox + 0.12) / 0.35, 0, 1) * 18;
  const winScore = winLowerBound * 14;
  const profitFactorScore = clamp(input.performance.profitFactorApprox / 3, 0, 1) * 12;
  const drawdownPenalty = clamp(input.performance.maxDrawdownApprox / 0.35, 0, 1) * 18;
  return clamp(sampleScore + breadthScore + volumeScore + returnScore + winScore + profitFactorScore + input.exitBehaviorScore * 0.12 - drawdownPenalty, 0, 100);
}

function scoreCategoryConsistency(tradeCount: number, uniqueMarkets: number, performance: WalletPerformance): number {
  const categorySample = clamp((tradeCount - 5) / 25, 0, 1);
  const closedSample = clamp(performance.closedTradeCount / 12, 0, 1);
  const breadth = clamp(uniqueMarkets / 6, 0, 1);
  const winLowerBound = wilsonLowerBound(performance.wins, performance.closedTradeCount);
  const returnQuality = clamp((performance.avgReturnPctApprox + 0.08) / 0.28, 0, 1);
  const profitFactor = clamp(performance.profitFactorApprox / 2.5, 0, 1);
  const drawdownPenalty = clamp(performance.maxDrawdownApprox / 0.3, 0, 1) * 18;
  const raw = categorySample * 24 + closedSample * 18 + breadth * 12 + winLowerBound * 18 + returnQuality * 18 + profitFactor * 10 - drawdownPenalty;
  const cap = tradeCount < 20 ? 74 : performance.closedTradeCount < 5 ? 68 : 100;
  return Math.round(clamp(raw, 0, cap));
}

function scoreHotness(recentTradeCount: number, recentVolume: number, lastSeenAt: number, now: number): number {
  const hoursSinceLastTrade = Math.max(0, (now - lastSeenAt) / 3_600_000);
  const activity = clamp(recentTradeCount / 12, 0, 1) * 45;
  const volume = clamp(Math.log10(Math.max(1, recentVolume)) / 4, 0, 1) * 35;
  const recency = clamp(1 - hoursSinceLastTrade / 24, 0, 1) * 20;
  return Math.round(activity + volume + recency);
}

function scoreExitBehavior(sellCount: number, buyCount: number, avgHoldMinutes: number): number {
  if (buyCount === 0) return 0;
  const sellRatio = clamp(sellCount / buyCount, 0, 1);
  const holdScore = avgHoldMinutes <= 0 ? 35 : clamp((avgHoldMinutes - 5) / 240, 0, 1) * 35;
  return Math.round(sellRatio * 65 + holdScore);
}

function sampleConfidenceFor(tradeCount: number, closedTradeCount: number): number {
  const tradeEvidence = clamp((tradeCount - 3) / 27, 0, 1);
  const closedEvidence = clamp(closedTradeCount / 12, 0, 1);
  return Number((tradeEvidence * 0.55 + closedEvidence * 0.45).toFixed(3));
}

function capByEvidence(score: number, tradeCount: number, closedTradeCount: number, sellCount: number): number {
  let cap = 100;
  if (tradeCount < 5) cap = Math.min(cap, 45);
  else if (tradeCount < 10) cap = Math.min(cap, 58);
  else if (tradeCount < 20) cap = Math.min(cap, 72);
  if (closedTradeCount < 3) cap = Math.min(cap, 62);
  if (sellCount === 0) cap = Math.min(cap, 60);
  return clamp(score, 0, cap);
}

function copyabilityPenalty(flags: string[], performance: WalletPerformance): number {
  let penalty = 0;
  if (flags.includes("SINGLE_MARKET")) penalty += 8;
  if (flags.includes("NO_SELL_HISTORY")) penalty += 12;
  if (flags.includes("VERY_FAST_TRADER")) penalty += 12;
  if (flags.includes("HIGH_DRAWDOWN")) penalty += 10;
  if (flags.includes("WEAK_EVIDENCE")) penalty += 8;
  penalty += Math.max(0, 20 - performance.avgHoldMinutesApprox) * 0.2;
  return penalty;
}

export function calculateShadowScoreImpact(performance: ShadowWalletPerformance): number {
  const sampleWeight = clamp(performance.simulated / 25, 0, 1);
  const realizedWeight = clamp(performance.realized / 10, 0, 1);
  const fallbackRatio = performance.simulated > 0 ? performance.fallback / performance.simulated : 0;
  const markQuality = 1 - fallbackRatio * 0.6;
  const allTradeReturn = clamp(performance.avgReturnPct / 0.08, -1, 1) * 7 * sampleWeight * markQuality;
  const realizedReturn = clamp(performance.realizedAvgReturnPct / 0.1, -1, 1) * 6 * realizedWeight;
  const winRateTilt = clamp((performance.winRate - 0.5) / 0.35, -1, 1) * 3 * sampleWeight;
  return Math.round(clamp(allTradeReturn + realizedReturn + winRateTilt, -15, 15));
}

function analyzeWalletPerformance(trades: WalletTrade[]): WalletPerformance {
  const lots = new Map<string, { size: number; cost: number; openedAt: number }>();
  const closedReturns: number[] = [];
  const holdMinutes: number[] = [];
  let pnl = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let equity = 0;
  let peakEquity = 0;
  let maxDrawdown = 0;

  for (const trade of trades) {
    const key = `${trade.marketId}:${trade.outcome}`;
    const lot = lots.get(key) ?? { size: 0, cost: 0, openedAt: trade.timestamp };
    if (trade.side === "BUY") {
      if (lot.size <= 0) lot.openedAt = trade.timestamp;
      lot.size += trade.size;
      lot.cost += trade.price * trade.size;
      lots.set(key, lot);
      continue;
    }
    if (lot.size <= 0) continue;
    const sold = Math.min(lot.size, trade.size);
    const avgCost = lot.cost / lot.size;
    const tradePnl = (trade.price - avgCost) * sold;
    const returnPct = avgCost > 0 ? (trade.price - avgCost) / avgCost : 0;
    pnl += tradePnl;
    equity += tradePnl;
    peakEquity = Math.max(peakEquity, equity);
    if (peakEquity > 0) maxDrawdown = Math.max(maxDrawdown, (peakEquity - equity) / peakEquity);
    if (tradePnl >= 0) grossProfit += tradePnl;
    else grossLoss += Math.abs(tradePnl);
    closedReturns.push(returnPct);
    holdMinutes.push(Math.max(0, (trade.timestamp - lot.openedAt) / 60000));
    lot.size -= sold;
    lot.cost = Math.max(0, lot.cost - avgCost * sold);
    if (lot.size <= 0) lot.openedAt = trade.timestamp;
    lots.set(key, lot);
  }

  const wins = closedReturns.filter((value) => value > 0).length;
  return {
    realizedPnlApprox: pnl,
    profitFactorApprox: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? grossProfit : 0,
    winRateApprox: closedReturns.length > 0 ? wins / closedReturns.length : 0,
    avgReturnPctApprox: closedReturns.length > 0 ? closedReturns.reduce((sum, value) => sum + value, 0) / closedReturns.length : 0,
    maxDrawdownApprox: maxDrawdown,
    avgHoldMinutesApprox: holdMinutes.length > 0 ? holdMinutes.reduce((sum, value) => sum + value, 0) / holdMinutes.length : 0,
    closedTradeCount: closedReturns.length,
    wins
  };
}

function buildCategoryIndex(markets: MarketSnapshot[]): Map<string, MarketCategory> {
  const index = new Map<string, MarketCategory>();
  for (const market of markets) {
    const category = inferMarketCategory(market);
    index.set(market.id, category);
    if (market.conditionId) index.set(market.conditionId, category);
  }
  return index;
}

interface MarketResolution {
  resolved: boolean;
  winningOutcome?: string;
}

function buildResolutionIndex(markets: MarketSnapshot[]): Map<string, MarketResolution> {
  const index = new Map<string, MarketResolution>();
  for (const market of markets) {
    const resolution = {
      resolved: Boolean(market.resolved),
      winningOutcome: market.winningOutcome
    };
    index.set(market.id, resolution);
    if (market.conditionId) index.set(market.conditionId, resolution);
  }
  return index;
}

function analyzeResolvedOutcomes(
  trades: WalletTrade[],
  resolutionByMarket: Map<string, MarketResolution>
): { resolvedMarkets: number; resolvedWins: number; resolvedLosses: number; resolvedWinRate: number } {
  const exposureByMarketOutcome = new Map<string, { marketId: string; outcome: string; netSize: number }>();
  for (const trade of trades) {
    const key = `${trade.marketId}:${trade.outcome.toLowerCase()}`;
    const current = exposureByMarketOutcome.get(key) ?? { marketId: trade.marketId, outcome: trade.outcome, netSize: 0 };
    current.netSize += trade.side === "BUY" ? trade.size : -trade.size;
    exposureByMarketOutcome.set(key, current);
  }

  const resolvedMarkets = new Map<string, "WIN" | "LOSS">();
  for (const exposure of exposureByMarketOutcome.values()) {
    if (exposure.netSize <= 0) continue;
    const resolution = resolutionByMarket.get(exposure.marketId);
    if (!resolution?.resolved || !resolution.winningOutcome) continue;
    const outcomeWon = normalizeOutcome(exposure.outcome) === normalizeOutcome(resolution.winningOutcome);
    resolvedMarkets.set(exposure.marketId, outcomeWon ? "WIN" : "LOSS");
  }

  const resolvedWins = [...resolvedMarkets.values()].filter((result) => result === "WIN").length;
  const resolvedLosses = [...resolvedMarkets.values()].filter((result) => result === "LOSS").length;
  const total = resolvedWins + resolvedLosses;
  return {
    resolvedMarkets: total,
    resolvedWins,
    resolvedLosses,
    resolvedWinRate: total > 0 ? resolvedWins / total : 0
  };
}

function normalizeOutcome(value: string): string {
  return value.trim().toLowerCase();
}

export function inferMarketCategory(market: MarketSnapshot): MarketCategory {
  const text = `${market.question} ${market.slug ?? ""}`.toLowerCase();
  if (/\b(election|president|senate|house|congress|trump|biden|poll|mayor|governor|democrat|republican|minister)\b/.test(text)) return "politics";
  if (/\b(nba|nfl|mlb|nhl|ufc|soccer|football|tennis|golf|cricket|team|championship|super bowl|world cup)\b/.test(text)) return "sports";
  if (/\b(bitcoin|btc|ethereum|eth|solana|sol|xrp|crypto|token|coin|binance)\b/.test(text)) return "crypto";
  if (/\b(fed|inflation|cpi|rates|gdp|jobs|unemployment|recession|tariff|oil|gold)\b/.test(text)) return "macro";
  if (/\b(tesla|apple|nvidia|meta|google|amazon|microsoft|stock|earnings|ipo)\b/.test(text)) return "company";
  if (/\b(oscar|grammy|movie|album|stream|youtube|tiktok|celebrity|music)\b/.test(text)) return "culture";
  return "other";
}

function wilsonLowerBound(wins: number, total: number): number {
  if (total <= 0) return 0;
  const z = 1.96;
  const p = wins / total;
  const denominator = 1 + z ** 2 / total;
  const centre = p + z ** 2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + z ** 2 / (4 * total)) / total);
  return clamp((centre - margin) / denominator, 0, 1);
}

function emptyPerformance(): WalletPerformance {
  return {
    realizedPnlApprox: 0,
    profitFactorApprox: 0,
    winRateApprox: 0,
    avgReturnPctApprox: 0,
    maxDrawdownApprox: 0,
    avgHoldMinutesApprox: 0,
    closedTradeCount: 0,
    wins: 0
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
