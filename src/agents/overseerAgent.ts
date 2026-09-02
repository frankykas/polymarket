import type { BotDatabase } from "../db.js";
import { decideExit, PaperExecutionEngine } from "../engines.js";
import type { AgentEventWriter } from "../events/eventWriter.js";
import type { BotConfig, ExitDecision, MarketSnapshot, OrderBookSnapshot, PaperOrder, Position } from "../types.js";

export interface OverseerUpdate {
  position: Position;
  closed: boolean;
  reason: string;
}

export class OverseerAgent {
  private executor = new PaperExecutionEngine();

  constructor(
    private db: BotDatabase,
    private events: AgentEventWriter,
    private config: BotConfig
  ) {}

  monitor(orderBooks: Map<string, OrderBookSnapshot>): OverseerUpdate[] {
    const updates: OverseerUpdate[] = [];
    const now = Date.now();
    let sourceExitChecks = 0;
    let sourceSoldPositions = 0;
    let noBookPositions = 0;
    let noBidPositions = 0;
    for (const position of this.db.getOpenPositions()) {
      const book = orderBooks.get(position.tokenId);
      const entryPolicy = this.db.getPositionEntryPolicy(position.id);
      if (entryPolicy.exitPolicy === "HOLD_TO_RESOLUTION") {
        updates.push(this.monitorResolutionHold(position, book, entryPolicy, now));
        continue;
      }
      const sourceExit = this.config.sourceExitEnabled === false
        ? { sourceSold: false, sellerCount: 0, sourceCount: 0 }
        : this.db.getPositionSourceExit(position);
      sourceExitChecks += 1;
      if (sourceExit.sourceSold) sourceSoldPositions += 1;
      if (!book) {
        noBookPositions += 1;
        const fallback = this.noBookFallbackExit(position, sourceExit, now);
        if (!fallback) continue;
        const closedPosition = this.closePosition(position, fallback.price, fallback.decision);
        updates.push({ position: closedPosition, closed: true, reason: fallback.decision.reason });
        continue;
      }
      if (book.bestBid === undefined) {
        noBidPositions += 1;
        const noBidFallback = this.noBidFallbackExit(position, sourceExit, now);
        if (noBidFallback) {
          const closedPosition = this.closePosition(position, noBidFallback.price, noBidFallback.decision);
          updates.push({ position: closedPosition, closed: true, reason: noBidFallback.decision.reason });
          continue;
        }
      }
      const exit = decideExit(position, book, this.config, {
        trackedWalletReducing: sourceExit.sourceSold,
        sourceSellerCount: sourceExit.sellerCount,
        sourceCount: sourceExit.sourceCount
      });
      this.db.saveExitDecision(position.id, exit, {
        bestBid: book.bestBid,
        bestAsk: book.bestAsk,
        entryPrice: position.avgEntryPrice,
        size: position.size
      });
      this.events.write({
        type: "trade.updated",
        agent: "Overseer Agent",
        visibility: "PUBLIC",
        message: `Overseer reviewed ${position.outcome} position.`,
        payload: {
          positionId: position.id,
          decision: exit.decision,
          exitProbability: exit.exitProbability,
          reason: exit.reason,
          sourceExit
        }
      });
      if (sourceExit.sourceSold && exit.decision !== "FULL_EXIT") {
        this.events.write({
          type: "mirror_exit.missed",
          agent: "Overseer Agent",
          visibility: "PRIVATE",
          message: `Source sell detected for ${position.outcome}, but position did not fully close.`,
          payload: {
            positionId: position.id,
            marketId: position.marketId,
            outcome: position.outcome,
            sourceExit,
            exit
          }
        });
      }

      if (exit.decision === "FULL_EXIT") {
        const depthSuppressed = this.exitDepthSuppression(position, book, exit, now);
        if (depthSuppressed) {
          updates.push(depthSuppressed);
          continue;
        }
        const suppressed = this.exitRetrySuppression(position, exit, sourceExit, now);
        if (suppressed) {
          const updatedPosition: Position = {
            ...position,
            currentPrice: executableMarkPrice(book),
            updatedAt: now
          };
          this.db.savePosition(updatedPosition);
          this.events.write({
            type: "trade.exit_suppressed",
            agent: "Overseer Agent",
            visibility: "PRIVATE",
            message: `Exit retry suppressed for ${position.outcome}.`,
            payload: {
              positionId: position.id,
              marketId: position.marketId,
              outcome: position.outcome,
              reason: exit.reason,
              suppressedReason: suppressed.reason,
              lastOrderId: suppressed.lastOrder.id,
              lastOrderStatus: suppressed.lastOrder.status,
              lastOrderCreatedAt: suppressed.lastOrder.createdAt,
              retryCooldownMs: suppressed.retryCooldownMs,
              recentExitMisses: suppressed.recentExitMisses
            }
          });
          updates.push({ position: updatedPosition, closed: false, reason: suppressed.reason });
          continue;
        }
        updates.push(this.executeBookExit(position, book, exit));
      } else {
        const updatedPosition: Position = {
          ...position,
          currentPrice: executableMarkPrice(book),
          updatedAt: now
        };
        this.db.savePosition(updatedPosition);
        updates.push({ position: updatedPosition, closed: false, reason: exit.reason });
      }
    }
    if (sourceExitChecks > 0) {
      this.events.write({
        type: "source_exit.watchdog",
        agent: "Overseer Agent",
        visibility: "PRIVATE",
        message: "Source-exit watchdog checked open positions.",
        payload: {
          checkedPositions: sourceExitChecks,
          sourceSoldPositions,
          noBookPositions,
          noBidPositions,
          sourceExitEnabled: this.config.sourceExitEnabled !== false
        }
      });
    }
    return updates;
  }

