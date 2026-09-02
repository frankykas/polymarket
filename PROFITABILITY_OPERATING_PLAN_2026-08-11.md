# Profitability operating plan — 2026-08-11

## Decision

The system does not yet have a proven profitable entry strategy. The profitable component in the current paper sample is the Overseer's exit behavior; the weather probability model and wallet-copy lane are not independently profitable. The correct objective is therefore prospective strategy validation, not increasing trade count by weakening gates.

## Three-agent operating lane

1. **Signal Agent — discover, measure, rank.** Wallets are research leads and independent strategies are candidate generators. The Signal Agent scans all supported categories, but it sends only fresh, globally ranked, non-duplicate candidates to Risk. Wallet history is never interpreted as a current order.
2. **Risk Mitigation Agent — validate execution and allocate experimental capital.** It checks market quality, book freshness/depth, exposure and portfolio duplication. Uncalibrated independent models receive a flat paper stake; Kelly sizing is forbidden until forward calibration is demonstrated.
3. **Overseer Agent — manage exits and keep the financial truth.** It retains the current executable stop/take-profit supervision because the audit showed materially better results than passively holding the same entries.

Supporting research, wallet-intelligence, market-intelligence, microstructure, and council modules are inputs to these three responsibilities. They do not independently authorize orders.

## Frozen prospective weather experiment

Policy ID: `weather-no-midprice-v1`

- Starts at `2026-08-11T21:09:37.892Z`; earlier and backfilled rows are excluded.
- Outcome: `NO` only.
- Executable ask: 0.40–0.70 inclusive.
- Claimed probability edge: 0.15–0.50 inclusive. Extreme model disagreement is treated as probable model error, not stronger conviction.
- Existing forecast-skill, station match, uncertainty, expected-value, time-to-resolution and microstructure checks remain mandatory.
- One selected exposure per weather station/city and target date.
- Global ranking occurs before capital allocation.
- Flat paper stake: $5. No Kelly sizing.
- No re-entry in the same market/outcome for 24 hours.
- Portfolio collection cap: 10 trades and $50 gross open exposure; the former $5 daily stop no longer prevents paper evidence collection.

This policy was selected from the only tentatively positive in-sample slice, but that slice is data-mined. It is an experiment, not a profitable-strategy claim.

## Promotion gate

`npm run weather:forward` reports only portfolio-selected rows under the exact frozen policy. Promotion requires all of the following:

- at least 30 resolved selections;
- at least 30 closed executable paper positions;
- settlement return of at least 5%;
- actual Overseer-managed paper return of at least 5%;
- model Brier score no worse than the contemporaneous market probability.

Changing the policy requires a new policy ID and a new forward start. It may not inherit results from this experiment.

## Source-wallet lane

- Continue diversified leaderboard and market-tape discovery across non-blocked categories.
- Poll recently audited sources on hot scans, independent of the six-hour full research/backtest refresh.
- Use wallet behavior to propose strategy hypotheses and identify markets; do not copy wallet bet amounts.
- No wallet source may place a paper entry until deduplicated, forward, live-executable shadow results pass the existing profitability, win-rate, source-exit and sample gates.
- Sports remains blocked because the corrected forward wallet-copy sample was negative; it should be reopened only by new category-specific evidence.

## Scan architecture

- Hot scan: every two minutes, reuse recent audited source scores, poll those sources, and inspect only markets touched by fresh source activity plus independent-strategy markets.
- Full refresh: every six hours, run broad discovery, deep history, resolution backfill, shadow recomputation, and source rescoring.
- Watchlist observations are stored by Signal but do not run through the council and Risk stack.
- Full-cycle source trade diagnostics are market-scoped instead of counting the same global tape once per market.

## Next strategy research priority

Do not loosen the frozen weather policy merely to manufacture trades. Add independently testable strategy modules in this order:

1. scheduled macro-release markets, where official timestamps and observations permit clean walk-forward tests;
2. crypto threshold markets, using exchange candles and exact resolution rules;
3. news/politics only when point-in-time source timestamps can be stored without look-ahead;
4. sports only after category-specific forward evidence reverses the current negative result.

Each module must implement its own frozen policy, event-level diversification, executable price capture, forward scorecard, and promotion gate before it can consume paper capital.
