.headers on
.mode column
SELECT datetime('now') AS utc_now;

WITH latest_books AS (
  SELECT obs.* FROM orderbook_snapshots obs
  JOIN (SELECT token_id, MAX(created_at) AS max_created_at FROM orderbook_snapshots GROUP BY token_id) latest
    ON latest.token_id=obs.token_id AND latest.max_created_at=obs.created_at
), open_exec AS (
  SELECT p.*, lb.best_bid, lb.best_ask, lb.tick_size, lb.created_at AS book_created_at,
         CASE WHEN lb.token_id IS NULL THEN p.current_price WHEN lb.best_bid IS NULL THEN 0 ELSE lb.best_bid END AS executable_exit_price,
         CASE WHEN lb.token_id IS NOT NULL AND lb.best_bid IS NULL THEN 1 ELSE 0 END AS no_bid
  FROM positions p LEFT JOIN latest_books lb ON lb.token_id=p.token_id
  WHERE p.status='OPEN'
), all_summary AS (
  SELECT COALESCE(SUM(realized_pnl),0) AS realized_pnl,
         SUM(CASE WHEN status='CLOSED' THEN 1 ELSE 0 END) AS closed_positions,
         SUM(CASE WHEN status='CLOSED' AND realized_pnl > 0 THEN 1 ELSE 0 END) AS wins,
         SUM(CASE WHEN status='CLOSED' AND realized_pnl <= 0 THEN 1 ELSE 0 END) AS losses
  FROM positions
), open_summary AS (
  SELECT COUNT(*) AS open_positions,
         ROUND(COALESCE(SUM(avg_entry_price*size),0),2) AS open_exposure,
         ROUND(COALESCE(SUM(size*(executable_exit_price-avg_entry_price)),0),2) AS executable_unrealized,
         SUM(no_bid) AS no_bid_positions
  FROM open_exec
)
SELECT a.closed_positions, a.wins, a.losses, ROUND(1.0*a.wins/NULLIF(a.wins+a.losses,0),3) AS win_rate,
       ROUND(a.realized_pnl,2) AS realized_pnl,
       o.open_positions, o.open_exposure, o.executable_unrealized,
       ROUND(a.realized_pnl + o.executable_unrealized,2) AS executable_total_pnl,
       o.no_bid_positions
FROM all_summary a CROSS JOIN open_summary o;

WITH latest_books AS (
  SELECT obs.* FROM orderbook_snapshots obs
  JOIN (SELECT token_id, MAX(created_at) AS max_created_at FROM orderbook_snapshots GROUP BY token_id) latest
    ON latest.token_id=obs.token_id AND latest.max_created_at=obs.created_at
)
SELECT datetime(p.updated_at/1000,'unixepoch') AS updated_utc, p.profile, p.outcome, substr(p.market_id,1,12) AS market,
       ROUND(p.avg_entry_price,3) AS entry, ROUND(p.current_price,3) AS mark,
       ROUND(lb.best_bid,3) AS bid, ROUND(lb.best_ask,3) AS ask, ROUND(lb.tick_size,4) AS tick,
       ROUND(p.size,2) AS shares, ROUND(p.avg_entry_price*p.size,2) AS cost,
       ROUND(p.size*((CASE WHEN lb.token_id IS NULL THEN p.current_price WHEN lb.best_bid IS NULL THEN 0 ELSE lb.best_bid END)-p.avg_entry_price),2) AS executable_pnl,
       CASE WHEN lb.token_id IS NULL THEN 'NO_BOOK' WHEN lb.best_bid IS NULL THEN 'NO_BID' ELSE 'BID_OK' END AS state,
       datetime(lb.created_at/1000,'unixepoch') AS book_utc
FROM positions p LEFT JOIN latest_books lb ON lb.token_id=p.token_id
WHERE p.status='OPEN'
ORDER BY executable_pnl ASC;

SELECT datetime(updated_at/1000,'unixepoch') AS closed_utc, profile, outcome, substr(market_id,1,12) AS market,
       ROUND(avg_entry_price,3) AS entry, ROUND(current_price,3) AS exit_price,
       ROUND(size,2) AS shares, ROUND(realized_pnl,2) AS pnl
FROM positions
WHERE status='CLOSED'
ORDER BY updated_at DESC
LIMIT 20;

SELECT datetime(timestamp/1000,'unixepoch') AS fill_utc, side, ROUND(price,3) AS price, ROUND(size,2) AS shares,
       ROUND(price*size,2) AS notional, substr(market_id,1,12) AS market, substr(order_id,1,16) AS order_id
FROM paper_fills
ORDER BY timestamp DESC
LIMIT 25;

SELECT side, status, execution_policy, COALESCE(missed_reason,'') AS missed_reason,
       COUNT(*) AS n, ROUND(SUM(price*size),2) AS notional, MAX(datetime(created_at/1000,'unixepoch')) AS latest_utc
FROM paper_orders
WHERE created_at >= CAST((strftime('%s','now') - 86400) * 1000 AS INTEGER)
GROUP BY side, status, execution_policy, COALESCE(missed_reason,'')
ORDER BY side, status, n DESC;

SELECT datetime(created_at/1000,'unixepoch') AS utc,
       json_extract(payload_json,'$.tradeCandidates') AS candidates,
       json_extract(payload_json,'$.emittedSignals') AS emitted,
       json_extract(payload_json,'$.topDropReasons[0].reason') AS drop1,
       json_extract(payload_json,'$.topDropReasons[0].count') AS drop1_n,
       json_extract(payload_json,'$.topSourceRejectReasons[0].reason') AS src1,
       json_extract(payload_json,'$.topSourceRejectReasons[0].count') AS src1_n,
       json_extract(payload_json,'$.topSourceRejectReasons[1].reason') AS src2,
       json_extract(payload_json,'$.topSourceRejectReasons[1].count') AS src2_n
FROM bot_run_logs
WHERE message='signal diagnostics'
ORDER BY created_at DESC
LIMIT 8;

SELECT reason, COUNT(*) AS n, MAX(datetime(created_at/1000,'unixepoch')) AS last_utc
FROM risk_events
WHERE decision='REJECT' AND created_at >= CAST((strftime('%s','now') - 86400) * 1000 AS INTEGER)
GROUP BY reason ORDER BY n DESC LIMIT 12;

SELECT datetime(created_at/1000,'unixepoch') AS utc, type, message,
       ROUND(json_extract(payload_json,'$.executableTotalPnl'),2) AS executable_pnl,
       ROUND(json_extract(payload_json,'$.realizedPnl'),2) AS realized_pnl,
       ROUND(json_extract(payload_json,'$.executableUnrealizedPnl'),2) AS exec_unrealized,
       json_extract(payload_json,'$.filledOrders') AS filled,
       json_extract(payload_json,'$.buyFills') AS buys,
       json_extract(payload_json,'$.sellFills') AS sells,
       json_extract(payload_json,'$.exitMisses') AS exit_misses,
       json_extract(payload_json,'$.sourceSellDetections') AS source_sells,
       json_extract(payload_json,'$.takeProfitExitFills') AS tp_fills,
       json_extract(payload_json,'$.noBidOpenPositions') AS no_bid
FROM agent_events WHERE type='parity.scorecard'
ORDER BY created_at DESC LIMIT 8;