  private monitorResolutionHold(
    position: Position,
    book: OrderBookSnapshot | undefined,
    entryPolicy: { strategyId?: string; policyVersion?: string; exitPolicy?: string },
    now: number
  ): OverseerUpdate {
    const market = this.db.getMarketById(position.marketId);
    const resolvedPrice = resolvedPositionPrice(position, market);
    if (resolvedPrice !== undefined) {
      const exit: ExitDecision = {
        decision: "FULL_EXIT",
        exitProbability: 100,
        reason: "resolved market outcome; frozen hold-to-resolution policy"
      };
      return { position: this.closePosition(position, resolvedPrice, exit), closed: true, reason: exit.reason };
    }

    const markPrice = book ? executableMarkPrice(book) : position.currentPrice;
    const exit: ExitDecision = {
      decision: "HOLD",
      exitProbability: 0,
      reason: "frozen hold-to-resolution policy; market unresolved"
    };
    this.db.saveExitDecision(position.id, exit, {
      bestBid: book?.bestBid,
      bestAsk: book?.bestAsk,
      entryPrice: position.avgEntryPrice,
      size: position.size
    });
    const updatedPosition: Position = { ...position, currentPrice: markPrice, updatedAt: now };
    this.db.savePosition(updatedPosition);
    this.events.write({
      type: "trade.updated",
      agent: "Overseer Agent",
      visibility: "PUBLIC",
      message: `Overseer held ${position.outcome} position to resolution.`,
      payload: {
        positionId: position.id,
        marketId: position.marketId,
        outcome: position.outcome,
        decision: exit.decision,
        reason: exit.reason,
        strategyId: entryPolicy.strategyId,
        policyVersion: entryPolicy.policyVersion,
        exitPolicy: entryPolicy.exitPolicy
      }
    });
    return { position: updatedPosition, closed: false, reason: exit.reason };
  }

