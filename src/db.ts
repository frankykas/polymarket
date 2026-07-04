import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentEvent,
  CapitalLockupReport,
  DiscoveredWallet,
  ExitDecision,
  ExposureHealthReport,
  MarketSnapshot,
  AgentThroughputPoint,
  OrderHealthTrendPoint,
  OrderBookSnapshot,
  PaperFill,
  PaperOrder,
  PaperTradeLedgerEntry,
  PaperSourceFeedbackSummary,
  PaperSourcePerformance,
  PerformanceReport,
  Position,
  ReconstructedSourcePosition,
  ProfilePerformanceReport,
  OrderHealthReport,
  RiskDecision,
  RecentRiskEvent,
  RiskEventSummary,
  ShadowBacktestReport,
  ShadowCategorySummary,
  ShadowCategoryTrendPoint,
  SourceCategorySummary,
  ShadowTrade,
  SourceScorePoint,
  SourceScoreSummary,
  TradeSignal,
  TrackedWallet,
  WalletScore,
  WalletDegradationReport,
  WalletTrade
} from "./types.js";

export class BotDatabase {
  private db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 10000");
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
        profile TEXT,
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
        profile TEXT,
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
        signal_id TEXT,
        market_id TEXT,
        outcome TEXT,
        decision TEXT NOT NULL,
        profile TEXT,
        confidence REAL,
        risk_state TEXT,
        position_size REAL NOT NULL,
        reason TEXT NOT NULL,
        details_json TEXT,
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
        shadow_trade_count INTEGER,
        shadow_simulated INTEGER,
        shadow_realized INTEGER,
        shadow_pnl REAL,
        shadow_avg_return_pct REAL,
        shadow_win_rate REAL,
        shadow_score_impact REAL,
        trade_count INTEGER NOT NULL,
        reliability TEXT NOT NULL,
        flags_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS shadow_trades (
        id TEXT PRIMARY KEY,
        wallet TEXT NOT NULL,
        market_id TEXT NOT NULL,
        category TEXT,
        token_id TEXT,
        outcome TEXT NOT NULL,
        source_timestamp INTEGER NOT NULL,
        detected_at INTEGER NOT NULL,
        source_price REAL NOT NULL,
        simulated_entry_price REAL,
        simulated_exit_price REAL,
        size_usd REAL NOT NULL,
        pnl REAL NOT NULL,
        return_pct REAL NOT NULL,
        status TEXT NOT NULL,
        exit_reason TEXT,
        rejection_reason TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_shadow_trades_wallet ON shadow_trades (wallet);
      CREATE INDEX IF NOT EXISTS idx_shadow_trades_status ON shadow_trades (status);
      CREATE TABLE IF NOT EXISTS paper_source_feedback (
        id TEXT PRIMARY KEY,
        wallet TEXT NOT NULL,
        filled_orders INTEGER NOT NULL,
        pnl REAL NOT NULL,
        avg_return_pct REAL NOT NULL,
        score_impact REAL NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_paper_source_feedback_wallet ON paper_source_feedback (wallet, created_at DESC);
    `);
    this.ensureDiscoveredWalletColumns();
    this.ensureWalletScoreColumns();
    this.ensureSourceScoreSnapshotColumns();
    this.ensureShadowTradeColumns();
    this.ensureMarketColumns();
    this.ensureProfileColumns();
    this.ensureRiskEventColumns();
  }

  private ensureProfileColumns(): void {
    for (const [table, columnDefinition] of [
      ["paper_orders", "profile TEXT"],
      ["positions", "profile TEXT"],
      ["risk_events", "profile TEXT"]
    ] as const) {
      const columns = new Set(
        (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name)
      );
      const [name] = columnDefinition.split(" ");
      if (!columns.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDefinition}`);
    }
  }

  private ensureRiskEventColumns(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(risk_events)").all() as Array<{ name: string }>).map((column) => column.name)
    );
    const missing: Array<[string, string]> = [
      ["signal_id", "TEXT"],
      ["market_id", "TEXT"],
      ["outcome", "TEXT"],
      ["confidence", "REAL"],
      ["risk_state", "TEXT"],
      ["details_json", "TEXT"]
    ];
    for (const [name, definition] of missing) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE risk_events ADD COLUMN ${name} ${definition}`);
    }
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
      ["resolved_win_rate", "REAL"],
      ["shadow_trade_count", "INTEGER"],
      ["shadow_simulated", "INTEGER"],
      ["shadow_realized", "INTEGER"],
      ["shadow_pnl", "REAL"],
      ["shadow_avg_return_pct", "REAL"],
      ["shadow_win_rate", "REAL"],
      ["shadow_score_impact", "REAL"]
    ];
    for (const [name, definition] of missing) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE wallet_scores ADD COLUMN ${name} ${definition}`);
    }
  }

  private ensureSourceScoreSnapshotColumns(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(source_score_snapshots)").all() as Array<{ name: string }>).map((column) => column.name)
    );
    const missing: Array<[string, string]> = [
      ["shadow_trade_count", "INTEGER"],
      ["shadow_simulated", "INTEGER"],
      ["shadow_realized", "INTEGER"],
      ["shadow_pnl", "REAL"],
      ["shadow_avg_return_pct", "REAL"],
      ["shadow_win_rate", "REAL"],
      ["shadow_score_impact", "REAL"]
    ];
    for (const [name, definition] of missing) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE source_score_snapshots ADD COLUMN ${name} ${definition}`);
    }
  }

  private ensureShadowTradeColumns(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(shadow_trades)").all() as Array<{ name: string }>).map((column) => column.name)
    );
    const missing: Array<[string, string]> = [
      ["category", "TEXT"]
    ];
    for (const [name, definition] of missing) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE shadow_trades ADD COLUMN ${name} ${definition}`);
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
       resolved_markets, resolved_wins, resolved_losses, resolved_win_rate, shadow_trade_count, shadow_simulated, shadow_realized,
       shadow_pnl, shadow_avg_return_pct, shadow_win_rate, shadow_score_impact, trade_count, recent_trade_count, reliability, flags_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      score.shadowTradeCount ?? null,
      score.shadowSimulated ?? null,
      score.shadowRealized ?? null,
      score.shadowPnl ?? null,
      score.shadowAvgReturnPct ?? null,
      score.shadowWinRate ?? null,
      score.shadowScoreImpact ?? null,
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

  getMarketsByIds(ids: string[]): MarketSnapshot[] {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return [];
    const rows: DbMarket[] = [];
    for (let index = 0; index < unique.length; index += 400) {
      const chunk = unique.slice(index, index + 400);
      const placeholders = chunk.map(() => "?").join(", ");
      rows.push(...this.db.prepare(`
        SELECT * FROM markets
        WHERE id IN (${placeholders}) OR condition_id IN (${placeholders})
      `).all(...chunk, ...chunk) as unknown as DbMarket[]);
    }
    return rows.map(rowToMarket);
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

  saveRiskDecision(decision: RiskDecision, context?: {
    signalId?: string;
    marketId?: string;
    outcome?: string;
    details?: RecentRiskEvent["details"];
  }): void {
    this.db.prepare(`
      INSERT INTO risk_events
      (id, signal_id, market_id, outcome, decision, profile, confidence, risk_state, position_size, reason, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomId("risk"),
      context?.signalId ?? null,
      context?.marketId ?? null,
      context?.outcome ?? null,
      decision.decision,
      decision.profile ?? null,
      decision.confidence ?? null,
      decision.riskState ?? null,
      decision.positionSize,
      decision.reason,
      context?.details ? JSON.stringify(context.details) : null,
      Date.now()
    );
  }

  savePaperOrder(order: PaperOrder): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO paper_orders
      (id, signal_id, profile, market_id, token_id, outcome, side, price, size, remaining_size, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      order.id,
      order.signalId,
      order.profile ?? null,
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
      (id, profile, market_id, token_id, outcome, size, avg_entry_price, current_price, realized_pnl, opened_at, updated_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      position.id,
      position.profile ?? null,
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

  savePaperEntry(position: Position): Position {
    const row = this.db.prepare("SELECT * FROM positions WHERE id = ? AND status = 'OPEN'").get(position.id) as unknown as DbPosition | undefined;
    if (!row) {
      this.savePosition(position);
      return position;
    }

    const existing = rowToPosition(row);
    const combinedSize = existing.size + position.size;
    const avgEntryPrice = combinedSize > 0
      ? ((existing.avgEntryPrice * existing.size) + (position.avgEntryPrice * position.size)) / combinedSize
      : position.avgEntryPrice;
    const merged: Position = {
      ...existing,
      profile: existing.profile ?? position.profile,
      size: combinedSize,
      avgEntryPrice,
      currentPrice: position.currentPrice,
      realizedPnl: existing.realizedPnl + position.realizedPnl,
      updatedAt: position.updatedAt,
      status: "OPEN"
    };
    this.savePosition(merged);
    return merged;
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

  getExposureHealthReport(maxOpenExposure: number, bankroll = maxOpenExposure, reserveCashPct = 0): ExposureHealthReport {
    const openExposure = this.getOpenExposure();
    const activeExposureCap = Math.min(maxOpenExposure, bankroll * (1 - reserveCashPct));
    const remainingExposure = Math.max(0, activeExposureCap - openExposure);
    const usedPct = activeExposureCap > 0 ? openExposure / activeExposureCap : 0;
    return {
      maxOpenExposure,
      activeExposureCap,
      openExposure,
      remainingExposure,
      usedPct,
      status: remainingExposure <= 0 || usedPct >= 1 ? "FULL" : usedPct >= 0.85 ? "NEAR_CAP" : "AVAILABLE"
    };
  }

  getCapitalLockupReport(input: {
    bankroll: number;
    maxOpenExposure: number;
    reserveCashPct: number;
    maxTimeToResolutionHours: number;
  }): CapitalLockupReport {
    const positions = this.getOpenPositions();
    const markets = this.getMarketsByIds(positions.map((position) => position.marketId));
    const marketById = new Map<string, MarketSnapshot>();
    for (const market of markets) {
      marketById.set(market.id, market);
      if (market.conditionId) marketById.set(market.conditionId, market);
    }
    let longDatedPositions = 0;
    let longDatedCapital = 0;
    let longestResolutionHours: number | undefined;
    const now = Date.now();
    for (const position of positions) {
      const endDate = marketById.get(position.marketId)?.endDate;
      if (!endDate) continue;
      const hours = (Date.parse(endDate) - now) / 3_600_000;
      if (!Number.isFinite(hours)) continue;
      longestResolutionHours = longestResolutionHours === undefined ? hours : Math.max(longestResolutionHours, hours);
      if (hours > input.maxTimeToResolutionHours) {
        longDatedPositions += 1;
        longDatedCapital += position.size * position.currentPrice;
      }
    }
    return {
      reserveCashPct: input.reserveCashPct,
      reserveCash: input.bankroll * input.reserveCashPct,
      activeTradingCap: Math.min(input.maxOpenExposure, input.bankroll * (1 - input.reserveCashPct)),
      maxTimeToResolutionHours: input.maxTimeToResolutionHours,
      longDatedPositions,
      longDatedCapital,
      longestResolutionHours
    };
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

  getClosedPositions(limit = 20): Position[] {
    const rows = this.db.prepare(`
      SELECT * FROM positions
      WHERE status = 'CLOSED'
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(limit) as unknown as DbPosition[];
    return rows.map(rowToPosition);
  }

  getPerformanceReport(): PerformanceReport {
    const openRow = this.db.prepare(`
      SELECT
        COUNT(*) as count,
        COALESCE(SUM(avg_entry_price * size), 0) as open_cost,
        COALESCE(SUM(current_price * size), 0) as open_value,
        COALESCE(SUM((current_price - avg_entry_price) * size), 0) as unrealized_pnl
      FROM positions
      WHERE status = 'OPEN'
    `).get() as { count: number; open_cost: number; open_value: number; unrealized_pnl: number };
    const closedRow = this.db.prepare(`
      SELECT
        COUNT(*) as count,
        COALESCE(SUM(realized_pnl), 0) as realized_pnl,
        SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END) as losses
      FROM positions
      WHERE status = 'CLOSED'
    `).get() as { count: number; realized_pnl: number; wins: number | null; losses: number | null };
    const paperOrders = this.count("paper_orders");
    const paperFills = this.count("paper_fills");
    const signals = this.count("signals");
    const approvedSignals = this.count("paper_orders");
    const openCost = Number(openRow.open_cost ?? 0);
    const openValue = Number(openRow.open_value ?? 0);
    const realizedPnl = Number(closedRow.realized_pnl ?? 0);
    const unrealizedPnl = Number(openRow.unrealized_pnl ?? 0);
    const wins = Number(closedRow.wins ?? 0);
    const losses = Number(closedRow.losses ?? 0);
    return {
      openPositions: Number(openRow.count ?? 0),
      closedPositions: Number(closedRow.count ?? 0),
      openCost,
      openValue,
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

  getProfilePerformanceReports(bankroll: number): ProfilePerformanceReport[] {
    return (["Conservative", "Aggressive"] as const).map((profile) => {
      const positionRows = this.db.prepare("SELECT * FROM positions WHERE profile = ?").all(profile) as unknown as DbPosition[];
      const openRows = positionRows.filter((row) => row.status === "OPEN");
      const closedRows = positionRows.filter((row) => row.status === "CLOSED");
      const paperOrders = this.scalarCount("paper_orders", "profile = " + sqlString(profile));
      const approvedSignals = paperOrders;
      const rejectedSignals = this.scalarCount("risk_events", "profile = " + sqlString(profile) + " AND decision NOT IN ('APPROVE', 'REDUCE_SIZE')");
      const openCost = openRows.reduce((sum, row) => sum + row.avg_entry_price * row.size, 0);
      const openValue = openRows.reduce((sum, row) => sum + row.current_price * row.size, 0);
      const realizedPnl = closedRows.reduce((sum, row) => sum + row.realized_pnl, 0);
      const unrealizedPnl = openRows.reduce((sum, row) => sum + (row.current_price - row.avg_entry_price) * row.size, 0);
      const wins = closedRows.filter((row) => row.realized_pnl > 0).length;
      const losses = closedRows.filter((row) => row.realized_pnl < 0).length;
      const returns = closedRows
        .map((row) => row.avg_entry_price > 0 ? (row.current_price - row.avg_entry_price) / row.avg_entry_price : 0)
        .filter(Number.isFinite);
      const avgHoldMinutes = closedRows.length
        ? closedRows.reduce((sum, row) => sum + Math.max(0, row.updated_at - row.opened_at) / 60000, 0) / closedRows.length
        : 0;

      return {
        profile,
        bankroll,
        openPositions: openRows.length,
        closedPositions: closedRows.length,
        openCost,
        openValue,
        realizedPnl,
        unrealizedPnl,
        totalPnl: realizedPnl + unrealizedPnl,
        winRate: wins + losses > 0 ? wins / (wins + losses) : 0,
        wins,
        losses,
        paperOrders,
        approvedSignals,
        rejectedSignals,
        openExposure: openRows.reduce((sum, row) => sum + row.size * row.current_price, 0),
        maxDrawdown: calculateMaxDrawdown(closedRows),
        avgHoldMinutes,
        bestTradeReturnPct: returns.length ? Math.max(...returns) : undefined,
        worstTradeReturnPct: returns.length ? Math.min(...returns) : undefined
      };
    });
  }

  getOrderHealthReport(minPositionSize: number): OrderHealthReport {
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) as count
      FROM paper_orders
      GROUP BY status
    `).all() as Array<{ status: PaperOrder["status"]; count: number }>;
    const byStatus = new Map(rows.map((row) => [row.status, Number(row.count ?? 0)]));
    const totalOrders = rows.reduce((sum, row) => sum + Number(row.count ?? 0), 0);
    const filledOrders = byStatus.get("FILLED") ?? 0;
    const openOrders = byStatus.get("OPEN") ?? 0;
    const expiredOrders = byStatus.get("EXPIRED") ?? 0;
    const cancelledOrders = byStatus.get("CANCELLED") ?? 0;
    const partialOrders = byStatus.get("PARTIAL") ?? 0;
    const now = Date.now();
    const fillRow = this.db.prepare(`
      SELECT
        COALESCE(AVG(price * size), 0) as avg_filled_notional,
        SUM(CASE WHEN timestamp >= ? THEN 1 ELSE 0 END) as recent_fills
      FROM paper_fills
    `).get(now - 24 * 60 * 60 * 1000) as { avg_filled_notional: number; recent_fills: number | null };
    const staleOpenRow = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM paper_orders
      WHERE status = 'OPEN' AND expires_at < ?
    `).get(now) as { count: number };
    const dustRow = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM paper_orders
      WHERE status = 'FILLED' AND price * size < ?
    `).get(minPositionSize) as { count: number };
    return {
      totalOrders,
      filledOrders,
      openOrders,
      expiredOrders,
      cancelledOrders,
      partialOrders,
      fillRate: totalOrders > 0 ? filledOrders / totalOrders : 0,
      staleOpenOrders: Number(staleOpenRow.count ?? 0),
      dustFilledOrders: Number(dustRow.count ?? 0),
      avgFilledNotional: Number(fillRow.avg_filled_notional ?? 0),
      recentFills24h: Number(fillRow.recent_fills ?? 0)
    };
  }

  getPaperSourcePerformance(): Map<string, PaperSourcePerformance> {
    const rows = this.db.prepare(`
      SELECT
        s.aligned_wallets_json,
        s.confidence,
        s.created_at as signal_created_at,
        po.profile,
        po.market_id,
        po.token_id,
        pf.price,
        pf.size,
        pf.timestamp,
        p.current_price,
        p.realized_pnl,
        p.status
      FROM paper_fills pf
      JOIN paper_orders po ON po.id = pf.order_id
      JOIN signals s ON s.id = po.signal_id
      LEFT JOIN positions p
        ON p.market_id = po.market_id
        AND p.token_id = po.token_id
        AND COALESCE(p.profile, '') = COALESCE(po.profile, '')
      WHERE pf.timestamp >= s.created_at
    `).all() as Array<{
      aligned_wallets_json: string;
      confidence: number;
      signal_created_at: number;
      profile: string | null;
      market_id: string;
      token_id: string;
      price: number;
      size: number;
      timestamp: number;
      current_price: number | null;
      realized_pnl: number | null;
      status: Position["status"] | null;
    }>;

    const buckets = new Map<string, { filledOrders: number; pnl: number; weightedReturnSum: number; weightSum: number }>();
    for (const row of rows) {
      const alignedWallets = JSON.parse(row.aligned_wallets_json) as string[];
      if (alignedWallets.length === 0 || !row.current_price) continue;
      const pnl = (row.current_price - row.price) * row.size;
      const returnPct = row.price > 0 ? (row.current_price - row.price) / row.price : 0;
      const confidenceWeight = Math.max(0.5, Math.min(1.2, row.confidence / 100));
      const sourceShare = 1 / alignedWallets.length;
      const sourceWeight = confidenceWeight * sourceShare;
      for (const wallet of alignedWallets) {
        const normalized = wallet.toLowerCase();
        const bucket = buckets.get(normalized) ?? { filledOrders: 0, pnl: 0, weightedReturnSum: 0, weightSum: 0 };
        bucket.filledOrders += sourceShare;
        bucket.pnl += pnl * sourceWeight;
        bucket.weightedReturnSum += returnPct * sourceWeight;
        bucket.weightSum += sourceWeight;
        buckets.set(normalized, bucket);
      }
    }

    const performance = new Map<string, PaperSourcePerformance>();
    for (const [wallet, bucket] of buckets) {
      const avgReturnPct = bucket.weightSum > 0 ? bucket.weightedReturnSum / bucket.weightSum : 0;
      const sampleWeight = Math.min(1, bucket.filledOrders / 20);
      const scoreImpact = Math.round(Math.max(-5, Math.min(5, avgReturnPct / 0.08 * 5 * sampleWeight)));
      performance.set(wallet, {
        wallet,
        filledOrders: bucket.filledOrders,
        pnl: bucket.pnl,
        avgReturnPct,
        scoreImpact
      });
    }
    return performance;
  }

  savePaperSourceFeedback(performance: Iterable<PaperSourcePerformance>): number {
    const stmt = this.db.prepare(`
      INSERT INTO paper_source_feedback
      (id, wallet, filled_orders, pnl, avg_return_pct, score_impact, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    let saved = 0;
    const now = Date.now();
    for (const item of performance) {
      if (item.filledOrders === 0 || item.scoreImpact === 0) continue;
      const result = stmt.run(
        randomId("paperfb"),
        item.wallet,
        item.filledOrders,
        item.pnl,
        item.avgReturnPct,
        item.scoreImpact,
        now
      );
      saved += Number(result.changes ?? 0);
    }
    return saved;
  }

  getPaperSourceFeedbackSummary(): PaperSourceFeedbackSummary {
    const row = this.db.prepare(`
      SELECT
        COUNT(DISTINCT wallet) as sources,
        COUNT(DISTINCT CASE WHEN score_impact > 0 THEN wallet END) as positive_sources,
        COUNT(DISTINCT CASE WHEN score_impact < 0 THEN wallet END) as negative_sources,
        COALESCE(AVG(score_impact), 0) as avg_score_impact,
        COALESCE(MAX(created_at), 0) as latest_at
      FROM paper_source_feedback
      WHERE created_at >= ?
    `).get(Date.now() - 7 * 24 * 60 * 60 * 1000) as {
      sources: number;
      positive_sources: number;
      negative_sources: number;
      avg_score_impact: number;
      latest_at: number;
    };
    return {
      sources: Number(row.sources ?? 0),
      positiveSources: Number(row.positive_sources ?? 0),
      negativeSources: Number(row.negative_sources ?? 0),
      avgScoreImpact: Number(row.avg_score_impact ?? 0),
      latestAt: Number(row.latest_at ?? 0)
    };
  }

  getPaperTradeLedger(bankroll: number, limit = 40): PaperTradeLedgerEntry[] {
    const fillRows = this.db.prepare(`
      SELECT *
      FROM (
        SELECT
          pf.id,
          po.profile,
          pf.market_id,
          po.outcome,
          pf.price,
          pf.size,
          pf.timestamp as created_at
        FROM paper_fills pf
        JOIN paper_orders po ON po.id = pf.order_id
        ORDER BY pf.timestamp DESC
        LIMIT ?
      )
      ORDER BY created_at ASC
    `).all(limit) as Array<{
      id: string;
      profile: Position["profile"] | null;
      market_id: string;
      outcome: string;
      price: number;
      size: number;
      created_at: number;
    }>;
    const closedRows = this.db.prepare(`
      SELECT *
      FROM (
        SELECT *
        FROM positions
        WHERE status = 'CLOSED'
        ORDER BY updated_at DESC
        LIMIT ?
      )
      ORDER BY updated_at ASC
    `).all(limit) as unknown as DbPosition[];
    const performance = this.getPerformanceReport();
    const totalPnl = performance.totalPnl;
    const availableCash = bankroll - performance.openCost + performance.realizedPnl;

    const events = [
      ...fillRows.map((row) => ({
        id: row.id,
        type: "ENTRY" as const,
        profile: row.profile ?? undefined,
        marketId: row.market_id,
        outcome: row.outcome,
        price: row.price,
        size: row.size,
        notional: row.price * row.size,
        realizedPnl: 0,
        createdAt: row.created_at
      })),
      ...closedRows.map((row) => ({
        id: row.id,
        type: "EXIT" as const,
        profile: row.profile ?? undefined,
        marketId: row.market_id,
        outcome: row.outcome,
        price: row.current_price,
        size: row.size,
        notional: row.current_price * row.size,
        realizedPnl: row.realized_pnl,
        createdAt: row.updated_at
      }))
    ].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);

    return events.map((event) => ({
      ...event,
      unrealizedPnl: performance.unrealizedPnl,
      totalPnl,
      equity: bankroll + totalPnl,
      availableCash
    }));
  }

  getShadowCategoryTrend(days = 14): ShadowCategoryTrendPoint[] {
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const rows = this.db.prepare(`
      SELECT
        ((created_at / 86400000) * 86400000) as bucket_start,
        COALESCE(category, 'other') as category,
        COUNT(*) as simulated,
        SUM(CASE WHEN exit_reason IN ('source sell after detection', 'resolved market outcome') THEN 1 ELSE 0 END) as realized,
        COALESCE(SUM(pnl), 0) as pnl,
        COALESCE(AVG(return_pct), 0) as avg_return_pct
      FROM shadow_trades
      WHERE status = 'SIMULATED' AND created_at >= ?
      GROUP BY bucket_start, COALESCE(category, 'other')
      ORDER BY bucket_start ASC, category ASC
    `).all(since) as Array<{
      bucket_start: number;
      category: ShadowCategoryTrendPoint["category"];
      simulated: number;
      realized: number;
      pnl: number;
      avg_return_pct: number;
    }>;
    return rows.map((row) => ({
      bucketStart: Number(row.bucket_start ?? 0),
      category: row.category,
      simulated: Number(row.simulated ?? 0),
      realized: Number(row.realized ?? 0),
      pnl: Number(row.pnl ?? 0),
      avgReturnPct: Number(row.avg_return_pct ?? 0)
    }));
  }

  getOrderHealthTrend(days = 14): OrderHealthTrendPoint[] {
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const orderRows = this.db.prepare(`
      SELECT
        ((created_at / 86400000) * 86400000) as bucket_start,
        COUNT(*) as created_orders,
        SUM(CASE WHEN status = 'FILLED' THEN 1 ELSE 0 END) as filled_orders,
        SUM(CASE WHEN status = 'EXPIRED' THEN 1 ELSE 0 END) as expired_orders,
        SUM(CASE WHEN status = 'PARTIAL' THEN 1 ELSE 0 END) as partial_orders
      FROM paper_orders
      WHERE created_at >= ?
      GROUP BY bucket_start
    `).all(since) as Array<{
      bucket_start: number;
      created_orders: number;
      filled_orders: number;
      expired_orders: number;
      partial_orders: number;
    }>;
    const fillRows = this.db.prepare(`
      SELECT
        ((timestamp / 86400000) * 86400000) as bucket_start,
        COUNT(*) as fills,
        COALESCE(SUM(price * size), 0) as filled_notional
      FROM paper_fills
      WHERE timestamp >= ?
      GROUP BY bucket_start
    `).all(since) as Array<{ bucket_start: number; fills: number; filled_notional: number }>;
    const byBucket = new Map<number, OrderHealthTrendPoint>();
    for (const row of orderRows) {
      byBucket.set(Number(row.bucket_start), {
        bucketStart: Number(row.bucket_start),
        createdOrders: Number(row.created_orders ?? 0),
        filledOrders: Number(row.filled_orders ?? 0),
        expiredOrders: Number(row.expired_orders ?? 0),
        partialOrders: Number(row.partial_orders ?? 0),
        fills: 0,
        filledNotional: 0
      });
    }
    for (const row of fillRows) {
      const bucket = byBucket.get(Number(row.bucket_start)) ?? {
        bucketStart: Number(row.bucket_start),
        createdOrders: 0,
        filledOrders: 0,
        expiredOrders: 0,
        partialOrders: 0,
        fills: 0,
        filledNotional: 0
      };
      bucket.fills = Number(row.fills ?? 0);
      bucket.filledNotional = Number(row.filled_notional ?? 0);
      byBucket.set(bucket.bucketStart, bucket);
    }
    return [...byBucket.values()].sort((a, b) => a.bucketStart - b.bucketStart);
  }

  getAgentThroughputTrend(days = 7): AgentThroughputPoint[] {
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const rows = this.db.prepare(`
      SELECT
        ((created_at / 3600000) * 3600000) as bucket_start,
        agent,
        COUNT(*) as events,
        SUM(CASE WHEN visibility = 'PUBLIC' THEN 1 ELSE 0 END) as public_events
      FROM agent_events
      WHERE created_at >= ?
      GROUP BY bucket_start, agent
      ORDER BY bucket_start ASC, agent ASC
    `).all(since) as Array<{
      bucket_start: number;
      agent: AgentThroughputPoint["agent"];
      events: number;
      public_events: number;
    }>;
    return rows.map((row) => ({
      bucketStart: Number(row.bucket_start ?? 0),
      agent: row.agent,
      events: Number(row.events ?? 0),
      publicEvents: Number(row.public_events ?? 0)
    }));
  }

  getWalletDegradationReport(days = 14, limit = 20): WalletDegradationReport[] {
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const rows = this.db.prepare(`
      SELECT *
      FROM (
        SELECT wallet, NULL as label, score, copyability_score, dominant_category, created_at
        FROM source_score_snapshots
        WHERE created_at >= ?
        ORDER BY created_at DESC
        LIMIT 5000
      )
      ORDER BY wallet ASC, created_at ASC
    `).all(since) as Array<{
      wallet: string;
      label: string | null;
      score: number;
      copyability_score: number | null;
      dominant_category: WalletDegradationReport["category"] | null;
      created_at: number;
    }>;
    const byWallet = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byWallet.get(row.wallet) ?? [];
      list.push(row);
      byWallet.set(row.wallet, list);
    }
    return [...byWallet.entries()]
      .map(([wallet, snapshots]) => {
        const first = snapshots[0];
        const latest = snapshots[snapshots.length - 1];
        const scoreChange = latest.score - first.score;
        const copyabilityChange = latest.copyability_score !== null && first.copyability_score !== null
          ? latest.copyability_score - first.copyability_score
          : undefined;
        return {
          wallet,
          label: latest.label ?? undefined,
          category: latest.dominant_category ?? undefined,
          startScore: first.score,
          latestScore: latest.score,
          scoreChange,
          startCopyabilityScore: first.copyability_score ?? undefined,
          latestCopyabilityScore: latest.copyability_score ?? undefined,
          copyabilityChange,
          snapshots: snapshots.length,
          status: scoreChange <= -8 || (copyabilityChange ?? 0) <= -8 ? "DEGRADING" : scoreChange >= 8 || (copyabilityChange ?? 0) >= 8 ? "IMPROVING" : "STABLE",
          latestAt: latest.created_at
        } satisfies WalletDegradationReport;
      })
      .sort((a, b) => a.scoreChange - b.scoreChange || b.snapshots - a.snapshots)
      .slice(0, limit);
  }

  getSourceCategorySummaries(): SourceCategorySummary[] {
    const rows = this.db.prepare(`
      SELECT
        COALESCE(dominant_category, 'other') as category,
        COUNT(*) as sources,
        COALESCE(AVG(copyability_score), 0) as avg_copyability_score,
        COALESCE(AVG(score), 0) as avg_score,
        COALESCE(AVG(sample_confidence), 0) as avg_sample_confidence,
        COALESCE(AVG(shadow_score_impact), 0) as avg_shadow_impact,
        COALESCE(SUM(trade_count), 0) as total_trades,
        SUM(CASE WHEN reliability = 'HIGH' THEN 1 ELSE 0 END) as high_reliability
      FROM wallet_scores
      GROUP BY COALESCE(dominant_category, 'other')
      ORDER BY avg_copyability_score DESC, sources DESC
    `).all() as Array<{
      category: SourceCategorySummary["category"];
      sources: number;
      avg_copyability_score: number;
      avg_score: number;
      avg_sample_confidence: number;
      avg_shadow_impact: number;
      total_trades: number;
      high_reliability: number;
    }>;
    return rows.map((row) => ({
      category: row.category,
      sources: Number(row.sources ?? 0),
      avgCopyabilityScore: Number(row.avg_copyability_score ?? 0),
      avgScore: Number(row.avg_score ?? 0),
      avgSampleConfidence: Number(row.avg_sample_confidence ?? 0),
      avgShadowImpact: Number(row.avg_shadow_impact ?? 0),
      totalTrades: Number(row.total_trades ?? 0),
      highReliability: Number(row.high_reliability ?? 0)
    }));
  }

  getReconstructedSourcePositions(limit = 80): ReconstructedSourcePosition[] {
    const rows = this.db.prepare(`
      SELECT wt.*, m.question, m.raw_json
      FROM (
        SELECT *
        FROM wallet_trades
        ORDER BY timestamp DESC
        LIMIT ?
      ) wt
      LEFT JOIN markets m ON m.id = wt.market_id OR m.condition_id = wt.market_id
      ORDER BY wt.wallet ASC, wt.market_id ASC, wt.outcome ASC, wt.timestamp ASC
    `).all(Math.max(limit * 120, 2000)) as unknown as Array<DbWalletTrade & { question: string | null; raw_json: string | null }>;
    const positions = new Map<string, ReconstructedSourcePosition>();
    for (const row of rows) {
      const key = `${row.wallet}:${row.market_id}:${row.outcome.toLowerCase()}`;
      const current = positions.get(key) ?? {
        wallet: row.wallet,
        marketId: row.market_id,
        tokenId: row.token_id ?? undefined,
        outcome: row.outcome,
        category: marketCategoryFromText(row.question, row.raw_json),
        netSize: 0,
        costBasis: 0,
        avgEntryPrice: 0,
        realizedPnlApprox: 0,
        lastTradeAt: row.timestamp,
        status: "CLOSED" as const
      };
      if (row.side === "BUY") {
        current.netSize += row.size;
        current.costBasis += row.price * row.size;
      } else if (current.netSize > 0) {
        const sold = Math.min(current.netSize, row.size);
        const avgCost = current.costBasis / current.netSize;
        current.realizedPnlApprox += (row.price - avgCost) * sold;
        current.netSize -= sold;
        current.costBasis = Math.max(0, current.costBasis - avgCost * sold);
      }
      current.avgEntryPrice = current.netSize > 0 ? current.costBasis / current.netSize : 0;
      current.lastTradeAt = Math.max(current.lastTradeAt, row.timestamp);
      current.status = current.netSize > 0 ? "OPEN" : "CLOSED";
      positions.set(key, current);
    }
    return [...positions.values()]
      .filter((position) => position.netSize > 0 || position.realizedPnlApprox !== 0)
      .sort((a, b) => b.lastTradeAt - a.lastTradeAt)
      .slice(0, limit);
  }

  getSourceScoreSummary(): SourceScoreSummary {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) as total_sources,
        SUM(CASE WHEN reliability = 'HIGH' THEN 1 ELSE 0 END) as high_reliability,
        SUM(CASE WHEN reliability = 'MEDIUM' THEN 1 ELSE 0 END) as medium_reliability,
        SUM(CASE WHEN reliability = 'LOW' THEN 1 ELSE 0 END) as low_reliability,
        COALESCE(AVG(score), 0) as avg_score,
        COALESCE(AVG(copyability_score), 0) as avg_copyability_score,
        COALESCE(AVG(shadow_score_impact), 0) as avg_shadow_impact
      FROM wallet_scores
    `).get() as {
      total_sources: number;
      high_reliability: number;
      medium_reliability: number;
      low_reliability: number;
      avg_score: number;
      avg_copyability_score: number;
      avg_shadow_impact: number;
    };
    return {
      totalSources: Number(row.total_sources ?? 0),
      highReliability: Number(row.high_reliability ?? 0),
      mediumReliability: Number(row.medium_reliability ?? 0),
      lowReliability: Number(row.low_reliability ?? 0),
      avgScore: Number(row.avg_score ?? 0),
      avgCopyabilityScore: Number(row.avg_copyability_score ?? 0),
      avgShadowImpact: Number(row.avg_shadow_impact ?? 0)
    };
  }

  getRecentSignals(limit: number): TradeSignal[] {
    const rows = this.db.prepare(`
      SELECT * FROM signals
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as unknown as DbSignal[];
    return rows.map(rowToSignal);
  }

  getRecentBotLogs(limit: number): Array<{ level: "INFO" | "WARN" | "ERROR"; message: string; payload?: unknown; createdAt: number }> {
    const rows = this.db.prepare(`
      SELECT level, message, payload_json, created_at
      FROM bot_run_logs
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as Array<{ level: "INFO" | "WARN" | "ERROR"; message: string; payload_json: string | null; created_at: number }>;
    return rows.map((row) => ({
      level: row.level,
      message: row.message,
      payload: row.payload_json ? JSON.parse(row.payload_json) as unknown : undefined,
      createdAt: row.created_at
    }));
  }

  getTopWalletScores(limit: number): WalletScore[] {
    const rows = this.db.prepare(`
      SELECT * FROM wallet_scores
      ORDER BY score DESC, copyability_score DESC, updated_at DESC
      LIMIT ?
    `).all(limit) as unknown as DbWalletScore[];
    return rows.map(rowToWalletScore);
  }

  getSourceScoreHistory(limit: number): SourceScorePoint[] {
    const rows = this.db.prepare(`
      SELECT wallet, score, copyability_score, category_consistency_score, shadow_score_impact,
             trade_count, reliability, created_at
      FROM source_score_snapshots
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as Array<{
      wallet: string;
      score: number;
      copyability_score: number | null;
      category_consistency_score: number | null;
      shadow_score_impact: number | null;
      trade_count: number;
      reliability: WalletScore["reliability"];
      created_at: number;
    }>;
    return rows.map((row) => ({
      wallet: row.wallet,
      score: row.score,
      copyabilityScore: row.copyability_score ?? undefined,
      categoryConsistencyScore: row.category_consistency_score ?? undefined,
      shadowScoreImpact: row.shadow_score_impact ?? undefined,
      tradeCount: row.trade_count,
      reliability: row.reliability,
      createdAt: row.created_at
    }));
  }

  getRiskEventSummary(limit: number): RiskEventSummary[] {
    const rows = this.db.prepare(`
      SELECT decision, profile, reason, COUNT(*) as count, MAX(created_at) as latest_at
      FROM risk_events
      GROUP BY decision, profile, reason
      ORDER BY latest_at DESC
      LIMIT ?
    `).all(limit) as Array<{
      decision: RiskDecision["decision"];
      profile: RiskDecision["profile"] | null;
      reason: string;
      count: number;
      latest_at: number;
    }>;
    return rows.map((row) => ({
      decision: row.decision,
      profile: row.profile ?? undefined,
      reason: row.reason,
      count: Number(row.count ?? 0),
      latestAt: Number(row.latest_at ?? 0)
    }));
  }

  getRecentRiskEvents(limit: number): RecentRiskEvent[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM risk_events
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as Array<{
      id: string;
      signal_id: string | null;
      market_id: string | null;
      outcome: string | null;
      decision: RiskDecision["decision"];
      profile: RiskDecision["profile"] | null;
      confidence: number | null;
      risk_state: RiskDecision["riskState"] | null;
      position_size: number;
      reason: string;
      details_json: string | null;
      created_at: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      signalId: row.signal_id ?? undefined,
      marketId: row.market_id ?? undefined,
      outcome: row.outcome ?? undefined,
      decision: row.decision,
      profile: row.profile ?? undefined,
      confidence: row.confidence ?? undefined,
      riskState: row.risk_state ?? undefined,
      positionSize: row.position_size,
      reason: row.reason,
      details: row.details_json ? JSON.parse(row.details_json) as RecentRiskEvent["details"] : undefined,
      createdAt: row.created_at
    }));
  }

  private count(table: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as { count: number };
    return Number(row.count ?? 0);
  }

  private scalarCount(table: string, where: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) as count FROM ${table} WHERE ${where}`).get() as { count: number };
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

  saveShadowTrades(trades: ShadowTrade[]): number {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO shadow_trades
      (id, wallet, market_id, category, token_id, outcome, source_timestamp, detected_at, source_price, simulated_entry_price,
       simulated_exit_price, size_usd, pnl, return_pct, status, exit_reason, rejection_reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let saved = 0;
    for (const trade of trades) {
      const result = stmt.run(
        trade.id,
        trade.wallet,
        trade.marketId,
        trade.category ?? null,
        trade.tokenId ?? null,
        trade.outcome,
        trade.sourceTimestamp,
        trade.detectedAt,
        trade.sourcePrice,
        trade.simulatedEntryPrice ?? null,
        trade.simulatedExitPrice ?? null,
        trade.sizeUsd,
        trade.pnl,
        trade.returnPct,
        trade.status,
        trade.exitReason ?? null,
        trade.rejectionReason ?? null,
        trade.createdAt
      );
      saved += Number(result.changes ?? 0);
    }
    return saved;
  }

  getShadowBacktestReport(): ShadowBacktestReport {
    const total = this.count("shadow_trades");
    const simulated = this.scalarCount("shadow_trades", "status = 'SIMULATED'");
    const skipped = this.scalarCount("shadow_trades", "status = 'SKIPPED'");
    const row = this.db.prepare(`
      SELECT
        COALESCE(SUM(pnl), 0) as pnl,
        COALESCE(AVG(return_pct), 0) as avg_return_pct,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losses
      FROM shadow_trades
      WHERE status = 'SIMULATED'
    `).get() as { pnl: number; avg_return_pct: number; wins: number; losses: number };
    const wins = Number(row.wins ?? 0);
    const losses = Number(row.losses ?? 0);
    return {
      total,
      simulated,
      skipped,
      pnl: Number(row.pnl ?? 0),
      wins,
      losses,
      winRate: wins + losses > 0 ? wins / (wins + losses) : 0,
      avgReturnPct: Number(row.avg_return_pct ?? 0)
    };
  }

  getShadowCategorySummaries(): ShadowCategorySummary[] {
    const rows = this.db.prepare(`
      SELECT
        COALESCE(category, 'other') as category,
        COUNT(*) as simulated,
        SUM(CASE WHEN exit_reason IN ('source sell after detection', 'resolved market outcome') THEN 1 ELSE 0 END) as realized,
        COALESCE(SUM(pnl), 0) as pnl,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losses,
        COALESCE(AVG(return_pct), 0) as avg_return_pct,
        SUM(CASE WHEN exit_reason = 'source price fallback' THEN 1 ELSE 0 END) as fallback
      FROM shadow_trades
      WHERE status = 'SIMULATED'
      GROUP BY COALESCE(category, 'other')
      ORDER BY pnl DESC
    `).all() as Array<{
      category: ShadowCategorySummary["category"];
      simulated: number;
      realized: number;
      pnl: number;
      wins: number;
      losses: number;
      avg_return_pct: number;
      fallback: number;
    }>;
    return rows.map((row) => {
      const wins = Number(row.wins ?? 0);
      const losses = Number(row.losses ?? 0);
      const simulated = Number(row.simulated ?? 0);
      return {
        category: row.category,
        simulated,
        realized: Number(row.realized ?? 0),
        pnl: Number(row.pnl ?? 0),
        winRate: wins + losses > 0 ? wins / (wins + losses) : 0,
        avgReturnPct: Number(row.avg_return_pct ?? 0),
        fallbackRate: simulated > 0 ? Number(row.fallback ?? 0) / simulated : 0
      };
    });
  }

  private saveSourceScoreSnapshot(score: WalletScore): void {
    this.db.prepare(`
      INSERT INTO source_score_snapshots
      (id, wallet, score, copyability_score, hot_score, category_consistency_score, sample_confidence, dominant_category,
       resolved_markets, resolved_wins, resolved_losses, resolved_win_rate, shadow_trade_count, shadow_simulated, shadow_realized,
       shadow_pnl, shadow_avg_return_pct, shadow_win_rate, shadow_score_impact, trade_count, reliability, flags_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      score.shadowTradeCount ?? null,
      score.shadowSimulated ?? null,
      score.shadowRealized ?? null,
      score.shadowPnl ?? null,
      score.shadowAvgReturnPct ?? null,
      score.shadowWinRate ?? null,
      score.shadowScoreImpact ?? null,
      score.tradeCount,
      score.reliability,
      JSON.stringify(score.flags),
      score.updatedAt
    );
  }
}

