import type { BotDatabase } from "../db.js";
import { adminAgentEvents, adminWalletPreviews } from "../admin/readModels.js";
import { publicAgentEvents, publicPerformance, publicSignal, publicWalletPreviews } from "../public/readModels.js";
import type {
  AgentEvent,
  AgentThroughputPoint,
  AgentHandoffTrace,
  CapitalLockupReport,
  ExposureHealthReport,
  OrderHealthTrendPoint,
  PerformanceReport,
  ProfilePerformanceReport,
  OrderHealthReport,
  PaperTradeLedgerEntry,
  PaperSourceFeedbackSummary,
  ReconstructedSourcePosition,
  RiskEventSummary,
  RecentRiskEvent,
  ShadowBacktestReport,
  ShadowCategorySummary,
  ShadowCategoryTrendPoint,
  SourceCategorySummary,
  SourceScorePoint,
  WalletDegradationReport,
} from "../types.js";

export interface DashboardReadModel {
  generatedAt: number;
  mode: "PAPER";
  capital: {
    startingBankroll: number;
    availableCash: number;
    deployedCost: number;
    openValue: number;
    realizedPnl: number;
    equity: number;
  };
  performance: PerformanceReport;
  orderHealth: OrderHealthReport;
  exposure: ExposureHealthReport;
  capitalLockup: CapitalLockupReport;
  paperFeedback: PaperSourceFeedbackSummary;
  shadow: ShadowBacktestReport;
  tradeLedger: PaperTradeLedgerEntry[];
  trends: {
    shadowCategories: ShadowCategoryTrendPoint[];
    orderHealth: OrderHealthTrendPoint[];
    agentThroughput: AgentThroughputPoint[];
  };
  profiles: ProfilePerformanceReport[];
  sourceSummary: {
    reliabilityMix: "NONE" | "LOW" | "MEDIUM" | "HIGH";
    avgScore: number;
    avgCopyabilityScore: number;
    avgShadowImpact: number;
  };
  shadowCategories: ShadowCategorySummary[];
  sourceCategories: SourceCategorySummary[];
  sourceDegradation: Array<Omit<WalletDegradationReport, "wallet" | "label"> & { source: string }>;
  reconstructedSourcePositions: Array<Omit<ReconstructedSourcePosition, "wallet"> & { source: string }>;
  wallets: ReturnType<typeof publicWalletPreviews>;
  signals: Array<ReturnType<typeof publicSignal> & { market: string }>;
  positions: Array<{
    id: string;
    profile?: string;
    marketId: string;
    market: string;
    outcome: string;
    size: number;
    entryCost: number;
    currentValue: number;
    avgEntryPrice: number;
    currentPrice: number;
    unrealizedPnl: number;
    openedAt: number;
  }>;
  closedPositions: Array<{
    id: string;
    profile?: string;
    marketId: string;
    market: string;
    outcome: string;
    size: number;
    entryCost: number;
    exitValue: number;
    avgEntryPrice: number;
    currentPrice: number;
    realizedPnl: number;
    returnPct: number;
    updatedAt: number;
  }>;
  events: AgentEvent[];
  logs: Array<{ level: "INFO" | "WARN" | "ERROR"; message: string; createdAt: number }>;
  risk: RiskEventSummary[];
  rejectedSignals: RecentRiskEvent[];
}

export interface AdminDashboardReadModel {
  generatedAt: number;
  mode: "PAPER";
  wallets: ReturnType<typeof adminWalletPreviews>;
  walletScores: Array<{
    wallet: string;
    label?: string;
    score: number;
    copyabilityScore?: number;
    category?: string;
    reliability: string;
    tradeCount: number;
    recentTradeCount: number;
    shadowPnl?: number;
    shadowScoreImpact?: number;
    flags: string[];
    updatedAt: number;
  }>;
  scoreHistory: SourceScorePoint[];
  risk: RiskEventSummary[];
  handoffTrace: AgentHandoffTrace[];
}

export interface PublicTrackerReadModel {
  generatedAt: number;
  name: string;
  walletAddress?: string;
  disclosure: string;
  mode: "PAPER";
  capital: DashboardReadModel["capital"];
  performance: DashboardReadModel["performance"];
  tradeLedger: DashboardReadModel["tradeLedger"];
  positions: DashboardReadModel["positions"];
  closedPositions: DashboardReadModel["closedPositions"];
  sourceSummary: DashboardReadModel["sourceSummary"];
  recentSignals: DashboardReadModel["signals"];
}

