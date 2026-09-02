import assert from "node:assert/strict";
import test from "node:test";
import { evaluateLaunchControl, type LaunchLaneInput } from "../src/launchControl.js";
import type { PerformanceReport, WeatherForwardScorecard } from "../src/types.js";

test("launch control selects the strongest independent lane instead of hard-wiring CPI", () => {
  const report = evaluateLaunchControl({
    lanes: [
      lane("macro", "Scheduled CPI", "MACRO_RELEASE", false, scorecard({ policyVersion: "cpi-v1" })),
      lane("weather", "Weather forecasting", "WEATHER_FORECASTING", true, scorecard({
        policyVersion: "weather-v1",
        resolved: 7,
        unresolved: 3,
        promotionReason: "needs 30 resolved immutable research selections; has 7"
      }))
    ],
    actualPaper: performance(-2),
    paperMode: true,
    now: 123
  });

  assert.equal(report.generatedAt, 123);
  assert.equal(report.selectedLane?.strategyId, "weather");
  assert.equal(report.selectedLane?.stage, "FORWARD_VALIDATION");
  assert.match(report.nextMilestone, /needs 30 resolved/);
  assert.equal(report.liveCanaryEligible, false);
});

test("a strategy evidence pass cannot bypass missing live execution controls", () => {
  const report = evaluateLaunchControl({
    lanes: [lane("weather", "Weather forecasting", "WEATHER_FORECASTING", true, scorecard({
      policyVersion: "weather-v2",
      resolved: 30,
      closedPaperPositions: 30,
      settlementPnl: 12,
      settlementReturnPct: 0.08,
      paperPnl: 10,
      paperReturnPct: 0.07,
      researchPromotionEligible: true,
      experimentalPaperEligible: true,
      standardPaperEligible: true,
      promotionEligible: true,
      researchPromotionReason: "passed",
      promotionReason: "passed"
    }))],
    actualPaper: performance(10),
    paperMode: true,
    liveExecutionCodeReady: false,
    liveCredentialsConfigured: false
  });

  assert.equal(report.strategyEvidencePassed, true);
  assert.equal(report.paperCanaryEligible, true);
  assert.equal(report.liveCanaryEligible, false);
  assert.ok(report.blockers.some((item) => /live-order adapter/.test(item)));
  assert.ok(report.blockers.some((item) => /paperMode/.test(item)));
});

test("live canary requires evidence, positive aggregate paper, adapter, credentials, and explicit live mode", () => {
  const winning = lane("weather", "Weather forecasting", "WEATHER_FORECASTING", true, scorecard({
    policyVersion: "weather-v2",
    resolved: 30,
    closedPaperPositions: 30,
    settlementPnl: 12,
    settlementReturnPct: 0.08,
    paperPnl: 10,
    paperReturnPct: 0.07,
    researchPromotionEligible: true,
    experimentalPaperEligible: true,
    standardPaperEligible: true,
    promotionEligible: true,
    researchPromotionReason: "passed",
    promotionReason: "passed"
  }));
  const blocked = evaluateLaunchControl({
    lanes: [winning],
    actualPaper: performance(-0.01),
    paperMode: false,
    liveExecutionCodeReady: true,
    liveCredentialsConfigured: true
  });
  assert.equal(blocked.liveCanaryEligible, false);
  assert.ok(blocked.blockers.some((item) => /aggregate paper P&L/.test(item)));

  const eligible = evaluateLaunchControl({
    lanes: [winning],
    actualPaper: performance(1),
    paperMode: false,
    liveExecutionCodeReady: true,
    liveCredentialsConfigured: true
  });
  assert.equal(eligible.liveCanaryEligible, true);
  assert.deepEqual(eligible.blockers, []);
});

function lane(
  strategyId: string,
  label: string,
  cluster: LaunchLaneInput["cluster"],
  validationPassed: boolean,
  card: WeatherForwardScorecard
): LaunchLaneInput {
  return { strategyId, label, cluster, validationPassed, scorecard: card };
}

function scorecard(overrides: Partial<WeatherForwardScorecard>): WeatherForwardScorecard {
  return {
    policyVersion: "v1",
    since: 0,
    positionSizeUsd: 5,
    observations: 0,
    uniqueCandidates: 0,
    executedCandidates: 0,
    closedPaperPositions: 0,
    resolved: 0,
    unresolved: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    settlementPnl: 0,
    settlementReturnPct: 0,
    paperPnl: 0,
    paperReturnPct: 0,
    researchPromotionEligible: false,
    researchPromotionReason: "not enough evidence",
    experimentalPaperEligible: false,
    standardPaperEligible: false,
    promotionEligible: false,
    promotionReason: "not enough evidence",
    ...overrides
  };
}

function performance(totalPnl: number): PerformanceReport {
  return {
    openPositions: 0,
    closedPositions: 0,
    openCost: 0,
    openValue: 0,
    storedOpenValue: 0,
    executableOpenValue: 0,
    realizedPnl: totalPnl,
    unrealizedPnl: 0,
    storedUnrealizedPnl: 0,
    executableUnrealizedPnl: 0,
    totalPnl,
    storedTotalPnl: totalPnl,
    executableTotalPnl: totalPnl,
    noBidOpenPositions: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    paperOrders: 0,
    paperFills: 0,
    signals: 0,
    approvedSignals: 0
  };
}
