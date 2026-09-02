.mode column
.headers on

SELECT 'latest_scores_near_probation' AS section;
SELECT
  substr(wallet,1,10) || '...' AS wallet,
  label,
  ROUND(score,1) AS score,
  ROUND(copyability_score,1) AS copyability,
  ROUND(sample_confidence,2) AS sample_conf,
  recent_trade_count,
  ROUND(source_sell_realized_ratio*100,1) AS source_sell_pct,
  live_executable_shadow_simulated AS live_n,
  ROUND(live_executable_shadow_pnl,2) AS live_pnl,
  ROUND(live_executable_shadow_avg_return_pct*100,2) AS live_ret_pct,
  flags_json,
  datetime(updated_at/1000, 'unixepoch') AS updated_utc
FROM wallet_scores
WHERE score >= 68
ORDER BY updated_at DESC, score DESC
LIMIT 80;

SELECT 'latest_score_gate_counts' AS section;
SELECT
  COUNT(*) AS score_68,
  SUM(CASE WHEN score >= 72 THEN 1 ELSE 0 END) AS score_72,
  SUM(CASE WHEN score >= 72 AND COALESCE(copyability_score, score) >= 70 THEN 1 ELSE 0 END) AS copy_70,
  SUM(CASE WHEN score >= 72 AND COALESCE(copyability_score, score) >= 70 AND COALESCE(sample_confidence,0) >= 0.55 THEN 1 ELSE 0 END) AS sample_55,
  SUM(CASE WHEN score >= 72 AND COALESCE(copyability_score, score) >= 70 AND COALESCE(sample_confidence,0) >= 0.55 AND COALESCE(recent_trade_count,0) >= 1 THEN 1 ELSE 0 END) AS recent_ok,
  SUM(CASE WHEN score >= 72 AND COALESCE(copyability_score, score) >= 70 AND COALESCE(sample_confidence,0) >= 0.55 AND COALESCE(recent_trade_count,0) >= 1 AND (source_sell_realized_ratio IS NULL OR source_sell_realized_ratio >= 0.3) THEN 1 ELSE 0 END) AS ratio_ok
FROM wallet_scores
WHERE score >= 68;

SELECT 'recent_source_reject_events' AS section;
SELECT
  datetime(created_at/1000, 'unixepoch') AS utc,
  json_extract(payload_json,'$.topSourceRejectReasons') AS source_rejects
FROM agent_events
WHERE type='signal.diagnostics'
ORDER BY created_at DESC
LIMIT 5;
