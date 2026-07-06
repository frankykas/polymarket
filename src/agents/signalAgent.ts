import type { BotDatabase } from "../db.js";
import {
  applyShadowPerformanceToScore,
  applyPaperPerformanceToScore,
  calculateShadowScoreImpact,
  discoverWallets,
  generateSignals,
  scoreDiscoveredWallet,
  scoreWallet
} from "../engines.js";
import type { AgentEventWriter } from "../events/eventWriter.js";
import type { PolymarketProvider } from "../providers/polymarketProvider.js";
import { runShadowBacktest, summarizeShadowBacktest, summarizeShadowPerformanceByWallet, summarizeShadowPerformanceByWalletAndCategory } from "../shadowBacktest.js";
import type {
  BotConfig,
  MarketCategory,
  MarketSnapshot,
  OrderBookSnapshot,
  ShadowWalletPerformance,
  TradeSignal,
  TrackedWallet,
  WalletScore,
  WalletTrade
} from "../types.js";

export interface SignalAgentResult {
  markets: MarketSnapshot[];
  scores: WalletScore[];
  discovered: number;
  discoveryTrades: number;
  allTrades: WalletTrade[];
}

export class SignalAgent {
  constructor(
    private provider: PolymarketProvider,
    private db: BotDatabase,
    private events: AgentEventWriter,
    private config: BotConfig
  ) {}

  async discoverAndScore(wallets: TrackedWallet[]): Promise<SignalAgentResult> {
    const markets = await this.provider.getActiveMarkets(this.config.marketScanLimit);
    const watchedMarkets = markets.slice(0, this.config.maxWatchedMarkets);
    for (const market of watchedMarkets) this.db.saveMarket(market);
    this.events.write({
      type: "market.discovery_completed",
      agent: "Signal Agent",
      visibility: "PUBLIC",
      message: `Signal Agent scanned ${watchedMarkets.length} active markets.`,
      payload: { marketCount: watchedMarkets.length }
    });

    const discoveryTrades = this.config.discoveryEnabled ? await this.fetchDiscoveryTrades(watchedMarkets) : [];
    const discoveryInserted = this.db.saveWalletTrades(discoveryTrades);
    if (discoveryTrades.length > 0) {
      this.events.write({
        type: "source.backfill_completed",
        agent: "Signal Agent",
        message: "Stored market-discovery wallet trades.",
        payload: {
          observedTrades: discoveryTrades.length,
          insertedTrades: discoveryInserted
        }
      });
    }
    const walletPreviewPositions = this.config.discoveryEnabled ? await this.fetchPositionPreviews(discoveryTrades) : [];
    const discoveredWallets = this.config.discoveryEnabled
      ? discoverWallets(discoveryTrades, this.config, Date.now(), walletPreviewPositions, watchedMarkets)
      : [];
    for (const wallet of discoveredWallets) {
      this.db.saveDiscoveredWallet(wallet);
      this.events.write({
        type: "source.discovered",
        agent: "Signal Agent",
        message: "Candidate source wallet discovered.",
        payload: {
          address: wallet.address,
          copyabilityScore: wallet.copyabilityScore,
          categoryConsistencyScore: wallet.categoryConsistencyScore,
          hotScore: wallet.hotScore,
          sampleConfidence: wallet.sampleConfidence,
          dominantCategory: wallet.dominantCategory,
          tradeCount: wallet.tradeCount,
          flags: wallet.flags
        }
      });
    }

    const discoveredSeedScores = discoveredWallets.map((wallet) => scoreDiscoveredWallet(wallet));
    const discoveredScores = this.config.autoTrackDiscoveredWallets
      ? discoveredSeedScores.filter((score) => score.score >= this.config.minWalletScore)
      : [];
    const deepHistorySeedScores = this.config.autoTrackDiscoveredWallets && this.config.deepHistoryEnabled
      ? [...discoveredSeedScores]
          .sort((a, b) => (b.copyabilityScore ?? b.score) - (a.copyabilityScore ?? a.score))
          .slice(0, Math.max(0, this.config.deepHistoryWalletLimit))
      : [];
    const trackedWallets = [...wallets];
    for (const wallet of mergeScores(deepHistorySeedScores, discoveredScores)) {
      if (!trackedWallets.some((tracked) => tracked.address.toLowerCase() === wallet.wallet.toLowerCase())) {
        trackedWallets.push({ address: wallet.wallet, label: "discovered", enabled: true });
      }
    }
    this.db.syncWallets(trackedWallets);

    const deepHistoryWallets = this.deepHistoryWalletSet(wallets, deepHistorySeedScores);
    const walletTrades = await this.fetchWalletTrades(trackedWallets, deepHistoryWallets);
    const historyMarkets = await this.backfillMarketSnapshots([...walletTrades.values()].flat(), watchedMarkets);
    const historyScores = trackedWallets.map((wallet) =>
      scoreWallet(wallet, walletTrades.get(wallet.address.toLowerCase()) ?? [], Date.now(), historyMarkets, this.config)
    );
    const baseScores = mergeScores(historyScores, discoveredScores);
    const shadowPerformance = this.runShadowBacktests(baseScores, walletTrades, historyMarkets, discoveryTrades);
    const paperPerformance = this.db.getPaperSourcePerformance();
    const savedPaperFeedback = this.db.savePaperSourceFeedback(paperPerformance.values());
    if (savedPaperFeedback > 0) {
      this.events.write({
        type: "source.paper_feedback_updated",
        agent: "Signal Agent",
        visibility: "PUBLIC",
        message: "Paper-copy source feedback updated.",
        payload: { sources: paperPerformance.size, saved: savedPaperFeedback }
      });
    }
    const scores = baseScores
      .map((score) => applyShadowPerformanceToScore(score, shadowPerformance.byWallet.get(score.wallet.toLowerCase())))
      .map((score) => applyPaperPerformanceToScore(score, paperPerformance.get(score.wallet.toLowerCase())))
      .map((score) => ({
        ...score,
        shadowCategoryImpacts: shadowPerformance.categoryImpacts.get(score.wallet.toLowerCase())
      }))
      .sort((a, b) => b.score - a.score);
    for (const score of scores) {
      this.db.saveWalletScore(score);
      this.events.write({
        type: "source.scored",
        agent: "Signal Agent",
        message: "Source wallet scored.",
        payload: {
          wallet: score.wallet,
          label: score.label,
          score: score.score,
          copyabilityScore: score.copyabilityScore,
          categoryConsistencyScore: score.categoryConsistencyScore,
          hotScore: score.hotScore,
          sampleConfidence: score.sampleConfidence,
          dominantCategory: score.dominantCategory,
          resolvedMarkets: score.resolvedMarkets,
          resolvedWins: score.resolvedWins,
          resolvedLosses: score.resolvedLosses,
          resolvedWinRate: score.resolvedWinRate,
          shadowSimulated: score.shadowSimulated,
          shadowRealized: score.shadowRealized,
          shadowPnl: score.shadowPnl,
          shadowAvgReturnPct: score.shadowAvgReturnPct,
          shadowScoreImpact: score.shadowScoreImpact,
          reliability: score.reliability,
          flags: score.flags
        }
      });
    }

    return {
      markets: watchedMarkets,
      scores,
      discovered: discoveredWallets.length,
      discoveryTrades: discoveryTrades.length,
      allTrades: [
        ...[...walletTrades.values()].flat(),
        ...discoveryTrades.filter((trade) => scores.some((score) => score.wallet.toLowerCase() === trade.wallet.toLowerCase()))
      ]
    };
  }

