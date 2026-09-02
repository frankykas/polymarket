# StratiFi Polymarket Strategy Lab

TypeScript research and paper-execution system for discovering and validating Polymarket strategies. Wallets are hypothesis leads, not trade instructions; only independently tested and prospectively validated strategy lanes may reach paper execution.

No live trading code path is enabled in this version.

## Setup

```bash
npm install
cp .env.example .env
npm run scan
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
npm run scan
```

Add wallets in `config/wallets.json` by setting `enabled` to `true` and replacing the placeholder address.

## Commands

```bash
npm run scan       # one-shot scan, no paper orders
npm run dev        # continuous paper bot loop
npm run dashboard  # local StratiFi web dashboard
npm run performance # local paper PnL report
npm run execution:forward # prospective maker/arbitrage/latency validation scorecards
npm run execution:cross-sensitivity # training/untouched-test replay of crypto latency arms
npm run weather:tournament # fixed-horizon forward-only weather strategy tournament
npm run macro:collect # append the current official CPI nowcast as a point-in-time vintage
npm run profitability:audit # authoritative cross-strategy profitability report
npm run export-ledger # export paper trades to data/paper-trade-ledger.csv
npm run cleanup:daily:dry # preview safe daily SQLite/generated-file cleanup
npm run cleanup:daily # prune bulky history while preserving current bot state
npm run test       # unit tests
npm run typecheck  # TypeScript checks
```

Run one `npm run dev` loop per SQLite database. Running multiple bot loops against the same `BOT_DB_PATH` can create SQLite write contention. The dashboard can run alongside the bot, but if you see `database is locked`, stop extra bot/dashboard processes and restart one clean bot loop.

Market scoring uses bounded concurrency (`signalMarketConcurrency`, default 6). Upstream history/forecast failures are cooled down for ten minutes so one unavailable research source cannot serialize or stall the rest of a scan.

Paper trades are persisted in SQLite and also exported to `data/paper-trade-ledger.csv` after paper entries/exits. Rebuild the CSV anytime with `npm run export-ledger`. Override the file path with `PAPER_TRADE_LEDGER_PATH`.

## Execution Research

The optional research-only execution lab can record Polymarket depth/trade events and BTC/ETH Binance reference ticks to immutable process gzip JSONL segments under `data/market-tape`. Its models include delayed-entry crypto reaction trades, post-latency binary-pair execution with one-leg risk, and inventory-aware maker quoting with queue position, quote skew, stale requotes, persisted inventory, and forced-hedge limits. Rewards and rebates are excluded from base P&L. These engines never place paper or live orders. It is disabled in the current production policy because its frozen forward maker and latency arms lost money and the large tape workload delayed the primary weather evidence loop; prior results remain immutable and reportable.

Scheduled CPI research blends the historical challenger with the Federal Reserve Bank of Cleveland's current nowcast. Every source observation is stored append-only in `macro_forecast_vintages`; missing historical vintages are never reconstructed. Consequently the nowcast model remains research-only until its own frozen forward selections resolve profitably and satisfy validation gates.

Install `pmarke-research.service` and `pmarke-research.timer` from `deploy/systemd` to collect CPI vintages and persist a bounded six-hour crypto-latency sensitivity report each day. Sensitivity reports are model-selection evidence only and cannot enter a promotion scorecard.

Candidates and results are insert-only in SQLite. `npm run execution:forward` reports every economically exposed outcome, including hedge misses, after the frozen policy start and blocks promotion until the configured sample, distinct-market, return, and win-rate gates all pass. This subsystem has no order-placement path.

The weather strategy tournament is also research-only. It freezes one append-only observation per validated station-day and preregistered arm at 24h, 12h, and 6h horizons. The incumbent NO policy is compared with expanded-NO and two-sided challengers using the executable $10 ask VWAP, fees, market-probability Brier benchmark, a 30-resolution screen, and a 100-resolution final decision. Tournament rows never enter paper-policy promotion evidence or place paper/live orders.

Upcoming weather ladders use a dedicated Gamma event search in addition to the global volume-ranked market scan. Complete events from already validated resolution stations are admitted first, followed by a bounded number of new-station events. This prevents newly listed, low-volume weather markets from being omitted before their fixed tournament horizons.

Weather paper entries freeze their execution policy into the signal. The current `weather-station-skill-v5-resolution-hold` epoch holds each accepted position until the market publishes a winning outcome, then settles it at 1 or 0. Interim book moves, generic stop losses, take profits, source exits, and maximum-hold timers cannot alter those positions. Earlier epochs remain queryable and are excluded from v5 promotion evidence.

## Daily Cleanup

For long-running VPS deployments, stop the bot before maintenance, preview the cleanup, then apply it:

```bash
systemctl stop pmarke-bot
cd /opt/pmarke
npm run cleanup:daily:dry
npm run cleanup:daily
systemctl start pmarke-bot
```

The cleanup preserves the economic ledger (paper orders, fills, source attribution, exits), immutable forward selections, execution results, and post-epoch wallet observations. It prunes replaceable telemetry and pre-epoch bulk history. Use `npm run cleanup:daily -- --keep-days 2 --keep-rows 5000` to keep more telemetry, and add `-- --vacuum` only when the VPS has enough free disk space for SQLite compaction.

See `FULL_APP_PROFITABILITY_AUDIT_2026-08-16.md` for the current evidence, agent audit, and restructuring decision. Historical or raw shadow profit is never sufficient for promotion.

Run `npm run launch:readiness` for the unified weather/CPI/crypto launch gate and its exact next milestone. The gate is strategy-agnostic, but it remains hard-blocked until one frozen strategy passes forward settlement and paper execution and an authenticated live-order adapter has received a separate security review. See `LIVE_LAUNCH_ROADMAP_2026-08-17.md` for the complete promotion and canary sequence.

