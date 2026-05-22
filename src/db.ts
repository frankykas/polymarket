import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentEvent,
  DiscoveredWallet,
  ExitDecision,
  MarketSnapshot,
  OrderBookSnapshot,
  PaperFill,
  PaperOrder,
  PerformanceReport,
  Position,
  RiskDecision,
  TradeSignal,
  TrackedWallet,
  WalletScore,
  WalletTrade
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
        copyability_score REAL,
        hot_score REAL,
        category_consistency_score REAL,
        sample_confidence REAL,
        dominant_category TEXT,
        trade_count INTEGER NOT NULL,
        recent_trade_count INTEGER NOT NULL,
        reliability TEXT NOT NULL,
        flags_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS discovered_wallets (
        address TEXT PRIMARY KEY,
        score REAL NOT NULL,
        copyability_score REAL NOT NULL DEFAULT 0,
        hot_score REAL NOT NULL DEFAULT 0,
        category_consistency_score REAL NOT NULL DEFAULT 0,
        exit_behavior_score REAL NOT NULL DEFAULT 0,
        sample_confidence REAL NOT NULL DEFAULT 0,
        dominant_category TEXT NOT NULL DEFAULT 'other',
        trade_count INTEGER NOT NULL,
        buy_count INTEGER NOT NULL,
        sell_count INTEGER NOT NULL,
        unique_markets INTEGER NOT NULL,
        total_volume REAL NOT NULL,
        avg_trade_size REAL NOT NULL,
        realized_pnl_approx REAL NOT NULL,
        profit_factor_approx REAL NOT NULL,
        win_rate_approx REAL NOT NULL DEFAULT 0,
        avg_return_pct_approx REAL NOT NULL DEFAULT 0,
        max_drawdown_approx REAL NOT NULL DEFAULT 0,
        avg_hold_minutes_approx REAL NOT NULL DEFAULT 0,
        open_position_count INTEGER NOT NULL DEFAULT 0,
        open_position_value REAL NOT NULL DEFAULT 0,
        open_position_pnl_approx REAL NOT NULL DEFAULT 0,
        flags_json TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
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
        resolved INTEGER NOT NULL DEFAULT 0,
        winning_outcome TEXT,
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
      CREATE TABLE IF NOT EXISTS agent_events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        agent TEXT NOT NULL,
        visibility TEXT NOT NULL,
        message TEXT NOT NULL,
        payload_json TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wallet_trades (
        id TEXT PRIMARY KEY,
        wallet TEXT NOT NULL,
        market_id TEXT NOT NULL,
        condition_id TEXT,
        token_id TEXT,
        outcome TEXT NOT NULL,
        side TEXT NOT NULL,
        price REAL NOT NULL,
        size REAL NOT NULL,
        timestamp INTEGER NOT NULL,
        raw_json TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_wallet_trades_wallet_time ON wallet_trades (wallet, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_wallet_trades_market ON wallet_trades (market_id);
      CREATE TABLE IF NOT EXISTS source_score_snapshots (
        id TEXT PRIMARY KEY,
        wallet TEXT NOT NULL,
        score REAL NOT NULL,
        copyability_score REAL,
        hot_score REAL,
        category_consistency_score REAL,
        sample_confidence REAL,
        dominant_category TEXT,
        resolved_markets INTEGER NOT NULL DEFAULT 0,
        resolved_wins INTEGER NOT NULL DEFAULT 0,
        resolved_losses INTEGER NOT NULL DEFAULT 0,
        resolved_win_rate REAL NOT NULL DEFAULT 0,
        trade_count INTEGER NOT NULL,
        reliability TEXT NOT NULL,
        flags_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    this.ensureDiscoveredWalletColumns();
    this.ensureWalletScoreColumns();
    this.ensureMarketColumns();
  }

  private ensureDiscoveredWalletColumns(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(discovered_wallets)").all() as Array<{ name: string }>).map((column) => column.name)
    );
    const missing: Array<[string, string]> = [
      ["copyability_score", "REAL NOT NULL DEFAULT 0"],
      ["hot_score", "REAL NOT NULL DEFAULT 0"],
      ["category_consistency_score", "REAL NOT NULL DEFAULT 0"],
      ["exit_behavior_score", "REAL NOT NULL DEFAULT 0"],
      ["sample_confidence", "REAL NOT NULL DEFAULT 0"],
      ["dominant_category", "TEXT NOT NULL DEFAULT 'other'"],
      ["win_rate_approx", "REAL NOT NULL DEFAULT 0"],
      ["avg_return_pct_approx", "REAL NOT NULL DEFAULT 0"],
      ["max_drawdown_approx", "REAL NOT NULL DEFAULT 0"],
      ["avg_hold_minutes_approx", "REAL NOT NULL DEFAULT 0"],
      ["open_position_count", "INTEGER NOT NULL DEFAULT 0"],
      ["open_position_value", "REAL NOT NULL DEFAULT 0"],
      ["open_position_pnl_approx", "REAL NOT NULL DEFAULT 0"],
      ["resolved_markets", "INTEGER NOT NULL DEFAULT 0"],
      ["resolved_wins", "INTEGER NOT NULL DEFAULT 0"],
      ["resolved_losses", "INTEGER NOT NULL DEFAULT 0"],
      ["resolved_win_rate", "REAL NOT NULL DEFAULT 0"]
    ];
    for (const [name, definition] of missing) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE discovered_wallets ADD COLUMN ${name} ${definition}`);
    }
  }

  private ensureWalletScoreColumns(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(wallet_scores)").all() as Array<{ name: string }>).map((column) => column.name)
    );
    const missing: Array<[string, string]> = [
      ["copyability_score", "REAL"],
      ["hot_score", "REAL"],
      ["category_consistency_score", "REAL"],
      ["sample_confidence", "REAL"],
      ["dominant_category", "TEXT"],
      ["resolved_markets", "INTEGER"],
      ["resolved_wins", "INTEGER"],
      ["resolved_losses", "INTEGER"],
      ["resolved_win_rate", "REAL"]
    ];
    for (const [name, definition] of missing) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE wallet_scores ADD COLUMN ${name} ${definition}`);
    }
  }

  private ensureMarketColumns(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(markets)").all() as Array<{ name: string }>).map((column) => column.name)
    );
    const missing: Array<[string, string]> = [
      ["resolved", "INTEGER NOT NULL DEFAULT 0"],
      ["winning_outcome", "TEXT"]
    ];
    for (const [name, definition] of missing) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE markets ADD COLUMN ${name} ${definition}`);
    }
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
      (wallet, label, score, copyability_score, hot_score, category_consistency_score, sample_confidence, dominant_category,
       resolved_markets, resolved_wins, resolved_losses, resolved_win_rate, trade_count, recent_trade_count, reliability, flags_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      score.wallet,
      score.label ?? null,
      score.score,
      score.copyabilityScore ?? null,
      score.hotScore ?? null,
      score.categoryConsistencyScore ?? null,
      score.sampleConfidence ?? null,
      score.dominantCategory ?? null,
      score.resolvedMarkets ?? null,
      score.resolvedWins ?? null,
      score.resolvedLosses ?? null,
      score.resolvedWinRate ?? null,
      score.tradeCount,
      score.recentTradeCount,
      score.reliability,
      JSON.stringify(score.flags),
      score.updatedAt
    );
    this.saveSourceScoreSnapshot(score);
  }

  saveDiscoveredWallet(wallet: DiscoveredWallet): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO discovered_wallets
      (address, score, copyability_score, hot_score, category_consistency_score, exit_behavior_score, sample_confidence,
       dominant_category, trade_count, buy_count, sell_count, unique_markets, total_volume, avg_trade_size,
       realized_pnl_approx, profit_factor_approx, win_rate_approx, avg_return_pct_approx, max_drawdown_approx,
       avg_hold_minutes_approx, open_position_count, open_position_value, open_position_pnl_approx,
       resolved_markets, resolved_wins, resolved_losses, resolved_win_rate, flags_json, first_seen_at, last_seen_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      wallet.address,
      wallet.score,
      wallet.copyabilityScore,
      wallet.hotScore,
      wallet.categoryConsistencyScore,
      wallet.exitBehaviorScore,
      wallet.sampleConfidence,
      wallet.dominantCategory,
      wallet.tradeCount,
      wallet.buyCount,
      wallet.sellCount,
      wallet.uniqueMarkets,
      wallet.totalVolume,
      wallet.avgTradeSize,
      wallet.realizedPnlApprox,
      wallet.profitFactorApprox,
      wallet.winRateApprox,
      wallet.avgReturnPctApprox,
      wallet.maxDrawdownApprox,
      wallet.avgHoldMinutesApprox,
      wallet.openPositionCount,
      wallet.openPositionValue,
      wallet.openPositionPnlApprox,
      wallet.resolvedMarkets,
      wallet.resolvedWins,
      wallet.resolvedLosses,
      wallet.resolvedWinRate,
      JSON.stringify(wallet.flags),
      wallet.firstSeenAt,
      wallet.lastSeenAt,
      Date.now()
    );
  }

  getTopDiscoveredWallets(limit: number): DiscoveredWallet[] {
    const rows = this.db.prepare(`
      SELECT * FROM discovered_wallets
      ORDER BY copyability_score DESC, score DESC, total_volume DESC
      LIMIT ?
    `).all(limit) as unknown as DbDiscoveredWallet[];
    return rows.map(rowToDiscoveredWallet);
  }

  saveMarket(market: MarketSnapshot): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO markets
      (id, condition_id, question, active, closed, archived, accepting_orders, liquidity, volume_24h,
       resolved, winning_outcome, outcomes_json, clob_token_ids_json, raw_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      market.resolved ? 1 : 0,
      market.winningOutcome ?? null,
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

  getPerformanceReport(): PerformanceReport {
    const openRows = this.db.prepare("SELECT * FROM positions WHERE status = 'OPEN'").all() as unknown as DbPosition[];
    const closedRows = this.db.prepare("SELECT * FROM positions WHERE status = 'CLOSED'").all() as unknown as DbPosition[];
    const paperOrders = this.count("paper_orders");
    const paperFills = this.count("paper_fills");
    const signals = this.count("signals");
    const approvedSignals = this.count("paper_orders");
    const realizedPnl = closedRows.reduce((sum, row) => sum + row.realized_pnl, 0);
    const unrealizedPnl = openRows.reduce((sum, row) => sum + (row.current_price - row.avg_entry_price) * row.size, 0);
    const wins = closedRows.filter((row) => row.realized_pnl > 0).length;
    const losses = closedRows.filter((row) => row.realized_pnl < 0).length;
    return {
      openPositions: openRows.length,
      closedPositions: closedRows.length,
      realizedPnl,
      unrealizedPnl,
      totalPnl: realizedPnl + unrealizedPnl,
      wins,
      losses,
      winRate: wins + losses > 0 ? wins / (wins + losses) : 0,
      paperOrders,
      paperFills,
      signals,
      approvedSignals
    };
  }

  private count(table: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as { count: number };
    return Number(row.count ?? 0);
  }

  log(level: "INFO" | "WARN" | "ERROR", message: string, payload?: unknown): void {
    this.db.prepare(`
      INSERT INTO bot_run_logs (level, message, payload_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(level, message, payload === undefined ? null : JSON.stringify(payload), Date.now());
  }

  saveAgentEvent(event: AgentEvent): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO agent_events
      (id, type, agent, visibility, message, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.type,
      event.agent,
      event.visibility,
      event.message,
      event.payload === undefined ? null : JSON.stringify(event.payload),
      event.createdAt
    );
  }

  getRecentAgentEvents(limit: number, visibility?: AgentEvent["visibility"]): AgentEvent[] {
    const rows = (visibility
      ? this.db.prepare("SELECT * FROM agent_events WHERE visibility = ? ORDER BY created_at DESC LIMIT ?").all(visibility, limit)
      : this.db.prepare("SELECT * FROM agent_events ORDER BY created_at DESC LIMIT ?").all(limit)) as unknown as DbAgentEvent[];
    return rows.map(rowToAgentEvent);
  }

  saveWalletTrades(trades: WalletTrade[]): number {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO wallet_trades
      (id, wallet, market_id, condition_id, token_id, outcome, side, price, size, timestamp, raw_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let inserted = 0;
    const now = Date.now();
    for (const trade of trades) {
      const result = stmt.run(
        walletTradeId(trade),
        trade.wallet.toLowerCase(),
        trade.marketId,
        trade.conditionId ?? null,
        trade.tokenId ?? null,
        trade.outcome,
        trade.side,
        trade.price,
        trade.size,
        trade.timestamp,
        JSON.stringify(trade.raw ?? null),
        now
      );
      inserted += Number(result.changes ?? 0);
    }
    return inserted;
  }

  getWalletTradeHistory(wallet: string, limit: number): WalletTrade[] {
    const rows = this.db.prepare(`
      SELECT * FROM wallet_trades
      WHERE wallet = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(wallet.toLowerCase(), limit) as unknown as DbWalletTrade[];
    return rows.map(rowToWalletTrade).sort((a, b) => a.timestamp - b.timestamp);
  }

  private saveSourceScoreSnapshot(score: WalletScore): void {
    this.db.prepare(`
      INSERT INTO source_score_snapshots
      (id, wallet, score, copyability_score, hot_score, category_consistency_score, sample_confidence, dominant_category,
       resolved_markets, resolved_wins, resolved_losses, resolved_win_rate, trade_count, reliability, flags_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomId("score"),
      score.wallet,
      score.score,
      score.copyabilityScore ?? null,
      score.hotScore ?? null,
      score.categoryConsistencyScore ?? null,
      score.sampleConfidence ?? null,
      score.dominantCategory ?? null,
      score.resolvedMarkets ?? 0,
      score.resolvedWins ?? 0,
      score.resolvedLosses ?? 0,
      score.resolvedWinRate ?? 0,
      score.tradeCount,
      score.reliability,
      JSON.stringify(score.flags),
      score.updatedAt
    );
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

interface DbDiscoveredWallet {
  address: string;
  score: number;
  copyability_score: number;
  hot_score: number;
  category_consistency_score: number;
  exit_behavior_score: number;
  sample_confidence: number;
  dominant_category: DiscoveredWallet["dominantCategory"];
  trade_count: number;
  buy_count: number;
  sell_count: number;
  unique_markets: number;
  total_volume: number;
  avg_trade_size: number;
  realized_pnl_approx: number;
  profit_factor_approx: number;
  win_rate_approx: number;
  avg_return_pct_approx: number;
  max_drawdown_approx: number;
  avg_hold_minutes_approx: number;
  open_position_count: number;
  open_position_value: number;
  open_position_pnl_approx: number;
  resolved_markets: number;
  resolved_wins: number;
  resolved_losses: number;
  resolved_win_rate: number;
  flags_json: string;
  first_seen_at: number;
  last_seen_at: number;
}

interface DbWalletTrade {
  wallet: string;
  market_id: string;
  condition_id: string | null;
  token_id: string | null;
  outcome: string;
  side: WalletTrade["side"];
  price: number;
  size: number;
  timestamp: number;
  raw_json: string | null;
}

interface DbAgentEvent {
  id: string;
  type: string;
  agent: AgentEvent["agent"];
  visibility: AgentEvent["visibility"];
  message: string;
  payload_json: string | null;
  created_at: number;
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

function rowToDiscoveredWallet(row: DbDiscoveredWallet): DiscoveredWallet {
  return {
    address: row.address,
    score: row.score,
    copyabilityScore: row.copyability_score,
    hotScore: row.hot_score,
    categoryConsistencyScore: row.category_consistency_score,
    exitBehaviorScore: row.exit_behavior_score,
    sampleConfidence: row.sample_confidence,
    dominantCategory: row.dominant_category,
    tradeCount: row.trade_count,
    buyCount: row.buy_count,
    sellCount: row.sell_count,
    uniqueMarkets: row.unique_markets,
    totalVolume: row.total_volume,
    avgTradeSize: row.avg_trade_size,
    realizedPnlApprox: row.realized_pnl_approx,
    profitFactorApprox: row.profit_factor_approx,
    winRateApprox: row.win_rate_approx,
    avgReturnPctApprox: row.avg_return_pct_approx,
    maxDrawdownApprox: row.max_drawdown_approx,
    avgHoldMinutesApprox: row.avg_hold_minutes_approx,
    openPositionCount: row.open_position_count,
    openPositionValue: row.open_position_value,
    openPositionPnlApprox: row.open_position_pnl_approx,
    resolvedMarkets: row.resolved_markets,
    resolvedWins: row.resolved_wins,
    resolvedLosses: row.resolved_losses,
    resolvedWinRate: row.resolved_win_rate,
    flags: JSON.parse(row.flags_json) as string[],
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at
  };
}

function rowToWalletTrade(row: DbWalletTrade): WalletTrade {
  return {
    wallet: row.wallet,
    marketId: row.market_id,
    conditionId: row.condition_id ?? undefined,
    tokenId: row.token_id ?? undefined,
    outcome: row.outcome,
    side: row.side,
    price: row.price,
    size: row.size,
    timestamp: row.timestamp,
    raw: row.raw_json ? JSON.parse(row.raw_json) as unknown : undefined
  };
}

function walletTradeId(trade: WalletTrade): string {
  return [
    trade.wallet.toLowerCase(),
    trade.marketId,
    trade.conditionId ?? "",
    trade.tokenId ?? "",
    trade.outcome,
    trade.side,
    trade.price,
    trade.size,
    trade.timestamp
  ].join("|");
}

function rowToAgentEvent(row: DbAgentEvent): AgentEvent {
  return {
    id: row.id,
    type: row.type,
    agent: row.agent,
    visibility: row.visibility,
    message: row.message,
    payload: row.payload_json ? JSON.parse(row.payload_json) as unknown : undefined,
    createdAt: row.created_at
  };
}

export function randomId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
