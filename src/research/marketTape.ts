import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import type { CryptoReferenceTick, MarketSnapshot, MarketStreamUpdate, PriceLevel } from "../types.js";

export type MarketTapeRecord =
  | {
      schemaVersion: 1;
      recordType: "MARKET_METADATA";
      receivedAt: number;
      marketId: string;
      conditionId?: string;
      eventId?: string;
      eventSlug?: string;
      eventMarketCount?: number;
      question: string;
      endDate?: string;
      tokenIds: string[];
      outcomes: string[];
      volume24h: number;
      liquidity: number;
      feesEnabled?: boolean;
      takerFeeRate?: number;
      negRisk?: boolean;
      negRiskAugmented?: boolean;
      rewardsMinSize?: number;
      rewardsMaxSpread?: number;
      rewardsDailyRate?: number;
    }
  | {
      schemaVersion: 1;
      recordType: "MARKET_STREAM";
      eventType: MarketStreamUpdate["eventType"];
      receivedAt: number;
      exchangeTimestamp?: number;
      tokenId: string;
      marketId?: string;
      bestBid?: number;
      bestAsk?: number;
      spread?: number;
      lastTradePrice?: number;
      tickSize?: number;
      bids?: PriceLevel[];
      asks?: PriceLevel[];
      bookDelta?: MarketStreamUpdate["bookDelta"];
      trade?: MarketStreamUpdate["trade"];
    }
  | {
      schemaVersion: 1;
      recordType: "CRYPTO_REFERENCE";
      receivedAt: number;
      exchangeTimestamp?: number;
      symbol: CryptoReferenceTick["symbol"];
      bid: number;
      ask: number;
      price: number;
    };

export interface MarketTapeStats {
  records: number;
  streamRecords: number;
  metadataRecords: number;
  referenceRecords: number;
  bytesUncompressed: number;
  currentFile?: string;
}

/**
 * Prospective append-only research tape. Each process/day owns an immutable
 * gzip segment, so a damaged active segment cannot invalidate earlier history.
 * DuckDB can ingest these newline-delimited gzip segments directly and they can
 * later be compacted to Parquet without touching the trading database.
 */
export class CompressedMarketTapeWriter {
  private day?: string;
  private currentFile?: string;
  private segment = 0;
  private readonly sessionId = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${process.pid}-${randomBytes(3).toString("hex")}`;
  private bufferedLines: string[] = [];
  private bufferedBytes = 0;
  private readonly flushThresholdBytes = 8 * 1024 * 1024;
  private closed = false;
  private metadataFingerprints = new Map<string, string>();
  private stats: MarketTapeStats = {
    records: 0,
    streamRecords: 0,
    metadataRecords: 0,
    referenceRecords: 0,
    bytesUncompressed: 0
  };

  constructor(private directory: string, private depthLevels = 10) {
    mkdirSync(directory, { recursive: true });
  }

  recordMarket(market: MarketSnapshot, receivedAt = Date.now()): boolean {
    const record: MarketTapeRecord = {
      schemaVersion: 1,
      recordType: "MARKET_METADATA",
      receivedAt,
      marketId: market.id,
      conditionId: market.conditionId,
      eventId: market.eventId,
      eventSlug: market.eventSlug,
      eventMarketCount: market.eventMarketCount,
      question: market.question,
      endDate: market.endDate,
      tokenIds: market.clobTokenIds,
      outcomes: market.outcomes,
      volume24h: market.volume24h,
      liquidity: market.liquidity,
      feesEnabled: market.feesEnabled,
      takerFeeRate: market.takerFeeRate,
      negRisk: market.negRisk,
      negRiskAugmented: market.negRiskAugmented,
      rewardsMinSize: market.rewardsMinSize,
      rewardsMaxSpread: market.rewardsMaxSpread,
      rewardsDailyRate: market.rewardsDailyRate
    };
    const fingerprint = JSON.stringify({ ...record, receivedAt: 0 });
    if (this.metadataFingerprints.get(market.id) === fingerprint) return false;
    this.metadataFingerprints.set(market.id, fingerprint);
    this.write(record);
    this.stats.metadataRecords += 1;
    return true;
  }

  recordUpdate(update: MarketStreamUpdate, marketId?: string): void {
    this.write({
      schemaVersion: 1,
      recordType: "MARKET_STREAM",
      eventType: update.eventType,
      receivedAt: update.receivedAt,
      exchangeTimestamp: update.exchangeTimestamp,
      tokenId: update.tokenId,
      marketId: update.marketId ?? marketId,
      bestBid: update.bestBid,
      bestAsk: update.bestAsk,
      spread: update.spread,
      lastTradePrice: update.lastTradePrice,
      tickSize: update.tickSize,
      bids: update.bids?.slice(0, this.depthLevels),
      asks: update.asks?.slice(0, this.depthLevels),
      bookDelta: update.bookDelta,
      trade: update.trade
    });
    this.stats.streamRecords += 1;
  }

  recordReference(tick: CryptoReferenceTick): void {
    this.write({
      schemaVersion: 1,
      recordType: "CRYPTO_REFERENCE",
      receivedAt: tick.receivedAt,
      exchangeTimestamp: tick.exchangeTimestamp,
      symbol: tick.symbol,
      bid: tick.bid,
      ask: tick.ask,
      price: tick.price
    });
    this.stats.referenceRecords += 1;
  }

  getStats(): MarketTapeStats {
    return { ...this.stats, currentFile: this.currentFile };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.flush();
  }

  private write(record: MarketTapeRecord): void {
    if (this.closed) return;
    this.ensureDay(record.receivedAt);
    const line = `${JSON.stringify(record)}\n`;
    this.bufferedLines.push(line);
    this.bufferedBytes += Buffer.byteLength(line);
    this.stats.records += 1;
    this.stats.bytesUncompressed += Buffer.byteLength(line);
    if (this.bufferedBytes >= this.flushThresholdBytes) this.flush();
  }

  private ensureDay(timestamp: number): void {
    const day = new Date(timestamp).toISOString().slice(0, 10);
    if (this.day === day) return;
    if (this.day) this.flush();
    this.day = day;
  }

  private flush(): void {
    if (this.bufferedLines.length === 0 || !this.day) return;
    this.segment += 1;
    this.currentFile = join(this.directory, `market-tape-${this.day}-${this.sessionId}-${String(this.segment).padStart(3, "0")}.jsonl.gz`);
    const temporary = `${this.currentFile}.tmp`;
    const compressed = gzipSync(this.bufferedLines.join(""), { level: 6 });
    writeFileSync(temporary, compressed, { flag: "wx" });
    renameSync(temporary, this.currentFile);
    this.bufferedLines = [];
    this.bufferedBytes = 0;
  }
}

export function readCompressedMarketTape(path: string): MarketTapeRecord[] {
  const text = gunzipSync(readFileSync(path)).toString("utf8");
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as MarketTapeRecord);
}
