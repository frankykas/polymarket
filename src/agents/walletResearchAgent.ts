import type { BotDatabase } from "../db.js";
import type { AgentEventWriter } from "../events/eventWriter.js";
import type { PolymarketProvider } from "../providers/polymarketProvider.js";
import type {
  BotConfig,
  ClosedWalletPosition,
  LeaderboardCategory,
  LeaderboardPeriod,
  TraderLeaderboardEntry,
  WalletResearchArchetype,
  WalletResearchReport,
  WalletResearchRecommendation,
  WalletScore,
  WalletTrade
} from "../types.js";

/** Every category is researched. Trading category gates are intentionally applied later. */
const RESEARCH_CATEGORIES: LeaderboardCategory[] = [
  "OVERALL", "POLITICS", "SPORTS", "ESPORTS", "CRYPTO", "CULTURE",
  "ECONOMICS", "TECH", "FINANCE", "WEATHER", "MENTIONS"
];
const RESEARCH_PERIODS: LeaderboardPeriod[] = ["DAY", "WEEK", "MONTH", "ALL"];

interface ResearchCandidate {
  wallet: string;
  name?: string;
  entries: TraderLeaderboardEntry[];
}

export class WalletResearchAgent {
  constructor(
    private provider: PolymarketProvider,
    private db: BotDatabase,
    private events: AgentEventWriter,
    private config: BotConfig
  ) {}

  async refresh(force = false): Promise<WalletResearchReport[]> {
    const limit = this.config.walletResearchCandidateLimit ?? 100;
    if (this.config.walletResearchEnabled === false) return this.db.getWalletResearchReports(limit);
    const interval = this.config.walletResearchIntervalMs ?? 6 * 60 * 60 * 1000;
    const cachedReports = this.db.getWalletResearchReports(limit);
    if (!force && cachedReports.length >= limit && this.db.getLatestWalletResearchAt() >= Date.now() - interval) {
      return cachedReports;
    }

    const leaderboardResults = await Promise.allSettled(
      RESEARCH_CATEGORIES.flatMap((category) => RESEARCH_PERIODS.map((period) =>
        this.provider.getTraderLeaderboard(category, period, 30)
      ))
    );
    const leaderboards = leaderboardResults
      .filter((result): result is PromiseFulfilledResult<TraderLeaderboardEntry[]> => result.status === "fulfilled")
      .flatMap((result) => result.value);
    const candidates = selectDiversifiedCandidates(leaderboards, limit);
    if (candidates.length === 0) {
      this.events.write({
        type: "wallet_research.refresh_failed",
        agent: "Wallet Research Agent",
        visibility: "PRIVATE",
        message: "Wallet Research could not load rolling all-category leaderboard candidates.",
        payload: { leaderboardRows: leaderboards.length, failedBoards: leaderboardResults.filter((result) => result.status === "rejected").length }
      });
      return this.db.getWalletResearchReports(limit);
    }

    const usable = await mapWithConcurrency(candidates, 3, (candidate) => this.profile(candidate));
    this.db.activateWalletResearchReports(usable);

    this.events.write({
      type: "wallet_research.refresh_completed",
      agent: "Wallet Research Agent",
      visibility: "PUBLIC",
      message: `Wallet Research profiled ${usable.length} rolling all-category leaderboard candidate(s).`,
      payload: {
        candidates: usable.length,
        directional: usable.filter((report) => report.archetype === "DIRECTIONAL_SPECIALIST").length,
        makerDominant: usable.filter((report) => report.archetype === "MAKER_SPECIALIST").length,
        pairedOutcome: usable.filter((report) => report.archetype === "PAIRED_OUTCOME_ARBITRAGE").length,
        doNotCopy: usable.filter((report) => report.recommendation === "DO_NOT_COPY").length,
        deepHistoryAvailable: usable.filter((report) => report.recentTrades > 0 || report.closedPositions > 0).length
      }
    });
    this.events.write({
      type: "wallet_research.handoff",
      agent: "Wallet Research Agent",
      visibility: "PRIVATE",
      message: "Wallet Research handed archetype and copyability findings to Signal and Wallet Intelligence.",
      payload: usable.map((report) => ({
        wallet: report.wallet,
        name: report.name,
        archetype: report.archetype,
        recommendation: report.recommendation,
        researchScore: report.researchScore,
        categories: report.leaderboardCategories,
        makerShare: report.estimatedMakerShare,
        copyableAt10Rate: report.copyableAt10Rate,
        closedPnl: report.closedPnl,
        closedWinRate: report.closedWinRate,
        patterns: report.patterns
      }))
    });
    return usable;
  }

