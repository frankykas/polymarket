.mode column
.headers on

SELECT 'generated_utc' AS metric, datetime('now') AS value;

SELECT 'signals_since_fix' AS section;
SELECT
  COUNT(*) AS signals,
  SUM(CASE WHEN decision='TRADE_CANDIDATE' THEN 1 ELSE 0 END) AS candidates,
  SUM(CASE WHEN decision='WATCHLIST' THEN 1 ELSE 0 END) AS watchlist,
  SUM(CASE WHEN reason LIKE 'paper exploration:%' THEN 1 ELSE 0 END) AS paper_exploration,
  datetime(MAX(created_at)/1000, 'unixepoch') AS latest_signal_utc
FROM signals
WHERE created_at >= strftime('%s','2026-08-04 06:20:16')*1000;

SELECT 'latest_signals_since_fix' AS section;
SELECT
  datetime(created_at/1000, 'unixepoch') AS utc,
  decision,
  outcome,
  market_id,
  confidence,
  ROUND(limit_price,3) AS price,
  ROUND(entry_depth_multiple,1) AS depth_x,
  ROUND(source_sell_realized_ratio*100,1) AS source_sell_pct,
  parity_status,
  reason
FROM signals
WHERE created_at >= strftime('%s','2026-08-04 06:20:16')*1000
ORDER BY created_at DESC
LIMIT 25;

SELECT 'paper_fills_since_fix' AS section;
SELECT
  COUNT(*) AS fills,
  SUM(CASE WHEN side='BUY' THEN 1 ELSE 0 END) AS buys,
  SUM(CASE WHEN side='SELL' THEN 1 ELSE 0 END) AS sells,
  ROUND(SUM(price*size),2) AS notional,
  datetime(MAX(timestamp)/1000, 'unixepoch') AS latest_fill_utc
FROM paper_fills
WHERE timestamp >= strftime('%s','2026-08-04 06:20:16')*1000;

SELECT 'risk_since_fix' AS section;
SELECT
  decision,
  reason,
  COUNT(*) AS events,
  datetime(MAX(created_at)/1000, 'unixepoch') AS latest_utc
FROM risk_events
WHERE created_at >= strftime('%s','2026-08-04 06:20:16')*1000
GROUP BY decision, reason
ORDER BY events DESC
LIMIT 20;

SELECT 'latest_signal_diagnostics_since_fix' AS section;
SELECT
  datetime(created_at/1000, 'unixepoch') AS utc,
  json_extract(payload_json,'$.tradeCandidates') AS candidates,
  json_extract(payload_json,'$.emittedSignals') AS emitted,
  json_extract(payload_json,'$.groupedMarkets') AS grouped,
  json_extract(payload_json,'$.topDropReasons[0].reason') AS drop1,
  json_extract(payload_json,'$.topDropReasons[0].count') AS drop1_count,
  json_extract(payload_json,'$.topSourceRejectReasons[0].reason') AS src1,
  json_extract(payload_json,'$.topSourceRejectReasons[0].count') AS src1_count
FROM agent_events
WHERE type='signal.diagnostics'
  AND created_at >= strftime('%s','2026-08-04 06:20:16')*1000
ORDER BY created_at DESC
LIMIT 10;

SELECT 'open_positions' AS section;
SELECT
  COUNT(*) AS open_positions,
  ROUND(COALESCE(SUM(size*avg_entry_price),0),2) AS open_exposure,
  ROUND(COALESCE(SUM(size*(current_price-avg_entry_price)),0),2) AS open_mark_pnl
FROM positions
WHERE status='OPEN';
