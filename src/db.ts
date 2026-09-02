import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { estimateTapeExecutableShadow, takerFeeUsd } from "./liveExecution.js";
import type {
  AgentEvent,
  CapitalLockupReport,
  DiscoveredWallet,
  ExitDecision,
  ExitDecisionMark,
  ExposureHealthReport,
  ForwardShadowScorecard,
  MarketSnapshot,
  MarketCategory,
  BotConfig,
  AgentThroughputPoint,
  DailyCoreScorecard,
  DailyScorecardSnapshot,
  ForwardSelection,
  OrderHealthTrendPoint,
  OrderBookSnapshot,
  PaperFill,
  PaperOrder,
  PaperTradeLedgerEntry,
  PaperSourceFeedbackSummary,
  PaperSourcePerformance,
  ParityScorecard,
  PerformanceReport,
  Position,
  ReconstructedSourcePosition,
  ProfilePerformanceReport,
  OrderHealthReport,
  LiveReadinessReport,
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
  StrategyProfileName,
  TradeSignal,
  TradeParityMetric,
  TrackedWallet,
  WalletScore,
  WalletDegradationReport,
  WalletResearchReport,
  StrategyHypothesis,
  StrategyBacktestResult,
  StrategyOpportunity,
  StrategyForwardScorecard,
  WeatherOpportunity,
  WeatherForwardScorecard,
  WeatherTournamentObservation,
  WalletTrade,
  ExecutionResearchCandidate,
  ExecutionResearchResult,
  ExecutionResearchScorecard,
  ExecutionResearchStrategy,
  MacroForecastVintage
} from "./types.js";

export class BotDatabase {
  private db: DatabaseSync;
  private performanceStartAt: number;

