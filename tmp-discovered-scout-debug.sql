.mode column
.headers on

SELECT 'latest_discovered_wallets' AS section;
SELECT
  substr(address,1,10) || '...' AS wallet,
  ROUND(score,1) AS score,
  ROUND(copyability_score,1) AS copyability,
  ROUND(category_consistency_score,1) AS category_score,
  ROUND(sample_confidence,2) AS sample_conf,
  trade_count,
  buy_count,
  sell_count,
  ROUND(1.0*sell_count/NULLIF(buy_count,0)*100,1) AS sell_buy_pct,
  ROUND(total_volume,1) AS volume,
  flags_json,
  datetime(updated_at/1000, 'unixepoch') AS updated_utc
FROM discovered_wallets
ORDER BY updated_at DESC, copyability_score DESC
LIMIT 80;

SELECT 'scout_filter_counts' AS section;
SELECT
  COUNT(*) AS discovered,
  SUM(CASE WHEN copyability_score >= 68 THEN 1 ELSE 0 END) AS copy_68,
  SUM(CASE WHEN copyability_score >= 70 THEN 1 ELSE 0 END) AS copy_70,
  SUM(CASE WHEN copyability_score >= 70 AND sample_confidence >= 0.55 THEN 1 ELSE 0 END) AS sample_ok,
  SUM(CASE WHEN copyability_score >= 70 AND sample_confidence >= 0.55 AND 1.0*sell_count/NULLIF(buy_count,0) >= 0.3 THEN 1 ELSE 0 END) AS sell_ok,
  SUM(CASE WHEN copyability_score >= 70 AND sample_confidence >= 0.55 AND 1.0*sell_count/NULLIF(buy_count,0) >= 0.3 AND flags_json NOT LIKE '%NO_SELL_HISTORY%' AND flags_json NOT LIKE '%NEGATIVE_REALIZED_APPROX%' THEN 1 ELSE 0 END) AS rough_ok
FROM discovered_wallets
WHERE updated_at >= strftime('%s','now','-30 minutes')*1000;
