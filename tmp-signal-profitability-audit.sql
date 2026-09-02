.mode column
.headers on
.timer off

SELECT 'audit_generated_utc' AS metric, datetime('now') AS value;

SELECT 'current_bot_state' AS section;
SELECT
  (SELECT COUNT(*) FROM positions WHERE status='CLOSED') AS closed_positions,
  ROUND((SELECT COALESCE(SUM(realized_pnl),0) FROM positions WHERE status='CLOSED'), 2) AS realized_pnl,
  (SELECT COUNT(*) FROM positions WHERE status='OPEN') AS open_positions,
  ROUND((SELECT COALESCE(SUM(size * avg_entry_price),0) FROM positions WHERE status='OPEN'), 2) AS open_exposure,
  ROUND((SELECT COALESCE(SUM(size * (current_price - avg_entry_price)),0) FROM positions WHERE status='OPEN'), 2) AS open_mark_pnl;

SELECT 'signals_by_window' AS section;
WITH windows(label, cutoff) AS (
  VALUES
    ('24h', strftime('%s','now','-24 hours')*1000),
    ('48h', strftime('%s','now','-48 hours')*1000),
    ('7d',  strftime('%s','now','-7 days')*1000),
    ('all', 0)
)
SELECT
  w.label,
  COUNT(s.id) AS signals,
  SUM(CASE WHEN s.decision='TRADE_CANDIDATE' THEN 1 ELSE 0 END) AS candidates,
  SUM(CASE WHEN s.decision='WATCHLIST' THEN 1 ELSE 0 END) AS watchlist,
  SUM(CASE WHEN s.parity_status='PASS' THEN 1 ELSE 0 END) AS parity_pass,
  SUM(CASE WHEN s.parity_status='FAIL' THEN 1 ELSE 0 END) AS parity_fail,
  ROUND(AVG(s.expected_live_executable_return_pct) * 100, 2) AS avg_expected_live_return_pct,
  ROUND(AVG(s.entry_depth_multiple), 2) AS avg_depth_x,
  ROUND(MAX(s.max_entry_slippage) * 100, 2) AS max_entry_slippage_cents,
  datetime(MAX(s.created_at)/1000, 'unixepoch') AS latest_signal_utc
FROM windows w
LEFT JOIN signals s ON s.created_at >= w.cutoff
GROUP BY w.label
ORDER BY CASE w.label WHEN '24h' THEN 1 WHEN '48h' THEN 2 WHEN '7d' THEN 3 ELSE 4 END;

SELECT 'candidate_paper_outcomes_by_window' AS section;
WITH windows(label, cutoff) AS (
  VALUES
    ('24h', strftime('%s','now','-24 hours')*1000),
    ('48h', strftime('%s','now','-48 hours')*1000),
    ('7d',  strftime('%s','now','-7 days')*1000),
    ('all', 0)
),
entries AS (
  SELECT
    s.id AS signal_id,
    s.created_at,
    s.expected_live_executable_return_pct,
    s.entry_depth_multiple,
    s.source_sell_realized_ratio,
    o.profile,
    o.id AS order_id,
    o.status AS order_status,
    o.execution_policy,
    f.price AS entry_fill_price,
    f.size AS entry_fill_size,
    p.status AS position_status,
    p.realized_pnl,
    p.current_price,
    p.avg_entry_price,
    p.size AS position_size
  FROM signals s
  JOIN paper_orders o ON o.signal_id = s.id AND o.side='BUY'
  LEFT JOIN paper_fills f ON f.order_id = o.id AND f.side='BUY'
  LEFT JOIN positions p ON p.id = COALESCE(o.profile, 'Shared') || ':' || o.market_id || ':' || o.token_id
  WHERE s.decision='TRADE_CANDIDATE'
)
SELECT
  w.label,
  COUNT(e.signal_id) AS entry_orders,
  SUM(CASE WHEN e.order_status IN ('FILLED','PARTIAL') THEN 1 ELSE 0 END) AS filled_entries,
  SUM(CASE WHEN e.position_status='CLOSED' THEN 1 ELSE 0 END) AS closed_positions,
  ROUND(SUM(CASE WHEN e.position_status='CLOSED' THEN e.realized_pnl ELSE 0 END), 2) AS closed_realized_pnl,
  ROUND(SUM(CASE WHEN e.position_status='OPEN' THEN e.position_size * (e.current_price - e.avg_entry_price) ELSE 0 END), 2) AS open_mark_pnl,
  ROUND(AVG(e.expected_live_executable_return_pct) * 100, 2) AS avg_expected_live_return_pct,
  ROUND(AVG(e.entry_depth_multiple), 2) AS avg_depth_x,
  ROUND(AVG(e.source_sell_realized_ratio) * 100, 1) AS avg_source_sell_ratio_pct
