import { createReadStream, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { loadBotConfig, loadRuntimeEnv } from "../config.js";
import { takerFeeUsd } from "../liveExecution.js";
import { applyPriceLevelDelta } from "../orderBookDelta.js";
import type { CryptoReferenceTick, PriceLevel } from "../types.js";
import type { MarketTapeRecord } from "./marketTape.js";

interface Arm {
  thresholdBps: number;
  moveWindowMs?: number;
  entryLatencyMs?: number;
  holdMs: number;
  sizeUsd: number;
  minEntryPrice?: number;
  maxEntryPrice?: number;
}

interface TapeMarket {
  marketId: string;
  question: string;
  endDate?: string;
  tokenIds: string[];
  outcomes: string[];
  feesEnabled?: boolean;
  takerFeeRate?: number;
}

interface TapeBook {
  tokenId: string;
  bestBid?: number;
  bestAsk?: number;
  bids: PriceLevel[];
  asks: PriceLevel[];
  timestamp: number;
}

interface ActiveTrade {
  arm: Arm;
  marketId: string;
  tokenId: string;
  signaledAt: number;
  entryNotBefore: number;
  entryDeadline: number;
  shares?: number;
  entryPrice?: number;
  entryFee?: number;
  capitalUsd?: number;
  enteredAt?: number;
  exitsAt?: number;
}

interface ReplayResult {
  arm: Arm;
  marketId: string;
  enteredAt: number;
  pnlUsd: number;
  capitalUsd: number;
  exitMiss: boolean;
}

interface ArmSummary extends Arm {
  outcomes: number;
  distinctMarkets: number;
  exitMisses: number;
  pnlUsd: number;
  capitalUsd: number;
  returnPct: number;
  winRate: number;
}

interface ReplayDiagnostics {
  referenceTicks: number;
  thresholdSignals: number;
  eligibleMarkets: number;
  rejectedPrice: number;
  rejectedSpread: number;
  rejectedBookAge: number;
  rejectedDepth: number;
  entryTimeouts: number;
}

export class CrossMarketSensitivityReplay {
  private markets = new Map<string, TapeMarket>();
  private tokenToMarket = new Map<string, TapeMarket>();
  private books = new Map<string, TapeBook>();
  private referenceHistory = new Map<CryptoReferenceTick["symbol"], CryptoReferenceTick[]>();
  private active = new Map<string, ActiveTrade>();
  private cooldowns = new Map<string, number>();
  private results: ReplayResult[] = [];
  private diagnostics: ReplayDiagnostics = {
    referenceTicks: 0,
    thresholdSignals: 0,
    eligibleMarkets: 0,
    rejectedPrice: 0,
    rejectedSpread: 0,
    rejectedBookAge: 0,
    rejectedDepth: 0,
    entryTimeouts: 0
  };
  private firstTimestamp?: number;
  private lastTimestamp?: number;

  constructor(
    private arms: Arm[],
    private fallbackFeeRate: number,
    private gates: {
      entryTimeoutMs?: number;
      minEntryPrice?: number;
      maxEntryPrice?: number;
      maxSpread?: number;
      minDepthMultiple?: number;
      maxBookAgeMs?: number;
    } = {}
  ) {}

  process(record: MarketTapeRecord): void {
    this.firstTimestamp = Math.min(this.firstTimestamp ?? record.receivedAt, record.receivedAt);
    this.lastTimestamp = Math.max(this.lastTimestamp ?? record.receivedAt, record.receivedAt);
    if (record.recordType === "MARKET_METADATA") {
      const market: TapeMarket = {
        marketId: record.marketId,
        question: record.question,
        endDate: record.endDate,
        tokenIds: record.tokenIds,
        outcomes: record.outcomes,
        feesEnabled: record.feesEnabled,
        takerFeeRate: record.takerFeeRate
      };
      this.markets.set(market.marketId, market);
      for (const tokenId of market.tokenIds) this.tokenToMarket.set(tokenId, market);
      this.settle(record.receivedAt);
      return;
    }
    if (record.recordType === "MARKET_STREAM") {
      const previous = this.books.get(record.tokenId);
      const bidChanged = record.bestBid !== undefined && record.bestBid !== previous?.bestBid;
      const askChanged = record.bestAsk !== undefined && record.bestAsk !== previous?.bestAsk;
      const topOnly = record.bids === undefined && record.asks === undefined && !record.bookDelta && (bidChanged || askChanged);
      this.books.set(record.tokenId, {
        tokenId: record.tokenId,
        bestBid: record.bestBid ?? previous?.bestBid,
        bestAsk: record.bestAsk ?? previous?.bestAsk,
        bids: record.bids
          ?? (record.bookDelta?.side === "BUY"
            ? applyPriceLevelDelta(previous?.bids ?? [], record.bookDelta)
            : topOnly && bidChanged ? [] : previous?.bids ?? []),
        asks: record.asks
          ?? (record.bookDelta?.side === "SELL"
            ? applyPriceLevelDelta(previous?.asks ?? [], record.bookDelta)
            : topOnly && askChanged ? [] : previous?.asks ?? []),
        timestamp: record.receivedAt
      });
      this.maybeEnter(record.tokenId, record.receivedAt);
      this.settle(record.receivedAt);
      return;
    }
    this.onReference({
      symbol: record.symbol,
      bid: record.bid,
      ask: record.ask,
      price: record.price,
      exchangeTimestamp: record.exchangeTimestamp,
      receivedAt: record.receivedAt
    });
    this.settle(record.receivedAt);
  }

  report(): {
    firstTimestamp?: number;
    lastTimestamp?: number;
    splitAt?: number;
    recordsWithOutcomes: number;
    training: ArmSummary[];
    selectedArm?: ArmSummary;
    untouchedTest?: ArmSummary;
    diagnostics: ReplayDiagnostics;
    verdict: string;
  } {
    if (this.firstTimestamp === undefined || this.lastTimestamp === undefined) {
      return { recordsWithOutcomes: 0, training: [], diagnostics: this.diagnostics, verdict: "No readable tape records." };
    }
    // Split on the time span of executable outcomes, not the entire tape. Older
    // tape schemas can contain readable records that were never eligible for
    // this replay (for example, metadata captured before endDate was stored).
    // Letting those rows define the boundary would permanently place every
    // compatible outcome in the "test" partition and leave training empty.
    const enteredTimes = this.results.map((result) => result.enteredAt);
    const firstOutcomeAt = enteredTimes.length > 0 ? Math.min(...enteredTimes) : this.firstTimestamp;
    const lastOutcomeAt = enteredTimes.length > 0 ? Math.max(...enteredTimes) : this.lastTimestamp;
    const splitAt = firstOutcomeAt === lastOutcomeAt
      ? lastOutcomeAt + 1
      : firstOutcomeAt + (lastOutcomeAt - firstOutcomeAt) * 0.7;
    const training = summarize(this.results.filter((result) => result.enteredAt < splitAt), this.arms)
      .sort((a, b) => b.returnPct - a.returnPct || b.pnlUsd - a.pnlUsd);
    const selectedArm = training.find((row) => row.outcomes >= 10 && row.returnPct > 0);
    const untouchedTest = selectedArm
      ? summarize(
          this.results.filter((result) => result.enteredAt >= splitAt && armKey(result.arm) === armKey(selectedArm)),
          [selectedArm]
        )[0]
      : undefined;
    const verdict = !selectedArm
      ? "No training arm has at least 10 positive-return economic outcomes; do not freeze a forward policy."
      : !untouchedTest || untouchedTest.outcomes < 10
        ? "A training arm exists, but the untouched partition is undersampled; do not promote."
        : untouchedTest.returnPct <= 0
          ? "The training-selected arm failed on the untouched partition; reject it."
          : "The arm survived this sensitivity holdout only; freeze a new policy and collect a separate prospective sample before paper promotion.";
    return {
      firstTimestamp: this.firstTimestamp,
      lastTimestamp: this.lastTimestamp,
      splitAt,
      recordsWithOutcomes: this.results.length,
      training,
      selectedArm,
      untouchedTest,
      diagnostics: this.diagnostics,
      verdict
    };
  }

  private onReference(tick: CryptoReferenceTick): void {
    this.diagnostics.referenceTicks += 1;
    const history = this.referenceHistory.get(tick.symbol) ?? [];
    history.push(tick);
    while (history.length > 0 && history[0].receivedAt < tick.receivedAt - 10_000) history.shift();
    this.referenceHistory.set(tick.symbol, history);
    for (const arm of this.arms) {
      const moveWindowMs = arm.moveWindowMs ?? 2_000;
      const baseline = [...history].reverse().find((item) => item.receivedAt <= tick.receivedAt - moveWindowMs);
      if (!baseline) continue;
      const moveBps = ((tick.price / baseline.price) - 1) * 10_000;
      if (Math.abs(moveBps) < arm.thresholdBps) continue;
      this.diagnostics.thresholdSignals += 1;
      for (const market of this.markets.values()) {
        const direction = cryptoDirection(market.question);
        if (!direction || direction.symbol !== tick.symbol || !shortHorizon(market, tick.receivedAt)) continue;
        const predictedYes = Math.sign(moveBps) === direction.yesDirection;
        const desiredOutcome = market.outcomes.some((outcome) => /^(up|down)$/i.test(outcome))
          ? (moveBps > 0 ? "UP" : "DOWN")
          : (predictedYes ? "YES" : "NO");
        const outcomeIndex = market.outcomes.findIndex((outcome) => outcome.toUpperCase() === desiredOutcome);
        const tokenId = market.tokenIds[outcomeIndex];
        const book = tokenId ? this.books.get(tokenId) : undefined;
        if (!book?.bestAsk || book.bestBid === undefined) continue;
        if (book.bestAsk < (arm.minEntryPrice ?? this.gates.minEntryPrice ?? 0.1) || book.bestAsk > (arm.maxEntryPrice ?? this.gates.maxEntryPrice ?? 0.9)) {
          this.diagnostics.rejectedPrice += 1;
          continue;
        }
        if (book.bestAsk - book.bestBid > (this.gates.maxSpread ?? 0.03)) {
          this.diagnostics.rejectedSpread += 1;
          continue;
        }
        if (tick.receivedAt - book.timestamp < 0 || tick.receivedAt - book.timestamp > (this.gates.maxBookAgeMs ?? 2_000)) {
          this.diagnostics.rejectedBookAge += 1;
          continue;
        }
        const requestedShares = arm.sizeUsd / book.bestAsk;
        if (topSize(book.asks, book.bestAsk) < requestedShares * (this.gates.minDepthMultiple ?? 3)) {
          this.diagnostics.rejectedDepth += 1;
          continue;
        }
        this.diagnostics.eligibleMarkets += 1;
        const key = `${armKey(arm)}:${market.marketId}`;
        if (this.active.has(key) || (this.cooldowns.get(key) ?? 0) > tick.receivedAt) continue;
        const entryLatencyMs = arm.entryLatencyMs ?? 250;
        this.active.set(key, {
          arm,
          marketId: market.marketId,
          tokenId,
          signaledAt: tick.receivedAt,
          entryNotBefore: tick.receivedAt + entryLatencyMs,
          entryDeadline: tick.receivedAt + entryLatencyMs + (this.gates.entryTimeoutMs ?? 2_000)
        });
        this.cooldowns.set(key, tick.receivedAt + arm.holdMs * 2);
      }
    }
  }

  private maybeEnter(tokenId: string, now: number): void {
    for (const trade of this.active.values()) {
      if (trade.tokenId !== tokenId || trade.enteredAt !== undefined || now < trade.entryNotBefore || now > trade.entryDeadline) continue;
      const book = this.books.get(tokenId);
      const market = this.markets.get(trade.marketId);
      if (!book?.bestAsk || book.bestBid === undefined || !market) continue;
      if (book.bestAsk < (trade.arm.minEntryPrice ?? this.gates.minEntryPrice ?? 0.1) || book.bestAsk > (trade.arm.maxEntryPrice ?? this.gates.maxEntryPrice ?? 0.9)) continue;
      if (book.bestAsk - book.bestBid > (this.gates.maxSpread ?? 0.03)) continue;
      const shares = trade.arm.sizeUsd / book.bestAsk;
      if (topSize(book.asks, book.bestAsk) < shares * (this.gates.minDepthMultiple ?? 3)) continue;
      const feeRate = market.feesEnabled === false ? 0 : market.takerFeeRate ?? this.fallbackFeeRate;
      trade.shares = shares;
      trade.entryPrice = book.bestAsk;
      trade.entryFee = takerFeeUsd(shares, book.bestAsk, feeRate);
      trade.capitalUsd = shares * book.bestAsk + trade.entryFee;
      trade.enteredAt = now;
      trade.exitsAt = now + trade.arm.holdMs;
    }
  }

  private settle(now: number): void {
    for (const [key, trade] of this.active) {
      if (trade.enteredAt === undefined) {
        if (now < trade.entryDeadline) continue;
        this.diagnostics.entryTimeouts += 1;
        this.active.delete(key);
        continue;
      }
      if (now < trade.exitsAt!) continue;
      const book = this.books.get(trade.tokenId);
      const market = this.markets.get(trade.marketId);
      const executable = book?.bestBid !== undefined
        && now - book.timestamp >= 0
        && now - book.timestamp <= (this.gates.maxBookAgeMs ?? 2_000)
        && topSize(book.bids, book.bestBid) >= trade.shares!;
      if (!executable || !market) {
        this.results.push({
          arm: trade.arm,
          marketId: trade.marketId,
          enteredAt: trade.enteredAt,
          pnlUsd: -trade.capitalUsd!,
          capitalUsd: trade.capitalUsd!,
          exitMiss: true
        });
      } else {
        const feeRate = market.feesEnabled === false ? 0 : market.takerFeeRate ?? this.fallbackFeeRate;
        const exitFee = takerFeeUsd(trade.shares!, book!.bestBid!, feeRate);
        this.results.push({
          arm: trade.arm,
          marketId: trade.marketId,
          enteredAt: trade.enteredAt,
          pnlUsd: trade.shares! * (book!.bestBid! - trade.entryPrice!) - trade.entryFee! - exitFee,
          capitalUsd: trade.capitalUsd!,
          exitMiss: false
        });
      }
      this.active.delete(key);
    }
  }
}

async function* recordsFrom(path: string): AsyncGenerator<MarketTapeRecord> {
  const lines = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (!line) continue;
    yield JSON.parse(line) as MarketTapeRecord;
  }
}

