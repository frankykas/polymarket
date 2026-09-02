import { randomId } from "../db.js";
import type { BotDatabase } from "../db.js";
import type { AgentEventWriter } from "../events/eventWriter.js";
import { takerFeeUsd } from "../liveExecution.js";
import { researchObservationId } from "../researchObservationId.js";
import { fetchClevelandFedNowcast } from "../research/macroNowcast.js";
import type {
  BotConfig,
  MacroForecastVintage,
  MarketSnapshot,
  OrderBookSnapshot,
  StrategyBacktestResult,
  StrategyHypothesis,
  StrategyOpportunity,
  TradeSignal
} from "../types.js";

export type CpiMetric = "HEADLINE_MOM" | "CORE_MOM" | "HEADLINE_YOY" | "CORE_YOY";
export type CpiBucket = "EXACT" | "AT_LEAST" | "AT_MOST";

export interface MacroCpiSpec {
  metric: CpiMetric;
  bucket: CpiBucket;
  targetValue: number;
  referenceYear: number;
  referenceMonth: number;
  releaseTimestamp: number;
}

export interface CpiObservation {
  period: string;
  timestamp: number;
  headlineMom?: number;
  coreMom?: number;
  headlineYoy?: number;
  coreYoy?: number;
}

interface ForecastDistribution {
  point: number;
  sigma: number;
  sampleSize: number;
  modelName?: CpiModelName;
  /** Weight on the parametric model; the remainder uses a trailing empirical base rate. */
  blendWeight?: number;
}

export type CpiModelName =
  | "AR1"
  | "LAST_VALUE"
  | "MEAN_6"
  | "MEAN_12"
  | "EWMA_03"
  | "SEASONAL_12";
const CPI_MODEL_CANDIDATES: CpiModelName[] = [
  "AR1", "LAST_VALUE", "MEAN_6", "MEAN_12", "EWMA_03", "SEASONAL_12"
];

const MACRO_HYPOTHESIS_ID = "hypothesis_macro_scheduled_releases";
export const MACRO_CPI_STRATEGY_ID = "macro_us_cpi_nowcast_v3";
export const MACRO_CPI_MODEL_VERSION = "cleveland-nowcast-prospective-v3";

const SERIES = {
  headlineSa: "CUSR0000SA0",
  coreSa: "CUSR0000SA0L1E",
  headlineNsa: "CUUR0000SA0",
  coreNsa: "CUUR0000SA0L1E"
} as const;

export class MacroCpiStrategyAgent {
  private historyCache = new Map<string, Promise<CpiObservation[]>>();
  private nowcastCache = new Map<string, Promise<MacroForecastVintage[]>>();
  private validation?: StrategyBacktestResult;
  private experimentalPaperEligible = false;

  constructor(private db: BotDatabase, private events: AgentEventWriter, private config: BotConfig) {}

