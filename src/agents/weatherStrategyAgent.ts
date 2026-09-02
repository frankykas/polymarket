import { randomId } from "../db.js";
import type { BotDatabase } from "../db.js";
import type { AgentEventWriter } from "../events/eventWriter.js";
import { takerFeeUsd } from "../liveExecution.js";
import { researchObservationId } from "../researchObservationId.js";
import type {
  BotConfig,
  MarketSnapshot,
  OrderBookSnapshot,
  StrategyBacktestResult,
  StrategyHypothesis,
  TradeSignal,
  WeatherMarketSpec,
  WeatherOpportunity
} from "../types.js";

interface Location {
  latitude: number;
  longitude: number;
  timezone?: string;
  source: "AIRPORT" | "GEOCODE";
  stationCode?: string;
}

interface EnsembleForecast {
  values: number[];
  mean: number;
  standardDeviation: number;
  sampleSize: number;
  locationSource: Location["source"];
}

export interface ForecastSkill {
  sampleSize: number;
  maeC: number;
  maeUpper95C: number;
  biasC: number;
  withinOneC: number;
  passed: boolean;
  actualSource: "STATION_METAR" | "GRID_ARCHIVE";
}

interface StationValidationFailure {
  station: string;
  error: string;
}

const WEATHER_HYPOTHESIS_ID = "hypothesis_weather_forecasting";
export const DEFAULT_WEATHER_POLICY_VERSION = "weather-unfrozen";

export function weatherStrategyEventKey(spec: WeatherMarketSpec): string {
  return `weather:${(spec.stationCode ?? spec.city).trim().toLowerCase()}:${spec.targetDate}`;
}

export function evaluateWeatherCandidatePolicy(input: {
  outcome: string;
  marketProbability: number;
  probabilityEdge: number;
}, config: BotConfig): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const allowedOutcomes = new Set((config.weatherAllowedOutcomes ?? ["YES", "NO"]).map((value) => value.trim().toLowerCase()));
  if (!allowedOutcomes.has(input.outcome.trim().toLowerCase())) {
    reasons.push(`outcome ${input.outcome} is outside the frozen ${[...allowedOutcomes].join("/").toUpperCase()} lane`);
  }
  const minPrice = config.weatherMinEntryPrice ?? 0.03;
  const maxPrice = config.weatherMaxEntryPrice ?? 0.97;
  if (input.marketProbability < minPrice || input.marketProbability > maxPrice) {
    reasons.push(`entry ${(input.marketProbability * 100).toFixed(1)}% is outside ${(minPrice * 100).toFixed(0)}-${(maxPrice * 100).toFixed(0)}%`);
  }
  const minEdge = config.weatherMinProbabilityEdge ?? 0.08;
  const maxEdge = config.weatherMaxProbabilityEdge ?? 1;
  if (input.probabilityEdge < minEdge || input.probabilityEdge > maxEdge) {
    reasons.push(`edge ${(input.probabilityEdge * 100).toFixed(1)}pp is outside ${(minEdge * 100).toFixed(0)}-${(maxEdge * 100).toFixed(0)}pp`);
  }
  return { passed: reasons.length === 0, reasons };
}

export class WeatherStrategyAgent {
  private locationCache = new Map<string, Promise<Location | undefined>>();
  private forecastCache = new Map<string, Promise<EnsembleForecast | undefined>>();
  private locationFailureUntil = new Map<string, number>();
  private forecastFailureUntil = new Map<string, number>();
  private stationSkills = new Map<string, ForecastSkill>();
  private cycleOpportunities: WeatherOpportunity[] = [];
  private validation?: StrategyBacktestResult;

  constructor(private db: BotDatabase, private events: AgentEventWriter, private config: BotConfig) {}

  beginCycle(): void {
    this.cycleOpportunities = [];
  }

  getCycleOpportunities(): WeatherOpportunity[] {
    return [...this.cycleOpportunities];
  }

