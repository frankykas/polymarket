import { ClobMarketWebSocket, makeClients } from "./src/clients.js";
import { loadBotConfig, loadRuntimeEnv, loadTrackedWallets } from "./src/config.js";
import { BotDatabase } from "./src/db.js";
import {
  PaperExecutionEngine,
  decideExit,
  decideRisk,
  discoverWallets,
  evaluateMarketQuality,
  generateSignals,
  scoreDiscoveredWallet,
  scoreWallet,
  type RiskState
} from "./src/engines.js";
import { TelegramAlerts } from "./src/telegram.js";
import type { MarketSnapshot, OrderBookSnapshot, PaperOrder, WalletScore, WalletTrade } from "./src/types.js";

type Mode = "dev" | "scan";

interface CycleResult {
  markets: MarketSnapshot[];
  scores: WalletScore[];
  discovered: number;
  signals: number;
  approved: number;
  rejected: number;
}

class PolymarketPaperBot {
  private env = loadRuntimeEnv();
  private config = loadBotConfig();
  private wallets = loadTrackedWallets();
  private clients = makeClients(this.env);
  private db = new BotDatabase(this.env.dbPath);
  private telegram = new TelegramAlerts(this.env);
  private executor = new PaperExecutionEngine();
  private orderBooks = new Map<string, OrderBookSnapshot>();
  private openOrders = new Map<string, PaperOrder>();
  private ws = new ClobMarketWebSocket(this.env.clobWsUrl);
  private paused = false;
  private lastResult?: CycleResult;
  private lastCycleAt?: number;

  async start(mode: Mode): Promise<void> {
    this.db.syncWallets(this.wallets);
    this.ws.onUpdate((update) => {
      const previous = this.orderBooks.get(update.tokenId);
      this.orderBooks.set(update.tokenId, {
        tokenId: update.tokenId,
        marketId: update.marketId ?? previous?.marketId,
        bids: previous?.bids ?? [],
        asks: previous?.asks ?? [],
        bestBid: update.bestBid ?? previous?.bestBid,
        bestAsk: update.bestAsk ?? previous?.bestAsk,
        spread: update.spread ?? previous?.spread,
        depth: update.depth ?? previous?.depth ?? 0,
        lastTradePrice: update.lastTradePrice ?? previous?.lastTradePrice,
        timestamp: update.timestamp ?? Date.now(),
        raw: update.raw ?? previous?.raw
      });
    });

    if (mode === "scan") {
      const result = await this.runCycle({ placePaperOrders: false });
      this.printSummary(result);
      this.db.close();
      return;
    }

    console.log("Starting Polymarket paper bot. No live trading code path is enabled.");
    this.telegram.startCommandLoop({
      status: () => this.telegramStatus(),
      scan: () => this.telegramScan(),
      risk: () => this.telegramRisk(),
      wallets: () => this.telegramWallets(),
      topWallets: () => this.telegramTopWallets(),
      pause: () => this.telegramPause(),
      resume: () => this.telegramResume()
    });
    await this.telegram.sendStartup();
    await this.runCycle({ placePaperOrders: true });
    setInterval(() => {
      if (this.paused) return;
      this.runCycle({ placePaperOrders: true }).catch((error) => this.handleError(error));
    }, this.config.scanIntervalMs);
  }

