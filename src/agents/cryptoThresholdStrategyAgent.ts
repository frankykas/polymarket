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
  StrategyOpportunity,
  TradeSignal
} from "../types.js";

export interface CryptoThresholdSpec {
  asset: "Bitcoin" | "Ethereum";
  symbol: "BTCUSDT" | "ETHUSDT";
  threshold: number;
  targetTimestamp: number;
}

interface HourlyClose {
  timestamp: number;
  close: number;
}

const CRYPTO_HYPOTHESIS_ID = "hypothesis_crypto_threshold";
export const CRYPTO_THRESHOLD_STRATEGY_ID = "crypto_close_threshold_empirical_v1";

export class CryptoThresholdStrategyAgent {
  private historyCache = new Map<string, Promise<HourlyClose[]>>();
  private historyFailureUntil = new Map<string, number>();
  private validation?: StrategyBacktestResult;

  constructor(private db: BotDatabase, private events: AgentEventWriter, private config: BotConfig) {}

  async ensureValidation(markets: MarketSnapshot[], hypothesis?: StrategyHypothesis, now = Date.now()): Promise<StrategyBacktestResult | undefined> {
    if (this.config.cryptoThresholdStrategyEnabled === false) return undefined;
    const cached = this.db.getLatestStrategyBacktests().find((item) =>
      item.cluster === "CRYPTO_THRESHOLD" && item.testKind === "WALK_FORWARD_PROBABILITY" && item.metrics.validationVersion === 2
    );
    const interval = this.config.cryptoThresholdBacktestIntervalMs ?? 24 * 60 * 60_000;
    if (cached && cached.createdAt >= now - interval) {
      this.validation = cached;
      if (hypothesis) this.db.saveStrategyHypothesis({
        ...hypothesis,
        status: cached.passed ? "PAPER_ELIGIBLE" : "VALIDATING",
        updatedAt: Math.max(hypothesis.updatedAt, cached.createdAt)
      });
      return cached;
    }
    const symbols = [...new Set(markets.map((market) => parseCryptoThresholdMarket(market, now)?.symbol).filter(Boolean))] as CryptoThresholdSpec["symbol"][];
    const tested = await Promise.all((symbols.length > 0 ? symbols : ["BTCUSDT", "ETHUSDT"] as const).map(async (symbol) => {
      const history = await this.historyFor(symbol, now);
      return walkForwardCryptoCalibration(history);
    }));
    const usable = tested.filter((item): item is NonNullable<typeof item> => Boolean(item));
    const sampleSize = usable.reduce((sum, item) => sum + item.sampleSize, 0);
    const weighted = (field: "modelBrier" | "benchmarkBrier" | "accuracy") =>
      sampleSize > 0 ? usable.reduce((sum, item) => sum + item[field] * item.sampleSize, 0) / sampleSize : 0;
    const modelBrier = weighted("modelBrier");
    const benchmarkBrier = weighted("benchmarkBrier");
    const requiredBrierImprovement = 0.005;
    const passed = sampleSize >= 150 && modelBrier <= 0.21 && modelBrier + requiredBrierImprovement <= benchmarkBrier;
    const result: StrategyBacktestResult = {
      id: randomId("backtest_crypto"),
      hypothesisId: hypothesis?.id ?? CRYPTO_HYPOTHESIS_ID,
      cluster: "CRYPTO_THRESHOLD",
      testKind: "WALK_FORWARD_PROBABILITY",
      independentFromLeadWallets: true,
      sampleSize,
      passed,
      metrics: {
        modelBrier: round(modelBrier, 5),
        benchmarkBrier: round(benchmarkBrier, 5),
        accuracy: round(weighted("accuracy"), 4),
        symbols: symbols.join(",") || "BTCUSDT,ETHUSDT",
        horizonHours: 24,
        trainingHours: 1_440,
        independentOrigins: Math.floor(sampleSize / 5),
        brierImprovement: round(benchmarkBrier - modelBrier, 5),
        requiredBrierImprovement,
        source: "BINANCE_SPOT_HOURLY_KLINES",
        validationVersion: 2
      },
      reason: sampleSize > 0
        ? `${Math.floor(sampleSize / 5)} rolling origins / ${sampleSize} threshold contracts: model Brier ${modelBrier.toFixed(4)} vs volatility benchmark ${benchmarkBrier.toFixed(4)}; requires at least ${requiredBrierImprovement.toFixed(3)} improvement.`
        : "Binance history was unavailable; crypto thresholds remain watchlist-only.",
      createdAt: now
    };
    this.db.saveStrategyBacktest(result);
    if (hypothesis) this.db.saveStrategyHypothesis({
      ...hypothesis,
      status: passed ? "PAPER_ELIGIBLE" : "VALIDATING",
      updatedAt: Math.max(hypothesis.updatedAt, now)
    });
    this.validation = result;
    this.events.write({
      type: "crypto_strategy.validation_completed",
      agent: "Strategy Research Agent",
      visibility: "PUBLIC",
      message: `Crypto threshold strategy ${passed ? "passed" : "did not pass"} rolling walk-forward validation (${sampleSize} events).`,
      payload: result
    });
    return result;
  }

