import type { AgentEvent, DiscoveredWallet, PerformanceReport, TradeSignal } from "../types.js";

export interface PublicWalletPreview {
  rank: number;
  sourceStrength: number;
  categoryStrength: number;
  hotness: number;
  sampleConfidence: number;
  category: string;
  tradeCount: number;
  uniqueMarkets: number;
  volumeBand: "LOW" | "MEDIUM" | "HIGH";
  flags: string[];
}

export function publicWalletPreviews(wallets: DiscoveredWallet[]): PublicWalletPreview[] {
  return wallets.map((wallet, index) => ({
    rank: index + 1,
    sourceStrength: wallet.copyabilityScore,
    categoryStrength: wallet.categoryConsistencyScore,
    hotness: wallet.hotScore,
    sampleConfidence: wallet.sampleConfidence,
    category: wallet.dominantCategory,
    tradeCount: wallet.tradeCount,
    uniqueMarkets: wallet.uniqueMarkets,
    volumeBand: wallet.totalVolume >= 10000 ? "HIGH" : wallet.totalVolume >= 1000 ? "MEDIUM" : "LOW",
    flags: wallet.flags.filter((flag) => !flag.includes("ADDRESS"))
  }));
}

export function publicSignal(signal: TradeSignal): Omit<TradeSignal, "alignedWallets"> & { alignedSourceCount: number } {
  return {
    ...signal,
    alignedSourceCount: signal.alignedWallets.length
  };
}

export function publicAgentEvents(events: AgentEvent[]): AgentEvent[] {
  return events
    .filter((event) => event.visibility === "PUBLIC")
    .map((event) => ({
      ...event,
      payload: scrubPrivatePayload(event.payload)
    }));
}

export function publicPerformance(report: PerformanceReport): PerformanceReport {
  return report;
}

function scrubPrivatePayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  if (Array.isArray(payload)) return payload.map(scrubPrivatePayload);
  const scrubbed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (["wallet", "address", "alignedWallets", "apiKey", "token"].includes(key)) continue;
    scrubbed[key] = scrubPrivatePayload(value);
  }
  return scrubbed;
}
