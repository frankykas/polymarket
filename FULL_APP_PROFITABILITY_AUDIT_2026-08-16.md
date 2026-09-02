# PMarke full application and profitability audit

Data cut: 2026-08-16 03:25 UTC
Production: `/opt/pmarke` on `edgesniffer`
Verdict: no strategy currently has a validated profitable edge.

## Executive decision

The application should no longer be described or operated as a three-AI-agent trading bot. It is now an evidence-driven Polymarket strategy laboratory with a paper-execution harness. The three core runtime roles remain useful, but they do not create edge:

1. Discovery/Signal proposes hypotheses and candidates.
2. Validation/Risk decides whether evidence and execution are sufficient.
3. Execution/Overseer simulates orders and manages positions.

Wallet activity is research input, not a trade instruction. No category, wallet, model, or execution strategy is eligible for standard paper promotion today. More trades would increase loss, not confidence, unless they come from a preregistered strategy lane whose independent and forward gates have passed.

The best current research lead is scheduled U.S. CPI, but it is not a strategy yet. Its nested walk-forward Brier score is 0.12264 versus a 0.12721 benchmark, a 0.00458 improvement against the frozen 0.005 requirement. Crypto thresholds lose to their benchmark; weather validation fails; wallet copying is negative out of sample; maker execution v2 is sharply negative after correcting its accounting.

## Authoritative production evidence

| Evidence lane | Current result | Decision |
|---|---:|---|
| Actual paper epoch | -$9.57, 19 closed, 47% win rate | Failed; no live launch |
| All stored paper positions | -$111.43, 269 closed | Historical context only |
| True immutable wallet forward scorecard | 0 rows | No prospective wallet evidence |
| Retrospective wallet walk-forward, all test sources | 69 executable, -$22.28, -3.23% average, 20.3% win rate | Failed |
| $5/$10/$15 post-epoch wallet replay | all negative before the unknown-category fix | Failed; size does not create edge |
| Category walk-forward | no category passed | No category allowlist expansion |
| Weather independent validation | 24 samples, 3.14 C MAE, 16.7% within 1 C | Failed policy |
| Crypto independent validation | 890 contracts; model Brier 0.17062 vs 0.16770 benchmark | Failed model |
| CPI independent validation | 1,180 contracts; model Brier 0.12264 vs 0.12721 benchmark | Closest lead, still failed |
| Crypto/CPI/weather immutable selections | 0 resolved for every lane | No forward proof |
| Maker execution v2 | 16 economic outcomes, including 11 hedge misses; -$70.23 on $120.23 (-58.4%) | Failed policy |
| Maker execution v3 | first economic outcome -$0.02 on $10.02 (-0.21%); 0 hedge misses | Fresh forward collection; far too little promotion evidence |
| Binary-pair arbitrage | 0 opportunities | Continue observation only |
| Complete negative-risk arbitrage | 0 opportunities | Continue observation only |
| Crypto cross-market latency | 0 opportunities under the 8 bps/2 s trigger | Data/sensitivity stage only |

The former raw shadow result around +$18k is not promotion evidence. It mixed retrospective/backfilled selection with a permissive execution model. It must remain labeled research-only and must never be a dashboard headline.

## Why the bot is not trading

The lack of trades is mostly correct behavior:

- direct wallet-lead trading is disabled;
- the category allowlist is intentionally empty, so wallet-copy entries are blocked;
- paper exploration is now disabled;
- weather, crypto, and CPI independent validations have not passed;
- no atomic paired or negative-risk arbitrage was observed;
- the initial cross-market trigger was too rare to produce a sample;
- the maker policy produced adverse one-leg exposure and is now retired.

The goal is not to loosen these gates. The goal is to make each research lane capable of generating honest, testable evidence.

## Agent audit

### Signal Agent: partially aligned, too broad

It correctly discovers markets and wallets, persists source trades, blocks research-only wallets, and produces independent-model watchlists. It also owns too many concerns: leaderboard discovery, historical backfill, scoring, shadow replay, signal generation, and market persistence. This makes the hot loop expensive and obscures the distinction between observation and selection.

It is deterministic TypeScript, not an AI model. Its scores are heuristics. Calling it AI overstates what it can infer.

Decision: keep it as Discovery/Signal, but its output is a hypothesis or a preregistered model prediction. It cannot authorize capital.

### Risk Mitigation Agent: aligned on safety, not profitability

It correctly checks book freshness, spread, depth, exposure, confidence, cooldowns, and execution policy. These checks prevent bad execution; they cannot prove positive expected value. The supporting Market Intelligence, Wallet Intelligence, and Decision Council reuse many of the same fields and create correlated heuristic votes rather than independent evidence.

Decision: keep hard risk and microstructure checks. Demote the intelligence/council scores to diagnostics. Strategy admission must come only from the profitability control plane.

### Overseer Agent: operationally useful, evidence incomplete

It models executable exits, fees, FAK/FOK behavior, stale/no-bid states, partial exits, source exits, and stop/take-profit rules. Position IDs are now unique per entry order, which prevents re-entry from overwriting prior round trips.

Its historical profitability cannot be cleanly attributed because cleanup deleted the originating signal rows for every existing paper order. Future evidence is protected by the retention fix.

Decision: retain it as Paper Execution/Overseer. Evaluate exit policies separately from entry policies so a good exit cannot be used to claim a bad entry has edge.

### Supporting “agents”

Wallet Research and Strategy Research are useful analysis modules, but current strategy hypotheses can become stale because their cache is driven by wallet-report timestamps rather than a model/policy version. Market Intelligence and the Decision Council are not independent models and should not count as votes toward profitability.

Decision: expose them as research/diagnostic modules, not autonomous agents.

## Data and accounting audit

### Fixed now