function summarize(results: ReplayResult[], arms: Arm[]): ArmSummary[] {
  return arms.map((arm) => {
    const rows = results.filter((row) => armKey(row.arm) === armKey(arm));
    const pnlUsd = rows.reduce((sum, row) => sum + row.pnlUsd, 0);
    const capitalUsd = rows.reduce((sum, row) => sum + row.capitalUsd, 0);
    return {
      ...arm,
      outcomes: rows.length,
      distinctMarkets: new Set(rows.map((row) => row.marketId)).size,
      exitMisses: rows.filter((row) => row.exitMiss).length,
      pnlUsd,
      capitalUsd,
      returnPct: capitalUsd > 0 ? pnlUsd / capitalUsd : 0,
      winRate: rows.length > 0 ? rows.filter((row) => row.pnlUsd > 0).length / rows.length : 0
    };
  });
}

function cartesian(
  thresholds: number[],
  moveWindows: number[],
  entryLatencies: number[],
  holds: number[],
  sizes: number[],
  priceBands: Array<[number, number]>
): Arm[] {
  return thresholds.flatMap((thresholdBps) => moveWindows.flatMap((moveWindowMs) => entryLatencies.flatMap((entryLatencyMs) =>
    holds.flatMap((holdMs) => sizes.flatMap((sizeUsd) => priceBands.map(([minEntryPrice, maxEntryPrice]) => ({
      thresholdBps, moveWindowMs, entryLatencyMs, holdMs, sizeUsd, minEntryPrice, maxEntryPrice
    }))))
  )));
}

