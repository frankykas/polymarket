import type { MarketSnapshot, OrderBookSnapshot, TradeSignal } from "./types.js";

export interface CandidateContext {
  market: MarketSnapshot;
  books: OrderBookSnapshot[];
  signal: TradeSignal;
}

export interface RankedCandidate extends CandidateContext {
  priority: number;
  eventKey: string;
}

/**
 * Rank the complete cycle before capital is allocated. Independent-model
 * scores deliberately cap the value of model edge: the historical model was
 * overconfident, so extreme disagreement is not treated as stronger evidence.
 */
export function candidatePriority(signal: TradeSignal): number {
  const confidence = clamp01(signal.confidence / 100);
  const depth = clamp01(Math.log10(1 + Math.max(0, signal.entryBookDepth ?? 0)) / 3);
  if (signal.signalOrigin !== "INDEPENDENT_MODEL") {
    const sourceBreadth = clamp01(signal.alignedWallets.length / 3);
    const executableReturn = clamp01((signal.expectedLiveExecutableReturnPct ?? 0) / 0.25);
    return roundScore(confidence * 45 + sourceBreadth * 30 + executableReturn * 15 + depth * 10);
  }

  const price = signal.marketProbability ?? signal.limitPrice;
  const priceFit = clamp01(1 - Math.abs(price - 0.55) / 0.15);
  const edge = signal.probabilityEdge ?? 0;
  const moderateEdgeFit = clamp01(1 - Math.abs(edge - 0.3) / 0.2);
  const uncertaintyFit = 1 - clamp01(signal.modelUncertainty ?? 1);
  const agreement = clamp01(signal.modelAgreement ?? 0);
  return roundScore(priceFit * 35 + moderateEdgeFit * 20 + uncertaintyFit * 20 + agreement * 15 + depth * 10);
}

export function rankAndDiversifyCandidates(candidates: CandidateContext[]): {
  selected: RankedCandidate[];
  skipped: RankedCandidate[];
} {
  return rankAndDiversify(candidates.filter((candidate) => candidate.signal.decision === "TRADE_CANDIDATE"));
}

/** Selects one prospectively ranked no-trade observation per event. */
export function rankAndDiversifyResearchSelections(candidates: CandidateContext[]): {
  selected: RankedCandidate[];
  skipped: RankedCandidate[];
} {
  return rankAndDiversify(candidates.filter((candidate) => candidate.signal.researchEligible === true));
}

function rankAndDiversify(candidates: CandidateContext[]): {
  selected: RankedCandidate[];
  skipped: RankedCandidate[];
} {
  const ranked = candidates
    .map((candidate) => ({
      ...candidate,
      priority: candidatePriority(candidate.signal),
      eventKey: candidate.signal.strategyEventKey ?? `market:${candidate.signal.marketId}`
    }))
    .sort((a, b) =>
      b.priority - a.priority ||
      b.signal.confidence - a.signal.confidence ||
      a.signal.createdAt - b.signal.createdAt ||
      a.signal.id.localeCompare(b.signal.id)
    );
  const seen = new Set<string>();
  const selected: RankedCandidate[] = [];
  const skipped: RankedCandidate[] = [];
  for (const candidate of ranked) {
    if (seen.has(candidate.eventKey)) skipped.push(candidate);
    else {
      seen.add(candidate.eventKey);
      selected.push(candidate);
    }
  }
  return { selected, skipped };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}
