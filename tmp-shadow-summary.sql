select count(*) as rows,
 round(sum(pnl),2) as raw_pnl,
 round(sum(case when status='SIMULATED' then pnl else 0 end),2) as simulated_pnl,
 round(sum(live_executable_pnl),2) as live_exec_pnl,
 sum(case when live_executable_status='EXECUTABLE' then 1 else 0 end) as exec_rows,
 min(source_timestamp) as first_ts,max(source_timestamp) as last_ts
from shadow_trades;
select category,count(*) rows,round(sum(pnl),2) raw_pnl,round(sum(live_executable_pnl),2) exec_pnl
from shadow_trades group by category order by raw_pnl desc;
select status,count(*) n,round(sum(pnl),2) pnl from shadow_trades group by status;
