import type { BotDatabase } from "../db.js";
import { adminAgentEvents, adminWalletPreviews } from "../admin/readModels.js";
import { publicAgentEvents, publicPerformance, publicSignal, publicWalletPreviews } from "../public/readModels.js";
import type {
  AgentEvent,
  AgentHandoffTrace,
  PerformanceReport,
  RiskEventSummary,
  ShadowBacktestReport,
  ShadowCategorySummary,
  SourceScorePoint,
  SourceScoreSummary
} from "../types.js";

export interface DashboardReadModel {
  generatedAt: number;
  mode: "PAPER";
  performance: PerformanceReport;
  shadow: ShadowBacktestReport;
  sourceSummary: SourceScoreSummary;
  shadowCategories: ShadowCategorySummary[];
  wallets: ReturnType<typeof publicWalletPreviews>;
  signals: ReturnType<typeof publicSignal>[];
  positions: Array<{
    marketId: string;
    outcome: string;
    size: number;
    avgEntryPrice: number;
    currentPrice: number;
    unrealizedPnl: number;
    openedAt: number;
  }>;
  events: AgentEvent[];
  logs: Array<{ level: "INFO" | "WARN" | "ERROR"; message: string; createdAt: number }>;
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

export function buildDashboardReadModel(db: BotDatabase): DashboardReadModel {
  const positions = db.getOpenPositions().map((position) => ({
    marketId: position.marketId,
    outcome: position.outcome,
    size: position.size,
    avgEntryPrice: position.avgEntryPrice,
    currentPrice: position.currentPrice,
    unrealizedPnl: (position.currentPrice - position.avgEntryPrice) * position.size,
    openedAt: position.openedAt
  }));

  return {
    generatedAt: Date.now(),
    mode: "PAPER",
    performance: publicPerformance(db.getPerformanceReport()),
    shadow: db.getShadowBacktestReport(),
    sourceSummary: db.getSourceScoreSummary(),
    shadowCategories: db.getShadowCategorySummaries(),
    wallets: publicWalletPreviews(db.getTopDiscoveredWallets(12)),
    signals: db.getRecentSignals(12).map(publicSignal),
    positions,
    events: publicAgentEvents(db.getRecentAgentEvents(20, "PUBLIC")),
    logs: db.getRecentBotLogs(8).map((log) => ({
      level: log.level,
      message: log.message,
      createdAt: log.createdAt
    }))
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