On the VPS, install the daily automatic cleanup timer:

```bash
cp deploy/systemd/pmarke-cleanup.service /etc/systemd/system/pmarke-cleanup.service
cp deploy/systemd/pmarke-cleanup.timer /etc/systemd/system/pmarke-cleanup.timer
systemctl daemon-reload
systemctl enable --now pmarke-cleanup.timer
systemctl list-timers pmarke-cleanup.timer
```

The timer briefly stops the bot and dashboard, applies retention cleanup, then starts both services again.

## Dashboard

Run:

```bash
npm run dashboard
```

Then open `http://localhost:8787`.

Follower tracker:

```text
http://localhost:8787/tracker
```

Set `PUBLIC_TRACKER_NAME`, `PUBLIC_TRACKER_WALLET_ADDRESS`, and `PUBLIC_TRACKER_DISCLOSURE` in `.env` to customize the public tracker. The tracker is public-safe and shows paper balance, PnL, open/closed paper positions, recent signals, and the trade ledger without exposing source wallet addresses.

The dashboard reads from SQLite and exposes public-safe summaries: paper PnL, bankroll/equity, order health, Conservative/Aggressive profile rollups, source strength bands, recent signals, open and closed paper positions, public agent events, run logs, risk summaries, and shadow-copy performance by category. The viewing portal does not expose source wallet addresses.

Order Health tracks filled/open/expired orders, fill rate, average filled size, stale orders, and dust-fill protection. Paper orders below the configured minimum position size are rejected instead of creating tiny fills.

Rejected Signals shows the latest risk failures with concrete blockers such as spread, depth, liquidity, resolution window, exposure, and profile fit. Use it with Telegram `/risklog` when tuning `config/bot.json`.

The Admin Intelligence API is local-operator focused and includes exact wallet addresses, score drift, risk decision groups, and an agent handoff trace. Localhost access works without a token; set `ADMIN_DASHBOARD_TOKEN` before exposing admin data beyond localhost.

## Telegram

Set `TELEGRAM_BOT_TOKEN` in `.env`, run `npm run dev`, then send `/start` to your bot. The bot remembers the first chat that starts it as the private admin chat and shows an inline control menu.

For an explicit private/public split:

```text
TELEGRAM_ADMIN_CHAT_ID=123456789
TELEGRAM_PUBLIC_CHAT_ID=@YourPublicChannel
```

Admin commands and operational summaries stay in the admin chat. Approved paper BUY signals and paper exits are sent to `TELEGRAM_PUBLIC_CHAT_ID` when configured. `TELEGRAM_CHAT_ID` still works as the legacy single-chat fallback.

Commands:

```text
/start   menu and controls
/status  bot health and cycle stats
/scan    manual one-shot paper scan
/discover find profitable wallet candidates
/topwallets ranked wallet intelligence
/agents three-agent activity summary
/bankroll current paper bankroll, equity, deployed capital, and PnL
/pnl     alias for /bankroll
/ledger  paper trade PnL and running balance trail
/performance paper PnL report
/positions list open paper positions
/close <number-or-id> close one paper position
/closeall close every open paper position after confirmation
/risk    current risk limits
/risklog latest risk decisions and concrete rejection causes
/wallets tracked wallets
/pause   pause scheduled cycles
/resume  resume scheduled cycles
```

## Data Sources

- Gamma API for active market metadata.
- Data API for public wallet trade/activity attempts.
- CLOB REST for order books.
- CLOB WebSocket for market updates.

## Safety

This project is paper trading only. It does not read private keys, derive API credentials, place live orders, or cancel live orders.

## Position Sizing

Edit `config/bot.json`:

```json
{
  "bankroll": 200,
  "minPositionSize": 2,
  "maxPositionSize": 5,
  "maxOpenExposure": 25,
  "reserveCashPct": 0.2,
  "maxTimeToResolutionHours": 720,
  "maxDailyLoss": 10
}
```

- `minPositionSize`: smallest paper bet size in USDC.
- `maxPositionSize`: largest paper bet size in USDC.
- `maxOpenExposure`: maximum total open paper exposure.
- `reserveCashPct`: paper bankroll percentage protected from normal entries for future high-priority opportunities.
- `maxTimeToResolutionHours`: rejects far-dated markets that could lock capital too long. `maxPositionHoldHours` bounds actual lockup regardless, so this entry gate can stay generous.
- `minEntryPrice` / `maxEntryPrice`: outcome-price band for trade candidates. Extreme longshots are noise-dominated and extreme favorites have negative asymmetry, so prices outside the band watchlist but never trade.
- `stopLossAbs` / `takeProfitAbs`: absolute probability moves for exits (e.g. 0.06 / 0.10). These replace the relative-percentage stops that stopped cheap positions out on ordinary price noise. If unset, the bot falls back to `stopLossPct` / `takeProfitPct`.
- `sourceExitEnabled`: when true, the Overseer exits a position once a seeding source wallet sells the same outcome (the exit shadow-copy backtesting shows is profitable).
- `stopCooldownMs`: after a losing stop-out, how long before the same market/outcome can be re-entered. Prevents re-entry churn.
- `maxDailyLoss`: auto-pause/reject threshold for daily realized loss.
- `deepHistoryEnabled`, `deepHistoryWalletLimit`, `deepHistoryPages`, `deepHistoryPageSize`: pull paginated source-wallet history for configured wallets and top discovered candidates.
- `resolutionBackfillLimit`: caps how many historical market snapshots can be fetched/refreshed per scan for category and resolved-outcome scoring.

The Risk Mitigation Agent rejects markets too close to resolution and markets too far from resolution. This avoids both last-minute volatility and long-dated capital lockup, such as sports championship markets that may not resolve for months.
