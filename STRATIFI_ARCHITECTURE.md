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
- reject far-dated markets that create capital-lockup risk
- protect reserve cash for future high-priority opportunities
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

In dev mode the Overseer also runs on its own cadence between full market scans. It refreshes order books for open positions, updates marks, evaluates exits, and writes public review summaries.

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

The local dashboard builds from `src/dashboard/readModel.ts` and serves through `src/dashboard/server.ts`.

Dashboard endpoints:
- `/api/dashboard` is public-safe: source wallet addresses and raw private payload fields are scrubbed before display.
- `/api/admin/dashboard` is local-operator focused: exact source wallets, score history, risk summaries, and agent handoff trace are available for debugging and tuning.

## Event Ledger

Every important handoff should become an event in `agent_events`.

Current event types include:
- `market.discovery_completed`
- `agent.cycle_completed`
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

For configured wallets and the strongest discovered candidates, the Signal Agent can also pull paginated wallet-trade history. This is controlled by `deepHistoryEnabled`, `deepHistoryWalletLimit`, `deepHistoryPages`, and `deepHistoryPageSize`. The deeper history is deduped into SQLite and then used for scoring, shadow-copy backtests, and market-resolution backfill.

Historical market backfill now also refreshes cached markets that appear ended or closed but lack resolved-outcome data. `resolutionBackfillLimit` caps the amount of provider lookups per scan.

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

Shadow trades also store inferred market category. The Signal Agent summarizes shadow-copy performance by wallet and category, then uses matching category impact as a small confidence adjustment when creating signals. This keeps a wallet's crypto edge from automatically inflating sports or politics signals.

This gives us the foundation for the transparency dashboard, Telegram summaries, audit review, and future backtesting comparisons.

## Paper Copy Feedback

Paper-copy performance is separate from shadow-copy backtesting. When paper fills exist, StratiFi joins the paper fill back to the source-aligned signal and marks that fill against the current paper position price. This produces a small capped source-score adjustment.

The adjustment is intentionally conservative:
- small samples are flagged as `PAPER_LOW_SAMPLE`
- strong underperformance is flagged as `PAPER_COPY_UNDERPERFORMS`
- strong outperformance is flagged as `PAPER_COPY_OUTPERFORMS`
- paper feedback nudges scores, but does not overpower source history or shadow-copy evidence
- multi-source signals split attribution across aligned sources
- signal confidence weights the attribution so stronger paper signals count slightly more

This is the first step toward letting the agents demote wallets that look good historically but perform poorly when copied by StratiFi's actual paper execution.

## Order Health

Paper execution quality is tracked separately from PnL. The dashboard read model reports filled, open, expired, partial, and cancelled orders, fill rate, stale open orders, average filled notional, recent fills, and dust fills.

Dust protection rejects new trades when remaining exposure is below `minPositionSize`, so paper stats are not polluted by microscopic fills near the exposure cap.

## Capital Lockup

The Risk Mitigation Agent protects against two forms of bad timing:

- markets too close to resolution, where volatility and spread can spike
- markets too far from resolution, where capital can be trapped for weeks or months

`maxTimeToResolutionHours` rejects long-dated markets by default. `reserveCashPct` protects part of bankroll from normal entries, leaving cash available for stronger future source-wallet signals.

## Next Build Phases

1. Add deeper dashboard charts for category shadow-copy drift, order health trends, and per-agent throughput.
2. Strengthen realized paper attribution as more closed paper positions accumulate.
3. Broaden resolved-market reconciliation for provider payloads that omit winners.
4. Add live-trading interfaces only after paper trading has enough forward performance data.