  private async profile(candidate: ResearchCandidate): Promise<WalletResearchReport> {
    const tradeLimit = this.config.walletResearchTradeLimit ?? 1000;
    const closedLimit = this.config.walletResearchClosedPositionLimit ?? 200;
    const [allTrades, takerTrades, closed] = await Promise.all([
      this.provider.getWalletTradesByRole(candidate.wallet, tradeLimit, false),
      this.provider.getWalletTradesByRole(candidate.wallet, tradeLimit, true),
      this.provider.getWalletClosedPositions(candidate.wallet, closedLimit)
    ]);
    // The ordinary signal/shadow tape is deliberately taker-only. Persisting the
    // all-role research sample here would make maker fills look copyable later.
    // Model-only wallets also stay outside the signal tape entirely.
    const report = buildWalletResearchReport(candidate, allTrades, takerTrades, closed);
    if (allTrades.length === 0 && closed.length === 0) {
      report.reasons.unshift("deep trade/position history was unavailable during this refresh; retained as a leaderboard lead only");
      report.patterns.push("deep profile pending; no promotion allowed from leaderboard rank alone");
    }
    if (report.recommendation === "SHADOW_DIRECTIONAL" && takerTrades.length > 0) this.db.saveWalletTrades(takerTrades);
    return report;
  }
}

export function applyWalletResearchToScore(score: WalletScore, report?: WalletResearchReport): WalletScore {
  if (!report) return score;
  const flags = new Set(score.flags);
  flags.add(`RESEARCH_${report.archetype}`);
  if (report.recommendation === "DO_NOT_COPY" || report.recommendation === "MODEL_EDGE_ONLY") flags.add("RESEARCH_DO_NOT_COPY");
  if (report.recommendation === "SHADOW_DIRECTIONAL") {
    flags.add("RESEARCH_DIRECTIONAL_CANDIDATE");
    flags.add("RESEARCH_SHADOW_ONLY");
  }
  const copyPenalty = report.recommendation === "DO_NOT_COPY" ? 35 : report.recommendation === "MODEL_EDGE_ONLY" ? 25 : 0;
  const scorePenalty = report.recommendation === "DO_NOT_COPY" ? 20 : report.recommendation === "MODEL_EDGE_ONLY" ? 12 : 0;
  return {
    ...score,
    score: Math.max(0, score.score - scorePenalty),
    copyabilityScore: Math.max(0, (score.copyabilityScore ?? score.score) - copyPenalty),
    flags: [...flags]
  };
}