  async ensureValidation(markets: MarketSnapshot[], hypothesis?: StrategyHypothesis, now = Date.now()): Promise<StrategyBacktestResult | undefined> {
    if (this.config.weatherStrategyEnabled === false) return undefined;
    const parsedMarkets = markets.map((market) => ({ market, spec: parseWeatherMarket(market, now) }));
    const fallbackSpec: WeatherMarketSpec = {
      city: "London",
      stationCode: "EGLC",
      targetDate: isoDate(now),
      unit: "C",
      bucket: "EXACT",
      lower: 20,
      upper: 20
    };
    const stationSpecs = selectWeatherValidationSpecs(
      parsedMarkets.map((item) => item.spec).filter((spec): spec is WeatherMarketSpec => Boolean(spec)),
      this.config.weatherValidationStationLimit ?? 12
    );
    const validationSpecs = stationSpecs.length > 0 ? stationSpecs : [fallbackSpec];
    const cached = this.db.getLatestStrategyBacktests().find((item) => item.cluster === "WEATHER_FORECASTING" && item.testKind === "INDEPENDENT_FORECAST_SKILL");
    const interval = this.config.weatherBacktestIntervalMs ?? 24 * 60 * 60_000;
    const cachedWindowStartedAt = Number(cached?.metrics.validationWindowStartedAt ?? cached?.createdAt ?? 0);
    const cachedIsCurrent = Boolean(cached) &&
      cached?.metrics.validationVersion === 5 &&
      cachedWindowStartedAt >= now - interval;
    const cachedSkills = cachedIsCurrent
      ? parseStationSkills(cached?.metrics.stationSkillsJson)
      : new Map<string, ForecastSkill>();
    const attemptedStations = cachedIsCurrent
      ? parseAttemptedStations(cached?.metrics.attemptedStationsJson, cachedSkills.keys())
      : new Set<string>();
    const cachedFailures = cachedIsCurrent
      ? parseStationFailures(cached?.metrics.stationFailuresJson)
      : [];
    const specsToValidate = selectUnattemptedWeatherValidationSpecs(validationSpecs, attemptedStations);
    const cachedMetadataComplete = Number(cached?.metrics.stationCount) === cachedSkills.size &&
      Number(cached?.metrics.attemptedStationCount) === attemptedStations.size &&
      Number.isFinite(Number(cached?.metrics.validationWindowStartedAt));
    if (cached && cachedIsCurrent && specsToValidate.length === 0 && cachedMetadataComplete) {
      this.stationSkills = cachedSkills;
      this.validation = cached;
      return cached;
    }

    const stationSkills = await mapWithConcurrency(specsToValidate, 3, async (spec) => {
      try {
        const location = await this.locationFor(spec);
        const skill = location ? await backtestForecastSkill(
          location,
          this.config.weatherBacktestDays ?? 21,
          now,
          this.config.weatherValidationLagDays ?? 2
        ) : undefined;
        return { spec, skill };
      } catch (error) {
        return { spec, skill: undefined, error: error instanceof Error ? error.message : String(error) };
      }
    });
    const usableSkills = stationSkills.filter((item): item is { spec: WeatherMarketSpec; skill: ForecastSkill } => Boolean(item.skill));
    this.stationSkills = new Map(cachedSkills);
    for (const item of usableSkills) {
      if (item.spec.stationCode) this.stationSkills.set(item.spec.stationCode.toUpperCase(), item.skill);
    }
    for (const spec of specsToValidate) {
      if (spec.stationCode) attemptedStations.add(spec.stationCode.toUpperCase());
    }
    const skill = combineForecastSkills([...this.stationSkills.values()]);
    const stationNames = [...this.stationSkills.keys()].sort().join(",") || validationSpecs.map((item) => item.stationCode ?? item.city).join(",");
    const newStationFailures = stationSkills
      .filter((item) => !item.skill)
      .map((item) => ({
        station: item.spec.stationCode ?? item.spec.city,
        error: "error" in item ? item.error : "no forecast skill data"
      }));
    const newlySuccessfulStations = new Set(usableSkills
      .map((item) => item.spec.stationCode?.toUpperCase())
      .filter((station): station is string => Boolean(station)));
    const stationFailures = [
      ...cachedFailures.filter((failure) => !newlySuccessfulStations.has(failure.station.toUpperCase())),
      ...newStationFailures
    ];
    const validationWindowStartedAt = cachedIsCurrent ? cachedWindowStartedAt : now;
    const result: StrategyBacktestResult = {
      id: randomId("backtest"),
      hypothesisId: hypothesis?.id ?? WEATHER_HYPOTHESIS_ID,
      cluster: "WEATHER_FORECASTING",
      testKind: "INDEPENDENT_FORECAST_SKILL",
      independentFromLeadWallets: true,
      sampleSize: skill?.sampleSize ?? 0,
      passed: skill?.passed ?? false,
      metrics: skill ? {
        maeC: round(skill.maeC, 3),
        maeUpper95C: round(skill.maeUpper95C, 3),
        biasC: round(skill.biasC, 3),
        withinOneC: round(skill.withinOneC, 4),
        stations: stationNames,
        stationCount: this.stationSkills.size,
        horizons: "previous_day1+previous_day2",
        actualSource: skill.actualSource,
        validationVersion: 5,
        validationWindowStartedAt,
        attemptedStationCount: attemptedStations.size,
        attemptedStationsJson: JSON.stringify([...attemptedStations].sort()),
        stationFailuresJson: JSON.stringify(stationFailures),
        stationSkillsJson: JSON.stringify(Object.fromEntries([...this.stationSkills].map(([station, stationSkill]) => [station, {
          sampleSize: stationSkill.sampleSize,
          maeC: round(stationSkill.maeC, 3),
          maeUpper95C: round(stationSkill.maeUpper95C, 3),
          biasC: round(stationSkill.biasC, 3),
          withinOneC: round(stationSkill.withinOneC, 4),
          passed: stationSkill.passed,
          actualSource: stationSkill.actualSource
        }]))),
        stationGate: "sample>=12 and 95% MAE upper bound<=3C",
        validationLagDays: this.config.weatherValidationLagDays ?? 2
      } : {
        dataReady: false,
        stations: stationNames,
        stationCount: 0,
        validationVersion: 5,
        validationWindowStartedAt,
        attemptedStationCount: attemptedStations.size,
        attemptedStationsJson: JSON.stringify([...attemptedStations].sort()),
        stationFailuresJson: JSON.stringify(stationFailures),
        stationSkillsJson: "{}"
      },
      reason: skill
        ? `${skill.sampleSize}-forecast out-of-sample skill check: MAE ${skill.maeC.toFixed(2)}C, ${(skill.withinOneC * 100).toFixed(1)}% within 1C.`
        : "Independent forecast and observed-weather history could not be loaded; weather candidates remain watchlist-only.",
      createdAt: now
    };
    this.db.saveStrategyBacktest(result);
    this.validation = result;
    this.events.write({
      type: "weather_strategy.validation_completed",
      agent: "Weather Strategy Agent",
      visibility: "PUBLIC",
      message: `Weather Strategy ${result.passed ? "passed" : "did not pass"} independent forecast-skill validation (${result.sampleSize} samples across ${this.stationSkills.size}/${attemptedStations.size} attempted stations).`,
      payload: result
    });
    return result;
  }

