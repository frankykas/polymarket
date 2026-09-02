import type { BotDatabase } from "./db.js";
import { excludeIneligibleShadowTrades, loadShadowValidationDataset, runShadowDataset, summarizeExecutableShadow } from "./shadowValidation.js";
import type { BotConfig, CleanWalkForwardReport, ShadowTrade, WalkForwardMetrics } from "./types.js";

export function computeCleanWalkForward(
  db: BotDatabase,
  config: BotConfig,
  input: { walletLimit?: number; historyLimit?: number; now?: number } = {}
): CleanWalkForwardReport {
  const calculatedAt = input.now ?? Date.now();
  const dataset = loadShadowValidationDataset(db, {
    activitySince: 0,
    walletLimit: input.walletLimit ?? 60,
    historyLimit: input.historyLimit ?? 1500
  });
  const buyTimes = dataset.observedTrades
    .filter((trade) => trade.side === "BUY")
    .map((trade) => trade.timestamp)
    .sort((a, b) => a - b);
  if (buyTimes.length < 20) {
    return emptyReport(calculatedAt, dataset.histories.size, dataset.markets.length, "needs at least 20 chronologically observed source buys");
  }

  const splitAt = buyTimes[Math.min(buyTimes.length - 1, Math.floor(buyTimes.length * 0.7))];
  const endAt = buyTimes[buyTimes.length - 1] + 1;
  // Resolved state is deliberately stripped in both windows so a later market
  // resolution cannot leak into a historical source rank.
  const train = eligible(runShadowDataset(dataset, config, { before: splitAt, stripResolution: true }), config);
  const test = eligible(runShadowDataset(dataset, config, { since: splitAt, before: endAt, stripResolution: true }), config);
  const trainByWallet = groupByWallet(train);
  const ranked = [...trainByWallet.entries()]
    .map(([wallet, trades]) => ({ wallet, metrics: summarizeExecutableShadow(trades) }))
    .sort((a, b) => rankScore(b.metrics) - rankScore(a.metrics));
  const promoted = ranked.filter((row) => passesPromotion(row.metrics, config));
  const gatePassingOos = publicMetrics(summarizeExecutableShadow(testForWallets(test, promoted.map((row) => row.wallet))));
  const allTestSources = publicMetrics(summarizeExecutableShadow(test));
  const passed = promoted.length > 0 && passesPromotion(gatePassingOos, config);
  const reason = promoted.length === 0
    ? "no source passed the frozen training gates"
    : !passed
      ? `training promoted ${promoted.length} source(s), but next-period executable P&L/return/win/sell gates failed`
      : `${promoted.length} training-ranked source(s) remained profitable and gate-compliant out of sample`;
  return {
    calculatedAt,
    splitAt,
    endAt,
    wallets: dataset.histories.size,
    markets: dataset.markets.length,
    trainRows: train.length,
    testRows: test.length,
    promotedSources: promoted.length,
    gatePassingOos,
    allTestSources,
    passed,
    reason
  };
}

function emptyReport(calculatedAt: number, wallets: number, markets: number, reason: string): CleanWalkForwardReport {
  const metrics = publicMetrics(summarizeExecutableShadow([]));
  return {
    calculatedAt,
    wallets,
    markets,
    trainRows: 0,
    testRows: 0,
    promotedSources: 0,
    gatePassingOos: metrics,
    allTestSources: metrics,
    passed: false,
    reason
  };
}

function eligible(trades: ShadowTrade[], config: BotConfig): ShadowTrade[] {
  return excludeIneligibleShadowTrades(trades, config);
}

function groupByWallet(trades: ShadowTrade[]): Map<string, ShadowTrade[]> {
  const groups = new Map<string, ShadowTrade[]>();
  for (const trade of trades) groups.set(trade.wallet, [...(groups.get(trade.wallet) ?? []), trade]);
  return groups;
}

function passesPromotion(metrics: WalkForwardMetrics, config: BotConfig): boolean {
  return metrics.executable >= (config.minLiveExecutableShadowTradesForTrading ?? 8)
    && metrics.pnl > (config.minLiveExecutableShadowPnlForTrading ?? 0)
    && metrics.avgReturnPct > (config.liveExecutableMinReturnPct ?? 0.03)
    && metrics.winRate >= (config.minLiveExecutableShadowWinRateForTrading ?? 0.45)
    && metrics.sourceSellRatio >= (config.minSourceSellRealizedRatio ?? 0.35);
}

function rankScore(metrics: WalkForwardMetrics): number {
  if (metrics.executable === 0) return Number.NEGATIVE_INFINITY;
  return metrics.avgReturnPct * Math.sqrt(metrics.executable) + metrics.pnl / 1000;
}

function testForWallets(trades: ShadowTrade[], wallets: string[]): ShadowTrade[] {
  const selected = new Set(wallets);
  return trades.filter((trade) => selected.has(trade.wallet));
}

function publicMetrics(metrics: ReturnType<typeof summarizeExecutableShadow>): WalkForwardMetrics {
  return {
    executable: metrics.executable,
    pnl: metrics.pnl,
    avgReturnPct: metrics.avgReturnPct,
    winRate: metrics.winRate,
    sourceSellRatio: metrics.sourceSellRatio
  };
}