interface DbPosition {
  id: string;
  profile: Position["profile"] | null;
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

interface DbMarket {
  id: string;
  condition_id: string | null;
  question: string;
  active: number;
  closed: number;
  archived: number;
  accepting_orders: number;
  resolved: number;
  winning_outcome: string | null;
  liquidity: number;
  volume_24h: number;
  outcomes_json: string;
  clob_token_ids_json: string;
  raw_json: string | null;
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

interface DbWalletScore {
  wallet: string;
  label: string | null;
  score: number;
  copyability_score: number | null;
  hot_score: number | null;
  category_consistency_score: number | null;
  sample_confidence: number | null;
  dominant_category: WalletScore["dominantCategory"] | null;
  resolved_markets: number | null;
  resolved_wins: number | null;
  resolved_losses: number | null;
  resolved_win_rate: number | null;
  shadow_trade_count: number | null;
  shadow_simulated: number | null;
  shadow_realized: number | null;
  shadow_pnl: number | null;
  shadow_avg_return_pct: number | null;
  shadow_win_rate: number | null;
  shadow_score_impact: number | null;
  trade_count: number;
  recent_trade_count: number;
  reliability: WalletScore["reliability"];
  flags_json: string;
  updated_at: number;
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

interface DbSignal {
  id: string;
  decision: TradeSignal["decision"];
  market_id: string;
  condition_id: string | null;
  token_id: string;
  outcome: string;
  side: TradeSignal["side"];
  confidence: number;
  limit_price: number;
  aligned_wallets_json: string;
  reason: string;
  created_at: number;
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
    profile: row.profile ?? undefined,
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

function rowToMarket(row: DbMarket): MarketSnapshot {
  const raw = row.raw_json ? JSON.parse(row.raw_json) as unknown : undefined;
  const rawRecord = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    return {
      id: row.id,
      conditionId: row.condition_id ?? undefined,
      question: row.question,
      slug: typeof rawRecord.slug === "string" ? rawRecord.slug : undefined,
      endDate: typeof rawRecord.endDate === "string"
        ? rawRecord.endDate
        : typeof rawRecord.endDateIso === "string"
          ? rawRecord.endDateIso
          : undefined,
      active: Boolean(row.active),
    closed: Boolean(row.closed),
    archived: Boolean(row.archived),
    acceptingOrders: Boolean(row.accepting_orders),
    resolved: Boolean(row.resolved),
    winningOutcome: row.winning_outcome ?? undefined,
    liquidity: row.liquidity,
    volume24h: row.volume_24h,
    outcomes: JSON.parse(row.outcomes_json) as string[],
    clobTokenIds: JSON.parse(row.clob_token_ids_json) as string[],
    outcomePrices: Array.isArray(rawRecord.outcomePrices) ? rawRecord.outcomePrices.map(Number).filter(Number.isFinite) : [],
    raw
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

function rowToWalletScore(row: DbWalletScore): WalletScore {
  return {
    wallet: row.wallet,
    label: row.label ?? undefined,
    score: row.score,
    copyabilityScore: row.copyability_score ?? undefined,
    hotScore: row.hot_score ?? undefined,
    categoryConsistencyScore: row.category_consistency_score ?? undefined,
    sampleConfidence: row.sample_confidence ?? undefined,
    dominantCategory: row.dominant_category ?? undefined,
    resolvedMarkets: row.resolved_markets ?? undefined,
    resolvedWins: row.resolved_wins ?? undefined,
    resolvedLosses: row.resolved_losses ?? undefined,
    resolvedWinRate: row.resolved_win_rate ?? undefined,
    shadowTradeCount: row.shadow_trade_count ?? undefined,
    shadowSimulated: row.shadow_simulated ?? undefined,
    shadowRealized: row.shadow_realized ?? undefined,
    shadowPnl: row.shadow_pnl ?? undefined,
    shadowAvgReturnPct: row.shadow_avg_return_pct ?? undefined,
    shadowWinRate: row.shadow_win_rate ?? undefined,
    shadowScoreImpact: row.shadow_score_impact ?? undefined,
    tradeCount: row.trade_count,
    recentTradeCount: row.recent_trade_count,
    reliability: row.reliability,
    flags: JSON.parse(row.flags_json) as string[],
    updatedAt: row.updated_at
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

function rowToSignal(row: DbSignal): TradeSignal {
  return {
    id: row.id,
    decision: row.decision,
    marketId: row.market_id,
    conditionId: row.condition_id ?? undefined,
    tokenId: row.token_id,
    outcome: row.outcome,
    side: row.side,
    confidence: row.confidence,
    limitPrice: row.limit_price,
    alignedWallets: JSON.parse(row.aligned_wallets_json) as string[],
    reason: row.reason,
    createdAt: row.created_at
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

function calculateMaxDrawdown(rows: DbPosition[]): number {
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const row of [...rows].sort((a, b) => a.updated_at - b.updated_at)) {
    equity += row.realized_pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  return maxDrawdown;
}

function marketCategoryFromText(question: string | null, rawJson: string | null): ReconstructedSourcePosition["category"] {
  let slug = "";
  if (rawJson) {
    try {
      const raw = JSON.parse(rawJson) as Record<string, unknown>;
      slug = typeof raw.slug === "string" ? raw.slug : "";
    } catch {
      slug = "";
    }
  }
  const text = `${question ?? ""} ${slug}`.toLowerCase();
  if (/\b(election|president|senate|house|congress|trump|biden|poll|mayor|governor|democrat|republican|minister)\b/.test(text)) return "politics";
  if (/\b(nba|nfl|mlb|nhl|ufc|soccer|football|tennis|golf|cricket|team|championship|super bowl|world cup)\b/.test(text)) return "sports";
  if (/\b(bitcoin|btc|ethereum|eth|solana|sol|xrp|crypto|token|coin|binance)\b/.test(text)) return "crypto";
  if (/\b(fed|inflation|cpi|rates|gdp|jobs|unemployment|recession|tariff|oil|gold)\b/.test(text)) return "macro";
  if (/\b(tesla|apple|nvidia|meta|google|amazon|microsoft|stock|earnings|ipo)\b/.test(text)) return "company";
  if (/\b(oscar|grammy|movie|album|stream|youtube|tiktok|celebrity|music)\b/.test(text)) return "culture";
  return "other";
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function randomId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
