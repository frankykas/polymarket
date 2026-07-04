import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ClobMarketWebSocket, makeClients } from "./src/clients.js";
import { loadBotConfig, loadRuntimeEnv, loadTrackedWallets } from "./src/config.js";
import { BotDatabase } from "./src/db.js";
import { DecisionCouncil } from "./src/agents/decisionCouncil.js";
import { MarketIntelligenceAgent } from "./src/agents/marketIntelligenceAgent.js";
import { applyMicrostructureToQuality, MicrostructureAgent } from "./src/agents/microstructureAgent.js";
import { OverseerAgent } from "./src/agents/overseerAgent.js";
import { RiskMitigationAgent } from "./src/agents/riskMitigationAgent.js";
import { SignalAgent } from "./src/agents/signalAgent.js";
import { WalletIntelligenceAgent } from "./src/agents/walletIntelligenceAgent.js";
import {
  PaperExecutionEngine,
  evaluateMarketQuality,
  type RiskState
} from "./src/engines.js";
import { AgentEventWriter } from "./src/events/eventWriter.js";
import { buildStrategyProfiles } from "./src/profiles/profiles.js";
import { PolymarketProvider } from "./src/providers/polymarketProvider.js";
import { TelegramAlerts } from "./src/telegram.js";
import { exportPaperTradeLedgerFile } from "./src/paperTradeLedgerFile.js";
import type { MarketSnapshot, OrderBookSnapshot, PaperOrder, Position, WalletScore } from "./src/types.js";

