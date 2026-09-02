import { createHash } from "node:crypto";
import type { BotConfig, MarketCategory, MarketSnapshot, ShadowBacktestReport, ShadowTrade, ShadowWalletPerformance, WalletTrade } from "./types.js";
import { copyDelayPriceMovePct, estimateTapeExecutableShadow } from "./liveExecution.js";
import { isProspectiveWalletTrade, liveShadowPolicyVersion, walletCopyPositionSize } from "./tradingPolicy.js";
import { inferMarketCategory } from "./walletIntelligence.js";

export function runShadowBacktest(
  wallet: string,
  trades: WalletTrade[],
  markets: MarketSnapshot[],
  config: BotConfig,
  now = Date.now(),
  marketTrades: WalletTrade[] = trades
): ShadowTrade[] {
  const marketById = buildMarketIndex(markets);
  const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp);
  const sortedMarketTrades = [...marketTrades].sort((a, b) => a.timestamp - b.timestamp);
  const shadowTrades: ShadowTrade[] = [];
  const sourceExits = matchSourceExitsFifo(sorted, config);

  for (const trade of sorted) {
    if (trade.side !== "BUY") continue;
    const detectedAt = trade.timestamp + config.shadowCopyDelayMs;
    const market = marketById.get(trade.marketId) ?? marketById.get(trade.conditionId ?? "");
    const base = baseShadowTrade(wallet, trade, detectedAt, config, now, market ? inferMarketCategory(market) : undefined);
    const simulatedEntryPrice = estimateCopyEntryPrice(trade.price, config);

    const sourceExit = sourceExits.get(trade);
    const latestObservedMark = [...sortedMarketTrades].reverse().find((candidate) =>
      candidate.marketId === trade.marketId &&
      candidate.outcome.toLowerCase() === trade.outcome.toLowerCase() &&
      candidate.timestamp >= detectedAt
    );
    const resolvedExit = market?.resolved && market.winningOutcome
      ? (normalizeOutcome(market.winningOutcome) === normalizeOutcome(trade.outcome) ? 1 : 0)
      : undefined;
    // A buy the source never sold is not un-copyable -- it is a position we would
    // have carried and exited on our own policy. Blend any FIFO-matched sell with
    // the mark for the unsold remainder so partially-exited lots are not scored as
    // though the whole position was closed at the sell price.
    const policyExitPrice = resolvedExit ?? latestObservedMark?.price ?? trade.price;
    const matchedRatio = sourceExit ? Math.min(1, sourceExit.matchedSize / Math.max(trade.size, 1e-9)) : 0;
    const simulatedExitPrice = sourceExit
      ? sourceExit.price * matchedRatio + policyExitPrice * (1 - matchedRatio)
      : policyExitPrice;

    const positionSizeUsd = walletCopyPositionSize(config);
    const shares = positionSizeUsd / simulatedEntryPrice;
    const pnl = (simulatedExitPrice - simulatedEntryPrice) * shares;
    const exitReason = sourceExit && matchedRatio >= 0.5
      ? "source sell after detection"
      : resolvedExit !== undefined
        ? "resolved market outcome"
        : latestObservedMark
          ? "latest observed mark"
          : "source price fallback";
    const liveExecutableSizeUsd = positionSizeUsd;
    const liveExecutable = config.liveExecutableShadowEnabled === false
      ? undefined
      : estimateTapeExecutableShadow({
          sourcePrice: trade.price,
          entryPrice: simulatedEntryPrice,
          exitPrice: simulatedExitPrice,
          sourceBuySize: trade.size,
          sourceSellSize: sourceExit?.matchedSize,
          sizeUsd: liveExecutableSizeUsd,
          exitReason,
          config
        });
    shadowTrades.push({
      ...base,
      status: "SIMULATED",
      simulatedEntryPrice,
      simulatedExitPrice,
      pnl,
      returnPct: simulatedEntryPrice > 0 ? (simulatedExitPrice - simulatedEntryPrice) / simulatedEntryPrice : 0,
      liveExecutablePnl: liveExecutable?.pnl,
      liveExecutableReturnPct: liveExecutable?.returnPct,
      liveExecutableStatus: liveExecutable?.status,
      liveExecutableReason: liveExecutable?.reason,
      liveExecutableEntryPrice: liveExecutable?.entryPrice,
      liveExecutableExitPrice: liveExecutable?.exitPrice,
      liveExecutableEntrySlippage: liveExecutable?.entrySlippage,
      liveExecutableExitSlippage: liveExecutable?.exitSlippage,
      exitReason
    });
  }

  return shadowTrades;
}