  createSignals(input: {
    market: MarketSnapshot;
    books: OrderBookSnapshot[];
    trades: WalletTrade[];
    scores: WalletScore[];
  }): TradeSignal[] {
    const signals = generateSignals(input.market, input.books, input.trades, input.scores, this.config);
    for (const signal of signals) {
      this.db.saveSignal(signal);
      this.events.write({
        type: "signal.created",
        agent: "Signal Agent",
        visibility: signal.decision === "TRADE_CANDIDATE" ? "PUBLIC" : "PRIVATE",
        message: `${signal.decision}: ${signal.outcome} on market ${signal.marketId}.`,
        payload: {
          signalId: signal.id,
          marketId: signal.marketId,
          tokenId: signal.tokenId,
          outcome: signal.outcome,
          confidence: signal.confidence,
          alignedSources: signal.alignedWallets.length,
          reason: signal.reason
        }
      });
    }
    return signals;
  }

  async fetchWalletTrades(wallets: TrackedWallet[], deepHistoryWallets = new Set<string>()): Promise<Map<string, WalletTrade[]>> {
    const trades = new Map<string, WalletTrade[]>();
    for (const wallet of wallets) {
      const deepHistory = deepHistoryWallets.has(wallet.address.toLowerCase());
      const walletTrades = deepHistory
        ? await this.fetchPaginatedWalletTrades(wallet.address)
        : await this.provider.getWalletTrades(wallet.address, this.config.walletActivityLimit);
      const inserted = this.db.saveWalletTrades(walletTrades);
      const historyLimit = deepHistory
        ? Math.max(this.config.walletActivityLimit, this.config.deepHistoryPageSize * this.config.deepHistoryPages, 500)
        : Math.max(this.config.walletActivityLimit, 500);
      const history = this.db.getWalletTradeHistory(wallet.address, historyLimit);
      trades.set(wallet.address.toLowerCase(), history.length > 0 ? history : walletTrades);
      if (walletTrades.length > 0) {
        this.events.write({
          type: "source.backfill_completed",
          agent: "Signal Agent",
          message: "Stored source wallet trade history.",
          payload: {
            wallet: wallet.address.toLowerCase(),
            observedTrades: walletTrades.length,
            insertedTrades: inserted,
            historyTrades: history.length,
            deepHistory
          }
        });
      }
    }
    return trades;
  }