  async createSignals(market: MarketSnapshot, books: OrderBookSnapshot[], now = Date.now()): Promise<TradeSignal[]> {
    if (this.config.weatherStrategyEnabled === false) return [];
    const spec = parseWeatherMarket(market, now);
    if (!spec) return [];
    try {
      const location = await this.locationFor(spec);
      if (!location) return this.recordUnavailable(market, spec, "resolution location unavailable", now);
      const forecast = await this.forecastFor(spec, location);
      if (!forecast || forecast.sampleSize < 20) return this.recordUnavailable(market, spec, "ensemble forecast unavailable or undersampled", now);

      const stationSkill = spec.stationCode ? this.stationSkills.get(spec.stationCode.toUpperCase()) : undefined;
      const calibrationMae = stationSkill?.maeC ?? Number(this.validation?.metrics.maeC ?? 1.5);
      const calibrationBiasC = stationSkill?.biasC ?? Number(this.validation?.metrics.biasC ?? 0);
      const calibrationBias = spec.unit === "F" ? calibrationBiasC * 1.8 : calibrationBiasC;
      const calibratedValues = forecast.values.map((value) => value - calibrationBias);
      const residualSigma = Math.max(spec.unit === "F" ? 1.8 : 1, spec.unit === "F" ? calibrationMae * 1.8 : calibrationMae);
      const fairYes = probabilityForBucket(calibratedValues, spec, residualSigma);
      const standardDeviationC = spec.unit === "F" ? forecast.standardDeviation / 1.8 : forecast.standardDeviation;
      const uncertainty = clamp01(standardDeviationC / 12 + calibrationMae / 18 + (forecast.locationSource === "GEOCODE" ? 0.08 : 0));
      const agreement = clamp01(1 - standardDeviationC / 7);
      const choices = market.outcomes.map((outcome, index) => {
        const tokenId = market.clobTokenIds[index];
        const book = books.find((item) => item.tokenId === tokenId);
        const marketProbability = book?.bestAsk ?? market.outcomePrices[index];
        const fairProbability = String(outcome).toLowerCase() === "no" ? 1 - fairYes : fairYes;
        if (!tokenId || !(marketProbability > 0 && marketProbability < 1)) return undefined;
        const edge = fairProbability - marketProbability;
        const fee = takerFeeUsd(1, marketProbability, market.feesEnabled === false ? 0 : market.takerFeeRate ?? this.config.liveExecutionFeeRatePct ?? 0);
        const expectedValuePct = (edge - fee) / marketProbability;
        return { outcome, tokenId, book, marketProbability, fairProbability, edge, expectedValuePct };
      }).filter((item): item is NonNullable<typeof item> => Boolean(item))
        .sort((a, b) => b.expectedValuePct - a.expectedValuePct);
      const best = choices[0];
      if (!best) return this.recordUnavailable(market, spec, "no executable binary outcome book", now);

      const tournamentSizeUsd = this.config.weatherTournamentPositionSizeUsd ??
        this.config.independentModelFlatPositionSize ?? this.config.minPositionSize;
      const executable = best.book
        ? estimateWeatherExecutableBuy(best.book, tournamentSizeUsd, this.config.maxEntrySlippage ?? 0.02)
        : undefined;
      const executableShares = executable ? tournamentSizeUsd / executable.vwap : 0;
      const executableFee = executable
        ? takerFeeUsd(executableShares, executable.vwap, market.feesEnabled === false ? 0 : market.takerFeeRate ?? this.config.liveExecutionFeeRatePct ?? 0)
        : 0;

      const hours = market.endDate ? (Date.parse(market.endDate) - now) / 3_600_000 : Number.POSITIVE_INFINITY;
      const validationPassed = this.validation?.passed === true && stationSkill?.passed === true;
      const policyGate = evaluateWeatherCandidatePolicy({
        outcome: String(best.outcome),
        marketProbability: best.marketProbability,
        probabilityEdge: best.edge
      }, this.config);
      const policyVersion = this.config.weatherForwardPolicyVersion ?? DEFAULT_WEATHER_POLICY_VERSION;
      const exitPolicy = this.config.weatherExitPolicy ?? "GENERIC_MARK_TO_MARKET";
      const strategyEventKey = weatherStrategyEventKey(spec);
      const passes = validationPassed &&
        forecast.locationSource === "AIRPORT" &&
        policyGate.passed &&
        best.expectedValuePct >= (this.config.weatherMinExpectedValuePct ?? 0.12) &&
        uncertainty <= (this.config.weatherMaxUncertainty ?? 0.35) &&
        hours >= (this.config.weatherMinTimeToResolutionHours ?? 2);
      const reasonParts = [
        `prospective policy ${policyVersion}`,
        `ensemble fair ${(best.fairProbability * 100).toFixed(1)}% vs ask ${(best.marketProbability * 100).toFixed(1)}%`,
        `edge ${(best.edge * 100).toFixed(1)}pp`,
        `net EV ${(best.expectedValuePct * 100).toFixed(1)}%`,
        `${forecast.sampleSize} members`,
        `bias correction ${calibrationBias.toFixed(1)}°${spec.unit}`,
        `uncertainty ${(uncertainty * 100).toFixed(1)}%`,
        validationPassed
          ? `station-specific forecast validation passed (${spec.stationCode}, n=${stationSkill?.sampleSize ?? 0}, MAE upper95 ${stationSkill?.maeUpper95C.toFixed(2) ?? "n/a"}C)`
          : `station-specific forecast validation not passed (${spec.stationCode ?? "unmatched"})`,
        forecast.locationSource === "AIRPORT" ? "resolution station matched" : "no station match; watchlist only",
        ...(policyGate.passed ? ["frozen outcome/price/edge gate passed"] : policyGate.reasons)
      ];
      const confidence = Math.round(Math.max(0, Math.min(100, 70 + best.edge * 120 + agreement * 10 - uncertainty * 12)));
      const signalId = passes
        ? randomId("sig_weather")
        : researchObservationId("sig_weather_watch", market.id, best.tokenId, policyVersion, now);
      const signal: TradeSignal = {
        id: signalId,
        decision: passes ? "TRADE_CANDIDATE" : "WATCHLIST",
        marketId: market.id,
        conditionId: market.conditionId,
        tokenId: best.tokenId,
        outcome: best.outcome,
        side: "BUY",
        confidence,
        limitPrice: best.marketProbability,
        alignedWallets: [],
        reason: `independent weather model: ${reasonParts.join("; ")}`,
        createdAt: now,
        botDetectedTimestamp: now,
        expectedEntryPrice: best.marketProbability,
        expectedExitPrice: best.fairProbability,
        expectedLiveExecutableReturnPct: best.expectedValuePct,
        entryBookDepth: best.book ? askNotional(best.book) : 0,
        maxEntrySlippage: this.config.maxEntrySlippage,
        parityStatus: passes ? "PASS" : "FAIL",
        parityReason: passes ? "frozen prospective forecast, EV, uncertainty, timing, and validation gates passed" : "one or more frozen prospective strategy gates failed",
        signalOrigin: "INDEPENDENT_MODEL",
        strategyId: "weather_ensemble_fair_value_v2",
        strategyHypothesisId: WEATHER_HYPOTHESIS_ID,
        policyVersion,
        strategyEventKey,
        exitPolicy,
        fairProbability: best.fairProbability,
        marketProbability: best.marketProbability,
        probabilityEdge: best.edge,
        expectedValuePct: best.expectedValuePct,
        modelUncertainty: uncertainty,
        modelAgreement: agreement,
        forecastSampleSize: forecast.sampleSize
      };
      this.db.saveSignal(signal);
      const opportunity: WeatherOpportunity = {
        id: passes ? randomId("weatheropp") : researchObservationId("weatheropp_watch", market.id, best.tokenId, policyVersion, now),
        signalId: signal.id,
        marketId: market.id,
        tokenId: best.tokenId,
        outcome: best.outcome,
        spec,
        fairProbability: best.fairProbability,
        marketProbability: best.marketProbability,
        probabilityEdge: best.edge,
        expectedValuePct: best.expectedValuePct,
        uncertainty,
        agreement,
        forecastSampleSize: forecast.sampleSize,
        executableEntryPrice: executable?.vwap,
        marketMidProbability: best.book?.bestBid !== undefined && best.book.bestAsk !== undefined
          ? (best.book.bestBid + best.book.bestAsk) / 2
          : best.marketProbability,
        executableSizeUsd: executable ? tournamentSizeUsd : undefined,
        entryFeeUsd: executableFee,
        stationValidationPassed: validationPassed,
        stationSkillSampleSize: stationSkill?.sampleSize,
        stationSkillMaeUpper95C: stationSkill?.maeUpper95C,
        resolutionTimestamp: market.endDate ? Date.parse(market.endDate) : undefined,
        exitPolicy,
        policyVersion,
        strategyEventKey,
        status: passes ? "CANDIDATE" : "WATCHLIST",
        reason: reasonParts.join("; "),
        createdAt: now
      };
      this.db.saveWeatherOpportunity(opportunity);
      this.cycleOpportunities.push(opportunity);
      this.events.write({
        type: "weather_strategy.opportunity_scored",
        agent: "Weather Strategy Agent",
        visibility: passes ? "PUBLIC" : "PRIVATE",
        message: `${passes ? "Candidate" : "Watchlist"}: ${market.question} (${(best.edge * 100).toFixed(1)}pp model edge).`,
        payload: opportunity
      });
      return [signal];
    } catch (error) {
      this.events.write({
        type: "weather_strategy.scan_failed",
        agent: "Weather Strategy Agent",
        visibility: "PRIVATE",
        message: `Weather Strategy could not score ${market.question}.`,
        payload: { marketId: market.id, error: error instanceof Error ? error.message : String(error) }
      });
      return [];
    }
  }