FROM windows w
LEFT JOIN entries e ON e.created_at >= w.cutoff
GROUP BY w.label
ORDER BY CASE w.label WHEN '24h' THEN 1 WHEN '48h' THEN 2 WHEN '7d' THEN 3 ELSE 4 END;

SELECT 'paper_results_by_profile_7d' AS section;
SELECT
  COALESCE(profile, 'Shared') AS profile,
  COUNT(*) AS positions,
  SUM(CASE WHEN status='CLOSED' THEN 1 ELSE 0 END) AS closed,
  SUM(CASE WHEN status='OPEN' THEN 1 ELSE 0 END) AS open,
  SUM(CASE WHEN status='CLOSED' AND realized_pnl > 0 THEN 1 ELSE 0 END) AS wins,
  SUM(CASE WHEN status='CLOSED' AND realized_pnl < 0 THEN 1 ELSE 0 END) AS losses,
  ROUND(SUM(CASE WHEN status='CLOSED' THEN realized_pnl ELSE 0 END), 2) AS realized_pnl,
  ROUND(SUM(CASE WHEN status='OPEN' THEN size * (current_price - avg_entry_price) ELSE 0 END), 2) AS open_mark_pnl
FROM positions
WHERE opened_at >= strftime('%s','now','-7 days')*1000
GROUP BY COALESCE(profile, 'Shared')
ORDER BY realized_pnl ASC;

SELECT 'latest_wallet_score_gate_breakdown' AS section;
WITH latest AS (
  SELECT ss.*
  FROM source_score_snapshots ss
  JOIN (
    SELECT wallet, MAX(created_at) AS max_created_at
    FROM source_score_snapshots
    GROUP BY wallet
  ) x ON x.wallet = ss.wallet AND x.max_created_at = ss.created_at
),
gated AS (
  SELECT
    wallet,
    score,
    reliability,
    shadow_simulated,
    shadow_pnl,
    shadow_avg_return_pct,
    source_sell_realized_ratio,
    live_executable_shadow_simulated,
    live_executable_shadow_pnl,
    live_executable_shadow_avg_return_pct,
    live_executable_shadow_win_rate,
    flags_json,
    CASE
      WHEN score < 68 THEN 'score<68'
      WHEN live_executable_shadow_simulated < 3 OR live_executable_shadow_simulated IS NULL THEN 'live_exec_sample<3'
      WHEN live_executable_shadow_pnl <= 0 OR live_executable_shadow_pnl IS NULL THEN 'live_exec_pnl<=0'
      WHEN live_executable_shadow_avg_return_pct <= 0.03 OR live_executable_shadow_avg_return_pct IS NULL THEN 'live_exec_return<=3%'
      WHEN live_executable_shadow_win_rate < 0.45 OR live_executable_shadow_win_rate IS NULL THEN 'live_exec_winrate<45%'
      WHEN source_sell_realized_ratio < 0.30 OR source_sell_realized_ratio IS NULL THEN 'source_sell_ratio<30%'
      ELSE 'passes_current_live_gate'
    END AS gate_bucket
  FROM latest
)
SELECT
  gate_bucket,
  COUNT(*) AS wallets,
  ROUND(AVG(score), 1) AS avg_score,
  ROUND(AVG(live_executable_shadow_pnl), 2) AS avg_live_exec_pnl,
  ROUND(AVG(live_executable_shadow_avg_return_pct)*100, 2) AS avg_live_exec_return_pct,
  ROUND(AVG(source_sell_realized_ratio)*100, 1) AS avg_source_sell_ratio_pct
