# PMarke live-launch roadmap

Status: paper-only. No private key is read and no authenticated order is posted.

## Launch principle

The bot does not go live because it found many candidates or because a retrospective simulation is profitable. A single frozen strategy must pass independent validation, immutable forward settlement, and strategy-attributed paper execution. Only then is an authenticated live adapter implemented and reviewed.

## Current shortest path

Weather is the lead lane because it can produce independent daily exposures and its forecast-skill validation passed. The previous `weather-no-midprice-v1` forward window remains immutable historical evidence. It exposed two control weaknesses: aggregate station skill could admit an unvalidated station, and the runtime could trade a second market for an already-selected station/date.

The replacement `weather-station-skill-v4` policy starts at `1787023946396` and changes neither the price, edge, outcome, EV, uncertainty, nor resolution-time gates. It adds:

- independent skill validation for each admitted resolution station;
- station-specific bias and MAE calibration;
- validation of the 12 most represented stations instead of an arbitrary first five;
- bounded validation requests and a two-complete-day lag to maximize honest forecast/actual overlap without using incomplete observations;
- a station gate based on the 95% upper confidence bound of MAE (at least 12 observations and upper bound no greater than 3°C), replacing an arbitrary raw sample cutoff;
- one durable station/date selection and at most one paper entry per independent exposure.

Maker `v4.3` and cross-market latency `v2.1` are frozen because their prospective results were negative. Their immutable rows remain queryable, but new observations are disabled. Binary, threshold-ladder, and complete negative-risk arbitrage continue as no-trade research because they have not produced a valid current-policy sample.

## Gates to a live canary

1. Independent validation: the exact policy must pass its preregistered walk-forward or forecast-skill test.
2. Research-forward evidence: at least 30 resolved immutable selections, settlement return of at least 5%, and model Brier score no worse than the market.
3. Paper execution: at least 30 closed positions attributed to the same policy and paper return of at least 5% after executable prices and fees.
4. Portfolio control: current-epoch aggregate paper P&L must be positive.
5. Engineering: implement and audit the official authenticated Polymarket order adapter, secret handling, order reconciliation, cancel-all kill switch, and restart recovery.
6. Operator preflight: configure a separate minimally funded wallet, leave credentials outside source control, verify geography/account eligibility, and explicitly disable paper mode.
7. Canary: one $5 FOK entry at a time. Do not increase size until live fills, slippage, exits, and P&L remain within the paper-parity envelope.

No execution-research simulator can satisfy gates 1–4 until it has a separately reviewed paper-order path. This prevents a profitable shadow accounting result from becoming trading permission.

## Operational commands

- `npm run launch:readiness` prints the selected lane, every blocker, and the next measurable milestone.
- `npm run weather:forward` prints weather settlement and paper-execution evidence.
- `npm run strategies:forward` prints CPI and crypto evidence.
- `npm run profitability:audit` prints all strategy and frozen execution-policy results.
- `npm run scorecard:daily` persists one append-only daily control-plane snapshot per policy fingerprint.

The six-hour research timer collects CPI vintages, runs the bounded crypto-latency sensitivity report, and emits launch readiness. The daily retention job freezes the daily scorecard before cleanup and cannot delete immutable selections, economic execution outcomes, orders, fills, or positions.