- `HEDGE_MISS` results now count in P&L, win rate, breadth, latency, and promotion samples.
- Maker candidates require hedge depth of at least 3x on either possible one-leg fill and reject a modeled hedge loss worse than 2%.
- Maker policy rolled to `execution-microstructure-v3-hedge-safe`; v2 remains immutable failed evidence.
- Unknown shadow categories can no longer bypass an explicit category allowlist.
- Watchlist observations reuse hourly IDs, reducing tens of thousands of duplicate rows per day without touching immutable selections.
- Daily cleanup no longer deletes paper orders, fills, source attribution, or exit evidence. Signals referenced by economic or selected rows are preserved.
- Post-epoch wallet trades are preserved so source-time validation is reproducible.
- Paper forward scorecards join positions to their exact entry order instead of any order in the same market/token/profile.
- Execution tape metadata now stores `endDate`, enabling honest horizon-aware replay.
- Polymarket `price_change` level deltas now update stored bid/ask depth instead of discarding side and size; the live book and tape replay share this logic.
- Short-horizon BTC/ETH markets receive a reserved execution-research priority.
- The daily immutable truth snapshot now includes all four execution scorecards.

### Irrecoverable/current limitations

- Production cleanup already orphaned all 1,113 paper orders from their signal rows. The aggregate position P&L remains, but old strategy/category attribution is not trustworthy unless a pre-cleanup backup contains the missing signals.
- SQLite stores current market payloads and high-volume logs in one large file. `markets` and `bot_run_logs` are the largest logical tables; unused pages remain until a controlled `VACUUM`.
- Retrospective source-time walk-forward still has wallet-selection/survivorship limitations. It is a robustness test, not prospective evidence.
- Forward model selection is correctly immutable, but monthly CPI event diversification means evidence accrues slowly. Historical Polymarket prices cannot substitute unless they are point-in-time and free of look-ahead.

## Architecture decision

The target design has four explicit planes:

1. **Collectors:** Gamma metadata, CLOB REST/WebSocket books and trades, Data API wallet activity, Binance/Polymarket reference feeds. They write append-only compressed tapes.
2. **Research:** offline model fitting, wallet-pattern mining, parameter sensitivity, and historical robustness. Results can reject a policy but cannot promote it.
3. **Forward validator:** one immutable prediction/candidate per independent event under a frozen policy, with fees, depth, latency, settlement, calibration, and multiple-testing controls.
4. **Paper executor:** admits only a strategy whose validation stage allows it, then records exact order/fill/position attribution and Overseer-managed outcomes.

The current `index.ts` is a 1,397-line orchestration monolith and `src/db.ts` is 4,800+ lines. They should be split by these planes after the correctness changes stabilize. That refactor is maintainability work, not an excuse to change policy results or reset forward samples.

## Strategy portfolio

### 1. Atomic arbitrage: highest confidence, lowest expected frequency

Keep binary-pair and complete negative-risk FOK scanners active. They only record an opportunity when all legs, depth, fees, and guaranteed payout are known. Zero candidates is a valid result. Do not lower the net-edge threshold to manufacture trades.

### 2. Cross-market crypto latency: next experiment to make testable

The tape now contains exchange and receive timestamps, full market metadata, BTC/ETH reference ticks, and selected CLOB depth. Run a preregistered sensitivity study across reference-move thresholds and hold periods, choose one policy on the research partition, then validate it only on the next untouched tape partition. Use Polymarket’s reference feed as a control against the direct Binance feed. No paper order is allowed from the sensitivity partition.

### 3. CPI: best directional research lead, incomplete inputs

The current model uses BLS history but not the point-in-time consensus and nowcast information in its own thesis. Add archived consensus forecasts and vintage-safe leading indicators. Compare against both historical frequency and the contemporaneous market probability. A 0.00042 miss to a threshold is not permission to round up.

### 4. Maker/reward strategy: redesign, do not resume v2

Official Polymarket guidance requires two-sided quoting, current books, stale-quote cancellation, and inventory control. The failed prototype quoted paired bids but did not run a full inventory-aware two-sided maker. V3 only tests whether hedge-safe paired quoting can survive without rewards. If base trading P&L becomes non-negative, add rewards/rebates as a separately reported component; never use estimated incentives to hide adverse-selection losses.

### 5. Weather and generic wallet copying: paused

Weather needs a new calibration design and policy ID. Delayed wallet copying is rejected as an entry strategy. Wallets remain valuable for finding market niches, maker behavior, arbitrage structure, and information timing.

## Operational and security audit

- There is no live-order code path and no trading private key integration. This is correct.
- TypeScript typecheck and all 136 automated tests pass.
- `npm audit --omit=dev` reports zero known production vulnerabilities.
- Services were healthy before deployment with zero restarts, but readiness was 45/100 and correctly `NOT_READY`.
- Secrets shared in chat should be rotated even though they are unrelated to strategy and are not committed. `.env` is gitignored.
- A controlled backup, checkpoint, and later `VACUUM` are appropriate; data deletion is not a profitability fix.

## Promotion rules

A strategy can move to standard paper only when all applicable gates pass:

- independent walk-forward beats its preregistered benchmark;
- immutable forward sample reaches its independent-event minimum;
- forward settlement P&L is positive after fees and the return threshold passes;
- model calibration is no worse than the market where probabilities are used;
- realistic paper execution independently passes sample, return, drawdown, and slippage gates;
- policy ID, parameters, universe, and start time were frozen before the counted sample;
- no backfilled, retrospective, or sensitivity-selection rows enter promotion statistics.

Live money remains blocked until a promoted strategy also demonstrates stable paper/live-parity execution and an explicit key, cancel-all, heartbeat, and emergency-stop implementation is separately reviewed.