  constructor(path: string, performanceStartAt = 0) {
    this.performanceStartAt = Number.isFinite(performanceStartAt) && performanceStartAt > 0
      ? Math.floor(performanceStartAt)
      : 0;
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
        tick_size REAL,
        raw_json TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS signals (
        id TEXT PRIMARY KEY,
        decision TEXT NOT NULL,
        market_id TEXT NOT NULL,
        condition_id TEXT,
        token_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        side TEXT NOT NULL,
        confidence REAL NOT NULL,
        limit_price REAL NOT NULL,
        aligned_wallets_json TEXT NOT NULL,
        reason TEXT NOT NULL,
        source_buy_timestamp INTEGER,
        bot_detected_timestamp INTEGER,
        expected_entry_price REAL,
        expected_exit_price REAL,
        expected_live_executable_return_pct REAL,
        entry_book_depth REAL,
        entry_depth_multiple REAL,
        max_entry_slippage REAL,
        source_sell_realized_ratio REAL,
        parity_status TEXT,
        parity_reason TEXT,
        model_json TEXT,
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
        expires_at INTEGER NOT NULL,
        execution_policy TEXT,
        fee_rate REAL,
        missed_reason TEXT,
        partial_fill_reason TEXT
      );
      CREATE TABLE IF NOT EXISTS paper_fills (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        market_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        side TEXT NOT NULL,
        price REAL NOT NULL,
        size REAL NOT NULL,
        fee_usd REAL NOT NULL DEFAULT 0,
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
      CREATE INDEX IF NOT EXISTS idx_wallet_trades_time ON wallet_trades (timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_markets_condition_id ON markets (condition_id);
      CREATE TABLE IF NOT EXISTS wallet_research_reports (
        wallet TEXT PRIMARY KEY,
        name TEXT,
        archetype TEXT NOT NULL,
        recommendation TEXT NOT NULL,
        research_score REAL NOT NULL,
        report_json TEXT NOT NULL,
        first_observed_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_wallet_research_score ON wallet_research_reports (research_score DESC, updated_at DESC);
      CREATE TABLE IF NOT EXISTS strategy_hypotheses (
        id TEXT PRIMARY KEY,
        cluster TEXT NOT NULL,
        status TEXT NOT NULL,
        hypothesis_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_strategy_hypotheses_status ON strategy_hypotheses (status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS strategy_backtests (
        id TEXT PRIMARY KEY,
        hypothesis_id TEXT NOT NULL,
        cluster TEXT NOT NULL,
        test_kind TEXT NOT NULL,
        independent INTEGER NOT NULL,
        sample_size INTEGER NOT NULL,
        passed INTEGER NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_strategy_backtests_hypothesis ON strategy_backtests (hypothesis_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS weather_opportunities (
        id TEXT PRIMARY KEY,
        signal_id TEXT,
        market_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        status TEXT NOT NULL,
        opportunity_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_weather_opportunities_market ON weather_opportunities (market_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS strategy_opportunities (
        id TEXT PRIMARY KEY,
        signal_id TEXT,
        strategy_id TEXT NOT NULL,
        cluster TEXT NOT NULL,
        market_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        status TEXT NOT NULL,
        opportunity_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_strategy_opportunities_strategy ON strategy_opportunities (strategy_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_strategy_opportunities_market ON strategy_opportunities (market_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS macro_forecast_vintages (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        reference_period TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        source_updated_at INTEGER NOT NULL,
        vintage_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_macro_vintages_period_time
        ON macro_forecast_vintages (source, reference_period, fetched_at DESC);
      CREATE TRIGGER IF NOT EXISTS macro_vintages_no_update
        BEFORE UPDATE ON macro_forecast_vintages BEGIN
          SELECT RAISE(ABORT, 'macro_forecast_vintages is append-only');
        END;
      CREATE TRIGGER IF NOT EXISTS macro_vintages_no_delete
        BEFORE DELETE ON macro_forecast_vintages BEGIN
          SELECT RAISE(ABORT, 'macro_forecast_vintages is append-only');
        END;
      CREATE TABLE IF NOT EXISTS execution_research_candidates (
        id TEXT PRIMARY KEY,
        strategy TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        event_key TEXT NOT NULL,
        market_ids_json TEXT NOT NULL,
        token_ids_json TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        notional_usd REAL NOT NULL,
        expected_gross_edge_usd REAL NOT NULL,
        expected_net_edge_usd REAL NOT NULL,
        candidate_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_execution_candidates_strategy_time
        ON execution_research_candidates (strategy, policy_version, observed_at ASC);
      CREATE TABLE IF NOT EXISTS execution_research_results (
        id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL UNIQUE,
        strategy TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        event_key TEXT NOT NULL,
        status TEXT NOT NULL,
        pnl_usd REAL NOT NULL,
        capital_usd REAL NOT NULL,
        return_pct REAL NOT NULL,
        filled_legs INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        adverse_selection_5m REAL,
        resolved_at INTEGER NOT NULL,
        result_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_execution_results_strategy_time
        ON execution_research_results (strategy, policy_version, resolved_at ASC);
      CREATE TABLE IF NOT EXISTS execution_research_state (
        state_key TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS execution_candidates_no_update
        BEFORE UPDATE ON execution_research_candidates BEGIN
          SELECT RAISE(ABORT, 'execution_research_candidates is append-only');
        END;
      CREATE TRIGGER IF NOT EXISTS execution_candidates_no_delete
        BEFORE DELETE ON execution_research_candidates BEGIN
          SELECT RAISE(ABORT, 'execution_research_candidates is append-only');
        END;
      CREATE TRIGGER IF NOT EXISTS execution_results_no_update
        BEFORE UPDATE ON execution_research_results BEGIN
          SELECT RAISE(ABORT, 'execution_research_results is append-only');
        END;
      CREATE TRIGGER IF NOT EXISTS execution_results_no_delete
        BEFORE DELETE ON execution_research_results BEGIN
          SELECT RAISE(ABORT, 'execution_research_results is append-only');
        END;
      CREATE TABLE IF NOT EXISTS forward_selections (
        id TEXT PRIMARY KEY,
        strategy_id TEXT NOT NULL,
        cluster TEXT NOT NULL,
        market_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        strategy_event_key TEXT NOT NULL,
        selection_stage TEXT NOT NULL DEFAULT 'PAPER_REVIEW',
        selection_json TEXT NOT NULL,
        selected_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_forward_selections_policy_event
        ON forward_selections (strategy_id, policy_version, strategy_event_key);
      CREATE INDEX IF NOT EXISTS idx_forward_selections_time
        ON forward_selections (selected_at ASC);
      CREATE TABLE IF NOT EXISTS weather_tournament_observations (
        id TEXT PRIMARY KEY,
        tournament_version TEXT NOT NULL,
        arm_id TEXT NOT NULL,
        station_code TEXT NOT NULL,
        target_date TEXT NOT NULL,
        market_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        observation_json TEXT NOT NULL,
        selected_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_weather_tournament_arm_event
        ON weather_tournament_observations (tournament_version, arm_id, station_code, target_date);
      CREATE INDEX IF NOT EXISTS idx_weather_tournament_time
        ON weather_tournament_observations (selected_at ASC);
      CREATE TABLE IF NOT EXISTS daily_scorecard_snapshots (
        id TEXT PRIMARY KEY,
        snapshot_date TEXT NOT NULL,
        policy_fingerprint TEXT NOT NULL,
        scorecard_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_scorecard_policy_date
        ON daily_scorecard_snapshots (snapshot_date, policy_fingerprint);
      CREATE INDEX IF NOT EXISTS idx_daily_scorecard_created
        ON daily_scorecard_snapshots (created_at DESC);
      CREATE TRIGGER IF NOT EXISTS forward_selections_no_update
        BEFORE UPDATE ON forward_selections BEGIN
          SELECT RAISE(ABORT, 'forward_selections is append-only');
        END;
      CREATE TRIGGER IF NOT EXISTS forward_selections_no_delete
        BEFORE DELETE ON forward_selections BEGIN
          SELECT RAISE(ABORT, 'forward_selections is append-only');
        END;
      CREATE TRIGGER IF NOT EXISTS daily_scorecards_no_update
        BEFORE UPDATE ON daily_scorecard_snapshots BEGIN
          SELECT RAISE(ABORT, 'daily_scorecard_snapshots is append-only');
        END;
      CREATE TRIGGER IF NOT EXISTS daily_scorecards_no_delete
        BEFORE DELETE ON daily_scorecard_snapshots BEGIN
          SELECT RAISE(ABORT, 'daily_scorecard_snapshots is append-only');
        END;
      CREATE TRIGGER IF NOT EXISTS weather_tournament_no_update
        BEFORE UPDATE ON weather_tournament_observations BEGIN
          SELECT RAISE(ABORT, 'weather_tournament_observations is append-only');
        END;
      CREATE TRIGGER IF NOT EXISTS weather_tournament_no_delete
        BEFORE DELETE ON weather_tournament_observations BEGIN
          SELECT RAISE(ABORT, 'weather_tournament_observations is append-only');
        END;
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
        source_observed_at INTEGER,
        detected_at INTEGER NOT NULL,
        source_price REAL NOT NULL,
        simulated_entry_price REAL,
        simulated_exit_price REAL,
        size_usd REAL NOT NULL,
        pnl REAL NOT NULL,
        return_pct REAL NOT NULL,
        live_executable_pnl REAL,
        live_executable_return_pct REAL,
        live_executable_status TEXT,
        live_executable_reason TEXT,
        live_executable_entry_price REAL,
        live_executable_exit_price REAL,
        live_executable_entry_slippage REAL,
        live_executable_exit_slippage REAL,
        status TEXT NOT NULL,
        exit_reason TEXT,
        rejection_reason TEXT,
        forward_eligible INTEGER NOT NULL DEFAULT 0,
        policy_version TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_shadow_trades_wallet ON shadow_trades (wallet);
      CREATE INDEX IF NOT EXISTS idx_shadow_trades_status ON shadow_trades (status);
      CREATE INDEX IF NOT EXISTS idx_shadow_trades_source_time ON shadow_trades (source_timestamp, status, category);
      CREATE INDEX IF NOT EXISTS idx_source_score_snapshots_time ON source_score_snapshots (created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_events_time ON agent_events (created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_bot_run_logs_time ON bot_run_logs (created_at DESC);
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
      CREATE TABLE IF NOT EXISTS trade_parity_metrics (
        id TEXT PRIMARY KEY,
        position_id TEXT,
        order_id TEXT,
        signal_id TEXT,
        profile TEXT,
        market_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        source_buy_timestamp INTEGER,
        bot_detected_timestamp INTEGER,
        order_sent_timestamp INTEGER,
        fill_timestamp INTEGER,
        shadow_expected_entry REAL,
        shadow_expected_exit REAL,
        actual_entry REAL,
        actual_exit REAL,
        entry_slippage REAL,
        exit_slippage REAL,
        missed_reason TEXT,
        partial_fill_reason TEXT,
        execution_policy TEXT,
        entry_book_depth REAL,
        entry_depth_multiple REAL,
        expected_live_executable_return_pct REAL,
        source_sell_realized_ratio REAL,
        aligned_wallets_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trade_parity_signal ON trade_parity_metrics (signal_id);
      CREATE INDEX IF NOT EXISTS idx_trade_parity_position ON trade_parity_metrics (position_id);
    `);
    this.ensureDiscoveredWalletColumns();
    this.ensureWalletResearchColumns();
    this.ensureWalletScoreColumns();
    this.ensureSourceScoreSnapshotColumns();
    this.ensureShadowTradeColumns();
    this.ensureExitEventColumns();
    this.ensureMarketColumns();
    this.ensureProfileColumns();
    this.ensureRiskEventColumns();
    this.ensureSignalColumns();
    this.ensurePaperOrderColumns();
    this.ensurePaperFillColumns();
    this.ensureTradeParityTable();
    this.ensureOrderBookColumns();
    this.ensureForwardSelectionColumns();
    this.backfillImmutableForwardSelections();
  }

  private ensureForwardSelectionColumns(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(forward_selections)").all() as Array<{ name: string }>).map((column) => column.name)
    );
    if (!columns.has("selection_stage")) {
      this.db.exec("ALTER TABLE forward_selections ADD COLUMN selection_stage TEXT NOT NULL DEFAULT 'PAPER_REVIEW'");
    }
  }

  private backfillImmutableForwardSelections(): void {
    const strategyRows = this.db.prepare(`
      SELECT opportunity_json FROM strategy_opportunities WHERE status = 'SELECTED'
    `).all() as Array<{ opportunity_json: string }>;
    for (const row of strategyRows) {
      const opportunity = JSON.parse(row.opportunity_json) as StrategyOpportunity;
      this.insertForwardSelection({
        id: forwardSelectionId(opportunity.strategyId, opportunity.policyVersion, opportunity.strategyEventKey),
        strategyId: opportunity.strategyId,
        cluster: opportunity.cluster,
        marketId: opportunity.marketId,
        tokenId: opportunity.tokenId,
        outcome: opportunity.outcome,
        policyVersion: opportunity.policyVersion,
        strategyEventKey: opportunity.strategyEventKey,
        selectionStage: "PAPER_REVIEW",
        selectedAt: opportunity.createdAt,
        selection: opportunity
      });
    }
    const weatherRows = this.db.prepare(`
      SELECT opportunity_json FROM weather_opportunities WHERE status = 'SELECTED'
    `).all() as Array<{ opportunity_json: string }>;
    for (const row of weatherRows) {
      const opportunity = JSON.parse(row.opportunity_json) as WeatherOpportunity;
      const policyVersion = opportunity.policyVersion ?? "weather-unfrozen";
      const strategyEventKey = opportunity.strategyEventKey ?? `${opportunity.marketId}:${opportunity.tokenId}`;
      this.insertForwardSelection({
        id: forwardSelectionId("weather_ensemble_fair_value_v2", policyVersion, strategyEventKey),
        strategyId: "weather_ensemble_fair_value_v2",
        cluster: "WEATHER_FORECASTING",
        marketId: opportunity.marketId,
        tokenId: opportunity.tokenId,
        outcome: opportunity.outcome,
        policyVersion,
        strategyEventKey,
        selectionStage: "PAPER_REVIEW",
        selectedAt: opportunity.createdAt,
        selection: opportunity
      });
    }
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

  private ensureWalletResearchColumns(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(wallet_research_reports)").all() as Array<{ name: string }>).map((column) => column.name)
    );
    if (!columns.has("first_observed_at")) this.db.exec("ALTER TABLE wallet_research_reports ADD COLUMN first_observed_at INTEGER");
    if (!columns.has("active")) this.db.exec("ALTER TABLE wallet_research_reports ADD COLUMN active INTEGER NOT NULL DEFAULT 1");
    this.db.exec("UPDATE wallet_research_reports SET first_observed_at = COALESCE(first_observed_at, updated_at)");
  }

  private ensurePaperFillColumns(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(paper_fills)").all() as Array<{ name: string }>).map((column) => column.name)
    );
    if (!columns.has("fee_usd")) this.db.exec("ALTER TABLE paper_fills ADD COLUMN fee_usd REAL NOT NULL DEFAULT 0");
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
      ["shadow_score_impact", "REAL"],
      ["source_sell_shadow_realized", "INTEGER"],
      ["source_sell_realized_ratio", "REAL"],
      ["live_executable_shadow_simulated", "INTEGER"],
      ["live_executable_shadow_pnl", "REAL"],
      ["live_executable_shadow_avg_return_pct", "REAL"],
      ["live_executable_shadow_win_rate", "REAL"]
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
      ["shadow_score_impact", "REAL"],
      ["source_sell_shadow_realized", "INTEGER"],
      ["source_sell_realized_ratio", "REAL"],
      ["live_executable_shadow_simulated", "INTEGER"],
      ["live_executable_shadow_pnl", "REAL"],
      ["live_executable_shadow_avg_return_pct", "REAL"],
      ["live_executable_shadow_win_rate", "REAL"]
    ];
    for (const [name, definition] of missing) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE source_score_snapshots ADD COLUMN ${name} ${definition}`);
    }
  }

  // The Overseer evaluates every open position on each pass but historically kept
  // no record of the book it decided against, so a stopped-out position left no
  // trace of the move that stopped it. Order-book snapshots do not fill the gap:
  // they are only persisted when the cached book goes stale, which for a position
  // that closes inside 30 minutes is almost never. Recording the mark here makes
  // the exit decision reconstructable after the fact.
  private ensureExitEventColumns(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(exit_events)").all() as Array<{ name: string }>).map((column) => column.name)
    );
    const missing: Array<[string, string]> = [
      ["best_bid", "REAL"],
      ["best_ask", "REAL"],
      ["entry_price", "REAL"],
      ["position_size", "REAL"],
      ["unrealized_pnl", "REAL"]
    ];
    for (const [name, definition] of missing) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE exit_events ADD COLUMN ${name} ${definition}`);
    }
  }

  private ensureShadowTradeColumns(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(shadow_trades)").all() as Array<{ name: string }>).map((column) => column.name)
    );
    const missing: Array<[string, string]> = [
      ["category", "TEXT"],
      ["live_executable_pnl", "REAL"],
      ["live_executable_return_pct", "REAL"],
      ["live_executable_status", "TEXT"],
      ["live_executable_reason", "TEXT"],
      ["live_executable_entry_price", "REAL"],
      ["live_executable_exit_price", "REAL"],
      ["live_executable_entry_slippage", "REAL"],
      ["live_executable_exit_slippage", "REAL"],
      ["source_observed_at", "INTEGER"],
      ["forward_eligible", "INTEGER NOT NULL DEFAULT 0"],
      ["policy_version", "TEXT"]
    ];
    for (const [name, definition] of missing) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE shadow_trades ADD COLUMN ${name} ${definition}`);
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_shadow_trades_forward_policy ON shadow_trades (forward_eligible, policy_version, source_timestamp)");
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

  private ensureSignalColumns(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(signals)").all() as Array<{ name: string }>).map((column) => column.name)
    );
    const missing: Array<[string, string]> = [
      ["condition_id", "TEXT"],
      ["source_buy_timestamp", "INTEGER"],
      ["bot_detected_timestamp", "INTEGER"],
      ["expected_entry_price", "REAL"],
      ["expected_exit_price", "REAL"],
      ["expected_live_executable_return_pct", "REAL"],
      ["entry_book_depth", "REAL"],
      ["entry_depth_multiple", "REAL"],
      ["max_entry_slippage", "REAL"],
      ["source_sell_realized_ratio", "REAL"],
      ["parity_status", "TEXT"],
      ["parity_reason", "TEXT"],
      ["model_json", "TEXT"]
    ];
    for (const [name, definition] of missing) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE signals ADD COLUMN ${name} ${definition}`);
    }
  }

  private ensurePaperOrderColumns(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(paper_orders)").all() as Array<{ name: string }>).map((column) => column.name)
    );
    const missing: Array<[string, string]> = [
      ["execution_policy", "TEXT"],
      ["fee_rate", "REAL"],
      ["missed_reason", "TEXT"],
      ["partial_fill_reason", "TEXT"]
    ];
    for (const [name, definition] of missing) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE paper_orders ADD COLUMN ${name} ${definition}`);
    }
  }

  private ensureTradeParityTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trade_parity_metrics (
        id TEXT PRIMARY KEY,
        position_id TEXT,
        order_id TEXT,
        signal_id TEXT,
        profile TEXT,
        market_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        source_buy_timestamp INTEGER,
        bot_detected_timestamp INTEGER,
        order_sent_timestamp INTEGER,
        fill_timestamp INTEGER,
        shadow_expected_entry REAL,
        shadow_expected_exit REAL,
        actual_entry REAL,
        actual_exit REAL,
        entry_slippage REAL,
        exit_slippage REAL,
        missed_reason TEXT,
        partial_fill_reason TEXT,
        execution_policy TEXT,
        entry_book_depth REAL,
        entry_depth_multiple REAL,
        expected_live_executable_return_pct REAL,
        source_sell_realized_ratio REAL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trade_parity_signal ON trade_parity_metrics (signal_id);
      CREATE INDEX IF NOT EXISTS idx_trade_parity_position ON trade_parity_metrics (position_id);
    `);
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(trade_parity_metrics)").all() as Array<{ name: string }>).map((column) => column.name)
    );
    if (!columns.has("aligned_wallets_json")) this.db.exec("ALTER TABLE trade_parity_metrics ADD COLUMN aligned_wallets_json TEXT");
  }

  private ensureOrderBookColumns(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(orderbook_snapshots)").all() as Array<{ name: string }>).map((column) => column.name)
    );
    if (!columns.has("tick_size")) this.db.exec("ALTER TABLE orderbook_snapshots ADD COLUMN tick_size REAL");
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
       shadow_pnl, shadow_avg_return_pct, shadow_win_rate, shadow_score_impact, source_sell_shadow_realized, source_sell_realized_ratio,
       live_executable_shadow_simulated, live_executable_shadow_pnl, live_executable_shadow_avg_return_pct, live_executable_shadow_win_rate,
       trade_count, recent_trade_count, reliability, flags_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      score.sourceSellShadowRealized ?? null,
      score.sourceSellRealizedRatio ?? null,
      score.liveExecutableShadowSimulated ?? null,
      score.liveExecutableShadowPnl ?? null,
      score.liveExecutableShadowAvgReturnPct ?? null,
      score.liveExecutableShadowWinRate ?? null,
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

  getMarketById(id: string): MarketSnapshot | undefined {
    const row = this.db.prepare(`
      SELECT * FROM markets
      WHERE id = ? OR condition_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(id, id) as unknown as DbMarket | undefined;
    return row ? rowToMarket(row) : undefined;
  }

  getPositionEntryPolicy(positionId: string): Pick<TradeSignal, "strategyId" | "policyVersion" | "exitPolicy"> {
    const row = this.db.prepare(`
      SELECT s.model_json
      FROM paper_orders po
      JOIN signals s ON s.id = po.signal_id
      WHERE po.side = 'BUY'
        AND COALESCE(po.profile, 'Shared') || ':' || po.market_id || ':' || po.token_id || ':' || po.id = ?
      ORDER BY po.created_at ASC
      LIMIT 1
    `).get(positionId) as { model_json: string | null } | undefined;
    if (!row?.model_json) return {};
    try {
      const model = JSON.parse(row.model_json) as Partial<TradeSignal>;
      return {
        strategyId: model.strategyId,
        policyVersion: model.policyVersion,
        exitPolicy: model.exitPolicy
      };
    } catch {
      return {};
    }
  }

  saveOrderBook(book: OrderBookSnapshot): void {
    this.db.prepare(`
      INSERT INTO orderbook_snapshots
      (token_id, market_id, best_bid, best_ask, spread, depth, tick_size, raw_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      book.tokenId,
      book.marketId ?? null,
      book.bestBid ?? null,
      book.bestAsk ?? null,
      book.spread ?? null,
      book.depth,
      book.tickSize ?? null,
      JSON.stringify(book.raw ?? null),
      book.timestamp
    );
  }

  saveSignal(signal: TradeSignal): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO signals
      (id, decision, market_id, condition_id, token_id, outcome, side, confidence, limit_price, aligned_wallets_json, reason,
       source_buy_timestamp, bot_detected_timestamp, expected_entry_price, expected_exit_price, expected_live_executable_return_pct,
       entry_book_depth, entry_depth_multiple, max_entry_slippage, source_sell_realized_ratio, parity_status, parity_reason, model_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      signal.id,
      signal.decision,
      signal.marketId,
      signal.conditionId ?? null,
      signal.tokenId,
      signal.outcome,
      signal.side,
      signal.confidence,
      signal.limitPrice,
      JSON.stringify(signal.alignedWallets),
      signal.reason,
      signal.sourceBuyTimestamp ?? null,
      signal.botDetectedTimestamp ?? null,
      signal.expectedEntryPrice ?? null,
      signal.expectedExitPrice ?? null,
      signal.expectedLiveExecutableReturnPct ?? null,
      signal.entryBookDepth ?? null,
      signal.entryDepthMultiple ?? null,
      signal.maxEntrySlippage ?? null,
      signal.sourceSellRealizedRatio ?? null,
      signal.parityStatus ?? null,
      signal.parityReason ?? null,
      JSON.stringify({
        signalOrigin: signal.signalOrigin,
        strategyId: signal.strategyId,
        strategyHypothesisId: signal.strategyHypothesisId,
        fairProbability: signal.fairProbability,
        marketProbability: signal.marketProbability,
        probabilityEdge: signal.probabilityEdge,
        expectedValuePct: signal.expectedValuePct,
        modelUncertainty: signal.modelUncertainty,
        modelAgreement: signal.modelAgreement,
        forecastSampleSize: signal.forecastSampleSize,
        policyVersion: signal.policyVersion,
        strategyEventKey: signal.strategyEventKey,
        exitPolicy: signal.exitPolicy,
        resolutionTimestamp: signal.resolutionTimestamp,
        targetPositionSizeUsd: signal.targetPositionSizeUsd
      }),
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
      (id, signal_id, profile, market_id, token_id, outcome, side, price, size, remaining_size, status, created_at, expires_at,
       execution_policy, fee_rate, missed_reason, partial_fill_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      order.expiresAt,
      order.executionPolicy ?? null,
      order.feeRate ?? null,
      order.missedReason ?? null,
      order.partialFillReason ?? null
    );
  }

  getLatestPaperExitOrder(positionId: string): PaperOrder | undefined {
    const row = this.db.prepare(`
      SELECT *
      FROM paper_orders
      WHERE signal_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(`exit:${positionId}`) as unknown as DbPaperOrder | undefined;
    return row ? rowToPaperOrder(row) : undefined;
  }

  countRecentPaperExitMisses(positionId: string, since: number): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM paper_orders
      WHERE signal_id = ?
        AND side = 'SELL'
        AND status = 'EXPIRED'
        AND created_at >= ?
    `).get(`exit:${positionId}`, since) as { count: number };
    return Number(row.count ?? 0);
  }

  expireStalePaperOrders(now = Date.now()): number {
    const result = this.db.prepare(`
      UPDATE paper_orders
      SET status = 'EXPIRED'
      WHERE status IN ('OPEN', 'PARTIAL')
        AND expires_at <= ?
    `).run(now);
    return Number(result.changes ?? 0);
  }

  saveFill(fill: PaperFill): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO paper_fills
      (id, order_id, market_id, token_id, side, price, size, fee_usd, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(fill.id, fill.orderId, fill.marketId, fill.tokenId, fill.side, fill.price, fill.size, fill.feeUsd ?? 0, fill.timestamp);
  }

  saveTradeParityMetric(metric: TradeParityMetric): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO trade_parity_metrics
      (id, position_id, order_id, signal_id, profile, market_id, token_id, outcome, source_buy_timestamp, bot_detected_timestamp,
       order_sent_timestamp, fill_timestamp, shadow_expected_entry, shadow_expected_exit, actual_entry, actual_exit,
       entry_slippage, exit_slippage, missed_reason, partial_fill_reason, execution_policy, entry_book_depth, entry_depth_multiple,
       expected_live_executable_return_pct, source_sell_realized_ratio, aligned_wallets_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      metric.id,
      metric.positionId ?? null,
      metric.orderId ?? null,
      metric.signalId ?? null,
      metric.profile ?? null,
      metric.marketId,
      metric.tokenId,
      metric.outcome,
      metric.sourceBuyTimestamp ?? null,
      metric.botDetectedTimestamp ?? null,
      metric.orderSentTimestamp ?? null,
      metric.fillTimestamp ?? null,
      metric.shadowExpectedEntry ?? null,
      metric.shadowExpectedExit ?? null,
      metric.actualEntry ?? null,
      metric.actualExit ?? null,
      metric.entrySlippage ?? null,
      metric.exitSlippage ?? null,
      metric.missedReason ?? null,
      metric.partialFillReason ?? null,
      metric.executionPolicy ?? null,
      metric.entryBookDepth ?? null,
      metric.entryDepthMultiple ?? null,
      metric.expectedLiveExecutableReturnPct ?? null,
      metric.sourceSellRealizedRatio ?? null,
      metric.alignedWallets ? JSON.stringify(metric.alignedWallets.map((wallet) => wallet.toLowerCase())) : null,
      metric.createdAt,
      metric.updatedAt
    );
  }

  recordPaperEntryParity(signal: TradeSignal, order: PaperOrder, fill?: PaperFill, position?: Position): void {
    const now = Date.now();
    this.saveTradeParityMetric({
      id: `parity:${order.id}`,
      positionId: position?.id,
      orderId: order.id,
      signalId: signal.id,
      profile: order.profile,
      marketId: order.marketId,
      tokenId: order.tokenId,
      outcome: order.outcome,
      sourceBuyTimestamp: signal.sourceBuyTimestamp,
      botDetectedTimestamp: signal.botDetectedTimestamp ?? signal.createdAt,
      orderSentTimestamp: order.createdAt,
      fillTimestamp: fill?.timestamp,
      shadowExpectedEntry: signal.expectedEntryPrice ?? signal.limitPrice,
      shadowExpectedExit: signal.expectedExitPrice,
      actualEntry: fill?.price,
      entrySlippage: fill && signal.expectedEntryPrice !== undefined ? fill.price - signal.expectedEntryPrice : undefined,
      missedReason: order.missedReason ?? (order.status === "EXPIRED" && !fill ? "entry did not fill" : signal.parityStatus === "FAIL" ? signal.parityReason : undefined),
      partialFillReason: order.partialFillReason ?? (order.status === "PARTIAL" ? "partial paper fill" : undefined),
      executionPolicy: order.executionPolicy,
      entryBookDepth: signal.entryBookDepth,
      entryDepthMultiple: signal.entryDepthMultiple,
      expectedLiveExecutableReturnPct: signal.expectedLiveExecutableReturnPct,
      sourceSellRealizedRatio: signal.sourceSellRealizedRatio,
      alignedWallets: signal.alignedWallets,
      createdAt: now,
      updatedAt: now
    });
  }

  updateParityExit(position: Position, expectedExitPrice?: number): void {
    const row = this.db.prepare(`
      SELECT id, actual_entry
      FROM trade_parity_metrics
      WHERE position_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(position.id) as { id: string; actual_entry: number | null } | undefined;
    if (!row) return;
    const actualEntry = row.actual_entry ?? position.avgEntryPrice;
    this.db.prepare(`
      UPDATE trade_parity_metrics
      SET shadow_expected_exit = COALESCE(?, shadow_expected_exit),
          actual_exit = ?,
          exit_slippage = CASE WHEN ? IS NULL THEN NULL ELSE ? - ? END,
          updated_at = ?
      WHERE id = ?
    `).run(
      expectedExitPrice ?? null,
      position.currentPrice,
      expectedExitPrice ?? null,
      expectedExitPrice ?? actualEntry,
      position.currentPrice,
      Date.now(),
      row.id
    );
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

  saveExitDecision(positionId: string, exit: ExitDecision, mark?: ExitDecisionMark): void {
    const unrealizedPnl = mark?.bestBid !== undefined && mark.entryPrice !== undefined && mark.size !== undefined
      ? mark.size * (mark.bestBid - mark.entryPrice)
      : undefined;
    this.db.prepare(`
      INSERT INTO exit_events
      (id, position_id, decision, exit_probability, reason, created_at,
       best_bid, best_ask, entry_price, position_size, unrealized_pnl)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomId("exit"), positionId, exit.decision, exit.exitProbability, exit.reason, Date.now(),
      mark?.bestBid ?? null, mark?.bestAsk ?? null, mark?.entryPrice ?? null, mark?.size ?? null, unrealizedPnl ?? null
    );
  }

  getWalletsWithShadowEvidence(limit = 25): string[] {
    const rows = this.db.prepare(`
      SELECT wallet FROM wallet_scores
      WHERE live_executable_shadow_simulated > 0
      ORDER BY live_executable_shadow_simulated DESC
      LIMIT ?
    `).all(limit) as unknown as Array<{ wallet: string }>;
    return rows.map((row) => row.wallet);
  }

  saveWalletResearchReport(report: WalletResearchReport): void {
    const existing = this.db.prepare("SELECT first_observed_at FROM wallet_research_reports WHERE wallet = ?").get(report.wallet.toLowerCase()) as
      { first_observed_at: number | null } | undefined;
    const firstObservedAt = Number(existing?.first_observed_at ?? report.firstObservedAt ?? report.updatedAt);
    const persisted = { ...report, firstObservedAt };
    this.db.prepare(`
      INSERT INTO wallet_research_reports
      (wallet, name, archetype, recommendation, research_score, report_json, first_observed_at, updated_at, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(wallet) DO UPDATE SET
        name = excluded.name,
        archetype = excluded.archetype,
        recommendation = excluded.recommendation,
        research_score = excluded.research_score,
        report_json = excluded.report_json,
        updated_at = excluded.updated_at,
        active = 1
    `).run(
      report.wallet.toLowerCase(),
      report.name ?? null,
      report.archetype,
      report.recommendation,
      report.researchScore,
      JSON.stringify(persisted),
      firstObservedAt,
      report.updatedAt
    );
  }

  activateWalletResearchReports(reports: WalletResearchReport[]): void {
    if (reports.length === 0) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("UPDATE wallet_research_reports SET active = 0");
      for (const report of reports) this.saveWalletResearchReport(report);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getWalletResearchReports(limit = 30): WalletResearchReport[] {
    const rows = this.db.prepare(`
      SELECT report_json, first_observed_at
      FROM wallet_research_reports
      WHERE active = 1
      ORDER BY research_score DESC, updated_at DESC
      LIMIT ?
    `).all(limit) as Array<{ report_json: string; first_observed_at: number }>;
    return rows.map((row) => ({ ...JSON.parse(row.report_json), firstObservedAt: row.first_observed_at }) as WalletResearchReport);
  }

  getWalletResearchReportsByWallets(wallets: string[]): Map<string, WalletResearchReport> {
    const unique = [...new Set(wallets.map((wallet) => wallet.toLowerCase()).filter(Boolean))];
    if (unique.length === 0) return new Map();
    const rows: Array<{ wallet: string; report_json: string; first_observed_at: number }> = [];
    for (let index = 0; index < unique.length; index += 400) {
      const chunk = unique.slice(index, index + 400);
      rows.push(...this.db.prepare(`
        SELECT wallet, report_json, first_observed_at
        FROM wallet_research_reports
        WHERE active = 1 AND wallet IN (${chunk.map(() => "?").join(", ")})
      `).all(...chunk) as Array<{ wallet: string; report_json: string; first_observed_at: number }>);
    }
    return new Map(rows.map((row) => [row.wallet, ({ ...JSON.parse(row.report_json), firstObservedAt: row.first_observed_at }) as WalletResearchReport]));
  }

  getLatestWalletResearchAt(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(updated_at), 0) AS updated_at FROM wallet_research_reports WHERE active = 1").get() as { updated_at: number };
    return Number(row.updated_at ?? 0);
  }

  saveStrategyHypothesis(hypothesis: StrategyHypothesis): void {
    this.db.prepare(`
      INSERT INTO strategy_hypotheses (id, cluster, status, hypothesis_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET cluster = excluded.cluster, status = excluded.status,
        hypothesis_json = excluded.hypothesis_json, updated_at = excluded.updated_at
    `).run(hypothesis.id, hypothesis.cluster, hypothesis.status, JSON.stringify(hypothesis), hypothesis.updatedAt);
  }

  getStrategyHypotheses(): StrategyHypothesis[] {
    const rows = this.db.prepare("SELECT hypothesis_json FROM strategy_hypotheses ORDER BY updated_at DESC").all() as Array<{ hypothesis_json: string }>;
    return rows.map((row) => JSON.parse(row.hypothesis_json) as StrategyHypothesis);
  }

  saveStrategyBacktest(result: StrategyBacktestResult): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO strategy_backtests
      (id, hypothesis_id, cluster, test_kind, independent, sample_size, passed, result_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(result.id, result.hypothesisId, result.cluster, result.testKind, result.independentFromLeadWallets ? 1 : 0,
      result.sampleSize, result.passed ? 1 : 0, JSON.stringify(result), result.createdAt);
  }

  getLatestStrategyBacktests(): StrategyBacktestResult[] {
    const rows = this.db.prepare(`
      SELECT result_json FROM strategy_backtests b
      WHERE created_at = (SELECT MAX(created_at) FROM strategy_backtests x WHERE x.hypothesis_id = b.hypothesis_id)
      ORDER BY created_at DESC
    `).all() as Array<{ result_json: string }>;
    return rows.map((row) => JSON.parse(row.result_json) as StrategyBacktestResult);
  }

  getLatestStrategyBacktestAt(cluster: string): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(created_at), 0) AS created_at FROM strategy_backtests WHERE cluster = ?").get(cluster) as { created_at: number };
    return Number(row.created_at ?? 0);
  }

  saveDailyScorecardSnapshot(snapshot: DailyScorecardSnapshot): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO daily_scorecard_snapshots
      (id, snapshot_date, policy_fingerprint, scorecard_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(snapshot.id, snapshot.snapshotDate, snapshot.policyFingerprint, JSON.stringify(snapshot.scorecard), snapshot.createdAt);
    return Number(result.changes) === 1;
  }

  getLatestDailyScorecardSnapshot(): DailyScorecardSnapshot | undefined {
    const row = this.db.prepare(`
      SELECT id, snapshot_date, policy_fingerprint, scorecard_json, created_at
      FROM daily_scorecard_snapshots
      ORDER BY created_at DESC
      LIMIT 1
    `).get() as {
      id: string;
      snapshot_date: string;
      policy_fingerprint: string;
      scorecard_json: string;
      created_at: number;
    } | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      snapshotDate: row.snapshot_date,
      policyFingerprint: row.policy_fingerprint,
      scorecard: JSON.parse(row.scorecard_json) as DailyCoreScorecard,
      createdAt: row.created_at
    };
  }

  getDailyScorecardSnapshots(limit = 30): DailyScorecardSnapshot[] {
    const rows = this.db.prepare(`
      SELECT id, snapshot_date, policy_fingerprint, scorecard_json, created_at
      FROM daily_scorecard_snapshots
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as Array<{
      id: string;
      snapshot_date: string;
      policy_fingerprint: string;
      scorecard_json: string;
      created_at: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      snapshotDate: row.snapshot_date,
      policyFingerprint: row.policy_fingerprint,
      scorecard: JSON.parse(row.scorecard_json) as DailyCoreScorecard,
      createdAt: row.created_at
    }));
  }

  saveWeatherOpportunity(opportunity: WeatherOpportunity): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO weather_opportunities
      (id, signal_id, market_id, token_id, status, opportunity_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(opportunity.id, opportunity.signalId ?? null, opportunity.marketId, opportunity.tokenId,
      opportunity.status, JSON.stringify(opportunity), opportunity.createdAt);
  }

  private insertForwardSelection(selection: ForwardSelection): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO forward_selections
      (id, strategy_id, cluster, market_id, token_id, outcome, policy_version, strategy_event_key, selection_stage, selection_json, selected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      selection.id,
      selection.strategyId,
      selection.cluster,
      selection.marketId,
      selection.tokenId,
      selection.outcome,
      selection.policyVersion,
      selection.strategyEventKey,
      selection.selectionStage,
      JSON.stringify(selection.selection),
      selection.selectedAt
    );
    return Number(result.changes) === 1;
  }

  getForwardSelections(limit = 100): ForwardSelection[] {
    const rows = this.db.prepare(`
      SELECT id, strategy_id, cluster, market_id, token_id, outcome, policy_version,
        strategy_event_key, selection_stage, selection_json, selected_at
      FROM forward_selections
      ORDER BY selected_at DESC
      LIMIT ?
    `).all(limit) as Array<{
      id: string;
      strategy_id: string;
      cluster: ForwardSelection["cluster"];
      market_id: string;
      token_id: string;
      outcome: ForwardSelection["outcome"];
      policy_version: string;
      strategy_event_key: string;
      selection_stage: ForwardSelection["selectionStage"];
      selection_json: string;
      selected_at: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      strategyId: row.strategy_id,
      cluster: row.cluster,
      marketId: row.market_id,
      tokenId: row.token_id,
      outcome: row.outcome,
      policyVersion: row.policy_version,
      strategyEventKey: row.strategy_event_key,
      selectionStage: row.selection_stage,
      selection: JSON.parse(row.selection_json) as ForwardSelection["selection"],
      selectedAt: row.selected_at
    }));
  }

  saveWeatherTournamentObservation(observation: WeatherTournamentObservation): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO weather_tournament_observations
      (id, tournament_version, arm_id, station_code, target_date, market_id, token_id, outcome, observation_json, selected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      observation.id,
      observation.tournamentVersion,
      observation.armId,
      observation.stationCode,
      observation.targetDate,
      observation.marketId,
      observation.tokenId,
      observation.outcome,
      JSON.stringify(observation),
      observation.selectedAt
    );
    return Number(result.changes ?? 0) === 1;
  }

  getWeatherTournamentObservations(tournamentVersion: string): WeatherTournamentObservation[] {
    const rows = this.db.prepare(`
      SELECT observation_json
      FROM weather_tournament_observations
      WHERE tournament_version = ?
      ORDER BY selected_at ASC
    `).all(tournamentVersion) as Array<{ observation_json: string }>;
    return rows.map((row) => JSON.parse(row.observation_json) as WeatherTournamentObservation);
  }

  getWeatherTournamentSettlementMarketIds(tournamentVersion: string, now = Date.now(), limit = 20): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT w.market_id
      FROM weather_tournament_observations w
      LEFT JOIN markets m ON m.id = w.market_id
      WHERE w.tournament_version = ?
        AND CAST(json_extract(w.observation_json, '$.resolutionTimestamp') AS INTEGER) <= ?
        AND (m.winning_outcome IS NULL OR m.winning_outcome = '')
      ORDER BY w.selected_at ASC
      LIMIT ?
    `).all(tournamentVersion, now, Math.max(1, Math.floor(limit))) as Array<{ market_id: string }>;
    return rows.map((row) => row.market_id);
  }

  getWeatherOpportunities(limit = 100): WeatherOpportunity[] {
    const rows = this.db.prepare("SELECT opportunity_json FROM weather_opportunities ORDER BY created_at DESC LIMIT ?").all(limit) as Array<{ opportunity_json: string }>;
    return rows.map((row) => JSON.parse(row.opportunity_json) as WeatherOpportunity);
  }

  saveStrategyOpportunity(opportunity: StrategyOpportunity): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO strategy_opportunities
      (id, signal_id, strategy_id, cluster, market_id, token_id, status, opportunity_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      opportunity.id,
      opportunity.signalId ?? null,
      opportunity.strategyId,
      opportunity.cluster,
      opportunity.marketId,
      opportunity.tokenId,
      opportunity.status,
      JSON.stringify(opportunity),
      opportunity.createdAt
    );
  }

  saveMacroForecastVintage(vintage: MacroForecastVintage): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO macro_forecast_vintages
      (id, source, reference_period, fetched_at, source_updated_at, vintage_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      vintage.id,
      vintage.source,
      vintage.referencePeriod,
      vintage.fetchedAt,
      vintage.sourceUpdatedAt,
      JSON.stringify(vintage)
    );
    return Number(result.changes ?? 0) === 1;
  }

  getLatestMacroForecastVintage(referencePeriod: string): MacroForecastVintage | undefined {
    const row = this.db.prepare(`
      SELECT vintage_json
      FROM macro_forecast_vintages
      WHERE reference_period = ?
      ORDER BY fetched_at DESC
      LIMIT 1
    `).get(referencePeriod) as { vintage_json: string } | undefined;
    return row ? JSON.parse(row.vintage_json) as MacroForecastVintage : undefined;
  }

  markStrategyOpportunityResearchSelected(signalId: string): boolean {
    const row = this.db.prepare(`
      SELECT id, opportunity_json
      FROM strategy_opportunities
      WHERE signal_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(signalId) as { id: string; opportunity_json: string } | undefined;
    if (!row) return false;
    const opportunity = JSON.parse(row.opportunity_json) as StrategyOpportunity;
    if (opportunity.researchEligible !== true) return false;
    opportunity.status = "RESEARCH_SELECTED";
    const inserted = this.insertForwardSelection({
      id: forwardSelectionId(opportunity.strategyId, opportunity.policyVersion, opportunity.strategyEventKey),
      strategyId: opportunity.strategyId,
      cluster: opportunity.cluster,
      marketId: opportunity.marketId,
      tokenId: opportunity.tokenId,
      outcome: opportunity.outcome,
      policyVersion: opportunity.policyVersion,
      strategyEventKey: opportunity.strategyEventKey,
      selectionStage: "RESEARCH",
      selectedAt: opportunity.createdAt,
      selection: opportunity
    });
    if (!inserted) return false;
    this.db.prepare(`
      UPDATE strategy_opportunities
      SET status = 'RESEARCH_SELECTED', opportunity_json = ?
      WHERE id = ?
    `).run(JSON.stringify(opportunity), row.id);
    return true;
  }

  markStrategyOpportunitySelected(signalId: string): boolean {
    const row = this.db.prepare(`
      SELECT id, opportunity_json
      FROM strategy_opportunities
      WHERE signal_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(signalId) as { id: string; opportunity_json: string } | undefined;
    if (!row) return false;
    const opportunity = JSON.parse(row.opportunity_json) as StrategyOpportunity;
    const alreadySelected = this.db.prepare(`
      SELECT 1
      FROM strategy_opportunities
      WHERE strategy_id = ?
        AND status = 'SELECTED'
        AND json_extract(opportunity_json, '$.policyVersion') = ?
        AND json_extract(opportunity_json, '$.strategyEventKey') = ?
      LIMIT 1
    `).get(opportunity.strategyId, opportunity.policyVersion, opportunity.strategyEventKey);
    if (alreadySelected) return false;
    opportunity.status = "SELECTED";
    this.insertForwardSelection({
      id: forwardSelectionId(opportunity.strategyId, opportunity.policyVersion, opportunity.strategyEventKey),
      strategyId: opportunity.strategyId,
      cluster: opportunity.cluster,
      marketId: opportunity.marketId,
      tokenId: opportunity.tokenId,
      outcome: opportunity.outcome,
      policyVersion: opportunity.policyVersion,
      strategyEventKey: opportunity.strategyEventKey,
      selectionStage: "PAPER_REVIEW",
      selectedAt: opportunity.createdAt,
      selection: opportunity
    });
    this.db.prepare(`
      UPDATE strategy_opportunities
      SET status = 'SELECTED', opportunity_json = ?
      WHERE id = ?
    `).run(JSON.stringify(opportunity), row.id);
    return true;
  }

  getStrategyForwardScorecard(input: {
    strategyId: string;
    cluster: StrategyOpportunity["cluster"];
    since: number;
    policyVersion: string;
    positionSizeUsd: number;
    minResolvedTrades: number;
    minReturnPct: number;
  }): StrategyForwardScorecard {
    const rows = this.db.prepare(`
      SELECT selection_json
      FROM forward_selections
      WHERE strategy_id = ? AND selected_at >= ? AND policy_version = ?
      ORDER BY selected_at ASC
    `).all(input.strategyId, input.since, input.policyVersion) as Array<{ selection_json: string }>;
    const observations = rows
      .map((row) => JSON.parse(row.selection_json) as StrategyOpportunity)
      .filter((opportunity) => opportunity.policyVersion === input.policyVersion);
    const unique = new Map<string, StrategyOpportunity>();
    for (const opportunity of observations) {
      if (!unique.has(opportunity.strategyEventKey)) unique.set(opportunity.strategyEventKey, opportunity);
    }

    let wins = 0;
    let losses = 0;
    let settlementPnl = 0;
    let modelBrier = 0;
    let marketBrier = 0;
    for (const opportunity of unique.values()) {
      const market = this.getMarketById(opportunity.marketId);
      if (!market?.winningOutcome) continue;
      const won = normalizeOutcomeText(market.winningOutcome) === normalizeOutcomeText(String(opportunity.outcome));
      if (won) wins += 1;
      else losses += 1;
      const actual = won ? 1 : 0;
      modelBrier += (opportunity.fairProbability - actual) ** 2;
      marketBrier += (opportunity.marketProbability - actual) ** 2;
      const shares = input.positionSizeUsd / opportunity.marketProbability;
      const feeRate = market.feesEnabled === false ? 0 : market.takerFeeRate ?? 0;
      settlementPnl += (won ? shares : 0) - input.positionSizeUsd - takerFeeUsd(shares, opportunity.marketProbability, feeRate);
    }

    const paperRows = this.db.prepare(`
      SELECT DISTINCT p.id, p.status, p.realized_pnl, p.avg_entry_price * p.size AS entry_cost
      FROM positions p
      JOIN paper_orders po
        ON po.market_id = p.market_id
       AND po.token_id = p.token_id
       AND COALESCE(po.profile, 'Shared') = COALESCE(p.profile, 'Shared')
       AND po.side = 'BUY'
       AND p.id = COALESCE(po.profile, 'Shared') || ':' || po.market_id || ':' || po.token_id || ':' || po.id
      JOIN signals s ON s.id = po.signal_id
      WHERE po.created_at >= ?
        AND s.model_json LIKE ?
        AND s.model_json LIKE ?
    `).all(
      input.since,
      `%\"policyVersion\":\"${input.policyVersion.replaceAll('"', '')}\"%`,
      `%\"strategyId\":\"${input.strategyId.replaceAll('"', '')}\"%`
    ) as Array<{ id: string; status: Position["status"]; realized_pnl: number; entry_cost: number }>;
    const closedPaper = paperRows.filter((row) => row.status === "CLOSED");
    const paperPnl = closedPaper.reduce((sum, row) => sum + row.realized_pnl, 0);
    const paperCapital = closedPaper.reduce((sum, row) => sum + row.entry_cost, 0);
    const resolved = wins + losses;
    const settlementReturnPct = resolved > 0 ? settlementPnl / (resolved * input.positionSizeUsd) : 0;
    const paperReturnPct = paperCapital > 0 ? paperPnl / paperCapital : 0;
    const calibrated = resolved > 0 && modelBrier / resolved <= marketBrier / resolved;
    const researchPromotionEligible = resolved >= input.minResolvedTrades &&
      settlementReturnPct >= input.minReturnPct && calibrated;
    const researchPromotionReason = resolved < input.minResolvedTrades
      ? `needs ${input.minResolvedTrades} resolved immutable research selections; has ${resolved}`
      : settlementReturnPct < input.minReturnPct
        ? `research settlement return must be at least ${(input.minReturnPct * 100).toFixed(1)}%; has ${(settlementReturnPct * 100).toFixed(1)}%`
        : !calibrated
          ? "research model probability is less calibrated than the market"
          : "research sample, settlement profitability, and calibration gates passed";
    const walkForwardPassed = this.getLatestStrategyBacktests().some((item) =>
      item.cluster === input.cluster && item.testKind === "WALK_FORWARD_PROBABILITY" && item.passed
    );
    const experimentalPaperEligible = walkForwardPassed && researchPromotionEligible;
    const standardPaperEligible = experimentalPaperEligible &&
      closedPaper.length >= input.minResolvedTrades && paperReturnPct >= input.minReturnPct;
    const promotionEligible = standardPaperEligible;
    const promotionReason = !walkForwardPassed
      ? "independent walk-forward validation has not passed"
      : !researchPromotionEligible
        ? researchPromotionReason
        : closedPaper.length < input.minResolvedTrades
          ? `experimental paper needs ${input.minResolvedTrades} closed positions; has ${closedPaper.length}`
          : paperReturnPct < input.minReturnPct
            ? `paper return must be at least ${(input.minReturnPct * 100).toFixed(1)}%; has ${(paperReturnPct * 100).toFixed(1)}%`
            : "walk-forward, clean research-forward, and paper gates passed";
    return {
      strategyId: input.strategyId,
      cluster: input.cluster,
      policyVersion: input.policyVersion,
      since: input.since,
      positionSizeUsd: input.positionSizeUsd,
      observations: unique.size,
      uniqueCandidates: unique.size,
      executedCandidates: paperRows.length,
      closedPaperPositions: closedPaper.length,
      resolved,
      unresolved: unique.size - resolved,
      wins,
      losses,
      winRate: resolved > 0 ? wins / resolved : 0,
      settlementPnl: roundMoney(settlementPnl),
      settlementReturnPct,
      paperPnl: roundMoney(paperPnl),
      paperReturnPct,
      modelBrierScore: resolved > 0 ? modelBrier / resolved : undefined,
      marketBrierScore: resolved > 0 ? marketBrier / resolved : undefined,
      researchPromotionEligible,
      researchPromotionReason,
      experimentalPaperEligible,
      standardPaperEligible,
      promotionEligible,
      promotionReason
    };
  }

  insertExecutionResearchCandidate(candidate: ExecutionResearchCandidate): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO execution_research_candidates
      (id, strategy, policy_version, event_key, market_ids_json, token_ids_json,
       observed_at, expires_at, notional_usd, expected_gross_edge_usd,
       expected_net_edge_usd, candidate_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      candidate.id,
      candidate.strategy,
      candidate.policyVersion,
      candidate.eventKey,
      JSON.stringify(candidate.marketIds),
      JSON.stringify(candidate.tokenIds),
      candidate.observedAt,
      candidate.expiresAt,
      candidate.notionalUsd,
      candidate.expectedGrossEdgeUsd,
      candidate.expectedNetEdgeUsd,
      JSON.stringify(candidate)
    );
    return Number(result.changes ?? 0) > 0;
  }

  insertExecutionResearchResult(result: ExecutionResearchResult): boolean {
    const inserted = this.db.prepare(`
      INSERT OR IGNORE INTO execution_research_results
      (id, candidate_id, strategy, policy_version, event_key, status, pnl_usd,
       capital_usd, return_pct, filled_legs, latency_ms, adverse_selection_5m,
       resolved_at, result_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      result.id,
      result.candidateId,
      result.strategy,
      result.policyVersion,
      result.eventKey,
      result.status,
      result.pnlUsd,
      result.capitalUsd,
      result.returnPct,
      result.filledLegs,
      result.latencyMs,
      result.adverseSelection5m ?? null,
      result.resolvedAt,
      JSON.stringify(result)
    );
    return Number(inserted.changes ?? 0) > 0;
  }

  getExpiredUnresolvedExecutionResearchCandidates(input: {
    strategy: ExecutionResearchStrategy;
    policyVersion: string;
    expiredBefore: number;
  }): ExecutionResearchCandidate[] {
    const rows = this.db.prepare(`
      SELECT c.candidate_json
      FROM execution_research_candidates c
      LEFT JOIN execution_research_results r ON r.candidate_id = c.id
      WHERE c.strategy = ? AND c.policy_version = ? AND c.expires_at <= ? AND r.candidate_id IS NULL
      ORDER BY c.observed_at ASC
    `).all(input.strategy, input.policyVersion, input.expiredBefore) as Array<{ candidate_json: string }>;
    return rows.map((row) => JSON.parse(row.candidate_json) as ExecutionResearchCandidate);
  }

  saveExecutionResearchState(stateKey: string, state: unknown, updatedAt = Date.now()): void {
    this.db.prepare(`
      INSERT INTO execution_research_state (state_key, state_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(state_key) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at
    `).run(stateKey, JSON.stringify(state), updatedAt);
  }

  getExecutionResearchState<T>(stateKey: string): T | undefined {
    const row = this.db.prepare("SELECT state_json FROM execution_research_state WHERE state_key = ?").get(stateKey) as { state_json: string } | undefined;
    return row ? JSON.parse(row.state_json) as T : undefined;
  }

  getExecutionResearchPolicyWindows(): Array<{
    strategy: ExecutionResearchStrategy;
    policyVersion: string;
    firstObservedAt: number;
    lastObservedAt: number;
    candidates: number;
  }> {
    const rows = this.db.prepare(`
      SELECT strategy, policy_version, MIN(observed_at) AS first_observed_at,
        MAX(observed_at) AS last_observed_at, COUNT(*) AS candidates
      FROM execution_research_candidates
      GROUP BY strategy, policy_version
      ORDER BY first_observed_at ASC
    `).all() as Array<{
      strategy: ExecutionResearchStrategy;
      policy_version: string;
      first_observed_at: number;
      last_observed_at: number;
      candidates: number;
    }>;
    return rows.map((row) => ({
      strategy: row.strategy,
      policyVersion: row.policy_version,
      firstObservedAt: row.first_observed_at,
      lastObservedAt: row.last_observed_at,
      candidates: row.candidates
    }));
  }

  getExecutionResearchScorecard(input: {
    strategy: ExecutionResearchStrategy;
    policyVersion: string;
    since: number;
    minResolved: number;
    minDistinctMarkets: number;
    minReturnPct: number;
    minWinRate: number;
  }): ExecutionResearchScorecard {
    const candidates = this.db.prepare(`
      SELECT candidate_json
      FROM execution_research_candidates
      WHERE strategy = ? AND policy_version = ? AND observed_at >= ?
      ORDER BY observed_at ASC
    `).all(input.strategy, input.policyVersion, input.since) as Array<{ candidate_json: string }>;
    const results = this.db.prepare(`
      SELECT result_json
      FROM execution_research_results
      WHERE strategy = ? AND policy_version = ? AND resolved_at >= ?
      ORDER BY resolved_at ASC
    `).all(input.strategy, input.policyVersion, input.since) as Array<{ result_json: string }>;
    const parsedCandidates = candidates.map((row) => JSON.parse(row.candidate_json) as ExecutionResearchCandidate);
    const prospectiveCandidateIds = new Set(parsedCandidates.map((candidate) => candidate.id));
    const parsedResults = results
      .map((row) => JSON.parse(row.result_json) as ExecutionResearchResult)
      .filter((result) => prospectiveCandidateIds.has(result.candidateId));
    // Every result with capital at risk is an economic outcome. In particular,
    // HEDGE_MISS is a realized one-leg exposure and must never disappear from P&L
    // or promotion statistics merely because the intended pair did not complete.
    const economicOutcomes = parsedResults.filter((result) => result.capitalUsd > 0);
    const completed = economicOutcomes.filter((result) => result.status === "COMPLETE");
    const hedgeMisses = economicOutcomes.filter((result) => result.status === "HEDGE_MISS");
    const pnlUsd = economicOutcomes.reduce((sum, result) => sum + result.pnlUsd, 0);
    const capitalUsd = economicOutcomes.reduce((sum, result) => sum + result.capitalUsd, 0);
    const wins = economicOutcomes.filter((result) => result.pnlUsd > 0).length;
    const losses = economicOutcomes.filter((result) => result.pnlUsd < 0).length;
    const economicCandidateIds = new Set(economicOutcomes.map((result) => result.candidateId));
    const economicCandidates = parsedCandidates.filter((candidate) => economicCandidateIds.has(candidate.id));
    const distinctEvents = new Set(economicCandidates.map((candidate) => candidate.eventKey)).size;
    const distinctMarkets = new Set(economicCandidates.flatMap((candidate) => candidate.marketIds)).size;
    const latencies = economicOutcomes.map((result) => result.latencyMs).sort((a, b) => a - b);
    const markouts = economicOutcomes.map((result) => result.adverseSelection5m).filter((value): value is number => value !== undefined);
    const returnPct = capitalUsd > 0 ? pnlUsd / capitalUsd : 0;
    const winRate = economicOutcomes.length > 0 ? wins / economicOutcomes.length : 0;
    const promotionEligible = economicOutcomes.length >= input.minResolved &&
      distinctMarkets >= input.minDistinctMarkets && returnPct >= input.minReturnPct && winRate >= input.minWinRate;
    const promotionReason = economicOutcomes.length < input.minResolved
      ? `needs ${input.minResolved} prospective economic outcomes; has ${economicOutcomes.length}`
      : distinctMarkets < input.minDistinctMarkets
        ? `needs ${input.minDistinctMarkets} distinct markets; has ${distinctMarkets}`
        : returnPct < input.minReturnPct
          ? `net return must be at least ${(input.minReturnPct * 100).toFixed(1)}%; has ${(returnPct * 100).toFixed(1)}%`
          : winRate < input.minWinRate
            ? `win rate must be at least ${(input.minWinRate * 100).toFixed(1)}%; has ${(winRate * 100).toFixed(1)}%`
            : "prospective execution sample, breadth, return, and win-rate gates passed";
    return {
      strategy: input.strategy,
      policyVersion: input.policyVersion,
      since: input.since,
      candidates: parsedCandidates.length,
      resolved: parsedResults.length,
      completed: completed.length,
      hedgeMisses: hedgeMisses.length,
      economicOutcomes: economicOutcomes.length,
      noFill: parsedResults.filter((result) => result.status === "NO_FILL" || result.status === "EXPIRED").length,
      pnlUsd: roundMoney(pnlUsd),
      capitalUsd: roundMoney(capitalUsd),
      returnPct,
      wins,
      losses,
      winRate,
      distinctEvents,
      distinctMarkets,
      medianLatencyMs: latencies.length > 0 ? latencies[Math.floor((latencies.length - 1) / 2)] : undefined,
      averageAdverseSelection5m: markouts.length > 0 ? markouts.reduce((sum, value) => sum + value, 0) / markouts.length : undefined,
      promotionEligible,
      promotionReason
    };
  }

  markWeatherOpportunitySelected(signalId: string): boolean {
    const row = this.db.prepare(`
      SELECT id, opportunity_json
      FROM weather_opportunities
      WHERE signal_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(signalId) as { id: string; opportunity_json: string } | undefined;
    if (!row) return false;
    const opportunity = JSON.parse(row.opportunity_json) as WeatherOpportunity;
    const eventKey = opportunity.strategyEventKey ?? `${opportunity.marketId}:${opportunity.tokenId}`;
    const alreadySelected = this.db.prepare(`
      SELECT 1
      FROM weather_opportunities
      WHERE status = 'SELECTED'
        AND json_extract(opportunity_json, '$.policyVersion') = ?
        AND COALESCE(
          json_extract(opportunity_json, '$.strategyEventKey'),
          json_extract(opportunity_json, '$.marketId') || ':' || json_extract(opportunity_json, '$.tokenId')
        ) = ?
      LIMIT 1
    `).get(opportunity.policyVersion ?? "", eventKey);
    if (alreadySelected) return false;
    opportunity.status = "SELECTED";
    const policyVersion = opportunity.policyVersion ?? "weather-unfrozen";
    this.insertForwardSelection({
      id: forwardSelectionId("weather_ensemble_fair_value_v2", policyVersion, eventKey),
      strategyId: "weather_ensemble_fair_value_v2",
      cluster: "WEATHER_FORECASTING",
      marketId: opportunity.marketId,
      tokenId: opportunity.tokenId,
      outcome: opportunity.outcome,
      policyVersion,
      strategyEventKey: eventKey,
      selectionStage: "PAPER_REVIEW",
      selectedAt: opportunity.createdAt,
      selection: opportunity
    });
    this.db.prepare(`
      UPDATE weather_opportunities
      SET status = 'SELECTED', opportunity_json = ?
      WHERE id = ?
    `).run(JSON.stringify(opportunity), row.id);
    return true;
  }

  getWeatherForwardScorecard(input: {
    since: number;
    policyVersion: string;
    positionSizeUsd: number;
    minResolvedTrades: number;
    minReturnPct: number;
  }): WeatherForwardScorecard {
    const rows = this.db.prepare(`
      SELECT selection_json
      FROM forward_selections
      WHERE strategy_id = 'weather_ensemble_fair_value_v2'
        AND selected_at >= ?
        AND policy_version = ?
      ORDER BY selected_at ASC
    `).all(input.since, input.policyVersion) as Array<{ selection_json: string }>;
    const observations = rows
      .map((row) => JSON.parse(row.selection_json) as WeatherOpportunity)
      .filter((opportunity) => opportunity.policyVersion === input.policyVersion);
    const unique = new Map<string, WeatherOpportunity>();
    for (const opportunity of observations) {
      const key = opportunity.strategyEventKey ?? `${opportunity.marketId}:${opportunity.tokenId}`;
      if (!unique.has(key)) unique.set(key, opportunity);
    }

    let wins = 0;
    let losses = 0;
    let settlementPnl = 0;
    let modelBrier = 0;
    let marketBrier = 0;
    for (const opportunity of unique.values()) {
      const market = this.getMarketById(opportunity.marketId);
      if (!market?.winningOutcome) continue;
      const won = normalizeOutcomeText(market.winningOutcome) === normalizeOutcomeText(String(opportunity.outcome));
      if (won) wins += 1;
      else losses += 1;
      const actual = won ? 1 : 0;
      modelBrier += (opportunity.fairProbability - actual) ** 2;
      marketBrier += (opportunity.marketProbability - actual) ** 2;
      const shares = input.positionSizeUsd / opportunity.marketProbability;
      const feeRate = market.feesEnabled === false ? 0 : market.takerFeeRate ?? 0;
      const entryFee = takerFeeUsd(shares, opportunity.marketProbability, feeRate);
      settlementPnl += (won ? shares : 0) - input.positionSizeUsd - entryFee;
    }

    const paperRows = this.db.prepare(`
      SELECT DISTINCT p.id, p.status, p.realized_pnl, p.avg_entry_price * p.size AS entry_cost
      FROM positions p
      JOIN paper_orders po
        ON po.market_id = p.market_id
       AND po.token_id = p.token_id
       AND COALESCE(po.profile, 'Shared') = COALESCE(p.profile, 'Shared')
       AND po.side = 'BUY'
       AND p.id = COALESCE(po.profile, 'Shared') || ':' || po.market_id || ':' || po.token_id || ':' || po.id
      JOIN signals s ON s.id = po.signal_id
      WHERE po.created_at >= ?
        AND s.model_json LIKE ?
    `).all(input.since, `%\"policyVersion\":\"${input.policyVersion.replaceAll('"', '')}\"%`) as Array<{
      id: string;
      status: Position["status"];
      realized_pnl: number;
      entry_cost: number;
    }>;
    const closedPaper = paperRows.filter((row) => row.status === "CLOSED");
    const paperPnl = closedPaper.reduce((sum, row) => sum + row.realized_pnl, 0);
    const paperCapital = closedPaper.reduce((sum, row) => sum + row.entry_cost, 0);
    const resolved = wins + losses;
    const settlementReturnPct = resolved > 0 ? settlementPnl / (resolved * input.positionSizeUsd) : 0;
    const paperReturnPct = paperCapital > 0 ? paperPnl / paperCapital : 0;
    const calibrated = resolved > 0 && modelBrier / resolved <= marketBrier / resolved;
    const researchPromotionEligible = resolved >= input.minResolvedTrades &&
      settlementReturnPct >= input.minReturnPct && calibrated;
    const researchPromotionReason = resolved < input.minResolvedTrades
      ? `needs ${input.minResolvedTrades} resolved immutable research selections; has ${resolved}`
      : settlementReturnPct < input.minReturnPct
        ? `research settlement return must be at least ${(input.minReturnPct * 100).toFixed(1)}%; has ${(settlementReturnPct * 100).toFixed(1)}%`
        : !calibrated
          ? "research model probability is less calibrated than the market"
          : "research sample, settlement profitability, and calibration gates passed";
    const walkForwardPassed = this.getLatestStrategyBacktests().some((item) =>
      item.cluster === "WEATHER_FORECASTING" && item.passed
    );
    const experimentalPaperEligible = walkForwardPassed && researchPromotionEligible;
    const standardPaperEligible = experimentalPaperEligible &&
      closedPaper.length >= input.minResolvedTrades && paperReturnPct >= input.minReturnPct;
    const promotionEligible = standardPaperEligible;
    const promotionReason = !walkForwardPassed
      ? "independent walk-forward validation has not passed"
      : !researchPromotionEligible
        ? researchPromotionReason
        : closedPaper.length < input.minResolvedTrades
          ? `experimental paper needs ${input.minResolvedTrades} closed positions; has ${closedPaper.length}`
          : paperReturnPct < input.minReturnPct
            ? `paper return must be at least ${(input.minReturnPct * 100).toFixed(1)}%; has ${(paperReturnPct * 100).toFixed(1)}%`
            : "walk-forward, clean research-forward, and paper gates passed";

    return {
      policyVersion: input.policyVersion,
      since: input.since,
      positionSizeUsd: input.positionSizeUsd,
      observations: unique.size,
      uniqueCandidates: unique.size,
      executedCandidates: paperRows.length,
      closedPaperPositions: closedPaper.length,
      resolved,
      unresolved: unique.size - resolved,
      wins,
      losses,
      winRate: resolved > 0 ? wins / resolved : 0,
      settlementPnl: roundMoney(settlementPnl),
      settlementReturnPct,
      paperPnl: roundMoney(paperPnl),
      paperReturnPct,
      modelBrierScore: resolved > 0 ? modelBrier / resolved : undefined,
      marketBrierScore: resolved > 0 ? marketBrier / resolved : undefined,
      researchPromotionEligible,
      researchPromotionReason,
      experimentalPaperEligible,
      standardPaperEligible,
      promotionEligible,
      promotionReason
    };
  }

  getExitEventMarks(positionId: string): Array<{ createdAt: number; bestBid?: number; bestAsk?: number; entryPrice?: number; size?: number; unrealizedPnl?: number }> {
    const rows = this.db.prepare(`
      SELECT created_at, best_bid, best_ask, entry_price, position_size, unrealized_pnl
      FROM exit_events WHERE position_id = ? ORDER BY created_at ASC
    `).all(positionId) as unknown as Array<{
      created_at: number; best_bid: number | null; best_ask: number | null;
      entry_price: number | null; position_size: number | null; unrealized_pnl: number | null;
    }>;
    return rows.map((row) => ({
      createdAt: row.created_at,
      bestBid: row.best_bid ?? undefined,
      bestAsk: row.best_ask ?? undefined,
      entryPrice: row.entry_price ?? undefined,
      size: row.position_size ?? undefined,
      unrealizedPnl: row.unrealized_pnl ?? undefined
    }));
  }

  getOpenExposure(): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(size * avg_entry_price), 0) as exposure FROM positions WHERE status = 'OPEN'").get() as { exposure: number };
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
    const cutoff = Math.max(start.getTime(), this.performanceStartAt);
    const row = this.db.prepare("SELECT COALESCE(SUM(realized_pnl), 0) as pnl FROM positions WHERE updated_at >= ? AND opened_at >= ?").get(cutoff, this.performanceStartAt) as { pnl: number };
    return Number(row.pnl ?? 0);
  }

  getTradesToday(now = Date.now()): number {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM paper_fills
      WHERE side = 'BUY' AND timestamp >= ?
    `).get(Math.max(start.getTime(), this.performanceStartAt)) as { count: number };
    return Number(row.count ?? 0);
  }

  getLossStreak(limit = 20): number {
    const rows = this.db.prepare(`
      SELECT realized_pnl
      FROM positions
      WHERE status = 'CLOSED' AND opened_at >= ?
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(this.performanceStartAt, limit) as Array<{ realized_pnl: number }>;
    let streak = 0;
    for (const row of rows) {
      if (Number(row.realized_pnl ?? 0) < 0) streak += 1;
      else break;
    }
    return streak;
  }

  private getLatestExecutableExitPriceByToken(tokens: string[]): Map<string, { executablePrice: number; hasBid: boolean; bestAsk?: number; bookTimestamp: number }> {
    const uniqueTokens = uniqueStrings(tokens.filter(Boolean));
    if (uniqueTokens.length === 0) return new Map();
    const placeholders = uniqueTokens.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT obs.token_id, obs.best_bid, obs.best_ask, obs.created_at
      FROM orderbook_snapshots obs
      JOIN (
        SELECT token_id, MAX(created_at) AS max_created_at
        FROM orderbook_snapshots
        WHERE token_id IN (${placeholders})
        GROUP BY token_id
      ) latest ON latest.token_id = obs.token_id AND latest.max_created_at = obs.created_at
    `).all(...uniqueTokens) as Array<{ token_id: string; best_bid: number | null; best_ask: number | null; created_at: number }>;
    return new Map(rows.map((row) => [
      row.token_id,
      {
        executablePrice: row.best_bid === null || row.best_bid === undefined ? 0 : Number(row.best_bid),
        hasBid: row.best_bid !== null && row.best_bid !== undefined,
        bestAsk: row.best_ask === null || row.best_ask === undefined ? undefined : Number(row.best_ask),
        bookTimestamp: Number(row.created_at ?? 0)
      }
    ]));
  }

  getOpenPositions(): Position[] {
    const rows = this.db.prepare("SELECT * FROM positions WHERE status = 'OPEN'").all() as unknown as DbPosition[];
    const positions = rows.map(rowToPosition);
    const marks = this.getLatestExecutableExitPriceByToken(positions.map((position) => position.tokenId));
    return positions.map((position) => {
      const mark = marks.get(position.tokenId);
      if (!mark) return position;
      return {
        ...position,
        currentPrice: mark.executablePrice
      };
    });
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

  getPaperPositionAttribution(marketId: string, tokenId: string, profile?: string): {
    sourceCount: number;
    confidence?: number;
    category?: string;
  } | undefined {
    const row = this.db.prepare(`
      SELECT
        s.aligned_wallets_json,
        s.confidence,
        m.question,
        m.raw_json
      FROM paper_orders po
      JOIN signals s ON s.id = po.signal_id
      LEFT JOIN markets m ON m.id = po.market_id OR m.condition_id = po.market_id
      WHERE po.market_id = ?
        AND po.token_id = ?
        AND COALESCE(po.profile, 'Shared') = COALESCE(?, 'Shared')
      ORDER BY po.created_at DESC
      LIMIT 1
    `).get(marketId, tokenId, profile ?? null) as {
      aligned_wallets_json: string;
      confidence: number;
      question: string | null;
      raw_json: string | null;
    } | undefined;
    if (!row) return undefined;
    let sourceCount = 0;
    try {
      const wallets = JSON.parse(row.aligned_wallets_json) as unknown;
      sourceCount = Array.isArray(wallets) ? wallets.length : 0;
    } catch {
      sourceCount = 0;
    }
    return {
      sourceCount,
      confidence: Number(row.confidence ?? 0),
      category: marketCategoryFromText(row.question, row.raw_json)
    };
  }

  getOpenPositionSourceWallets(): Array<{ position: Position; wallets: string[] }> {
    const positions = this.getOpenPositions();
    if (positions.length === 0) return [];
    return positions.map((position) => ({
      position,
      wallets: this.getPositionSeedWallets(position)
    }));
  }

  private getPositionSeedWallets(position: Position): string[] {
    const walletRows = this.db.prepare(`
      SELECT DISTINCT s.aligned_wallets_json
      FROM paper_orders po
      JOIN signals s ON s.id = po.signal_id
      WHERE po.market_id = ?
        AND po.token_id = ?
        AND COALESCE(po.profile, 'Shared') = COALESCE(?, 'Shared')
    `).all(position.marketId, position.tokenId, position.profile ?? null) as Array<{ aligned_wallets_json: string }>;

    const wallets = new Set<string>();
    for (const row of walletRows) {
      try {
        const parsed = JSON.parse(row.aligned_wallets_json) as unknown;
        if (Array.isArray(parsed)) for (const wallet of parsed) wallets.add(String(wallet).toLowerCase());
      } catch {
        // ignore malformed alignment payloads
      }
    }
    return [...wallets];
  }

  /**
   * Detects whether any source wallet that seeded this position has SOLD the
   * same outcome since the position opened. The shadow-copy backtest shows the
   * "source sold after detection" exit is the profitable one, so the Overseer
   * uses this to exit alongside the wallets it copied instead of on price noise.
   */
  getPositionSourceExit(position: Position, now = Date.now()): { sourceSold: boolean; sellerCount: number; sourceCount: number } {
    const walletList = this.getPositionSeedWallets(position);
    if (walletList.length === 0) return { sourceSold: false, sellerCount: 0, sourceCount: 0 };

    const placeholders = walletList.map(() => "?").join(",");
    const sellers = this.db.prepare(`
      SELECT DISTINCT wallet
      FROM wallet_trades
      WHERE wallet IN (${placeholders})
        AND side = 'SELL'
        AND timestamp >= ?
        AND (
          token_id = ?
          OR (market_id = ? AND LOWER(outcome) = LOWER(?))
        )
    `).all(...walletList, position.openedAt, position.tokenId, position.marketId, position.outcome) as Array<{ wallet: string }>;

    return { sourceSold: sellers.length > 0, sellerCount: sellers.length, sourceCount: walletList.length };
  }

  /**
   * True when this exact token was closed at a realized loss inside the cooldown
   * window. Prevents the re-entry churn where the bot repeatedly re-buys a market
   * it was just stopped out of on the same source signal.
   */
  isMarketInStopCooldown(marketId: string, tokenId: string, cooldownMs: number, now = Date.now()): boolean {
    if (!(cooldownMs > 0)) return false;
    const row = this.db.prepare(`
      SELECT MAX(updated_at) AS last_stop
      FROM positions
      WHERE market_id = ?
        AND token_id = ?
        AND status = 'CLOSED'
        AND realized_pnl < 0
    `).get(marketId, tokenId) as { last_stop: number | null } | undefined;
    const lastStop = row?.last_stop ?? null;
    if (!lastStop) return false;
    return now - lastStop < cooldownMs;
  }

  isMarketEntryInCooldown(marketId: string, tokenId: string, cooldownMs: number, now = Date.now()): boolean {
    if (!(cooldownMs > 0)) return false;
    const row = this.db.prepare(`
      SELECT MAX(created_at) AS last_entry
      FROM paper_orders
      WHERE market_id = ?
        AND token_id = ?
        AND side = 'BUY'
        AND status IN ('FILLED', 'PARTIAL')
    `).get(marketId, tokenId) as { last_entry: number | null } | undefined;
    const lastEntry = row?.last_entry ?? null;
    return lastEntry !== null && now - lastEntry < cooldownMs;
  }

  hasOpenPosition(marketId: string, tokenId: string, profile?: StrategyProfileName): boolean {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM positions
      WHERE market_id = ?
        AND token_id = ?
        AND COALESCE(profile, 'Shared') = COALESCE(?, 'Shared')
        AND status = 'OPEN'
    `).get(marketId, tokenId, profile ?? null) as { count: number };
    return Number(row.count ?? 0) > 0;
  }

  isSourceEntryInCooldown(signal: TradeSignal, profile: StrategyProfileName | undefined, cooldownMs: number, now = Date.now()): boolean {
    if (!(cooldownMs > 0) || signal.alignedWallets.length === 0) return false;
    const cutoff = now - cooldownMs;
    const aligned = new Set(signal.alignedWallets.map((wallet) => wallet.toLowerCase()));
    const rows = this.db.prepare(`
      SELECT s.aligned_wallets_json
      FROM paper_orders po
      JOIN signals s ON s.id = po.signal_id
      WHERE po.market_id = ?
        AND po.token_id = ?
        AND po.outcome = ?
        AND COALESCE(po.profile, 'Shared') = COALESCE(?, 'Shared')
        AND po.created_at >= ?
      ORDER BY po.created_at DESC
      LIMIT 50
    `).all(signal.marketId, signal.tokenId, signal.outcome, profile ?? null, cutoff) as Array<{ aligned_wallets_json: string }>;
    for (const row of rows) {
      try {
        const previousWallets = JSON.parse(row.aligned_wallets_json) as string[];
        if (previousWallets.some((wallet) => aligned.has(wallet.toLowerCase()))) return true;
      } catch {
        continue;
      }
    }
    return false;
  }

  getPerformanceReport(): PerformanceReport {
    const openRow = this.db.prepare(`
      WITH latest_books AS (
        SELECT obs.*
        FROM orderbook_snapshots obs
        JOIN (
          SELECT token_id, MAX(created_at) AS max_created_at
          FROM orderbook_snapshots
          GROUP BY token_id
        ) latest ON latest.token_id = obs.token_id AND latest.max_created_at = obs.created_at
      )
      SELECT
        COUNT(p.id) as count,
        COALESCE(SUM(p.avg_entry_price * p.size), 0) as open_cost,
        COALESCE(SUM(p.realized_pnl), 0) as open_realized_pnl,
        COALESCE(SUM(p.current_price * p.size), 0) as stored_open_value,
        COALESCE(SUM((p.current_price - p.avg_entry_price) * p.size), 0) as stored_unrealized_pnl,
        COALESCE(SUM(
          (CASE
            WHEN lb.token_id IS NULL THEN p.current_price
            WHEN lb.best_bid IS NULL THEN 0
            ELSE lb.best_bid
          END) * p.size
        ), 0) as executable_open_value,
        COALESCE(SUM(
          ((CASE
            WHEN lb.token_id IS NULL THEN p.current_price
            WHEN lb.best_bid IS NULL THEN 0
            ELSE lb.best_bid
          END) - p.avg_entry_price) * p.size
        ), 0) as executable_unrealized_pnl,
        SUM(CASE WHEN lb.token_id IS NOT NULL AND lb.best_bid IS NULL THEN 1 ELSE 0 END) as no_bid_open_positions
      FROM positions p
      LEFT JOIN latest_books lb ON lb.token_id = p.token_id
      WHERE p.status = 'OPEN' AND p.opened_at >= ?
    `).get(this.performanceStartAt) as {
      count: number;
      open_cost: number;
      open_realized_pnl: number;
      stored_open_value: number;
      stored_unrealized_pnl: number;
      executable_open_value: number;
      executable_unrealized_pnl: number;
      no_bid_open_positions: number | null;
    };
    const closedRow = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'CLOSED' THEN 1 ELSE 0 END) as count,
        COALESCE(SUM(CASE WHEN status = 'CLOSED' THEN realized_pnl ELSE 0 END), 0) as realized_pnl,
        SUM(CASE WHEN status = 'CLOSED' AND realized_pnl > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN status = 'CLOSED' AND realized_pnl < 0 THEN 1 ELSE 0 END) as losses
      FROM positions
      WHERE opened_at >= ?
    `).get(this.performanceStartAt) as { count: number; realized_pnl: number; wins: number | null; losses: number | null };
    const paperOrders = Number((this.db.prepare("SELECT COUNT(*) AS count FROM paper_orders WHERE created_at >= ?").get(this.performanceStartAt) as { count: number }).count ?? 0);
    const paperFills = Number((this.db.prepare("SELECT COUNT(*) AS count FROM paper_fills WHERE timestamp >= ?").get(this.performanceStartAt) as { count: number }).count ?? 0);
    const signals = Number((this.db.prepare("SELECT COUNT(*) AS count FROM signals WHERE created_at >= ?").get(this.performanceStartAt) as { count: number }).count ?? 0);
    const approvedSignals = paperOrders;
    const openCost = Number(openRow.open_cost ?? 0);
    const storedOpenValue = Number(openRow.stored_open_value ?? 0);
    const executableOpenValue = Number(openRow.executable_open_value ?? storedOpenValue);
    const realizedPnl = Number(closedRow.realized_pnl ?? 0) + Number(openRow.open_realized_pnl ?? 0);
    const storedUnrealizedPnl = Number(openRow.stored_unrealized_pnl ?? 0);
    const executableUnrealizedPnl = Number(openRow.executable_unrealized_pnl ?? storedUnrealizedPnl);
    const wins = Number(closedRow.wins ?? 0);
    const losses = Number(closedRow.losses ?? 0);
    return {
      performanceStartAt: this.performanceStartAt || undefined,
      openPositions: Number(openRow.count ?? 0),
      closedPositions: Number(closedRow.count ?? 0),
      openCost,
      openValue: executableOpenValue,
      storedOpenValue,
      executableOpenValue,
      realizedPnl,
      unrealizedPnl: executableUnrealizedPnl,
      storedUnrealizedPnl,
      executableUnrealizedPnl,
      totalPnl: realizedPnl + executableUnrealizedPnl,
      storedTotalPnl: realizedPnl + storedUnrealizedPnl,
      executableTotalPnl: realizedPnl + executableUnrealizedPnl,
      noBidOpenPositions: Number(openRow.no_bid_open_positions ?? 0),
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
      const positionRows = this.db.prepare("SELECT * FROM positions WHERE profile = ? AND opened_at >= ?").all(profile, this.performanceStartAt) as unknown as DbPosition[];
      const openRows = positionRows.filter((row) => row.status === "OPEN");
      const closedRows = positionRows.filter((row) => row.status === "CLOSED");
      const paperOrders = this.scalarCount("paper_orders", "profile = " + sqlString(profile) + ` AND created_at >= ${this.performanceStartAt}`);
      const approvedSignals = paperOrders;
      const rejectedSignals = this.scalarCount("risk_events", "profile = " + sqlString(profile) + ` AND decision NOT IN ('APPROVE', 'REDUCE_SIZE') AND created_at >= ${this.performanceStartAt}`);
      const openCost = openRows.reduce((sum, row) => sum + row.avg_entry_price * row.size, 0);
      const executableMarks = this.getLatestExecutableExitPriceByToken(openRows.map((row) => row.token_id));
      const storedOpenValue = openRows.reduce((sum, row) => sum + row.current_price * row.size, 0);
      const openValue = openRows.reduce((sum, row) => {
        const mark = executableMarks.get(row.token_id);
        const price = mark ? mark.executablePrice : row.current_price;
        return sum + price * row.size;
      }, 0);
      const realizedPnl = positionRows.reduce((sum, row) => sum + row.realized_pnl, 0);
      const storedUnrealizedPnl = openRows.reduce((sum, row) => sum + (row.current_price - row.avg_entry_price) * row.size, 0);
      const unrealizedPnl = openRows.reduce((sum, row) => {
        const mark = executableMarks.get(row.token_id);
        const price = mark ? mark.executablePrice : row.current_price;
        return sum + (price - row.avg_entry_price) * row.size;
      }, 0);
      const noBidOpenPositions = openRows.filter((row) => executableMarks.get(row.token_id)?.hasBid === false).length;
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
        storedOpenValue,
        executableOpenValue: openValue,
        realizedPnl,
        unrealizedPnl,
        storedUnrealizedPnl,
        executableUnrealizedPnl: unrealizedPnl,
        totalPnl: realizedPnl + unrealizedPnl,
        storedTotalPnl: realizedPnl + storedUnrealizedPnl,
        executableTotalPnl: realizedPnl + unrealizedPnl,
        noBidOpenPositions,
        winRate: wins + losses > 0 ? wins / (wins + losses) : 0,
        wins,
        losses,
        paperOrders,
        approvedSignals,
        rejectedSignals,
        openExposure: openCost,
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
      WHERE status IN ('OPEN', 'PARTIAL') AND expires_at < ?
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
        COALESCE(tpm.aligned_wallets_json, s.aligned_wallets_json) AS aligned_wallets_json,
        COALESCE(s.confidence, 100) AS confidence,
        po.profile,
        po.market_id,
        po.token_id,
        COALESCE(tpm.actual_entry, pf.price) AS price,
        pf.size,
        pf.timestamp,
        COALESCE(tpm.actual_exit, p.current_price) AS current_price,
        COALESCE(
          po.fee_rate,
          CASE WHEN COALESCE(json_extract(m.raw_json, '$.feesEnabled'), 0) = 1
            THEN json_extract(m.raw_json, '$.feeSchedule.rate')
            ELSE 0 END,
          0
        ) AS fee_rate,
        CASE WHEN tpm.actual_exit IS NOT NULL THEN 'CLOSED' ELSE COALESCE(p.status, 'OPEN') END AS status
      FROM trade_parity_metrics tpm
      JOIN paper_orders po ON po.id = tpm.order_id AND po.side = 'BUY'
      JOIN paper_fills pf ON pf.order_id = po.id AND pf.side = 'BUY'
      LEFT JOIN signals s ON s.id = tpm.signal_id
      LEFT JOIN positions p ON p.id = tpm.position_id
      LEFT JOIN markets m ON m.id = tpm.market_id
      WHERE tpm.actual_entry IS NOT NULL
        AND COALESCE(tpm.aligned_wallets_json, s.aligned_wallets_json) IS NOT NULL
    `).all() as Array<{
      aligned_wallets_json: string;
      confidence: number;
      profile: string | null;
      market_id: string;
      token_id: string;
      price: number;
      size: number;
      timestamp: number;
      current_price: number | null;
      fee_rate: number;
      status: Position["status"] | null;
    }>;

    const buckets = new Map<string, { filledOrders: number; pnl: number; weightedReturnSum: number; weightSum: number }>();
    for (const row of rows) {
      const alignedWallets = JSON.parse(row.aligned_wallets_json) as string[];
      if (alignedWallets.length === 0 || row.current_price === null) continue;
      const entryFee = takerFeeUsd(row.size, row.price, row.fee_rate);
      const exitFee = takerFeeUsd(row.size, row.current_price, row.fee_rate);
      const pnl = (row.current_price - row.price) * row.size - entryFee - exitFee;
      const cost = row.price * row.size + entryFee;
      const returnPct = cost > 0 ? pnl / cost : 0;
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
        WHERE pf.side = 'BUY' AND pf.timestamp >= ?
        ORDER BY pf.timestamp DESC
        LIMIT ?
      )
      ORDER BY created_at ASC
    `).all(this.performanceStartAt, limit) as Array<{
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
        WHERE status = 'CLOSED' AND opened_at >= ?
        ORDER BY updated_at DESC
        LIMIT ?
      )
      ORDER BY updated_at ASC
    `).all(this.performanceStartAt, limit) as unknown as DbPosition[];
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
      SELECT
        wt.*,
        COALESCE(
          (SELECT question FROM markets WHERE id = wt.market_id LIMIT 1),
          (SELECT question FROM markets WHERE condition_id = wt.market_id ORDER BY updated_at DESC LIMIT 1)
        ) AS question,
        COALESCE(
          (SELECT raw_json FROM markets WHERE id = wt.market_id LIMIT 1),
          (SELECT raw_json FROM markets WHERE condition_id = wt.market_id ORDER BY updated_at DESC LIMIT 1)
        ) AS raw_json
      FROM (
        SELECT *
        FROM wallet_trades
        ORDER BY timestamp DESC
        LIMIT ?
      ) wt
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

  getRecentTradeParityMetrics(limit: number): TradeParityMetric[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM trade_parity_metrics
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(limit) as unknown as DbTradeParityMetric[];
    return rows.map(rowToTradeParityMetric);
  }

  getParityScorecard(lookbackHours = 24): ParityScorecard {
    const since = Math.max(Date.now() - lookbackHours * 3_600_000, this.performanceStartAt);
    const orderRow = this.db.prepare(`
      SELECT
        COUNT(*) AS orders,
        SUM(CASE WHEN status = 'FILLED' THEN 1 ELSE 0 END) AS filled_orders,
        SUM(CASE WHEN side = 'BUY' AND status = 'FILLED' THEN 1 ELSE 0 END) AS buy_fills,
        SUM(CASE WHEN side = 'SELL' AND status = 'FILLED' THEN 1 ELSE 0 END) AS sell_fills,
        SUM(CASE WHEN status = 'EXPIRED' THEN 1 ELSE 0 END) AS expired_orders,
        SUM(CASE WHEN status = 'PARTIAL' THEN 1 ELSE 0 END) AS partial_orders,
        SUM(CASE WHEN execution_policy = 'FOK' AND status = 'EXPIRED' AND COALESCE(missed_reason, '') <> '' THEN 1 ELSE 0 END) AS fok_misses,
        SUM(CASE WHEN execution_policy = 'FAK' AND status = 'PARTIAL' THEN 1 ELSE 0 END) AS fak_partial_fills
      FROM paper_orders
      WHERE created_at >= ?
    `).get(since) as {
      orders: number;
      filled_orders: number | null;
      buy_fills: number | null;
      sell_fills: number | null;
      expired_orders: number | null;
      partial_orders: number | null;
      fok_misses: number | null;
      fak_partial_fills: number | null;
    };
    const fillRow = this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN pf.side = 'BUY' THEN pf.price * pf.size ELSE 0 END), 0) AS buy_notional,
        COALESCE(SUM(CASE WHEN pf.side = 'SELL' THEN pf.price * pf.size ELSE 0 END), 0) AS sell_notional
      FROM paper_fills pf
      WHERE pf.timestamp >= ?
    `).get(since) as { buy_notional: number; sell_notional: number };
    const realizedRow = this.db.prepare(`
      SELECT COALESCE(SUM(realized_pnl), 0) AS realized_pnl
      FROM positions
      WHERE updated_at >= ?
    `).get(since) as { realized_pnl: number };
    const exitRow = this.db.prepare(`
      SELECT
        SUM(CASE WHEN reason LIKE '%source wallet%exiting%' OR reason LIKE '%source wallets exiting%' THEN 1 ELSE 0 END) AS source_sell_exits,
        SUM(CASE WHEN reason LIKE '%take profit%' THEN 1 ELSE 0 END) AS take_profit_attempts
      FROM exit_events
      WHERE created_at >= ?
    `).get(since) as { source_sell_exits: number | null; take_profit_attempts: number | null };
    const eventRow = this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN type = 'source_exit.watchdog' THEN json_extract(payload_json, '$.checkedPositions') ELSE 0 END), 0) AS source_exit_checks,
        COALESCE(SUM(CASE WHEN type = 'source_exit.watchdog' THEN json_extract(payload_json, '$.sourceSoldPositions') ELSE 0 END), 0) AS source_sell_detections,
        SUM(CASE WHEN type = 'mirror_exit.missed' THEN 1 ELSE 0 END) AS source_sell_misses,
        SUM(CASE WHEN type = 'trade.exit_missed' THEN 1 ELSE 0 END) AS exit_misses,
        SUM(CASE WHEN type = 'trade.closed' AND json_extract(payload_json, '$.reason') LIKE '%take profit%' THEN 1 ELSE 0 END) AS take_profit_fills,
        MAX(created_at) AS latest_at
      FROM agent_events
      WHERE created_at >= ?
    `).get(since) as {
      source_exit_checks: number;
      source_sell_detections: number;
      source_sell_misses: number | null;
      exit_misses: number | null;
      take_profit_fills: number | null;
      latest_at: number | null;
    };
    const parityRow = this.db.prepare(`
      SELECT
        COUNT(*) AS parity_rows,
        SUM(CASE WHEN COALESCE(missed_reason, '') <> '' THEN 1 ELSE 0 END) AS missed_rows,
        COALESCE(AVG(entry_slippage), 0) AS avg_entry_slippage,
        COALESCE(MAX(entry_slippage), 0) AS max_entry_slippage,
        COALESCE(AVG(exit_slippage), 0) AS avg_exit_slippage,
        COALESCE(MAX(exit_slippage), 0) AS max_exit_slippage,
        COALESCE(AVG(entry_depth_multiple), 0) AS avg_entry_depth_multiple
      FROM trade_parity_metrics
      WHERE created_at >= ?
    `).get(since) as {
      parity_rows: number;
      missed_rows: number | null;
      avg_entry_slippage: number;
      max_entry_slippage: number;
      avg_exit_slippage: number;
      max_exit_slippage: number;
      avg_entry_depth_multiple: number;
    };
    const performance = this.getPerformanceReport();
    return {
      lookbackHours,
      orders: Number(orderRow.orders ?? 0),
      filledOrders: Number(orderRow.filled_orders ?? 0),
      buyFills: Number(orderRow.buy_fills ?? 0),
      sellFills: Number(orderRow.sell_fills ?? 0),
      expiredOrders: Number(orderRow.expired_orders ?? 0),
      partialOrders: Number(orderRow.partial_orders ?? 0),
      fokMisses: Number(orderRow.fok_misses ?? 0),
      fakPartialFills: Number(orderRow.fak_partial_fills ?? 0),
      buyNotional: Number(fillRow.buy_notional ?? 0),
      sellNotional: Number(fillRow.sell_notional ?? 0),
      realizedPnl: Number(realizedRow.realized_pnl ?? 0),
      storedTotalPnl: performance.storedTotalPnl ?? performance.totalPnl,
      executableTotalPnl: performance.executableTotalPnl ?? performance.totalPnl,
      storedUnrealizedPnl: performance.storedUnrealizedPnl ?? performance.unrealizedPnl,
      executableUnrealizedPnl: performance.executableUnrealizedPnl ?? performance.unrealizedPnl,
      noBidOpenPositions: performance.noBidOpenPositions ?? 0,
      sourceExitChecks: Number(eventRow.source_exit_checks ?? 0),
      sourceSellDetections: Number(eventRow.source_sell_detections ?? 0),
      sourceSellExits: Number(exitRow.source_sell_exits ?? 0),
      sourceSellMisses: Number(eventRow.source_sell_misses ?? 0),
      takeProfitExitAttempts: Number(exitRow.take_profit_attempts ?? 0),
      takeProfitExitFills: Number(eventRow.take_profit_fills ?? 0),
      exitMisses: Number(eventRow.exit_misses ?? 0),
      parityRows: Number(parityRow.parity_rows ?? 0),
      missedParityRows: Number(parityRow.missed_rows ?? 0),
      avgEntrySlippage: Number(parityRow.avg_entry_slippage ?? 0),
      maxEntrySlippage: Number(parityRow.max_entry_slippage ?? 0),
      avgExitSlippage: Number(parityRow.avg_exit_slippage ?? 0),
      maxExitSlippage: Number(parityRow.max_exit_slippage ?? 0),
      avgEntryDepthMultiple: Number(parityRow.avg_entry_depth_multiple ?? 0),
      latestAt: Number(eventRow.latest_at ?? Date.now())
    };
  }

  getLiveReadinessReport(config: BotConfig, lookbackHours = 24): LiveReadinessReport {
    const since = Math.max(Date.now() - lookbackHours * 3_600_000, this.performanceStartAt);
    const parity = this.getParityScorecard(lookbackHours);
    const performance = this.getPerformanceReport();
    const orderRow = this.db.prepare(`
      SELECT
        SUM(CASE WHEN side = 'BUY' AND execution_policy = 'FOK' THEN 1 ELSE 0 END) AS fok_entry_orders,
        SUM(CASE WHEN side = 'BUY' AND execution_policy = 'FOK' AND status = 'FILLED' THEN 1 ELSE 0 END) AS fok_entry_fills,
        SUM(CASE WHEN side = 'BUY' AND execution_policy = 'FOK' AND status = 'EXPIRED' THEN 1 ELSE 0 END) AS fok_entry_misses,
        SUM(CASE WHEN side = 'SELL' THEN 1 ELSE 0 END) AS exit_orders,
        SUM(CASE WHEN side = 'SELL' AND status IN ('FILLED', 'PARTIAL') THEN 1 ELSE 0 END) AS exit_fills,
        SUM(CASE WHEN side = 'SELL' AND status = 'EXPIRED' THEN 1 ELSE 0 END) AS exit_misses
      FROM paper_orders
      WHERE created_at >= ?
    `).get(since) as {
      fok_entry_orders: number | null;
      fok_entry_fills: number | null;
      fok_entry_misses: number | null;
      exit_orders: number | null;
      exit_fills: number | null;
      exit_misses: number | null;
    };
    const closedRow = this.db.prepare(`
      SELECT
        COUNT(*) AS closed_positions,
        SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN realized_pnl <= 0 THEN 1 ELSE 0 END) AS losses
      FROM positions
      WHERE status = 'CLOSED'
        AND updated_at >= ?
    `).get(since) as {
      closed_positions: number;
      wins: number | null;
      losses: number | null;
    };
    const sourceSellRow = this.db.prepare(`
      SELECT COUNT(DISTINCT position_id) AS source_sell_exits
      FROM exit_events
      WHERE decision = 'FULL_EXIT'
        AND created_at >= ?
        AND (reason LIKE '%source wallet%exiting%' OR reason LIKE '%source wallets exiting%')
    `).get(since) as { source_sell_exits: number | null };
    const takeProfitRow = this.db.prepare(`
      SELECT COUNT(DISTINCT position_id) AS take_profit_attempts
      FROM exit_events
      WHERE decision = 'FULL_EXIT'
        AND created_at >= ?
        AND reason LIKE '%take profit%'
    `).get(since) as { take_profit_attempts: number | null };
    const watchRow = this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN type = 'source_exit.watchdog' THEN json_extract(payload_json, '$.checkedPositions') ELSE 0 END), 0) AS checked_positions,
        COALESCE(SUM(CASE WHEN type = 'source_exit.watchdog' THEN json_extract(payload_json, '$.noBidPositions') ELSE 0 END), 0) AS no_bid_positions
      FROM agent_events
      WHERE created_at >= ?
    `).get(since) as {
      checked_positions: number;
      no_bid_positions: number;
    };
    const exitReasonRow = this.db.prepare(`
      SELECT
        SUM(CASE WHEN type IN ('trade.closed', 'trade.exit_partial') AND json_extract(payload_json, '$.reason') LIKE '%take profit%' THEN 1 ELSE 0 END) AS take_profit_fills,
        SUM(CASE WHEN type = 'trade.exit_missed' AND json_extract(payload_json, '$.reason') LIKE '%take profit%' THEN 1 ELSE 0 END) AS take_profit_misses,
        SUM(CASE
          WHEN type IN ('trade.closed', 'trade.exit_partial')
           AND (
            json_extract(payload_json, '$.reason') LIKE '%source wallet%exiting%' OR
            json_extract(payload_json, '$.reason') LIKE '%source wallets exiting%' OR
            json_extract(payload_json, '$.reason') LIKE '%stop loss%' OR
            json_extract(payload_json, '$.reason') LIKE '%no executable bid%' OR
            json_extract(payload_json, '$.reason') LIKE '%price reversal%' OR
            json_extract(payload_json, '$.reason') LIKE '%spread widened%' OR
            json_extract(payload_json, '$.reason') LIKE '%max hold%' OR
            json_extract(payload_json, '$.reason') LIKE '%no fresh order book%' OR
            json_extract(payload_json, '$.reason') LIKE '%market no longer%'
           )
          THEN 1 ELSE 0 END) AS urgent_exit_fills,
        SUM(CASE
          WHEN type = 'trade.exit_missed'
           AND (
            json_extract(payload_json, '$.reason') LIKE '%source wallet%exiting%' OR
            json_extract(payload_json, '$.reason') LIKE '%source wallets exiting%' OR
            json_extract(payload_json, '$.reason') LIKE '%stop loss%' OR
            json_extract(payload_json, '$.reason') LIKE '%no executable bid%' OR
            json_extract(payload_json, '$.reason') LIKE '%price reversal%' OR
            json_extract(payload_json, '$.reason') LIKE '%spread widened%' OR
            json_extract(payload_json, '$.reason') LIKE '%max hold%' OR
            json_extract(payload_json, '$.reason') LIKE '%no fresh order book%' OR
            json_extract(payload_json, '$.reason') LIKE '%market no longer%'
           )
          THEN 1 ELSE 0 END) AS urgent_exit_misses
      FROM agent_events
      WHERE created_at >= ?
    `).get(since) as {
      take_profit_fills: number | null;
      take_profit_misses: number | null;
      urgent_exit_fills: number | null;
      urgent_exit_misses: number | null;
    };

    const fokEntryOrders = Number(orderRow.fok_entry_orders ?? 0);
    const fokEntryFills = Number(orderRow.fok_entry_fills ?? 0);
    const fokEntryMisses = Number(orderRow.fok_entry_misses ?? 0);
    const exitOrders = Number(orderRow.exit_orders ?? 0);
    const exitFills = Number(orderRow.exit_fills ?? 0);
    const exitMisses = Number(orderRow.exit_misses ?? 0);
    const closedPositions = Number(closedRow.closed_positions ?? 0);
    const wins = Number(closedRow.wins ?? 0);
    const losses = Number(closedRow.losses ?? 0);
    const sourceSellDetections = parity.sourceSellDetections;
    const sourceSellExits = Number(sourceSellRow.source_sell_exits ?? 0);
    const takeProfitExitAttempts = Number(takeProfitRow.take_profit_attempts ?? 0);
    const takeProfitExitFills = Number(exitReasonRow.take_profit_fills ?? parity.takeProfitExitFills);
    const takeProfitExitMisses = Number(exitReasonRow.take_profit_misses ?? 0);
    const urgentExitFills = Number(exitReasonRow.urgent_exit_fills ?? 0);
    const urgentExitMisses = Number(exitReasonRow.urgent_exit_misses ?? 0);
    const checkedPositions = Number(watchRow.checked_positions ?? 0);
    const noBidWatchPositions = Number(watchRow.no_bid_positions ?? 0);

    const metrics: LiveReadinessReport["metrics"] = {
      executableTotalPnl: parity.executableTotalPnl,
      storedTotalPnl: parity.storedTotalPnl,
      realizedPnl: parity.realizedPnl,
      executableUnrealizedPnl: parity.executableUnrealizedPnl,
      openPositions: performance.openPositions,
      openExposure: performance.openCost,
      noBidOpenPositions: parity.noBidOpenPositions,
      noBidOpenPositionRate: performance.openPositions > 0 ? parity.noBidOpenPositions / performance.openPositions : 0,
      closedPositions,
      wins,
      losses,
      winRate: wins + losses > 0 ? wins / (wins + losses) : 0,
      filledOrders: parity.filledOrders,
      buyFills: parity.buyFills,
      sellFills: parity.sellFills,
      fokEntryOrders,
      fokEntryFills,
      fokEntryMisses,
      fokEntryMissRate: fokEntryOrders > 0 ? fokEntryMisses / fokEntryOrders : 0,
      exitOrders,
      exitFills,
      exitMisses,
      exitMissRate: exitOrders > 0 ? exitMisses / exitOrders : 0,
      sourceSellDetections,
      sourceSellExits,
      sourceSellSuccessRate: sourceSellDetections > 0 ? Math.min(1, sourceSellExits / sourceSellDetections) : undefined,
      takeProfitExitAttempts,
      takeProfitExitFills,
      takeProfitExitMisses,
      takeProfitFillRate: takeProfitExitFills + takeProfitExitMisses > 0 ? takeProfitExitFills / (takeProfitExitFills + takeProfitExitMisses) : undefined,
      urgentExitFills,
      urgentExitMisses,
      urgentExitFillRate: urgentExitFills + urgentExitMisses > 0 ? urgentExitFills / (urgentExitFills + urgentExitMisses) : undefined,
      noBidWatchRate: checkedPositions > 0 ? noBidWatchPositions / checkedPositions : 0,
      avgEntrySlippage: parity.avgEntrySlippage,
      maxEntrySlippage: parity.maxEntrySlippage,
      avgExitSlippage: parity.avgExitSlippage,
      maxExitSlippage: parity.maxExitSlippage,
      avgEntryDepthMultiple: parity.avgEntryDepthMultiple
    };

    const blockers: string[] = [];
    const warnings: string[] = [];
    let score = 100;
    const minBuySample = Math.max(10, config.minLiveExecutableShadowTradesForTrading ?? 8);
    const minWinRate = config.minLiveExecutableShadowWinRateForTrading ?? 0.45;
    const maxEntryMissRate = 0.35;
    const maxExitMissRate = 0.35;
    const minSourceSellSuccessRate = config.minSourceSellRealizedRatio ?? 0.35;
    const maxEntrySlippage = config.maxEntrySlippage ?? 0.03;
    const maxExitSlippage = config.maxExitSlippage ?? maxEntrySlippage;

    if (metrics.buyFills < minBuySample) {
      blockers.push(`need at least ${minBuySample} filled FOK entries in ${lookbackHours}h; only ${metrics.buyFills}`);
      score -= 20;
    }
    if (metrics.executableTotalPnl <= 0) {
      blockers.push(`executable total PnL is not positive ($${metrics.executableTotalPnl.toFixed(2)})`);
      score -= 30;
    }
    if (metrics.noBidOpenPositions > 0) {
      blockers.push(`${metrics.noBidOpenPositions} open position(s) currently have no executable bid`);
      score -= 25;
    }
    if (metrics.fokEntryMissRate > maxEntryMissRate) {
      blockers.push(`FOK entry miss rate ${(metrics.fokEntryMissRate * 100).toFixed(0)}% exceeds ${(maxEntryMissRate * 100).toFixed(0)}%`);
      score -= 15;
    }
    if (metrics.exitMissRate > maxExitMissRate) {
      blockers.push(`exit miss rate ${(metrics.exitMissRate * 100).toFixed(0)}% exceeds ${(maxExitMissRate * 100).toFixed(0)}%`);
      score -= 20;
    }
    if (metrics.closedPositions >= 5 && metrics.winRate < minWinRate) {
      blockers.push(`closed-position win rate ${(metrics.winRate * 100).toFixed(0)}% is below ${(minWinRate * 100).toFixed(0)}%`);
      score -= 15;
    }
    if (metrics.sourceSellSuccessRate !== undefined && metrics.sourceSellSuccessRate < minSourceSellSuccessRate) {
      blockers.push(`source-sell success rate ${(metrics.sourceSellSuccessRate * 100).toFixed(0)}% is below ${(minSourceSellSuccessRate * 100).toFixed(0)}%`);
      score -= 15;
    }

    if (metrics.sourceSellSuccessRate === undefined) {
      warnings.push("no source-sell detection sample in this window");
      score -= 5;
    }
    if (metrics.takeProfitFillRate !== undefined && metrics.takeProfitFillRate < 0.75) {
      warnings.push(`take-profit fill rate ${(metrics.takeProfitFillRate * 100).toFixed(0)}% is below 75%`);
      score -= 8;
    }
    if (metrics.noBidWatchRate > 0.05) {
      warnings.push(`watchdog saw no-bid state in ${(metrics.noBidWatchRate * 100).toFixed(1)}% of checks`);
      score -= 8;
    }
    if (metrics.avgEntryDepthMultiple > 0 && metrics.avgEntryDepthMultiple < (config.entryBookDepthMultiple ?? 3)) {
      warnings.push(`average entry depth ${metrics.avgEntryDepthMultiple.toFixed(2)}x is below target ${(config.entryBookDepthMultiple ?? 3).toFixed(2)}x`);
      score -= 8;
    }
    if (metrics.maxEntrySlippage > maxEntrySlippage) {
      warnings.push(`max entry slippage ${(metrics.maxEntrySlippage * 100).toFixed(1)}c exceeds ${(maxEntrySlippage * 100).toFixed(1)}c`);
      score -= 8;
    }
    if (metrics.maxExitSlippage > maxExitSlippage) {
      warnings.push(`max exit slippage ${(metrics.maxExitSlippage * 100).toFixed(1)}c exceeds ${(maxExitSlippage * 100).toFixed(1)}c`);
      score -= 8;
    }

    score = Math.max(0, Math.min(100, Math.round(score)));
    const status: LiveReadinessReport["status"] = blockers.length > 0 ? "NOT_READY" : score >= 80 && warnings.length === 0 ? "READY" : "WATCH";
    return {
      lookbackHours,
      status,
      score,
      blockers,
      warnings,
      metrics
    };
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

  getLatestWalletScoreAt(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(updated_at), 0) AS updated_at FROM wallet_scores").get() as { updated_at: number };
    return Number(row.updated_at ?? 0);
  }

  getWalletScoresUpdatedSince(since: number, limit: number): WalletScore[] {
    const rows = this.db.prepare(`
      SELECT * FROM wallet_scores
      WHERE updated_at >= ?
      ORDER BY score DESC, copyability_score DESC, updated_at DESC
      LIMIT ?
    `).all(Math.max(0, since), Math.max(1, limit)) as unknown as DbWalletScore[];
    return rows.map(rowToWalletScore);
  }

  getTopLiveExecutableWalletScores(input: {
    limit: number;
    minWalletScore: number;
    minTrades: number;
    minPnl: number;
    minReturnPct: number;
    minSourceSellRatio: number;
    minWinRate?: number;
  }): WalletScore[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM wallet_scores
      WHERE score >= ?
        AND COALESCE(live_executable_shadow_simulated, 0) >= ?
        AND COALESCE(live_executable_shadow_pnl, 0) > ?
        AND COALESCE(live_executable_shadow_avg_return_pct, 0) > ?
        AND COALESCE(source_sell_realized_ratio, 0) >= ?
        AND COALESCE(live_executable_shadow_win_rate, 0) >= ?
      ORDER BY live_executable_shadow_pnl DESC,
               live_executable_shadow_avg_return_pct DESC,
               score DESC,
               updated_at DESC
      LIMIT ?
    `).all(
      input.minWalletScore,
      input.minTrades,
      input.minPnl,
      input.minReturnPct,
      input.minSourceSellRatio,
      input.minWinRate ?? 0,
      input.limit
    ) as unknown as DbWalletScore[];
    return rows.map(rowToWalletScore);
  }

  getTopDurableLiveExecutableWalletScores(input: {
    limit: number;
    minWalletScore: number;
    minTrades: number;
    minPnl: number;
    minReturnPct: number;
    minSourceSellRatio: number;
    minWinRate?: number;
    sourceTimestampSince?: number;
    excludedCategories?: MarketCategory[];
    includedCategories?: MarketCategory[];
    enforceCategoryAllowlist?: boolean;
    policyVersion?: string;
  }): WalletScore[] {
    const excludedCategories = (input.excludedCategories ?? []).filter(Boolean);
    const includedCategories = (input.includedCategories ?? []).filter(Boolean);
    const categoryExclusion = excludedCategories.length > 0
      ? `AND COALESCE(st.category, 'other') NOT IN (${excludedCategories.map(() => "?").join(", ")})`
      : "";
    const categoryInclusion = input.enforceCategoryAllowlist === true && includedCategories.length === 0
      ? "AND 1 = 0"
      : includedCategories.length > 0
        ? `AND COALESCE(st.category, 'other') IN (${includedCategories.map(() => "?").join(", ")})`
        : "";
    const rows = this.db.prepare(`
      SELECT *
      FROM (
        SELECT
          st.wallet,
          COALESCE(ws.label, 'durable-live-exec-shadow') AS label,
          COALESCE(ws.score, ?) AS score,
          COALESCE(ws.copyability_score, ws.score, ?) AS copyability_score,
          ws.hot_score,
          ws.category_consistency_score,
          ws.sample_confidence,
          ws.dominant_category,
          ws.resolved_markets,
          ws.resolved_wins,
          ws.resolved_losses,
          ws.resolved_win_rate,
          COUNT(*) AS shadow_trade_count,
          SUM(CASE WHEN st.status = 'SIMULATED' THEN 1 ELSE 0 END) AS shadow_simulated,
          SUM(CASE WHEN st.status = 'SIMULATED' AND st.exit_reason IN ('source sell after detection', 'resolved market outcome') THEN 1 ELSE 0 END) AS shadow_realized,
          COALESCE(SUM(CASE WHEN st.status = 'SIMULATED' THEN st.pnl ELSE 0 END), 0) AS shadow_pnl,
          COALESCE(AVG(CASE WHEN st.status = 'SIMULATED' THEN st.return_pct END), 0) AS shadow_avg_return_pct,
          SUM(CASE WHEN st.status = 'SIMULATED' AND st.pnl > 0 THEN 1 ELSE 0 END) AS shadow_wins,
          SUM(CASE WHEN st.status = 'SIMULATED' AND st.pnl < 0 THEN 1 ELSE 0 END) AS shadow_losses,
          SUM(CASE WHEN st.status = 'SIMULATED' AND st.exit_reason = 'source sell after detection' THEN 1 ELSE 0 END) AS source_sell_shadow_realized,
          1.0 * SUM(CASE WHEN st.status = 'SIMULATED' AND st.exit_reason = 'source sell after detection' THEN 1 ELSE 0 END)
            / NULLIF(SUM(CASE WHEN st.status = 'SIMULATED' THEN 1 ELSE 0 END), 0) AS source_sell_realized_ratio,
          SUM(CASE WHEN st.live_executable_status = 'EXECUTABLE' THEN 1 ELSE 0 END) AS live_executable_shadow_simulated,
          COALESCE(SUM(CASE WHEN st.live_executable_status = 'EXECUTABLE' THEN st.live_executable_pnl ELSE 0 END), 0) AS live_executable_shadow_pnl,
          COALESCE(AVG(CASE WHEN st.live_executable_status = 'EXECUTABLE' THEN st.live_executable_return_pct END), 0) AS live_executable_shadow_avg_return_pct,
          SUM(CASE WHEN st.live_executable_status = 'EXECUTABLE' AND st.live_executable_pnl > 0 THEN 1 ELSE 0 END) AS live_wins,
          SUM(CASE WHEN st.live_executable_status = 'EXECUTABLE' AND st.live_executable_pnl < 0 THEN 1 ELSE 0 END) AS live_losses,
          1.0 * SUM(CASE WHEN st.live_executable_status = 'EXECUTABLE' AND st.live_executable_pnl > 0 THEN 1 ELSE 0 END)
            / NULLIF(SUM(CASE WHEN st.live_executable_status = 'EXECUTABLE' AND st.live_executable_pnl <> 0 THEN 1 ELSE 0 END), 0) AS live_executable_shadow_win_rate,
          COALESCE(ws.trade_count, COUNT(*)) AS trade_count,
          COALESCE(ws.recent_trade_count, 0) AS recent_trade_count,
          COALESCE(ws.reliability, 'HIGH') AS reliability,
          COALESCE(ws.flags_json, '["SHADOW_PROVEN_COPYABLE","DURABLE_LIVE_EXECUTABLE_SHADOW"]') AS flags_json,
          MAX(COALESCE(ws.updated_at, st.created_at)) AS updated_at
        FROM shadow_trades st
        LEFT JOIN wallet_scores ws ON ws.wallet = st.wallet
        LEFT JOIN wallet_research_reports wrr ON wrr.wallet = st.wallet
        WHERE st.status = 'SIMULATED'
          AND st.forward_eligible = 1
          AND st.policy_version = ?
          AND st.source_timestamp >= MAX(?, COALESCE(wrr.first_observed_at, ?))
          ${categoryExclusion}
          ${categoryInclusion}
        GROUP BY st.wallet
      )
      WHERE score >= ?
        AND live_executable_shadow_simulated >= ?
        AND live_executable_shadow_pnl > ?
        AND live_executable_shadow_avg_return_pct > ?
        AND source_sell_realized_ratio >= ?
        AND COALESCE(live_executable_shadow_win_rate, 0) >= ?
      ORDER BY live_executable_shadow_pnl DESC,
               live_executable_shadow_avg_return_pct DESC,
               score DESC
      LIMIT ?
    `).all(
      input.minWalletScore,
      input.minWalletScore,
      input.policyVersion ?? "live-shadow-parity-v1",
      input.sourceTimestampSince ?? 0,
      input.sourceTimestampSince ?? 0,
      ...excludedCategories,
      ...includedCategories,
      input.minWalletScore,
      input.minTrades,
      input.minPnl,
      input.minReturnPct,
      input.minSourceSellRatio,
      input.minWinRate ?? 0,
      input.limit
    ) as unknown as Array<DbWalletScore & {
      shadow_wins: number | null;
      shadow_losses: number | null;
      live_wins: number | null;
      live_losses: number | null;
    }>;
    return rows.map((row) => {
      const score = rowToWalletScore(row);
      const shadowWins = Number(row.shadow_wins ?? 0);
      const shadowLosses = Number(row.shadow_losses ?? 0);
      const liveWins = Number(row.live_wins ?? 0);
      const liveLosses = Number(row.live_losses ?? 0);
      return {
        ...score,
        shadowWinRate: shadowWins + shadowLosses > 0 ? shadowWins / (shadowWins + shadowLosses) : score.shadowWinRate,
        liveExecutableShadowWinRate: liveWins + liveLosses > 0 ? liveWins / (liveWins + liveLosses) : score.liveExecutableShadowWinRate,
        flags: uniqueStrings([...score.flags, "DURABLE_LIVE_EXECUTABLE_SHADOW", "SHADOW_PROVEN_COPYABLE"])
      };
    });
  }

  getLatestOrderBooksForTokens(tokenIds: string[]): OrderBookSnapshot[] {
    const unique = [...new Set(tokenIds.filter(Boolean))];
    if (unique.length === 0) return [];
    const placeholders = unique.map(() => "?").join(",");
    const rows = this.db.prepare(`
      SELECT obs.*
      FROM orderbook_snapshots obs
      JOIN (
        SELECT token_id, MAX(created_at) AS created_at
        FROM orderbook_snapshots
        WHERE token_id IN (${placeholders})
        GROUP BY token_id
      ) latest
        ON latest.token_id = obs.token_id
       AND latest.created_at = obs.created_at
    `).all(...unique) as Array<{
      token_id: string;
      market_id: string | null;
      best_bid: number | null;
      best_ask: number | null;
      spread: number | null;
      depth: number;
      tick_size: number | null;
      raw_json: string | null;
      created_at: number;
    }>;
    return rows.map(rowToOrderBook);
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

  getWalletsWithTradeActivitySince(since: number, limit: number): string[] {
    const rows = this.db.prepare(`
      SELECT wallet
      FROM wallet_trades
      WHERE timestamp >= ?
      GROUP BY wallet
      ORDER BY COUNT(*) DESC, MAX(timestamp) DESC
      LIMIT ?
    `).all(Math.max(0, since), limit) as Array<{ wallet: string }>;
    return rows.map((row) => row.wallet);
  }

  saveShadowTrades(trades: ShadowTrade[]): number {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO shadow_trades
      (id, wallet, market_id, category, token_id, outcome, source_timestamp, source_observed_at, detected_at, source_price, simulated_entry_price,
       simulated_exit_price, size_usd, pnl, return_pct, live_executable_pnl, live_executable_return_pct, live_executable_status,
       live_executable_reason, live_executable_entry_price, live_executable_exit_price, live_executable_entry_slippage,
       live_executable_exit_slippage, status, exit_reason, rejection_reason, forward_eligible, policy_version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        trade.sourceObservedAt ?? null,
        trade.detectedAt,
        trade.sourcePrice,
        trade.simulatedEntryPrice ?? null,
        trade.simulatedExitPrice ?? null,
        trade.sizeUsd,
        trade.pnl,
        trade.returnPct,
        trade.liveExecutablePnl ?? null,
        trade.liveExecutableReturnPct ?? null,
        trade.liveExecutableStatus ?? null,
        trade.liveExecutableReason ?? null,
        trade.liveExecutableEntryPrice ?? null,
        trade.liveExecutableExitPrice ?? null,
        trade.liveExecutableEntrySlippage ?? null,
        trade.liveExecutableExitSlippage ?? null,
        trade.status,
        trade.exitReason ?? null,
        trade.rejectionReason ?? null,
        trade.forwardEligible ? 1 : 0,
        trade.policyVersion ?? null,
        trade.createdAt
      );
      saved += Number(result.changes ?? 0);
    }
    return saved;
  }

  // Rewrites the live-executable columns of already-simulated shadow trades under
  // the current tape model. Stored rows carry whatever model was in force when they
  // were written, and hasLiveExecutableProof aggregates them directly, so a change
  // to the model has no effect on the live gate until the history is recomputed.
  //
  // Rows touched are those already EXECUTABLE (repriced) plus those rejected for
  // having no mirrorable source-sell, which the current model now admits. Both
  // groups already cleared the min-size, entry-slippage and buy-size checks that run
  // before that rejection, so replaying them with satisfying sizes is sound. Rows
  // rejected on a size check are left alone: their inputs are not stored, and FIFO
  // re-matching changes them anyway, so they need a fresh backtest rather than a
  // recompute.
  recomputeLiveExecutableShadow(config: BotConfig): { scanned: number; updated: number; nowMissed: number } {
    const rows = this.db.prepare(`
      SELECT id, source_price, simulated_entry_price, simulated_exit_price, size_usd, exit_reason,
             live_executable_pnl, live_executable_return_pct
      FROM shadow_trades
      WHERE status = 'SIMULATED'
        AND (live_executable_status = 'EXECUTABLE'
             OR live_executable_reason LIKE 'no live mirrorable%')
    `).all() as unknown as Array<{
      id: string;
      source_price: number;
      simulated_entry_price: number | null;
      simulated_exit_price: number | null;
      size_usd: number;
      exit_reason: string | null;
      live_executable_pnl: number | null;
      live_executable_return_pct: number | null;
    }>;

    const update = this.db.prepare(`
      UPDATE shadow_trades
      SET live_executable_pnl = ?, live_executable_return_pct = ?, live_executable_status = ?,
          live_executable_reason = ?, live_executable_entry_price = ?, live_executable_exit_price = ?,
          live_executable_entry_slippage = ?, live_executable_exit_slippage = ?
      WHERE id = ?
    `);

    let updated = 0;
    let nowMissed = 0;
    for (const row of rows) {
      if (row.simulated_entry_price === null || row.simulated_exit_price === null) continue;
      const shares = row.simulated_entry_price > 0 ? row.size_usd / row.simulated_entry_price : 0;
      const recomputed = estimateTapeExecutableShadow({
        sourcePrice: row.source_price,
        entryPrice: row.simulated_entry_price,
        exitPrice: row.simulated_exit_price,
        // The row was EXECUTABLE, so it already cleared both FOK size checks; those
        // are independent of the exit model, so replay them as satisfied.
        sourceBuySize: shares,
        sourceSellSize: shares,
        sizeUsd: Math.max(row.size_usd, config.minPositionSize),
        exitReason: row.exit_reason ?? undefined,
        config
      });
      if (recomputed.status === "MISSED") nowMissed += 1;
      update.run(
        recomputed.pnl ?? null,
        recomputed.returnPct ?? null,
        recomputed.status,
        recomputed.reason,
        recomputed.entryPrice ?? null,
        recomputed.exitPrice ?? null,
        recomputed.entrySlippage ?? null,
        recomputed.exitSlippage ?? null,
        row.id
      );
      updated += 1;
    }
    return { scanned: rows.length, updated, nowMissed };
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
        SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losses,
        COALESCE(SUM(CASE WHEN live_executable_status = 'EXECUTABLE' THEN live_executable_pnl ELSE 0 END), 0) as live_executable_pnl,
        SUM(CASE WHEN live_executable_status = 'EXECUTABLE' THEN 1 ELSE 0 END) as live_executable_simulated,
        COALESCE(AVG(CASE WHEN live_executable_status = 'EXECUTABLE' THEN live_executable_return_pct END), 0) as live_executable_avg_return_pct,
        SUM(CASE WHEN live_executable_status = 'EXECUTABLE' AND live_executable_pnl > 0 THEN 1 ELSE 0 END) as live_wins,
        SUM(CASE WHEN live_executable_status = 'EXECUTABLE' AND live_executable_pnl < 0 THEN 1 ELSE 0 END) as live_losses
      FROM shadow_trades
      WHERE status = 'SIMULATED'
    `).get() as {
      pnl: number;
      avg_return_pct: number;
      wins: number;
      losses: number;
      live_executable_pnl: number;
      live_executable_simulated: number;
      live_executable_avg_return_pct: number;
      live_wins: number;
      live_losses: number;
    };
    const wins = Number(row.wins ?? 0);
    const losses = Number(row.losses ?? 0);
    const liveWins = Number(row.live_wins ?? 0);
    const liveLosses = Number(row.live_losses ?? 0);
    return {
      total,
      simulated,
      skipped,
      pnl: Number(row.pnl ?? 0),
      wins,
      losses,
      winRate: wins + losses > 0 ? wins / (wins + losses) : 0,
      avgReturnPct: Number(row.avg_return_pct ?? 0),
      liveExecutablePnl: Number(row.live_executable_pnl ?? 0),
      liveExecutableSimulated: Number(row.live_executable_simulated ?? 0),
      liveExecutableWinRate: liveWins + liveLosses > 0 ? liveWins / (liveWins + liveLosses) : 0,
      liveExecutableAvgReturnPct: Number(row.live_executable_avg_return_pct ?? 0)
    };
  }

  getForwardShadowScorecard(
    since = this.performanceStartAt,
    policyVersion = "live-shadow-parity-v1",
    categoryPolicy: { blocked?: MarketCategory[]; allowed?: MarketCategory[]; enforceAllowlist?: boolean } = {}
  ): ForwardShadowScorecard {
    const boundary = Math.max(0, since);
    const blocked = (categoryPolicy.blocked ?? []).filter(Boolean);
    const allowed = (categoryPolicy.allowed ?? []).filter(Boolean);
    const clauses: string[] = [];
    const categoryParams: MarketCategory[] = [];
    if (blocked.length > 0) {
      clauses.push(`AND COALESCE(category, 'other') NOT IN (${blocked.map(() => "?").join(", ")})`);
      categoryParams.push(...blocked);
    }
    if (categoryPolicy.enforceAllowlist === true && allowed.length === 0) clauses.push("AND 1 = 0");
    else if (allowed.length > 0) {
      clauses.push(`AND COALESCE(category, 'other') IN (${allowed.map(() => "?").join(", ")})`);
      categoryParams.push(...allowed);
    }
    const categoryClause = clauses.join("\n        ");
    const queryParams = [boundary, policyVersion, ...categoryParams];
    const counts = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'SIMULATED' THEN 1 ELSE 0 END) AS simulated,
        SUM(CASE WHEN status = 'SKIPPED' THEN 1 ELSE 0 END) AS skipped,
        SUM(CASE WHEN live_executable_status = 'MISSED' THEN 1 ELSE 0 END) AS missed
      FROM shadow_trades
      WHERE source_timestamp >= ? AND forward_eligible = 1 AND policy_version = ?
        ${categoryClause}
    `).get(...queryParams) as { total: number; simulated: number | null; skipped: number | null; missed: number | null };
    const metrics = this.db.prepare(`
      SELECT
        COALESCE(SUM(pnl), 0) AS pnl,
        COALESCE(AVG(return_pct), 0) AS avg_return_pct,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) AS losses,
        COALESCE(SUM(CASE WHEN live_executable_status = 'EXECUTABLE' THEN live_executable_pnl ELSE 0 END), 0) AS live_executable_pnl,
        SUM(CASE WHEN live_executable_status = 'EXECUTABLE' THEN 1 ELSE 0 END) AS live_executable_simulated,
        COALESCE(AVG(CASE WHEN live_executable_status = 'EXECUTABLE' THEN live_executable_return_pct END), 0) AS live_executable_avg_return_pct,
        SUM(CASE WHEN live_executable_status = 'EXECUTABLE' AND live_executable_pnl > 0 THEN 1 ELSE 0 END) AS live_wins,
        SUM(CASE WHEN live_executable_status = 'EXECUTABLE' AND live_executable_pnl < 0 THEN 1 ELSE 0 END) AS live_losses
      FROM shadow_trades
      WHERE source_timestamp >= ? AND forward_eligible = 1 AND policy_version = ? AND status = 'SIMULATED'
        ${categoryClause}
    `).get(...queryParams) as {
      pnl: number; avg_return_pct: number; wins: number | null; losses: number | null;
      live_executable_pnl: number; live_executable_simulated: number | null;
      live_executable_avg_return_pct: number; live_wins: number | null; live_losses: number | null;
    };
    const missedReasons = this.db.prepare(`
      SELECT COALESCE(NULLIF(live_executable_reason, ''), 'unknown') AS reason, COUNT(*) AS count
      FROM shadow_trades
      WHERE source_timestamp >= ? AND forward_eligible = 1 AND policy_version = ? AND live_executable_status = 'MISSED'
        ${categoryClause}
      GROUP BY COALESCE(NULLIF(live_executable_reason, ''), 'unknown')
      ORDER BY count DESC, reason ASC
    `).all(...queryParams) as Array<{ reason: string; count: number }>;
    const categories = this.db.prepare(`
      SELECT
        COALESCE(category, 'other') AS category,
        SUM(CASE WHEN status = 'SIMULATED' THEN 1 ELSE 0 END) AS simulated,
        SUM(CASE WHEN live_executable_status = 'EXECUTABLE' THEN 1 ELSE 0 END) AS live_executable_simulated,
        COALESCE(SUM(CASE WHEN live_executable_status = 'EXECUTABLE' THEN live_executable_pnl ELSE 0 END), 0) AS live_executable_pnl,
        COALESCE(AVG(CASE WHEN live_executable_status = 'EXECUTABLE' THEN live_executable_return_pct END), 0) AS live_executable_avg_return_pct,
        SUM(CASE WHEN live_executable_status = 'EXECUTABLE' AND live_executable_pnl > 0 THEN 1 ELSE 0 END) AS live_wins,
        SUM(CASE WHEN live_executable_status = 'EXECUTABLE' AND live_executable_pnl < 0 THEN 1 ELSE 0 END) AS live_losses
      FROM shadow_trades
      WHERE source_timestamp >= ? AND forward_eligible = 1 AND policy_version = ?
        ${categoryClause}
      GROUP BY COALESCE(category, 'other')
      ORDER BY live_executable_pnl DESC, simulated DESC
    `).all(...queryParams) as Array<{
      category: ForwardShadowScorecard["categories"][number]["category"];
      simulated: number; live_executable_simulated: number; live_executable_pnl: number;
      live_executable_avg_return_pct: number; live_wins: number | null; live_losses: number | null;
    }>;
    const wins = Number(metrics.wins ?? 0);
    const losses = Number(metrics.losses ?? 0);
    const liveWins = Number(metrics.live_wins ?? 0);
    const liveLosses = Number(metrics.live_losses ?? 0);
    return {
      since: boundary,
      total: Number(counts.total ?? 0),
      simulated: Number(counts.simulated ?? 0),
      skipped: Number(counts.skipped ?? 0),
      missed: Number(counts.missed ?? 0),
      pnl: Number(metrics.pnl ?? 0),
      wins,
      losses,
      winRate: wins + losses > 0 ? wins / (wins + losses) : 0,
      avgReturnPct: Number(metrics.avg_return_pct ?? 0),
      liveExecutablePnl: Number(metrics.live_executable_pnl ?? 0),
      liveExecutableSimulated: Number(metrics.live_executable_simulated ?? 0),
      liveExecutableWinRate: liveWins + liveLosses > 0 ? liveWins / (liveWins + liveLosses) : 0,
      liveExecutableAvgReturnPct: Number(metrics.live_executable_avg_return_pct ?? 0),
      missedReasons: missedReasons.map((row) => ({ reason: row.reason, count: Number(row.count) })),
      categories: categories.map((row) => {
        const categoryWins = Number(row.live_wins ?? 0);
        const categoryLosses = Number(row.live_losses ?? 0);
        return {
          category: row.category,
          simulated: Number(row.simulated ?? 0),
          liveExecutableSimulated: Number(row.live_executable_simulated ?? 0),
          liveExecutablePnl: Number(row.live_executable_pnl ?? 0),
          liveExecutableWinRate: categoryWins + categoryLosses > 0 ? categoryWins / (categoryWins + categoryLosses) : 0,
          liveExecutableAvgReturnPct: Number(row.live_executable_avg_return_pct ?? 0)
        };
      })
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
       shadow_pnl, shadow_avg_return_pct, shadow_win_rate, shadow_score_impact, source_sell_shadow_realized, source_sell_realized_ratio,
       live_executable_shadow_simulated, live_executable_shadow_pnl, live_executable_shadow_avg_return_pct, live_executable_shadow_win_rate,
       trade_count, reliability, flags_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      score.sourceSellShadowRealized ?? null,
      score.sourceSellRealizedRatio ?? null,
      score.liveExecutableShadowSimulated ?? null,
      score.liveExecutableShadowPnl ?? null,
      score.liveExecutableShadowAvgReturnPct ?? null,
      score.liveExecutableShadowWinRate ?? null,
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
  source_sell_shadow_realized: number | null;
  source_sell_realized_ratio: number | null;
  live_executable_shadow_simulated: number | null;
  live_executable_shadow_pnl: number | null;
  live_executable_shadow_avg_return_pct: number | null;
  live_executable_shadow_win_rate: number | null;
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
  created_at: number;
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
  source_buy_timestamp: number | null;
  bot_detected_timestamp: number | null;
  expected_entry_price: number | null;
  expected_exit_price: number | null;
  expected_live_executable_return_pct: number | null;
  entry_book_depth: number | null;
  entry_depth_multiple: number | null;
  max_entry_slippage: number | null;
  source_sell_realized_ratio: number | null;
  parity_status: TradeSignal["parityStatus"] | null;
  parity_reason: string | null;
  model_json: string | null;
  created_at: number;
}

interface DbTradeParityMetric {
  id: string;
  position_id: string | null;
  order_id: string | null;
  signal_id: string | null;
  profile: Position["profile"] | null;
  market_id: string;
  token_id: string;
  outcome: string;
  source_buy_timestamp: number | null;
  bot_detected_timestamp: number | null;
  order_sent_timestamp: number | null;
  fill_timestamp: number | null;
  shadow_expected_entry: number | null;
  shadow_expected_exit: number | null;
  actual_entry: number | null;
  actual_exit: number | null;
  entry_slippage: number | null;
  exit_slippage: number | null;
  missed_reason: string | null;
  partial_fill_reason: string | null;
  execution_policy: TradeParityMetric["executionPolicy"] | null;
  entry_book_depth: number | null;
  entry_depth_multiple: number | null;
  expected_live_executable_return_pct: number | null;
  source_sell_realized_ratio: number | null;
  aligned_wallets_json: string | null;
  created_at: number;
  updated_at: number;
}

interface DbPaperOrder {
  id: string;
  signal_id: string;
  profile: PaperOrder["profile"] | null;
  market_id: string;
  token_id: string;
  outcome: string;
  side: PaperOrder["side"];
  price: number;
  size: number;
  remaining_size: number;
  status: PaperOrder["status"];
  created_at: number;
  expires_at: number;
  execution_policy: PaperOrder["executionPolicy"] | null;
  fee_rate: number | null;
  missed_reason: string | null;
  partial_fill_reason: string | null;
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

function rowToPaperOrder(row: DbPaperOrder): PaperOrder {
  return {
    id: row.id,
    signalId: row.signal_id,
    profile: row.profile ?? undefined,
    marketId: row.market_id,
    tokenId: row.token_id,
    outcome: row.outcome,
    side: row.side,
    price: row.price,
    size: row.size,
    remainingSize: row.remaining_size,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    executionPolicy: row.execution_policy ?? undefined,
    feeRate: row.fee_rate ?? undefined,
    missedReason: row.missed_reason ?? undefined,
    partialFillReason: row.partial_fill_reason ?? undefined
  };
}

function rowToMarket(row: DbMarket): MarketSnapshot {
  const raw = row.raw_json ? JSON.parse(row.raw_json) as unknown : undefined;
  const rawRecord = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const feeSchedule = rawRecord.feeSchedule && typeof rawRecord.feeSchedule === "object" && !Array.isArray(rawRecord.feeSchedule)
    ? rawRecord.feeSchedule as Record<string, unknown>
    : undefined;
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
    feesEnabled: rawRecord.feesEnabled === undefined ? undefined : Boolean(rawRecord.feesEnabled),
    takerFeeRate: finiteNumberOrUndefined(feeSchedule?.rate ?? rawRecord.takerFeeRate ?? rawRecord.feeRate),
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
    sourceSellShadowRealized: row.source_sell_shadow_realized ?? undefined,
    sourceSellRealizedRatio: row.source_sell_realized_ratio ?? undefined,
    liveExecutableShadowSimulated: row.live_executable_shadow_simulated ?? undefined,
    liveExecutableShadowPnl: row.live_executable_shadow_pnl ?? undefined,
    liveExecutableShadowAvgReturnPct: row.live_executable_shadow_avg_return_pct ?? undefined,
    liveExecutableShadowWinRate: row.live_executable_shadow_win_rate ?? undefined,
    tradeCount: row.trade_count,
    recentTradeCount: row.recent_trade_count,
    reliability: row.reliability,
    flags: JSON.parse(row.flags_json) as string[],
    updatedAt: row.updated_at
  };
}

function rowToOrderBook(row: {
  token_id: string;
  market_id: string | null;
  best_bid: number | null;
  best_ask: number | null;
  spread: number | null;
  depth: number;
  tick_size?: number | null;
  raw_json: string | null;
  created_at: number;
}): OrderBookSnapshot {
  const raw = row.raw_json ? JSON.parse(row.raw_json) as unknown : undefined;
  const rawRecord = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const bids = parsePriceLevels(rawRecord.bids);
  const asks = parsePriceLevels(rawRecord.asks);
  return {
    tokenId: row.token_id,
    marketId: row.market_id ?? undefined,
    bids,
    asks,
    bestBid: row.best_bid ?? (bids.length ? Math.max(...bids.map((level) => level.price)) : undefined),
    bestAsk: row.best_ask ?? (asks.length ? Math.min(...asks.map((level) => level.price)) : undefined),
    spread: row.spread ?? undefined,
    depth: row.depth,
    tickSize: row.tick_size ?? undefined,
    raw,
    timestamp: row.created_at
  };
}

function parsePriceLevels(value: unknown): Array<{ price: number; size: number }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const price = Number(record.price ?? record.p);
      const size = Number(record.size ?? record.s);
      return { price, size };
    })
    .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size) && level.size > 0);
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
    observedAt: row.created_at,
    raw: row.raw_json ? JSON.parse(row.raw_json) as unknown : undefined
  };
}

