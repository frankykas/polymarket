import type { BotDatabase } from "../db.js";
import {
  discoverWallets,
  generateSignals,
  scoreDiscoveredWallet,
  scoreWallet
} from "../engines.js";
import type { AgentEventWriter } from "../events/eventWriter.js";
import type { PolymarketProvider } from "../providers/polymarketProvider.js";
import type {
  BotConfig,
  MarketSnapshot,
  OrderBookSnapshot,
  TradeSignal,
  TrackedWallet,
  WalletScore,
  WalletTrade
} from "../types.js";

const MARKET_BACKFILL_LIMIT = 80;

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

    const discoveredScores = this.config.autoTrackDiscoveredWallets
      ? discoveredWallets.map((wallet) => scoreDiscoveredWallet(wallet)).filter((score) => score.score >= this.config.minWalletScore)
      : [];
    const trackedWallets = [...wallets];
    for (const wallet of discoveredScores) {
      if (!trackedWallets.some((tracked) => tracked.address.toLowerCase() === wallet.wallet.toLowerCase())) {
        trackedWallets.push({ address: wallet.wallet, label: "discovered", enabled: true });
      }
    }
    this.db.syncWallets(trackedWallets);

    const walletTrades = await this.fetchWalletTrades(trackedWallets);
    const historyMarkets = await this.backfillMarketSnapshots([...walletTrades.values()].flat(), watchedMarkets);
    const configuredScores = wallets.map((wallet) =>
      scoreWallet(wallet, walletTrades.get(wallet.address.toLowerCase()) ?? [], Date.now(), historyMarkets)
    );
    const scores = mergeScores(configuredScores, discoveredScores);
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

  async fetchWalletTrades(wallets: TrackedWallet[]): Promise<Map<string, WalletTrade[]>> {
    const trades = new Map<string, WalletTrade[]>();
    for (const wallet of wallets) {
      const walletTrades = await this.provider.getWalletTrades(wallet.address, this.config.walletActivityLimit);
      const inserted = this.db.saveWalletTrades(walletTrades);
      const history = this.db.getWalletTradeHistory(wallet.address, Math.max(this.config.walletActivityLimit, 500));
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
            historyTrades: history.length
          }
        });
      }
    }
    return trades;
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
    const missing = ids.filter((id) => !known.has(id)).slice(0, MARKET_BACKFILL_LIMIT);
    const fetched: MarketSnapshot[] = [];

    for (const id of missing) {
      const market = await this.provider.getMarketById(id);
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
          skippedByLimit: Math.max(0, ids.filter((id) => !seedById.has(id)).length - missing.length)
        }
      });
    }

    return [...new Map([...seedMarkets, ...cached, ...fetched].map((market) => [market.id, market])).values()];
  }
}

function marketIndex(markets: MarketSnapshot[]): Map<string, MarketSnapshot> {
  const index = new Map<string, MarketSnapshot>();
  for (const market of markets) {
    index.set(market.id, market);
    if (market.conditionId) index.set(market.conditionId, market);
  }
  return index;
}

function mergeScores(configured: WalletScore[], discovered: WalletScore[]): WalletScore[] {
  const scores = new Map<string, WalletScore>();
  for (const score of discovered) scores.set(score.wallet.toLowerCase(), score);
  for (const score of configured) scores.set(score.wallet.toLowerCase(), score);
  return [...scores.values()].sort((a, b) => b.score - a.score);
}
