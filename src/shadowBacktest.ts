import { createHash } from "node:crypto";
import type { BotConfig, MarketCategory, MarketSnapshot, ShadowBacktestReport, ShadowTrade, ShadowWalletPerformance, WalletTrade } from "./types.js";
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

  for (const trade of sorted) {
    if (trade.side !== "BUY") continue;
    const detectedAt = trade.timestamp + config.shadowCopyDelayMs;
    const market = marketById.get(trade.marketId) ?? marketById.get(trade.conditionId ?? "");
    const base = baseShadowTrade(wallet, trade, detectedAt, config, now, market ? inferMarketCategory(market) : undefined);
    const simulatedEntryPrice = estimateCopyEntryPrice(trade.price, config);

    const sourceExit = sorted.find((candidate) =>
      candidate.side === "SELL" &&
      candidate.marketId === trade.marketId &&
      candidate.outcome.toLowerCase() === trade.outcome.toLowerCase() &&
      candidate.timestamp >= detectedAt
    );
    const latestObservedMark = [...sortedMarketTrades].reverse().find((candidate) =>
      candidate.marketId === trade.marketId &&
      candidate.outcome.toLowerCase() === trade.outcome.toLowerCase() &&
      candidate.timestamp >= detectedAt
    );
    const resolvedExit = market?.resolved && market.winningOutcome
      ? (normalizeOutcome(market.winningOutcome) === normalizeOutcome(trade.outcome) ? 1 : 0)
      : undefined;
    const simulatedExitPrice = sourceExit?.price ?? resolvedExit ?? latestObservedMark?.price ?? trade.price;

    const shares = config.shadowPositionSize / simulatedEntryPrice;
    const pnl = (simulatedExitPrice - simulatedEntryPrice) * shares;
    shadowTrades.push({
      ...base,
      status: "SIMULATED",
      simulatedEntryPrice,
      simulatedExitPrice,
      pnl,
      returnPct: simulatedEntryPrice > 0 ? (simulatedExitPrice - simulatedEntryPrice) / simulatedEntryPrice : 0,
      exitReason: sourceExit
        ? "source sell after detection"
        : resolvedExit !== undefined
          ? "resolved market outcome"
          : latestObservedMark
            ? "latest observed mark"
            : "source price fallback"
    });
  }

  return shadowTrades;
}

export function summarizeShadowBacktest(trades: ShadowTrade[]): ShadowBacktestReport {
  const simulatedTrades = trades.filter((trade) => trade.status === "SIMULATED");
  const pnl = simulatedTrades.reduce((sum, trade) => sum + trade.pnl, 0);
  const wins = simulatedTrades.filter((trade) => trade.pnl > 0).length;
  const losses = simulatedTrades.filter((trade) => trade.pnl < 0).length;
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
  const marked = simulated.filter((trade) => trade.exitReason === "latest observed mark");
  const fallback = simulated.filter((trade) => trade.exitReason === "source price fallback");
  const wins = simulated.filter((trade) => trade.pnl > 0).length;
  const losses = simulated.filter((trade) => trade.pnl < 0).length;
  return {
    wallet,
    category,
    total: walletTrades.length,
    simulated: simulated.length,
    realized: realized.length,
    marked: marked.length,
    fallback: fallback.length,
    pnl: simulated.reduce((sum, trade) => sum + trade.pnl, 0),
    realizedPnl: realized.reduce((sum, trade) => sum + trade.pnl, 0),
    wins,
    losses,
    winRate: wins + losses > 0 ? wins / (wins + losses) : 0,
    avgReturnPct: simulated.length > 0
      ? simulated.reduce((sum, trade) => sum + trade.returnPct, 0) / simulated.length
      : 0,
    realizedAvgReturnPct: realized.length > 0
      ? realized.reduce((sum, trade) => sum + trade.returnPct, 0) / realized.length
      : 0
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
    sizeUsd: config.shadowPositionSize,
    pnl: 0,
    returnPct: 0,
    createdAt: now
  };
}

function estimateCopyEntryPrice(sourcePrice: number, config: BotConfig): number {
  const delayMinutes = config.shadowCopyDelayMs / 60000;
  const delayPenalty = Math.min(config.shadowMaxEntryPriceMovePct, 0.01 + delayMinutes * 0.002);
  return Math.min(0.99, sourcePrice * (1 + delayPenalty));
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
