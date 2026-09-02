# Independent audit brief

Date prepared: 2026-09-02
Audit branch: `stratifi-intelligence-agents`

## Audit objective

Determine whether this repository can become a reliable, profitable Polymarket trading system. Do not assume the current three-agent architecture, wallet-lead approach, weather focus, or any existing strategy should be preserved. Separate software correctness, research validity, demonstrated edge, and live executability.

## What the application is

PMarke began as a TypeScript wallet-copying paper bot and evolved into an evidence-driven strategy lab. The core runtime roles are:

1. Signal/Discovery: market and wallet discovery, feature collection, independent models, and candidate generation.
2. Validation/Risk: model-policy admission, market quality, liquidity/depth, exposure, correlation, and risk gates.
3. Execution/Overseer: executable paper entries, fills, position monitoring, exits, and settlement.

The supporting “agents” are deterministic TypeScript modules, not independent LLMs. Audit whether their overlapping scores create correlated or cosmetic consensus.

The application is paper-only. No authenticated live-order adapter has been completed or security-audited.

## Evidence hierarchy

Use evidence in this order:

1. Immutable prospective selections and completed forward outcomes.
2. Chronological walk-forward and untouched test periods.
3. Executable paper results with fees, slippage, latency, and depth.
4. Retrospective research only as hypothesis generation.

Do not use the historical raw shadow result of approximately +$18,000 as evidence of edge. It mixed backfilled selection with optimistic execution assumptions.

## Known results

Corrected wallet-copy replay:

- $5 size: -$124.41.
- $10 size: -$239.92.
- $15 size: -$354.60.
- Chronological top-ranked-wallet test: -$96.67 over 274 executable trades.
- Chronological all-wallet test: -$280.86 over 338 executable trades.

Weather v4 decomposition:

- Five resolved immutable selections valued at settlement: +$0.71 / +2.82%.
- Eight paper positions under generic early exits: -$3.91 / -10.15%.
- A London position stopped for -$1.48 would later have settled for approximately +$4.

The latest weather paper policy is `weather-station-skill-v5-resolution-hold`. It freezes `HOLD_TO_RESOLUTION` at entry. At the last verified production checkpoint it had six immutable selections, three paper positions, and no resolved v5 outcome.

Early prospective tournament results were positive but under-sampled. Several arms also had worse Brier scores than market-implied probabilities. Treat weather as a lead, not a validated edge.

Other frozen forward results included:

- Maker execution: -$135.93 / -10.9% over 130 economic outcomes.
- Crypto latency: -$159.90 / -55.0% over 28 outcomes.
- Negative-risk arbitrage: +$0.48 on one observation.
- Binary and threshold arbitrage: no qualifying observations.
- Crypto thresholds: failed the independent benchmark.
- CPI: Brier improvement 0.00458 against the frozen 0.005 requirement.

## Known operational gap

The previous VPS path and `pmarke-bot` service were absent when checked on 2026-09-02. The production database from the final v5 collection window is therefore not included in this repository. Local SQLite files, `.env`, generated market tape, build output, and credentials are intentionally excluded from Git.

Do not infer results after the last verified checkpoint.

## Required audit

1. Trace data from external API observation through feature, signal, selection, risk decision, order, fill, position, exit, settlement, and scorecard.
2. Identify leakage, survivorship bias, duplicated observations, bad joins, accounting errors, unrealistic execution, stale data, concurrency hazards, and restart/idempotency failures.
3. Produce a keep/rewrite/remove decision for every major agent and subsystem.
4. Decide whether the three-agent organization provides real separation of concerns.
5. Design a target architecture with immutable point-in-time data, deterministic replay, strategy plugins, unified shadow/paper/live execution, reconciliation, monitoring, and disaster recovery.
6. Rank plausible Polymarket strategy families without privileging weather.
7. Specify the three highest-value next experiments, including hypothesis, data, benchmark, entry, exit, sizing, walk-forward method, sample requirement, kill criteria, and promotion criteria.
8. Produce P0–P4 implementation priorities: correctness/security, infrastructure, research, paper validation, and live canary.

Every conclusion should cite exact files, functions, tables, tests, or supplied metrics. Clearly distinguish verified defects from recommendations.

## Repository reading order

1. `README.md`
2. `FULL_APP_PROFITABILITY_AUDIT_2026-08-16.md`
3. `STRATEGY_AUDIT_2026-08-09.md`
4. `PROFITABILITY_OPERATING_PLAN_2026-08-11.md`
5. `LIVE_LAUNCH_ROADMAP_2026-08-17.md`
6. `index.ts`, `src/types.ts`, `src/config.ts`, and `src/db.ts`
7. `src/agents/`, `src/research/`, and the forward scorecard modules
8. `tests/`
