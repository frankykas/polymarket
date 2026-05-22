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
npm run test       # unit tests
npm run typecheck  # TypeScript checks
```

## Telegram

Set `TELEGRAM_BOT_TOKEN` in `.env`, run `npm run dev`, then send `/start` to your bot. The bot remembers the first chat that starts it and shows an inline control menu.

Commands:

```text
/start   menu and controls
/status  bot health and cycle stats
/scan    manual one-shot paper scan
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