  private recordUnavailable(market: MarketSnapshot, spec: WeatherMarketSpec, reason: string, now: number): TradeSignal[] {
    const tokenId = market.clobTokenIds[0] ?? "";
    const policyVersion = this.config.weatherForwardPolicyVersion ?? DEFAULT_WEATHER_POLICY_VERSION;
    this.db.saveWeatherOpportunity({
      id: researchObservationId("weatheropp_reject", market.id, tokenId, policyVersion, now), marketId: market.id, tokenId, outcome: market.outcomes[0] ?? "YES", spec,
      fairProbability: 0, marketProbability: 0, probabilityEdge: 0, expectedValuePct: 0, uncertainty: 1,
      agreement: 0, forecastSampleSize: 0, policyVersion, status: "REJECTED", reason, createdAt: now
    });
    return [];
  }

  private locationFor(spec: WeatherMarketSpec): Promise<Location | undefined> {
    const key = spec.stationCode ?? spec.city.toLowerCase();
    if ((this.locationFailureUntil.get(key) ?? 0) > Date.now()) return Promise.resolve(undefined);
    let value = this.locationCache.get(key);
    if (!value) {
      value = resolveLocation(spec);
      this.locationCache.set(key, value);
      void value.catch(() => {
        this.locationCache.delete(key);
        this.locationFailureUntil.set(key, Date.now() + 10 * 60_000);
      });
    }
    return value;
  }

