import { loadBotConfig, loadRuntimeEnv } from "./config.js";
import { BotDatabase } from "./db.js";
import { generateSignalsWithDiagnostics, type SignalDropDiagnostics } from "./engines.js";
import type { MarketSnapshot, OrderBookSnapshot, TradeSignal } from "./types.js";

const config = loadBotConfig();
const env = loadRuntimeEnv();
const db = new BotDatabase(env.dbPath);

try {
  const walletLimit = config.replayAuditWalletLimit ?? config.liveExecutableAutoTrackLimit ?? 25;
  const lookbackHours = config.replayAuditLookbackHours ?? 24;
  const cutoff = Date.now() - lookbackHours * 3_600_000;
  const scores = db.getTopDurableLiveExecutableWalletScores({
    limit: walletLimit,
    minWalletScore: config.minWalletScore,
    minTrades: config.minLiveExecutableShadowTradesForTrading ?? 8,
    minPnl: config.minLiveExecutableShadowPnlForTrading ?? 0,
    minReturnPct: config.liveExecutableMinReturnPct ?? 0.03,
    minSourceSellRatio: config.minSourceSellRealizedRatio ?? 0.35
  });
  const walletSet = new Set(scores.map((score) => score.wallet.toLowerCase()));
  const trades = scores
    .flatMap((score) => db.getWalletTradeHistory(score.wallet, Math.max(config.walletActivityLimit, 1000)))
    .filter((trade) => walletSet.has(trade.wallet.toLowerCase()))
    .filter((trade) => trade.timestamp >= cutoff);
  const marketIds = [...new Set(trades.flatMap((trade) => [trade.marketId, trade.conditionId]).filter((id): id is string => Boolean(id)))];
  const markets = db.getMarketsByIds(marketIds);
  const marketById = marketIndex(markets);
  const tokenIds = [...new Set([
    ...trades.map((trade) => trade.tokenId).filter((id): id is string => Boolean(id)),
    ...markets.flatMap((market) => market.clobTokenIds)
  ])];
  const books = db.getLatestOrderBooksForTokens(tokenIds);
  const booksByToken = new Map(books.map((book) => [book.tokenId, book]));
  const aggregate = emptyDiagnostics();
  const signals: TradeSignal[] = [];
  let replayedMarkets = 0;

  for (const market of markets) {
    const marketTrades = trades.filter((trade) => trade.marketId === market.id || trade.marketId === market.conditionId || trade.conditionId === market.id || trade.conditionId === market.conditionId);
    if (marketTrades.length === 0) continue;
    replayedMarkets += 1;
    const marketBooks = market.clobTokenIds.map((tokenId) => booksByToken.get(tokenId)).filter((book): book is OrderBookSnapshot => Boolean(book));
    const result = generateSignalsWithDiagnostics(market, marketBooks, marketTrades, scores, config);
    mergeDiagnostics(aggregate, result.diagnostics);
    signals.push(...result.signals);
  }

  const candidates = signals.filter((signal) => signal.decision === "TRADE_CANDIDATE");
  const watchlist = signals.filter((signal) => signal.decision === "WATCHLIST");
  const staleBooks = books.filter((book) => Date.now() - book.timestamp > (config.maxOrderBookAgeMs ?? 60_000)).length;
  console.log("Live-Gate Replay Audit");
  console.log(`Lookback: ${lookbackHours}h`);
  console.log(`Wallets: ${scores.length}`);
  console.log(`Recent wallet trades: ${trades.length}`);
  console.log(`Markets replayed: ${replayedMarkets}/${markets.length}`);
  console.log(`Cached books: ${books.length} (${staleBooks} stale)`);
  console.log(`Signals: ${signals.length} | candidates: ${candidates.length} | watchlist: ${watchlist.length}`);
  console.log("");
  console.log("Drop Reasons");
  for (const item of topEntries(aggregate.dropReasons, 15)) console.log(`- ${item.reason}: ${item.count}`);
  console.log("");
  console.log("Source Reject Reasons");
  for (const item of topEntries(aggregate.sourceRejectReasons, 15)) console.log(`- ${item.reason}: ${item.count}`);
  if (signals.length > 0) {
    console.log("");
    console.log("Top Signals");
    for (const signal of signals.slice(0, 10)) {
      const market = marketById.get(signal.marketId);
      console.log(`- ${signal.decision} ${signal.outcome} ${signal.marketId} conf=${signal.confidence} price=${signal.limitPrice.toFixed(3)} parity=${signal.parityStatus ?? "UNKNOWN"} depth=${(signal.entryDepthMultiple ?? 0).toFixed(2)}x ${market?.question ?? ""}`);
    }
  }
} finally {
  db.close();
}

function emptyDiagnostics(): SignalDropDiagnostics {
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

function mergeDiagnostics(target: SignalDropDiagnostics, source: SignalDropDiagnostics): void {
  target.totalTrades += source.totalTrades;
  target.buyTrades += source.buyTrades;
  target.scoredBuyTrades += source.scoredBuyTrades;
  target.groupedMarkets += source.groupedMarkets;
  target.emittedSignals += source.emittedSignals;
  target.tradeCandidates += source.tradeCandidates;
  target.watchlist += source.watchlist;
  mergeCounts(target.dropReasons, source.dropReasons);
  mergeCounts(target.sourceRejectReasons, source.sourceRejectReasons);
}

function mergeCounts(target: Record<string, number>, source: Record<string, number>): void {
  for (const [key, count] of Object.entries(source)) target[key] = (target[key] ?? 0) + count;
}

function topEntries(record: Record<string, number>, limit: number): Array<{ reason: string; count: number }> {
  return Object.entries(record)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function marketIndex(markets: MarketSnapshot[]): Map<string, MarketSnapshot> {
  const index = new Map<string, MarketSnapshot>();
  for (const market of markets) {
    index.set(market.id, market);
    if (market.conditionId) index.set(market.conditionId, market);
  }
  return index;
}