type Mode = "dev" | "scan" | "performance" | "shadow";
const devPidPath = "data/polymarket-paper-bot.dev.pid";

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
  private marketIntelligenceAgent = new MarketIntelligenceAgent(this.events);
  private microstructureAgent = new MicrostructureAgent(this.events);
  private walletIntelligenceAgent = new WalletIntelligenceAgent(this.events);
  private decisionCouncil = new DecisionCouncil(this.events);
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
  private lastBankrollSummaryAt = 0;

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
    this.registerDevPid();
    this.telegram.startCommandLoop({
      status: () => this.telegramStatus(),
      scan: () => this.telegramScan(),
      risk: () => this.telegramRisk(),
      riskLog: () => this.telegramRiskLog(),
      wallets: () => this.telegramWallets(),
      topWallets: () => this.telegramTopWallets(),
      agents: () => this.telegramAgents(),
      bankroll: () => this.telegramBankroll(),
      ledger: () => this.telegramLedger(),
      performance: () => this.telegramPerformance(),
      positions: () => this.telegramPositions(),
      close: (positionRef) => this.telegramClosePosition(positionRef),
      closeAll: (confirmed) => this.telegramCloseAllPositions(confirmed),
      shadow: () => this.telegramShadow(),
      pause: () => this.telegramPause(),
      resume: () => this.telegramResume()
    });
    await this.telegram.sendStartup();
    await this.runCycle({ placePaperOrders: true });
    setInterval(() => {
      if (this.paused) return;
      this.monitorOpenPositions().catch((error) => this.handleError(error));
    }, Math.max(15_000, Math.min(60_000, Math.floor(this.config.scanIntervalMs / 2))));
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
      if (options.placePaperOrders) {
        const watchedTokenIds = signalState.markets.flatMap((market) => market.clobTokenIds);
        this.pruneRuntimeCaches(watchedTokenIds);
        this.ws.connect(watchedTokenIds);
      }
      this.events.write({
        type: "agent.cycle_completed",
        agent: "Signal Agent",
        visibility: "PUBLIC",
        message: `Signal Agent scanned ${signalState.markets.length} markets and scored ${signalState.scores.length} sources.`,
        payload: {
          markets: signalState.markets.length,
          sources: signalState.scores.length,
          discovered: signalState.discovered,
          discoveryTrades: signalState.discoveryTrades
        }
      });
      const rejectedReasons = new Map<string, number>();

      for (const market of signalState.markets) {
        const books = await this.getBooksForMarket(market);
        const microstructure = this.microstructureAgent.review(market, books, this.config);
        const quality = applyMicrostructureToQuality(evaluateMarketQuality(market, books, this.config), microstructure);
        const marketSignals = this.signalAgent.createSignals({
          market,
          books,
          trades: signalState.allTrades,
          scores: signalState.scores
        });
        result.signals += marketSignals.length;

        for (const signal of marketSignals) {
          const walletIntelligence = this.walletIntelligenceAgent.reviewSignal(signal, signalState.scores, signalState.allTrades);
          const marketIntelligence = this.marketIntelligenceAgent.review({
            market,
            signal,
            books,
            scores: signalState.scores,
            walletIntelligence
          });
          const state = this.riskState();
          const debate = this.decisionCouncil.review({
            signal,
            quality,
            riskState: state,
            config: this.config,
            marketIntelligence,
            microstructure,
            walletIntelligence
          });
          const risk = this.riskAgent.decide(signal, quality, state, {
            marketIntelligence,
            microstructure,
            walletIntelligence,
            debate
          });
          if (risk.decision === "APPROVE" || risk.decision === "REDUCE_SIZE") {
            result.approved += 1;
            await this.telegram.sendApproved({
              outcome: signal.outcome,
              question: market.question,
              price: signal.limitPrice,
              size: risk.positionSize,
              confidence: signal.confidence
            });
            if (options.placePaperOrders) await this.placeAndSimulate(signal, risk, books);
          } else {
            result.rejected += 1;
            if (signal.decision === "TRADE_CANDIDATE") {
              rejectedReasons.set(risk.reason, (rejectedReasons.get(risk.reason) ?? 0) + 1);
            }
          }
        }
      }

      if (options.placePaperOrders && rejectedReasons.size > 0) {
        const exposure = this.db.getExposureHealthReport(this.config.maxOpenExposure, this.config.bankroll, this.config.reserveCashPct);
        await this.telegram.sendRejectedSummary({
          rejected: [...rejectedReasons.values()].reduce((sum, count) => sum + count, 0),
          reasons: rejectedReasons,
          exposure: {
            openExposure: exposure.openExposure,
            maxOpenExposure: exposure.maxOpenExposure,
            activeExposureCap: exposure.activeExposureCap,
            remainingExposure: exposure.remainingExposure
          }
        });
      }
      this.events.write({
        type: "agent.cycle_completed",
        agent: "Risk Mitigation Agent",
        visibility: "PUBLIC",
        message: `Risk Agent approved ${result.approved} and rejected ${result.rejected} signal(s).`,
        payload: {
          approved: result.approved,
          rejected: result.rejected,
          topRejectedReasons: [...rejectedReasons.entries()].slice(0, 5)
        }
      });

      if (options.placePaperOrders) {
        await this.monitorOpenPositions();
        await this.maybeSendBankrollSummary();
      }
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
      if (cached?.bestBid !== undefined && cached.bestAsk !== undefined && cached.bids.length > 0 && cached.asks.length > 0) {
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

  private async placeAndSimulate(signal: Parameters<PaperExecutionEngine["createOrder"]>[0], risk: Parameters<PaperExecutionEngine["createOrder"]>[1], books: OrderBookSnapshot[]): Promise<void> {
    const order = this.executor.createOrder(signal, risk, this.config);
    const book = books.find((candidate) => candidate.tokenId === order.tokenId);
    if (!book) return;
    const simulated = this.executor.simulate(order, book);
    if (simulated.order.status === "OPEN" || simulated.order.status === "PARTIAL") this.openOrders.set(simulated.order.id, simulated.order);
    else this.openOrders.delete(simulated.order.id);
    this.db.savePaperOrder(simulated.order);
    if (simulated.fill) this.db.saveFill(simulated.fill);
    if (simulated.position) {
      const position = this.db.savePaperEntry(simulated.position);
      const balance = this.paperBalanceTrail();
      const cost = simulated.position.avgEntryPrice * simulated.position.size;
      await this.telegram.sendPaperEntry({
        outcome: position.outcome,
        marketId: position.marketId,
        price: simulated.position.avgEntryPrice,
        sizeUsd: cost,
        shares: simulated.position.size,
        unrealizedPnl: (position.currentPrice - position.avgEntryPrice) * position.size,
        totalPnl: balance.totalPnl,
        equity: balance.equity,
        availableCash: balance.availableCash
      });
      this.exportPaperLedger();
    }
  }

  private async monitorOpenPositions(): Promise<void> {
    await this.refreshOpenPositionBooks();
    const updates = this.overseerAgent.monitor(this.orderBooks);
    if (updates.length > 0) {
      this.events.write({
        type: "agent.cycle_completed",
        agent: "Overseer Agent",
        visibility: "PUBLIC",
        message: `Overseer reviewed ${updates.length} open position(s).`,
        payload: {
          reviewed: updates.length,
          closed: updates.filter((update) => update.closed).length
        }
      });
    }
    for (const update of updates) {
      if (update.closed) {
        void this.telegram.sendExit({
          outcome: update.position.outcome,
          marketId: update.position.marketId,
          reason: update.reason,
          price: update.position.currentPrice,
          sizeUsd: update.position.currentPrice * update.position.size,
          realizedPnl: update.position.realizedPnl,
          ...this.paperBalanceTrail()
        });
        this.exportPaperLedger();
      }
    }
  }

  private async refreshOpenPositionBooks(): Promise<void> {
    for (const position of this.db.getOpenPositions()) {
      const cached = this.orderBooks.get(position.tokenId);
      const stale = !cached || Date.now() - cached.timestamp > 60_000;
      if (!stale && cached.bids.length > 0 && cached.asks.length > 0) continue;
      const book = await this.provider.getOrderBook(position.tokenId, position.marketId);
      if (!book) continue;
      this.orderBooks.set(position.tokenId, book);
      this.db.saveOrderBook(book);
    }
  }

  private pruneRuntimeCaches(watchedTokenIds: string[]): void {
    const keepTokens = new Set(watchedTokenIds);
    for (const position of this.db.getOpenPositions()) keepTokens.add(position.tokenId);
    for (const tokenId of this.orderBooks.keys()) {
      if (!keepTokens.has(tokenId)) this.orderBooks.delete(tokenId);
    }
    for (const [orderId, order] of this.openOrders.entries()) {
      if (order.status !== "OPEN" && order.status !== "PARTIAL") this.openOrders.delete(orderId);
    }
  }

  private async maybeSendBankrollSummary(): Promise<void> {
    const sixHours = 6 * 60 * 60 * 1000;
    if (Date.now() - this.lastBankrollSummaryAt < sixHours) return;
    const report = this.db.getPerformanceReport();
    if (report.paperFills === 0 && report.openPositions === 0 && report.closedPositions === 0) return;
    this.lastBankrollSummaryAt = Date.now();
    await this.telegram.sendAdmin(this.telegramBankroll());
  }

  private riskState(): RiskState {
    return {
      openExposure: this.db.getOpenExposure(),
      dailyPnl: this.db.getDailyRealizedPnl(),
      lossStreak: 0,
      tradesToday: 0
    };
  }

  private paperBalanceTrail(): { totalPnl: number; equity: number; availableCash: number } {
    const report = this.db.getPerformanceReport();
    return {
      totalPnl: report.totalPnl,
      equity: this.config.bankroll + report.totalPnl,
      availableCash: this.config.bankroll - report.openCost + report.realizedPnl
    };
  }

  private exportPaperLedger(): void {
    try {
      exportPaperTradeLedgerFile(this.db, this.config.bankroll);
    } catch (error) {
      this.db.log("WARN", "failed to export paper trade ledger file", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
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
          ? ` category=${score.dominantCategory} catScore=${score.categoryConsistencyScore ?? 0} hot=${score.hotScore ?? 0} evidence=${Math.round((score.sampleConfidence ?? 0) * 100)}% shadow=${score.shadowScoreImpact ?? 0}`
          : "";
        console.log(`${score.wallet} score=${score.score} reliability=${score.reliability} trades=${score.tradeCount}${details}`);
      }
    }
  }

  private handleError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    try {
      this.db.log("ERROR", message);
    } catch (logError) {
      console.error(`failed to write error log: ${logError instanceof Error ? logError.message : String(logError)}`);
    }
    void this.telegram.sendError(message);
  }

  private registerDevPid(): void {
    mkdirSync(dirname(devPidPath), { recursive: true });
    writeFileSync(devPidPath, JSON.stringify({
      pid: process.pid,
      startedAt: Date.now(),
      mode: "dev"
    }, null, 2));

    const cleanup = (): void => {
      try {
        if (!existsSync(devPidPath)) return;
        const state = JSON.parse(readFileSync(devPidPath, "utf8")) as { pid?: number };
        if (state.pid === process.pid) unlinkSync(devPidPath);
      } catch {
        // Best-effort cleanup only.
      }
    };

    process.once("exit", cleanup);
    process.once("SIGINT", () => {
      cleanup();
      process.exit(0);
    });
    process.once("SIGTERM", () => {
      cleanup();
      process.exit(0);
    });
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

  private telegramRiskLog(): string {
    const events = this.db.getRecentRiskEvents(10);
    if (events.length === 0) return "No risk decisions stored yet.";
    return [
      "🛡 <b>Risk Decision Log</b>",
      "",
      ...events.flatMap((event, index) => {
        const qualityReasons = event.details?.marketQualityReasons ?? [];
        const details = qualityReasons.length
          ? qualityReasons.join("; ")
          : event.reason;
        return [
          `<b>${index + 1}. ${event.decision}</b> ${event.riskState ? `(${event.riskState})` : ""} ${event.profile ? `/${event.profile}` : ""}`,
          `${event.marketId ? `<code>${escapeHtml(event.marketId)}</code>` : "unknown market"} ${event.outcome ? escapeHtml(event.outcome) : ""} confidence ${event.confidence ?? "?"}`,
          `Reason: ${escapeHtml(details)}`,
          event.details?.openExposure !== undefined ? `Exposure: $${event.details.openExposure.toFixed(2)}` : "",
          ""
        ].filter(Boolean);
      })
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

  private telegramAgents(): string {
    const events = this.db.getRecentAgentEvents(30);
    const counts = new Map<string, number>();
    for (const event of events) counts.set(event.agent, (counts.get(event.agent) ?? 0) + 1);
    const latest = (agent: string) => events.find((event) => event.agent === agent);
    const report = this.db.getPerformanceReport();
    const risk = this.db.getRiskEventSummary(8);
    const topRisk = risk[0];
    return [
      "🤖 <b>StratiFi Agents</b>",
      "",
      `<b>Signal Agent</b>`,
      `Recent events: <b>${counts.get("Signal Agent") ?? 0}</b>`,
      `Latest: ${escapeHtml(latest("Signal Agent")?.message ?? "waiting for next scan")}`,
      "",
      `<b>Market Intelligence Agent</b>`,
      `Recent events: <b>${counts.get("Market Intelligence Agent") ?? 0}</b>`,
      `Latest: ${escapeHtml(latest("Market Intelligence Agent")?.message ?? "waiting for briefs")}`,
      "",
      `<b>Microstructure Agent</b>`,
      `Recent events: <b>${counts.get("Microstructure Agent") ?? 0}</b>`,
      `Latest: ${escapeHtml(latest("Microstructure Agent")?.message ?? "waiting for order books")}`,
      "",
      `<b>Wallet Intelligence Agent</b>`,
      `Recent events: <b>${counts.get("Wallet Intelligence Agent") ?? 0}</b>`,
      `Latest: ${escapeHtml(latest("Wallet Intelligence Agent")?.message ?? "waiting for wallet alignment")}`,
      "",
      `<b>Decision Council</b>`,
      `Recent events: <b>${counts.get("Decision Council") ?? 0}</b>`,
      `Latest: ${escapeHtml(latest("Decision Council")?.message ?? "waiting for debate")}`,
      "",
      `<b>Risk Mitigation Agent</b>`,
      `Recent events: <b>${counts.get("Risk Mitigation Agent") ?? 0}</b>`,
      `Latest: ${escapeHtml(latest("Risk Mitigation Agent")?.message ?? "waiting for decisions")}`,
      topRisk ? `Top risk group: <b>${topRisk.decision}</b> x${topRisk.count} (${escapeHtml(topRisk.reason)})` : "Top risk group: none yet",
      "",
      `<b>Overseer Agent</b>`,
      `Recent events: <b>${counts.get("Overseer Agent") ?? 0}</b>`,
      `Latest: ${escapeHtml(latest("Overseer Agent")?.message ?? "waiting for open positions")}`,
      `Monitoring: <b>${report.openPositions}</b> open / <b>${report.closedPositions}</b> closed`,
      "",
      `Paper fills: <b>${report.paperFills}</b>`,
      `Paper PnL: <b>$${report.totalPnl.toFixed(2)}</b>`
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
      `Paper fills: <b>${report.paperFills}</b>`,
      "",
      ...this.telegramOpenPositionLines(6)
    ].join("\n");
  }

  private telegramBankroll(): string {
    const report = this.db.getPerformanceReport();
    const startingBankroll = this.config.bankroll;
    const availableCash = startingBankroll - report.openCost + report.realizedPnl;
    const equity = startingBankroll + report.totalPnl;
    const netRoi = startingBankroll > 0 ? report.totalPnl / startingBankroll : 0;
    const deployedPct = startingBankroll > 0 ? report.openCost / startingBankroll : 0;
    return [
      "💵 <b>Paper Bankroll</b>",
      "",
      `Starting bankroll: <b>$${startingBankroll.toFixed(2)}</b>`,
      `Equity: <b>$${equity.toFixed(2)}</b>`,
      `Available cash: <b>$${availableCash.toFixed(2)}</b>`,
      `Deployed cost: <b>$${report.openCost.toFixed(2)}</b> (${(deployedPct * 100).toFixed(1)}%)`,
      `Open value: <b>$${report.openValue.toFixed(2)}</b>`,
      "",
      `Total PnL: <b>$${report.totalPnl.toFixed(2)}</b> (${(netRoi * 100).toFixed(2)}%)`,
      `Realized: <b>$${report.realizedPnl.toFixed(2)}</b>`,
      `Unrealized: <b>$${report.unrealizedPnl.toFixed(2)}</b>`,
      "",
      `Positions: <b>${report.openPositions}</b> open / <b>${report.closedPositions}</b> closed`,
      `Fills: <b>${report.paperFills}</b> / Orders: <b>${report.paperOrders}</b>`,
      `Win rate: <b>${(report.winRate * 100).toFixed(0)}%</b>`,
      "",
      ...this.telegramOpenPositionLines(6)
    ].join("\n");
  }

  private telegramLedger(): string {
    const ledger = this.db.getPaperTradeLedger(this.config.bankroll, 12);
    if (ledger.length === 0) {
      return [
        "ðŸ“‹ <b>Paper Trade Ledger</b>",
        "",
        "No paper entries or exits yet."
      ].join("\n");
    }
    return [
      "ðŸ“‹ <b>Paper Trade Ledger</b>",
      "",
      ...ledger.flatMap((item, index) => [
        `<b>${index + 1}. ${item.type}</b> ${escapeHtml(String(item.outcome))} ${item.profile ? `/${escapeHtml(item.profile)}` : ""}`,
        `<code>${escapeHtml(item.marketId)}</code>`,
        `Notional <b>$${item.notional.toFixed(2)}</b> @ ${item.price.toFixed(3)} | Realized <b>$${item.realizedPnl.toFixed(2)}</b>`,
        `Total PnL <b>$${item.totalPnl.toFixed(2)}</b> | Equity <b>$${item.equity.toFixed(2)}</b> | Cash <b>$${item.availableCash.toFixed(2)}</b>`,
        ""
      ])
    ].join("\n");
  }

  private telegramPositions(): string {
    return this.telegramOpenPositionLines(20).join("\n");
  }

  private async telegramClosePosition(positionRef: string): Promise<string> {
    const position = this.resolveOpenPosition(positionRef);
    if (!position) {
      return [
        "No matching open paper position.",
        "",
        "Use /positions, then close by number or full position ID."
      ].join("\n");
    }
    const closed = await this.closePaperPosition(position, "manual Telegram close");
    const balance = this.paperBalanceTrail();
    return [
      "🟡 <b>Paper Position Closed</b>",
      "",
      `<b>${escapeHtml(String(closed.outcome))}</b>`,
      `<code>${escapeHtml(closed.marketId)}</code>`,
      `Exit mark: <b>${closed.currentPrice.toFixed(3)}</b>`,
      `Realized PnL: <b>$${closed.realizedPnl.toFixed(2)}</b>`,
      `Total PnL: <b>$${balance.totalPnl.toFixed(2)}</b>`,
      `Equity: <b>$${balance.equity.toFixed(2)}</b> | Cash: <b>$${balance.availableCash.toFixed(2)}</b>`,
      "",
      "Paper mode only. No live Polymarket order was placed."
    ].join("\n");
  }

  private async telegramCloseAllPositions(confirmed: boolean): Promise<string> {
    const positions = this.db.getOpenPositions();
    if (positions.length === 0) return "No open paper positions to close.";
    if (!confirmed) {
      const exposure = positions.reduce((sum, position) => sum + position.currentPrice * position.size, 0);
      return [
        "⚠️ <b>Confirm Close All Paper Positions</b>",
        "",
        `Open positions: <b>${positions.length}</b>`,
        `Marked value: <b>$${exposure.toFixed(2)}</b>`,
        "",
        "Tap confirm or send /confirmcloseall to close all open paper positions.",
        "Paper mode only. No live Polymarket orders will be placed."
      ].join("\n");
    }

    const closed: Position[] = [];
    for (const position of positions) closed.push(await this.closePaperPosition(position, "manual Telegram close all"));
    const realized = closed.reduce((sum, position) => sum + position.realizedPnl, 0);
    const balance = this.paperBalanceTrail();
    return [
      "🟡 <b>All Paper Positions Closed</b>",
      "",
      `Closed: <b>${closed.length}</b>`,
      `Realized PnL: <b>$${realized.toFixed(2)}</b>`,
      `Total PnL: <b>$${balance.totalPnl.toFixed(2)}</b>`,
      `Equity: <b>$${balance.equity.toFixed(2)}</b> | Cash: <b>$${balance.availableCash.toFixed(2)}</b>`,
      "",
      "Paper mode only. No live Polymarket orders were placed."
    ].join("\n");
  }

  private telegramShadow(): string {
    const report = this.db.getShadowBacktestReport();
    return [
      "\u{1F9EA} <b>Shadow Copy Backtest</b>",
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
      `Paper fills: ${report.paperFills}`,
      "",
      ...this.plainOpenPositionLines(12)
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

  private resolveOpenPosition(positionRef: string): Position | undefined {
    const positions = this.db.getOpenPositions();
    const trimmed = positionRef.trim();
    const asIndex = Number(trimmed);
    if (Number.isInteger(asIndex) && asIndex >= 1) return positions[asIndex - 1];
    return positions.find((position) => position.id === trimmed || position.marketId === trimmed || position.id.endsWith(trimmed));
  }

  private async closePaperPosition(position: Position, reason: string): Promise<Position> {
    await this.refreshOpenPositionBooks();
    const book = this.orderBooks.get(position.tokenId);
    const currentPrice = book?.bestBid ?? book?.lastTradePrice ?? position.currentPrice;
    const closedPosition: Position = {
      ...position,
      currentPrice,
      realizedPnl: (currentPrice - position.avgEntryPrice) * position.size,
      updatedAt: Date.now(),
      status: "CLOSED"
    };
    this.db.savePosition(closedPosition);
    this.exportPaperLedger();
    this.events.write({
      type: "trade.closed",
      agent: "Overseer Agent",
      visibility: "PUBLIC",
      message: `Closed ${position.outcome} position: ${reason}.`,
      payload: {
        positionId: position.id,
        marketId: position.marketId,
        outcome: position.outcome,
        realizedPnl: closedPosition.realizedPnl,
        reason
      }
    });
    return closedPosition;
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

  private plainOpenPositionLines(limit: number): string[] {
    const positions = this.db.getOpenPositions();
    if (positions.length === 0) return ["Open Positions: none"];
    const lines = ["Open Positions:"];
    for (const position of positions.slice(0, limit)) {
      const cost = position.avgEntryPrice * position.size;
      const value = position.currentPrice * position.size;
      const pnl = value - cost;
      lines.push(
        `- ${position.profile ?? "Shared"} ${position.outcome} ${position.marketId}: size=${position.size.toFixed(2)} entry=${position.avgEntryPrice.toFixed(3)} mark=${position.currentPrice.toFixed(3)} cost=$${cost.toFixed(2)} value=$${value.toFixed(2)} uPnL=$${pnl.toFixed(2)}`
      );
    }
    if (positions.length > limit) lines.push(`- ...and ${positions.length - limit} more`);
    return lines;
  }

  private telegramOpenPositionLines(limit: number): string[] {
    const positions = this.db.getOpenPositions();
    if (positions.length === 0) return ["<b>Open Positions</b>", "None"];
    return [
      "<b>Open Positions</b>",
      ...positions.slice(0, limit).map((position) => {
        const cost = position.avgEntryPrice * position.size;
        const value = position.currentPrice * position.size;
        const pnl = value - cost;
        return [
          `- <b>${escapeHtml(position.profile ?? "Shared")}</b> ${escapeHtml(String(position.outcome))}`,
          `<code>${escapeHtml(position.marketId)}</code>`,
          `entry ${position.avgEntryPrice.toFixed(3)} to mark ${position.currentPrice.toFixed(3)}`,
          `value <b>$${value.toFixed(2)}</b> | uPnL <b>$${pnl.toFixed(2)}</b> | cost $${cost.toFixed(2)}`
        ].join(" ");
      }),
      ...(positions.length > limit ? [`- ...and ${positions.length - limit} more`] : [])
    ];
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const arg = process.argv[2];
const mode = (arg === "dev" || arg === "performance" || arg === "shadow" ? arg : "scan") satisfies Mode;
const bot = new PolymarketPaperBot();
await bot.start(mode);
