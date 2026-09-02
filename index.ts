import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ClobMarketWebSocket, CryptoReferenceWebSocket, makeClients } from "./src/clients.js";
import { loadBotConfig, loadRuntimeEnv, loadTrackedWallets } from "./src/config.js";
import { BotDatabase } from "./src/db.js";
import { DecisionCouncil } from "./src/agents/decisionCouncil.js";
import { MarketIntelligenceAgent } from "./src/agents/marketIntelligenceAgent.js";
import { applyMicrostructureToQuality, MicrostructureAgent } from "./src/agents/microstructureAgent.js";
import { OverseerAgent } from "./src/agents/overseerAgent.js";
import { RiskMitigationAgent } from "./src/agents/riskMitigationAgent.js";
import { SignalAgent } from "./src/agents/signalAgent.js";
import { WalletIntelligenceAgent } from "./src/agents/walletIntelligenceAgent.js";
import { WalletResearchAgent } from "./src/agents/walletResearchAgent.js";
import { StrategyResearchAgent } from "./src/agents/strategyResearchAgent.js";
import { WeatherStrategyAgent } from "./src/agents/weatherStrategyAgent.js";
import { CryptoThresholdStrategyAgent, CRYPTO_THRESHOLD_STRATEGY_ID, parseCryptoThresholdMarket } from "./src/agents/cryptoThresholdStrategyAgent.js";
import { MacroCpiStrategyAgent, MACRO_CPI_STRATEGY_ID, parseMacroCpiMarket } from "./src/agents/macroCpiStrategyAgent.js";
import { rankAndDiversifyCandidates, rankAndDiversifyResearchSelections, type CandidateContext } from "./src/candidateRanking.js";
import {
  PaperExecutionEngine,
  evaluateMarketQuality,
  inferMarketCategory,
  type RiskState
} from "./src/engines.js";
import { AgentEventWriter } from "./src/events/eventWriter.js";
import { buildStrategyProfiles } from "./src/profiles/profiles.js";
import { PolymarketProvider } from "./src/providers/polymarketProvider.js";
import { TelegramAlerts } from "./src/telegram.js";
import { exportPaperTradeLedgerFile } from "./src/paperTradeLedgerFile.js";
import { formatPlainLiveReadinessReport } from "./src/liveReadiness.js";
import { CompressedMarketTapeWriter } from "./src/research/marketTape.js";
import { includeCompleteNegativeRiskGraphs, includeCompleteThresholdLadderGroups, selectExecutionResearchUniverse, type ExecutionResearchUniverseEntry } from "./src/research/executionUniverse.js";
import { ExecutionResearchCoordinator } from "./src/research/executionShadowEngines.js";
import { EXECUTION_RESEARCH_STRATEGIES, executionPolicyVersion } from "./src/research/executionPolicy.js";
import { mergeMarketStreamBook } from "./src/orderBookDelta.js";
import { collectWeatherTournamentObservations, WEATHER_TOURNAMENT_VERSION } from "./src/weatherStrategyTournament.js";
import type { BotConfig, IntelligenceReviewContext, MarketSnapshot, OrderBookSnapshot, PaperOrder, Position, TradeSignal, WalletScore } from "./src/types.js";

