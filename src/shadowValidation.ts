import type { BotDatabase } from "./db.js";
import { runShadowBacktest } from "./shadowBacktest.js";
import type { BotConfig, MarketCategory, MarketSnapshot, ShadowTrade, WalletTrade } from "./types.js";
import { categoryEligibility } from "./tradingPolicy.js";

export interface ShadowValidationDataset {
  histories: Map<string, WalletTrade[]>;
  markets: MarketSnapshot[];
  observedTrades: WalletTrade[];
}

export interface ExecutableShadowSummary {
  total: number;
  simulated: number;
  executable: number;
  missed: number;
  pnl: number;
  avgReturnPct: number;
  winRate: number;
  sourceSellRatio: number;
  missReasons: Array<{ reason: string; count: number }>;
}

export function loadShadowValidationDataset(
  db: BotDatabase,
  input: { activitySince?: number; walletLimit: number; historyLimit: number }
): ShadowValidationDataset {
  const wallets = db.getWalletsWithTradeActivitySince(input.activitySince ?? 0, input.walletLimit);
  const histories = new Map<string, WalletTrade[]>();
  const marketIds = new Set<string>();
  for (const wallet of wallets) {
    const trades = db.getWalletTradeHistory(wallet, input.historyLimit);
    if (trades.length === 0) continue;
    histories.set(wallet.toLowerCase(), trades);
    for (const trade of trades) {
      if (trade.marketId) marketIds.add(trade.marketId);
      if (trade.conditionId) marketIds.add(trade.conditionId);
    }
  }
  const observedTrades = [...histories.values()].flat();
  return {
    histories,
    markets: db.getMarketsByIds([...marketIds]),
    observedTrades
  };
}

export function runShadowDataset(
  dataset: ShadowValidationDataset,
  config: BotConfig,
  input: { since?: number; before?: number; stripResolution?: boolean } = {}
): ShadowTrade[] {
  const since = input.since ?? 0;
  const before = input.before ?? Number.POSITIVE_INFINITY;
  const observedTrades = dataset.observedTrades.filter((trade) => trade.timestamp >= since && trade.timestamp < before);
  const markets = input.stripResolution
    ? dataset.markets.map((market) => ({ ...market, resolved: false, winningOutcome: undefined }))
    : dataset.markets;
  const result: ShadowTrade[] = [];
  for (const [wallet, history] of dataset.histories) {
    const periodTrades = history.filter((trade) => trade.timestamp >= since && trade.timestamp < before);
    if (periodTrades.length === 0) continue;
    result.push(...runShadowBacktest(wallet, periodTrades, markets, config, Date.now(), observedTrades));
  }
  return result;
}

export function excludeBlockedShadowTrades(trades: ShadowTrade[], blocked: MarketCategory[] = []): ShadowTrade[] {
  const blockedSet = new Set(blocked);
  return trades.filter((trade) => !blockedSet.has(trade.category ?? "other"));
}

export function excludeIneligibleShadowTrades(trades: ShadowTrade[], config: BotConfig): ShadowTrade[] {
  // Missing market metadata is not permission to bypass an allowlist. Treat an
  // unknown category exactly as the database scorecard does: "other".
  return trades.filter((trade) => categoryEligibility(trade.category ?? "other", config).eligible);
}

export function summarizeExecutableShadow(trades: ShadowTrade[]): ExecutableShadowSummary {
  const simulated = trades.filter((trade) => trade.status === "SIMULATED");
  const executable = simulated.filter((trade) => trade.liveExecutableStatus === "EXECUTABLE");
  const missed = simulated.filter((trade) => trade.liveExecutableStatus === "MISSED");
  const wins = executable.filter((trade) => (trade.liveExecutablePnl ?? 0) > 0).length;
  const losses = executable.filter((trade) => (trade.liveExecutablePnl ?? 0) < 0).length;
  const sourceSells = simulated.filter((trade) => trade.exitReason === "source sell after detection").length;
  const missCounts = new Map<string, number>();
  for (const trade of missed) {
    const reason = trade.liveExecutableReason || "unknown";
    missCounts.set(reason, (missCounts.get(reason) ?? 0) + 1);
  }
  return {
    total: trades.length,
    simulated: simulated.length,
    executable: executable.length,
    missed: missed.length,
    pnl: executable.reduce((sum, trade) => sum + (trade.liveExecutablePnl ?? 0), 0),
    avgReturnPct: executable.length > 0
      ? executable.reduce((sum, trade) => sum + (trade.liveExecutableReturnPct ?? 0), 0) / executable.length
      : 0,
    winRate: wins + losses > 0 ? wins / (wins + losses) : 0,
    sourceSellRatio: simulated.length > 0 ? sourceSells / simulated.length : 0,
    missReasons: [...missCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
  };
}
