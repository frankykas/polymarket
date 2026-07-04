import { randomId } from "../db.js";
import type { AgentEventWriter } from "../events/eventWriter.js";
import type { BotConfig, MarketQuality, MarketSnapshot, MicrostructureReport, OrderBookSnapshot } from "../types.js";

export class MicrostructureAgent {
  constructor(private events?: AgentEventWriter) {}

  review(market: MarketSnapshot, books: OrderBookSnapshot[], config: BotConfig, now = Date.now()): MicrostructureReport {
    const usableBooks = books.filter((book) => book.bestBid !== undefined && book.bestAsk !== undefined);
    const spreads = usableBooks.map((book) => book.spread ?? Math.max(0, (book.bestAsk ?? 1) - (book.bestBid ?? 0)));
    const bestSpread = spreads.length ? Math.min(...spreads) : undefined;
    const worstSpread = spreads.length ? Math.max(...spreads) : undefined;
    const totalDepth = books.reduce((sum, book) => sum + Math.max(0, book.depth), 0);
    const executableAskDepth = usableBooks.reduce((sum, book) => sum + askNotional(book, config.minPositionSize), 0);
    const priceImpactForMinSize = usableBooks.length
      ? Math.min(...usableBooks.map((book) => estimatePriceImpact(book, config.minPositionSize)))
      : 1;
    const dataAgeMs = books.length ? Math.max(...books.map((book) => Math.max(0, now - book.timestamp))) : Number.POSITIVE_INFINITY;

    const reasons: string[] = [];
    if (usableBooks.length === 0) reasons.push("missing executable order book");
    if (bestSpread !== undefined && bestSpread > config.maxSpread) reasons.push(`best spread ${bestSpread.toFixed(4)} above ${config.maxSpread}`);
    if (worstSpread !== undefined && worstSpread > config.maxSpread * 1.5) reasons.push(`worst spread ${worstSpread.toFixed(4)} materially wide`);
    if (totalDepth < config.minOrderBookDepth) reasons.push(`combined depth ${totalDepth.toFixed(2)} below ${config.minOrderBookDepth}`);
    if (executableAskDepth < config.minPositionSize) reasons.push(`ask depth supports only $${executableAskDepth.toFixed(2)} at entry`);
    if (priceImpactForMinSize > config.maxSpread * 2) reasons.push(`estimated entry impact ${(priceImpactForMinSize * 100).toFixed(1)}%`);
    if (!Number.isFinite(dataAgeMs) || dataAgeMs > 120_000) reasons.push("order book data is stale");

    const spreadPenalty = bestSpread === undefined ? 35 : Math.min(35, (bestSpread / Math.max(config.maxSpread, 0.001)) * 25);
    const depthPenalty = totalDepth >= config.minOrderBookDepth ? 0 : 20;
    const executablePenalty = executableAskDepth >= config.minPositionSize ? 0 : 20;
    const impactPenalty = Math.min(20, priceImpactForMinSize * 250);
    const stalePenalty = !Number.isFinite(dataAgeMs) ? 20 : dataAgeMs > 120_000 ? 20 : dataAgeMs > 60_000 ? 8 : 0;
    const score = clampScore(100 - spreadPenalty - depthPenalty - executablePenalty - impactPenalty - stalePenalty);

    const state: MicrostructureReport["state"] =
      usableBooks.length === 0 ? "UNKNOWN"
        : !Number.isFinite(dataAgeMs) || dataAgeMs > 120_000 ? "STALE"
          : bestSpread !== undefined && bestSpread > config.maxSpread ? "WIDE"
            : totalDepth < config.minOrderBookDepth || executableAskDepth < config.minPositionSize ? "THIN"
              : "EXECUTABLE";

    const report: MicrostructureReport = {
      id: randomId("micro"),
      marketId: market.id,
      score,
      state,
      bestSpread,
      worstSpread,
      totalDepth,
      executableAskDepth,
      priceImpactForMinSize,
      dataAgeMs: Number.isFinite(dataAgeMs) ? dataAgeMs : 0,
      reasons: reasons.length ? reasons : ["order book supports controlled entry"],
      createdAt: now
    };

    this.events?.write({
      type: "microstructure.review_completed",
      agent: "Microstructure Agent",
      visibility: state === "EXECUTABLE" ? "PUBLIC" : "PRIVATE",
      message: `Microstructure rated ${state} (${score}/100).`,
      payload: report
    });

    return report;
  }
}

export function applyMicrostructureToQuality(quality: MarketQuality, report: MicrostructureReport): MarketQuality {
  const reasons = [...quality.reasons];
  if (report.state !== "EXECUTABLE") reasons.push(`microstructure ${report.state.toLowerCase()}: ${report.reasons.join("; ")}`);
  if (report.score < 50) reasons.push(`microstructure score ${report.score} below 50`);
  return {
    ...quality,
    approved: quality.approved && report.state === "EXECUTABLE" && report.score >= 50,
    score: Math.min(quality.score, report.score),
    reasons,
    microstructureScore: report.score,
    microstructureState: report.state,
    microstructureReasons: report.reasons
  };
}

function askNotional(book: OrderBookSnapshot, targetUsd: number): number {
  let notional = 0;
  for (const level of book.asks) {
    notional += Math.max(0, level.price) * Math.max(0, level.size);
    if (notional >= targetUsd) return notional;
  }
  return notional;
}

function estimatePriceImpact(book: OrderBookSnapshot, targetUsd: number): number {
  if (!book.asks.length || book.bestAsk === undefined || book.bestAsk <= 0) return 1;
  let remainingUsd = targetUsd;
  let acquiredShares = 0;
  let spentUsd = 0;
  for (const level of book.asks) {
    if (remainingUsd <= 0) break;
    const levelNotional = Math.max(0, level.price) * Math.max(0, level.size);
    const spend = Math.min(remainingUsd, levelNotional);
    if (level.price > 0) acquiredShares += spend / level.price;
    spentUsd += spend;
    remainingUsd -= spend;
  }
  if (spentUsd < targetUsd || acquiredShares <= 0) return 1;
  const avgPrice = spentUsd / acquiredShares;
  return Math.max(0, (avgPrice - book.bestAsk) / book.bestAsk);
}

function clampScore(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)));
}