export function buildDashboardReadModel(
  db: BotDatabase,
  bankroll = 200,
  minPositionSize = 2,
  maxOpenExposure = 25,
  reserveCashPct = 0.2,
  maxTimeToResolutionHours = 720
): DashboardReadModel {
  const openPositions = db.getOpenPositions();
  const closedPositionRows = db.getClosedPositions(20);
  const recentSignals = db.getRecentSignals(12);
  const performance = publicPerformance(db.getPerformanceReport());
  const marketIds = [
    ...openPositions.map((position) => position.marketId),
    ...closedPositionRows.map((position) => position.marketId),
    ...recentSignals.map((signal) => signal.marketId)
  ];
  const markets = new Map(db.getMarketsByIds(marketIds).map((market) => [market.id, market.question]));
  const positions = openPositions.map((position) => ({
    id: position.id,
    profile: position.profile,
    marketId: position.marketId,
    market: markets.get(position.marketId) ?? position.marketId,
    outcome: position.outcome,
    size: position.size,
    entryCost: position.avgEntryPrice * position.size,
    currentValue: position.currentPrice * position.size,
    avgEntryPrice: position.avgEntryPrice,
    currentPrice: position.currentPrice,
    unrealizedPnl: (position.currentPrice - position.avgEntryPrice) * position.size,
    openedAt: position.openedAt
  }));
  const closedPositions = closedPositionRows.map((position) => ({
    id: position.id,
    profile: position.profile,
    marketId: position.marketId,
    market: markets.get(position.marketId) ?? position.marketId,
    outcome: position.outcome,
    size: position.size,
    entryCost: position.avgEntryPrice * position.size,
    exitValue: position.currentPrice * position.size,
    avgEntryPrice: position.avgEntryPrice,
    currentPrice: position.currentPrice,
    realizedPnl: position.realizedPnl,
    returnPct: position.avgEntryPrice > 0 ? (position.currentPrice - position.avgEntryPrice) / position.avgEntryPrice : 0,
    updatedAt: position.updatedAt
  }));

  const sourceSummary = db.getSourceScoreSummary();

  return {
    generatedAt: Date.now(),
    mode: "PAPER",
    capital: {
      startingBankroll: bankroll,
      availableCash: bankroll - performance.openCost + performance.realizedPnl,
      deployedCost: performance.openCost,
      openValue: performance.openValue,
      realizedPnl: performance.realizedPnl,
      equity: bankroll + performance.totalPnl
    },
    performance,
    orderHealth: db.getOrderHealthReport(minPositionSize),
    exposure: db.getExposureHealthReport(maxOpenExposure, bankroll, reserveCashPct),
    capitalLockup: db.getCapitalLockupReport({
      bankroll,
      maxOpenExposure,
      reserveCashPct,
      maxTimeToResolutionHours
    }),
    paperFeedback: db.getPaperSourceFeedbackSummary(),
    shadow: db.getShadowBacktestReport(),
    tradeLedger: db.getPaperTradeLedger(bankroll, 30),
    trends: {
      shadowCategories: db.getShadowCategoryTrend(21),
      orderHealth: db.getOrderHealthTrend(21),
      agentThroughput: db.getAgentThroughputTrend(7)
    },
    profiles: db.getProfilePerformanceReports(bankroll),
    sourceSummary: {
      reliabilityMix: sourceSummary.highReliability > 0 ? "HIGH" : sourceSummary.mediumReliability > 0 ? "MEDIUM" : sourceSummary.lowReliability > 0 ? "LOW" : "NONE",
      avgScore: sourceSummary.avgScore,
      avgCopyabilityScore: sourceSummary.avgCopyabilityScore,
      avgShadowImpact: sourceSummary.avgShadowImpact
    },
    shadowCategories: db.getShadowCategorySummaries(),
    sourceCategories: db.getSourceCategorySummaries(),
    sourceDegradation: db.getWalletDegradationReport(21, 12).map((item, index) => {
      const { wallet: _wallet, label: _label, ...publicItem } = item;
      return { ...publicItem, source: `Source ${index + 1}` };
    }),
    reconstructedSourcePositions: db.getReconstructedSourcePositions(40).map((item, index) => {
      const { wallet: _wallet, ...publicItem } = item;
      return { ...publicItem, source: `Source ${index + 1}` };
    }),
    wallets: publicWalletPreviews(db.getTopDiscoveredWallets(12)),
    signals: recentSignals.map((signal) => ({
      ...publicSignal(signal),
      market: markets.get(signal.marketId) ?? signal.marketId
    })),
    positions,
    closedPositions,
    events: publicAgentEvents(db.getRecentAgentEvents(20, "PUBLIC")),
    logs: db.getRecentBotLogs(8).map((log) => ({
      level: log.level,
      message: log.message,
      createdAt: log.createdAt
    })),
    risk: db.getRiskEventSummary(20),
    rejectedSignals: db.getRecentRiskEvents(40).filter((event) => event.decision === "REJECT" || event.decision === "PAUSE_TRADING")
  };
}