  private forecastFor(spec: WeatherMarketSpec, location: Location): Promise<EnsembleForecast | undefined> {
    const key = `${location.latitude.toFixed(3)}:${location.longitude.toFixed(3)}:${spec.targetDate}:${spec.unit}`;
    if ((this.forecastFailureUntil.get(key) ?? 0) > Date.now()) return Promise.resolve(undefined);
    let value = this.forecastCache.get(key);
    if (!value) {
      value = fetchEnsembleForecast(location, spec.targetDate, spec.unit);
      this.forecastCache.set(key, value);
      void value.catch(() => {
        this.forecastCache.delete(key);
        this.forecastFailureUntil.set(key, Date.now() + 10 * 60_000);
      });
    }
    return value;
  }
}

export function selectWeatherValidationSpecs(specs: WeatherMarketSpec[], limit: number): WeatherMarketSpec[] {
  const byStation = new Map<string, { spec: WeatherMarketSpec; markets: number }>();
  for (const spec of specs) {
    if (!spec.stationCode) continue;
    const station = spec.stationCode.toUpperCase();
    const current = byStation.get(station);
    if (current) current.markets += 1;
    else byStation.set(station, { spec: { ...spec, stationCode: station }, markets: 1 });
  }
  return [...byStation.entries()]
    .sort((a, b) => b[1].markets - a[1].markets || a[0].localeCompare(b[0]))
    .slice(0, Math.max(1, Math.floor(limit)))
    .map(([, item]) => item.spec);
}

export function selectUnattemptedWeatherValidationSpecs(
  specs: WeatherMarketSpec[],
  attemptedStations: ReadonlySet<string>
): WeatherMarketSpec[] {
  return specs.filter((spec) => !spec.stationCode || !attemptedStations.has(spec.stationCode.toUpperCase()));
}

