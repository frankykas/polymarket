import { ClobMarketWebSocket, makeClients } from "./src/clients.js";
import { loadBotConfig, loadRuntimeEnv, loadTrackedWallets } from "./src/config.js";
import { BotDatabase } from "./src/db.js";
import { OverseerAgent } from "./src/agents/overseerAgent.js";
import { RiskMitigationAgent } from "./src/agents/riskMitigationAgent.js";
import { SignalAgent } from "./src/agents/signalAgent.js";
import {
  PaperExecutionEngine,
  evaluateMarketQuality,
  type RiskState
} from "./src/engines.js";
import { AgentEventWriter } from "./src/events/eventWriter.js";
import { buildStrategyProfiles } from "./src/profiles/profiles.js";
import { PolymarketProvider } from "./src/providers/polymarketProvider.js";
import { TelegramAlerts } from "./src/telegram.js";
import type { MarketSnapshot, OrderBookSnapshot, PaperOrder, WalletScore } from "./src/types.js";

type Mode = "dev" | "scan" | "performance" | "shadow";

interface CycleResult {
  markets: MarketSnapshot[];
  scores: WalletScore[];
  discovered: number;
  discoveryTrades: number;
  signals: number;
  approved: number;
  rejected: number;
}

class PolymarketPaperBot {
  private env = loadRuntimeEnv();
  private config = loadBotConfig();
  private wallets = loadTrackedWallets();
  private clients = makeClients(this.env);
  private provider = new PolymarketProvider(this.clients);
  private db = new BotDatabase(this.env.dbPath);
  private events = new AgentEventWriter(this.db);
  private profiles = buildStrategyProfiles(this.config);
  private signalAgent = new SignalAgent(this.provider, this.db, this.events, this.config);
  private riskAgent = new RiskMitigationAgent(this.db, this.events, this.config, this.profiles);
  private overseerAgent = new OverseerAgent(this.db, this.events, this.config);
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

    if (mode === "performance") {
      console.log(this.plainPerformanceReport());
      this.db.close();
      return;
    }

