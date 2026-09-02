import type { BotConfig, LiveExecutionEstimate, OrderBookSnapshot, OrderExecutionPolicy, PriceLevel, Side } from "./types.js";

/** Polymarket taker fee: shares * fee-rate * p * (1-p). */
export function takerFeeUsd(shares: number, price: number, feeRate: number): number {
  if (!(shares > 0) || !(price > 0) || !(price < 1) || !(feeRate > 0)) return 0;
  return shares * feeRate * price * (1 - price);
}

export function estimateEntryExecution(input: {
  side?: "BUY";
  book?: OrderBookSnapshot;
  sizeUsd: number;
  referencePrice?: number;
  config: BotConfig;
  now?: number;
}): LiveExecutionEstimate {
  return estimateBookExecution({
    side: input.side ?? "BUY",
    book: input.book,
    sizeUsd: input.sizeUsd,
    referencePrice: input.referencePrice ?? input.book?.bestAsk,
    policy: input.config.entryOrderPolicy ?? "FAK",
    maxSlippage: input.config.maxEntrySlippage ?? 0.03,
    tickSize: input.book?.tickSize ?? input.config.orderTickSize ?? 0.01,
    minOrderSize: input.config.minPositionSize,
    feeRatePct: input.config.liveExecutionFeeRatePct ?? 0,
    maxBookAgeMs: input.config.maxOrderBookAgeMs ?? 60_000,
    now: input.now ?? Date.now()
  });
}

export function estimateExitExecution(input: {
  side?: "SELL";
  book?: OrderBookSnapshot;
  shares: number;
  referencePrice?: number;
  config: BotConfig;
  now?: number;
}): LiveExecutionEstimate {
  const referencePrice = input.referencePrice ?? input.book?.bestBid;
  return estimateBookExecution({
    side: input.side ?? "SELL",
    book: input.book,
    sizeUsd: Math.max(0, input.shares * Math.max(referencePrice ?? 0, 0)),
    shares: input.shares,
    referencePrice,
    policy: input.config.exitOrderPolicy ?? "FAK",
    maxSlippage: input.config.maxExitSlippage ?? input.config.maxEntrySlippage ?? 0.03,
    tickSize: input.book?.tickSize ?? input.config.orderTickSize ?? 0.01,
    minOrderSize: input.config.minPositionSize,
    feeRatePct: input.config.liveExecutionFeeRatePct ?? 0,
    maxBookAgeMs: input.config.maxOrderBookAgeMs ?? 60_000,
    now: input.now ?? Date.now()
  });
}

export function liveEntryParity(input: {
  estimate: LiveExecutionEstimate;
  expectedReturnPct?: number;
  sourceSellRealizedRatio?: number;
  config: BotConfig;
}): { passed: boolean; reason: string } {
  const minReturn = input.config.liveExecutableMinReturnPct ?? 0.03;
  const minSourceSellRatio = input.config.minSourceSellRealizedRatio ?? 0.35;
  const minDepthMultiple = input.config.entryBookDepthMultiple ?? 3;
  const maxEntrySlippage = input.config.maxEntrySlippage ?? 0.03;
  const expectedReturn = input.expectedReturnPct ?? 0;
  const sourceSellRatio = input.sourceSellRealizedRatio ?? 0;
  const reasons: string[] = [];

  if (!input.estimate.executable) reasons.push(input.estimate.reason ?? "entry is not executable");
  if (expectedReturn <= minReturn) reasons.push(`live executable return ${(expectedReturn * 100).toFixed(2)}% <= ${(minReturn * 100).toFixed(2)}%`);
  if (sourceSellRatio < minSourceSellRatio) reasons.push(`source-sell ratio ${(sourceSellRatio * 100).toFixed(1)}% < ${(minSourceSellRatio * 100).toFixed(1)}%`);
  if (input.estimate.depthMultiple < minDepthMultiple) reasons.push(`entry depth ${input.estimate.depthMultiple.toFixed(2)}x < ${minDepthMultiple}x`);
  if (input.estimate.slippage > maxEntrySlippage) reasons.push(`entry slippage ${input.estimate.slippage.toFixed(4)} > ${maxEntrySlippage.toFixed(4)}`);

  return {
    passed: reasons.length === 0,
    reason: reasons.length === 0 ? "live parity passed" : reasons.join("; ")
  };
}