export function parseWeatherMarket(market: MarketSnapshot, now = Date.now()): WeatherMarketSpec | undefined {
  const question = market.question.replaceAll("−", "-");
  const match = question.match(/highest temperature in (.+?) be (.+?) on ([A-Za-z]+\s+\d{1,2})(?:,?\s+(20\d{2}))?\??$/i);
  if (!match) return undefined;
  const city = match[1].trim();
  const expression = match[2].trim();
  const unitMatch = expression.match(/°?\s*([CF])\b/i);
  if (!unitMatch) return undefined;
  const unit = unitMatch[1].toUpperCase() as "C" | "F";
  const values = [...expression.matchAll(/-?\d+(?:\.\d+)?/g)].map((item) => Number(item[0]));
  if (values.length === 0) return undefined;
  let bucket: WeatherMarketSpec["bucket"] = "EXACT";
  let lower: number | undefined = values[0];
  let upper: number | undefined = values[0];
  if (/between|\d\s*-\s*\d/i.test(expression) && values.length >= 2) {
    bucket = "RANGE";
    lower = Math.min(values[0], values[1]);
    upper = Math.max(values[0], values[1]);
  } else if (/or below|or lower|at most|or less/i.test(expression)) {
    bucket = "AT_MOST";
    lower = undefined;
  } else if (/or above|or higher|at least|or more/i.test(expression)) {
    bucket = "AT_LEAST";
    upper = undefined;
  }
  const year = Number(match[4] ?? yearFromSlug(market.slug) ?? yearFromEndDate(market.endDate) ?? new Date(now).getUTCFullYear());
  const parsedDate = Date.parse(`${match[3]} ${year} UTC`);
  if (!Number.isFinite(parsedDate)) return undefined;
  const raw = asRecord(market.raw);
  const events = Array.isArray(raw.events) ? raw.events as Array<Record<string, unknown>> : [];
  const description = String(raw.resolutionSource ?? raw.description ?? events[0]?.resolutionSource ?? events[0]?.description ?? "");
  const stationMatch = description.match(/wunderground\.com\/history\/daily\/(?:[^/\s]+\/)+([A-Z0-9]{4})(?:\/|\b)/i)
    ?? description.match(/\bAirport Station\s+([A-Z0-9]{4})\b/i)
    ?? description.match(/\b([A-Z]{4})\s+Airport Station\b/i);
  return {
    city,
    stationCode: stationMatch?.[1]?.toUpperCase(),
    targetDate: isoDate(parsedDate),
    unit,
    bucket,
    lower: Number.isFinite(lower) ? lower : undefined,
    upper: Number.isFinite(upper) ? upper : undefined
  };
}

export function probabilityForBucket(values: number[], spec: WeatherMarketSpec, residualSigma: number): number {
  if (values.length === 0) return 0;
  const sigma = Math.max(0.25, residualSigma);
  const lower = spec.bucket === "AT_MOST" ? Number.NEGATIVE_INFINITY : (spec.lower ?? Number.NEGATIVE_INFINITY) - 0.5;
  const upper = spec.bucket === "AT_LEAST" ? Number.POSITIVE_INFINITY : (spec.upper ?? Number.POSITIVE_INFINITY) + 0.5;
  return clamp01(average(values.map((value) => normalCdf(upper, value, sigma) - normalCdf(lower, value, sigma))));
}

export function estimateWeatherExecutableBuy(
  book: OrderBookSnapshot,
  positionSizeUsd: number,
  maxAbsoluteSlippage: number
): { vwap: number; shares: number } | undefined {
  if (!(positionSizeUsd > 0)) return undefined;
  const asks = [...book.asks]
    .filter((level) => level.price > 0 && level.price < 1 && level.size > 0)
    .sort((a, b) => a.price - b.price);
  const bestAsk = book.bestAsk ?? asks[0]?.price;
  if (!(bestAsk > 0 && bestAsk < 1)) return undefined;
  const priceLimit = Math.min(1, bestAsk + Math.max(0, maxAbsoluteSlippage));
  let cost = 0;
  let shares = 0;
  for (const ask of asks) {
    if (ask.price > priceLimit) break;
    const remainingCost = positionSizeUsd - cost;
    if (remainingCost <= 1e-9) break;
    const levelCost = ask.price * ask.size;
    const usedCost = Math.min(remainingCost, levelCost);
    cost += usedCost;
    shares += usedCost / ask.price;
  }
  if (cost + 1e-6 < positionSizeUsd || shares <= 0) return undefined;
  return { vwap: cost / shares, shares };
}

