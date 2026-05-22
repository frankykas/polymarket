import type { AgentEvent, DiscoveredWallet } from "../types.js";

export interface AdminWalletPreview {
  address: string;
  sourceStrength: number;
  score: number;
  tradeCount: number;
  uniqueMarkets: number;
  totalVolume: number;
  openPositionValue: number;
  openPositionPnlApprox: number;
  flags: string[];
}

export function adminWalletPreviews(wallets: DiscoveredWallet[]): AdminWalletPreview[] {
  return wallets.map((wallet) => ({
    address: wallet.address,
    sourceStrength: wallet.copyabilityScore,
    score: wallet.score,
    tradeCount: wallet.tradeCount,
    uniqueMarkets: wallet.uniqueMarkets,
    totalVolume: wallet.totalVolume,
    openPositionValue: wallet.openPositionValue,
    openPositionPnlApprox: wallet.openPositionPnlApprox,
    flags: wallet.flags
  }));
}

export function adminAgentEvents(events: AgentEvent[]): AgentEvent[] {
  return events;
}