export function summarizeShadowBacktest(trades: ShadowTrade[]): ShadowBacktestReport {
  const simulatedTrades = trades.filter((trade) => trade.status === "SIMULATED");
  const liveExecutableTrades = simulatedTrades.filter((trade) => trade.liveExecutableStatus === "EXECUTABLE");
  const pnl = simulatedTrades.reduce((sum, trade) => sum + trade.pnl, 0);
  const wins = simulatedTrades.filter((trade) => trade.pnl > 0).length;
  const losses = simulatedTrades.filter((trade) => trade.pnl < 0).length;
  const liveWins = liveExecutableTrades.filter((trade) => (trade.liveExecutablePnl ?? 0) > 0).length;
  const liveLosses = liveExecutableTrades.filter((trade) => (trade.liveExecutablePnl ?? 0) < 0).length;
  return {
    total: trades.length,
    simulated: simulatedTrades.length,
    skipped: trades.length - simulatedTrades.length,
    pnl,
    wins,
    losses,
    winRate: wins + losses > 0 ? wins / (wins + losses) : 0,
    avgReturnPct: simulatedTrades.length > 0
      ? simulatedTrades.reduce((sum, trade) => sum + trade.returnPct, 0) / simulatedTrades.length
      : 0,
    liveExecutablePnl: liveExecutableTrades.reduce((sum, trade) => sum + (trade.liveExecutablePnl ?? 0), 0),
    liveExecutableSimulated: liveExecutableTrades.length,
    liveExecutableWinRate: liveWins + liveLosses > 0 ? liveWins / (liveWins + liveLosses) : 0,
    liveExecutableAvgReturnPct: liveExecutableTrades.length > 0
      ? liveExecutableTrades.reduce((sum, trade) => sum + (trade.liveExecutableReturnPct ?? 0), 0) / liveExecutableTrades.length
      : 0
  };
}

export function summarizeShadowPerformanceByWallet(trades: ShadowTrade[]): Map<string, ShadowWalletPerformance> {
  const byWallet = new Map<string, ShadowTrade[]>();
  for (const trade of trades) {
    const list = byWallet.get(trade.wallet) ?? [];
    list.push(trade);
    byWallet.set(trade.wallet, list);
  }

  const performance = new Map<string, ShadowWalletPerformance>();
  for (const [wallet, walletTrades] of byWallet) {
    performance.set(wallet, summarizeWalletTrades(wallet, walletTrades));
  }
  return performance;
}

export function summarizeShadowPerformanceByWalletAndCategory(trades: ShadowTrade[]): Map<string, ShadowWalletPerformance> {
  const grouped = new Map<string, ShadowTrade[]>();
  for (const trade of trades) {
    const category = trade.category ?? "other";
    const key = `${trade.wallet}:${category}`;
    const list = grouped.get(key) ?? [];
    list.push(trade);
    grouped.set(key, list);
  }

  const performance = new Map<string, ShadowWalletPerformance>();
  for (const [key, categoryTrades] of grouped) {
    const [wallet, category] = key.split(":") as [string, MarketCategory];
    performance.set(key, summarizeWalletTrades(wallet, categoryTrades, category));
  }
  return performance;
}

function summarizeWalletTrades(wallet: string, walletTrades: ShadowTrade[], category?: MarketCategory): ShadowWalletPerformance {
  const simulated = walletTrades.filter((trade) => trade.status === "SIMULATED");
  const realized = simulated.filter((trade) =>
    trade.exitReason === "source sell after detection" || trade.exitReason === "resolved market outcome"
  );
  const sourceSellRealized = simulated.filter((trade) => trade.exitReason === "source sell after detection");
  const marked = simulated.filter((trade) => trade.exitReason === "latest observed mark");
  const fallback = simulated.filter((trade) => trade.exitReason === "source price fallback");
  const liveExecutable = simulated.filter((trade) => trade.liveExecutableStatus === "EXECUTABLE");
  const wins = simulated.filter((trade) => trade.pnl > 0).length;
  const losses = simulated.filter((trade) => trade.pnl < 0).length;
  const liveWins = liveExecutable.filter((trade) => (trade.liveExecutablePnl ?? 0) > 0).length;
  const liveLosses = liveExecutable.filter((trade) => (trade.liveExecutablePnl ?? 0) < 0).length;
  return {
    wallet,
    category,
    total: walletTrades.length,
    simulated: simulated.length,
    realized: realized.length,
    sourceSellRealized: sourceSellRealized.length,
    marked: marked.length,
    fallback: fallback.length,
    pnl: simulated.reduce((sum, trade) => sum + trade.pnl, 0),
    realizedPnl: realized.reduce((sum, trade) => sum + trade.pnl, 0),
    sourceSellPnl: sourceSellRealized.reduce((sum, trade) => sum + trade.pnl, 0),
    wins,
    losses,
    winRate: wins + losses > 0 ? wins / (wins + losses) : 0,
    avgReturnPct: simulated.length > 0
      ? simulated.reduce((sum, trade) => sum + trade.returnPct, 0) / simulated.length
      : 0,
    realizedAvgReturnPct: realized.length > 0
      ? realized.reduce((sum, trade) => sum + trade.returnPct, 0) / realized.length
      : 0,
    sourceSellRealizedRatio: simulated.length > 0 ? sourceSellRealized.length / simulated.length : 0,
    liveExecutableSimulated: liveExecutable.length,
    liveExecutablePnl: liveExecutable.reduce((sum, trade) => sum + (trade.liveExecutablePnl ?? 0), 0),
    liveExecutableAvgReturnPct: liveExecutable.length > 0
      ? liveExecutable.reduce((sum, trade) => sum + (trade.liveExecutableReturnPct ?? 0), 0) / liveExecutable.length
      : 0,
    liveExecutableWinRate: liveWins + liveLosses > 0 ? liveWins / (liveWins + liveLosses) : 0
  };
}

