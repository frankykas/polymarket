import type { BotDatabase } from "../db.js";
import {
  applyShadowPerformanceToScore,
  applyPaperPerformanceToScore,
  calculateShadowScoreImpact,
  discoverWallets,
  generateSignalsWithDiagnostics,
  inferMarketCategory,
  scoreDiscoveredWallet,
  scoreWallet,
  type SignalDropDiagnostics
} from "../engines.js";
import type { AgentEventWriter } from "../events/eventWriter.js";
import type { PolymarketProvider } from "../providers/polymarketProvider.js";
import { applyWalletResearchToScore } from "./walletResearchAgent.js";
import { runShadowBacktest, summarizeShadowBacktest, summarizeShadowPerformanceByWallet, summarizeShadowPerformanceByWalletAndCategory } from "../shadowBacktest.js";
import { categoryEligibility, liveShadowPolicyVersion } from "../tradingPolicy.js";
import { parseWeatherMarket } from "./weatherStrategyAgent.js";
import type {
  BotConfig,
  MarketCategory,
  MarketSnapshot,
  OrderBookSnapshot,
  ShadowWalletPerformance,
  TradeSignal,
  TrackedWallet,
  WalletScore,
  WalletResearchReport,
  WalletTrade
} from "../types.js";

export interface SignalAgentResult {
  markets: MarketSnapshot[];
  scores: WalletScore[];
  discovered: number;
  discoveryTrades: number;
  allTrades: WalletTrade[];
}

