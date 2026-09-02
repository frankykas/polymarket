.mode column
.headers on

SELECT 'generated_utc' AS metric, datetime('now') AS value;

SELECT 'fresh_live_exec_since_restart' AS section;
WITH fresh AS (
  SELECT *
  FROM shadow_trades
  WHERE created_at >= strftime('%s','2026-08-04 06:02:30')*1000
)
SELECT
  live_executable_status,
  live_executable_reason,
  COUNT(*) AS trades,
  ROUND(SUM(COALESCE(live_executable_pnl,0)), 2) AS live_pnl,
  ROUND(AVG(live_executable_return_pct)*100, 2) AS avg_ret_pct,
  SUM(CASE WHEN live_executable_pnl > 0 THEN 1 ELSE 0 END) AS wins,
  SUM(CASE WHEN live_executable_pnl < 0 THEN 1 ELSE 0 END) AS losses
FROM fresh
GROUP BY live_executable_status, live_executable_reason
ORDER BY trades DESC;

SELECT 'fresh_live_exec_by_wallet' AS section;
WITH fresh AS (
  SELECT *
  FROM shadow_trades
  WHERE created_at >= strftime('%s','2026-08-04 06:02:30')*1000
    AND live_executable_status='EXECUTABLE'
)
SELECT
  substr(wallet,1,10) || '...' AS wallet,
  category,
  COUNT(*) AS live_n,
  ROUND(SUM(live_executable_pnl), 2) AS live_pnl,
  ROUND(AVG(live_executable_return_pct)*100, 2) AS avg_ret_pct,
  SUM(CASE WHEN live_executable_pnl > 0 THEN 1 ELSE 0 END) AS wins,
  SUM(CASE WHEN live_executable_pnl < 0 THEN 1 ELSE 0 END) AS losses,
  ROUND(AVG(live_executable_entry_slippage)*100, 2) AS avg_entry_slip_c,
  ROUND(AVG(live_executable_exit_slippage)*100, 2) AS avg_exit_slip_c
FROM fresh
GROUP BY wallet, category
ORDER BY live_pnl ASC
LIMIT 30;

SELECT 'fresh_live_exec_by_category' AS section;
WITH fresh AS (
  SELECT *
  FROM shadow_trades
  WHERE created_at >= strftime('%s','2026-08-04 06:02:30')*1000
    AND live_executable_status='EXECUTABLE'
)
SELECT
  COALESCE(category,'unknown') AS category,
  COUNT(*) AS live_n,
  ROUND(SUM(live_executable_pnl), 2) AS live_pnl,
  ROUND(AVG(live_executable_return_pct)*100, 2) AS avg_ret_pct,
  SUM(CASE WHEN live_executable_pnl > 0 THEN 1 ELSE 0 END) AS wins,
  SUM(CASE WHEN live_executable_pnl < 0 THEN 1 ELSE 0 END) AS losses
FROM fresh
GROUP BY COALESCE(category,'unknown')
ORDER BY live_pnl ASC;

SELECT 'fresh_live_exec_trade_examples' AS section;
SELECT
  datetime(created_at/1000, 'unixepoch') AS created_utc,
  substr(wallet,1,10) || '...' AS wallet,
  category,
  market_id,
  outcome,
  ROUND(source_price,3) AS src_px,
  ROUND(live_executable_entry_price,3) AS entry_px,
  ROUND(live_executable_exit_price,3) AS exit_px,
  ROUND(live_executable_pnl,2) AS pnl,
  ROUND(live_executable_return_pct*100,2) AS ret_pct,
  exit_reason
FROM shadow_trades
WHERE created_at >= strftime('%s','2026-08-04 06:02:30')*1000
  AND live_executable_status='EXECUTABLE'
ORDER BY live_executable_pnl ASC
LIMIT 25;

SELECT 'fresh_source_score_snapshots' AS section;
SELECT
  COUNT(*) AS snapshots,
  COUNT(DISTINCT wallet) AS wallets,
  datetime(MAX(created_at)/1000, 'unixepoch') AS latest_utc
FROM source_score_snapshots
WHERE created_at >= strftime('%s','2026-08-04 06:02:30')*1000;

SELECT 'fresh_gate_candidates_after_fix' AS section;
WITH latest AS (
  SELECT ss.*
  FROM source_score_snapshots ss
  JOIN (
    SELECT wallet, MAX(created_at) AS max_created_at
    FROM source_score_snapshots
    GROUP BY wallet
  ) x ON x.wallet = ss.wallet AND x.max_created_at = ss.created_at
)
SELECT
  COUNT(*) AS wallets,
  SUM(CASE WHEN score >= 68 THEN 1 ELSE 0 END) AS score_ok,
  SUM(CASE WHEN score >= 68 AND live_executable_shadow_simulated >= 3 THEN 1 ELSE 0 END) AS sample_ok,
  SUM(CASE WHEN score >= 68 AND live_executable_shadow_simulated >= 3 AND live_executable_shadow_pnl > 0 THEN 1 ELSE 0 END) AS pnl_ok,
  SUM(CASE WHEN score >= 68 AND live_executable_shadow_simulated >= 3 AND live_executable_shadow_pnl > 0 AND live_executable_shadow_avg_return_pct > 0.03 THEN 1 ELSE 0 END) AS return_ok,
  SUM(CASE WHEN score >= 68 AND live_executable_shadow_simulated >= 3 AND live_executable_shadow_pnl > 0 AND live_executable_shadow_avg_return_pct > 0.03 AND live_executable_shadow_win_rate >= 0.45 THEN 1 ELSE 0 END) AS winrate_ok,
  SUM(CASE WHEN score >= 68 AND live_executable_shadow_simulated >= 3 AND live_executable_shadow_pnl > 0 AND live_executable_shadow_avg_return_pct > 0.03 AND live_executable_shadow_win_rate >= 0.45 AND source_sell_realized_ratio >= 0.30 THEN 1 ELSE 0 END) AS current_gate_pass
FROM latest;
