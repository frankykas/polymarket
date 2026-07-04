import { randomId } from "../db.js";
import type { AgentEventWriter } from "../events/eventWriter.js";
import type { TradeSignal, WalletIntelligenceReport, WalletScore, WalletTrade } from "../types.js";

export class WalletIntelligenceAgent {
  constructor(private events?: AgentEventWriter) {}

  reviewSignal(signal: TradeSignal, scores: WalletScore[], trades: WalletTrade[], now = Date.now()): WalletIntelligenceReport {
    const alignedWalletSet = new Set(signal.alignedWallets.map((wallet) => wallet.toLowerCase()));
    const alignedScores = scores.filter((score) => alignedWalletSet.has(score.wallet.toLowerCase()));
    const alignedTrades = trades.filter((trade) =>
      alignedWalletSet.has(trade.wallet.toLowerCase()) &&
      (trade.marketId === signal.marketId || trade.marketId === signal.conditionId) &&
      String(trade.outcome).toLowerCase() === String(signal.outcome).toLowerCase() &&
      trade.side === signal.side
    );

    const timestamps = alignedTrades.map((trade) => trade.timestamp).filter((value) => Number.isFinite(value));
    const timingSpreadMs = timestamps.length > 1 ? Math.max(...timestamps) - Math.min(...timestamps) : undefined;
    const avgCopyabilityScore = average(alignedScores.map((score) => score.copyabilityScore ?? score.score));
    const avgSampleConfidence = average(alignedScores.map((score) => score.sampleConfidence ?? 0));
    const lowEvidence = alignedScores.some((score) => score.reliability === "LOW" || (score.sampleConfidence ?? 0) < 0.25);
    const tightTiming = timingSpreadMs !== undefined && timingSpreadMs < 90_000 && alignedWalletSet.size > 1;
    const clusterPenalty = tightTiming ? Math.min(35, 10 + alignedWalletSet.size * 5) : 0;
    const independentSourceCount = Math.max(0, alignedWalletSet.size - (tightTiming ? 1 : 0));

    const reasons: string[] = [];
    if (alignedWalletSet.size === 0) reasons.push("no aligned wallets attached to signal");
    if (tightTiming) reasons.push("aligned buys arrived in a tight time cluster");
    if (lowEvidence) reasons.push("one or more aligned sources has low sample confidence");
    if (independentSourceCount >= 2) reasons.push(`${independentSourceCount} independent source(s) remain after clustering checks`);
    if (avgCopyabilityScore > 0) reasons.push(`average copyability ${avgCopyabilityScore.toFixed(0)}/100`);

    const score = clampScore(
      avgCopyabilityScore * 0.55 +
      avgSampleConfidence * 25 +
      independentSourceCount * 12 -
      clusterPenalty +
      (signal.confidence >= 80 ? 8 : 0)
    );
    const state: WalletIntelligenceReport["state"] =
      alignedWalletSet.size === 0 ? "UNKNOWN"
        : lowEvidence && independentSourceCount < 2 ? "WEAK_EVIDENCE"
          : clusterPenalty >= 20 && independentSourceCount < 2 ? "CLUSTERED"
            : "INDEPENDENT";
    const confidenceModifier =
      state === "INDEPENDENT" ? Math.min(8, Math.round((score - 65) / 5))
        : state === "CLUSTERED" ? -8
          : state === "WEAK_EVIDENCE" ? -6
            : -10;

    const report: WalletIntelligenceReport = {
      id: randomId("walletintel"),
      signalId: signal.id,
      marketId: signal.marketId,
      state,
      score,
      alignedWallets: alignedWalletSet.size,
      independentSourceCount,
      clusterPenalty,
      timingSpreadMs,
      avgCopyabilityScore,
      avgSampleConfidence,
      confidenceModifier,
      reasons: reasons.length ? reasons : ["wallet signal has limited but usable evidence"],
      createdAt: now
    };

    this.events?.write({
      type: "wallet_intelligence.review_completed",
      agent: "Wallet Intelligence Agent",
      visibility: state === "INDEPENDENT" ? "PUBLIC" : "PRIVATE",
      message: `Wallet Intelligence rated ${state} (${score}/100).`,
      payload: {
        ...report,
        // Keep full wallet addresses out of public event surfaces.
        alignedWallets: report.alignedWallets
      }
    });

    return report;
  }
}

function average(values: number[]): number {
  const usable = values.filter((value) => Number.isFinite(value));
  if (usable.length === 0) return 0;
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

function clampScore(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)));
}
