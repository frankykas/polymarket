import { randomId } from "../db.js";
import type { RiskState } from "../engines.js";
import type { AgentEventWriter } from "../events/eventWriter.js";
import type {
  AgentDebateDecision,
  AgentVote,
  BotConfig,
  IntelligenceReviewContext,
  MarketQuality,
  TradeSignal
} from "../types.js";

interface DecisionCouncilInput extends IntelligenceReviewContext {
  signal: TradeSignal;
  quality: MarketQuality;
  riskState: RiskState;
  config: BotConfig;
}

export class DecisionCouncil {
  constructor(private events?: AgentEventWriter) {}

  review(input: DecisionCouncilInput): AgentDebateDecision {
    const votes: AgentVote[] = [
      signalVote(input.signal, input.config),
      marketIntelligenceVote(input.marketIntelligence),
      microstructureVote(input.microstructure),
      walletIntelligenceVote(input.walletIntelligence),
      riskVote(input.quality, input.riskState, input.config)
    ];
    const consensusScore = Math.round(votes.reduce((sum, vote) => sum + vote.score, 0) / votes.length);
    const rejects = votes.filter((vote) => vote.vote === "REJECT").length;
    const approvals = votes.filter((vote) => vote.vote === "APPROVE").length;
    const consensus: AgentDebateDecision["consensus"] =
      rejects >= 2 || consensusScore < 45 ? "REJECT"
        : approvals >= 3 && consensusScore >= 68 ? "APPROVE"
          : "WATCH";
    const publicSummary = `Decision Council ${consensus.toLowerCase()} consensus (${consensusScore}/100): ${votes.map((vote) => `${vote.agent} ${vote.vote}`).join(", ")}.`;

    const decision: AgentDebateDecision = {
      id: randomId("debate"),
      signalId: input.signal.id,
      marketId: input.signal.marketId,
      outcome: input.signal.outcome,
      votes,
      consensus,
      consensusScore,
      publicSummary,
      createdAt: Date.now()
    };

    this.events?.write({
      type: "decision_council.debate_completed",
      agent: "Decision Council",
      visibility: consensus === "APPROVE" ? "PUBLIC" : "PRIVATE",
      message: publicSummary,
      payload: decision
    });

    return decision;
  }
}

function signalVote(signal: TradeSignal, config: BotConfig): AgentVote {
  const vote = signal.decision === "TRADE_CANDIDATE" && signal.confidence >= config.minSignalConfidence ? "APPROVE" : "WATCH";
  return {
    agent: "Signal Agent",
    vote,
    score: signal.confidence,
    reason: vote === "APPROVE" ? "signal confidence clears threshold" : "signal remains below trade threshold"
  };
}

function marketIntelligenceVote(context: IntelligenceReviewContext["marketIntelligence"]): AgentVote {
  if (!context) return { agent: "Market Intelligence Agent", vote: "WATCH", score: 50, reason: "market context not available" };
  const vote = context.thesis === "REJECT_CONTEXT" ? "REJECT" : context.thesis === "BULLISH_SIGNAL" ? "APPROVE" : "WATCH";
  return {
    agent: "Market Intelligence Agent",
    vote,
    score: context.contextScore,
    reason: context.publicSummary
  };
}

function microstructureVote(context: IntelligenceReviewContext["microstructure"]): AgentVote {
  if (!context) return { agent: "Microstructure Agent", vote: "WATCH", score: 50, reason: "microstructure context not available" };
  const vote = context.state === "EXECUTABLE" && context.score >= 65 ? "APPROVE" : context.score < 50 || context.state === "STALE" ? "REJECT" : "WATCH";
  return {
    agent: "Microstructure Agent",
    vote,
    score: context.score,
    reason: context.reasons.join("; ")
  };
}

function walletIntelligenceVote(context: IntelligenceReviewContext["walletIntelligence"]): AgentVote {
  if (!context) return { agent: "Wallet Intelligence Agent", vote: "WATCH", score: 50, reason: "wallet independence context not available" };
  const vote = (context.state === "INDEPENDENT" || context.state === "MODEL_INDEPENDENT") && context.score >= 65 ? "APPROVE" : context.state === "UNKNOWN" || context.score < 45 ? "REJECT" : "WATCH";
  return {
    agent: "Wallet Intelligence Agent",
    vote,
    score: context.score,
    reason: context.reasons.join("; ")
  };
}

function riskVote(quality: MarketQuality, state: RiskState, config: BotConfig): AgentVote {
  if (!quality.approved) return { agent: "Risk Mitigation Agent", vote: "REJECT", score: quality.score, reason: quality.reasons.join("; ") };
  if (state.dailyPnl <= -config.maxDailyLoss) return { agent: "Risk Mitigation Agent", vote: "REJECT", score: 0, reason: "daily loss limit reached" };
  if (state.openExposure >= config.maxOpenExposure) return { agent: "Risk Mitigation Agent", vote: "REJECT", score: 20, reason: "max open exposure reached" };
  return { agent: "Risk Mitigation Agent", vote: quality.score >= 70 ? "APPROVE" : "WATCH", score: quality.score, reason: "risk envelope available" };
}