export function buildWalletResearchReport(
  candidate: ResearchCandidate,
  allTrades: WalletTrade[],
  takerTrades: WalletTrade[],
  closed: ClosedWalletPosition[],
  now = Date.now()
): WalletResearchReport {
  const buys = allTrades.filter((trade) => trade.side === "BUY");
  const sells = allTrades.filter((trade) => trade.side === "SELL");
  const groups = groupTradesByMarket(allTrades);
  const twoOutcomeMarkets = [...groups.values()].filter((trades) => new Set(trades.map((trade) => trade.outcome.toLowerCase())).size > 1).length;
  const roundTripMarkets = [...groups.values()].filter((trades) => new Set(trades.map((trade) => trade.side)).size > 1).length;
  const allKeys = new Set(allTrades.map(tradeIdentity));
  const takerKeys = new Set(takerTrades.map(tradeIdentity));
  const makerOnly = [...allKeys].filter((key) => !takerKeys.has(key)).length;
  const notionals = buys.map((trade) => trade.price * trade.size).sort((a, b) => a - b);
  const wins = closed.filter((position) => position.realizedPnl > 0);
  const losses = closed.filter((position) => position.realizedPnl < 0);
  const positivePnl = wins.reduce((sum, position) => sum + position.realizedPnl, 0);
  const top3Pnl = [...wins].sort((a, b) => b.realizedPnl - a.realizedPnl).slice(0, 3).reduce((sum, position) => sum + position.realizedPnl, 0);
  const closedPnl = closed.reduce((sum, position) => sum + position.realizedPnl, 0);
  const resolvedPredictions = closed.filter((position) => position.curPrice !== undefined && (position.curPrice <= 0.01 || position.curPrice >= 0.99));
  const predictionBrier = resolvedPredictions.length > 0
    ? average(resolvedPredictions.map((position) => (position.avgPrice - (position.curPrice! >= 0.99 ? 1 : 0)) ** 2))
    : undefined;
  const predictionAccuracy = resolvedPredictions.length > 0
    ? resolvedPredictions.filter((position) => (position.avgPrice >= 0.5) === (position.curPrice! >= 0.99)).length / resolvedPredictions.length
    : undefined;
  const makerShare = allKeys.size > 0 ? makerOnly / allKeys.size : 0;
  const copyableRate = buys.length > 0 ? notionals.filter((notional) => notional >= 10).length / buys.length : 0;
  const twoOutcomeRate = groups.size > 0 ? twoOutcomeMarkets / groups.size : 0;
  const roundTripRate = groups.size > 0 ? roundTripMarkets / groups.size : 0;
  const winRate = wins.length + losses.length > 0 ? wins.length / (wins.length + losses.length) : 0;
  const concentration = positivePnl > 0 ? top3Pnl / positivePnl : 0;
  const buyRate = allTrades.length > 0 ? buys.length / allTrades.length : 0;
  const archetype = classifyArchetype({ buyRate, makerShare, twoOutcomeRate, closed: closed.length, closedPnl, winRate, copyableRate, concentration });
  const recommendation = recommendationFor(archetype);
  const categories = unique(candidate.entries.map((entry) => entry.category));
  const periods = unique(candidate.entries.map((entry) => entry.period));
  const patterns = inferPatterns(allTrades, categories, { makerShare, copyableRate, twoOutcomeRate, roundTripRate, buyRate });
  if (predictionBrier !== undefined) patterns.push(`resolved-position Brier ${predictionBrier.toFixed(3)} across ${resolvedPredictions.length} positions`);
  const reasons = buildReasons(archetype, recommendation, { makerShare, copyableRate, twoOutcomeRate, winRate, concentration, closedPnl });
    const researchScore = calculateResearchScore({ periods: periods.length, closed: closed.length, closedPnl, winRate, concentration, predictionBrier });
    const executionCompatibilityScore = calculateExecutionCompatibilityScore({ makerShare, copyableRate, twoOutcomeRate, buyRate });
  return {
    wallet: candidate.wallet,
    name: candidate.name,
    firstObservedAt: now,
    archetype,
    recommendation,
    researchScore,
    executionCompatibilityScore,
    leaderboardAppearances: candidate.entries.length,
    leaderboardPeriods: periods,
    leaderboardCategories: categories,
    leaderboardPnl: Math.max(0, ...candidate.entries.map((entry) => entry.pnl)),
    leaderboardVolume: Math.max(0, ...candidate.entries.map((entry) => entry.volume)),
    recentTrades: allTrades.length,
    recentBuys: buys.length,
    recentSells: sells.length,
    closedPositions: closed.length,
    closedPnl,
    closedWinRate: winRate,
    resolvedPredictions: resolvedPredictions.length,
    predictionBrier,
    predictionAccuracy,
    estimatedMakerShare: makerShare,
    copyableAt10Rate: copyableRate,
    twoOutcomeMarketRate: twoOutcomeRate,
    roundTripMarketRate: roundTripRate,
    medianBuyNotional: median(notionals),
    avgBuyPrice: average(buys.map((trade) => trade.price)),
    top3ProfitConcentration: concentration,
    patterns,
    reasons,
    updatedAt: now
  };
}

