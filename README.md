# Polymarket Wallet-Following Paper Bot

TypeScript MVP for a Polymarket wallet-following paper bot. It tracks configured wallets, scans public Polymarket data, applies market-quality and risk rules, simulates limit-order fills, logs to SQLite, and can optionally send Telegram alerts.

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
npm run export-ledger # export paper trades to data/paper-trade-ledger.csv
npm run test       # unit tests
npm run typecheck  # TypeScript checks
```

Run one `npm run dev` loop per SQLite database. Running multiple bot loops against the same `BOT_DB_PATH` can create SQLite write contention. The dashboard can run alongside the bot, but if you see `database is locked`, stop extra bot/dashboard processes and restart one clean bot loop.

Paper trades are persisted in SQLite and also exported to `data/paper-trade-ledger.csv` after paper entries/exits. Rebuild the CSV anytime with `npm run export-ledger`. Override the file path with `PAPER_TRADE_LEDGER_PATH`.

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
- `maxTimeToResolutionHours`: rejects far-dated markets that could lock capital too long.
- `maxDailyLoss`: auto-pause/reject threshold for daily realized loss.
- `deepHistoryEnabled`, `deepHistoryWalletLimit`, `deepHistoryPages`, `deepHistoryPageSize`: pull paginated source-wallet history for configured wallets and top discovered candidates.
- `resolutionBackfillLimit`: caps how many historical market snapshots can be fetched/refreshed per scan for category and resolved-outcome scoring.

The Risk Mitigation Agent rejects markets too close to resolution and markets too far from resolution. This avoids both last-minute volatility and long-dated capital lockup, such as sports championship markets that may not resolve for months.