  private executeBookExit(position: Position, book: OrderBookSnapshot, exit: ExitDecision): OverseerUpdate {
    const referencePrice = executableMarkPrice(book);
    const maxSlippage = this.exitSlippageForReason(exit.reason);
    const market = this.db.getMarketById(position.marketId);
    const feeRate = market?.feesEnabled === false
      ? 0
      : market?.takerFeeRate ?? this.config.liveExecutionFeeRatePct ?? 0;
    const order = this.executor.createExitOrder(position, this.config, referencePrice, book.tickSize, maxSlippage, feeRate);
    const simulated = this.executor.simulate(order, book);
    this.db.savePaperOrder(simulated.order);
    if (simulated.fill) this.db.saveFill(simulated.fill);

    if (simulated.order.status === "FILLED" && simulated.fill) {
      const closedPosition = this.closePosition(position, simulated.fill.price, exit, false, referencePrice, simulated.fill.feeUsd ?? 0);
      return { position: closedPosition, closed: true, reason: exit.reason };
    }
    if (simulated.order.status === "PARTIAL" && simulated.fill) {
      const remainingSize = Math.max(0, position.size - simulated.fill.size);
      const realizedPnl = position.realizedPnl + (simulated.fill.price - position.avgEntryPrice) * simulated.fill.size - (simulated.fill.feeUsd ?? 0);
      const updatedPosition: Position = {
        ...position,
        size: remainingSize,
        currentPrice: referencePrice,
        realizedPnl,
        updatedAt: Date.now(),
        status: remainingSize <= 0 ? "CLOSED" : "OPEN"
      };
      this.db.savePosition(updatedPosition);
      this.events.write({
        type: "trade.exit_partial",
        agent: "Overseer Agent",
        visibility: "PUBLIC",
        message: `Partially exited ${position.outcome} position: ${exit.reason}.`,
        payload: {
          positionId: position.id,
          marketId: position.marketId,
          outcome: position.outcome,
          filledShares: simulated.fill.size,
          remainingShares: remainingSize,
          realizedPnl,
          reason: exit.reason,
          executionPolicy: simulated.order.executionPolicy,
          limitPrice: simulated.order.price,
          maxSlippage
        }
      });
      return { position: updatedPosition, closed: updatedPosition.status === "CLOSED", reason: `partial exit: ${exit.reason}` };
    }

    const updatedPosition: Position = {
      ...position,
      currentPrice: referencePrice,
      updatedAt: Date.now()
    };
    this.db.savePosition(updatedPosition);
    this.events.write({
      type: "trade.exit_missed",
      agent: "Overseer Agent",
      visibility: "PUBLIC",
      message: `Exit order did not fill for ${position.outcome}.`,
      payload: {
        positionId: position.id,
        marketId: position.marketId,
        outcome: position.outcome,
        reason: exit.reason,
        orderStatus: simulated.order.status,
        missedReason: simulated.order.missedReason,
        partialFillReason: simulated.order.partialFillReason,
        executionPolicy: simulated.order.executionPolicy,
        limitPrice: simulated.order.price,
        maxSlippage
      }
    });
    return {
      position: updatedPosition,
      closed: false,
      reason: simulated.order.missedReason ?? simulated.order.partialFillReason ?? `exit ${simulated.order.status.toLowerCase()}`
    };
  }

  private noBookFallbackExit(
    position: Position,
    sourceExit: { sourceSold: boolean; sellerCount: number; sourceCount: number },
    now = Date.now()
  ): { price: number; decision: ExitDecision } | undefined {
    const market = this.db.getMarketById(position.marketId);
    const resolvedPrice = resolvedPositionPrice(position, market);
    if (resolvedPrice !== undefined) {
      return {
        price: resolvedPrice,
        decision: { decision: "FULL_EXIT", exitProbability: 100, reason: "resolved market outcome" }
      };
    }

    if (sourceExit.sourceSold) {
      const sellerText = sourceExit.sellerCount >= 2 ? `${sourceExit.sellerCount} source wallets exiting` : "source wallet exiting";
      return {
        price: position.currentPrice,
        decision: { decision: "FULL_EXIT", exitProbability: 100, reason: `${sellerText}; no fresh order book` }
      };
    }

    const noBookCloseAfterMs = this.config.noBookPositionCloseAfterMs ?? 2 * 60 * 60 * 1000;
    if (noBookCloseAfterMs > 0 && now - position.openedAt >= noBookCloseAfterMs) {
      return {
        price: position.currentPrice,
        decision: { decision: "FULL_EXIT", exitProbability: 100, reason: "no fresh order book timeout" }
      };
    }

    const holdHours = (now - position.openedAt) / 3_600_000;
    if (this.config.maxPositionHoldHours > 0 && holdHours >= this.config.maxPositionHoldHours) {
      return {
        price: position.currentPrice,
        decision: { decision: "FULL_EXIT", exitProbability: 100, reason: "max hold time reached without fresh order book" }
      };
    }

    if (market && (!market.active || market.closed || market.archived || !market.acceptingOrders)) {
      return {
        price: position.currentPrice,
        decision: { decision: "FULL_EXIT", exitProbability: 90, reason: "market no longer tradeable without fresh order book" }
      };
    }

    return undefined;
  }

  private noBidFallbackExit(
    position: Position,
    sourceExit: { sourceSold: boolean; sellerCount: number; sourceCount: number },
    now = Date.now()
  ): { price: number; decision: ExitDecision } | undefined {
    if (sourceExit.sourceSold) {
      const sellerText = sourceExit.sellerCount >= 2 ? `${sourceExit.sellerCount} source wallets exiting` : "source wallet exiting";
      return {
        price: 0,
        decision: { decision: "FULL_EXIT", exitProbability: 100, reason: `${sellerText}; no executable bid` }
      };
    }

    const noBidCloseAfterMs = this.config.noBidPositionCloseAfterMs ?? 30 * 60 * 1000;
    if (noBidCloseAfterMs > 0 && now - position.openedAt >= noBidCloseAfterMs) {
      return {
        price: 0,
        decision: { decision: "FULL_EXIT", exitProbability: 100, reason: "no executable bid timeout" }
      };
    }

    return undefined;
  }