  private async runCycle(options: { placePaperOrders: boolean }): Promise<CycleResult> {
    const result: CycleResult = { markets: [], scores: [], discovered: 0, signals: 0, approved: 0, rejected: 0 };
    try {
      this.db.log("INFO", "cycle started", { placePaperOrders: options.placePaperOrders });
      const markets = await this.clients.gamma.getMarkets(this.config.marketScanLimit);
      const watchedMarkets = markets.slice(0, this.config.maxWatchedMarkets);
      result.markets = watchedMarkets;
      for (const market of watchedMarkets) this.db.saveMarket(market);
      if (options.placePaperOrders) this.ws.connect(watchedMarkets.flatMap((market) => market.clobTokenIds));

      const discoveryTrades = this.config.discoveryEnabled ? await this.fetchDiscoveryTrades(watchedMarkets) : [];
      const discovered = this.config.discoveryEnabled ? discoverWallets(discoveryTrades, this.config) : [];
      for (const wallet of discovered) this.db.saveDiscoveredWallet(wallet);
      result.discovered = discovered.length;

      const discoveredScores = this.config.autoTrackDiscoveredWallets
        ? discovered.map((wallet) => scoreDiscoveredWallet(wallet)).filter((score) => score.score >= this.config.minWalletScore)
        : [];
      const trackedWallets = [...this.wallets];
      for (const wallet of discoveredScores) {
        if (!trackedWallets.some((tracked) => tracked.address === wallet.wallet)) {
          trackedWallets.push({ address: wallet.wallet, label: "discovered", enabled: true });
        }
      }
      this.db.syncWallets(trackedWallets);

      const walletTrades = await this.fetchWalletTrades(trackedWallets);
      const configuredScores = this.wallets.map((wallet) => scoreWallet(wallet, walletTrades.get(wallet.address) ?? []));
      const scores = mergeScores(configuredScores, discoveredScores);
      for (const score of scores) this.db.saveWalletScore(score);
      result.scores = scores;

      const allTrades = [...walletTrades.values()].flat();
      for (const trade of discoveryTrades) {
        if (scores.some((score) => score.wallet === trade.wallet)) allTrades.push(trade);
      }
      for (const market of watchedMarkets) {
        const books = await this.getBooksForMarket(market);
        const quality = evaluateMarketQuality(market, books, this.config);
        const marketSignals = generateSignals(market, books, allTrades, scores, this.config);
        result.signals += marketSignals.length;

        for (const signal of marketSignals) {
          this.db.saveSignal(signal);
          const risk = decideRisk(signal, quality, this.riskState(), this.config);
          this.db.saveRiskDecision(risk);
          if (risk.decision === "APPROVE" || risk.decision === "REDUCE_SIZE") {
            result.approved += 1;
            await this.telegram.sendApproved({
              outcome: signal.outcome,
              question: market.question,
              price: signal.limitPrice,
              size: risk.positionSize,
              confidence: signal.confidence
            });
            if (options.placePaperOrders) this.placeAndSimulate(signal, risk, books);
          } else {
            result.rejected += 1;
            if (signal.decision === "TRADE_CANDIDATE") {
              await this.telegram.sendRejected({ question: market.question, reason: risk.reason });
            }
          }
        }
      }

      if (options.placePaperOrders) this.monitorOpenPositions();
      this.db.log("INFO", "cycle completed", result);
      this.lastResult = result;
      this.lastCycleAt = Date.now();
      return result;
    } catch (error) {
      this.handleError(error);
      return result;
    }
  }

  private async fetchWalletTrades(wallets = this.wallets): Promise<Map<string, WalletTrade[]>> {
    const trades = new Map<string, WalletTrade[]>();
    for (const wallet of wallets) {
      const walletTrades = await this.clients.data.getWalletTrades(wallet.address, this.config.walletActivityLimit);
      trades.set(wallet.address, walletTrades);
    }
    return trades;
  }

  private async fetchDiscoveryTrades(markets: MarketSnapshot[]): Promise<WalletTrade[]> {
    const trades: WalletTrade[] = [];
    const discoveryMarkets = markets.slice(0, this.config.discoveryMarketLimit);
    for (const market of discoveryMarkets) {
      const marketTrades = await this.clients.data.getMarketTrades(market.conditionId ?? market.id, this.config.discoveryTradesPerMarket);
      trades.push(...marketTrades);
    }
    return trades;
  }

  private async getBooksForMarket(market: MarketSnapshot): Promise<OrderBookSnapshot[]> {
    const books: OrderBookSnapshot[] = [];
    for (const tokenId of market.clobTokenIds) {
      const cached = this.orderBooks.get(tokenId);
      if (cached?.bestBid !== undefined && cached.bestAsk !== undefined) {
        books.push(cached);
        continue;
      }
      const book = await this.clients.clob.getOrderBook(tokenId, market.id);
      if (book) {
        this.orderBooks.set(tokenId, book);
        this.db.saveOrderBook(book);
        books.push(book);
      }
    }
    return books;
  }

