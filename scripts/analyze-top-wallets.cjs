const { DatabaseSync } = require("node:sqlite");

const db = new DatabaseSync("data/polymarket-paper-bot.sqlite", { readOnly: true });

const top = db.prepare(`
  SELECT
    address,
    copyability_score,
    score,
    hot_score,
    category_consistency_score,
    exit_behavior_score,
    sample_confidence,
    dominant_category,
    trade_count,
    buy_count,
    sell_count,
    unique_markets,
    total_volume,
    realized_pnl_approx,
    profit_factor_approx,
    win_rate_approx,
    avg_return_pct_approx,
    max_drawdown_approx,
    avg_hold_minutes_approx,
    open_position_count,
    open_position_value,
    open_position_pnl_approx,
    resolved_markets,
    resolved_wins,
    resolved_losses,
    resolved_win_rate,
    flags_json,
    first_seen_at,
    last_seen_at
  FROM discovered_wallets
  ORDER BY copyability_score DESC, score DESC, total_volume DESC
  LIMIT 15
`).all();

const walletScores = new Map(db.prepare(`
  SELECT
    wallet,
    score,
    copyability_score,
    reliability,
    shadow_trade_count,
    shadow_simulated,
    shadow_realized,
    shadow_pnl,
    shadow_avg_return_pct,
    shadow_win_rate,
    shadow_score_impact,
    flags_json,
    updated_at
  FROM wallet_scores
`).all().map((row) => [String(row.wallet).toLowerCase(), row]));

const shadowByWallet = new Map(db.prepare(`
  SELECT
    wallet,
    COUNT(*) as total,
    SUM(CASE WHEN status = 'SIMULATED' THEN 1 ELSE 0 END) as simulated,
    SUM(CASE WHEN status = 'SIMULATED' AND pnl > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN status = 'SIMULATED' AND pnl < 0 THEN 1 ELSE 0 END) as losses,
    COALESCE(SUM(CASE WHEN status = 'SIMULATED' THEN pnl ELSE 0 END), 0) as pnl,
    COALESCE(AVG(CASE WHEN status = 'SIMULATED' THEN return_pct ELSE NULL END), 0) as avg_return_pct,
    SUM(CASE WHEN exit_reason IN ('source sell after detection', 'resolved market outcome') THEN 1 ELSE 0 END) as realized_exits,
    SUM(CASE WHEN exit_reason = 'source price fallback' THEN 1 ELSE 0 END) as fallback_exits
  FROM shadow_trades
  GROUP BY wallet
`).all().map((row) => [String(row.wallet).toLowerCase(), row]));

const paperByWallet = new Map(db.prepare(`
  SELECT
    wallet,
    COUNT(*) as feedback_rows,
    COALESCE(SUM(pnl), 0) as pnl,
    COALESCE(AVG(avg_return_pct), 0) as avg_return_pct,
    COALESCE(AVG(score_impact), 0) as avg_score_impact,
    MAX(created_at) as latest_at
  FROM paper_source_feedback
  GROUP BY wallet
`).all().map((row) => [String(row.wallet).toLowerCase(), row]));

const recentTradeByWallet = new Map(db.prepare(`
  SELECT wallet, COUNT(*) as stored_trades, MAX(timestamp) as latest_trade_at, MIN(timestamp) as first_trade_at
  FROM wallet_trades
  GROUP BY wallet
`).all().map((row) => [String(row.wallet).toLowerCase(), row]));

const output = top.map((row, index) => {
  const address = String(row.address).toLowerCase();
  const walletScore = walletScores.get(address);
  const shadow = shadowByWallet.get(address);
  const paper = paperByWallet.get(address);
  const history = recentTradeByWallet.get(address);
  return {
    rank: index + 1,
    address,
    discovery: {
      copyabilityScore: row.copyability_score,
      rawScore: row.score,
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
      flags: JSON.parse(row.flags_json || "[]"),
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at
    },
    walletScore,
    shadow,
    paper,
    storedHistory: history
  };
});

console.log(JSON.stringify(output, null, 2));

console.log("\nCURRENT_WALLET_SCORES");
console.log(JSON.stringify(db.prepare(`
  SELECT
    wallet,
    score,
    copyability_score,
    hot_score,
    category_consistency_score,
    sample_confidence,
    dominant_category,
    resolved_markets,
    resolved_wins,
    resolved_losses,
    shadow_trade_count,
    shadow_simulated,
    shadow_pnl,
    shadow_score_impact,
    trade_count,
    recent_trade_count,
    reliability,
    flags_json,
    updated_at
  FROM wallet_scores
  ORDER BY updated_at DESC, score DESC
  LIMIT 30
`).all(), null, 2));

console.log("\nSIGNAL_SOURCE_COUNTS");
console.log(JSON.stringify(db.prepare(`
  SELECT
    wallet,
    COUNT(*) as signal_count
  FROM (
    SELECT json_each.value as wallet
    FROM signals, json_each(signals.aligned_wallets_json)
  )
  GROUP BY wallet
  ORDER BY signal_count DESC
  LIMIT 30
`).all(), null, 2));

console.log("\nCURRENT_TOP_COPYABILITY");
console.log(JSON.stringify(db.prepare(`
  SELECT
    wallet,
    score,
    copyability_score,
    hot_score,
    category_consistency_score,
    sample_confidence,
    dominant_category,
    shadow_simulated,
    shadow_pnl,
    shadow_score_impact,
    trade_count,
    recent_trade_count,
    reliability,
    flags_json,
    updated_at
  FROM wallet_scores
  WHERE copyability_score IS NOT NULL
  ORDER BY copyability_score DESC, score DESC
  LIMIT 20
`).all(), null, 2));

db.close();