  async ensureValidation(markets: MarketSnapshot[], hypothesis?: StrategyHypothesis, now = Date.now()): Promise<StrategyBacktestResult | undefined> {
    if (this.config.macroCpiStrategyEnabled === false) return undefined;
    const cached = this.db.getLatestStrategyBacktests().find((item) =>
      item.cluster === "MACRO_RELEASE" && item.testKind === "WALK_FORWARD_PROBABILITY" && item.metrics.validationVersion === 4
    );
    const interval = this.config.macroCpiBacktestIntervalMs ?? 24 * 60 * 60_000;
    if (cached && cached.createdAt >= now - interval) {
      this.validation = cached;
      this.experimentalPaperEligible = cached.passed && this.currentResearchForwardGate();
      if (hypothesis) this.db.saveStrategyHypothesis({
        ...hypothesis,
        status: cached.passed ? "PAPER_ELIGIBLE" : "VALIDATING",
        updatedAt: Math.max(hypothesis.updatedAt, cached.createdAt)
      });
      return cached;
    }

    let history: CpiObservation[] = [];
    let loadError: string | undefined;
    try {
      history = await this.historyFor(now);
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
    }
    const metrics = [...new Set(markets
      .map((market) => parseMacroCpiMarket(market, now)?.metric)
      .filter((metric): metric is CpiMetric => Boolean(metric)))];
    const testedMetrics = metrics.length > 0 ? metrics : Object.keys(METRIC_FIELD) as CpiMetric[];
    const tests = testedMetrics
      .map((metric) => walkForwardCpiCalibration(history, metric))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    const sampleSize = tests.reduce((sum, item) => sum + item.sampleSize, 0);
    const weighted = (field: "modelBrier" | "benchmarkBrier" | "accuracy") => sampleSize > 0
      ? tests.reduce((sum, item) => sum + item[field] * item.sampleSize, 0) / sampleSize
      : 0;
    const modelBrier = weighted("modelBrier");
    const benchmarkBrier = weighted("benchmarkBrier");
    const requiredBrierImprovement = 0.005;
    const historicalChallengerPassed = sampleSize >= 150 && modelBrier <= 0.2 && modelBrier + requiredBrierImprovement <= benchmarkBrier;
    // The external nowcast source does not publish a complete point-in-time
    // vintage history.  Refuse to call v3 walk-forward validated until our own
    // append-only vintages and frozen selections have accrued prospectively.
    const passed = false;
    const modelUsage = new Map<string, number>();
    for (const test of tests) {
      for (const [model, count] of Object.entries(test.modelUsage)) modelUsage.set(model, (modelUsage.get(model) ?? 0) + count);
    }
    const result: StrategyBacktestResult = {
      id: randomId("backtest_macro_cpi"),
      hypothesisId: hypothesis?.id ?? MACRO_HYPOTHESIS_ID,
      cluster: "MACRO_RELEASE",
      testKind: "WALK_FORWARD_PROBABILITY",
      independentFromLeadWallets: true,
      sampleSize,
      passed,
      metrics: {
        modelBrier: round(modelBrier, 5),
        benchmarkBrier: round(benchmarkBrier, 5),
        accuracy: round(weighted("accuracy"), 4),
        independentOrigins: Math.floor(sampleSize / 5),
        brierImprovement: round(benchmarkBrier - modelBrier, 5),
        requiredBrierImprovement,
        testedMetrics: testedMetrics.join(","),
        source: "BLS_PUBLIC_DATA_API_V2",
        releaseSource: "BLS_CPI_SCHEDULE",
        modelVersion: MACRO_CPI_MODEL_VERSION,
        historicalChallengerPassed,
        externalNowcastValidation: "PROSPECTIVE_ONLY",
        modelUsage: JSON.stringify(Object.fromEntries(modelUsage)),
        validationVersion: 4,
        ...(loadError ? { loadError } : {})
      },
      reason: sampleSize > 0
        ? `${Math.floor(sampleSize / 5)} outer rolling origins / ${sampleSize} CPI contracts test the historical challenger only (Brier ${modelBrier.toFixed(4)} vs ${benchmarkBrier.toFixed(4)} benchmark). The Cleveland Fed nowcast v3 remains prospective-only because pre-observation vintages are unavailable.`
        : `BLS history was unavailable or insufficient${loadError ? `: ${loadError}` : ""}; CPI candidates remain watchlist-only.`,
      createdAt: now
    };
    this.db.saveStrategyBacktest(result);
    if (hypothesis) this.db.saveStrategyHypothesis({
      ...hypothesis,
      status: passed ? "PAPER_ELIGIBLE" : "VALIDATING",
      updatedAt: Math.max(hypothesis.updatedAt, now)
    });
    this.validation = result;
    this.experimentalPaperEligible = passed && this.currentResearchForwardGate();
    this.events.write({
      type: "macro_strategy.validation_completed",
      agent: "Strategy Research Agent",
      visibility: "PUBLIC",
      message: `Scheduled CPI strategy ${passed ? "passed" : "did not pass"} rolling walk-forward validation (${sampleSize} events).`,
      payload: result
    });
    return result;
  }