  async createSignals(market: MarketSnapshot, books: OrderBookSnapshot[], now = Date.now()): Promise<TradeSignal[]> {
    if (this.config.cryptoThresholdStrategyEnabled === false) return [];
    const spec = parseCryptoThresholdMarket(market, now);
    if (!spec) return [];
    try {
      const history = await this.historyFor(spec.symbol, now);
      const hours = (spec.targetTimestamp - now) / 3_600_000;
      const horizon = Math.max(2, Math.ceil(hours));
      const distribution = empiricalHorizonReturns(history, horizon, 2_160);
      const currentPrice = history.at(-1)?.close;
      if (!(currentPrice && distribution.length >= 40)) return [];
      const targetReturn = Math.log(spec.threshold / currentPrice);
      const fairYes = smoothedTailProbability(distribution, targetReturn);
      const recentVol = standardDeviation(hourlyLogReturns(history.slice(-24 * 8)));
      const priorVol = standardDeviation(hourlyLogReturns(history.slice(-24 * 38, -24 * 8)));
      const regimeDrift = priorVol > 0 ? Math.min(1, Math.abs(recentVol / priorVol - 1)) : 1;
      const samplingError = Math.sqrt(Math.max(0.0001, fairYes * (1 - fairYes)) / distribution.length) * 2;
      const uncertainty = clamp01(samplingError + regimeDrift * 0.35);
      const agreement = clamp01(1 - regimeDrift);
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
      const policy = evaluateCryptoThresholdPolicy({ marketProbability: best.marketProbability, probabilityEdge: best.edge, hours }, this.config);
      const validationPassed = this.validation?.passed === true;
      const passes = validationPassed && policy.passed && best.expectedValuePct >= 0.1 && uncertainty <= 0.4;
      const policyVersion = this.config.cryptoThresholdForwardPolicyVersion ?? "crypto-unfrozen";
      const eventKey = `crypto:${spec.symbol}:${spec.targetTimestamp}`;
      const reasons = [
        `prospective policy ${policyVersion}`,
        `${spec.symbol} spot ${currentPrice.toFixed(2)} vs ${spec.threshold.toFixed(2)} close threshold`,
        `empirical fair ${(best.fairProbability * 100).toFixed(1)}% vs ask ${(best.marketProbability * 100).toFixed(1)}%`,
        `edge ${(best.edge * 100).toFixed(1)}pp`,
        `net EV ${(best.expectedValuePct * 100).toFixed(1)}%`,
        `${distribution.length} trailing horizon returns`,
        `regime uncertainty ${(uncertainty * 100).toFixed(1)}%`,
        validationPassed ? "rolling walk-forward validation passed" : "rolling walk-forward validation not passed",
        ...(policy.passed ? ["frozen price/edge/timing gate passed"] : policy.reasons)
      ];
      const signalId = passes
        ? randomId("sig_crypto")
        : researchObservationId("sig_crypto_watch", market.id, best.tokenId, policyVersion, now);
      const signal: TradeSignal = {
        id: signalId,
        decision: passes ? "TRADE_CANDIDATE" : "WATCHLIST",
        marketId: market.id,
        conditionId: market.conditionId,
        tokenId: best.tokenId,
        outcome: best.outcome,
        side: "BUY",
        confidence: Math.round(clamp01(0.6 + best.edge * 0.8 + agreement * 0.15 - uncertainty * 0.2) * 100),
        limitPrice: best.marketProbability,
        alignedWallets: [],
        reason: `independent crypto threshold model: ${reasons.join("; ")}`,
        createdAt: now,
        botDetectedTimestamp: now,
        expectedEntryPrice: best.marketProbability,
        expectedExitPrice: best.fairProbability,
        expectedLiveExecutableReturnPct: best.expectedValuePct,
        entryBookDepth: best.book ? askNotional(best.book) : 0,
        maxEntrySlippage: this.config.maxEntrySlippage,
        parityStatus: passes ? "PASS" : "FAIL",
        parityReason: passes ? "frozen crypto policy and independent walk-forward gate passed" : "crypto policy or validation gate failed",
        signalOrigin: "INDEPENDENT_MODEL",
        strategyId: CRYPTO_THRESHOLD_STRATEGY_ID,
        strategyHypothesisId: CRYPTO_HYPOTHESIS_ID,
        policyVersion,
        strategyEventKey: eventKey,
        fairProbability: best.fairProbability,
        marketProbability: best.marketProbability,
        probabilityEdge: best.edge,
        expectedValuePct: best.expectedValuePct,
        modelUncertainty: uncertainty,
        modelAgreement: agreement,
        forecastSampleSize: distribution.length,
        resolutionTimestamp: spec.targetTimestamp
      };
      this.db.saveSignal(signal);
      const opportunity: StrategyOpportunity = {
        id: passes ? randomId("cryptoopp") : researchObservationId("cryptoopp_watch", market.id, best.tokenId, policyVersion, now),
        signalId: signal.id, strategyId: CRYPTO_THRESHOLD_STRATEGY_ID, cluster: "CRYPTO_THRESHOLD",
        marketId: market.id, tokenId: best.tokenId, outcome: best.outcome,
        spec: { asset: spec.asset, symbol: spec.symbol, threshold: spec.threshold, targetTimestamp: spec.targetTimestamp },
        fairProbability: best.fairProbability, marketProbability: best.marketProbability, probabilityEdge: best.edge,
        expectedValuePct: best.expectedValuePct, uncertainty, agreement, modelSampleSize: distribution.length,
        policyVersion, strategyEventKey: eventKey, status: passes ? "CANDIDATE" : "WATCHLIST",
        reason: reasons.join("; "), createdAt: now
      };
      this.db.saveStrategyOpportunity(opportunity);
      this.events.write({
        type: "crypto_strategy.opportunity_scored",
        agent: "Signal Agent",
        visibility: passes ? "PUBLIC" : "PRIVATE",
        message: `${passes ? "Candidate" : "Watchlist"}: ${market.question} (${(best.edge * 100).toFixed(1)}pp independent edge).`,
        payload: opportunity
      });
      return [signal];
    } catch (error) {
      this.events.write({
        type: "crypto_strategy.scan_failed", agent: "Signal Agent", visibility: "PRIVATE",
        message: `Crypto threshold strategy could not score ${market.question}.`,
        payload: { marketId: market.id, error: error instanceof Error ? error.message : String(error) }
      });
      return [];
    }
  }

