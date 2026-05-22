import type { BotConfig, StrategyProfile } from "../types.js";

export function buildStrategyProfiles(config: BotConfig): StrategyProfile[] {
  return [
    {
      name: "Conservative",
      enabled: true,
      minConfidence: Math.max(85, config.minSignalConfidence),
      maxPositionPct: Math.min(0.03, config.maxPositionSize / config.bankroll),
      maxOpenExposurePct: Math.min(0.65, config.maxOpenExposure / config.bankroll),
      maxOpenTrades: 4,
      allowedRiskStates: ["SAFE"],
      nearCapPct: 0.9
    },
    {
      name: "Aggressive",
      enabled: true,
      minConfidence: Math.max(70, config.minSignalConfidence - 5),
      maxPositionPct: Math.min(0.05, config.maxPositionSize / config.bankroll),
      maxOpenExposurePct: Math.min(0.75, config.maxOpenExposure / config.bankroll),
      maxOpenTrades: 8,
      allowedRiskStates: ["SAFE", "WARNING"],
      nearCapPct: 0.95
    }
  ];
}
