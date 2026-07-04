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
- Fed per-wallet shadow-copy performance back into source scores.
- Added per-category shadow-copy summaries and category-matched signal confidence adjustments.
- Added score flags for weak shadow samples, fallback-heavy shadow evidence, and shadow under/outperformance.
- Added tests for source exits, resolved exits, latest marks, broad market tape marks, fallback marks, and DB reporting.

### Source History And Market Backfill

- Added durable wallet trade history in SQLite.
- Added deterministic trade deduping.
- Added source score snapshots so wallet scores can be tracked over time.
- Added market snapshot backfill for market IDs found in wallet trade history.
- Added cached-first lookup, then Gamma API fallback for missing market metadata.
- Added configurable paginated source-history pulls for configured wallets and top discovered candidates.
- Added refreshes for cached historical markets that look ended or closed but are missing resolved-outcome data.
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
- Added paper bankroll/equity tracking for available cash, deployed cost, open value, realized PnL, and total paper equity.
- Fixed full-book paper fill simulation so best-bid/ask WebSocket snapshots without depth do not block fills.
- Added dust-order protection so remaining exposure below `minPositionSize` is rejected instead of creating microscopic fills.
- Added Order Health metrics for filled/open/expired orders, fill rate, stale open orders, dust fills, and average filled notional.
- Added a conservative paper-copy feedback hook so source scoring can be nudged by actual marked paper-copy performance.
- Improved paper-copy feedback attribution so multi-source signals split credit and confidence weights the score nudge.
- Added capital-lockup protection with `maxTimeToResolutionHours` so far-dated markets are rejected before they trap paper capital.
- Added `reserveCashPct` so normal entries cannot consume the whole bankroll and block future high-priority signals.

### Telegram And Operations

- Added Telegram startup/status/scan/risk/wallet/performance commands.
- Added formatted alerts for approved signals, rejected signals, fills/exits, pauses, resumes, and errors.
- Reduced Telegram noise by grouping rejected trade candidates into one compact summary while keeping approved buys as individual alerts.
- Confirmed public channels can use `@ChannelUsername` style chat IDs when the bot is an admin/member.
- Split Telegram routing into private admin command/control chat and optional public alert-only channel output.
- Added `TELEGRAM_ADMIN_CHAT_ID` and `TELEGRAM_PUBLIC_CHAT_ID` while keeping `TELEGRAM_CHAT_ID` as the legacy single-chat fallback.
- Added Telegram `/bankroll` and `/pnl` for paper equity, cash, deployed capital, and PnL.
- Added Telegram `/agents` for the three-agent activity summary.
- Added occasional admin bankroll summaries during live paper operation.

### Dashboard And Read Models

- Added `npm run dashboard`.
- Added a local web dashboard at `http://localhost:8787`.
- Added `/api/dashboard` and `/api/health`.
- Added `/api/admin/dashboard`.
- Added a dashboard read model that composes public-safe performance, shadow, wallet, signal, event, position, and log summaries.
- Added an admin read model with exact source wallets, wallet score table, source score drift, risk decision groups, and agent handoff trace.
- Added SQLite read methods for source score summaries, recent signals, recent logs, and shadow performance by category.
- Fixed public signal serialization so aligned wallet addresses are removed at runtime, not only hidden by TypeScript types.
- Added a dashboard privacy test to make sure source wallet addresses do not leak into public dashboard JSON.
- Upgraded the dashboard UI with StratiFi branding, agent lanes, Overview/Admin Intelligence tabs, score drift chart, and richer operating tables.
- Reworked the local dashboard into the StratiFi Viewing Portal layout from the MD dashboard spec.
- Kept the viewing portal read-only and wired it only to the public-safe `/api/dashboard` model.
- Removed public exposure of source-pool counts and provider names; the portal now shows abstracted source quality and data-feed health.
- Added public-safe risk summaries, enriched signal/position market titles, and closed paper positions for the portal tables.
- Added profile attribution to risk events, paper orders, and positions.
- Added per-profile paper performance rollups for Conservative and Aggressive dashboard comparison.
- Added Order Health to the viewing portal.
- Added dark-mode dashboard styling with blue accents.
- Added a localhost/token guard for the admin dashboard endpoint.
- Fixed the remaining Telegram shadow-report mojibake string.

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
- run shadow-copy backtests against source history and market categories
- nudge source scores from real paper-copy performance
- serve a public-safe local dashboard from SQLite read models
- simulate paper orders and exits
- report PnL and wallet intelligence through CLI and Telegram

## Next Planned Work

The next likely phase is using the deeper stored history for richer per-category trend charts, stronger realized paper attribution, and broader resolved-market reconciliation as provider coverage allows.
