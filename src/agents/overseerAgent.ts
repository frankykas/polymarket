import type { BotDatabase } from "../db.js";
import { decideExit } from "../engines.js";
import type { AgentEventWriter } from "../events/eventWriter.js";
import type { BotConfig, OrderBookSnapshot, Position } from "../types.js";

export interface OverseerUpdate {
  position: Position;
  closed: boolean;
  reason: string;
}

export class OverseerAgent {
  constructor(
    private db: BotDatabase,
    private events: AgentEventWriter,
    private config: BotConfig
  ) {}

  monitor(orderBooks: Map<string, OrderBookSnapshot>): OverseerUpdate[] {
    const updates: OverseerUpdate[] = [];
    for (const position of this.db.getOpenPositions()) {
      const book = orderBooks.get(position.tokenId);
      if (!book) continue;
      const sourceExit = this.config.sourceExitEnabled === false
        ? { sourceSold: false, sellerCount: 0, sourceCount: 0 }
        : this.db.getPositionSourceExit(position);
      const exit = decideExit(position, book, this.config, {
        trackedWalletReducing: sourceExit.sourceSold,
        sourceSellerCount: sourceExit.sellerCount,
        sourceCount: sourceExit.sourceCount
      });
      this.db.saveExitDecision(position.id, exit);
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
        const currentPrice = book.bestBid ?? position.currentPrice;
        const closedPosition: Position = {
          ...position,
          currentPrice,
          realizedPnl: (currentPrice - position.avgEntryPrice) * position.size,
          updatedAt: Date.now(),
          status: "CLOSED"
        };
        this.db.savePosition(closedPosition);
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
            reason: exit.reason
          }
        });
        updates.push({ position: closedPosition, closed: true, reason: exit.reason });
      } else {
        const updatedPosition: Position = {
          ...position,
          currentPrice: book.bestBid ?? book.lastTradePrice ?? position.currentPrice,
          updatedAt: Date.now()
        };
        this.db.savePosition(updatedPosition);
        updates.push({ position: updatedPosition, closed: false, reason: exit.reason });
      }
    }
    return updates;
  }
}