export async function backtestForecastSkill(location: Location, days: number, now = Date.now(), lagDays = 2): Promise<ForecastSkill | undefined> {
  const end = new Date(now - Math.max(2, lagDays) * 86_400_000);
  const start = new Date(end.getTime() - Math.max(14, days) * 86_400_000);
  const params = new URLSearchParams({
    latitude: String(location.latitude), longitude: String(location.longitude),
    start_date: isoDate(start.getTime()), end_date: isoDate(end.getTime()), timezone: "auto"
  });
  const previousUrl = `https://previous-runs-api.open-meteo.com/v1/forecast?${params}&hourly=temperature_2m_previous_day1,temperature_2m_previous_day2&models=gfs_seamless`;
  const archiveUrl = `https://archive-api.open-meteo.com/v1/archive?${params}&daily=temperature_2m_max`;
  const actualRequest = location.stationCode
    ? fetchJson<unknown>(`https://aviationweather.gov/api/data/metar?ids=${encodeURIComponent(location.stationCode)}&format=json&hours=${Math.min(720, (Math.max(14, days) + 7) * 24)}`)
    : fetchJson<Record<string, unknown>>(archiveUrl);
  const [previous, actualResponse] = await Promise.all([
    fetchJson<Record<string, unknown>>(previousUrl),
    actualRequest
  ]);
  const hourly = asRecord(previous.hourly);
  const times = stringArray(hourly.time);
  const actualByDate = new Map<string, number>();
  let actualSource: ForecastSkill["actualSource"] = "GRID_ARCHIVE";
  if (location.stationCode) {
    const wrapper = asRecord(actualResponse);
    const rows = (Array.isArray(actualResponse) ? actualResponse : Array.isArray(wrapper.value) ? wrapper.value : []) as Array<Record<string, unknown>>;
    const offsetMs = Number(previous.utc_offset_seconds ?? 0) * 1000;
    for (const row of rows) {
      const timestampMs = Number(row.obsTime) * 1000;
      const temperature = Number(row.temp);
      if (!Number.isFinite(timestampMs) || !Number.isFinite(temperature)) continue;
      const date = isoDate(timestampMs + offsetMs);
      actualByDate.set(date, Math.max(actualByDate.get(date) ?? Number.NEGATIVE_INFINITY, temperature));
    }
    actualSource = "STATION_METAR";
  } else {
    const daily = asRecord(asRecord(actualResponse).daily);
    const actualTimes = stringArray(daily.time);
    const actualValues = numberArray(daily.temperature_2m_max);
    for (let index = 0; index < actualTimes.length; index++) actualByDate.set(actualTimes[index], actualValues[index]);
  }
  const errors: number[] = [];
  for (const variable of ["temperature_2m_previous_day1", "temperature_2m_previous_day2"]) {
    const values = numberArray(hourly[variable]);
    const maxima = new Map<string, number>();
    for (let index = 0; index < Math.min(times.length, values.length); index++) {
      if (!Number.isFinite(values[index])) continue;
      const date = times[index].slice(0, 10);
      maxima.set(date, Math.max(maxima.get(date) ?? Number.NEGATIVE_INFINITY, values[index]));
    }
    for (const [date, forecast] of maxima) {
      const actual = actualByDate.get(date);
      if (Number.isFinite(actual) && Number.isFinite(forecast)) errors.push(forecast - actual!);
    }
  }
  if (errors.length === 0) return undefined;
  return summarizeForecastErrors(errors, actualSource);
}

export function summarizeForecastErrors(errors: number[], actualSource: ForecastSkill["actualSource"] = "STATION_METAR"): ForecastSkill {
  const finite = errors.filter(Number.isFinite);
  const absolute = finite.map(Math.abs);
  const maeC = absolute.length > 0 ? average(absolute) : Number.POSITIVE_INFINITY;
  const variance = absolute.length > 1
    ? absolute.reduce((sum, error) => sum + (error - maeC) ** 2, 0) / (absolute.length - 1)
    : Number.POSITIVE_INFINITY;
  const standardError = Number.isFinite(variance) ? Math.sqrt(variance / absolute.length) : Number.POSITIVE_INFINITY;
  const maeUpper95C = maeC + 1.96 * standardError;
  const withinOneC = finite.length > 0 ? finite.filter((error) => Math.abs(error) <= 1).length / finite.length : 0;
  return {
    sampleSize: finite.length,
    maeC,
    maeUpper95C,
    biasC: finite.length > 0 ? average(finite) : 0,
    withinOneC,
    passed: finite.length >= 12 && maeUpper95C <= 3,
    actualSource
  };
}

function combineForecastSkills(skills: ForecastSkill[]): ForecastSkill | undefined {
  const usable = skills.filter((skill) => skill.sampleSize > 0 && skill.actualSource === "STATION_METAR");
  const sampleSize = usable.reduce((sum, skill) => sum + skill.sampleSize, 0);
  if (sampleSize === 0) return undefined;
  const weighted = (selector: (skill: ForecastSkill) => number) =>
    usable.reduce((sum, skill) => sum + selector(skill) * skill.sampleSize, 0) / sampleSize;
  const maeC = weighted((skill) => skill.maeC);
  const maeUpper95C = weighted((skill) => skill.maeUpper95C);
  return {
    sampleSize,
    maeC,
    maeUpper95C,
    biasC: weighted((skill) => skill.biasC),
    withinOneC: weighted((skill) => skill.withinOneC),
    passed: sampleSize >= 40 && maeUpper95C <= 3,
    actualSource: "STATION_METAR"
  };
}

function parseStationSkills(raw: number | string | boolean | null | undefined): Map<string, ForecastSkill> {
  if (typeof raw !== "string" || raw.length === 0) return new Map();
  try {
    const parsed = JSON.parse(raw) as Record<string, Partial<ForecastSkill>>;
    return new Map(Object.entries(parsed).flatMap(([station, skill]) => {
      const sampleSize = Number(skill.sampleSize);
      const maeC = Number(skill.maeC);
      const maeUpper95C = Number(skill.maeUpper95C);
      const biasC = Number(skill.biasC);
      const withinOneC = Number(skill.withinOneC);
      if (![sampleSize, maeC, maeUpper95C, biasC, withinOneC].every(Number.isFinite)) return [];
      return [[station.toUpperCase(), {
        sampleSize,
        maeC,
        maeUpper95C,
        biasC,
        withinOneC,
        passed: skill.passed === true,
        actualSource: skill.actualSource === "STATION_METAR" ? "STATION_METAR" : "GRID_ARCHIVE"
      } satisfies ForecastSkill] as const];
    }));
  } catch {
    return new Map();
  }
}