  private placeAndSimulate(signal: Parameters<PaperExecutionEngine["createOrder"]>[0], risk: Parameters<PaperExecutionEngine["createOrder"]>[1], books: OrderBookSnapshot[]): void {
    const order = this.executor.createOrder(signal, risk, this.config);
    const book = books.find((candidate) => candidate.tokenId === order.tokenId);
    if (!book) return;
    const simulated = this.executor.simulate(order, book);
    this.openOrders.set(simulated.order.id, simulated.order);
    this.db.savePaperOrder(simulated.order);
    if (simulated.fill) this.db.saveFill(simulated.fill);
    if (simulated.position) this.db.savePosition(simulated.position);
  }

  private monitorOpenPositions(): void {
    for (const position of this.db.getOpenPositions()) {
      const book = this.orderBooks.get(position.tokenId);
      if (!book) continue;
      const exit = decideExit(position, book, this.config);
      this.db.saveExitDecision(position.id, exit);
      if (exit.decision === "FULL_EXIT") {
        const currentPrice = book.bestBid ?? position.currentPrice;
        this.db.savePosition({
          ...position,
          currentPrice,
          realizedPnl: (currentPrice - position.avgEntryPrice) * position.size,
          updatedAt: Date.now(),
          status: "CLOSED"
        });
        void this.telegram.sendExit({ outcome: position.outcome, marketId: position.marketId, reason: exit.reason });
      }
    }
  }

  private riskState(): RiskState {
    return {
      openExposure: this.db.getOpenExposure(),
      dailyPnl: this.db.getDailyRealizedPnl(),
      lossStreak: 0,
      tradesToday: 0
    };
  }

  private printSummary(result: CycleResult): void {
    console.log("Polymarket paper scan complete");
    console.log(`Wallets scored: ${result.scores.length}`);
    console.log(`Markets scanned: ${result.markets.length}`);
    console.log(`Discovered wallets: ${result.discovered}`);
    console.log(`Signals: ${result.signals}`);
    console.log(`Approved: ${result.approved}`);
    console.log(`Rejected: ${result.rejected}`);
    if (result.scores.length === 0) {
      console.log("No enabled wallets. Add addresses to config/wallets.json to generate wallet-following signals.");
    } else {
      for (const score of result.scores) {
        console.log(`${score.wallet} score=${score.score} reliability=${score.reliability} trades=${score.tradeCount}`);
      }
    }
  }

