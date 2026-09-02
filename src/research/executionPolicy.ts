import type { BotConfig, ExecutionResearchStrategy } from "../types.js";

export const EXECUTION_RESEARCH_STRATEGIES: ExecutionResearchStrategy[] = [
  "MAKER_PAIR",
  "BINARY_PAIR_ARB",
  "THRESHOLD_LADDER_ARB",
  "NEG_RISK_ARB",
  "CROSS_MARKET_LATENCY"
];

export function executionPolicyVersion(config: BotConfig, strategy: ExecutionResearchStrategy): string {
  if (strategy === "MAKER_PAIR") return config.makerResearchPolicyVersion ?? config.executionResearchPolicyVersion ?? "maker-unfrozen";
  if (strategy === "BINARY_PAIR_ARB") return config.binaryArbPolicyVersion ?? config.executionResearchPolicyVersion ?? "binary-arb-unfrozen";
  if (strategy === "THRESHOLD_LADDER_ARB") return config.thresholdLadderPolicyVersion ?? config.executionResearchPolicyVersion ?? "threshold-ladder-unfrozen";
  if (strategy === "NEG_RISK_ARB") return config.negRiskArbPolicyVersion ?? config.executionResearchPolicyVersion ?? "neg-risk-arb-unfrozen";
  return config.crossMarketPolicyVersion ?? config.executionResearchPolicyVersion ?? "cross-market-unfrozen";
}

export function executionPolicyStartAt(config: BotConfig, strategy: ExecutionResearchStrategy): number {
  if (strategy === "MAKER_PAIR") return config.makerResearchPolicyStartAt ?? config.executionResearchPolicyStartAt ?? 0;
  if (strategy === "BINARY_PAIR_ARB") return config.binaryArbPolicyStartAt ?? config.executionResearchPolicyStartAt ?? 0;
  if (strategy === "THRESHOLD_LADDER_ARB") return config.thresholdLadderPolicyStartAt ?? config.executionResearchPolicyStartAt ?? 0;
  if (strategy === "NEG_RISK_ARB") return config.negRiskArbPolicyStartAt ?? config.executionResearchPolicyStartAt ?? 0;
  return config.crossMarketPolicyStartAt ?? config.executionResearchPolicyStartAt ?? 0;
}

export function executionPolicyEnabled(config: BotConfig, strategy: ExecutionResearchStrategy): boolean {
  if (config.executionResearchEnabled === false) return false;
  if (strategy === "MAKER_PAIR") return config.makerResearchEnabled !== false;
  if (strategy === "CROSS_MARKET_LATENCY") return config.crossMarketResearchEnabled !== false;
  return true;
}