function rowToSignal(row: DbSignal): TradeSignal {
  const model = row.model_json ? JSON.parse(row.model_json) as Partial<TradeSignal> : {};
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
    createdAt: row.created_at,
    sourceBuyTimestamp: row.source_buy_timestamp ?? undefined,
    botDetectedTimestamp: row.bot_detected_timestamp ?? undefined,
    expectedEntryPrice: row.expected_entry_price ?? undefined,
    expectedExitPrice: row.expected_exit_price ?? undefined,
    expectedLiveExecutableReturnPct: row.expected_live_executable_return_pct ?? undefined,
    entryBookDepth: row.entry_book_depth ?? undefined,
    entryDepthMultiple: row.entry_depth_multiple ?? undefined,
    maxEntrySlippage: row.max_entry_slippage ?? undefined,
    sourceSellRealizedRatio: row.source_sell_realized_ratio ?? undefined,
    parityStatus: row.parity_status ?? undefined,
    parityReason: row.parity_reason ?? undefined,
    ...model
  };
}

function rowToTradeParityMetric(row: DbTradeParityMetric): TradeParityMetric {
  return {
    id: row.id,
    positionId: row.position_id ?? undefined,
    orderId: row.order_id ?? undefined,
    signalId: row.signal_id ?? undefined,
    profile: row.profile ?? undefined,
    marketId: row.market_id,
    tokenId: row.token_id,
    outcome: row.outcome,
    sourceBuyTimestamp: row.source_buy_timestamp ?? undefined,
    botDetectedTimestamp: row.bot_detected_timestamp ?? undefined,
    orderSentTimestamp: row.order_sent_timestamp ?? undefined,
    fillTimestamp: row.fill_timestamp ?? undefined,
    shadowExpectedEntry: row.shadow_expected_entry ?? undefined,
    shadowExpectedExit: row.shadow_expected_exit ?? undefined,
    actualEntry: row.actual_entry ?? undefined,
    actualExit: row.actual_exit ?? undefined,
    entrySlippage: row.entry_slippage ?? undefined,
    exitSlippage: row.exit_slippage ?? undefined,
    missedReason: row.missed_reason ?? undefined,
    partialFillReason: row.partial_fill_reason ?? undefined,
    executionPolicy: row.execution_policy ?? undefined,
    entryBookDepth: row.entry_book_depth ?? undefined,
    entryDepthMultiple: row.entry_depth_multiple ?? undefined,
    expectedLiveExecutableReturnPct: row.expected_live_executable_return_pct ?? undefined,
    sourceSellRealizedRatio: row.source_sell_realized_ratio ?? undefined,
    alignedWallets: row.aligned_wallets_json ? JSON.parse(row.aligned_wallets_json) as string[] : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function finiteNumberOrUndefined(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
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
  if (/\b(highest temperature|lowest temperature|weather|rainfall|snowfall|precipitation|hurricane|wind speed)\b/.test(text)) return "weather";
  if (/\b(election|president|senate|house|congress|trump|biden|poll|mayor|governor|democrat|republican|minister)\b/.test(text)) return "politics";
  if (/\b(nba|nfl|mlb|nhl|ufc|soccer|football|tennis|golf|cricket|team|championship|super bowl|world cup)\b/.test(text)) return "sports";
  if (/\b(bitcoin|btc|ethereum|eth|solana|sol|xrp|crypto|token|coin|binance)\b/.test(text)) return "crypto";
  if (/\b(fed|inflation|cpi|rates|gdp|jobs|unemployment|recession|tariff|oil|gold|s&p|s and p|dow|nasdaq)\b/.test(text)) return "macro";
  if (/\b(tesla|apple|nvidia|meta|google|amazon|microsoft|stock|earnings|ipo)\b/.test(text)) return "company";
  if (/\b(oscar|grammy|movie|album|stream|youtube|tiktok|celebrity|music)\b/.test(text)) return "culture";
  return "other";
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeOutcomeText(value: string): string {
  return value.trim().toLowerCase();
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function forwardSelectionId(strategyId: string, policyVersion: string, eventKey: string): string {
  return `forward:${strategyId}:${policyVersion}:${eventKey}`;
}

export function randomId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
