import type { PerformanceReport, StrategyCluster, WeatherForwardScorecard } from "./types.js";

export type LaunchLaneStage = "RESEARCH" | "FORWARD_VALIDATION" | "EXPERIMENTAL_PAPER" | "STANDARD_PAPER";

export interface LaunchLaneInput {
  strategyId: string;
  label: string;
  cluster: StrategyCluster;
  validationPassed: boolean;
  scorecard: WeatherForwardScorecard;
}

export interface LaunchLaneStatus {
  strategyId: string;
  label: string;
  cluster: StrategyCluster;
  policyVersion: string;
  stage: LaunchLaneStage;
  validationPassed: boolean;
  resolved: number;
  unresolved: number;
  closedPaperPositions: number;
  settlementPnl: number;
  settlementReturnPct: number;
  paperPnl: number;
  paperReturnPct: number;
  researchPromotionEligible: boolean;
  standardPaperEligible: boolean;
  blocker: string;
}

export interface LaunchControlReport {
  generatedAt: number;
  mode: "PAPER_ONLY" | "LIVE_CAPABLE";
  lanes: LaunchLaneStatus[];
  selectedLane?: LaunchLaneStatus;
  strategyEvidencePassed: boolean;
  paperCanaryEligible: boolean;
  liveExecutionCodeReady: boolean;
  liveCredentialsConfigured: boolean;
  liveCanaryEligible: boolean;
  blockers: string[];
  nextMilestone: string;
}

/**
 * One launch gate for every independently testable strategy. Execution-research
 * lanes are deliberately excluded until they have their own paper order path;
 * a profitable simulator cannot silently become permission to trade.
 */
export function evaluateLaunchControl(input: {
  lanes: LaunchLaneInput[];
  actualPaper: PerformanceReport;
  paperMode: boolean;
  liveExecutionCodeReady?: boolean;
  liveCredentialsConfigured?: boolean;
  now?: number;
}): LaunchControlReport {
  const lanes = input.lanes.map(toLaneStatus).sort(compareLanes);
  const selectedLane = lanes[0];
  const strategyEvidencePassed = lanes.some((lane) => lane.standardPaperEligible);
  const paperCanaryEligible = strategyEvidencePassed;
  const liveExecutionCodeReady = input.liveExecutionCodeReady === true;
  const liveCredentialsConfigured = input.liveCredentialsConfigured === true;
  const blockers: string[] = [];

  if (!strategyEvidencePassed) {
    blockers.push(selectedLane
      ? `${selectedLane.label}: ${selectedLane.blocker}`
      : "no independently testable strategy lane is configured");
  }
  if (input.actualPaper.totalPnl <= 0) {
    blockers.push(`current-epoch aggregate paper P&L is not positive (${money(input.actualPaper.totalPnl)})`);
  }
  if (!liveExecutionCodeReady) blockers.push("authenticated live-order adapter has not been implemented and audited");
  if (!liveCredentialsConfigured) blockers.push("live exchange credentials and funding are not configured");
  if (input.paperMode) blockers.push("paperMode is enabled");

  const liveCanaryEligible = strategyEvidencePassed &&
    input.actualPaper.totalPnl > 0 &&
    liveExecutionCodeReady &&
    liveCredentialsConfigured &&
    !input.paperMode;

  return {
    generatedAt: input.now ?? Date.now(),
    mode: liveExecutionCodeReady ? "LIVE_CAPABLE" : "PAPER_ONLY",
    lanes,
    selectedLane,
    strategyEvidencePassed,
    paperCanaryEligible,
    liveExecutionCodeReady,
    liveCredentialsConfigured,
    liveCanaryEligible,
    blockers,
    nextMilestone: nextMilestone(selectedLane, input.actualPaper, liveExecutionCodeReady, liveCredentialsConfigured, input.paperMode)
  };
}

function toLaneStatus(input: LaunchLaneInput): LaunchLaneStatus {
  const scorecard = input.scorecard;
  const stage: LaunchLaneStage = scorecard.standardPaperEligible
    ? "STANDARD_PAPER"
    : scorecard.experimentalPaperEligible
      ? "EXPERIMENTAL_PAPER"
      : input.validationPassed
        ? "FORWARD_VALIDATION"
        : "RESEARCH";
  return {
    strategyId: input.strategyId,
    label: input.label,
    cluster: input.cluster,
    policyVersion: scorecard.policyVersion,
    stage,
    validationPassed: input.validationPassed,
    resolved: scorecard.resolved,
    unresolved: scorecard.unresolved,
    closedPaperPositions: scorecard.closedPaperPositions,
    settlementPnl: scorecard.settlementPnl,
    settlementReturnPct: scorecard.settlementReturnPct,
    paperPnl: scorecard.paperPnl,
    paperReturnPct: scorecard.paperReturnPct,
    researchPromotionEligible: scorecard.researchPromotionEligible,
    standardPaperEligible: scorecard.standardPaperEligible,
    blocker: scorecard.promotionReason
  };
}

function compareLanes(a: LaunchLaneStatus, b: LaunchLaneStatus): number {
  return stageRank(b.stage) - stageRank(a.stage) ||
    Number(b.validationPassed) - Number(a.validationPassed) ||
    b.resolved - a.resolved ||
    b.closedPaperPositions - a.closedPaperPositions ||
    b.settlementReturnPct - a.settlementReturnPct ||
    b.paperReturnPct - a.paperReturnPct ||
    a.label.localeCompare(b.label);
}

function stageRank(stage: LaunchLaneStage): number {
  if (stage === "STANDARD_PAPER") return 4;
  if (stage === "EXPERIMENTAL_PAPER") return 3;
  if (stage === "FORWARD_VALIDATION") return 2;
  return 1;
}

function nextMilestone(
  lane: LaunchLaneStatus | undefined,
  actualPaper: PerformanceReport,
  liveExecutionCodeReady: boolean,
  liveCredentialsConfigured: boolean,
  paperMode: boolean
): string {
  if (!lane) return "Configure an independently testable strategy lane.";
  if (!lane.validationPassed) return `${lane.label}: pass independent walk-forward validation before selecting forward trades.`;
  if (!lane.researchPromotionEligible) {
    return `${lane.label}: ${lane.blocker}`;
  }
  if (!lane.standardPaperEligible) return `${lane.label}: ${lane.blocker}`;
  if (actualPaper.totalPnl <= 0) return "Produce positive current-epoch aggregate paper P&L without changing the frozen winning policy.";
  if (!liveExecutionCodeReady) return "Implement and independently audit the authenticated live-order adapter with an enforced canary cap and kill switch.";
  if (!liveCredentialsConfigured) return "Configure live credentials and a minimally funded canary wallet outside source control.";
  if (paperMode) return "Run the explicit operator preflight, then switch from paper mode to the capped live canary.";
  return "Launch the capped live canary and require paper/live parity before increasing size.";
}

function money(value: number): string {
  return `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;
}
