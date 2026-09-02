import type { OrderBookSnapshot, PriceLevel } from "./types.js";

export interface PriceLevelDelta {
  price: number;
  size: number;
  side: "BUY" | "SELL";
}

/** Apply Polymarket's absolute price-level size update to a known book. */
export function applyPriceLevelDelta(levels: PriceLevel[], delta: PriceLevelDelta): PriceLevel[] {
  const next = levels.filter((level) => Math.abs(level.price - delta.price) > 1e-9);
  if (delta.size > 0) next.push({ price: delta.price, size: delta.size });
  next.sort((left, right) => delta.side === "BUY" ? right.price - left.price : left.price - right.price);
  return next;
}

export function mergeMarketStreamBook(
  previous: OrderBookSnapshot | undefined,
  update: Partial<OrderBookSnapshot> & { tokenId: string; bookDelta?: PriceLevelDelta }
): OrderBookSnapshot {
  const bidChanged = update.bestBid !== undefined && update.bestBid !== previous?.bestBid;
  const askChanged = update.bestAsk !== undefined && update.bestAsk !== previous?.bestAsk;
  const topOnlyUpdate = update.bids === undefined && update.asks === undefined && !update.bookDelta && (bidChanged || askChanged);
  const bids = update.bids
    ?? (update.bookDelta?.side === "BUY"
      ? applyPriceLevelDelta(previous?.bids ?? [], update.bookDelta)
      : topOnlyUpdate && bidChanged ? [] : previous?.bids ?? []);
  const asks = update.asks
    ?? (update.bookDelta?.side === "SELL"
      ? applyPriceLevelDelta(previous?.asks ?? [], update.bookDelta)
      : topOnlyUpdate && askChanged ? [] : previous?.asks ?? []);
  const bestBid = update.bestBid ?? (bids[0]?.price ?? previous?.bestBid);
  const bestAsk = update.bestAsk ?? (asks[0]?.price ?? previous?.bestAsk);
  return {
    tokenId: update.tokenId,
    marketId: update.marketId ?? previous?.marketId,
    bids,
    asks,
    bestBid,
    bestAsk,
    spread: update.spread ?? (bestBid !== undefined && bestAsk !== undefined ? Math.max(0, bestAsk - bestBid) : previous?.spread),
    depth: update.depth ?? [...bids, ...asks].reduce((sum, level) => sum + level.size, 0),
    tickSize: update.tickSize ?? previous?.tickSize,
    lastTradePrice: update.lastTradePrice ?? previous?.lastTradePrice,
    timestamp: update.timestamp ?? Date.now(),
    raw: update.raw ?? previous?.raw
  };
}