  async createSignals(market: MarketSnapshot, books: OrderBookSnapshot[], now = Date.now()): Promise<TradeSignal[]> {
    if (this.config.macroCpiStrategyEnabled === false) return [];
    const spec = parseMacroCpiMarket(market, now);
    if (!spec) return [];
    try {
      const history = await this.historyFor(now);
      const values = metricValuesBefore(history, spec.metric, spec.referenceYear, spec.referenceMonth);
      const historicalForecast = forecastCpiDistributionV2(values, spec.metric);
      if (!historicalForecast) return [];
      const vintage = await this.nowcastFor(spec, now);
      const nowcastValue = vintage ? metricNowcastValue(vintage, spec.metric) : undefined;
      const nowcastFresh = vintage !== undefined && nowcastValue !== undefined &&
        vintage.sourceUpdatedAt <= now + 24 * 60 * 60_000 &&
        now - vintage.sourceUpdatedAt <= (this.config.macroCpiMaxNowcastAgeMs ?? 7 * 24 * 60 * 60_000);
      const nowcastWeight = clamp(this.config.macroCpiNowcastWeight ?? 0.7, 0, 1);
      const forecast = nowcastFresh
        ? blendCpiForecastWithNowcast(historicalForecast, nowcastValue!, spec.metric, nowcastWeight)
        : historicalForecast;
      const historicalFairYes = probabilityForCpiForecastV2(historicalForecast, values, spec);
      const nowcastFairYes = nowcastFresh ? probabilityForCpiBucket({
        point: nowcastValue!,
        sigma: forecast.sigma,
        sampleSize: historicalForecast.sampleSize
      }, spec) : undefined;
      const fairYes = nowcastFairYes === undefined
        ? historicalFairYes
        : clamp01(nowcastWeight * nowcastFairYes + (1 - nowcastWeight) * historicalFairYes);
      const hours = (spec.releaseTimestamp - now) / 3_600_000;
      const instability = Math.min(1, Math.abs(forecast.point - values.at(-1)!) / Math.max(forecast.sigma, 0.05));
      const uncertainty = clamp01(forecast.sigma / (spec.metric.endsWith("MOM") ? 0.75 : 1.25) + 1 / Math.sqrt(forecast.sampleSize));
      const agreement = clamp01(1 - instability * 0.5 - uncertainty * 0.25);
      const choices = market.outcomes.map((outcome, index) => {
        const tokenId = market.clobTokenIds[index];
        const book = books.find((item) => item.tokenId === tokenId);
        const marketProbability = book?.bestAsk ?? market.outcomePrices[index];
        const fairProbability = String(outcome).toLowerCase() === "no" ? 1 - fairYes : fairYes;
        if (!tokenId || !(marketProbability > 0 && marketProbability < 1)) return undefined;
        const edge = fairProbability - marketProbability;
        const fee = takerFeeUsd(1, marketProbability, market.feesEnabled === false ? 0 : market.takerFeeRate ?? this.config.liveExecutionFeeRatePct ?? 0);
        return { outcome, tokenId, book, marketProbability, fairProbability, edge, expectedValuePct: (edge - fee) / marketProbability };
      }).filter((item): item is NonNullable<typeof item> => Boolean(item)).sort((a, b) => b.expectedValuePct - a.expectedValuePct);
      const best = choices[0];
      if (!best) return [];

      const policy = evaluateMacroCpiPolicy({ marketProbability: best.marketProbability, probabilityEdge: best.edge, hours }, this.config);
      const validationPassed = this.validation?.passed === true;
      const researchEligible = nowcastFresh && policy.passed && best.expectedValuePct >= 0.1 && uncertainty <= 0.4;
      const passes = validationPassed && this.experimentalPaperEligible && researchEligible;
      const policyVersion = this.config.macroCpiForwardPolicyVersion ?? "macro-cpi-unfrozen";
      const period = periodKey(spec.referenceYear, spec.referenceMonth);
      const strategyEventKey = `macro:us-cpi:${period}`;
      const reasons = [
        `prospective policy ${policyVersion}`,
        `${spec.metric} ${spec.bucket} ${spec.targetValue.toFixed(1)}%`,
        `${MACRO_CPI_MODEL_VERSION}/${historicalForecast.modelName ?? "UNKNOWN"} blended forecast ${forecast.point.toFixed(2)}% with sigma ${forecast.sigma.toFixed(2)}pp`,
        nowcastFresh
          ? `point-in-time Cleveland Fed vintage ${vintage!.id} (${nowcastValue!.toFixed(2)}%, updated ${new Date(vintage!.sourceUpdatedAt).toISOString()}) at ${(nowcastWeight * 100).toFixed(0)}% weight`
          : "no fresh matching point-in-time Cleveland Fed vintage; research selection blocked",
        `fair ${(best.fairProbability * 100).toFixed(1)}% vs ask ${(best.marketProbability * 100).toFixed(1)}%`,
        `edge ${(best.edge * 100).toFixed(1)}pp`,
        `net EV ${(best.expectedValuePct * 100).toFixed(1)}%`,
        `${forecast.sampleSize} prior releases`,
        validationPassed ? "rolling walk-forward validation passed" : "rolling walk-forward validation not passed",
        this.experimentalPaperEligible ? "clean research-forward gate passed" : "clean research-forward gate not passed",
        ...(policy.passed ? ["frozen price/edge/release-timing gate passed"] : policy.reasons)
      ];
      const signalId = passes || researchEligible
        ? randomId("sig_macro_cpi")
        : researchObservationId("sig_macro_watch", market.id, best.tokenId, policyVersion, now);
      const signal: TradeSignal = {
        id: signalId,
        decision: passes ? "TRADE_CANDIDATE" : "WATCHLIST",
        marketId: market.id,
        conditionId: market.conditionId,
        tokenId: best.tokenId,
        outcome: best.outcome,
        side: "BUY",
        confidence: Math.round(clamp01(0.65 + best.edge * 0.7 + agreement * 0.15 - uncertainty * 0.2) * 100),
        limitPrice: best.marketProbability,
        alignedWallets: [],
        reason: `independent scheduled CPI model: ${reasons.join("; ")}`,
        createdAt: now,
        botDetectedTimestamp: now,
        expectedEntryPrice: best.marketProbability,
        expectedExitPrice: best.fairProbability,
        expectedLiveExecutableReturnPct: best.expectedValuePct,
        entryBookDepth: best.book ? askNotional(best.book) : 0,
        maxEntrySlippage: this.config.maxEntrySlippage,
        parityStatus: passes ? "PASS" : "FAIL",
        parityReason: passes ? "frozen CPI policy and independent walk-forward gate passed" : "CPI policy or validation gate failed",
        signalOrigin: "INDEPENDENT_MODEL",
        strategyId: MACRO_CPI_STRATEGY_ID,
        strategyHypothesisId: MACRO_HYPOTHESIS_ID,
        policyVersion,
        strategyEventKey,
        fairProbability: best.fairProbability,
        marketProbability: best.marketProbability,
        probabilityEdge: best.edge,
        expectedValuePct: best.expectedValuePct,
        modelUncertainty: uncertainty,
        modelAgreement: agreement,
        forecastSampleSize: forecast.sampleSize,
        researchEligible,
        modelVersion: MACRO_CPI_MODEL_VERSION,
        modelName: historicalForecast.modelName,
        resolutionTimestamp: spec.releaseTimestamp
      };
      this.db.saveSignal(signal);
      const opportunity: StrategyOpportunity = {
        id: passes || researchEligible
          ? randomId("macroopp")
          : researchObservationId("macroopp_watch", market.id, best.tokenId, policyVersion, now),
        signalId: signal.id,
        strategyId: MACRO_CPI_STRATEGY_ID,
        cluster: "MACRO_RELEASE",
        marketId: market.id,
        tokenId: best.tokenId,
        outcome: best.outcome,
        spec: {
          ...spec,
          nowcastVintageId: vintage?.id ?? null,
          nowcastSource: vintage?.source ?? null,
          nowcastSourceUpdatedAt: vintage?.sourceUpdatedAt ?? null,
          nowcastValue: nowcastValue ?? null,
          nowcastWeight,
          nowcastFresh
        },
        fairProbability: best.fairProbability,
        marketProbability: best.marketProbability,
        probabilityEdge: best.edge,
        expectedValuePct: best.expectedValuePct,
        uncertainty,
        agreement,
        modelSampleSize: forecast.sampleSize,
        modelVersion: MACRO_CPI_MODEL_VERSION,
        modelName: historicalForecast.modelName,
        policyVersion,
        strategyEventKey,
        researchEligible,
        status: passes ? "CANDIDATE" : researchEligible ? "RESEARCH_QUALIFIED" : "WATCHLIST",
        reason: reasons.join("; "),
        createdAt: now
      };
      this.db.saveStrategyOpportunity(opportunity);
      this.events.write({
        type: "macro_strategy.opportunity_scored",
        agent: "Signal Agent",
        visibility: passes ? "PUBLIC" : "PRIVATE",
        message: `${passes ? "Candidate" : "Watchlist"}: ${market.question} (${(best.edge * 100).toFixed(1)}pp independent edge).`,
        payload: opportunity
      });
      return [signal];
    } catch (error) {
      this.events.write({
        type: "macro_strategy.scan_failed",
        agent: "Signal Agent",
        visibility: "PRIVATE",
        message: `Scheduled CPI strategy could not score ${market.question}.`,
        payload: { marketId: market.id, error: error instanceof Error ? error.message : String(error) }
      });
      return [];
    }
  }

