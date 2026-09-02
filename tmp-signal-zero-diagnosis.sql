.mode column
.headers on

SELECT 'generated_utc' AS metric, datetime('now') AS value;

SELECT 'wallet_trades_recent_side_counts' AS section;
WITH windows(label, cutoff) AS (
  VALUES
    ('1h', strftime('%s','now','-1 hours')*1000),
    ('6h', strftime('%s','now','-6 hours')*1000),
    ('24h', strftime('%s','now','-24 hours')*1000),
    ('48h', strftime('%s','now','-48 hours')*1000),
    ('all', 0)
)
SELECT
  w.label,
  wt.side,
  COUNT(*) AS trades,
  COUNT(DISTINCT wt.wallet) AS wallets,
  COUNT(DISTINCT wt.market_id) AS markets,
  datetime(MAX(wt.timestamp)/1000, 'unixepoch') AS latest_trade_utc
FROM windows w
LEFT JOIN wallet_trades wt ON wt.timestamp >= w.cutoff
GROUP BY w.label, wt.side
ORDER BY CASE w.label WHEN '1h' THEN 1 WHEN '6h' THEN 2 WHEN '24h' THEN 3 WHEN '48h' THEN 4 ELSE 5 END, wt.side;

SELECT 'bot_run_and_agent_activity' AS section;
SELECT
  'bot_logs' AS table_name,
  COUNT(*) AS rows_24h,
  datetime(MAX(created_at)/1000, 'unixepoch') AS latest_utc
FROM bot_run_logs
WHERE created_at >= strftime('%s','now','-24 hours')*1000
UNION ALL
SELECT
  'agent_events' AS table_name,
  COUNT(*) AS rows_24h,
  datetime(MAX(created_at)/1000, 'unixepoch') AS latest_utc
FROM agent_events
WHERE created_at >= strftime('%s','now','-24 hours')*1000;

SELECT 'latest_signal_diagnostics_payloads' AS section;
SELECT
  datetime(created_at/1000, 'unixepoch') AS utc,
  json_extract(payload_json,'$.totalTrades') AS total_trades,
  json_extract(payload_json,'$.buyTrades') AS buy_trades,
  json_extract(payload_json,'$.scoredBuyTrades') AS scored_buy_trades,
  json_extract(payload_json,'$.groupedMarkets') AS grouped_markets,
  json_extract(payload_json,'$.emittedSignals') AS emitted,
  json_extract(payload_json,'$.tradeCandidates') AS candidates,
  json_extract(payload_json,'$.watchlist') AS watchlist,
  json_extract(payload_json,'$.topDropReasons[0].reason') AS drop1,
  json_extract(payload_json,'$.topDropReasons[0].count') AS drop1_count,
  json_extract(payload_json,'$.topDropReasons[1].reason') AS drop2,
  json_extract(payload_json,'$.topDropReasons[1].count') AS drop2_count,
  json_extract(payload_json,'$.topSourceRejectReasons[0].reason') AS src_reject1,
  json_extract(payload_json,'$.topSourceRejectReasons[0].count') AS src_reject1_count
FROM agent_events
WHERE type='signal.diagnostics'
ORDER BY created_at DESC
LIMIT 30;

SELECT 'latest_wallet_scores' AS section;
SELECT
  COUNT(*) AS wallets,
  SUM(CASE WHEN enabled=1 THEN 1 ELSE 0 END) AS enabled
FROM tracked_wallets;

SELECT
  substr(ws.wallet,1,10) || '...' AS wallet,
  ROUND(ws.score,1) AS score,
  ws.reliability,
  ws.trade_count,
  ws.recent_trade_count,
  ws.flags_json,
  datetime(ws.updated_at/1000, 'unixepoch') AS updated_utc
FROM wallet_scores ws
ORDER BY ws.score DESC
LIMIT 25;

SELECT 'shadow_trade_status_all' AS section;
SELECT
  live_executable_status,
  live_executable_reason,
  COUNT(*) AS trades,
  ROUND(SUM(COALESCE(live_executable_pnl,0)), 2) AS live_pnl,
  ROUND(AVG(live_executable_return_pct)*100, 2) AS avg_return_pct,
  datetime(MAX(created_at)/1000, 'unixepoch') AS latest_created_utc
FROM shadow_trades
GROUP BY live_executable_status, live_executable_reason
ORDER BY trades DESC
LIMIT 20;

SELECT 'shadow_live_exec_by_wallet_all' AS section;
SELECT
  substr(wallet,1,10) || '...' AS wallet,
  COUNT(*) AS shadow_trades,
  SUM(CASE WHEN live_executable_status='EXECUTABLE' THEN 1 ELSE 0 END) AS live_exec_n,
  ROUND(SUM(CASE WHEN live_executable_status='EXECUTABLE' THEN live_executable_pnl ELSE 0 END), 2) AS live_exec_pnl,
  ROUND(AVG(CASE WHEN live_executable_status='EXECUTABLE' THEN live_executable_return_pct END)*100, 2) AS live_exec_avg_ret_pct,
  SUM(CASE WHEN live_executable_status='EXECUTABLE' AND live_executable_pnl > 0 THEN 1 ELSE 0 END) AS live_wins,
  SUM(CASE WHEN live_executable_status='EXECUTABLE' AND live_executable_pnl < 0 THEN 1 ELSE 0 END) AS live_losses,
  ROUND(1.0 * SUM(CASE WHEN exit_reason='source sell after detection' THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0) * 100, 1) AS source_sell_ratio_pct
FROM shadow_trades
GROUP BY wallet
HAVING live_exec_n > 0
ORDER BY live_exec_pnl DESC
LIMIT 25;

SELECT 'candidate_entry_details' AS section;
SELECT
  datetime(s.created_at/1000, 'unixepoch') AS signal_utc,
  o.profile,
  s.outcome,
  s.market_id,
  ROUND(s.limit_price,3) AS signal_price,
  ROUND(s.expected_live_executable_return_pct*100,2) AS expected_live_ret_pct,
  ROUND(s.entry_depth_multiple,1) AS depth_x,
  ROUND(s.source_sell_realized_ratio*100,1) AS source_sell_pct,
  o.status AS order_status,
  ROUND(f.price,3) AS fill_price,
  ROUND(f.size * f.price,2) AS notional,
  p.status AS pos_status,
  ROUND(p.realized_pnl,2) AS realized_pnl,
  ROUND(p.size * (p.current_price - p.avg_entry_price),2) AS open_mark_pnl
FROM signals s
JOIN paper_orders o ON o.signal_id=s.id AND o.side='BUY'
LEFT JOIN paper_fills f ON f.order_id=o.id
LEFT JOIN positions p ON p.id=COALESCE(o.profile,'Shared') || ':' || o.market_id || ':' || o.token_id
WHERE s.decision='TRADE_CANDIDATE'
ORDER BY s.created_at DESC
LIMIT 50;
