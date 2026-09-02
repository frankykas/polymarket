# PMarke strategy and agent audit

Data cut: 2026-08-09 07:15 UTC (03:15 America/Toronto)
Production database: `/opt/pmarke/data/polymarket-paper-bot.sqlite`

## Executive decision

Do not increase size or enable live money. Disable new paper entries while the corrected measurement pipeline collects prospective evidence. The current production strategy has no demonstrated positive edge after executable prices and current Polymarket taker fees.

The immediate strategy is therefore **capital preservation plus shadow-only validation**:

1. Block sports, which generated effectively all of the observed loss.
2. Require at least two genuinely distinct source wallets; do not grant a single-wallet exception.
3. Evaluate sources on immutable, fee-adjusted paper/parity trades, including positions marked at zero.
4. Keep entry size at $10, total exposure at $50, daily loss at $5, three consecutive losses, and five entries per day if paper entries are later re-enabled.
5. Re-enable paper entries only after the prospective promotion criteria below are satisfied. Live-money execution remains prohibited until a separate portfolio-level gate passes.

## What the data says

### Portfolio results

| Sample | Closed trades | Gross P&L | Gross ROI | Fee-adjusted P&L | Fee-adjusted ROI |
|---|---:|---:|---:|---:|---:|
| Since immutable parity tracking (2026-08-01) | 161 | -$56.04 | -3.67% | not used for the current decision | negative |
| Current configuration deployment | 35 | -$29.92 | -8.79% | -$44.81 | -13.2% |
| Current-config sports | 32 | -$31.88 | negative | -$45.12 | -14.4% |

Other observed facts:

- Displayed cumulative closed P&L was -$101.86 across 250 stored closed rows, but that figure is not an auditable lifetime result because earlier re-entries overwrote closed positions.
- Gross P&L over the last 24 hours was -$14.06.
- Overnight P&L from 18:00 America/Toronto was -$12.47.
- Under the current config, Aggressive lost $24.12 across 29 trades and Conservative lost $5.80 across 6 trades.
- Exit replay reproduced the latest 13 closed trades within three cents. Stop-loss tuning did not materially repair the result; entry selection is the primary failure.

### Category attribution

| Category | Trades | Gross P&L | Fee-adjusted P&L | Finding |
|---|---:|---:|---:|---|
| Sports | 133 | -$63.55 | -$121.29 | Definitively exclude |
| Macro | 7 | +$7.21 | +$4.01 | Hypothesis only; sample is too small |
| Crypto | 2 | +$1.78 | +$0.34 | No conclusion |
| Culture | 2 | -$0.13 | -$1.52 | No conclusion |
| Other | 17 | -$1.35 | -$2.75 | No demonstrated edge |

Macro is not yet a profitable strategy; seven observations are inadequate and may be selection noise. It can be studied in shadow mode, not promoted on this evidence.

Fees use Polymarket's documented taker formula: `shares * feeRate * price * (1 - price)`. The prior production config used a zero fee rate even though sampled sports markets were fee-enabled at a 0.05 rate. See [Polymarket trading fees](https://docs.polymarket.com/trading/fees).

## Agent audit

The three named agents are deterministic heuristics, not independent AI models. Their labels and council structure created a false impression of independent review even though they largely consumed the same inputs.

### Signal Agent — failed its objective

Expected objective: find source behavior that remains profitable after copying delay, executable prices, fees, and out-of-sample paper execution.

Findings:

- Current source scores did not predict realized paper outcomes. For sources with recent copied trades, score versus realized-result correlation was 0.063.
- Shadow return versus realized paper outcome correlation was -0.442 in the audited overlap.
- Three shadow trades could promote a wallet, allowing noise and overfit to masquerade as proof.
- A single “proven” wallet silently bypassed the two-wallet alignment setting.
- Sports classification missed tennis, cricket, esports, and markets identified mainly through metadata.
- Paper source feedback joined old fills to the latest overwritten position and excluded zero-priced marks, biasing feedback upward.
- Per-wallet discovery/scoring events generated tens of thousands of low-value rows per day.

Verdict: not doing what it was supposed to do. It optimized internal proxy scores that were not validated against fee-adjusted realized results.

### Risk Mitigation Agent — controls were present but ineffective

Expected objective: stop portfolio-level loss and reject poor execution or weak evidence.

Findings:

- Production allowed $500 exposure on a $500 bankroll with no reserve, $200 daily loss, effectively unlimited loss streak, and 500 trades/day.
- The configured `maxOpenTrades` profile limits were not enforced.
- Daily trades counted both buys and sells.
- Daily P&L and loss streak relied on overwritten position rows.
- A lone source was described as “independent” intelligence.
- Market intelligence scored liquidity and volume highly but added no independent informational edge.
- Council votes were correlated transformations of the same data; `WATCH` votes did not veto.

