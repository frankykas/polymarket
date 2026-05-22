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
npm run test       # unit tests
npm run typecheck  # TypeScript checks
```

## Dashboard

Run:

```bash
npm run dashboard
```

Then open `http://localhost:8787`.

The dashboard reads from SQLite and exposes public-safe summaries: paper PnL, source strength bands, recent signals, open paper positions, public agent events, run logs, and shadow-copy performance by category. It does not expose source wallet addresses.

## Telegram

Set `TELEGRAM_BOT_TOKEN` in `.env`, run `npm run dev`, then send `/start` to your bot. The bot remembers the first chat that starts it and shows an inline control menu.

Commands:

```text
/start   menu and controls
/status  bot health and cycle stats
/scan    manual one-shot paper scan
/discover find profitable wallet candidates
/topwallets ranked wallet intelligence
/performance paper PnL report
/risk    current risk limits
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
  "maxDailyLoss": 10
}
```

- `minPositionSize`: smallest paper bet size in USDC.
- `maxPositionSize`: largest paper bet size in USDC.
- `maxOpenExposure`: maximum total open paper exposure.
- `maxDailyLoss`: auto-pause/reject threshold for daily realized loss.