function numberList(raw: string | undefined, fallback: number[]): number[] {
  if (!raw) return fallback;
  const values = raw.split(",").map(Number).filter((value) => Number.isFinite(value) && value > 0);
  return values.length > 0 ? values : fallback;
}

function priceBands(raw: string | undefined): Array<[number, number]> {
  const parsed = (raw ?? "0.02-0.98,0.1-0.9").split(",").map((value) => value.split("-").map(Number))
    .filter((value): value is [number, number] => value.length === 2 && value[0] > 0 && value[1] < 1 && value[0] < value[1]);
  return parsed.length > 0 ? parsed : [[0.1, 0.9]];
}

function armKey(arm: Arm): string {
  return `${arm.thresholdBps}:${arm.moveWindowMs ?? 2_000}:${arm.entryLatencyMs ?? 250}:${arm.holdMs}:${arm.sizeUsd}:${arm.minEntryPrice ?? 0.1}:${arm.maxEntryPrice ?? 0.9}`;
}

function topSize(levels: PriceLevel[], price: number): number {
  return levels.find((level) => Math.abs(level.price - price) < 1e-9)?.size ?? 0;
}

function shortHorizon(market: TapeMarket, now: number): boolean {
  if (!market.endDate) return false;
  const endsAt = Date.parse(market.endDate);
  return Number.isFinite(endsAt) && endsAt > now && endsAt - now <= 36 * 60 * 60_000;
}