  private historyFor(now: number): Promise<CpiObservation[]> {
    const key = new Date(now).toISOString().slice(0, 10);
    let value = this.historyCache.get(key);
    if (!value) {
      value = fetchBlsCpiHistory(new Date(now).getUTCFullYear());
      this.historyCache.set(key, value);
      void value.catch(() => this.historyCache.delete(key));
    }
    return value;
  }

  private async nowcastFor(spec: MacroCpiSpec, now: number): Promise<MacroForecastVintage | undefined> {
    if (this.config.macroCpiNowcastEnabled === false) return undefined;
    const period = periodKey(spec.referenceYear, spec.referenceMonth);
    const key = new Date(now).toISOString().slice(0, 10);
    let pending = this.nowcastCache.get(key);
    if (!pending) {
      pending = fetchClevelandFedNowcast(this.config.macroCpiNowcastUrl, now);
      this.nowcastCache.set(key, pending);
      void pending.catch(() => this.nowcastCache.delete(key));
    }
    try {
      const vintages = await pending;
      for (const vintage of vintages) this.db.saveMacroForecastVintage(vintage);
      const fetched = vintages.find((vintage) => vintage.referencePeriod === period);
      const persisted = this.db.getLatestMacroForecastVintage(period);
      return [fetched, persisted]
        .filter((vintage): vintage is MacroForecastVintage => Boolean(vintage))
        .sort((left, right) => right.sourceUpdatedAt - left.sourceUpdatedAt || right.fetchedAt - left.fetchedAt)[0];
    } catch {
      return this.db.getLatestMacroForecastVintage(period);
    }
  }

  private currentResearchForwardGate(): boolean {
    const scorecard = this.db.getStrategyForwardScorecard({
      strategyId: MACRO_CPI_STRATEGY_ID,
      cluster: "MACRO_RELEASE",
      since: this.config.macroCpiForwardPolicyStartAt ?? 0,
      policyVersion: this.config.macroCpiForwardPolicyVersion ?? "macro-cpi-unfrozen",
      positionSizeUsd: this.config.independentModelFlatPositionSize ?? this.config.minPositionSize,
      minResolvedTrades: this.config.macroCpiForwardMinResolvedTrades ?? 30,
      minReturnPct: this.config.macroCpiForwardMinReturnPct ?? 0.05
    });
    return scorecard.researchPromotionEligible;
  }
}