function selectDiversifiedCandidates(entries: TraderLeaderboardEntry[], limit: number): ResearchCandidate[] {
  const grouped = new Map<string, ResearchCandidate>();
  for (const entry of entries) {
    const key = entry.wallet.toLowerCase();
    const existing = grouped.get(key) ?? { wallet: entry.wallet, name: entry.name, entries: [] };
    existing.entries.push(entry);
    if (!existing.name && entry.name) existing.name = entry.name;
    grouped.set(key, existing);
  }
  const all = [...grouped.values()].sort(candidateSort);
  const persistent = all.filter((candidate) => new Set(candidate.entries.map((entry) => entry.period)).size >= 2);
  const chosen: ResearchCandidate[] = [];
  for (const category of RESEARCH_CATEGORIES) {
    const candidate = all.find((item) => item.entries.some((entry) => entry.category === category) && !chosen.some((chosenItem) => chosenItem.wallet === item.wallet));
    if (candidate) chosen.push(candidate);
  }
  for (const candidate of persistent) {
    if (chosen.length >= limit) break;
    if (!chosen.some((item) => item.wallet === candidate.wallet)) chosen.push(candidate);
  }
  // A strong new DAY/WEEK entrant is still a useful lead. Persistence affects
  // research score and promotion, but does not prevent inclusion in the top 100.
  for (const candidate of all) {
    if (chosen.length >= limit) break;
    if (!chosen.some((item) => item.wallet === candidate.wallet)) chosen.push(candidate);
  }
  return chosen.slice(0, limit);
}

function candidateSort(a: ResearchCandidate, b: ResearchCandidate): number {
  const aPeriods = new Set(a.entries.map((entry) => entry.period)).size;
  const bPeriods = new Set(b.entries.map((entry) => entry.period)).size;
  const aBestRank = Math.min(...a.entries.map((entry) => entry.rank));
  const bBestRank = Math.min(...b.entries.map((entry) => entry.rank));
  return bPeriods - aPeriods || b.entries.length - a.entries.length || aBestRank - bBestRank;
}

function classifyArchetype(input: {
  buyRate: number; makerShare: number; twoOutcomeRate: number; closed: number;
  closedPnl: number; winRate: number; copyableRate: number; concentration: number;
}): WalletResearchArchetype {
  if (input.buyRate < 0.15) return "EXIT_OR_UNWIND";
  if (input.twoOutcomeRate >= 0.35) return "PAIRED_OUTCOME_ARBITRAGE";
  if (input.makerShare >= 0.55 && input.closedPnl > 0) return "MAKER_SPECIALIST";
  if (input.closed >= 30 && input.closedPnl > 0 && input.winRate >= 0.55 && input.concentration <= 0.6) {
    return "DIRECTIONAL_SPECIALIST";
  }
  return "MIXED_OR_UNPROVEN";
}

function recommendationFor(archetype: WalletResearchArchetype): WalletResearchRecommendation {
  if (archetype === "DIRECTIONAL_SPECIALIST") return "SHADOW_DIRECTIONAL";
  if (archetype === "MAKER_SPECIALIST" || archetype === "PAIRED_OUTCOME_ARBITRAGE") return "MODEL_EDGE_ONLY";
  if (archetype === "EXIT_OR_UNWIND") return "DO_NOT_COPY";
  return "RESEARCH_ONLY";
}

function calculateResearchScore(input: { periods: number; closed: number; closedPnl: number; winRate: number; concentration: number; predictionBrier?: number }): number {
  let score = Math.min(24, input.periods * 8);
  score += Math.min(16, input.closed / 12.5);
  score += input.closedPnl > 0 ? 10 : 0;
  score += input.closedPnl > 0 ? Math.min(10, Math.log10(input.closedPnl + 1) * 2) : 0;
  score += Math.min(16, input.winRate * 20);
  score += Math.max(0, 12 * (1 - Math.min(1, input.concentration)));
  if (input.predictionBrier !== undefined) score += Math.max(-12, Math.min(12, (0.25 - input.predictionBrier) * 48));
  if (input.closedPnl < 0) score -= 25;
  return Math.round(Math.max(0, Math.min(100, score)));
}

function calculateExecutionCompatibilityScore(input: { makerShare: number; copyableRate: number; twoOutcomeRate: number; buyRate: number }): number {
  const takerCompatibility = 1 - Math.min(1, input.makerShare);
  const directionalCompatibility = 1 - Math.min(1, input.twoOutcomeRate);
  const activeEntryCompatibility = Math.min(1, input.buyRate / 0.5);
  return Math.round(100 * (
    input.copyableRate * 0.35 +
    takerCompatibility * 0.3 +
    directionalCompatibility * 0.2 +
    activeEntryCompatibility * 0.15
  ));
}