  private handleError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    this.db.log("ERROR", message);
    void this.telegram.sendError(message);
  }

  private telegramStatus(): string {
    const result = this.lastResult;
    const lastCycle = this.lastCycleAt ? new Date(this.lastCycleAt).toLocaleString() : "never";
    return [
      "📊 <b>Bot Status</b>",
      "",
      "Mode: <b>Paper trading</b>",
      `State: <b>${this.paused ? "Paused" : "Running"}</b>`,
      `Last cycle: <b>${lastCycle}</b>`,
      `Markets: <b>${result?.markets.length ?? 0}</b>`,
      `Wallets scored: <b>${result?.scores.length ?? 0}</b>`,
      `Discovered wallets: <b>${result?.discovered ?? 0}</b>`,
      `Signals: <b>${result?.signals ?? 0}</b>`,
      `Approved: <b>${result?.approved ?? 0}</b>`,
      `Rejected: <b>${result?.rejected ?? 0}</b>`,
      `Open exposure: <b>$${this.db.getOpenExposure().toFixed(2)}</b>`
    ].join("\n");
  }

  private async telegramScan(): Promise<string> {
    const result = await this.runCycle({ placePaperOrders: false });
    return [
      "🔎 <b>Manual Scan Complete</b>",
      "",
      `Markets scanned: <b>${result.markets.length}</b>`,
      `Wallets scored: <b>${result.scores.length}</b>`,
      `Discovered wallets: <b>${result.discovered}</b>`,
      `Signals: <b>${result.signals}</b>`,
      `Approved: <b>${result.approved}</b>`,
      `Rejected: <b>${result.rejected}</b>`
    ].join("\n");
  }

  private telegramRisk(): string {
    return [
      "🛡 <b>Risk Rules</b>",
      "",
      `Bankroll: <b>$${this.config.bankroll}</b>`,
      `Max position: <b>$${this.config.maxPositionSize}</b>`,
      `Max open exposure: <b>$${this.config.maxOpenExposure}</b>`,
      `Daily loss stop: <b>$${this.config.maxDailyLoss}</b>`,
      `Loss streak pause: <b>${this.config.maxLossStreak}</b>`,
      `Min confidence: <b>${this.config.minSignalConfidence}</b>`,
      `Max spread: <b>${this.config.maxSpread}</b>`,
      `Open exposure now: <b>$${this.db.getOpenExposure().toFixed(2)}</b>`,
      `Daily PnL now: <b>$${this.db.getDailyRealizedPnl().toFixed(2)}</b>`
    ].join("\n");
  }

  private telegramWallets(): string {
    const discovered = this.db.getTopDiscoveredWallets(10);
    if (this.wallets.length === 0 && discovered.length === 0) {
      return [
        "👛 <b>Tracked Wallets</b>",
        "",
        "No enabled or discovered wallets yet.",
        "Run /scan to discover wallets from recent Polymarket trades."
      ].join("\n");
    }
    return [
      "👛 <b>Tracked Wallets</b>",
      "",
      ...this.wallets.map((wallet) => `• <code>${wallet.address}</code>${wallet.label ? ` - ${wallet.label}` : ""}`),
      "",
      "🔍 <b>Top Discovered</b>",
      ...discovered.map((wallet) => `• <code>${wallet.address}</code> copy=${wallet.copyabilityScore} score=${wallet.score} trades=${wallet.tradeCount}`)
    ].join("\n");
  }

  private telegramTopWallets(): string {
    const wallets = this.db.getTopDiscoveredWallets(10);
    if (wallets.length === 0) {
      return "🏆 <b>Top Wallets</b>\n\nNo wallet intelligence yet. Run /discover first.";
    }
    return [
      "🏆 <b>Top Wallet Intelligence</b>",
      "",
      ...wallets.flatMap((wallet, index) => [
        `<b>${index + 1}. Copy ${wallet.copyabilityScore}/100 | Score ${wallet.score}/100</b>`,
        `<code>${wallet.address}</code>`,
        `Trades ${wallet.tradeCount} | Markets ${wallet.uniqueMarkets} | Vol $${wallet.totalVolume.toFixed(0)}`,
        `PnL~ $${wallet.realizedPnlApprox.toFixed(2)} | Win~ ${(wallet.winRateApprox * 100).toFixed(0)}% | Return~ ${(wallet.avgReturnPctApprox * 100).toFixed(1)}%`,
        `DD~ ${(wallet.maxDrawdownApprox * 100).toFixed(0)}% | Hold~ ${wallet.avgHoldMinutesApprox.toFixed(0)}m`,
        wallet.flags.length ? `Flags: ${wallet.flags.join(", ")}` : "Flags: clean",
        ""
      ])
    ].join("\n");
  }

  private telegramPause(): string {
    this.paused = true;
    this.db.log("WARN", "bot paused from Telegram");
    return "⏸ <b>Bot paused.</b>\n\nNo scheduled cycles will run until /resume.";
  }

  private telegramResume(): string {
    this.paused = false;
    this.db.log("INFO", "bot resumed from Telegram");
    return "▶️ <b>Bot resumed.</b>\n\nScheduled paper scans are active.";
  }
}

const mode = (process.argv[2] === "dev" ? "dev" : "scan") satisfies Mode;
const bot = new PolymarketPaperBot();
await bot.start(mode);

function mergeScores(configured: WalletScore[], discovered: WalletScore[]): WalletScore[] {
  const scores = new Map<string, WalletScore>();
  for (const score of discovered) scores.set(score.wallet, score);
  for (const score of configured) scores.set(score.wallet, score);
  return [...scores.values()].sort((a, b) => b.score - a.score);
}