function cryptoDirection(question: string): { symbol: CryptoReferenceTick["symbol"]; yesDirection: 1 | -1 } | undefined {
  const symbol = /bitcoin|\bbtc\b/i.test(question) ? "BTCUSDT" : /ethereum|\beth\b/i.test(question) ? "ETHUSDT" : undefined;
  if (!symbol) return undefined;
  if (/above|over|up|higher|increase|rise/i.test(question)) return { symbol, yesDirection: 1 };
  if (/below|under|down|lower|decrease|fall/i.test(question)) return { symbol, yesDirection: -1 };
  return undefined;
}

function printReport(report: ReturnType<CrossMarketSensitivityReplay["report"]>, segments: number, availableSegments: number, lookbackHours: number, skippedSegments = 0): void {
  console.log("Cross-Market Latency Tape Sensitivity");
  console.log(`Segments: ${segments}/${availableSegments} in ${lookbackHours}h lookback; skipped corrupt/unreadable: ${skippedSegments}; economic outcomes: ${report.recordsWithOutcomes}`);
  if (report.splitAt) console.log(`Training before ${new Date(report.splitAt).toISOString()}; untouched test at/after split.`);
  console.log("threshold window entry hold   size     band  trainN markets misses       pnl  return   win");
  for (const row of report.training) {
    const band = `${row.minEntryPrice ?? 0.1}-${row.maxEntryPrice ?? 0.9}`;
    console.log(`${String(row.thresholdBps).padStart(6)}bps ${String((row.moveWindowMs ?? 2_000) / 1000).padStart(5)}s ${String(row.entryLatencyMs ?? 250).padStart(5)}ms ${String(row.holdMs / 1000).padStart(4)}s ${`$${row.sizeUsd}`.padStart(6)} ${band.padStart(8)} ${String(row.outcomes).padStart(7)} ${String(row.distinctMarkets).padStart(7)} ${String(row.exitMisses).padStart(6)} ${money(row.pnlUsd).padStart(9)} ${pct(row.returnPct).padStart(7)} ${pct(row.winRate).padStart(7)}`);
  }
  if (report.selectedArm) console.log(`Training selection: ${report.selectedArm.thresholdBps}bps / ${report.selectedArm.moveWindowMs ?? 2_000}ms window / ${report.selectedArm.entryLatencyMs ?? 250}ms entry / ${report.selectedArm.holdMs}ms hold / $${report.selectedArm.sizeUsd} / ${report.selectedArm.minEntryPrice ?? 0.1}-${report.selectedArm.maxEntryPrice ?? 0.9} band.`);
  if (report.untouchedTest) console.log(`Untouched test: n=${report.untouchedTest.outcomes}, pnl=${money(report.untouchedTest.pnlUsd)}, return=${pct(report.untouchedTest.returnPct)}, win=${pct(report.untouchedTest.winRate)}.`);
  console.log(`Diagnostics: refs=${report.diagnostics.referenceTicks}, threshold-signals=${report.diagnostics.thresholdSignals}, eligible=${report.diagnostics.eligibleMarkets}, price=${report.diagnostics.rejectedPrice}, spread=${report.diagnostics.rejectedSpread}, age=${report.diagnostics.rejectedBookAge}, depth=${report.diagnostics.rejectedDepth}, entry-timeouts=${report.diagnostics.entryTimeouts}.`);
  console.log(`Verdict: ${report.verdict}`);
  console.log("Sensitivity rows are research selection data and can never enter a promotion scorecard.");
}