Verdict: not providing meaningful risk control under the deployed configuration.

### Overseer Agent — generally executed its exit policy

Expected objective: monitor open positions and execute realistic exits.

Findings:

- Recent exit attribution: 7 stop losses lost $20.97, 4 source-sell exits lost $3.85, and 2 take profits made $6.60.
- Read-only replay matched realized P&L closely, showing the implemented exit mechanics were broadly reproducible.
- A 20% notional stop improved the replay only marginally; alternative exit policies did not turn the sample profitable.
- Exit parity was tautological because expected exit was recorded as actual exit, and the slippage sign was reversed.
- Entry and exit fees were omitted from paper P&L.

Verdict: mostly doing its operational job, but it could not rescue systematically bad entries and its measurement was misleading.

## Accounting and data-integrity defects corrected

- Position IDs now include the entry order ID so every round trip has an immutable row.
- Entry and exit taker fees are stored and included in realized P&L.
- Market fee metadata is persisted and used; the configured fallback is conservative.
- Source feedback is built from immutable parity records, attributes aligned wallets captured at entry, and includes zero-priced losses.
- Exit slippage is measured against the executable reference price with the correct sign.
- Performance reporting no longer double-counts realized amounts on open positions.
- Trades-per-day counts entries rather than entries plus exits.

## Prospective promotion gates

Do not reinterpret old backfilled results as prospective proof. A source/category is eligible for cautious paper entry only when all of the following are true under the corrected code:

- at least 50 shadow observations;
- at least 30 live-executable shadow trades;
- positive live-executable shadow P&L after fees;
- at least 10 immutable paper fills;
- positive fee-adjusted paper P&L and at least 2% average return;
- at least 55% live-executable shadow win rate;
- at least 50% of observations have a source-sell-realized exit;
- two distinct aligned sources;
- category is not sports.

Even after an individual source passes, live money should remain disabled until the complete portfolio records at least 100 prospective closed paper trades, positive fee-adjusted P&L, profit factor above 1.20, maximum drawdown below 10% of bankroll, and positive results in both halves of the sample. Any one of these failing resets the live-readiness decision to **NO-GO**.

## Initial audit safety configuration

- New entries: disabled
- Paper mode: enabled
- Sports: blocked
- Single-source signals: disabled
- Entry size: $10
- Maximum open exposure: $50
- Cash reserve: 90%
- Daily loss cap: $5
- Consecutive-loss cap: 3
- Daily entry cap: 5
- Minimum signal confidence: 85
- Minimum wallet score: 75

There is no honest basis in the available data for promising profit. The highest-value action now is preventing further low-quality entries while building a clean, prospective, fee-adjusted sample.

## Fresh prospective epoch — 2026-08-09 17:13:01 UTC

At the operator's request, displayed performance and risk counters now begin at timestamp `1786295581072`. Historical rows remain in SQLite for offline audit and validation; they are not deleted, do not qualify a source for promotion, and are not included in the new dashboard P&L, closed-trade count, win rate, ledger, daily P&L, daily trade count, or loss streak.

New paper entries are enabled only for a controlled prospective trial:

- live trading remains unavailable;
- sports remain blocked;
- normal signals still require two distinct sources;
- discovery uses Gamma keyset pagination and can inspect 500 markets, with up to 100 non-sports markets watched, instead of silently stopping at the legacy 100-market response cap;
- blocked-category sources cannot consume live-executable promotion slots;
- paper exploration is capped at one candidate per scan, five entries per day, $10 per entry, and $50 total exposure;
- exploration requires two sources, 75 confidence, 75 wallet/copyability scores, 0.65 sample confidence, 50% source-sell realization, five-times executable depth, at most 2% entry slippage, and a source buy no older than 15 minutes;
- known negative live-executable or paper-copy sources remain ineligible.

The first expanded production cycle reviewed 53 non-sports markets instead of 32 and produced zero candidates. This is acceptable: the system has a broader search surface but will not manufacture trades from sources already measured as negative.

## Forward shadow and validation controls — 2026-08-09 17:51 UTC

- Shadow notional is now $10, exactly matching the paper entry size.
- Promotion evidence is filtered on `source_timestamp >= performanceStartAt`; `created_at` is never used as the forward boundary because replayed rows are written today even when their source trades are old.
- Lifetime `wallet_scores` promotion is disabled while a prospective epoch is active.
- Blocked categories are excluded inside durable-promotion aggregation and from per-cycle shadow score impacts.
- The public dashboard model now exposes a forward-only shadow scorecard with executable P&L, return, win rate, miss reasons, and category breakdown.
- Reproducible commands were added: `npm run shadow:forward`, `npm run shadow:size-sensitivity`, and `npm run shadow:walk-forward`.

