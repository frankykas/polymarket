# StratiFi Architecture

StratiFi is organized around three agents and one shared event ledger. V1 remains paper trading only.

## Agents

### Signal Agent

Owns market discovery, source-wallet discovery, source scoring, and signal creation.

It can:
- scan active Polymarket CLOB markets
- collect recent market trades for wallet discovery
- score configured and discovered wallets
- create `TRADE_CANDIDATE`, `WATCHLIST`, or `NO_TRADE` signals
- write `source.discovered`, `source.scored`, and `signal.created` events

It cannot size positions, approve trades, execute entries, or manage exits.

### Risk Mitigation Agent

Owns final validation, strategy profile selection, position sizing, and approval/rejection.

It can:
- classify signals as `SAFE`, `WARNING`, or `HIGH_RISK`
- evaluate Conservative and Aggressive profiles separately
- approve, reject, resize, pause, or shadow-reject a signal
- write `risk.decision_created` events

It cannot discover wallets or create trade signals.

### Overseer Agent

Owns open position monitoring and exits.

It can:
- review open positions against current order books
- trigger hold, partial exit, or full exit decisions
- update paper PnL
- write `trade.updated` and `trade.closed` events

It cannot create new entries.

## Provider Boundary

Agents use a `PolymarketProvider` facade instead of calling raw clients directly. This keeps Gamma, Data API, and CLOB API quirks outside the agent layer.

Current provider methods:
- active markets
- market trades
- wallet trades
- wallet positions
- order books

## Strategy Profiles

Profiles live in `src/profiles/profiles.ts`.

Conservative:
- minimum confidence: 85 or higher
- accepts only `SAFE` risk state
- smaller per-position and exposure caps

Aggressive:
- minimum confidence: 70 or higher
- accepts `SAFE` and controlled `WARNING`
- larger caps than Conservative

## Public vs Private Data

Private data includes source wallet addresses, raw payloads, admin actions, and exact scoring internals.

Public-safe data includes source strength bands, confidence, market/outcome, trade status, PnL totals, and non-identifying event feed items.

Read model helpers live in:
- `src/public/readModels.ts`
- `src/admin/readModels.ts`

## Event Ledger

Every important handoff should become an event in `agent_events`.

Current event types include:
- `market.discovery_completed`
- `source.discovered`
- `source.scored`
- `signal.created`
- `risk.decision_created`
- `trade.updated`
- `trade.closed`

This gives us the foundation for the transparency dashboard, Telegram summaries, audit review, and future backtesting comparisons.

## Next Build Phases

1. Expand wallet scoring into category-specific source profiles.
2. Add historical backfill and resolved-market outcome attribution.
3. Split Telegram into private admin commands and public alert-only mode.
4. Add shadow trades for rejected-but-interesting signals.
5. Build the dashboard against public read models and event feeds.
6. Add live-trading interfaces only after paper trading has enough forward performance data.
