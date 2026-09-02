import { randomId, type BotDatabase } from "./db.js";
import type {
  MarketSnapshot,
  WeatherOpportunity,
  WeatherTournamentArmScorecard,
  WeatherTournamentObservation,
  WeatherTournamentReport
} from "./types.js";

export const WEATHER_TOURNAMENT_VERSION = "weather-prospective-tournament-v1";
export const WEATHER_TOURNAMENT_SCREEN_AT = 30;
export const WEATHER_TOURNAMENT_FINAL_AT = 100;

interface TournamentArm {
  id: string;
  label: string;
  horizonHours: number;
  horizonWindowHours: number;
  outcomes: readonly string[];
  minPrice: number;
  maxPrice: number;
  minEdge: number;
  maxEdge: number;
  maxUncertainty: number;
}

const HORIZONS = [24, 12, 6] as const;

export const WEATHER_TOURNAMENT_ARMS: readonly TournamentArm[] = HORIZONS.flatMap((horizonHours) => [
  {
    id: `incumbent-no-h${horizonHours}`,
    label: `Incumbent NO ${horizonHours}h`,
    horizonHours,
    horizonWindowHours: 1,
    outcomes: ["NO"],
    minPrice: 0.4,
    maxPrice: 0.7,
    minEdge: 0.15,
    maxEdge: 0.5,
    maxUncertainty: 0.35
  },
  {
    id: `expanded-no-h${horizonHours}`,
    label: `Expanded NO ${horizonHours}h`,
    horizonHours,
    horizonWindowHours: 1,
    outcomes: ["NO"],
    minPrice: 0.25,
    maxPrice: 0.75,
    minEdge: 0.08,
    maxEdge: 0.35,
    maxUncertainty: 0.35
  },
  {
    id: `two-sided-h${horizonHours}`,
    label: `Two-sided ${horizonHours}h`,
    horizonHours,
    horizonWindowHours: 1,
    outcomes: ["YES", "NO"],
    minPrice: 0.25,
    maxPrice: 0.75,
    minEdge: 0.08,
    maxEdge: 0.35,
    maxUncertainty: 0.35
  }
]);

export function collectWeatherTournamentObservations(input: {
  db: BotDatabase;
  opportunities: WeatherOpportunity[];
  positionSizeUsd: number;
  now?: number;
}): { attempted: number; inserted: number; observations: WeatherTournamentObservation[] } {
  const observations = selectWeatherTournamentObservations({
    opportunities: input.opportunities,
    positionSizeUsd: input.positionSizeUsd,
    now: input.now
  });
  let inserted = 0;
  for (const observation of observations) {
    if (input.db.saveWeatherTournamentObservation(observation)) inserted += 1;
  }
  return { attempted: observations.length, inserted, observations };
}

export function selectWeatherTournamentObservations(input: {
  opportunities: WeatherOpportunity[];
  positionSizeUsd: number;
  now?: number;
}): WeatherTournamentObservation[] {
  const now = input.now ?? Date.now();
  const positionSizeUsd = Math.max(0.01, input.positionSizeUsd);
  const eligibleBase = input.opportunities.filter((opportunity) =>
    opportunity.stationValidationPassed === true &&
    Boolean(opportunity.spec.stationCode) &&
    Number.isFinite(opportunity.resolutionTimestamp) &&
    opportunity.resolutionTimestamp! > now
  );
  const byStationDate = new Map<string, WeatherOpportunity[]>();
  for (const opportunity of eligibleBase) {
    const station = opportunity.spec.stationCode!.toUpperCase();
    const key = `${station}:${opportunity.spec.targetDate}`;
    const group = byStationDate.get(key) ?? [];
    group.push(opportunity);
    byStationDate.set(key, group);
  }

  const observations: WeatherTournamentObservation[] = [];
  for (const opportunities of byStationDate.values()) {
    for (const arm of WEATHER_TOURNAMENT_ARMS) {
      const inHorizon = opportunities.filter((opportunity) => {
        const hours = (opportunity.resolutionTimestamp! - now) / 3_600_000;
        return Math.abs(hours - arm.horizonHours) <= arm.horizonWindowHours;
      });
      if (inHorizon.length === 0) continue;
      const evaluated = inHorizon.map((opportunity) => evaluateForArm(opportunity, arm, positionSizeUsd));
      evaluated.sort((a, b) =>
        Number(b.eligible) - Number(a.eligible) ||
        (b.expectedReturnPct ?? Number.NEGATIVE_INFINITY) - (a.expectedReturnPct ?? Number.NEGATIVE_INFINITY) ||
        b.opportunity.fairProbability - a.opportunity.fairProbability ||
        a.opportunity.marketId.localeCompare(b.opportunity.marketId)
      );
      const selected = evaluated[0];
      const stationCode = selected.opportunity.spec.stationCode!.toUpperCase();
      observations.push({
        id: randomId("weather_tournament"),
        tournamentVersion: WEATHER_TOURNAMENT_VERSION,
        armId: arm.id,
        armLabel: arm.label,
        horizonHours: arm.horizonHours,
        horizonWindowHours: arm.horizonWindowHours,
        stationCode,
        targetDate: selected.opportunity.spec.targetDate,
        marketId: selected.opportunity.marketId,
        tokenId: selected.opportunity.tokenId,
        outcome: selected.opportunity.outcome,
        fairProbability: selected.opportunity.fairProbability,
        marketProbability: clampProbability(selected.opportunity.marketMidProbability ?? selected.opportunity.marketProbability),
        executableEntryPrice: selected.opportunity.executableEntryPrice,
        probabilityEdge: selected.probabilityEdge,
        expectedReturnPct: selected.expectedReturnPct,
        positionSizeUsd,
        entryFeeUsd: selected.opportunity.entryFeeUsd ?? 0,
        uncertainty: selected.opportunity.uncertainty,
        eligible: selected.eligible,
        eligibilityReasons: selected.reasons,
        resolutionTimestamp: selected.opportunity.resolutionTimestamp!,
        selectedAt: now
      });
    }
  }
  return observations;
}