function parseAttemptedStations(
  raw: number | string | boolean | null | undefined,
  fallbackStations: Iterable<string>
): Set<string> {
  if (typeof raw === "string" && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return new Set(parsed.map(String).map((station) => station.toUpperCase()));
      }
    } catch {
      // Older validation rows do not have attempted-station metadata.
    }
  }
  return new Set([...fallbackStations].map((station) => station.toUpperCase()));
}

function parseStationFailures(raw: number | string | boolean | null | undefined): StationValidationFailure[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const station = String((item as Record<string, unknown>).station ?? "");
      const error = String((item as Record<string, unknown>).error ?? "");
      return station ? [{ station, error }] : [];
    });
  } catch {
    return [];
  }
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(items.length, Math.max(1, Math.floor(concurrency))) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function resolveLocation(spec: WeatherMarketSpec): Promise<Location | undefined> {
  if (spec.stationCode) {
    const result = await fetchJson<unknown>(`https://aviationweather.gov/api/data/airport?ids=${encodeURIComponent(spec.stationCode)}&format=json`);
    const wrapper = asRecord(result);
    const rows = (Array.isArray(result) ? result : Array.isArray(wrapper.value) ? wrapper.value : []) as Array<Record<string, unknown>>;
    const first = rows[0];
    const latitude = Number(first?.lat ?? first?.latitude);
    const longitude = Number(first?.lon ?? first?.longitude);
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) return { latitude, longitude, source: "AIRPORT", stationCode: spec.stationCode };
  }
  const result = await fetchJson<{ results?: Array<Record<string, unknown>> }>(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(spec.city)}&count=1&language=en&format=json`);
  const first = result.results?.[0];
  const latitude = Number(first?.latitude);
  const longitude = Number(first?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;
  return { latitude, longitude, timezone: typeof first?.timezone === "string" ? first.timezone : undefined, source: "GEOCODE" };
}

async function fetchEnsembleForecast(location: Location, date: string, unit: "C" | "F"): Promise<EnsembleForecast | undefined> {
  const params = new URLSearchParams({
    latitude: String(location.latitude), longitude: String(location.longitude),
    daily: "temperature_2m_max", models: "gfs_seamless,icon_seamless,ecmwf_ifs025",
    timezone: location.timezone ?? "auto", start_date: date, end_date: date,
    temperature_unit: unit === "F" ? "fahrenheit" : "celsius"
  });
  const response = await fetchJson<Record<string, unknown>>(`https://ensemble-api.open-meteo.com/v1/ensemble?${params}`);
  const daily = asRecord(response.daily);
  const dates = stringArray(daily.time);
  const dateIndex = dates.indexOf(date);
  if (dateIndex < 0) return undefined;
  const values = Object.entries(daily)
    .filter(([key]) => key.startsWith("temperature_2m_max"))
    .map(([, raw]) => numberArray(raw)[dateIndex])
    .filter((value) => Number.isFinite(value));
  if (values.length === 0) return undefined;
  const mean = average(values);
  return { values, mean, standardDeviation: Math.sqrt(average(values.map((value) => (value - mean) ** 2))), sampleSize: values.length, locationSource: location.source };
}

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: "application/json", "user-agent": "StratiFi-weather-research/1.0" } });
    if (!response.ok) throw new Error(`HTTP ${response.status} for weather data`);
    return await response.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

function normalCdf(x: number, mean: number, sigma: number): number {
  if (x === Number.POSITIVE_INFINITY) return 1;
  if (x === Number.NEGATIVE_INFINITY) return 0;
  const z = (x - mean) / (sigma * Math.sqrt(2));
  const sign = z < 0 ? -1 : 1;
  const abs = Math.abs(z);
  const t = 1 / (1 + 0.3275911 * abs);
  const erf = sign * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-abs * abs));
  return 0.5 * (1 + erf);
}

function yearFromSlug(slug?: string): string | undefined {
  return slug?.match(/-(20\d{2})(?:-|$)/)?.[1];
}

function yearFromEndDate(endDate?: string): string | undefined {
  const year = endDate ? new Date(endDate).getUTCFullYear() : NaN;
  return Number.isFinite(year) ? String(year) : undefined;
}

function isoDate(value: number | Date): string {
  return new Date(value).toISOString().slice(0, 10);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.map(Number) : [];
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function askNotional(book: OrderBookSnapshot): number {
  return book.asks.reduce((sum, level) => sum + Math.max(0, level.price) * Math.max(0, level.size), 0);
}