function money(value: number): string {
  return `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const config = loadBotConfig();
  const env = loadRuntimeEnv();
  const tapeDir = resolve(process.env.CROSS_SENSITIVITY_TAPE_DIR || env.researchTapeDir || resolve(env.dbPath, "..", "market-tape"));
  const lookbackHours = Number(process.env.CROSS_SENSITIVITY_LOOKBACK_HOURS || 6);
  const cutoff = Date.now() - (Number.isFinite(lookbackHours) && lookbackHours > 0 ? lookbackHours : 6) * 60 * 60_000;
  const allFiles = readdirSync(tapeDir)
    .filter((name) => name.endsWith(".jsonl.gz"))
    .sort()
    .map((name) => join(tapeDir, name));
  const files = allFiles.filter((path) => statSync(path).mtimeMs >= cutoff);
  const arms = cartesian(
    numberList(process.env.CROSS_SENSITIVITY_THRESHOLDS_BPS, [2, 4, 8]),
    numberList(process.env.CROSS_SENSITIVITY_MOVE_WINDOWS_MS, [2_000]),
    numberList(process.env.CROSS_SENSITIVITY_ENTRY_LATENCIES_MS, [250]),
    numberList(process.env.CROSS_SENSITIVITY_HOLDS_MS, [5_000, 15_000, 30_000]),
    numberList(process.env.CROSS_SENSITIVITY_SIZES_USD, [5, 10, 25]),
    priceBands(process.env.CROSS_SENSITIVITY_PRICE_BANDS)
  );
  const replay = new CrossMarketSensitivityReplay(arms, config.liveExecutionFeeRatePct ?? 0, {
    entryTimeoutMs: config.crossMarketEntryTimeoutMs,
    minEntryPrice: config.crossMarketMinEntryPrice,
    maxEntryPrice: config.crossMarketMaxEntryPrice,
    maxSpread: config.crossMarketMaxSpread,
    minDepthMultiple: config.crossMarketMinDepthMultiple,
    maxBookAgeMs: config.crossMarketMaxBookAgeMs
  });
  let skippedSegments = 0;
  for (const path of files) {
    try {
      for await (const record of recordsFrom(path)) replay.process(record);
    } catch (error) {
      skippedSegments += 1;
      console.error(`Skipped unreadable tape segment ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const report = replay.report();
  const generatedAt = Date.now();
  const persisted = {
    generatedAt,
    tapeDir,
    lookbackHours,
    availableSegments: allFiles.length,
    processedSegments: files.length,
    skippedSegments,
    arms,
    report
  };
  if (process.env.CROSS_SENSITIVITY_PERSIST_REPORT !== "false") {
    const reportDir = resolve(process.env.CROSS_SENSITIVITY_REPORT_DIR || resolve(env.dbPath, "..", "research-reports"));
    mkdirSync(reportDir, { recursive: true });
    const body = `${JSON.stringify(persisted, null, 2)}\n`;
    writeFileSync(join(reportDir, `cross-market-${generatedAt}.json`), body, { flag: "wx" });
    writeFileSync(join(reportDir, "cross-market-latest.json"), body);
  }
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else printReport(report, files.length, allFiles.length, lookbackHours, skippedSegments);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