function inferPatterns(
  trades: WalletTrade[],
  categories: LeaderboardCategory[],
  metrics: { makerShare: number; copyableRate: number; twoOutcomeRate: number; roundTripRate: number; buyRate: number }
): string[] {
  const patterns = [`leaderboard specialization: ${categories.join(", ").toLowerCase()}`];
  const themes = trades.map((trade) => themeFromTrade(trade)).filter(Boolean);
  const themeCounts = countValues(themes);
  const dominantTheme = [...themeCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (dominantTheme && trades.length > 0 && dominantTheme[1] / trades.length >= 0.2) {
    patterns.push(`dominant observable theme: ${dominantTheme[0]} (${formatPct(dominantTheme[1] / trades.length)})`);
  }
  if (metrics.makerShare >= 0.55) patterns.push(`maker-dominant execution (${formatPct(metrics.makerShare)} estimated maker-only)`);
  if (metrics.twoOutcomeRate >= 0.2) patterns.push(`frequently trades both outcomes (${formatPct(metrics.twoOutcomeRate)} of markets)`);
  if (metrics.roundTripRate >= 0.25) patterns.push(`frequent entry/exit inventory turnover (${formatPct(metrics.roundTripRate)} of markets)`);
  patterns.push(`observed $10 execution compatibility: ${formatPct(metrics.copyableRate)} of buys (execution only; not a lead-selection gate)`);
  if (metrics.buyRate < 0.15) patterns.push("recent tape is primarily exits or inventory unwind");
  return patterns;
}

function buildReasons(
  archetype: WalletResearchArchetype,
  recommendation: WalletResearchRecommendation,
  metrics: { makerShare: number; copyableRate: number; twoOutcomeRate: number; winRate: number; concentration: number; closedPnl: number }
): string[] {
  const reasons = [
    `${archetype.toLowerCase().replaceAll("_", " ")} classified from public trade-role, outcome, and exit behavior`,
    `closed sample P&L $${metrics.closedPnl.toFixed(2)} at ${formatPct(metrics.winRate)} win rate`,
    `${formatPct(metrics.makerShare)} estimated maker-only activity`
  ];
  reasons.push(`${formatPct(metrics.copyableRate)} of observed buys meet $10 notional; retained only as an execution diagnostic`);
  if (metrics.twoOutcomeRate >= 0.2) reasons.push(`${formatPct(metrics.twoOutcomeRate)} paired-outcome market rate is not a directional copy signal`);
  if (metrics.concentration > 0.6) reasons.push(`${formatPct(metrics.concentration)} of positive P&L came from three positions`);
  reasons.push(`handoff recommendation: ${recommendation.toLowerCase().replaceAll("_", " ")}`);
  return reasons;
}

function themeFromTrade(trade: WalletTrade): string {
  const raw = trade.raw as Record<string, unknown> | undefined;
  const text = `${raw?.title ?? ""} ${raw?.slug ?? ""}`.toLowerCase();
  if (/temperature|hottest|weather|rain|snow|hurricane/.test(text)) return "weather/climate data";
  if (/fed|rate|inflation|cpi|gdp|jobs/.test(text)) return "macro releases";
  if (/ipo|ai|openai|anthropic|technology|tech/.test(text)) return "technology/IPO events";
  if (/bitcoin|btc|ethereum|eth|solana|crypto/.test(text)) return "crypto price events";
  if (/election|president|senate|house|government/.test(text)) return "politics";
  if (/mention|say |post |tweet/.test(text)) return "mentions";
  return "other";
}

function tradeIdentity(trade: WalletTrade): string {
  const raw = trade.raw as Record<string, unknown> | undefined;
  return `${raw?.transactionHash ?? ""}|${trade.tokenId ?? ""}|${trade.side}|${trade.size}|${trade.timestamp}`;
}

function groupTradesByMarket(trades: WalletTrade[]): Map<string, WalletTrade[]> {
  const grouped = new Map<string, WalletTrade[]>();
  for (const trade of trades) grouped.set(trade.marketId, [...(grouped.get(trade.marketId) ?? []), trade]);
  return grouped;
}

function countValues(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  return values[Math.floor(values.length / 2)] ?? 0;
}

function average(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
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
