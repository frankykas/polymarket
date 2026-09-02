import { randomId } from "../db.js";
import { inferMarketCategory } from "../engines.js";
import type { AgentEventWriter } from "../events/eventWriter.js";
import type {
  MarketIntelligenceBrief,
  MarketSnapshot,
  OrderBookSnapshot,
  TradeSignal,
  WalletIntelligenceReport,
  WalletScore
} from "../types.js";

interface MarketIntelligenceInput {
  market: MarketSnapshot;
  signal: TradeSignal;
  books: OrderBookSnapshot[];
  scores: WalletScore[];
  walletIntelligence?: WalletIntelligenceReport;
  now?: number;
}

export class MarketIntelligenceAgent {
  constructor(private events?: AgentEventWriter) {}

  review(input: MarketIntelligenceInput): MarketIntelligenceBrief {
    const now = input.now ?? Date.now();
    const category = inferMarketCategory(input.market);
    const text = `${input.market.question} ${input.market.slug ?? ""}`.toLowerCase();
    const catalystTags = detectCatalysts(text);
    const timeToResolutionHours = input.market.endDate ? (Date.parse(input.market.endDate) - now) / 3_600_000 : undefined;
    const signalAgeMs = Math.max(0, now - input.signal.createdAt);
    const signalFreshness: MarketIntelligenceBrief["signalFreshness"] =
      signalAgeMs <= 30 * 60_000 ? "FRESH" : signalAgeMs <= 2 * 60 * 60_000 ? "UNKNOWN" : "STALE";

    const alignedScores = input.signal.alignedWallets
      .map((wallet) => input.scores.find((score) => score.wallet.toLowerCase() === wallet.toLowerCase()))
      .filter((score): score is WalletScore => score !== undefined);
    const avgSourceScore = alignedScores.length
      ? alignedScores.reduce((sum, score) => sum + score.score, 0) / alignedScores.length
      : input.signal.signalOrigin === "INDEPENDENT_MODEL"
        ? Math.min(100, 55 + Math.max(0, input.signal.probabilityEdge ?? 0) * 200)
        : 0;
    const avgCategoryImpact = alignedScores.length
      ? alignedScores.reduce((sum, score) => sum + (score.shadowCategoryImpacts?.[category] ?? 0), 0) / alignedScores.length
      : 0;
    const hasUsableBook = input.books.some((book) => book.bestBid !== undefined && book.bestAsk !== undefined);
    const researchNonCopyable = alignedScores.some((score) => score.flags.includes("RESEARCH_DO_NOT_COPY"));

    const privateNotes: string[] = [];
    let contextScore = 45;
    contextScore += Math.min(20, input.market.liquidity / 500);
    contextScore += Math.min(12, input.market.volume24h / 1_000);
    contextScore += avgSourceScore * 0.18;
    if (input.signal.signalOrigin === "INDEPENDENT_MODEL") {
      contextScore += Math.min(12, Math.max(0, input.signal.expectedValuePct ?? 0) * 30);
      privateNotes.push("signal originates from an independent fair-value model rather than wallet copying");
    }
    contextScore += avgCategoryImpact;
    if (input.walletIntelligence) contextScore += input.walletIntelligence.confidenceModifier;
    if (researchNonCopyable) {
      contextScore -= 20;
      privateNotes.push("wallet research classified an aligned source as maker, paired-outcome, or unwind behavior rather than directional edge");
    }
    if (signalFreshness === "FRESH") contextScore += 8;
    if (signalFreshness === "STALE") {
      contextScore -= 18;
      privateNotes.push("signal age is stale relative to copy-trading execution");
    }
    if (!hasUsableBook) {
      contextScore -= 15;
      privateNotes.push("market lacks usable live order book context");
    }
    if (timeToResolutionHours !== undefined && Number.isFinite(timeToResolutionHours)) {
      if (timeToResolutionHours < 2) {
        contextScore -= 18;
        privateNotes.push("near-resolution timing increases execution and settlement risk");
      } else if (timeToResolutionHours <= 72) {
        contextScore += 6;
      } else if (timeToResolutionHours > 24 * 30) {
        contextScore -= 8;
        privateNotes.push("long-dated market increases treasury lockup risk");
      }
    }
    if (catalystTags.length > 0) contextScore += Math.min(8, catalystTags.length * 3);

    contextScore = clampScore(contextScore);
    const thesis: MarketIntelligenceBrief["thesis"] =
      contextScore >= 78 && input.signal.decision === "TRADE_CANDIDATE" ? "BULLISH_SIGNAL"
        : contextScore < 45 ? "REJECT_CONTEXT"
          : contextScore >= 60 ? "WATCH"
            : "NEUTRAL";
    const confidenceModifier = Math.max(-10, Math.min(10, Math.round((contextScore - 65) / 4)));
    const publicSummary = buildSummary(thesis, contextScore, category, catalystTags, signalFreshness);

    const brief: MarketIntelligenceBrief = {
      id: randomId("intel"),
      marketId: input.market.id,
      category,
      thesis,
      confidenceModifier,
      contextScore,
      timeToResolutionHours: Number.isFinite(timeToResolutionHours) ? timeToResolutionHours : undefined,
      signalFreshness,
      catalystTags,
      publicSummary,
      privateNotes: privateNotes.length ? privateNotes : ["context supports continued review"],
      createdAt: now
    };

    this.events?.write({
      type: "market_intelligence.brief_completed",
      agent: "Market Intelligence Agent",
      visibility: thesis === "BULLISH_SIGNAL" || thesis === "WATCH" ? "PUBLIC" : "PRIVATE",
      message: publicSummary,
      payload: brief
    });

    return brief;
  }
}

function detectCatalysts(text: string): string[] {
  const tags: string[] = [];
  const groups: Array<[string, string[]]> = [
    ["election", ["election", "primary", "senate", "house", "president", "vote"]],
    ["macro", ["fed", "cpi", "inflation", "rates", "jobs", "fomc"]],
    ["crypto", ["bitcoin", "btc", "ethereum", "eth", "solana", "binance", "etf"]],
    ["earnings", ["earnings", "revenue", "guidance", "stock"]],
    ["sports", ["match", "game", "final", "playoff", "tournament"]],
    ["weather", ["temperature", "weather", "rain", "snow", "hurricane"]]
  ];
  for (const [tag, words] of groups) {
    if (words.some((word) => text.includes(word))) tags.push(tag);
  }
  return [...new Set(tags)];
}

function buildSummary(
  thesis: MarketIntelligenceBrief["thesis"],
  score: number,
  category: string,
  catalystTags: string[],
  freshness: MarketIntelligenceBrief["signalFreshness"]
): string {
  const catalystText = catalystTags.length ? ` with ${catalystTags.join(", ")} catalyst context` : "";
  if (thesis === "BULLISH_SIGNAL") return `Market Intelligence supports the signal (${score}/100) in ${category}${catalystText}.`;
  if (thesis === "REJECT_CONTEXT") return `Market Intelligence rejects the context (${score}/100); signal is ${freshness.toLowerCase()}.`;
  if (thesis === "WATCH") return `Market Intelligence marks this as watchable (${score}/100) in ${category}${catalystText}.`;
  return `Market Intelligence is neutral (${score}/100) in ${category}.`;
}

function clampScore(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)));
}
