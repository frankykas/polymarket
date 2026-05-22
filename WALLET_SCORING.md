# StratiFi Wallet Scoring

StratiFi is a paper-trading research bot for Polymarket wallet intelligence. Its goal is not to blindly copy wallets. It tries to find wallets that are both profitable-looking and realistically copyable after fees, spread, slippage, liquidity limits, and delayed entry.

## What The Score Is Trying To Answer

The wallet score answers two different questions:

- **Performance score:** does this wallet look like it makes good trades?
- **Copyability score:** can StratiFi realistically follow this wallet without getting trapped in thin markets or late entries?

The copyability score is more important for trading decisions. A wallet can look profitable but still be a bad target if it trades too fast, only trades illiquid markets, or has too little history.

## Current Inputs

StratiFi groups recent public Polymarket trades by wallet and calculates:

- Trade count
- Buy count and sell count
- Unique markets traded
- Total traded volume
- Average trade size
- Approximate realized PnL from matched buys and sells
- Approximate profit factor
- Approximate win rate
- Approximate average return percentage
- Approximate max drawdown
- Approximate average hold time
- Recent activity

These are approximate because public recent trade data is not always enough to reconstruct a perfect full wallet history. The score should be treated as a ranking signal, not final proof that a wallet is good.

## Why Win Rate Alone Is Dangerous

A wallet with 3 wins out of 3 trades has a 100% win rate, but that does not mean it is a high-quality wallet.

Examples of misleading wallets:

- A wallet made only 3 obvious trades in easy markets.
- A wallet bought late after the price already moved.
- A wallet won one large lucky trade and has no repeatable edge.
- A wallet trades markets with no liquidity, so StratiFi cannot enter or exit at similar prices.
- A wallet has many open positions but no sell history, making realized performance unclear.
- A wallet wins often but loses much more on the few trades it loses.

Because of that, StratiFi does not rank wallets by win rate alone. Win rate is only one small input.

## Anti-False-Positive Rules

StratiFi applies filters and penalties to avoid overrating weak wallet samples:

- **Minimum trade count:** wallets below `minDiscoveryTrades` are filtered out.
- **Minimum volume:** wallets below `minDiscoveryVolume` are filtered out.
- **Breadth requirement:** wallets trading only one market receive a concentration penalty.
- **No sell history flag:** wallets with buys but no sells are flagged because realized PnL is uncertain.
- **Drawdown penalty:** wallets with large approximate drawdowns are penalized.
- **Very fast trader penalty:** wallets with extremely short average hold times are penalized because they may be impossible to copy.
- **Negative PnL flag:** wallets with negative approximate realized PnL are flagged.

This means a 3-for-3 wallet should not automatically rank well. It needs enough trades, enough volume, repeat behavior across markets, and exits that StratiFi can realistically follow.

## Score Components

The current discovery score is now split into four components:

- **Overall reputation:** broad wallet quality across all sampled trades.
- **Category consistency:** whether the wallet appears repeatable in its dominant market category, such as politics, sports, crypto, macro, company, or culture.
- **Hot score:** recent activity, recent volume, and recency of the latest trade.
- **Exit behavior:** whether the wallet has sell history and holds long enough to be copyable.

The copyability score combines those components and then applies penalties:

- Single-market concentration
- Very fast trading
- Short average hold time
- No sell history
- Weak evidence
- High drawdown

Wallets are sorted primarily by copyability score, then performance score, then volume.

## Evidence Caps

StratiFi now caps scores when evidence is weak:

- Fewer than 5 trades cannot rank as a strong wallet.
- Fewer than 10 trades remain capped even if the win rate is perfect.
- Fewer than 20 trades are flagged as under the preferred category sample.
- Fewer than 3 closed trades are capped because realized performance is not trustworthy.
- Wallets with no sell history are capped because exits are unknown.

This is how the bot avoids overrating a wallet that went 3-for-3 on easy trades.

## Category Consistency

For discovered wallets, StratiFi infers a market category from the market question and slug. The current categories are:

- Politics
- Sports
- Crypto
- Macro
- Company
- Culture
- Other

The dominant category is scored separately from overall reputation. A wallet can be useful in one category while being mediocre overall, and future signal scoring can use that category-specific strength instead of treating every market equally.

## Win Rate Adjustment

Raw win rate is adjusted with a Wilson lower-bound estimate. In plain English: the bot treats small samples with skepticism.

A wallet with 3 wins out of 3 trades does not get the same win-quality credit as a wallet with 60 wins out of 80 trades. This makes the ranking less exciting but much harder to fool.

## Approximate PnL Method

For each wallet, StratiFi groups trades by market and outcome.

- Buys add to an average-cost lot.
- Sells close part or all of that lot.
- Realized PnL is estimated as:

```text
sell proceeds - average cost of sold shares
```

This is not perfect historical accounting yet. It does not fully account for unresolved positions, all historical fills, rewards, fees, transfers, or positions opened before the data window.

## Known Limitations

Current scoring is useful for discovery, but it is not final-grade wallet intelligence yet.

Main limitations:

- Recent trade windows may miss older entries or exits.
- Unrealized PnL is not fully reconciled.
- Market resolution outcomes are not yet used for final win/loss truth.
- Copy delay and order-book slippage are only handled in the paper execution layer, not in historical wallet ranking.
- Wallets can look good during one market regime and degrade later.

## Next Improvements

The next scoring upgrades should be:

- Pull deeper wallet history for top candidates.
- Reconstruct full positions per market/outcome.
- Include resolved market outcomes.
- Backtest “copy after detection” instead of raw wallet PnL.
- Track wallet degradation over time.
- Store deeper per-category source history.
- Demote wallets whose paper-copy performance underperforms their raw historical score.

The long-term goal is simple: StratiFi should not ask “who made money?” It should ask “who can we realistically follow, at our size, with our latency, through liquid markets, while protecting downside?”