type Mode = "dev" | "scan" | "performance" | "shadow" | "readiness";
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
  private db = new BotDatabase(this.env.dbPath, this.config.performanceStartAt);
  private events = new AgentEventWriter(this.db);
  private profiles = buildStrategyProfiles(this.config);
  private signalAgent = new SignalAgent(this.provider, this.db, this.events, this.config);
  private walletResearchAgent = new WalletResearchAgent(this.provider, this.db, this.events, this.config);
  private strategyResearchAgent = new StrategyResearchAgent(this.db, this.events, this.config);
  private weatherStrategyAgent = new WeatherStrategyAgent(this.db, this.events, this.config);
  private cryptoThresholdStrategyAgent = new CryptoThresholdStrategyAgent(this.db, this.events, this.config);
  private macroCpiStrategyAgent = new MacroCpiStrategyAgent(this.db, this.events, this.config);
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
  private tickSizes = new Map<string, number>();
  private sourceExitPolls = new Map<string, number>();
  private ws = new ClobMarketWebSocket(this.env.clobWsUrl);
  private cryptoReferenceWs = new CryptoReferenceWebSocket(this.env.cryptoReferenceWsUrl ?? "wss://data-stream.binance.vision/stream?streams=btcusdt@bookTicker/ethusdt@bookTicker");
  private marketTape = new CompressedMarketTapeWriter(this.env.researchTapeDir ?? `${dirname(this.env.dbPath)}/market-tape`, this.config.executionResearchBookDepthLevels ?? 10);
  private executionResearch = new ExecutionResearchCoordinator(
    this.db,
    this.config,
    (tokenId, marketId) => this.provider.getOrderBook(tokenId, marketId)
  );
  private paused = false;
  private lastResult?: CycleResult;
  private lastCycleAt?: number;
  private lastBankrollSummaryAt = 0;
  private lastParityScorecardAt = 0;
  private cycleRunning = false;
  private lastExecutionResearchSummaryAt = 0;
  private executionEventGraphCache = new Map<string, { markets: MarketSnapshot[]; refreshedAt: number }>();

  async start(mode: Mode): Promise<void> {
    this.db.syncWallets(this.wallets);
    this.ws.onUpdate((update) => {
      const previous = this.orderBooks.get(update.tokenId);
      const merged = mergeMarketStreamBook(previous, update);
      this.orderBooks.set(update.tokenId, merged);
      const researchMarket = this.executionResearch.marketForToken(update.tokenId);
      this.marketTape.recordUpdate(update, researchMarket?.id);
      this.executionResearch.onMarketUpdate(update, merged);
    });
    this.cryptoReferenceWs.onTick((tick) => {
      this.marketTape.recordReference(tick);
      this.executionResearch.onReferenceTick(tick);
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

    if (mode === "readiness") {
      console.log(this.plainLiveReadinessReport());
      this.db.close();
      return;
    }

    console.log("Starting Polymarket paper bot. No live trading code path is enabled.");
    this.registerDevPid();
    if (this.config.executionResearchEnabled !== false) this.cryptoReferenceWs.connect();
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
    if (this.cycleRunning) {
      this.db.log("WARN", "cycle skipped because prior cycle is still running", { placePaperOrders: options.placePaperOrders });
      return this.lastResult ?? result;
    }
    this.cycleRunning = true;
    try {
      this.expireStaleOrders();
      this.db.log("INFO", "cycle started", { placePaperOrders: options.placePaperOrders });
      this.events.write({
        type: "agent.cycle_started",
        agent: "Signal Agent",
        visibility: "PUBLIC",
        message: "Signal Agent started a market scan and source refresh.",
        payload: { placePaperOrders: options.placePaperOrders }
      });
      const researchReports = await this.walletResearchAgent.refresh();
      const signalState = await this.signalAgent.discoverAndScore(this.wallets, researchReports);
      const hypotheses = this.strategyResearchAgent.refresh(researchReports);
      this.weatherStrategyAgent.beginCycle();
      // CPI is the primary research lane because its independent benchmark gap
      // is currently the closest to passing. Validate it first and keep the
      // other independent models running as secondary controls.
      await this.macroCpiStrategyAgent.ensureValidation(
        signalState.markets,
        hypotheses.find((hypothesis) => hypothesis.cluster === "MACRO_RELEASE")
      );
      await Promise.all([
        this.weatherStrategyAgent.ensureValidation(
          signalState.markets,
          hypotheses.find((hypothesis) => hypothesis.cluster === "WEATHER_FORECASTING")
        ),
        this.cryptoThresholdStrategyAgent.ensureValidation(
          signalState.markets,
          hypotheses.find((hypothesis) => hypothesis.cluster === "CRYPTO_THRESHOLD")
        )
      ]);
      const freshestSourceWindow = Math.max(
        this.config.maxSourceBuyAgeMs ?? 0,
        this.config.paperExplorationMaxSourceBuyAgeMs ?? 0
      );
      const freshSourceMarketIds = new Set(signalState.allTrades
        .filter((trade) => freshestSourceWindow <= 0 || trade.timestamp >= Date.now() - freshestSourceWindow)
        .map((trade) => trade.marketId));
      const signalMarkets = signalState.markets.filter((market) =>
        inferMarketCategory(market) === "weather" ||
        Boolean(parseCryptoThresholdMarket(market)) ||
        Boolean(parseMacroCpiMarket(market)) ||
        freshSourceMarketIds.has(market.id) ||
        (market.conditionId !== undefined && freshSourceMarketIds.has(market.conditionId))
      );
      result.markets = signalMarkets;
      result.discoveryTrades = signalState.discoveryTrades;
      result.discovered = signalState.discovered;
      result.scores = signalState.scores;
      const baseResearchUniverse = this.config.executionResearchEnabled === false
        ? []
        : selectExecutionResearchUniverse(signalState.markets, {
            limit: this.config.executionResearchUniverseLimit ?? 120,
            minVolume24h: this.config.executionResearchMinVolume24h ?? 1_000
          });
      const completeNegRiskGraphs = await this.loadCompleteNegativeRiskGraphs(baseResearchUniverse);
      const thresholdCompleteUniverse = includeCompleteThresholdLadderGroups(
        baseResearchUniverse,
        signalState.markets,
        this.config.executionResearchUniverseLimit ?? 120
      );
      const researchUniverse = includeCompleteNegativeRiskGraphs(
        thresholdCompleteUniverse,
        completeNegRiskGraphs,
        this.config.executionResearchUniverseLimit ?? 120
      );
      this.executionResearch.setUniverse(researchUniverse.map((entry) => entry.market));
      for (const entry of researchUniverse) this.marketTape.recordMarket(entry.market);
      if (options.placePaperOrders) {
        const watchedTokenIds = [...new Set([
          ...signalMarkets.flatMap((market) => market.clobTokenIds),
          ...researchUniverse.flatMap((entry) => entry.market.clobTokenIds)
        ])];
        this.pruneRuntimeCaches(watchedTokenIds);
        this.ws.connect(watchedTokenIds);
      }
      this.events.write({
        type: "agent.cycle_completed",
        agent: "Signal Agent",
        visibility: "PUBLIC",
        message: `Signal Agent scanned ${signalMarkets.length} actionable markets and scored ${signalState.scores.length} sources.`,
        payload: {
          markets: signalMarkets.length,
          fetchedMarkets: signalState.markets.length,
          sources: signalState.scores.length,
          discovered: signalState.discovered,
          discoveryTrades: signalState.discoveryTrades,
          executionResearchMarkets: researchUniverse.length,
          executionResearchTokens: new Set(researchUniverse.flatMap((entry) => entry.market.clobTokenIds)).size,
          completeNegRiskGraphsFetched: completeNegRiskGraphs.filter((graph) => graph.length > 0).length,
          completeNegRiskGraphMarketsFetched: completeNegRiskGraphs.reduce((sum, graph) => sum + graph.length, 0),
          completeNegRiskMarketsSelected: researchUniverse.filter((entry) => entry.market.eventMarketCount !== undefined).length
        }
      });
      const rejectedReasons = new Map<string, number>();
      const candidateQueue: CandidateContext[] = [];
      const researchSelectionQueue: CandidateContext[] = [];
      const tradesByMarket = new Map<string, typeof signalState.allTrades>();
      for (const trade of signalState.allTrades) {
        const grouped = tradesByMarket.get(trade.marketId) ?? [];
        grouped.push(trade);
        tradesByMarket.set(trade.marketId, grouped);
      }

      const marketAnalyses = await mapWithConcurrency(
        signalMarkets,
        Math.max(1, Math.floor(this.config.signalMarketConcurrency ?? 6)),
        async (market) => {
        const books = await this.getBooksForMarket(market);
        const relevantTrades = [...new Set([
          ...(tradesByMarket.get(market.id) ?? []),
          ...(market.conditionId ? tradesByMarket.get(market.conditionId) ?? [] : [])
        ])];
        const walletSignals = this.signalAgent.createSignals({
          market,
          books,
          trades: relevantTrades,
          scores: signalState.scores
        });
        const independentSignals = (await Promise.all([
          this.weatherStrategyAgent.createSignals(market, books),
          this.cryptoThresholdStrategyAgent.createSignals(market, books),
          this.macroCpiStrategyAgent.createSignals(market, books)
        ])).flat();
        return { market, books, signals: [...walletSignals, ...independentSignals] };
      });

      for (const { market, books, signals: marketSignals } of marketAnalyses) {
        result.signals += marketSignals.length;
        for (const signal of marketSignals) {
          if (signal.decision === "TRADE_CANDIDATE") candidateQueue.push({ market, books, signal });
          if (signal.strategyId === MACRO_CPI_STRATEGY_ID && signal.researchEligible === true) {
            researchSelectionQueue.push({ market, books, signal });
          }
        }
      }

      if (this.config.weatherTournamentEnabled !== false) {
        const tournament = collectWeatherTournamentObservations({
          db: this.db,
          opportunities: this.weatherStrategyAgent.getCycleOpportunities(),
          positionSizeUsd: this.config.weatherTournamentPositionSizeUsd ??
            this.config.independentModelFlatPositionSize ?? this.config.minPositionSize
        });
        if (tournament.inserted > 0) {
          this.events.write({
            type: "weather_strategy.tournament_observations_frozen",
            agent: "Strategy Research Agent",
            visibility: "PUBLIC",
            message: `Weather tournament froze ${tournament.inserted} new fixed-horizon station-day observation(s).`,
            payload: {
              tournamentVersion: WEATHER_TOURNAMENT_VERSION,
              attempted: tournament.attempted,
              inserted: tournament.inserted,
              eligible: tournament.observations.filter((observation) => observation.eligible).length
            }
          });
        }
        await this.refreshWeatherTournamentSettlements();
      }

      const researchRanked = rankAndDiversifyResearchSelections(researchSelectionQueue);
      let newResearchSelections = 0;
      for (const { signal } of researchRanked.selected) {
        if (this.db.markStrategyOpportunityResearchSelected(signal.id)) newResearchSelections += 1;
      }
      if (researchSelectionQueue.length > 0) {
        this.events.write({
          type: "macro_strategy.forward_research_selected",
          agent: "Strategy Research Agent",
          visibility: "PUBLIC",
          message: `CPI research froze ${newResearchSelections} new no-trade forward selection(s); ${researchRanked.skipped.length} correlated duplicate(s) were excluded.`,
          payload: {
            qualifiedPredictions: researchSelectionQueue.length,
            selectedEvents: researchRanked.selected.length,
            newlyInserted: newResearchSelections,
            correlatedDuplicatesRemoved: researchRanked.skipped.length,
            policyVersion: this.config.macroCpiForwardPolicyVersion
          }
        });
      }

      const ranked = rankAndDiversifyCandidates(candidateQueue);
      for (const skipped of ranked.skipped) {
        const reason = `lower-ranked duplicate exposure for ${skipped.eventKey}`;
        result.rejected += 1;
        rejectedReasons.set(reason, (rejectedReasons.get(reason) ?? 0) + 1);
        this.db.saveRiskDecision({
          decision: "REJECT",
          positionSize: 0,
          reason,
          confidence: skipped.signal.confidence,
          shadow: true
        }, {
          signalId: skipped.signal.id,
          marketId: skipped.signal.marketId,
          outcome: skipped.signal.outcome,
          details: { candidatePriority: skipped.priority, strategyEventKey: skipped.eventKey }
        });
      }
      this.events.write({
        type: "agent.review_started",
        agent: "Risk Mitigation Agent",
        visibility: "PUBLIC",
        message: `Risk Agent started reviewing ${ranked.selected.length} globally ranked candidate(s).`,
        payload: {
          rawCandidates: candidateQueue.length,
          selectedCandidates: ranked.selected.length,
          correlatedDuplicatesRemoved: ranked.skipped.length
        }
      });

      for (const { market, books, signal, priority } of ranked.selected) {
        if (signal.strategyId?.startsWith("weather_") && !this.db.markWeatherOpportunitySelected(signal.id)) {
          this.rejectDuplicateStrategyEvent(signal, result, rejectedReasons);
          continue;
        }
        if (signal.strategyId === CRYPTO_THRESHOLD_STRATEGY_ID || signal.strategyId === MACRO_CPI_STRATEGY_ID) {
          if (!this.db.markStrategyOpportunitySelected(signal.id)) {
            this.rejectDuplicateStrategyEvent(signal, result, rejectedReasons);
            continue;
          }
        }
        const microstructure = this.microstructureAgent.review(market, books, this.config);
        const qualityConfig = this.marketQualityConfigForSignal(signal);
        const qualityMarket = signal.resolutionTimestamp
          ? { ...market, endDate: new Date(signal.resolutionTimestamp).toISOString() }
          : market;
        const quality = applyMicrostructureToQuality(evaluateMarketQuality(qualityMarket, books, qualityConfig), microstructure);
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
          debate,
          sourceScores: this.sourceScoreAudit(signal, signalState.scores)
        });
        if (risk.decision === "APPROVE" || risk.decision === "REDUCE_SIZE") {
          if (this.config.newEntriesEnabled === false) {
            this.rejectApprovedSignal(signal, risk, "new paper entries disabled by audit gate", result, rejectedReasons);
            continue;
          }
          const cooldownMs = this.config.stopCooldownMs ?? 0;
          if (this.db.isMarketInStopCooldown(signal.marketId, signal.tokenId, cooldownMs)) {
            this.rejectApprovedSignal(signal, risk, "stop-out cooldown active", result, rejectedReasons);
            continue;
          }
          const entryCooldownMs = this.config.marketEntryCooldownMs ?? 0;
          if (this.db.isMarketEntryInCooldown(signal.marketId, signal.tokenId, entryCooldownMs)) {
            this.rejectApprovedSignal(signal, risk, "market/outcome entry cooldown active", result, rejectedReasons);
            continue;
          }
          if (this.db.hasOpenPosition(signal.marketId, signal.tokenId, risk.profile)) {
            this.rejectApprovedSignal(signal, risk, "position already open for market/outcome/profile", result, rejectedReasons);
            continue;
          }
          const sourceCooldownMs = this.config.sourceEntryCooldownMs ?? 0;
          if (this.db.isSourceEntryInCooldown(signal, risk.profile, sourceCooldownMs)) {
            this.rejectApprovedSignal(signal, risk, "source/outcome entry cooldown active", result, rejectedReasons);
            continue;
          }
          result.approved += 1;
          await this.telegram.sendApproved({
            outcome: signal.outcome,
            question: market.question,
            price: signal.limitPrice,
            size: risk.positionSize,
            confidence: signal.confidence
          });
          this.db.log("INFO", "globally ranked candidate approved", {
            signalId: signal.id,
            priority,
            strategyEventKey: signal.strategyEventKey,
            policyVersion: signal.policyVersion
          });
          if (options.placePaperOrders) await this.placeAndSimulate(signal, risk, books);
        } else {
          result.rejected += 1;
          rejectedReasons.set(risk.reason, (rejectedReasons.get(risk.reason) ?? 0) + 1);
        }
      }
      this.signalAgent.flushSignalDiagnostics();

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
        this.executionResearch.tick();
        this.maybeLogExecutionResearchSummary();
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
    } finally {
      this.cycleRunning = false;
    }
  }

  async stop(): Promise<void> {
    this.ws.stop();
    this.cryptoReferenceWs.stop();
    await this.marketTape.close();
    this.db.close();
  }

  private maybeLogExecutionResearchSummary(now = Date.now()): void {
    if (now - this.lastExecutionResearchSummaryAt < 15 * 60_000) return;
    this.lastExecutionResearchSummaryAt = now;
    this.db.log("INFO", "execution research summary", {
      ...this.executionResearch.getSummary(),
      tape: this.marketTape.getStats(),
      policies: Object.fromEntries(EXECUTION_RESEARCH_STRATEGIES
        .map((strategy) => [strategy, executionPolicyVersion(this.config, strategy)]))
    });
  }

  private async loadCompleteNegativeRiskGraphs(seed: ExecutionResearchUniverseEntry[]): Promise<MarketSnapshot[][]> {
    if (this.config.executionResearchEnabled === false) return [];
    const now = Date.now();
    const eventIds = [...new Set(seed
      .filter((entry) => entry.market.negRisk && !entry.market.negRiskAugmented && entry.market.eventId)
      .map((entry) => entry.market.eventId!))]
      .slice(0, 6);
    return Promise.all(eventIds.map(async (eventId) => {
      const cached = this.executionEventGraphCache.get(eventId);
      const cacheTtl = cached?.markets.length ? 15 * 60_000 : 60_000;
      if (cached && now - cached.refreshedAt < cacheTtl) return cached.markets;
      const markets = await this.provider.getEventMarkets(eventId);
      this.executionEventGraphCache.set(eventId, { markets, refreshedAt: now });
      return markets;
    }));
  }

  private rejectApprovedSignal(
    signal: TradeSignal,
    risk: ReturnType<RiskMitigationAgent["decide"]>,
    reason: string,
    result: CycleResult,
    rejectedReasons: Map<string, number>
  ): void {
    result.rejected += 1;
    rejectedReasons.set(reason, (rejectedReasons.get(reason) ?? 0) + 1);
    this.db.saveRiskDecision({
      decision: "REJECT",
      positionSize: 0,
      reason,
      profile: risk.profile,
      confidence: signal.confidence,
      riskState: risk.riskState
    }, {
      signalId: signal.id,
      marketId: signal.marketId,
      outcome: signal.outcome,
      details: {
        entryPrice: signal.limitPrice,
        sourceWalletCount: signal.alignedWallets.length,
        riskReasonAtApproval: risk.reason
      }
    });
  }

  private rejectDuplicateStrategyEvent(
    signal: TradeSignal,
    result: CycleResult,
    rejectedReasons: Map<string, number>
  ): void {
    const reason = `strategy event already has an immutable selection: ${signal.strategyEventKey ?? signal.marketId}`;
    result.rejected += 1;
    rejectedReasons.set(reason, (rejectedReasons.get(reason) ?? 0) + 1);
    this.db.saveRiskDecision({
      decision: "REJECT",
      positionSize: 0,
      reason,
      confidence: signal.confidence,
      shadow: true
    }, {
      signalId: signal.id,
      marketId: signal.marketId,
      outcome: signal.outcome,
      details: { strategyEventKey: signal.strategyEventKey }
    });
  }

  private sourceScoreAudit(signal: TradeSignal, scores: WalletScore[]): NonNullable<IntelligenceReviewContext["sourceScores"]> {
    const aligned = new Set(signal.alignedWallets.map((wallet) => wallet.toLowerCase()));
    return scores
      .filter((score) => aligned.has(score.wallet.toLowerCase()))
      .map((score) => ({
        wallet: score.wallet.toLowerCase(),
        score: score.score,
        copyabilityScore: score.copyabilityScore,
        shadowScoreImpact: score.shadowScoreImpact,
        shadowPnl: score.shadowPnl,
        shadowSimulated: score.shadowSimulated,
        shadowRealized: score.shadowRealized,
        sourceSellRealizedRatio: score.sourceSellRealizedRatio,
        liveExecutableShadowPnl: score.liveExecutableShadowPnl,
        liveExecutableShadowAvgReturnPct: score.liveExecutableShadowAvgReturnPct,
        liveExecutableShadowSimulated: score.liveExecutableShadowSimulated,
        categoryConsistencyScore: score.categoryConsistencyScore,
        sampleConfidence: score.sampleConfidence,
        flags: score.flags
      }));
  }

  private marketQualityConfigForSignal(signal: TradeSignal): BotConfig {
    if (signal.signalOrigin === "INDEPENDENT_MODEL" && signal.strategyId?.startsWith("weather_")) {
      return {
        ...this.config,
        minTimeToResolutionHours: this.config.weatherMinTimeToResolutionHours ?? 2,
        maxTimeToResolutionHours: Math.min(this.config.maxTimeToResolutionHours, 7 * 24)
      };
    }
    if (signal.signalOrigin === "INDEPENDENT_MODEL" && signal.strategyId === CRYPTO_THRESHOLD_STRATEGY_ID) {
      return {
        ...this.config,
        minTimeToResolutionHours: this.config.cryptoThresholdMinTimeToResolutionHours ?? 2,
        maxTimeToResolutionHours: this.config.cryptoThresholdMaxTimeToResolutionHours ?? 36
      };
    }
    if (signal.signalOrigin === "INDEPENDENT_MODEL" && signal.strategyId === MACRO_CPI_STRATEGY_ID) {
      return {
        ...this.config,
        minTimeToResolutionHours: this.config.macroCpiMinTimeToReleaseHours ?? 2,
        maxTimeToResolutionHours: this.config.macroCpiMaxTimeToReleaseHours ?? 168
      };
    }
    if (!this.isPaperExplorationSignal(signal)) return this.config;
    return {
      ...this.config,
      maxTimeToResolutionHours: this.config.paperExplorationMaxTimeToResolutionHours ?? this.config.maxTimeToResolutionHours
    };
  }

  private isPaperExplorationSignal(signal: TradeSignal): boolean {
    return this.config.paperMode && signal.reason.startsWith("paper exploration:");
  }

  private async getBooksForMarket(market: MarketSnapshot): Promise<OrderBookSnapshot[]> {
    const books: OrderBookSnapshot[] = [];
    for (const tokenId of market.clobTokenIds) {
      const cached = this.orderBooks.get(tokenId);
      if (cached?.bestBid !== undefined && cached.bestAsk !== undefined && cached.bids.length > 0 && cached.asks.length > 0) {
        const hydrated = await this.withTickSize(cached);
        this.orderBooks.set(tokenId, hydrated);
        books.push(hydrated);
        continue;
      }
      const book = await this.provider.getOrderBook(tokenId, market.id);
      if (book) {
        const hydrated = await this.withTickSize(book);
        this.orderBooks.set(tokenId, hydrated);
        this.db.saveOrderBook(hydrated);
        books.push(hydrated);
      }
    }
    return books;
  }

  private async placeAndSimulate(signal: Parameters<PaperExecutionEngine["createOrder"]>[0], risk: Parameters<PaperExecutionEngine["createOrder"]>[1], books: OrderBookSnapshot[]): Promise<void> {
    const book = books.find((candidate) => candidate.tokenId === signal.tokenId);
    const market = this.db.getMarketById(signal.marketId);
    const feeRate = market?.feesEnabled === false
      ? 0
      : market?.takerFeeRate ?? this.config.liveExecutionFeeRatePct ?? 0;
    const order = this.executor.createOrder(signal, risk, this.config, book?.tickSize, feeRate);
    if (!book) return;
    const simulated = this.executor.simulate(order, book);
    if (simulated.order.status === "OPEN" || simulated.order.status === "PARTIAL") this.openOrders.set(simulated.order.id, simulated.order);
    else this.openOrders.delete(simulated.order.id);
    this.db.savePaperOrder(simulated.order);
    if (simulated.fill) this.db.saveFill(simulated.fill);
    this.db.recordPaperEntryParity(signal, simulated.order, simulated.fill, simulated.position);
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
    this.expireStaleOrders();
    await this.refreshOpenPositionSourceTrades();
    await this.refreshOpenPositionMarkets();
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
    this.logParityScorecard();
  }

  private async refreshOpenPositionMarkets(): Promise<void> {
    const marketIds = [...new Set(this.db.getOpenPositions().map((position) => position.marketId))];
    for (const marketId of marketIds) {
      try {
        const market = await this.provider.getMarketById(marketId);
        if (market) this.db.saveMarket(market);
      } catch (error) {
        this.db.log("WARN", "open-position market refresh failed", { marketId, error: String(error) });
      }
    }
  }

  private async refreshWeatherTournamentSettlements(): Promise<void> {
    const marketIds = this.db.getWeatherTournamentSettlementMarketIds(WEATHER_TOURNAMENT_VERSION, Date.now(), 6);
    await Promise.all(marketIds.map(async (marketId) => {
      try {
        const market = await this.provider.getMarketById(marketId);
        if (market) this.db.saveMarket(market);
      } catch (error) {
        this.db.log("WARN", "weather tournament settlement refresh failed", { marketId, error: String(error) });
      }
    }));
  }

  private async refreshOpenPositionBooks(): Promise<void> {
    for (const position of this.db.getOpenPositions()) {
      const cached = this.orderBooks.get(position.tokenId);
      const stale = !cached || Date.now() - cached.timestamp > (this.config.maxOrderBookAgeMs ?? 60_000);
      if (!stale && cached.bids.length > 0 && cached.asks.length > 0) continue;
      const book = await this.provider.getOrderBook(position.tokenId, position.marketId);
      if (!book) continue;
      const hydrated = await this.withTickSize(book);
      this.orderBooks.set(position.tokenId, hydrated);
      this.db.saveOrderBook(hydrated);
    }
  }

  private async refreshOpenPositionSourceTrades(): Promise<void> {
    if (this.config.sourceExitEnabled === false || this.config.sourceExitPollingEnabled === false) return;
    const limit = this.config.sourceExitWalletTradeLimit ?? 80;
    const minIntervalMs = this.config.sourceExitPollIntervalMs ?? 30_000;
    const now = Date.now();
    const wallets = new Set<string>();
    for (const item of this.db.getOpenPositionSourceWallets()) {
      for (const wallet of item.wallets) {
        const lastPoll = this.sourceExitPolls.get(wallet) ?? 0;
        if (now - lastPoll >= minIntervalMs) wallets.add(wallet);
      }
    }
    if (wallets.size === 0) return;
    let fetched = 0;
    let inserted = 0;
    for (const wallet of wallets) {
      try {
        const trades = await this.provider.getWalletTrades(wallet, limit);
        fetched += trades.length;
        inserted += this.db.saveWalletTrades(trades);
        this.sourceExitPolls.set(wallet, now);
      } catch (error) {
        this.db.log("WARN", "source exit wallet refresh failed", { wallet, error: String(error) });
      }
    }
    this.events.write({
      type: "source_exit.sources_refreshed",
      agent: "Overseer Agent",
      visibility: "PRIVATE",
      message: "Refreshed source wallets for open-position exit detection.",
      payload: { wallets: wallets.size, fetched, inserted, limit }
    });
  }

  private async withTickSize(book: OrderBookSnapshot): Promise<OrderBookSnapshot> {
    const cached = this.tickSizes.get(book.tokenId);
    if (cached !== undefined) return { ...book, tickSize: book.tickSize ?? cached };
    const tickSize = book.tickSize ?? await this.provider.getTickSize(book.tokenId);
    if (tickSize !== undefined) this.tickSizes.set(book.tokenId, tickSize);
    return { ...book, tickSize };
  }

  private logParityScorecard(): void {
    const intervalMs = this.config.parityScorecardIntervalMs ?? 15 * 60_000;
    if (Date.now() - this.lastParityScorecardAt < intervalMs) return;
    this.lastParityScorecardAt = Date.now();
    const scorecard = this.db.getParityScorecard(24);
    this.db.log("INFO", "parity scorecard", scorecard);
    this.events.write({
      type: "parity.scorecard",
      agent: "Overseer Agent",
      visibility: "PUBLIC",
      message: `Stored portfolio executable PnL $${scorecard.executableTotalPnl.toFixed(2)}; ${scorecard.filledOrders} filled order(s) in ${scorecard.lookbackHours}h.`,
      payload: scorecard
    });
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
      lossStreak: this.db.getLossStreak(),
      tradesToday: this.db.getTradesToday()
    };
  }

  private expireStaleOrders(): void {
    const expired = this.db.expireStalePaperOrders();
    if (expired === 0) return;
    this.db.log("INFO", "expired stale paper orders", { expired });
    this.events.write({
      type: "orders.expired",
      agent: "Overseer Agent",
      visibility: "PRIVATE",
      message: `Expired ${expired} stale paper order(s).`,
      payload: { expired }
    });
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
    const shadow = this.db.getForwardShadowScorecard(this.config.performanceStartAt ?? 0);
    console.log(`Forward live-executable shadow: ${shadow.liveExecutableSimulated ?? 0}`);
    console.log(`Forward live-executable shadow PnL: $${(shadow.liveExecutablePnl ?? 0).toFixed(2)}`);
    const weather = this.db.getWeatherForwardScorecard({
      since: this.config.weatherForwardPolicyStartAt ?? 0,
      policyVersion: this.config.weatherForwardPolicyVersion ?? "weather-unfrozen",
      positionSizeUsd: this.config.independentModelFlatPositionSize ?? this.config.minPositionSize,
      minResolvedTrades: this.config.weatherForwardMinResolvedTrades ?? 30,
      minReturnPct: this.config.weatherForwardMinReturnPct ?? 0.05
    });
    console.log(`Weather forward selected/resolved: ${weather.uniqueCandidates}/${weather.resolved}`);
    console.log(`Weather forward promotion: ${weather.promotionEligible ? "ELIGIBLE" : "NOT ELIGIBLE"} (${weather.promotionReason})`);
    const crypto = this.db.getStrategyForwardScorecard({
      strategyId: CRYPTO_THRESHOLD_STRATEGY_ID,
      cluster: "CRYPTO_THRESHOLD",
      since: this.config.cryptoThresholdForwardPolicyStartAt ?? 0,
      policyVersion: this.config.cryptoThresholdForwardPolicyVersion ?? "crypto-unfrozen",
      positionSizeUsd: this.config.independentModelFlatPositionSize ?? this.config.minPositionSize,
      minResolvedTrades: this.config.cryptoThresholdForwardMinResolvedTrades ?? 30,
      minReturnPct: this.config.cryptoThresholdForwardMinReturnPct ?? 0.05
    });
    console.log(`Crypto forward selected/resolved: ${crypto.uniqueCandidates}/${crypto.resolved}`);
    console.log(`Crypto forward promotion: ${crypto.promotionEligible ? "ELIGIBLE" : "NOT ELIGIBLE"} (${crypto.promotionReason})`);
    const macro = this.db.getStrategyForwardScorecard({
      strategyId: MACRO_CPI_STRATEGY_ID,
      cluster: "MACRO_RELEASE",
      since: this.config.macroCpiForwardPolicyStartAt ?? 0,
      policyVersion: this.config.macroCpiForwardPolicyVersion ?? "macro-cpi-unfrozen",
      positionSizeUsd: this.config.independentModelFlatPositionSize ?? this.config.minPositionSize,
      minResolvedTrades: this.config.macroCpiForwardMinResolvedTrades ?? 30,
      minReturnPct: this.config.macroCpiForwardMinReturnPct ?? 0.05
    });
    console.log(`Macro CPI forward selected/resolved: ${macro.uniqueCandidates}/${macro.resolved}`);
    console.log(`Macro CPI forward promotion: ${macro.promotionEligible ? "ELIGIBLE" : "NOT ELIGIBLE"} (${macro.promotionReason})`);
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

  private plainLiveReadinessReport(): string {
    return formatPlainLiveReadinessReport(this.db.getLiveReadinessReport(this.config, 24), this.config);
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

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, items.length)) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      output[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return output;
}

const arg = process.argv[2];
const mode = (arg === "dev" || arg === "performance" || arg === "shadow" || arg === "readiness" ? arg : "scan") satisfies Mode;
const bot = new PolymarketPaperBot();
if (mode === "dev") {
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    void bot.stop().finally(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
await bot.start(mode);