function baseShadowTrade(
  wallet: string,
  trade: WalletTrade,
  detectedAt: number,
  config: BotConfig,
  now: number,
  category?: MarketCategory
): Omit<ShadowTrade, "status"> {
  return {
    id: shadowTradeId(wallet, trade, detectedAt),
    wallet: wallet.toLowerCase(),
    marketId: trade.marketId,
    category,
    tokenId: trade.tokenId,
    outcome: trade.outcome,
    sourceTimestamp: trade.timestamp,
    detectedAt,
    sourcePrice: trade.price,
    sourceObservedAt: trade.observedAt,
    sizeUsd: walletCopyPositionSize(config),
    pnl: 0,
    returnPct: 0,
    forwardEligible: isProspectiveWalletTrade(trade, config),
    policyVersion: liveShadowPolicyVersion(config),
    createdAt: now
  };
}

interface MatchedSourceExit {
  price: number;
  matchedSize: number;
  timestamp: number;
}

// Match each source sell against the buys it actually closes, oldest first.
//
// The previous implementation took the first sell after every buy independently,
// so a wallet that accumulated across several buys and closed once had that single
// sell credited to every buy in the leg. These wallets buy far more than they sell
// (2,247 buys against 182 sells for one of the top-ranked sources, ~4.6 buys per
// market/outcome leg), so one good exit was being counted four or five times while
// the buys it never covered were scored separately as unsold. That is what produced
// 100% win rates on source-sell exits. FIFO matching makes a sell close a bounded
// amount of inventory, exactly once.
function matchSourceExitsFifo(sortedTrades: WalletTrade[], config: BotConfig): Map<WalletTrade, MatchedSourceExit> {
  const matches = new Map<WalletTrade, MatchedSourceExit>();
  const openLots = new Map<string, Array<{ trade: WalletTrade; remaining: number; detectedAt: number }>>();

  for (const trade of sortedTrades) {
    const key = `${trade.marketId}:${trade.outcome.toLowerCase()}`;
    if (trade.side === "BUY") {
      const lots = openLots.get(key) ?? [];
      lots.push({ trade, remaining: trade.size, detectedAt: trade.timestamp + config.shadowCopyDelayMs });
      openLots.set(key, lots);
      continue;
    }

    const lots = openLots.get(key);
    if (!lots || lots.length === 0) continue;
    let unallocated = trade.size;
    for (const lot of lots) {
      if (unallocated <= 0) break;
      if (lot.remaining <= 0) continue;
      // Only a sell we could have observed after our own copy entry is mirrorable.
      if (trade.timestamp < lot.detectedAt) continue;
      const take = Math.min(lot.remaining, unallocated);
      lot.remaining -= take;
      unallocated -= take;
      const existing = matches.get(lot.trade);
      const matchedSize = (existing?.matchedSize ?? 0) + take;
      matches.set(lot.trade, {
        // Weighted average across every sell that closes part of this lot.
        price: existing
          ? (existing.price * existing.matchedSize + trade.price * take) / matchedSize
          : trade.price,
        matchedSize,
        timestamp: existing?.timestamp ?? trade.timestamp
      });
    }
    openLots.set(key, lots.filter((lot) => lot.remaining > 0));
  }
  return matches;
}

function estimateCopyEntryPrice(sourcePrice: number, config: BotConfig): number {
  return Math.min(0.99, sourcePrice * (1 + copyDelayPriceMovePct(config)));
}

function buildMarketIndex(markets: MarketSnapshot[]): Map<string, MarketSnapshot> {
  const index = new Map<string, MarketSnapshot>();
  for (const market of markets) {
    index.set(market.id, market);
    if (market.conditionId) index.set(market.conditionId, market);
  }
  return index;
}

function shadowTradeId(wallet: string, trade: WalletTrade, detectedAt: number): string {
  return createHash("sha256")
    .update([
      wallet.toLowerCase(),
      trade.marketId,
      trade.conditionId ?? "",
      trade.tokenId ?? "",
      trade.outcome,
      trade.timestamp,
      detectedAt,
      trade.price,
      trade.size
    ].join("|"))
    .digest("hex");
}

function normalizeOutcome(value: string): string {
  return value.trim().toLowerCase();
}
