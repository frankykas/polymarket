import type { BotDatabase } from "../db.js";
import { decideRisk, type RiskState } from "../engines.js";
import type { AgentEventWriter } from "../events/eventWriter.js";
import type {
  BotConfig,
  IntelligenceReviewContext,
  MarketQuality,
  RiskDecision,
  RiskStateLabel,
  StrategyProfile,
  TradeSignal
} from "../types.js";

export class RiskMitigationAgent {
  constructor(
    private db: BotDatabase,
    private events: AgentEventWriter,
    private config: BotConfig,
    private profiles: StrategyProfile[]
  ) {}

  decide(signal: TradeSignal, quality: MarketQuality, state: RiskState, context?: IntelligenceReviewContext): RiskDecision {
    const riskState = classifyRiskState(signal, quality, state, this.config);
    const intelligenceVeto = intelligenceVetoReason(context);
    if (intelligenceVeto) {
      const decision: RiskDecision = {
        decision: "REJECT",
        positionSize: 0,
        reason: intelligenceVeto,
        profile: undefined,
        confidence: signal.confidence,
        riskState,
        shadow: true
      };
      this.persist(signal, decision, quality, state, context);
      return decision;
    }

    const profile = this.profiles.find((candidate) =>
      candidate.enabled &&
      signal.confidence >= candidate.minConfidence &&
      candidate.allowedRiskStates.includes(riskState)
    );

    if (!profile) {
      const decision: RiskDecision = {
        decision: "REJECT",
        positionSize: 0,
        reason: profileRejectionReason(signal, quality, state, riskState, this.config),
        profile: undefined,
        confidence: signal.confidence,
        riskState,
        shadow: true
      };
      this.persist(signal, decision, quality, state, context);
      return decision;
    }

    const profileConfig: BotConfig = {
      ...this.config,
      minSignalConfidence: profile.minConfidence,
      maxPositionSize: Math.min(this.config.maxPositionSize, this.config.bankroll * profile.maxPositionPct),
      maxOpenExposure: Math.min(this.config.maxOpenExposure, this.config.bankroll * profile.maxOpenExposurePct)
    };
    const decision = {
      ...decideRisk(signal, quality, state, profileConfig),
      profile: profile.name,
      confidence: signal.confidence,
      riskState
    };
    this.persist(signal, decision, quality, state, context);
    return decision;
  }

  private persist(
    signal: TradeSignal,
    decision: RiskDecision,
    quality: MarketQuality,
    state: RiskState,
    context?: IntelligenceReviewContext
  ): void {
    this.db.saveRiskDecision(decision, {
      signalId: signal.id,
      marketId: signal.marketId,
      outcome: String(signal.outcome),
      details: {
        marketQualityApproved: quality.approved,
        marketQualityScore: quality.score,
        marketQualityReasons: quality.reasons,
        marketIntelligenceScore: context?.marketIntelligence?.contextScore,
        marketIntelligenceThesis: context?.marketIntelligence?.thesis,
        marketIntelligenceSummary: context?.marketIntelligence?.publicSummary,
        microstructureScore: context?.microstructure?.score,
        microstructureState: context?.microstructure?.state,
        microstructureReasons: context?.microstructure?.reasons,
        walletIntelligenceScore: context?.walletIntelligence?.score,
        walletIntelligenceState: context?.walletIntelligence?.state,
        debateConsensus: context?.debate?.consensus,
        debateScore: context?.debate?.consensusScore,
        debateVotes: context?.debate?.votes,
        openExposure: state.openExposure,
        dailyPnl: state.dailyPnl,
        lossStreak: state.lossStreak,
        tradesToday: state.tradesToday
      }
    });
    this.events.write({
      type: "risk.decision_created",
      agent: "Risk Mitigation Agent",
      visibility: decision.decision === "APPROVE" || decision.decision === "REDUCE_SIZE" ? "PUBLIC" : "PRIVATE",
      message: `${decision.decision} ${signal.outcome} signal${decision.profile ? ` for ${decision.profile}` : ""}.`,
      payload: {
        signalId: signal.id,
        decision: decision.decision,
        profile: decision.profile,
        riskState: decision.riskState,
        confidence: decision.confidence,
        positionSize: decision.positionSize,
        reason: decision.reason,
        shadow: decision.shadow,
        intelligence: {
          market: context?.marketIntelligence
            ? {
                thesis: context.marketIntelligence.thesis,
                score: context.marketIntelligence.contextScore,
                summary: context.marketIntelligence.publicSummary
              }
            : undefined,
          microstructure: context?.microstructure
            ? {
                state: context.microstructure.state,
                score: context.microstructure.score
              }
            : undefined,
          wallet: context?.walletIntelligence
            ? {
                state: context.walletIntelligence.state,
                score: context.walletIntelligence.score,
                independentSourceCount: context.walletIntelligence.independentSourceCount
              }
            : undefined,
          debate: context?.debate
            ? {
                consensus: context.debate.consensus,
                score: context.debate.consensusScore
              }
            : undefined
        }
      }
    });
  }
}

function intelligenceVetoReason(context?: IntelligenceReviewContext): string | undefined {
  if (!context) return undefined;
  if (context.microstructure && (context.microstructure.state === "STALE" || context.microstructure.score < 45)) {
    return `microstructure veto: ${context.microstructure.state.toLowerCase()} (${context.microstructure.score}/100)`;
  }
  if (context.walletIntelligence && context.walletIntelligence.state === "UNKNOWN") {
    return "wallet intelligence veto: no usable aligned source evidence";
  }
  if (context.marketIntelligence?.thesis === "REJECT_CONTEXT" && context.marketIntelligence.contextScore < 45) {
    return `market intelligence veto: ${context.marketIntelligence.publicSummary}`;
  }
  if (context.debate?.consensus === "REJECT") {
    return `decision council veto: ${context.debate.consensusScore}/100 consensus`;
  }
  return undefined;
}

function profileRejectionReason(
  signal: TradeSignal,
  quality: MarketQuality,
  state: RiskState,
  riskState: RiskStateLabel,
  config: BotConfig
): string {
  if (!quality.approved) return `market quality failed: ${quality.reasons.join("; ")}`;
  if (state.dailyPnl <= -config.maxDailyLoss) return "daily loss limit reached";
  if (state.lossStreak >= config.maxLossStreak) return "loss streak limit reached";
  const activeExposureCap = Math.min(config.maxOpenExposure, config.bankroll * (1 - config.reserveCashPct));
  if (state.openExposure >= activeExposureCap) return "active exposure cap reached";
  return `no strategy profile accepted ${riskState} signal at confidence ${signal.confidence}`;
}

function classifyRiskState(signal: TradeSignal, quality: MarketQuality, state: RiskState, config: BotConfig): RiskStateLabel {
  if (!quality.approved || state.dailyPnl <= -config.maxDailyLoss || state.lossStreak >= config.maxLossStreak) return "HIGH_RISK";
  const activeExposureCap = Math.min(config.maxOpenExposure, config.bankroll * (1 - config.reserveCashPct));
  if (signal.confidence < 85 || state.openExposure >= activeExposureCap * 0.8 || quality.score < 70) return "WARNING";
  return "SAFE";
}