export function blendCpiForecastWithNowcast(
  historical: ForecastDistribution,
  nowcastValue: number,
  metric: CpiMetric,
  weight: number
): ForecastDistribution {
  const boundedWeight = clamp(weight, 0, 1);
  const disagreement = Math.abs(historical.point - nowcastValue);
  const floor = metric.endsWith("MOM") ? 0.08 : 0.12;
  return {
    ...historical,
    point: historical.point * (1 - boundedWeight) + nowcastValue * boundedWeight,
    // Do not pretend the external point estimate makes the distribution more
    // certain. Model disagreement widens it instead.
    sigma: Math.max(floor, historical.sigma, disagreement * 0.5),
    blendWeight: 1
  };
}

function metricNowcastValue(vintage: MacroForecastVintage, metric: CpiMetric): number | undefined {
  if (metric === "HEADLINE_MOM") return vintage.headlineMom;
  if (metric === "CORE_MOM") return vintage.coreMom;
  if (metric === "HEADLINE_YOY") return vintage.headlineYoy;
  return vintage.coreYoy;
}

export function parseMacroCpiMarket(market: MarketSnapshot, now = Date.now()): MacroCpiSpec | undefined {
  const raw = asRecord(market.raw);
  const events = Array.isArray(raw.events) ? raw.events.map(asRecord) : [];
  const description = String(raw.description ?? events[0]?.description ?? "");
  if (!/U\.S\. Bureau of Labor Statistics|BLS/i.test(description) || !/Consumer Price Index|CPI/i.test(`${market.question} ${description}`)) return undefined;

  const release = description.match(/released on\s+([A-Za-z]+)\s+(\d{1,2}),\s*(20\d{2}),\s*at\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s*ET/i);
  if (!release) return undefined;
  const releaseMonth = monthNumber(release[1]);
  if (!releaseMonth) return undefined;
  const releaseHour = (Number(release[4]) % 12) + (release[6].toUpperCase() === "PM" ? 12 : 0);
  const releaseTimestamp = easternDateTimeToUtc(Number(release[3]), releaseMonth, Number(release[2]), releaseHour, Number(release[5]));
  if (!Number.isFinite(releaseTimestamp) || releaseTimestamp <= now) return undefined;

  const reference = `${market.question} ${description}`.match(/(?:in|for)\s+([A-Za-z]+)\s+(20\d{2})/i);
  if (!reference) return undefined;
  const referenceMonth = monthNumber(reference[1]);
  const referenceYear = Number(reference[2]);
  if (!referenceMonth || !referenceYear) return undefined;

  const question = market.question.replace(/[−–]/g, "-");
  let metric: CpiMetric;
  if (/Core CPI\s+MoM/i.test(question)) metric = "CORE_MOM";
  else if (/Core CPI\s+YoY/i.test(question)) metric = "CORE_YOY";
  else if (/annual inflation/i.test(question)) metric = "HEADLINE_YOY";
  else if (/monthly inflation/i.test(question)) metric = "HEADLINE_MOM";
  else return undefined;

  const numberMatch = question.match(/(-?\d+(?:\.\d+)?)\s*%/);
  let targetValue = numberMatch ? Number(numberMatch[1]) : Number.NaN;
  let bucket: CpiBucket = "EXACT";
  if (/decrease by/i.test(question) && targetValue > 0) targetValue = -targetValue;
  if (/or more|at least/i.test(question)) bucket = "AT_LEAST";
  else if (/or less|at most/i.test(question)) bucket = "AT_MOST";
  if (/stay flat/i.test(question)) targetValue = 0;
  if (!Number.isFinite(targetValue)) return undefined;
  return { metric, bucket, targetValue, referenceYear, referenceMonth, releaseTimestamp };
}

export function evaluateMacroCpiPolicy(input: { marketProbability: number; probabilityEdge: number; hours: number }, config: BotConfig): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const minPrice = config.macroCpiMinEntryPrice ?? 0.2;
  const maxPrice = config.macroCpiMaxEntryPrice ?? 0.8;
  const minEdge = config.macroCpiMinProbabilityEdge ?? 0.08;
  const maxEdge = config.macroCpiMaxProbabilityEdge ?? 0.3;
  const minHours = config.macroCpiMinTimeToReleaseHours ?? 2;
  const maxHours = config.macroCpiMaxTimeToReleaseHours ?? 168;
  if (input.marketProbability < minPrice || input.marketProbability > maxPrice) reasons.push("entry price outside frozen band");
  if (input.probabilityEdge < minEdge || input.probabilityEdge > maxEdge) reasons.push("model edge outside frozen band");
  if (input.hours < minHours || input.hours > maxHours) reasons.push("release horizon outside frozen band");
  return { passed: reasons.length === 0, reasons };
}