    if (mode === "shadow") {
      await this.runCycle({ placePaperOrders: false });
      console.log(this.plainShadowReport());
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
      performance: () => this.telegramPerformance(),
      shadow: () => this.telegramShadow(),
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
    const result: CycleResult = { markets: [], scores: [], discovered: 0, discoveryTrades: 0, signals: 0, approved: 0, rejected: 0 };
    try {
      this.db.log("INFO", "cycle started", { placePaperOrders: options.placePaperOrders });
      const signalState = await this.signalAgent.discoverAndScore(this.wallets);
      result.markets = signalState.markets;
      result.discoveryTrades = signalState.discoveryTrades;
      result.discovered = signalState.discovered;
      result.scores = signalState.scores;
      if (options.placePaperOrders) this.ws.connect(signalState.markets.flatMap((market) => market.clobTokenIds));

      for (const market of signalState.markets) {
        const books = await this.getBooksForMarket(market);
        const quality = evaluateMarketQuality(market, books, this.config);
        const marketSignals = this.signalAgent.createSignals({
          market,
          books,
          trades: signalState.allTrades,
          scores: signalState.scores
        });
        result.signals += marketSignals.length;

        for (const signal of marketSignals) {
          const risk = this.riskAgent.decide(signal, quality, this.riskState());
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

  private async getBooksForMarket(market: MarketSnapshot): Promise<OrderBookSnapshot[]> {
    const books: OrderBookSnapshot[] = [];
    for (const tokenId of market.clobTokenIds) {
      const cached = this.orderBooks.get(tokenId);
      if (cached?.bestBid !== undefined && cached.bestAsk !== undefined) {
        books.push(cached);
        continue;
      }
      const book = await this.provider.getOrderBook(tokenId, market.id);
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
    for (const update of this.overseerAgent.monitor(this.orderBooks)) {
      if (update.closed) {
        void this.telegram.sendExit({
          outcome: update.position.outcome,
          marketId: update.position.marketId,
          reason: update.reason
        });
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
    console.log(`Discovery trades: ${result.discoveryTrades}`);
    console.log(`Signals: ${result.signals}`);
    console.log(`Approved: ${result.approved}`);
    console.log(`Rejected: ${result.rejected}`);
    const shadow = this.db.getShadowBacktestReport();
    console.log(`Shadow simulated: ${shadow.simulated}`);
    console.log(`Shadow PnL: $${shadow.pnl.toFixed(2)}`);
    if (result.scores.length === 0) {
      console.log("No enabled wallets. Add addresses to config/wallets.json to generate wallet-following signals.");
    } else {
      for (const score of result.scores) {
        const details = score.dominantCategory
          ? ` category=${score.dominantCategory} catScore=${score.categoryConsistencyScore ?? 0} hot=${score.hotScore ?? 0} evidence=${Math.round((score.sampleConfidence ?? 0) * 100)}%`
          : "";
        console.log(`${score.wallet} score=${score.score} reliability=${score.reliability} trades=${score.tradeCount}${details}`);
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
      `Discovery trades: <b>${result?.discoveryTrades ?? 0}</b>`,
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
      `Discovery trades: <b>${result.discoveryTrades}</b>`,
      `Signals: <b>${result.signals}</b>`,
      `Approved: <b>${result.approved}</b>`,
      `Rejected: <b>${result.rejected}</b>`,
      "",
      ...this.topWalletPreviewLines(5)
    ].join("\n");
  }

  private telegramRisk(): string {
    return [
      "🛡 <b>Risk Rules</b>",
      "",
      `Bankroll: <b>$${this.config.bankroll}</b>`,
      `Min position: <b>$${this.config.minPositionSize}</b>`,
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
        `Category ${wallet.dominantCategory} | Cat ${wallet.categoryConsistencyScore}/100 | Hot ${wallet.hotScore}/100 | Evidence ${(wallet.sampleConfidence * 100).toFixed(0)}%`,
        `Trades ${wallet.tradeCount} | Markets ${wallet.uniqueMarkets} | Vol $${wallet.totalVolume.toFixed(0)}`,
        `Open value~ $${wallet.openPositionValue.toFixed(2)} | Open PnL~ $${wallet.openPositionPnlApprox.toFixed(2)}`,
        `PnL~ $${wallet.realizedPnlApprox.toFixed(2)} | Win~ ${(wallet.winRateApprox * 100).toFixed(0)}% | Return~ ${(wallet.avgReturnPctApprox * 100).toFixed(1)}%`,
        `DD~ ${(wallet.maxDrawdownApprox * 100).toFixed(0)}% | Hold~ ${wallet.avgHoldMinutesApprox.toFixed(0)}m`,
        wallet.flags.length ? `Flags: ${wallet.flags.join(", ")}` : "Flags: clean",
        ""
      ])
    ].join("\n");
  }

  private telegramPerformance(): string {
    const report = this.db.getPerformanceReport();
    return [
      "📈 <b>Paper Performance</b>",
      "",
      `Total PnL: <b>$${report.totalPnl.toFixed(2)}</b>`,
      `Realized: <b>$${report.realizedPnl.toFixed(2)}</b>`,
      `Unrealized: <b>$${report.unrealizedPnl.toFixed(2)}</b>`,
      `Open positions: <b>${report.openPositions}</b>`,
      `Closed positions: <b>${report.closedPositions}</b>`,
      `Win rate: <b>${(report.winRate * 100).toFixed(0)}%</b>`,
      `Wins/Losses: <b>${report.wins}/${report.losses}</b>`,
      `Signals: <b>${report.signals}</b>`,
      `Paper orders: <b>${report.paperOrders}</b>`,
      `Paper fills: <b>${report.paperFills}</b>`
    ].join("\n");
  }

  private telegramShadow(): string {
    const report = this.db.getShadowBacktestReport();
    return [
      "ðŸ§ª <b>Shadow Copy Backtest</b>",
      "",
      `Total candidates: <b>${report.total}</b>`,
      `Simulated: <b>${report.simulated}</b>`,
      `Skipped: <b>${report.skipped}</b>`,
      `PnL: <b>$${report.pnl.toFixed(2)}</b>`,
      `Average return: <b>${(report.avgReturnPct * 100).toFixed(1)}%</b>`,
      `Win rate: <b>${(report.winRate * 100).toFixed(0)}%</b>`,
      `Wins/Losses: <b>${report.wins}/${report.losses}</b>`
    ].join("\n");
  }

  private plainPerformanceReport(): string {
    const report = this.db.getPerformanceReport();
    return [
      "StratiFi Paper Performance",
      "",
      `Total PnL: $${report.totalPnl.toFixed(2)}`,
      `Realized: $${report.realizedPnl.toFixed(2)}`,
      `Unrealized: $${report.unrealizedPnl.toFixed(2)}`,
      `Open positions: ${report.openPositions}`,
      `Closed positions: ${report.closedPositions}`,
      `Win rate: ${(report.winRate * 100).toFixed(0)}%`,
      `Wins/Losses: ${report.wins}/${report.losses}`,
      `Signals: ${report.signals}`,
      `Paper orders: ${report.paperOrders}`,
      `Paper fills: ${report.paperFills}`
    ].join("\n");
  }

  private plainShadowReport(): string {
    const report = this.db.getShadowBacktestReport();
    return [
      "StratiFi Shadow Copy Backtest",
      "",
      `Total candidates: ${report.total}`,
      `Simulated: ${report.simulated}`,
      `Skipped: ${report.skipped}`,
      `PnL: $${report.pnl.toFixed(2)}`,
      `Average return: ${(report.avgReturnPct * 100).toFixed(1)}%`,
      `Win rate: ${(report.winRate * 100).toFixed(0)}%`,
      `Wins/Losses: ${report.wins}/${report.losses}`
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

  private topWalletPreviewLines(limit: number): string[] {
    const wallets = this.db.getTopDiscoveredWallets(limit);
    if (wallets.length === 0) return ["No top-wallet preview yet. Try /discover again."];
    return [
      "🏆 <b>Top Wallet Preview</b>",
      ...wallets.map((wallet, index) =>
        `${index + 1}. <code>${wallet.address}</code> copy=${wallet.copyabilityScore} cat=${wallet.dominantCategory}/${wallet.categoryConsistencyScore} evidence=${(wallet.sampleConfidence * 100).toFixed(0)}% trades=${wallet.tradeCount}`
      )
    ];
  }
}

const arg = process.argv[2];
const mode = (arg === "dev" || arg === "performance" || arg === "shadow" ? arg : "scan") satisfies Mode;
const bot = new PolymarketPaperBot();
await bot.start(mode);
