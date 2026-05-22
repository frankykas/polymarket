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
- `source.backfill_completed`
- `source.scored`
- `signal.created`
- `risk.decision_created`
- `trade.updated`
- `trade.closed`

## Source History

StratiFi stores normalized wallet trades in `wallet_trades` and writes every score update to `source_score_snapshots`.

This means source intelligence is no longer limited to one scan response. When the Signal Agent sees a wallet again, it can score from stored history plus fresh trades. Duplicate trades are ignored with a deterministic trade key.

Market snapshots also carry optional resolution fields:
- `resolved`
- `winningOutcome`

When resolution data is available, wallet scoring records resolved wins, resolved losses, resolved markets, and resolved win rate. Public-facing views should show only aggregate source strength and resolved-performance summaries, not the wallet address.

The Signal Agent also backfills market snapshots for market IDs found in stored source history. It uses cached snapshots first, then asks Gamma for missing markets. This gives configured-wallet scoring category and resolution context beyond the active market scan.

## Shadow Copy Backtesting

Shadow-copy backtesting is separate from paper trading. It does not open paper positions and it never places live orders.

The Signal Agent simulates whether StratiFi could have copied source-wallet buys after a configured detection delay. Results are stored in `shadow_trades` and summarized through `npm run shadow` and Telegram `/shadow`.

Shadow entry:
- starts from the source buy price
- adds a delay/copy penalty
- uses `shadowPositionSize` as the simulated stake

Shadow exit/mark priority:
- later source sell after detection
- resolved market outcome when known
- latest observed market-tape price after detection
- source-price fallback when no later mark exists

The goal is to compare raw wallet quality against realistic copy performance. A wallet that looks profitable but performs poorly in shadow-copy should eventually be demoted by the scoring engine.

Shadow-copy performance now feeds back into Signal Agent source scoring. The score impact is capped, realized source/resolution exits are weighted more heavily than marks, and fallback-heavy samples are flagged as weaker evidence.

This gives us the foundation for the transparency dashboard, Telegram summaries, audit review, and future backtesting comparisons.

## Next Build Phases

1. Pull deeper paginated source history for top candidates.
2. Add resolved-market lookup/backfill for older markets not present in active scans.
3. Split Telegram into private admin commands and public alert-only mode.
4. Track shadow-copy performance by category.
5. Build the dashboard against public read models and event feeds.
6. Add live-trading interfaces only after paper trading has enough forward performance data.