FROM gated
GROUP BY gate_bucket
ORDER BY wallets DESC;

SELECT 'top_wallets_passing_current_live_gate' AS section;
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
  substr(wallet,1,10) || '...' AS wallet,
  ROUND(score,1) AS score,
  reliability,
  shadow_simulated,
  ROUND(shadow_pnl,2) AS shadow_pnl,
  live_executable_shadow_simulated AS live_n,
  ROUND(live_executable_shadow_pnl,2) AS live_pnl,
  ROUND(live_executable_shadow_avg_return_pct*100,2) AS live_ret_pct,
  ROUND(live_executable_shadow_win_rate*100,1) AS live_win_pct,
  ROUND(source_sell_realized_ratio*100,1) AS source_sell_pct,
  flags_json
FROM latest
WHERE score >= 68
  AND live_executable_shadow_simulated >= 3
  AND live_executable_shadow_pnl > 0
  AND live_executable_shadow_avg_return_pct > 0.03
  AND live_executable_shadow_win_rate >= 0.45
  AND source_sell_realized_ratio >= 0.30
ORDER BY live_executable_shadow_pnl DESC
LIMIT 20;
SELECT 'shadow_live_executable_profit_by_bucket' AS section;
WITH base AS (
  SELECT
    st.*,
    CASE
      WHEN live_executable_status='EXECUTABLE' AND live_executable_return_pct >= 0.08 THEN '>=8%'
      WHEN live_executable_status='EXECUTABLE' AND live_executable_return_pct >= 0.03 THEN '3-8%'
      WHEN live_executable_status='EXECUTABLE' AND live_executable_return_pct >= 0 THEN '0-3%'
      WHEN live_executable_status='EXECUTABLE' THEN '<0%'
      ELSE 'missed'
    END AS bucket
  FROM shadow_trades st
  WHERE created_at >= strftime('%s','now','-7 days')*1000
)
SELECT
  bucket,
  COUNT(*) AS trades,
  SUM(CASE WHEN live_executable_pnl > 0 THEN 1 ELSE 0 END) AS wins,
  SUM(CASE WHEN live_executable_pnl < 0 THEN 1 ELSE 0 END) AS losses,
  ROUND(SUM(COALESCE(live_executable_pnl,0)), 2) AS live_exec_pnl,
  ROUND(AVG(live_executable_return_pct)*100, 2) AS avg_live_return_pct
FROM base
GROUP BY bucket
ORDER BY CASE bucket WHEN '>=8%' THEN 1 WHEN '3-8%' THEN 2 WHEN '0-3%' THEN 3 WHEN '<0%' THEN 4 ELSE 5 END;

SELECT 'source_reject_diagnostics_24h' AS section;
SELECT
  datetime(created_at/1000, 'unixepoch') AS utc,
  json_extract(payload_json,'$.tradeCandidates') AS candidates,
  json_extract(payload_json,'$.emittedSignals') AS emitted,
  json_extract(payload_json,'$.topDropReasons[0].reason') AS top_drop,
  json_extract(payload_json,'$.topDropReasons[0].count') AS top_drop_count,
  json_extract(payload_json,'$.topSourceRejectReasons[0].reason') AS top_source_reject,
  json_extract(payload_json,'$.topSourceRejectReasons[0].count') AS top_source_reject_count
FROM agent_events
WHERE type='signal.diagnostics'
  AND created_at >= strftime('%s','now','-24 hours')*1000
ORDER BY created_at DESC
LIMIT 20;

SELECT 'risk_rejections_24h' AS section;
SELECT
  reason,
  COUNT(*) AS events,
  datetime(MAX(created_at)/1000, 'unixepoch') AS last_utc
FROM risk_events
WHERE created_at >= strftime('%s','now','-24 hours')*1000
  AND decision <> 'APPROVE'
GROUP BY reason
ORDER BY events DESC
LIMIT 20;
