# StratiFi Build Log

This file tracks the major features added while building StratiFi from the original Polymarket agent-system architecture notes.

## Recent Milestones

### Shadow Copy Backtesting

- Added `shadow_trades` persistence.
- Added `npm run shadow`.
- Added Telegram `/shadow`.
- Added shadow-copy simulation for source-wallet buys after a configurable detection delay.
- Added copy-entry penalty through `shadowCopyDelayMs` and `shadowMaxEntryPriceMovePct`.
- Added simulated exits/marks from:
  - source sell after detection
  - resolved market outcome
  - latest observed market tape
  - source-price fallback
- Added aggregate shadow PnL, win rate, average return, simulated count, and skipped count.
- Added tests for source exits, resolved exits, latest marks, broad market tape marks, fallback marks, and DB reporting.

### Source History And Market Backfill

- Added durable wallet trade history in SQLite.
- Added deterministic trade deduping.
- Added source score snapshots so wallet scores can be tracked over time.
- Added market snapshot backfill for market IDs found in wallet trade history.
- Added cached-first lookup, then Gamma API fallback for missing market metadata.
- Added resolved market fields: `resolved` and `winningOutcome`.
- Added resolved wallet stats: resolved markets, wins, losses, and win rate.

### Wallet Intelligence Upgrade

- Split wallet scoring into multiple components:
  - overall reputation
  - copyability score
  - category consistency
  - hot score
  - exit behavior
  - sample confidence
- Added market category inference:
  - politics
  - sports
  - crypto
  - macro
  - company
  - culture
  - other
- Added evidence caps so tiny perfect samples cannot rank as elite.
- Added Wilson lower-bound win-rate adjustment for small-sample skepticism.
- Updated scan output and Telegram wallet previews with category, hotness, and evidence fields.

### Three-Agent Architecture

- Added explicit StratiFi agents:
  - Signal Agent
  - Risk Mitigation Agent
  - Overseer Agent
- Added `PolymarketProvider` facade so agents do not call raw clients directly.
- Added `agent_events` ledger for auditability and dashboard/Telegram feeds.
- Added Conservative and Aggressive strategy profiles.
- Added public/private read model helpers to avoid exposing wallet addresses publicly.

### Paper Trading And Performance

- Added paper order simulation and position tracking.
- Added paper PnL reporting.
- Added `npm run performance`.
- Added Telegram `/performance`.
- Added minimum and maximum position sizing through `config/bot.json`.

### Telegram And Operations

- Added Telegram startup/status/scan/risk/wallet/performance commands.
- Added formatted alerts for approved signals, rejected signals, fills/exits, pauses, resumes, and errors.
- Confirmed public channels can use `@ChannelUsername` style chat IDs when the bot is an admin/member.

## Current Status

StratiFi is still paper trading only. There is no live order placement path enabled.

The current scanner can:

- discover active Polymarket CLOB markets
- collect recent market trades
- discover candidate source wallets
- persist wallet trade history
- backfill market snapshots for historical source trades
- score wallets with category and sample-confidence controls
- create wallet-alignment signals
- run risk checks through strategy profiles
- run shadow-copy backtests against source history
- simulate paper orders and exits
- report PnL and wallet intelligence through CLI and Telegram

## Next Planned Work

The next major feature should feed shadow-copy results back into wallet scoring:

- demote sources with poor shadow-copy PnL
- separate realized shadow exits from marked/unrealized shadow results
- track shadow performance by category
- expose public-safe shadow performance in the dashboard

After that, the next likely phase is splitting Telegram into:

- private admin bot commands
- public alert-only channel output