function evaluateForArm(opportunity: WeatherOpportunity, arm: TournamentArm, positionSizeUsd: number): {
  opportunity: WeatherOpportunity;
  eligible: boolean;
  reasons: string[];
  probabilityEdge?: number;
  expectedReturnPct?: number;
} {
  const reasons: string[] = [];
  const outcome = String(opportunity.outcome).toUpperCase();
  if (!arm.outcomes.includes(outcome)) reasons.push(`outcome ${outcome} is outside ${arm.outcomes.join("/")}`);
  const entry = opportunity.executableEntryPrice;
  if (!(entry !== undefined && entry > 0 && entry < 1)) reasons.push("configured research size was not executable within the slippage limit");
  const edge = entry === undefined ? undefined : opportunity.fairProbability - entry;
  if (entry !== undefined && (entry < arm.minPrice || entry > arm.maxPrice)) {
    reasons.push(`entry ${(entry * 100).toFixed(1)}% is outside ${(arm.minPrice * 100).toFixed(0)}-${(arm.maxPrice * 100).toFixed(0)}%`);
  }
  if (edge !== undefined && (edge < arm.minEdge || edge > arm.maxEdge)) {
    reasons.push(`edge ${(edge * 100).toFixed(1)}pp is outside ${(arm.minEdge * 100).toFixed(0)}-${(arm.maxEdge * 100).toFixed(0)}pp`);
  }
  if (opportunity.uncertainty > arm.maxUncertainty) {
    reasons.push(`uncertainty ${(opportunity.uncertainty * 100).toFixed(1)}% exceeds ${(arm.maxUncertainty * 100).toFixed(0)}%`);
  }
  const shares = entry === undefined ? 0 : positionSizeUsd / entry;
  const expectedReturnPct = entry === undefined
    ? undefined
    : (opportunity.fairProbability * shares - positionSizeUsd - (opportunity.entryFeeUsd ?? 0)) / positionSizeUsd;
  return { opportunity, eligible: reasons.length === 0, reasons, probabilityEdge: edge, expectedReturnPct };
}

export function buildWeatherTournamentReport(input: {
  observations: WeatherTournamentObservation[];
  marketForId: (marketId: string) => MarketSnapshot | undefined;
  generatedAt?: number;
}): WeatherTournamentReport {
  const arms = WEATHER_TOURNAMENT_ARMS.map((arm) => scoreArm(
    arm,
    input.observations.filter((observation) => observation.armId === arm.id),
    input.marketForId
  ));
  const decisionOrder = { PROSPECTIVE_WINNER: 0, CONTINUE_TO_100: 1, COLLECTING: 2, KILL: 3 } as const;
  arms.sort((a, b) =>
    decisionOrder[a.decision] - decisionOrder[b.decision] ||
    b.returnPct - a.returnPct ||
    (b.brierImprovement ?? Number.NEGATIVE_INFINITY) - (a.brierImprovement ?? Number.NEGATIVE_INFINITY) ||
    a.armId.localeCompare(b.armId)
  );
  return {
    generatedAt: input.generatedAt ?? Date.now(),
    tournamentVersion: WEATHER_TOURNAMENT_VERSION,
    screenAt: WEATHER_TOURNAMENT_SCREEN_AT,
    finalAt: WEATHER_TOURNAMENT_FINAL_AT,
    arms
  };
}