export function roundPriceForSide(price: number, side: Side, tickSize: number): number {
  if (!(tickSize > 0)) return clampPrice(price);
  const ticks = side === "BUY" ? Math.ceil(price / tickSize) : Math.floor(price / tickSize);
  return clampPrice(ticks * tickSize);
}

// Expected price move between spotting a source fill on the tape and getting our
// own mirror order done. Entry and exit are both mirrored after the same
// detection delay, so both sides must charge the same expected move.
export function copyDelayPriceMovePct(config: BotConfig): number {
  const delayMinutes = (config.shadowCopyDelayMs ?? 0) / 60_000;
  return Math.min(config.shadowMaxEntryPriceMovePct ?? 0.06, 0.01 + delayMinutes * 0.002);
}

export function estimateTapeExecutableShadow(input: {
  sourcePrice: number;
  entryPrice: number;
  exitPrice?: number;
  sourceBuySize: number;
  sourceSellSize?: number;
  sizeUsd: number;
  exitReason?: string;
  config: BotConfig;
}): {
  status: "EXECUTABLE" | "MISSED";
  reason: string;
  pnl?: number;
  returnPct?: number;
  entryPrice?: number;
  exitPrice?: number;
  entrySlippage?: number;
  exitSlippage?: number;
} {
  const minOrderSize = input.config.minPositionSize;
  if (input.sizeUsd < minOrderSize) return { status: "MISSED", reason: "below min order size" };

  const maxEntrySlippage = input.config.maxEntrySlippage ?? 0.03;
  const maxExitSlippage = input.config.maxExitSlippage ?? maxEntrySlippage;
  const tickSize = input.config.orderTickSize ?? 0.01;
  const feeRatePct = input.config.liveExecutionFeeRatePct ?? 0;
  const entryPrice = roundPriceForSide(input.entryPrice, "BUY", tickSize);
  const entrySlippage = Math.max(0, entryPrice - input.sourcePrice);
  if (entrySlippage > maxEntrySlippage) {
    return { status: "MISSED", reason: "entry slippage exceeds cap", entryPrice, entrySlippage };
  }

  const shares = input.sizeUsd / entryPrice;
  if (input.sourceBuySize < shares) {
    return { status: "MISSED", reason: "source buy size below FOK copy size", entryPrice, entrySlippage };
  }

  // Whether the source later chose to sell is not an executability property -- it is
  // an outcome, and it is unknowable at the moment we enter. Excluding unsold buys
  // meant the executable population was exactly the subset the source closed at a
  // profit, which is unimplementable and drove win rates to ~100%. A buy the source
  // never closed is a position we would have carried and exited on our own policy at
  // the observed mark, so it belongs in the evidence. Only a buy with no observable
  // exit at all leaves us nothing to model.
  if (input.exitReason === "source price fallback" || input.exitReason === undefined) {
    return { status: "MISSED", reason: "no observable exit to model", entryPrice, entrySlippage };
  }
  if (input.exitPrice === undefined) return { status: "MISSED", reason: "missing exit price", entryPrice, entrySlippage };

  // Mirror the entry treatment: charge the *expected* price move for copying the
  // source's sell, then reject if that lands outside the cap. maxExitSlippage is
  // the worst fill we would accept before pulling the order, not the fill we
  // expect. Spending the whole cap on every exit modelled a source that made 10%
  // at 0.50 as a 2% copy, and left effectively no wallet able to clear
  // liveExecutableMinReturnPct -- which is what froze the live gate.
  // Resolution pays out at the settled price with no book to cross. Every other exit
  // -- mirroring the source's sell, or closing on our own policy at the mark -- means
  // selling into the market, so both pay the same expected move.
  const rawExitPrice = input.exitReason === "resolved market outcome"
    ? input.exitPrice
    : Math.max(0.01, input.exitPrice * (1 - copyDelayPriceMovePct(input.config)));
  const exitPrice = roundPriceForSide(rawExitPrice, "SELL", tickSize);
  const exitSlippage = Math.max(0, input.exitPrice - exitPrice);
  if (exitSlippage > maxExitSlippage) {
    return { status: "MISSED", reason: "exit slippage exceeds cap", entryPrice, exitPrice, entrySlippage, exitSlippage };
  }
  if (input.exitReason === "source sell after detection" && (input.sourceSellSize ?? 0) < shares) {
    return { status: "MISSED", reason: "source sell size below FOK exit size", entryPrice, exitPrice, entrySlippage, exitSlippage };
  }

  const entryNotional = entryPrice * shares;
  const exitNotional = exitPrice * shares;
  const fees = takerFeeUsd(shares, entryPrice, feeRatePct) + takerFeeUsd(shares, exitPrice, feeRatePct);
  const pnl = exitNotional - entryNotional - fees;
  return {
    status: "EXECUTABLE",
    reason: "live executable tape model",
    pnl,
    returnPct: entryNotional > 0 ? pnl / entryNotional : 0,
    entryPrice,
    exitPrice,
    entrySlippage,
    exitSlippage
  };
}

