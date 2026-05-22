import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ExitDecision,
  MarketSnapshot,
  OrderBookSnapshot,
  PaperFill,
  PaperOrder,
  Position,
  RiskDecision,
  TradeSignal,
  TrackedWallet,
  WalletScore
} from "./types.js";

export class BotDatabase {
  private db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.init();
  }

  close(): void {
    this.db.close();
  }

  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tracked_wallets (
        address TEXT PRIMARY KEY,
        label TEXT,
        enabled INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wallet_scores (
        wallet TEXT PRIMARY KEY,
        label TEXT,
        score REAL NOT NULL,
        trade_count INTEGER NOT NULL,
        recent_trade_count INTEGER NOT NULL,
        reliability TEXT NOT NULL,
        flags_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS markets (
        id TEXT PRIMARY KEY,
        condition_id TEXT,
        question TEXT NOT NULL,
        active INTEGER NOT NULL,
        closed INTEGER NOT NULL,
        archived INTEGER NOT NULL,
        accepting_orders INTEGER NOT NULL,
        liquidity REAL NOT NULL,
        volume_24h REAL NOT NULL,
        outcomes_json TEXT NOT NULL,
        clob_token_ids_json TEXT NOT NULL,
        raw_json TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS orderbook_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_id TEXT NOT NULL,
        market_id TEXT,
        best_bid REAL,
        best_ask REAL,
        spread REAL,
        depth REAL NOT NULL,
        raw_json TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS signals (
        id TEXT PRIMARY KEY,
        decision TEXT NOT NULL,
        market_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        side TEXT NOT NULL,
        confidence REAL NOT NULL,
        limit_price REAL NOT NULL,
        aligned_wallets_json TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS paper_orders (
        id TEXT PRIMARY KEY,
        signal_id TEXT NOT NULL,
        market_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        side TEXT NOT NULL,
        price REAL NOT NULL,
        size REAL NOT NULL,
        remaining_size REAL NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS paper_fills (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        market_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        side TEXT NOT NULL,
        price REAL NOT NULL,
        size REAL NOT NULL,
        timestamp INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS positions (
        id TEXT PRIMARY KEY,
        market_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        size REAL NOT NULL,
        avg_entry_price REAL NOT NULL,
        current_price REAL NOT NULL,
        realized_pnl REAL NOT NULL,
        opened_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS risk_events (
        id TEXT PRIMARY KEY,
        decision TEXT NOT NULL,
        position_size REAL NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS exit_events (
        id TEXT PRIMARY KEY,
        position_id TEXT NOT NULL,
        decision TEXT NOT NULL,
        exit_probability REAL NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bot_run_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        payload_json TEXT,
        created_at INTEGER NOT NULL
      );
    `);
  }

  syncWallets(wallets: TrackedWallet[]): void {
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO tracked_wallets (address, label, enabled, updated_at) VALUES (?, ?, ?, ?)"
    );
    const now = Date.now();
    for (const wallet of wallets) stmt.run(wallet.address, wallet.label ?? null, wallet.enabled ? 1 : 0, now);
  }

  saveWalletScore(score: WalletScore): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO wallet_scores
      (wallet, label, score, trade_count, recent_trade_count, reliability, flags_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      score.wallet,
      score.label ?? null,
      score.score,
      score.tradeCount,
      score.recentTradeCount,
      score.reliability,
      JSON.stringify(score.flags),
      score.updatedAt
    );
  }

  saveMarket(market: MarketSnapshot): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO markets
      (id, condition_id, question, active, closed, archived, accepting_orders, liquidity, volume_24h,
       outcomes_json, clob_token_ids_json, raw_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      market.id,
      market.conditionId ?? null,
      market.question,
      market.active ? 1 : 0,
      market.closed ? 1 : 0,
      market.archived ? 1 : 0,
      market.acceptingOrders ? 1 : 0,
      market.liquidity,
      market.volume24h,
      JSON.stringify(market.outcomes),
      JSON.stringify(market.clobTokenIds),
      JSON.stringify(market.raw ?? null),
      Date.now()
    );
  }

  saveOrderBook(book: OrderBookSnapshot): void {
    this.db.prepare(`
      INSERT INTO orderbook_snapshots
      (token_id, market_id, best_bid, best_ask, spread, depth, raw_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      book.tokenId,
      book.marketId ?? null,
      book.bestBid ?? null,
      book.bestAsk ?? null,
      book.spread ?? null,
      book.depth,
      JSON.stringify(book.raw ?? null),
      book.timestamp
    );
  }

  saveSignal(signal: TradeSignal): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO signals
      (id, decision, market_id, token_id, outcome, side, confidence, limit_price, aligned_wallets_json, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      signal.id,
      signal.decision,
      signal.marketId,
      signal.tokenId,
      signal.outcome,
      signal.side,
      signal.confidence,
      signal.limitPrice,
      JSON.stringify(signal.alignedWallets),
      signal.reason,
      signal.createdAt
    );
  }

  saveRiskDecision(decision: RiskDecision): void {
    this.db.prepare(`
      INSERT INTO risk_events (id, decision, position_size, reason, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(randomId("risk"), decision.decision, decision.positionSize, decision.reason, Date.now());
  }

  savePaperOrder(order: PaperOrder): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO paper_orders
      (id, signal_id, market_id, token_id, outcome, side, price, size, remaining_size, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      order.id,
      order.signalId,
      order.marketId,
      order.tokenId,
      order.outcome,
      order.side,
      order.price,
      order.size,
      order.remainingSize,
      order.status,
      order.createdAt,
      order.expiresAt
    );
  }

  saveFill(fill: PaperFill): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO paper_fills
      (id, order_id, market_id, token_id, side, price, size, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(fill.id, fill.orderId, fill.marketId, fill.tokenId, fill.side, fill.price, fill.size, fill.timestamp);
  }

  savePosition(position: Position): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO positions
      (id, market_id, token_id, outcome, size, avg_entry_price, current_price, realized_pnl, opened_at, updated_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      position.id,
      position.marketId,
      position.tokenId,
      position.outcome,
      position.size,
      position.avgEntryPrice,
      position.currentPrice,
      position.realizedPnl,
      position.openedAt,
      position.updatedAt,
      position.status
    );
  }

  saveExitDecision(positionId: string, exit: ExitDecision): void {
    this.db.prepare(`
      INSERT INTO exit_events (id, position_id, decision, exit_probability, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomId("exit"), positionId, exit.decision, exit.exitProbability, exit.reason, Date.now());
  }

  getOpenExposure(): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(size * current_price), 0) as exposure FROM positions WHERE status = 'OPEN'").get() as { exposure: number };
    return Number(row.exposure ?? 0);
  }

  getDailyRealizedPnl(): number {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const row = this.db.prepare("SELECT COALESCE(SUM(realized_pnl), 0) as pnl FROM positions WHERE updated_at >= ?").get(start.getTime()) as { pnl: number };
    return Number(row.pnl ?? 0);
  }

  getOpenPositions(): Position[] {
    const rows = this.db.prepare("SELECT * FROM positions WHERE status = 'OPEN'").all() as unknown as DbPosition[];
    return rows.map(rowToPosition);
  }

  log(level: "INFO" | "WARN" | "ERROR", message: string, payload?: unknown): void {
    this.db.prepare(`
      INSERT INTO bot_run_logs (level, message, payload_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(level, message, payload === undefined ? null : JSON.stringify(payload), Date.now());
  }
}

interface DbPosition {
  id: string;
  market_id: string;
  token_id: string;
  outcome: string;
  size: number;
  avg_entry_price: number;
  current_price: number;
  realized_pnl: number;
  opened_at: number;
  updated_at: number;
  status: "OPEN" | "CLOSED";
}

function rowToPosition(row: DbPosition): Position {
  return {
    id: row.id,
    marketId: row.market_id,
    tokenId: row.token_id,
    outcome: row.outcome,
    size: row.size,
    avgEntryPrice: row.avg_entry_price,
    currentPrice: row.current_price,
    realizedPnl: row.realized_pnl,
    openedAt: row.opened_at,
    updatedAt: row.updated_at,
    status: row.status
  };
}

export function randomId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