  private async fetchPaginatedWalletTrades(wallet: string): Promise<WalletTrade[]> {
    const pageSize = Math.max(1, this.config.deepHistoryPageSize);
    const pages = Math.max(1, this.config.deepHistoryPages);
    const allTrades: WalletTrade[] = [];
    const seen = new Set<string>();

    for (let page = 0; page < pages; page += 1) {
      const pageTrades = await this.provider.getWalletTradesPage(wallet, pageSize, page * pageSize);
      let newTrades = 0;
      for (const trade of pageTrades) {
        const key = walletTradeKey(trade);
        if (seen.has(key)) continue;
        seen.add(key);
        allTrades.push(trade);
        newTrades += 1;
      }
      if (pageTrades.length < pageSize || newTrades === 0) break;
    }

    return allTrades;
  }

  private async fetchDiscoveryTrades(markets: MarketSnapshot[]): Promise<WalletTrade[]> {
    const trades: WalletTrade[] = [];
    for (const market of markets.slice(0, this.config.discoveryMarketLimit)) {
      const marketTrades = await this.provider.getMarketTrades(market.conditionId ?? market.id, this.config.discoveryTradesPerMarket);
      trades.push(...marketTrades);
    }
    return trades;
  }

  private async fetchPositionPreviews(trades: WalletTrade[]) {
    const wallets = [...new Set(trades.map((trade) => trade.wallet))].slice(0, this.config.maxDiscoveredWallets);
    const positions = [];
    for (const wallet of wallets) positions.push(...await this.provider.getWalletPositions(wallet));
    return positions;
  }

  private async backfillMarketSnapshots(trades: WalletTrade[], seedMarkets: MarketSnapshot[]): Promise<MarketSnapshot[]> {
    const seedById = marketIndex(seedMarkets);
    const ids = [...new Set(trades.flatMap((trade) => [trade.marketId, trade.conditionId]).filter((id): id is string => Boolean(id)))];
    const cached = this.db.getMarketsByIds(ids);
    const known = marketIndex([...seedMarkets, ...cached]);
    const backfillLimit = Math.max(1, this.config.resolutionBackfillLimit);
    const missing = ids.filter((id) => !known.has(id)).slice(0, backfillLimit);
    const fetched: MarketSnapshot[] = [];

    for (const id of missing) {
      const market = await this.provider.getMarketById(id);
      if (!market) continue;
      this.db.saveMarket(market);
      fetched.push(market);
      if (market.conditionId) known.set(market.conditionId, market);
      known.set(market.id, market);
    }

    const refreshCandidates = cached
      .filter((market) => marketNeedsResolutionRefresh(market))
      .filter((market) => !fetched.some((candidate) => candidate.id === market.id))
      .slice(0, Math.max(0, backfillLimit - fetched.length));
    for (const candidate of refreshCandidates) {
      const market = await this.provider.getMarketById(candidate.conditionId ?? candidate.id);
      if (!market) continue;
      this.db.saveMarket(market);
      fetched.push(market);
      if (market.conditionId) known.set(market.conditionId, market);
      known.set(market.id, market);
    }

    if (ids.length > 0) {
      this.events.write({
        type: "market.resolution_backfill_completed",
        agent: "Signal Agent",
        message: "Backfilled market snapshots for source history.",
        payload: {
          requestedMarkets: ids.length,
          cachedMarkets: cached.length,
          fetchedMarkets: fetched.length,
          refreshedMarkets: refreshCandidates.length,
          skippedByLimit: Math.max(0, ids.filter((id) => !seedById.has(id)).length - backfillLimit)
        }
      });
    }

    return [...new Map([...seedMarkets, ...cached, ...fetched].map((market) => [market.id, market])).values()];
  }