  private historyFor(symbol: string, now: number): Promise<HourlyClose[]> {
    const key = `${symbol}:${new Date(now).toISOString().slice(0, 10)}`;
    if ((this.historyFailureUntil.get(key) ?? 0) > Date.now()) return Promise.resolve([]);
    let value = this.historyCache.get(key);
    if (!value) {
      value = fetchBinanceHourlyHistory(symbol, now - 150 * 24 * 60 * 60_000, now);
      this.historyCache.set(key, value);
      void value.catch(() => {
        this.historyCache.delete(key);
        this.historyFailureUntil.set(key, Date.now() + 10 * 60_000);
      });
    }
    return value;
  }
}

export function parseCryptoThresholdMarket(market: MarketSnapshot, now = Date.now()): CryptoThresholdSpec | undefined {
  const question = market.question.replaceAll(",", "");
  const match = question.match(/^Will the price of (Bitcoin|Ethereum) be above \$([\d.]+) on ([A-Za-z]+\s+\d{1,2})(?:\s+(20\d{2}))?\?$/i);
  if (!match || !market.endDate) return undefined;
  const targetTimestamp = Date.parse(market.endDate);
  if (!Number.isFinite(targetTimestamp) || targetTimestamp <= now) return undefined;
  const asset = titleCase(match[1]) as CryptoThresholdSpec["asset"];
  const threshold = Number(match[2]);
  if (!(threshold > 0)) return undefined;
  const raw = market.raw && typeof market.raw === "object" && !Array.isArray(market.raw) ? market.raw as Record<string, unknown> : {};
  const description = String(raw.description ?? "").toLowerCase();
  if (!description.includes("binance 1 minute candle") || !description.includes("final \"close\" price")) return undefined;
  return { asset, symbol: asset === "Bitcoin" ? "BTCUSDT" : "ETHUSDT", threshold, targetTimestamp };
}

export function evaluateCryptoThresholdPolicy(input: { marketProbability: number; probabilityEdge: number; hours: number }, config: BotConfig): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const minPrice = config.cryptoThresholdMinEntryPrice ?? 0.2;
  const maxPrice = config.cryptoThresholdMaxEntryPrice ?? 0.8;
  const minEdge = config.cryptoThresholdMinProbabilityEdge ?? 0.08;
  const maxEdge = config.cryptoThresholdMaxProbabilityEdge ?? 0.3;
  const minHours = config.cryptoThresholdMinTimeToResolutionHours ?? 2;
  const maxHours = config.cryptoThresholdMaxTimeToResolutionHours ?? 36;
  if (input.marketProbability < minPrice || input.marketProbability > maxPrice) reasons.push("entry price outside frozen band");
  if (input.probabilityEdge < minEdge || input.probabilityEdge > maxEdge) reasons.push("model edge outside frozen band");
  if (input.hours < minHours || input.hours > maxHours) reasons.push("resolution horizon outside frozen band");
  return { passed: reasons.length === 0, reasons };
}