  private exitRetrySuppression(
    position: Position,
    exit: ExitDecision,
    sourceExit: { sourceSold: boolean; sellerCount: number; sourceCount: number },
    now = Date.now()
  ): { reason: string; lastOrder: PaperOrder; retryCooldownMs: number; recentExitMisses: number } | undefined {
    const retryCooldownMs = this.config.exitRetryCooldownMs ?? 5 * 60 * 1000;
    if (retryCooldownMs <= 0 || sourceExit.sourceSold) return undefined;
    if (!/take profit|stop loss|no executable bid|price reversal|spread widened|max hold/i.test(exit.reason)) return undefined;
    const lastOrder = this.db.getLatestPaperExitOrder(position.id);
    if (!lastOrder || lastOrder.status === "FILLED") return undefined;
    const ageMs = now - lastOrder.createdAt;
    if (ageMs >= retryCooldownMs) return undefined;
    const waitMs = Math.max(0, retryCooldownMs - ageMs);
    const recentExitMisses = this.db.countRecentPaperExitMisses(position.id, now - 24 * 3_600_000);
    return {
      reason: `exit retry cooling down after ${lastOrder.status.toLowerCase()} ${lastOrder.executionPolicy ?? "paper"} order; retry in ${Math.ceil(waitMs / 1000)}s`,
      lastOrder,
      retryCooldownMs,
      recentExitMisses
    };
  }

  private exitDepthSuppression(position: Position, book: OrderBookSnapshot, exit: ExitDecision, now = Date.now()): OverseerUpdate | undefined {
    if (book.bestBid === undefined || book.bids.length > 0) return undefined;
    const updatedPosition: Position = {
      ...position,
      currentPrice: executableMarkPrice(book),
      updatedAt: now
    };
    this.db.savePosition(updatedPosition);
    this.events.write({
      type: "trade.exit_suppressed",
      agent: "Overseer Agent",
      visibility: "PRIVATE",
      message: `Exit waiting for fresh bid depth for ${position.outcome}.`,
      payload: {
        positionId: position.id,
        marketId: position.marketId,
        outcome: position.outcome,
        reason: exit.reason,
        suppressedReason: "waiting for fresh executable bid depth",
        bestBid: book.bestBid,
        bestAsk: book.bestAsk,
        bookTimestamp: book.timestamp
      }
    });
    return {
      position: updatedPosition,
      closed: false,
      reason: "waiting for fresh executable bid depth"
    };
  }

  private exitSlippageForReason(reason: string): number {
    const base = this.config.maxExitSlippage ?? this.config.maxEntrySlippage ?? 0.03;
    if (/take profit/i.test(reason)) return this.config.takeProfitExitSlippage ?? base;
    if (/source wallet|source wallets|stop loss|no executable bid|price reversal|spread widened|max hold|no fresh order book|market no longer/i.test(reason)) {
      return this.config.urgentExitSlippage ?? base;
    }
    return base;
  }

  private closePosition(
    position: Position,
    price: number,
    exit: ExitDecision,
    saveExitDecision = true,
    expectedExitPrice = price,
    exitFeeUsd = 0
  ): Position {
    if (saveExitDecision) {
      this.db.saveExitDecision(position.id, exit, {
        bestBid: price,
        entryPrice: position.avgEntryPrice,
        size: position.size
      });
    }
    const closedPosition: Position = {
      ...position,
      currentPrice: price,
      realizedPnl: position.realizedPnl + (price - position.avgEntryPrice) * position.size - exitFeeUsd,
      updatedAt: Date.now(),
      status: "CLOSED"
    };
    this.db.savePosition(closedPosition);
    this.db.updateParityExit(closedPosition, expectedExitPrice);
    this.events.write({
      type: "trade.closed",
      agent: "Overseer Agent",
      visibility: "PUBLIC",
      message: `Closed ${position.outcome} position: ${exit.reason}.`,
      payload: {
        positionId: position.id,
        marketId: position.marketId,
        outcome: position.outcome,
        realizedPnl: closedPosition.realizedPnl,
        exitFeeUsd,
        reason: exit.reason
      }
    });
    return closedPosition;
  }
}

function resolvedPositionPrice(position: Position, market?: MarketSnapshot): number | undefined {
  if (!market?.resolved || !market.winningOutcome) return undefined;
  return market.winningOutcome.trim().toLowerCase() === position.outcome.trim().toLowerCase() ? 1 : 0;
}

function executableMarkPrice(book: OrderBookSnapshot): number {
  return book.bestBid ?? 0;
}