export function forecastCpiDistribution(values: number[], metric: CpiMetric): ForecastDistribution | undefined {
  if (values.length < 18) return undefined;
  const train = values.slice(-48);
  const pairs = train.slice(1).map((value, index) => ({ x: train[index], y: value }));
  const meanX = pairs.reduce((sum, pair) => sum + pair.x, 0) / pairs.length;
  const meanY = pairs.reduce((sum, pair) => sum + pair.y, 0) / pairs.length;
  const denominator = pairs.reduce((sum, pair) => sum + (pair.x - meanX) ** 2, 0);
  const slope = denominator > 0 ? clamp(pairs.reduce((sum, pair) => sum + (pair.x - meanX) * (pair.y - meanY), 0) / denominator, -0.25, 1.1) : 0;
  const intercept = meanY - slope * meanX;
  const residuals = pairs.map((pair) => pair.y - (intercept + slope * pair.x));
  const floor = metric.endsWith("MOM") ? 0.08 : 0.12;
  return {
    point: intercept + slope * train.at(-1)!,
    sigma: Math.max(floor, standardDeviation(residuals)),
    sampleSize: pairs.length
  };
}

/**
 * Selects a forecasting rule using only inner, one-step-ahead folds from the
 * supplied training window, then fits that rule to the complete window. The
 * outer validation caller never exposes its held-out observation here.
 */
export function forecastCpiDistributionV2(values: number[], metric: CpiMetric): ForecastDistribution | undefined {
  if (values.length < 30) return undefined;
  const innerStart = Math.max(24, values.length - 36);
  const blendWeights = [0.25, 0.5, 0.75, 1] as const;
  const scores = new Map<string, { model: CpiModelName; blendWeight: number; loss: number; samples: number }>();
  for (const model of CPI_MODEL_CANDIDATES) {
    for (const blendWeight of blendWeights) scores.set(`${model}:${blendWeight}`, { model, blendWeight, loss: 0, samples: 0 });
  }
  for (let origin = innerStart; origin < values.length; origin += 1) {
    const train = values.slice(0, origin);
    const actual = round(values[origin], 1);
    const center = round(train.at(-1)!, 1);
    for (const score of scores.values()) {
      const forecast = forecastCpiCandidate(train, metric, score.model);
      if (!forecast) continue;
      for (const offset of [-0.2, -0.1, 0, 0.1, 0.2]) {
        const targetValue = round(center + offset, 1);
        const modelProbability = probabilityForCpiBucket(forecast, { bucket: "EXACT", targetValue });
        const benchmarkProbability = empiricalCpiProbability(train, { bucket: "EXACT", targetValue });
        const probability = score.blendWeight * modelProbability + (1 - score.blendWeight) * benchmarkProbability;
        const outcome = actual === targetValue ? 1 : 0;
        score.loss += (probability - outcome) ** 2;
        score.samples += 1;
      }
    }
  }
  const selected = [...scores.values()]
    .filter((score) => score.samples >= 30)
    .sort((a, b) => a.loss / a.samples - b.loss / b.samples || a.model.localeCompare(b.model) || a.blendWeight - b.blendWeight)[0]
    ?? { model: "AR1" as const, blendWeight: 1, loss: 0, samples: 0 };
  const forecast = forecastCpiCandidate(values, metric, selected.model);
  return forecast ? { ...forecast, blendWeight: selected.blendWeight } : undefined;
}

function forecastCpiCandidate(values: number[], metric: CpiMetric, model: CpiModelName): ForecastDistribution | undefined {
  if (values.length < 18) return undefined;
  const point = cpiModelPoint(values, model);
  if (point === undefined || !Number.isFinite(point)) return undefined;
  const residuals: number[] = [];
  const residualStart = Math.max(18, values.length - 48);
  for (let origin = residualStart; origin < values.length; origin += 1) {
    const predicted = cpiModelPoint(values.slice(0, origin), model);
    if (predicted !== undefined && Number.isFinite(predicted)) residuals.push(values[origin] - predicted);
  }
  const floor = metric.endsWith("MOM") ? 0.08 : 0.12;
  return {
    point,
    sigma: Math.max(floor, standardDeviation(residuals)),
    sampleSize: residuals.length,
    modelName: model
  };
}

function cpiModelPoint(values: number[], model: CpiModelName): number | undefined {
  const latest = values.at(-1);
  if (latest === undefined) return undefined;
  if (model === "LAST_VALUE") return latest;
  if (model === "MEAN_6") return average(values.slice(-6));
  if (model === "MEAN_12") return average(values.slice(-12));
  if (model === "SEASONAL_12") return values.length >= 12 ? values.at(-12) : undefined;
  if (model === "EWMA_03") {
    let estimate = values[Math.max(0, values.length - 24)];
    for (const value of values.slice(Math.max(0, values.length - 24) + 1)) estimate = 0.3 * value + 0.7 * estimate;
    return estimate;
  }
  const train = values.slice(-48);
  if (train.length < 3) return latest;
  const pairs = train.slice(1).map((value, index) => ({ x: train[index], y: value }));
  const meanX = average(pairs.map((pair) => pair.x));
  const meanY = average(pairs.map((pair) => pair.y));
  const denominator = pairs.reduce((sum, pair) => sum + (pair.x - meanX) ** 2, 0);
  const slope = denominator > 0
    ? clamp(pairs.reduce((sum, pair) => sum + (pair.x - meanX) * (pair.y - meanY), 0) / denominator, -0.25, 1.1)
    : 0;
  return meanY - slope * meanX + slope * latest;
}