export function walkForwardCryptoCalibration(history: HourlyClose[]): { sampleSize: number; modelBrier: number; benchmarkBrier: number; accuracy: number } | undefined {
  const horizon = 24;
  const training = 1_440;
  if (history.length < training + horizon * 5) return undefined;
  let sampleSize = 0;
  let modelBrier = 0;
  let benchmarkBrier = 0;
  let correct = 0;
  for (let origin = training; origin + horizon < history.length; origin += 24) {
    const train = empiricalHorizonReturns(history.slice(origin - training, origin + 1), horizon);
    if (train.length < 40) continue;
    const sigma = standardDeviation(train);
    const actualReturn = Math.log(history[origin + horizon].close / history[origin].close);
    for (const z of [-1, -0.5, 0, 0.5, 1]) {
      const threshold = z * sigma;
      const probability = smoothedTailProbability(train, threshold);
      const benchmark = 1 - normalCdf(z);
      const actual = actualReturn > threshold ? 1 : 0;
      modelBrier += (probability - actual) ** 2;
      benchmarkBrier += (benchmark - actual) ** 2;
      correct += (probability >= 0.5 ? 1 : 0) === actual ? 1 : 0;
      sampleSize += 1;
    }
  }
  return sampleSize > 0 ? { sampleSize, modelBrier: modelBrier / sampleSize, benchmarkBrier: benchmarkBrier / sampleSize, accuracy: correct / sampleSize } : undefined;
}

async function fetchBinanceHourlyHistory(symbol: string, startTime: number, endTime: number): Promise<HourlyClose[]> {
  const rows: HourlyClose[] = [];
  let cursor = startTime;
  while (cursor < endTime && rows.length < 4_000) {
    const params = new URLSearchParams({ symbol, interval: "1h", startTime: String(Math.floor(cursor)), endTime: String(Math.floor(endTime)), limit: "1000" });
    const response = await fetchWithTimeout(`https://data-api.binance.vision/api/v3/klines?${params}`);
    const page = await response.json() as unknown[][];
    if (!Array.isArray(page) || page.length === 0) break;
    for (const row of page) {
      const timestamp = Number(row[0]);
      const close = Number(row[4]);
      if (Number.isFinite(timestamp) && close > 0) rows.push({ timestamp, close });
    }
    const next = Number(page.at(-1)?.[0]) + 3_600_000;
    if (!(next > cursor)) break;
    cursor = next;
  }
  return [...new Map(rows.map((row) => [row.timestamp, row])).values()].sort((a, b) => a.timestamp - b.timestamp);
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: "application/json", "user-agent": "StratiFi-crypto-research/1.0" } });
    if (!response.ok) throw new Error(`HTTP ${response.status} for Binance data`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

function empiricalHorizonReturns(history: HourlyClose[], horizon: number, maxHours = Number.POSITIVE_INFINITY): number[] {
  const from = Math.max(0, history.length - Math.floor(maxHours));
  const returns: number[] = [];
  for (let index = from; index + horizon < history.length; index += Math.max(1, Math.floor(horizon / 4))) {
    returns.push(Math.log(history[index + horizon].close / history[index].close));
  }
  return returns.filter(Number.isFinite);
}

function hourlyLogReturns(history: HourlyClose[]): number[] {
  return history.slice(1).map((row, index) => Math.log(row.close / history[index].close)).filter(Number.isFinite);
}

function smoothedTailProbability(values: number[], threshold: number): number {
  return (values.filter((value) => value > threshold).length + 1) / (values.length + 2);
}

function normalCdf(value: number): number {
  const z = value / Math.sqrt(2);
  const sign = z < 0 ? -1 : 1;
  const abs = Math.abs(z);
  const t = 1 / (1 + 0.3275911 * abs);
  const erf = sign * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-abs * abs));
  return 0.5 * (1 + erf);
}

function standardDeviation(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

function askNotional(book: OrderBookSnapshot): number {
  return book.asks.reduce((sum, level) => sum + Math.max(0, level.price) * Math.max(0, level.size), 0);
}

function clamp01(value: number): number { return Math.max(0, Math.min(1, value)); }
function round(value: number, digits: number): number { const factor = 10 ** digits; return Math.round(value * factor) / factor; }
function titleCase(value: string): string { return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase(); }
