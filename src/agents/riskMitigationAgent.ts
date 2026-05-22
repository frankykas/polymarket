import type { BotDatabase } from "../db.js";
import { decideRisk, type RiskState } from "../engines.js";
import type { AgentEventWriter } from "../events/eventWriter.js";
import type {
  BotConfig,
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

  decide(signal: TradeSignal, quality: MarketQuality, state: RiskState): RiskDecision {
    const riskState = classifyRiskState(signal, quality, state, this.config);
    const profile = this.profiles.find((candidate) =>
      candidate.enabled &&
      signal.confidence >= candidate.minConfidence &&
      candidate.allowedRiskStates.includes(riskState)
    );

    if (!profile) {
      const decision: RiskDecision = {
        decision: "REJECT",
        positionSize: 0,
        reason: `no profile accepted ${riskState} signal at confidence ${signal.confidence}`,
        profile: undefined,
        confidence: signal.confidence,
        riskState,
        shadow: true
      };
      this.persist(signal, decision);
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
    this.persist(signal, decision);
    return decision;
  }

  private persist(signal: TradeSignal, decision: RiskDecision): void {
    this.db.saveRiskDecision(decision);
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
        shadow: decision.shadow
      }
    });
  }
}

function classifyRiskState(signal: TradeSignal, quality: MarketQuality, state: RiskState, config: BotConfig): RiskStateLabel {
  if (!quality.approved || state.dailyPnl <= -config.maxDailyLoss || state.lossStreak >= config.maxLossStreak) return "HIGH_RISK";
  if (signal.confidence < 85 || state.openExposure >= config.maxOpenExposure * 0.8 || quality.score < 70) return "WARNING";
  return "SAFE";
}
