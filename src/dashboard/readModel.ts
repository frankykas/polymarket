import type { BotDatabase } from "../db.js";
import { publicAgentEvents, publicPerformance, publicSignal, publicWalletPreviews } from "../public/readModels.js";
import type {
  AgentEvent,
  PerformanceReport,
  ShadowBacktestReport,
  ShadowCategorySummary,
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