export function buildAdminDashboardReadModel(db: BotDatabase): AdminDashboardReadModel {
  return {
    generatedAt: Date.now(),
    mode: "PAPER",
    wallets: adminWalletPreviews(db.getTopDiscoveredWallets(30)),
    walletScores: db.getTopWalletScores(30).map((score) => ({
      wallet: score.wallet,
      label: score.label,
      score: score.score,
      copyabilityScore: score.copyabilityScore,
      category: score.dominantCategory,
      reliability: score.reliability,
      tradeCount: score.tradeCount,
      recentTradeCount: score.recentTradeCount,
      shadowPnl: score.shadowPnl,
      shadowScoreImpact: score.shadowScoreImpact,
      flags: score.flags,
      updatedAt: score.updatedAt
    })),
    scoreHistory: db.getSourceScoreHistory(120),
    risk: db.getRiskEventSummary(20),
    handoffTrace: adminAgentEvents(db.getRecentAgentEvents(80)).map((event) => ({
      id: event.id,
      type: event.type,
      agent: event.agent,
      visibility: event.visibility,
      message: event.message,
      payload: event.payload,
      createdAt: event.createdAt
    }))
  };
}

export function buildPublicTrackerReadModel(
  dashboard: DashboardReadModel,
  input: { name?: string; walletAddress?: string; disclosure?: string }
): PublicTrackerReadModel {
  return {
    generatedAt: dashboard.generatedAt,
    name: input.name || "StratiFi Paper Tracker",
    walletAddress: input.walletAddress,
    disclosure: input.disclosure || "Paper trading tracker. No live Polymarket orders are placed by this bot.",
    mode: "PAPER",
    capital: dashboard.capital,
    performance: dashboard.performance,
    tradeLedger: dashboard.tradeLedger.slice(0, 30),
    positions: dashboard.positions.slice(0, 20),
    closedPositions: dashboard.closedPositions.slice(0, 20),
    sourceSummary: dashboard.sourceSummary,
    recentSignals: dashboard.signals.slice(0, 12)
  };
}

export function buildPublicTrackerReadModelFromDb(
  db: BotDatabase,
  input: {
    bankroll: number;
    name?: string;
    walletAddress?: string;
    disclosure?: string;
  }
): PublicTrackerReadModel {
  const openPositions = db.getOpenPositions();
  const closedPositionRows = db.getClosedPositions(20);
  const recentSignals = db.getRecentSignals(12);
  const performance = publicPerformance(db.getPerformanceReport());
  const marketIds = [
    ...openPositions.map((position) => position.marketId),
    ...closedPositionRows.map((position) => position.marketId),
    ...recentSignals.map((signal) => signal.marketId)
  ];
  const markets = new Map(db.getMarketsByIds(marketIds).map((market) => [market.id, market.question]));
  const sourceSummary = db.getSourceScoreSummary();
  return {
    generatedAt: Date.now(),
    name: input.name || "StratiFi Paper Tracker",
    walletAddress: input.walletAddress,
    disclosure: input.disclosure || "Paper trading tracker. No live Polymarket orders are placed by this bot.",
    mode: "PAPER",
    capital: {
      startingBankroll: input.bankroll,
      availableCash: input.bankroll - performance.openCost + performance.realizedPnl,
      deployedCost: performance.openCost,
      openValue: performance.openValue,
      realizedPnl: performance.realizedPnl,
      equity: input.bankroll + performance.totalPnl
    },
    performance,
    tradeLedger: db.getPaperTradeLedger(input.bankroll, 30),
    positions: openPositions.slice(0, 20).map((position) => ({
      id: position.id,
      profile: position.profile,
      marketId: position.marketId,
      market: markets.get(position.marketId) ?? position.marketId,
      outcome: position.outcome,
      size: position.size,
      entryCost: position.avgEntryPrice * position.size,
      currentValue: position.currentPrice * position.size,
      avgEntryPrice: position.avgEntryPrice,
      currentPrice: position.currentPrice,
      unrealizedPnl: (position.currentPrice - position.avgEntryPrice) * position.size,
      openedAt: position.openedAt
    })),
    closedPositions: closedPositionRows.map((position) => ({
      id: position.id,
      profile: position.profile,
      marketId: position.marketId,
      market: markets.get(position.marketId) ?? position.marketId,
      outcome: position.outcome,
      size: position.size,
      entryCost: position.avgEntryPrice * position.size,
      exitValue: position.currentPrice * position.size,
      avgEntryPrice: position.avgEntryPrice,
      currentPrice: position.currentPrice,
      realizedPnl: position.realizedPnl,
      returnPct: position.avgEntryPrice > 0 ? (position.currentPrice - position.avgEntryPrice) / position.avgEntryPrice : 0,
      updatedAt: position.updatedAt
    })),
    sourceSummary: {
      reliabilityMix: sourceSummary.highReliability > 0 ? "HIGH" : sourceSummary.mediumReliability > 0 ? "MEDIUM" : sourceSummary.lowReliability > 0 ? "LOW" : "NONE",
      avgScore: sourceSummary.avgScore,
      avgCopyabilityScore: sourceSummary.avgCopyabilityScore,
      avgShadowImpact: sourceSummary.avgShadowImpact
    },
    recentSignals: recentSignals.map((signal) => ({
      ...publicSignal(signal),
      market: markets.get(signal.marketId) ?? signal.marketId
    }))
  };
}