function uniqueMarkets(markets: MarketSnapshot[]): MarketSnapshot[] {
  const seen = new Set<string>();
  return markets.filter((market) => {
    const key = market.conditionId ?? market.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function selectDedicatedWeatherMarkets(
  markets: MarketSnapshot[],
  validatedStations: ReadonlySet<string>,
  eventLimit: number,
  now = Date.now()
): MarketSnapshot[] {
  const groups = new Map<string, { markets: MarketSnapshot[]; station?: string; endAt: number; volume24h: number }>();
  for (const market of markets) {
    const spec = parseWeatherMarket(market, now);
    if (!spec) continue;
    const key = market.eventId ?? `${spec.stationCode ?? spec.city.toLowerCase()}:${spec.targetDate}`;
    const current = groups.get(key) ?? {
      markets: [],
      station: spec.stationCode?.toUpperCase(),
      endAt: market.endDate ? Date.parse(market.endDate) : Number.POSITIVE_INFINITY,
      volume24h: 0
    };
    current.markets.push(market);
    current.station ??= spec.stationCode?.toUpperCase();
    current.endAt = Math.min(current.endAt, market.endDate ? Date.parse(market.endDate) : Number.POSITIVE_INFINITY);
    current.volume24h += Math.max(0, market.volume24h);
    groups.set(key, current);
  }
  return [...groups.entries()]
    .sort((a, b) =>
      Number(Boolean(b[1].station && validatedStations.has(b[1].station))) - Number(Boolean(a[1].station && validatedStations.has(a[1].station))) ||
      a[1].endAt - b[1].endAt ||
      b[1].volume24h - a[1].volume24h ||
      a[0].localeCompare(b[0])
    )
    .slice(0, Math.max(1, Math.floor(eventLimit)))
    .flatMap((entry) => entry[1].markets);
}

function parsePassedWeatherStations(raw: number | string | boolean | null | undefined): Set<string> {
  if (typeof raw !== "string" || raw.length === 0) return new Set();
  try {
    const parsed = JSON.parse(raw) as Record<string, { passed?: unknown }>;
    return new Set(Object.entries(parsed)
      .filter(([, skill]) => skill?.passed === true)
      .map(([station]) => station.toUpperCase()));
  } catch {
    return new Set();
  }
}

export class SignalAgent {
  private cycleDiagnostics = createSignalDiagnosticsAccumulator();
  private paperExplorationCandidatesThisCycle = 0;

  constructor(
    private provider: PolymarketProvider,
    private db: BotDatabase,
    private events: AgentEventWriter,
    private config: BotConfig
  ) {}

  async discoverAndScore(wallets: TrackedWallet[], researchReports: WalletResearchReport[] = []): Promise<SignalAgentResult> {
    this.cycleDiagnostics = createSignalDiagnosticsAccumulator();
    this.paperExplorationCandidatesThisCycle = 0;
    const baseMarkets = await this.provider.getActiveMarkets(this.config.marketScanLimit);
    let weatherMarketsFetched: MarketSnapshot[] = [];
    if (this.config.weatherStrategyEnabled !== false && this.config.weatherDedicatedDiscoveryEnabled !== false) {
      try {
        weatherMarketsFetched = await this.provider.getActiveWeatherMarkets(
          this.config.weatherDiscoveryEventFetchLimit ?? 80,
          this.config.weatherDiscoveryLookaheadHours ?? 60
        );
      } catch (error) {
        this.db.log("WARN", "dedicated weather discovery failed", { error: error instanceof Error ? error.message : String(error) });
      }
    }
    const latestWeatherValidation = this.db.getLatestStrategyBacktests().find((item) =>
      item.cluster === "WEATHER_FORECASTING" && item.testKind === "INDEPENDENT_FORECAST_SKILL"
    );
    const validatedStations = parsePassedWeatherStations(latestWeatherValidation?.metrics.stationSkillsJson);
    const dedicatedWeatherMarkets = selectDedicatedWeatherMarkets(
      weatherMarketsFetched,
      validatedStations,
      this.config.weatherDiscoveryEventSelectLimit ?? 12
    );
    if (this.config.weatherStrategyEnabled !== false && this.config.weatherDedicatedDiscoveryEnabled !== false) {
      const fetchedEvents = new Set(weatherMarketsFetched.map((market) => market.eventId ?? market.id));
      const selectedEvents = new Set(dedicatedWeatherMarkets.map((market) => market.eventId ?? market.id));
      const selectedStations = new Set(dedicatedWeatherMarkets
        .map((market) => parseWeatherMarket(market)?.stationCode)
        .filter((station): station is string => Boolean(station)));
      this.events.write({
        type: weatherMarketsFetched.length > 0 ? "weather_strategy.discovery_completed" : "weather_strategy.discovery_empty",
        agent: "Weather Strategy Agent",
        visibility: weatherMarketsFetched.length > 0 ? "PUBLIC" : "PRIVATE",
        message: weatherMarketsFetched.length > 0
          ? `Weather discovery admitted ${selectedEvents.size}/${fetchedEvents.size} upcoming complete event(s) (${dedicatedWeatherMarkets.length} markets).`
          : "Weather discovery found no upcoming highest-temperature events inside the configured lookahead.",
        payload: {
          fetchedMarkets: weatherMarketsFetched.length,
          fetchedEvents: fetchedEvents.size,
          selectedMarkets: dedicatedWeatherMarkets.length,
          selectedEvents: selectedEvents.size,
          selectedStations: selectedStations.size,
          validatedStationsPrioritized: [...selectedStations].filter((station) => validatedStations.has(station)).length,
          lookaheadHours: this.config.weatherDiscoveryLookaheadHours ?? 60,
          eventFetchLimit: this.config.weatherDiscoveryEventFetchLimit ?? 80,
          eventSelectLimit: this.config.weatherDiscoveryEventSelectLimit ?? 12
        }
      });
    }
    const markets = uniqueMarkets([...baseMarkets, ...dedicatedWeatherMarkets]);
    const blockedCategories = new Set(this.config.blockedMarketCategories ?? []);
    const sourceDiscoveryMarkets = baseMarkets
      .filter((market) => !blockedCategories.has(inferMarketCategory(market)))
      .slice(0, this.config.maxWatchedMarkets);
    // Independent strategies do not inherit the wallet-copy allowlist or the
    // discovery cap. Their own frozen validation policies decide promotion.
    const independentCategories = new Set<MarketCategory>();
    if (this.config.weatherStrategyEnabled !== false) independentCategories.add("weather");
    if (this.config.cryptoThresholdStrategyEnabled !== false) independentCategories.add("crypto");
    if (this.config.macroCpiStrategyEnabled !== false) independentCategories.add("macro");
    const independentStrategyMarkets = markets.filter((market) => {
      const category = inferMarketCategory(market);
      return independentCategories.has(category) && !blockedCategories.has(category);
    });
    const watchedMarkets = uniqueMarkets([...sourceDiscoveryMarkets, ...independentStrategyMarkets]);
    for (const market of markets) this.db.saveMarket(market);
    this.events.write({
      type: "market.discovery_completed",
      agent: "Signal Agent",
      visibility: "PUBLIC",
      message: `Signal Agent scanned ${watchedMarkets.length} active markets.`,
      payload: {
        marketCount: watchedMarkets.length,
        sourceDiscoveryMarketCount: sourceDiscoveryMarkets.length,
        independentStrategyMarketCount: independentStrategyMarkets.length,
        fetchedMarketCount: markets.length,
        volumeRankedMarketCount: baseMarkets.length,
        dedicatedWeatherMarketsFetched: weatherMarketsFetched.length,
        dedicatedWeatherMarketsSelected: dedicatedWeatherMarkets.length,
        dedicatedWeatherEventsSelected: new Set(dedicatedWeatherMarkets.map((market) => market.eventId ?? market.id)).size,
        validatedWeatherStationsPrioritized: validatedStations.size,
        blockedCategories: this.config.blockedMarketCategories ?? [],
        allowedCategories: this.config.allowedMarketCategories ?? []
      }
    });

    const latestScoreAt = this.db.getLatestWalletScoreAt();
    const scoreRefreshInterval = this.config.sourceScoringRefreshIntervalMs ?? 6 * 60 * 60_000;
    if (latestScoreAt > 0 && latestScoreAt >= Date.now() - scoreRefreshInterval) {
      const scores = this.db.getWalletScoresUpdatedSince(
        Math.max(0, latestScoreAt - 60_000),
        Math.max(100, this.config.maxDiscoveredWallets * 3)
      );
      const cachedWallets: TrackedWallet[] = scores.map((score) => ({
        address: score.wallet,
        label: score.label ?? "cached-audited-source",
        enabled: true
      }));
      for (const wallet of wallets) {
        if (!cachedWallets.some((candidate) => candidate.address.toLowerCase() === wallet.address.toLowerCase())) cachedWallets.push(wallet);
      }
      this.db.syncWallets(cachedWallets);
      const walletTrades = await this.fetchWalletTrades(cachedWallets);
      const allTrades = [...walletTrades.values()].flat();
      this.events.write({
        type: "source.scoring_cache_used",
        agent: "Signal Agent",
        visibility: "PUBLIC",
        message: `Hot scan reused ${scores.length} recently audited source score(s) and polled fresh source activity.`,
        payload: {
          scoreSnapshotAt: latestScoreAt,
          nextFullRefreshAfter: latestScoreAt + scoreRefreshInterval,
          sourcesPolled: cachedWallets.length,
          sourceTradesLoaded: allTrades.length
        }
      });
      return {
        markets: watchedMarkets,
        scores,
        discovered: 0,
        discoveryTrades: 0,
        allTrades
      };
    }

    const discoveryTrades = this.config.discoveryEnabled ? await this.fetchDiscoveryTrades(sourceDiscoveryMarkets) : [];
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
    for (const wallet of discoveredWallets) this.db.saveDiscoveredWallet(wallet);
    if (discoveredWallets.length > 0) {
      this.events.write({
        type: "source.discovery_summary",
        agent: "Signal Agent",
        message: `Discovery refreshed ${discoveredWallets.length} candidate source wallet(s).`,
        payload: {
          candidates: discoveredWallets.length,
          highScoreCandidates: discoveredWallets.filter((wallet) => wallet.score >= this.config.minWalletScore).length,
          categories: [...new Set(discoveredWallets.map((wallet) => wallet.dominantCategory))]
        }
      });
    }

    const discoveredSeedScores = discoveredWallets.map((wallet) => scoreDiscoveredWallet(wallet));
    const activeSourceLimit = this.config.liveExecutableAutoTrackLimit ?? 25;
    const sourceSearchLimit = Math.max(activeSourceLimit, activeSourceLimit * 4);
    // wallet_scores contains lifetime aggregates. Once a fresh performance epoch is
    // configured, only source-timestamped forward evidence may promote a source.
    const snapshotLiveExecutableSeedScores = this.config.liveExecutableAutoTrackEnabled === false || (this.config.performanceStartAt ?? 0) > 0
      ? []
      : this.db.getTopLiveExecutableWalletScores({
          limit: sourceSearchLimit,
          minWalletScore: this.config.minWalletScore,
          minTrades: this.config.minLiveExecutableShadowTradesForTrading ?? 8,
          minPnl: this.config.minLiveExecutableShadowPnlForTrading ?? 0,
          minReturnPct: this.config.liveExecutableMinReturnPct ?? 0.03,
          minSourceSellRatio: this.config.minSourceSellRealizedRatio ?? 0.35,
          minWinRate: this.config.minLiveExecutableShadowWinRateForTrading ?? 0.45
        }).filter((score) => !score.dominantCategory || categoryEligibility(score.dominantCategory, this.config).eligible).slice(0, activeSourceLimit);
    const durableLiveExecutableSeedScores = this.config.liveExecutableAutoTrackEnabled === false
      ? []
      : this.db.getTopDurableLiveExecutableWalletScores({
          limit: sourceSearchLimit,
          minWalletScore: this.config.minWalletScore,
          minTrades: this.config.minLiveExecutableShadowTradesForTrading ?? 8,
          minPnl: this.config.minLiveExecutableShadowPnlForTrading ?? 0,
          minReturnPct: this.config.liveExecutableMinReturnPct ?? 0.03,
          minSourceSellRatio: this.config.minSourceSellRealizedRatio ?? 0.35,
          minWinRate: this.config.minLiveExecutableShadowWinRateForTrading ?? 0.45,
          sourceTimestampSince: this.config.performanceStartAt ?? 0,
          policyVersion: liveShadowPolicyVersion(this.config),
          excludedCategories: this.config.blockedMarketCategories,
          includedCategories: this.config.allowedMarketCategories,
          enforceCategoryAllowlist: this.config.categoryTradingGateEnabled === true
        }).filter((score) => !score.dominantCategory || categoryEligibility(score.dominantCategory, this.config).eligible).slice(0, activeSourceLimit);
    const liveExecutableSeedScores = mergeScores(durableLiveExecutableSeedScores, snapshotLiveExecutableSeedScores);
    const durableLiveExecutableByWallet = new Map(durableLiveExecutableSeedScores.map((score) => [score.wallet.toLowerCase(), score]));
    if (liveExecutableSeedScores.length > 0) {
      this.events.write({
        type: "source.live_executable_research_lead",
        agent: "Signal Agent",
        visibility: "PUBLIC",
        message: `Retained ${liveExecutableSeedScores.length} live-executable shadow source(s) as research leads for active scoring.`,
        payload: {
          durableSources: durableLiveExecutableSeedScores.length,
          snapshotSources: snapshotLiveExecutableSeedScores.length,
          wallets: liveExecutableSeedScores.slice(0, 10).map((score) => ({
            wallet: score.wallet,
            score: score.score,
            liveExecutableShadowPnl: score.liveExecutableShadowPnl,
            liveExecutableShadowAvgReturnPct: score.liveExecutableShadowAvgReturnPct,
            sourceSellRealizedRatio: score.sourceSellRealizedRatio
          }))
        }
      });
    }
    const discoveredScores = this.config.autoTrackDiscoveredWallets
      ? discoveredSeedScores.filter((score) => score.score >= this.config.minWalletScore)
      : [];
    const promotedSeedScores = mergeScores(liveExecutableSeedScores, discoveredScores);
    const deepHistorySeedScores = this.config.autoTrackDiscoveredWallets && this.config.deepHistoryEnabled
      ? mergeScores(liveExecutableSeedScores, discoveredSeedScores)
          .sort((a, b) => (b.copyabilityScore ?? b.score) - (a.copyabilityScore ?? a.score))
          .slice(0, Math.max(0, this.config.deepHistoryWalletLimit))
      : [];
    const researchDirectionalWallets: TrackedWallet[] = researchReports
      .filter((report) => report.recommendation === "SHADOW_DIRECTIONAL")
      .map((report) => ({
        address: report.wallet,
        label: "research-directional-shadow",
        enabled: true
      }));
    const trackedWallets = [...wallets];
    for (const wallet of researchDirectionalWallets) {
      if (!trackedWallets.some((tracked) => tracked.address.toLowerCase() === wallet.address.toLowerCase())) trackedWallets.push(wallet);
    }
    for (const wallet of mergeScores(deepHistorySeedScores, promotedSeedScores)) {
      if (!trackedWallets.some((tracked) => tracked.address.toLowerCase() === wallet.wallet.toLowerCase())) {
        trackedWallets.push({ address: wallet.wallet, label: wallet.label ?? "live-exec-shadow", enabled: true });
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
    const shadowPerformance = this.runShadowBacktests(baseScores, walletTrades, historyMarkets, discoveryTrades, researchReports);
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
    const researchByWallet = new Map(researchReports.map((report) => [report.wallet.toLowerCase(), report]));
    const auditedScores = baseScores
      .map((score) => applyShadowPerformanceToScore(score, shadowPerformance.byWallet.get(score.wallet.toLowerCase())))
      .map((score) => applyDurableLiveExecutableEvidence(score, durableLiveExecutableByWallet.get(score.wallet.toLowerCase()), this.config))
      .map((score) => applyPaperPerformanceToScore(score, paperPerformance.get(score.wallet.toLowerCase())))
      .map((score) => applyWalletResearchToScore(score, researchByWallet.get(score.wallet.toLowerCase())))
      .map((score) => ({
        ...score,
        shadowCategoryImpacts: shadowPerformance.categoryImpacts.get(score.wallet.toLowerCase())
      }))
      .sort((a, b) => b.score - a.score);
    const explorationScoutScores = this.paperExplorationScoutScores(discoveredSeedScores, auditedScores);
    const scores = mergeScores(explorationScoutScores, auditedScores)
      .sort((a, b) => b.score - a.score);
    const scoutCount = explorationScoutScores.length;
    if (scoutCount > 0) {
      this.events.write({
        type: "source.paper_exploration_scouted",
        agent: "Signal Agent",
        visibility: "PUBLIC",
        message: `Added ${scoutCount} fresh discovery source(s) to paper exploration scoring.`,
        payload: {
          scouts: scores
            .filter((score) => score.label === "paper-exploration")
            .slice(0, 10)
            .map((score) => ({
              wallet: score.wallet,
              score: score.score,
              copyabilityScore: score.copyabilityScore,
              sourceSellRealizedRatio: score.sourceSellRealizedRatio,
              recentTradeCount: score.recentTradeCount
            }))
        }
      });
    }
    for (const score of scores) this.db.saveWalletScore(score);
    if (scores.length > 0) {
      this.events.write({
        type: "source.scoring_summary",
        agent: "Signal Agent",
        message: `Scored ${scores.length} source wallet(s).`,
        payload: {
          sources: scores.length,
          tradeableSources: scores.filter((score) => !score.flags.some((flag) => [
            "SHADOW_COPY_UNDERPERFORMS",
            "LIVE_EXECUTABLE_SHADOW_NEGATIVE",
            "PAPER_COPY_UNDERPERFORMS",
            "RESEARCH_DO_NOT_COPY"
          ].includes(flag))).length,
          highReliabilitySources: scores.filter((score) => score.reliability === "HIGH").length
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
    const { signals: generatedSignals, diagnostics } = generateSignalsWithDiagnostics(input.market, input.books, input.trades, input.scores, this.config);
    const signals = generatedSignals.map((signal) => this.enforcePaperExplorationCap(signal));
    this.recordSignalDiagnostics(input.market, diagnostics);
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
          reason: signal.reason,
          parityStatus: signal.parityStatus,
          parityReason: signal.parityReason,
          expectedLiveExecutableReturnPct: signal.expectedLiveExecutableReturnPct,
          sourceSellRealizedRatio: signal.sourceSellRealizedRatio,
          entryDepthMultiple: signal.entryDepthMultiple
        }
      });
    }
    return signals;
  }

  flushSignalDiagnostics(): void {
    if (this.config.signalDiagnosticsEnabled === false) return;
    const payload = {
      marketsReviewed: this.cycleDiagnostics.marketsReviewed,
      marketsWithSignals: this.cycleDiagnostics.marketsWithSignals,
      totalTrades: this.cycleDiagnostics.totalTrades,
      buyTrades: this.cycleDiagnostics.buyTrades,
      scoredBuyTrades: this.cycleDiagnostics.scoredBuyTrades,
      groupedMarkets: this.cycleDiagnostics.groupedMarkets,
      emittedSignals: this.cycleDiagnostics.emittedSignals,
      tradeCandidates: this.cycleDiagnostics.tradeCandidates,
      watchlist: this.cycleDiagnostics.watchlist,
      topDropReasons: topEntries(this.cycleDiagnostics.dropReasons, 12),
      topSourceRejectReasons: topEntries(this.cycleDiagnostics.sourceRejectReasons, 12),
      activeMarketsWithSignals: this.cycleDiagnostics.activeMarketsWithSignals.slice(0, 10)
    };
    this.db.log("INFO", "signal diagnostics", payload);
    this.events.write({
      type: "signal.diagnostics",
      agent: "Signal Agent",
      message: `Signal diagnostics: ${payload.tradeCandidates} candidate(s), ${payload.emittedSignals} emitted signal(s).`,
      payload
    });
  }

  private enforcePaperExplorationCap(signal: TradeSignal): TradeSignal {
    if (signal.decision !== "TRADE_CANDIDATE" || !signal.reason.startsWith("paper exploration:")) return signal;
    const max = this.config.paperExplorationMaxCandidatesPerCycle ?? 2;
    if (this.paperExplorationCandidatesThisCycle < max) {
      this.paperExplorationCandidatesThisCycle += 1;
      return signal;
    }
    return {
      ...signal,
      decision: "WATCHLIST",
      reason: `paper exploration cap reached; ${signal.reason}`
    };
  }

  private recordSignalDiagnostics(market: MarketSnapshot, diagnostics: SignalDropDiagnostics): void {
    if (this.config.signalDiagnosticsEnabled === false) return;
    this.cycleDiagnostics.marketsReviewed += 1;
    this.cycleDiagnostics.totalTrades += diagnostics.totalTrades;
    this.cycleDiagnostics.buyTrades += diagnostics.buyTrades;
    this.cycleDiagnostics.scoredBuyTrades += diagnostics.scoredBuyTrades;
    this.cycleDiagnostics.groupedMarkets += diagnostics.groupedMarkets;
    this.cycleDiagnostics.emittedSignals += diagnostics.emittedSignals;
    this.cycleDiagnostics.tradeCandidates += diagnostics.tradeCandidates;
    this.cycleDiagnostics.watchlist += diagnostics.watchlist;
    mergeReasonCounts(this.cycleDiagnostics.dropReasons, diagnostics.dropReasons);
    mergeReasonCounts(this.cycleDiagnostics.sourceRejectReasons, diagnostics.sourceRejectReasons);
    if (diagnostics.emittedSignals > 0) {
      this.cycleDiagnostics.marketsWithSignals += 1;
      this.cycleDiagnostics.activeMarketsWithSignals.push({
        marketId: market.id,
        question: market.question,
        emittedSignals: diagnostics.emittedSignals,
        tradeCandidates: diagnostics.tradeCandidates,
        watchlist: diagnostics.watchlist
      });
    }
  }

  async fetchWalletTrades(wallets: TrackedWallet[], deepHistoryWallets = new Set<string>()): Promise<Map<string, WalletTrade[]>> {
    const trades = new Map<string, WalletTrade[]>();
    const fetched = await mapWithConcurrency(wallets, 4, async (wallet) => {
      const deepHistory = deepHistoryWallets.has(wallet.address.toLowerCase());
      const walletTrades = deepHistory
        ? await this.fetchPaginatedWalletTrades(wallet.address)
        : await this.provider.getWalletTrades(wallet.address, this.config.walletActivityLimit);
      return { wallet, deepHistory, walletTrades };
    });
    for (const { wallet, deepHistory, walletTrades } of fetched) {
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
    const batches = await mapWithConcurrency(markets.slice(0, this.config.discoveryMarketLimit), 6, (market) =>
      this.provider.getMarketTrades(market.conditionId ?? market.id, this.config.discoveryTradesPerMarket)
    );
    return batches.flat();
  }

  private async fetchPositionPreviews(trades: WalletTrade[]) {
    const wallets = [...new Set(trades.map((trade) => trade.wallet))].slice(0, this.config.maxDiscoveredWallets);
    const positions = await mapWithConcurrency(wallets, 6, (wallet) => this.provider.getWalletPositions(wallet));
    return positions.flat();
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
    discoveryTrades: WalletTrade[],
    researchReports: WalletResearchReport[]
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
    const forwardSince = this.config.performanceStartAt ?? 0;
    const forwardTrades = allShadowTrades.filter((trade) => trade.forwardEligible === true);
    const researchFirstObserved = new Map(researchReports.map((report) => [report.wallet.toLowerCase(), report.firstObservedAt]));
    const promotionTrades = forwardTrades.filter((trade) =>
      (!trade.category || categoryEligibility(trade.category, this.config).eligible) &&
      trade.sourceTimestamp >= (researchFirstObserved.get(trade.wallet.toLowerCase()) ?? forwardSince)
    );
    const forwardReport = summarizeShadowBacktest(promotionTrades);
    const byWallet = summarizeShadowPerformanceByWallet(promotionTrades);
    const byWalletAndCategory = summarizeShadowPerformanceByWalletAndCategory(promotionTrades);
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
        avgReturnPct: report.avgReturnPct,
        forwardSince,
        forwardShadowTrades: forwardTrades.length,
        promotionEligibleShadowTrades: promotionTrades.length,
        forwardSimulated: forwardReport.simulated,
        forwardPnl: forwardReport.pnl,
        forwardLiveExecutableSimulated: forwardReport.liveExecutableSimulated,
        forwardLiveExecutablePnl: forwardReport.liveExecutablePnl
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

  private paperExplorationScoutScores(discoveredScores: WalletScore[], auditedScores: WalletScore[]): WalletScore[] {
    if (!this.config.paperMode || this.config.paperExplorationEnabled !== true) return [];
    const auditedByWallet = new Map(auditedScores.map((score) => [score.wallet.toLowerCase(), score]));
    const minScore = this.config.paperProbationMinWalletScore ?? this.config.minWalletScore;
    const minCopyability = this.config.paperProbationMinCopyabilityScore ?? this.config.minCopyabilityForPromotion ?? this.config.minWalletScore;
    const minSampleConfidence = this.config.paperProbationMinSampleConfidence ?? 0.55;
    const minSourceSellRatio = this.config.paperExplorationMinSourceSellRealizedRatio ?? this.config.minSourceSellRealizedRatio ?? 0.3;
    return discoveredScores
      .filter((score) => {
        const audited = auditedByWallet.get(score.wallet.toLowerCase());
        if (audited?.flags.some((flag) => flag === "LIVE_EXECUTABLE_SHADOW_NEGATIVE" || flag === "PAPER_COPY_UNDERPERFORMS")) return false;
        if ((audited?.liveExecutableShadowSimulated ?? 0) >= (this.config.paperProbationKnownBadLiveExecTrades ?? 3) &&
          (audited?.liveExecutableShadowPnl ?? 0) <= (this.config.minLiveExecutableShadowPnlForTrading ?? 0)) return false;
        if (score.score < minScore) return false;
        if ((score.copyabilityScore ?? score.score) < minCopyability) return false;
        if ((score.sampleConfidence ?? 0) < minSampleConfidence) return false;
        if ((score.sourceSellRealizedRatio ?? 0) < minSourceSellRatio) return false;
        return true;
      })
      .map((score) => ({
        ...score,
        label: "paper-exploration",
        flags: [...new Set(score.flags.filter((flag) => flag !== "DISCOVERY_LOW_SCORE").concat("PAPER_EXPLORATION_SCOUT"))]
      }));
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

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

interface ShadowPerformanceResult {
  byWallet: Map<string, ShadowWalletPerformance>;
  categoryImpacts: Map<string, Partial<Record<MarketCategory, number>>>;
}

interface SignalDiagnosticsAccumulator extends SignalDropDiagnostics {
  marketsReviewed: number;
  marketsWithSignals: number;
  activeMarketsWithSignals: Array<{
    marketId: string;
    question: string;
    emittedSignals: number;
    tradeCandidates: number;
    watchlist: number;
  }>;
}

function createSignalDiagnosticsAccumulator(): SignalDiagnosticsAccumulator {
  return {
    marketsReviewed: 0,
    marketsWithSignals: 0,
    totalTrades: 0,
    buyTrades: 0,
    scoredBuyTrades: 0,
    groupedMarkets: 0,
    emittedSignals: 0,
    tradeCandidates: 0,
    watchlist: 0,
    dropReasons: {},
    sourceRejectReasons: {},
    activeMarketsWithSignals: []
  };
}

function mergeReasonCounts(target: Record<string, number>, source: Record<string, number>): void {
  for (const [reason, count] of Object.entries(source)) target[reason] = (target[reason] ?? 0) + count;
}

function topEntries(record: Record<string, number>, limit: number): Array<{ reason: string; count: number }> {
  return Object.entries(record)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function applyDurableLiveExecutableEvidence(score: WalletScore, durable: WalletScore | undefined, config: BotConfig): WalletScore {
  if (!durable) return score;
  const durableLiveN = durable.liveExecutableShadowSimulated ?? 0;
  const durableLivePnl = durable.liveExecutableShadowPnl ?? 0;
  const durableLiveReturn = durable.liveExecutableShadowAvgReturnPct ?? 0;
  const durableSourceSellRatio = durable.sourceSellRealizedRatio ?? 0;
  const durableLiveWinRate = durable.liveExecutableShadowWinRate ?? 0;
  const passesGate = durableLiveN >= (config.minLiveExecutableShadowTradesForTrading ?? 8) &&
    durableLivePnl > (config.minLiveExecutableShadowPnlForTrading ?? 0) &&
    durableLiveReturn > (config.liveExecutableMinReturnPct ?? 0.03) &&
    durableLiveWinRate >= (config.minLiveExecutableShadowWinRateForTrading ?? 0.45) &&
    durableSourceSellRatio >= (config.minSourceSellRealizedRatio ?? 0.35);
  if (!passesGate) return score;

  const currentLiveN = score.liveExecutableShadowSimulated ?? 0;
  const useDurableLive = durableLiveN >= currentLiveN || (score.liveExecutableShadowPnl ?? 0) <= 0;
  const flags = score.flags.filter((flag) =>
    ![
      "LOW_LIVE_EXECUTABLE_SHADOW_RATE",
      "LIVE_EXECUTABLE_SHADOW_NEGATIVE",
      "LOW_SOURCE_SELL_REALIZATION"
    ].includes(flag)
  );
  return {
    ...score,
    label: score.label ?? durable.label,
    score: Math.max(score.score, durable.score),
    copyabilityScore: Math.max(score.copyabilityScore ?? score.score, durable.copyabilityScore ?? durable.score),
    reliability: score.reliability === "HIGH" || durable.reliability === "HIGH" ? "HIGH" : score.reliability,
    flags: [...new Set([...flags, "DURABLE_LIVE_EXECUTABLE_SHADOW", "SHADOW_PROVEN_COPYABLE"])],
    sourceSellShadowRealized: Math.max(score.sourceSellShadowRealized ?? 0, durable.sourceSellShadowRealized ?? 0),
    sourceSellRealizedRatio: Math.max(score.sourceSellRealizedRatio ?? 0, durableSourceSellRatio),
    liveExecutableShadowSimulated: useDurableLive ? durableLiveN : score.liveExecutableShadowSimulated,
    liveExecutableShadowPnl: useDurableLive ? durableLivePnl : score.liveExecutableShadowPnl,
    liveExecutableShadowAvgReturnPct: useDurableLive ? durableLiveReturn : score.liveExecutableShadowAvgReturnPct,
    liveExecutableShadowWinRate: useDurableLive ? durable.liveExecutableShadowWinRate : score.liveExecutableShadowWinRate
  };
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

export function mergeScores(configured: WalletScore[], discovered: WalletScore[]): WalletScore[] {
  const scores = new Map<string, WalletScore>();
  for (const score of discovered) scores.set(score.wallet.toLowerCase(), score);
  for (const score of configured) scores.set(score.wallet.toLowerCase(), score);
  return [...scores.values()].sort((a, b) => b.score - a.score);
}