function scoreArm(
  arm: TournamentArm,
  observations: WeatherTournamentObservation[],
  marketForId: (marketId: string) => MarketSnapshot | undefined
): WeatherTournamentArmScorecard {
  let resolved = 0;
  let eligibleResolved = 0;
  let wins = 0;
  let losses = 0;
  let pnlUsd = 0;
  let capitalUsd = 0;
  let modelBrier = 0;
  let marketBrier = 0;
  for (const observation of observations) {
    const winningOutcome = marketForId(observation.marketId)?.winningOutcome;
    if (!winningOutcome) continue;
    const won = normalizeOutcome(winningOutcome) === normalizeOutcome(String(observation.outcome));
    const actual = won ? 1 : 0;
    resolved += 1;
    modelBrier += (observation.fairProbability - actual) ** 2;
    marketBrier += (observation.marketProbability - actual) ** 2;
    if (!observation.eligible || observation.executableEntryPrice === undefined) continue;
    eligibleResolved += 1;
    if (won) wins += 1;
    else losses += 1;
    const shares = observation.positionSizeUsd / observation.executableEntryPrice;
    pnlUsd += (won ? shares : 0) - observation.positionSizeUsd - observation.entryFeeUsd;
    capitalUsd += observation.positionSizeUsd;
  }
  const modelBrierScore = resolved > 0 ? modelBrier / resolved : undefined;
  const marketBrierScore = resolved > 0 ? marketBrier / resolved : undefined;
  const brierImprovement = modelBrierScore !== undefined && marketBrierScore !== undefined
    ? marketBrierScore - modelBrierScore
    : undefined;
  const returnPct = capitalUsd > 0 ? pnlUsd / capitalUsd : 0;
  const decision = tournamentDecision({ resolved, eligibleResolved, pnlUsd, returnPct, brierImprovement });
  return {
    tournamentVersion: WEATHER_TOURNAMENT_VERSION,
    armId: arm.id,
    armLabel: arm.label,
    horizonHours: arm.horizonHours,
    observations: observations.length,
    resolved,
    eligibleSelections: observations.filter((observation) => observation.eligible).length,
    eligibleResolved,
    wins,
    losses,
    capitalUsd: roundMoney(capitalUsd),
    pnlUsd: roundMoney(pnlUsd),
    returnPct,
    modelBrierScore,
    marketBrierScore,
    brierImprovement,
    decision: decision.decision,
    decisionReason: decision.reason
  };
}

function tournamentDecision(input: {
  resolved: number;
  eligibleResolved: number;
  pnlUsd: number;
  returnPct: number;
  brierImprovement?: number;
}): { decision: WeatherTournamentArmScorecard["decision"]; reason: string } {
  if (input.resolved < WEATHER_TOURNAMENT_SCREEN_AT) {
    return {
      decision: "COLLECTING",
      reason: `needs ${WEATHER_TOURNAMENT_SCREEN_AT} independent resolved station-days for screening; has ${input.resolved}`
    };
  }
  if (input.pnlUsd < 0 && (input.brierImprovement ?? 0) < 0) {
    return {
      decision: "KILL",
      reason: `screen failed: executable P&L is $${input.pnlUsd.toFixed(2)} and model Brier improvement is ${(input.brierImprovement ?? 0).toFixed(4)}`
    };
  }
  if (input.resolved < WEATHER_TOURNAMENT_FINAL_AT) {
    return {
      decision: "CONTINUE_TO_100",
      reason: `screen survived; continue untouched to ${WEATHER_TOURNAMENT_FINAL_AT} resolved station-days (${input.eligibleResolved} executable)`
    };
  }
  if (input.eligibleResolved >= WEATHER_TOURNAMENT_SCREEN_AT && input.returnPct > 0 && (input.brierImprovement ?? 0) > 0) {
    return {
      decision: "PROSPECTIVE_WINNER",
      reason: `passed ${WEATHER_TOURNAMENT_FINAL_AT}-observation test with positive executable return and market-benchmark improvement`
    };
  }
  return {
    decision: "KILL",
    reason: `final failed: needs at least ${WEATHER_TOURNAMENT_SCREEN_AT} executable resolutions, positive return, and positive Brier improvement`
  };
}

function normalizeOutcome(value: string): string {
  return value.trim().toLowerCase();
}

function clampProbability(value: number): number {
  return Math.max(0.0001, Math.min(0.9999, value));
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