export function probabilityForCpiBucket(forecast: ForecastDistribution, spec: Pick<MacroCpiSpec, "bucket" | "targetValue">): number {
  const lower = spec.targetValue - 0.05;
  const upper = spec.targetValue + 0.05;
  if (spec.bucket === "AT_LEAST") return clamp01(1 - normalCdf((lower - forecast.point) / forecast.sigma));
  if (spec.bucket === "AT_MOST") return clamp01(normalCdf((upper - forecast.point) / forecast.sigma));
  return clamp01(normalCdf((upper - forecast.point) / forecast.sigma) - normalCdf((lower - forecast.point) / forecast.sigma));
}

export function probabilityForCpiForecastV2(
  forecast: ForecastDistribution,
  history: number[],
  spec: Pick<MacroCpiSpec, "bucket" | "targetValue">
): number {
  const modelProbability = probabilityForCpiBucket(forecast, spec);
  const benchmarkProbability = empiricalCpiProbability(history, spec);
  const blendWeight = forecast.blendWeight ?? 1;
  return clamp01(blendWeight * modelProbability + (1 - blendWeight) * benchmarkProbability);
}

function empiricalCpiProbability(history: number[], spec: Pick<MacroCpiSpec, "bucket" | "targetValue">): number {
  const values = history.slice(-36).map((value) => round(value, 1));
  if (values.length === 0) return 0.5;
  const lower = spec.targetValue - 0.05;
  const upper = spec.targetValue + 0.05;
  const successes = values.filter((value) =>
    spec.bucket === "AT_LEAST" ? value >= lower : spec.bucket === "AT_MOST" ? value <= upper : value === round(spec.targetValue, 1)
  ).length;
  return spec.bucket === "EXACT"
    ? (successes + 1) / (values.length + 5)
    : (successes + 1) / (values.length + 2);
}

export function walkForwardCpiCalibration(history: CpiObservation[], metric: CpiMetric): {
  sampleSize: number;
  modelBrier: number;
  benchmarkBrier: number;
  accuracy: number;
  modelUsage: Record<string, number>;
} | undefined {
  const values = history.map((row) => metricValue(row, metric)).filter((value): value is number => Number.isFinite(value));
  if (values.length < 48) return undefined;
  let sampleSize = 0;
  let modelBrier = 0;
  let benchmarkBrier = 0;
  let correct = 0;
  const modelUsage = new Map<string, number>();
  for (let origin = 48; origin < values.length; origin += 1) {
    const train = values.slice(0, origin);
    const forecast = forecastCpiDistributionV2(train, metric);
    if (!forecast) continue;
    const modelKey = `${forecast.modelName ?? "UNKNOWN"}@${forecast.blendWeight ?? 1}`;
    modelUsage.set(modelKey, (modelUsage.get(modelKey) ?? 0) + 1);
    const actual = round(values[origin], 1);
    // Contract grid is fixed from information available at the origin and is
    // shared by every challenger and the benchmark.
    const center = round(train.at(-1)!, 1);
    for (const offset of [-0.2, -0.1, 0, 0.1, 0.2]) {
      const targetValue = round(center + offset, 1);
      const spec = { bucket: "EXACT" as const, targetValue };
        const probability = probabilityForCpiForecastV2(forecast, train, spec);
      const roundedTrain = train.slice(-36).map((value) => round(value, 1));
      const benchmark = (roundedTrain.filter((value) => value === targetValue).length + 1) / (roundedTrain.length + 5);
      const outcome = actual === targetValue ? 1 : 0;
      modelBrier += (probability - outcome) ** 2;
      benchmarkBrier += (benchmark - outcome) ** 2;
      correct += (probability >= 0.5 ? 1 : 0) === outcome ? 1 : 0;
      sampleSize += 1;
    }
  }
  return sampleSize > 0 ? {
    sampleSize,
    modelBrier: modelBrier / sampleSize,
    benchmarkBrier: benchmarkBrier / sampleSize,
    accuracy: correct / sampleSize,
    modelUsage: Object.fromEntries(modelUsage)
  } : undefined;
}