function estimateBookExecution(input: {
  side: Side;
  book?: OrderBookSnapshot;
  sizeUsd: number;
  shares?: number;
  referencePrice?: number;
  policy: OrderExecutionPolicy;
  maxSlippage: number;
  tickSize: number;
  minOrderSize: number;
  feeRatePct: number;
  maxBookAgeMs: number;
  now: number;
}): LiveExecutionEstimate {
  const base: LiveExecutionEstimate = {
    executable: false,
    policy: input.policy,
    side: input.side,
    requestedSizeUsd: input.sizeUsd,
    requestedShares: 0,
    filledShares: 0,
    slippage: 0,
    maxSlippage: input.maxSlippage,
    bookDepth: 0,
    depthMultiple: 0,
    fee: 0
  };
  if (!input.book) return { ...base, reason: "missing order book" };
  if (input.now - input.book.timestamp > input.maxBookAgeMs) return { ...base, reason: "stale order book" };
  if (input.sizeUsd < input.minOrderSize) return { ...base, reason: "below min order size" };

  const referencePrice = input.referencePrice ?? (input.side === "BUY" ? input.book.bestAsk : input.book.bestBid);
  if (!referencePrice || referencePrice <= 0) return { ...base, reason: "missing executable reference price" };

  const limitPrice = roundPriceForSide(
    input.side === "BUY" ? referencePrice + input.maxSlippage : referencePrice - input.maxSlippage,
    input.side,
    input.tickSize
  );
  const requestedShares = input.shares ?? input.sizeUsd / limitPrice;
  const levels = executableLevels(input.side, limitPrice, input.book);
  const bookDepth = levels.reduce((sum, level) => sum + level.price * level.size, 0);
  const filled = fillLevels(levels, requestedShares);
  const averageFillPrice = filled.shares > 0 ? filled.notional / filled.shares : undefined;
  const slippage = averageFillPrice === undefined
    ? 0
    : input.side === "BUY"
      ? Math.max(0, averageFillPrice - referencePrice)
      : Math.max(0, referencePrice - averageFillPrice);
  const fee = averageFillPrice === undefined ? 0 : takerFeeUsd(filled.shares, averageFillPrice, input.feeRatePct);
  const depthMultiple = input.sizeUsd > 0 ? bookDepth / input.sizeUsd : 0;
  const partial = filled.shares > 0 && filled.shares < requestedShares;
  const executable = input.policy === "FOK"
    ? filled.shares >= requestedShares
    : filled.shares > 0;

  return {
    ...base,
    executable,
    requestedShares,
    filledShares: executable ? filled.shares : 0,
    averageFillPrice: executable ? averageFillPrice : undefined,
    limitPrice,
    referencePrice,
    slippage,
    bookDepth,
    depthMultiple,
    fee: executable ? fee : 0,
    reason: executable ? "executable" : partial ? "partial fill rejected by FOK" : "insufficient executable liquidity",
    partialFillReason: partial ? "insufficient executable liquidity for full size" : undefined
  };
}

function executableLevels(side: Side, limitPrice: number, book: OrderBookSnapshot): PriceLevel[] {
  const levels = side === "BUY"
    ? book.asks.filter((level) => level.price <= limitPrice).sort((a, b) => a.price - b.price)
    : book.bids.filter((level) => level.price >= limitPrice).sort((a, b) => b.price - a.price);
  return levels;
}

function fillLevels(levels: PriceLevel[], requestedShares: number): { shares: number; notional: number } {
  let remaining = requestedShares;
  let shares = 0;
  let notional = 0;
  for (const level of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, level.size);
    shares += take;
    notional += take * level.price;
    remaining -= take;
  }
  return { shares, notional };
}

function clampPrice(price: number): number {
  return Math.max(0.01, Math.min(0.99, Number(price.toFixed(4))));
}