Initial production results after alignment:

- Stored forward scorecard at the final deployment check: 78 source observations, 3 executable, executable P&L -$0.69, -2.30% average return, 0% win rate. The largest miss reason was source size below the $10 FOK copy size (63).
- Dynamic non-sports forward size sensitivity on 60 active wallets: $5 produced 306 executable observations and -$124.41; $10 produced 298 and -$239.92; $15 produced 297 and -$354.60. No size was profitable. Lower size improved availability and reduced dollar loss but did not create an edge.
- Leakage-safe 70/30 chronological walk-forward: zero training sources passed the unchanged promotion gates. The diagnostic top-10 ranking lost $96.67 on 274 next-period executable trades; all test sources lost $280.86 on 338 executable trades.

Conclusion: keep $10 shadow aligned with $10 paper, keep every profitability and alignment gate intact, and promote no source yet. Continue collecting prospective non-sports evidence; more candidates are useful only if the forward executable scorecard turns positive.

## Leaderboard wallet research redesign — 2026-08-09

The previous discovery path treated observed buys as though every profitable wallet exposed a directional signal that could be copied after the fact. That assumption is false for most persistent non-sports leaderboard wallets. The Polymarket Data API also returns taker-only trades by default, which hides the maker side of the very wallets the system is trying to learn from.

A new Wallet Research Agent now refreshes a cross-category, cross-period candidate set from the official leaderboard (week, month, and all-time across politics, crypto, culture, economics, tech, finance, weather, and mentions). For each candidate it compares all-role and taker-only activity, current trade direction, market concentration, paired-outcome behavior, executable trade size, closed-position results, prediction calibration where outcomes are resolved, and recurring market themes.

The research handoff classifies each wallet as one of:

- directional specialist — eligible only for shadow observation;
- maker specialist — useful for strategy research, not fill copying;
- paired-outcome arbitrage — useful for execution research, not fill copying;
- exit or unwind flow — hard-blocked from entry copying;
- mixed or unproven — research only.

`RESEARCH_DO_NOT_COPY` is a hard entry rejection in both the standard paper path and the controlled exploration path. Maker and model-edge wallets are penalized in wallet and market intelligence instead of receiving a misleading leaderboard bonus. The Signal Agent consumes the persisted research report before it scores a source, and the other agents receive a structured private handoff containing archetype, recommendation, patterns, and observed edge.

The first scan found one strong model candidate: `russell110320` (`0x118689...051b`). Across the latest 200 closed positions it showed $65,580.78 of realized P&L, a 67.8% profitable-position rate, a 0.126 resolved-position Brier score, and 83.3% directional accuracy. In the latest 1,000 all-role observations, 77.5% of buys were at least $10 and an estimated 41.4% of activity was maker-only. Its history is concentrated in climate and temperature-anomaly markets. It is automatically enrolled only in the forward taker-trade shadow stream—not paper copying—and remains hard-blocked until source-timestamped evidence from the current epoch passes the complete live-executable gate. The correct strategy hypothesis is to reproduce the wallet's information process with forecast/climate data and calibrated fair values, then validate executable orders prospectively.

Other persistent candidates were predominantly maker-driven, paired-outcome, highly concentrated, too small at the median fill, or visibly unwinding. Their profitability is evidence that market making, inventory management, specialized forecasting, and execution can have an edge; it is not evidence that chasing their taker fills five minutes later has an edge.

Reference implementations reviewed for architecture—not assumed profitability—include Polymarket's official CLI, a maker-only inventory-skew reference bot, weather-model trading research, and calibration/Brier-score tooling. No GitHub strategy is promoted without forward, fee-adjusted validation in this system.

### Lead quality is separate from bet size

Wallet notional is not a research-selection gate. The research score ranks leads using persistence, closed-position evidence, profitable-position rate, concentration, P&L magnitude as a secondary signal, and calibration. A separate execution-compatibility score records maker dependence, paired-outcome behavior, and whether a hypothetical order can be executed at the current paper size. A wallet remains a high-priority lead even when its observed fills are much smaller or larger than $10.

The candidate scan is expanded from 12 to 24 persistent non-sports wallets. Maker and arbitrage specialists remain research inputs because their market-selection, pricing, inventory, or timing process may be reproducible. They are blocked only from literal delayed fill-copying. Position size will be chosen later from independently estimated edge, uncertainty, liquidity, portfolio exposure, and drawdown limits—not from the source wallet's bet amount.

Each research wallet also receives an immutable first-observed timestamp. Trades backfilled when a lead is first enrolled can be used for pattern research, but cannot enter promotion statistics; only source trades occurring after that wallet entered observation count as forward evidence.