export async function fetchBlsCpiHistory(endYear: number): Promise<CpiObservation[]> {
  const startYear = Math.max(2017, endYear - 9);
  const response = await fetchWithTimeout("https://api.bls.gov/publicAPI/v2/timeseries/data/", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "user-agent": "StratiFi-macro-research/1.0" },
    body: JSON.stringify({ seriesid: Object.values(SERIES), startyear: String(startYear), endyear: String(endYear) })
  });
  const payload = await response.json() as {
    status?: string;
    message?: string[];
    Results?: { series?: Array<{ seriesID: string; data?: Array<{ year: string; period: string; value: string }> }> };
  };
  if (payload.status !== "REQUEST_SUCCEEDED") throw new Error(payload.message?.join("; ") || "BLS request failed");
  const bySeries = new Map<string, Map<string, number>>();
  for (const series of payload.Results?.series ?? []) {
    const values = new Map<string, number>();
    for (const item of series.data ?? []) {
      if (!/^M\d{2}$/.test(item.period) || item.period === "M13") continue;
      const month = Number(item.period.slice(1));
      const value = Number(item.value);
      if (month >= 1 && month <= 12 && Number.isFinite(value)) values.set(periodKey(Number(item.year), month), value);
    }
    bySeries.set(series.seriesID, values);
  }
  const periods = [...new Set([...bySeries.values()].flatMap((values) => [...values.keys()]))].sort();
  return periods.map((period) => {
    const [year, month] = parsePeriod(period);
    const previous = previousPeriod(year, month);
    const priorYear = periodKey(year - 1, month);
    const headlineSa = bySeries.get(SERIES.headlineSa)?.get(period);
    const coreSa = bySeries.get(SERIES.coreSa)?.get(period);
    const headlineNsa = bySeries.get(SERIES.headlineNsa)?.get(period);
    const coreNsa = bySeries.get(SERIES.coreNsa)?.get(period);
    return {
      period,
      timestamp: Date.UTC(year, month - 1, 1),
      headlineMom: percentChange(headlineSa, bySeries.get(SERIES.headlineSa)?.get(previous)),
      coreMom: percentChange(coreSa, bySeries.get(SERIES.coreSa)?.get(previous)),
      headlineYoy: percentChange(headlineNsa, bySeries.get(SERIES.headlineNsa)?.get(priorYear)),
      coreYoy: percentChange(coreNsa, bySeries.get(SERIES.coreNsa)?.get(priorYear))
    };
  }).filter((row) => Object.values(row).some((value) => typeof value === "number" && Number.isFinite(value)));
}

const METRIC_FIELD: Record<CpiMetric, keyof CpiObservation> = {
  HEADLINE_MOM: "headlineMom",
  CORE_MOM: "coreMom",
  HEADLINE_YOY: "headlineYoy",
  CORE_YOY: "coreYoy"
};

function metricValuesBefore(history: CpiObservation[], metric: CpiMetric, year: number, month: number): number[] {
  const target = periodKey(year, month);
  return history.filter((row) => row.period < target).map((row) => metricValue(row, metric)).filter((value): value is number => Number.isFinite(value));
}

function metricValue(row: CpiObservation, metric: CpiMetric): number | undefined {
  const value = row[METRIC_FIELD[metric]];
  return typeof value === "number" ? value : undefined;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} for BLS data`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

function easternDateTimeToUtc(year: number, month: number, day: number, hour: number, minute: number): number {
  const provisional = Date.UTC(year, month - 1, day, hour, minute);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(provisional));
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value);
  const displayedAsUtc = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"));
  return provisional - (displayedAsUtc - provisional);
}

function monthNumber(value: string): number | undefined {
  const parsed = Date.parse(`${value} 1, 2000 UTC`);
  return Number.isFinite(parsed) ? new Date(parsed).getUTCMonth() + 1 : undefined;
}

function periodKey(year: number, month: number): string { return `${year}-M${String(month).padStart(2, "0")}`; }
function parsePeriod(period: string): [number, number] { const [year, month] = period.split("-M").map(Number); return [year, month]; }
function previousPeriod(year: number, month: number): string { return month === 1 ? periodKey(year - 1, 12) : periodKey(year, month - 1); }
function percentChange(current?: number, prior?: number): number | undefined { return current !== undefined && prior ? (current / prior - 1) * 100 : undefined; }
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function askNotional(book: OrderBookSnapshot): number { return book.asks.reduce((sum, level) => sum + Math.max(0, level.price) * Math.max(0, level.size), 0); }
function standardDeviation(values: number[]): number { if (values.length === 0) return 0; const mean = values.reduce((sum, value) => sum + value, 0) / values.length; return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length); }
function average(values: number[]): number { return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function normalCdf(value: number): number { const z = value / Math.sqrt(2); const sign = z < 0 ? -1 : 1; const abs = Math.abs(z); const t = 1 / (1 + 0.3275911 * abs); const erf = sign * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-abs * abs)); return 0.5 * (1 + erf); }
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
function clamp01(value: number): number { return clamp(value, 0, 1); }
function round(value: number, digits: number): number { const factor = 10 ** digits; return Math.round(value * factor) / factor; }