  private runShadowBacktests(
    scores: WalletScore[],
    walletTrades: Map<string, WalletTrade[]>,
    markets: MarketSnapshot[],
    discoveryTrades: WalletTrade[]
  ): ShadowPerformanceResult {
    if (!this.config.shadowBacktestEnabled) return emptyShadowPerformance();
    const allObservedTrades = [...walletTrades.values()].flat().concat(discoveryTrades);
    const allShadowTrades = scores.flatMap((score) => {
      const trades = walletTrades.get(score.wallet.toLowerCase()) ?? [];
      if (trades.length === 0 || !this.shouldShadowAudit(score)) return [];
      return runShadowBacktest(
        score.wallet,
        trades.slice(-this.config.shadowHistoryLimit),
        markets,
        this.config,
        Date.now(),
        allObservedTrades
      );
    });
    if (allShadowTrades.length === 0) return emptyShadowPerformance();
    const saved = this.db.saveShadowTrades(allShadowTrades);
    const report = summarizeShadowBacktest(allShadowTrades);
    const byWallet = summarizeShadowPerformanceByWallet(allShadowTrades);
    const byWalletAndCategory = summarizeShadowPerformanceByWalletAndCategory(allShadowTrades);
    const categoryImpacts = buildCategoryImpactMap(byWalletAndCategory);
    this.events.write({
      type: "shadow.backtest_completed",
      agent: "Signal Agent",
      visibility: "PUBLIC",
      message: "Shadow-copy backtest updated.",
      payload: {
        shadowTrades: allShadowTrades.length,
        savedTrades: saved,
        simulated: report.simulated,
        skipped: report.skipped,
        pnl: report.pnl,
        winRate: report.winRate,
        avgReturnPct: report.avgReturnPct
      }
    });
    return { byWallet, categoryImpacts };
  }

  private shouldShadowAudit(score: WalletScore): boolean {
    const candidateMinScore = this.config.shadowCandidateMinScore ?? Math.max(0, this.config.minWalletScore - 25);
    const copyability = score.copyabilityScore ?? score.score;
    if (score.score >= this.config.minWalletScore) return true;
    if (score.label === "discovered" || score.label?.startsWith("discovered-")) {
      return score.score >= candidateMinScore || copyability >= candidateMinScore;
    }
    return copyability >= candidateMinScore && (score.sampleConfidence ?? 0) >= 0.35;
  }

  private deepHistoryWalletSet(configuredWallets: TrackedWallet[], discoveredScores: WalletScore[]): Set<string> {
    if (!this.config.deepHistoryEnabled) return new Set<string>();
    const configured = configuredWallets.map((wallet) => wallet.address.toLowerCase());
    const discovered = [...discoveredScores]
      .sort((a, b) => (b.copyabilityScore ?? b.score) - (a.copyabilityScore ?? a.score))
      .slice(0, Math.max(0, this.config.deepHistoryWalletLimit))
      .map((score) => score.wallet.toLowerCase());
    return new Set([...configured, ...discovered]);
  }
}

interface ShadowPerformanceResult {
  byWallet: Map<string, ShadowWalletPerformance>;
  categoryImpacts: Map<string, Partial<Record<MarketCategory, number>>>;
}

function emptyShadowPerformance(): ShadowPerformanceResult {
  return {
    byWallet: new Map<string, ShadowWalletPerformance>(),
    categoryImpacts: new Map<string, Partial<Record<MarketCategory, number>>>()
  };
}

function buildCategoryImpactMap(performance: Map<string, ShadowWalletPerformance>): Map<string, Partial<Record<MarketCategory, number>>> {
  const impacts = new Map<string, Partial<Record<MarketCategory, number>>>();
  for (const item of performance.values()) {
    if (!item.category) continue;
    const current = impacts.get(item.wallet) ?? {};
    current[item.category] = calculateShadowScoreImpact(item);
    impacts.set(item.wallet, current);
  }
  return impacts;
}

function marketIndex(markets: MarketSnapshot[]): Map<string, MarketSnapshot> {
  const index = new Map<string, MarketSnapshot>();
  for (const market of markets) {
    index.set(market.id, market);
    if (market.conditionId) index.set(market.conditionId, market);
  }
  return index;
}

function marketNeedsResolutionRefresh(market: MarketSnapshot, now = Date.now()): boolean {
  const ended = market.endDate ? Date.parse(market.endDate) <= now : false;
  const maybeResolved = market.closed || market.archived || ended;
  return maybeResolved && (!market.resolved || !market.winningOutcome);
}

function walletTradeKey(trade: WalletTrade): string {
  return [
    trade.wallet.toLowerCase(),
    trade.marketId,
    trade.conditionId ?? "",
    trade.tokenId ?? "",
    trade.outcome,
    trade.side,
    trade.price,
    trade.size,
    trade.timestamp
  ].join("|");
}

function mergeScores(configured: WalletScore[], discovered: WalletScore[]): WalletScore[] {
  const scores = new Map<string, WalletScore>();
  for (const score of discovered) scores.set(score.wallet.toLowerCase(), score);
  for (const score of configured) scores.set(score.wallet.toLowerCase(), score);
  return [...scores.values()].sort((a, b) => b.score - a.score);
}
