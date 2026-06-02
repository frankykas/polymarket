# StratiFi Polymarket Paper Trading Bot Documentation

## 1. Overview

### 1.1 What StratiFi Is

StratiFi is a TypeScript-based Polymarket wallet-intelligence and paper-trading bot. It scans public Polymarket market activity, discovers active wallets, scores them for performance and copyability, generates trade candidates, passes them through risk controls, simulates paper entries and exits, and publishes public-safe analytics through a dashboard, follower tracker, Telegram alerts, and exportable paper-trade data.

The system is currently paper trading only. It does not place live Polymarket orders, read private keys, derive exchange credentials, or cancel live orders.

### 1.2 What Problem It Solves

Polymarket has public wallet activity, but blindly copying wallets is risky. Wallets can look profitable for reasons that are not copyable:

- They entered before the move.
- They trade illiquid markets.
- They exit too quickly.
- Their apparent edge is concentrated in one category.
- Their public recent activity may miss old entries or exits.
- Their raw wallet PnL may not match what a follower could realistically copy.

StratiFi tries to answer a more useful question:

> Which wallets can be realistically followed at our size, with our latency, through liquid markets, while protecting downside?

### 1.3 Current Status

StratiFi currently includes:

- Active Polymarket market scanning.
- Public wallet discovery from recent market trades.
- Configured wallet tracking.
- Wallet scoring and copyability scoring.
- Category inference for markets.
- Source-wallet history storage.
- Market metadata and resolution backfill.
- Shadow-copy backtesting.
- Risk Mitigation Agent approval/rejection.
- Conservative and Aggressive strategy profiles.
- Paper order execution simulation.
- Open and closed paper position tracking.
- Trade-level paper PnL.
- Running equity and available-cash balance trail.
- Telegram command and alert system.
- Public-safe local dashboard.
- Public follower tracker page.
- CSV paper-trade ledger export.

### 1.4 What It Does Not Do Yet

StratiFi does not currently:

- Place live Polymarket orders.
- Store or use private keys.
- Sign transactions.
- Manage real wallet balances.
- Read live on-chain wallet balances for the public tracker.
- Guarantee profitable trading.

Live trading should only be added after enough forward paper-trading data exists to validate the strategy.

---

## 2. Key Concepts

### 2.1 Source Wallet

A source wallet is a public Polymarket wallet whose trading activity may be useful as a signal. Source wallets can be:

- Manually configured in `config/wallets.json`.
- Automatically discovered from market activity.

### 2.2 Configured Wallet

A configured wallet is a wallet explicitly listed in `config/wallets.json` with `enabled: true`.

Example:

```json
[
  {
    "address": "0x123...",
    "label": "example-source",
    "enabled": true
  }
]
```

### 2.3 Discovered Wallet

A discovered wallet is found by scanning public Polymarket trades. The bot groups recent trades by wallet and ranks wallets using volume, trade count, approximate performance, category consistency, copyability, and risk flags.

### 2.4 Copyability

Copyability measures whether StratiFi could realistically follow a wallet. A wallet with strong raw performance may still be poor to copy if:

- It trades too quickly.
- It enters thin markets.
- It has no sell history.
- It concentrates in one market.
- Its edge does not survive simulated copy delay.

### 2.5 Shadow Copy

Shadow-copy backtesting simulates what would have happened if StratiFi copied a source-wallet buy after a delay. Shadow trades do not open paper positions. They are used to evaluate whether a wallet is realistically copyable.

### 2.6 Paper Trading

Paper trading simulates entries, fills, exits, PnL, and balance changes without placing live Polymarket orders.

### 2.7 Public-Safe Data

Public-safe data can be shown to followers without exposing sensitive source intelligence.

Public-safe examples:

- Paper PnL.
- Open paper positions.
- Closed paper trades.
- Signal confidence.
- Source strength bands.
- Aggregated wallet quality.
- Trade ledger.

Private data examples:

- Exact discovered source wallet addresses.
- Raw wallet payloads.
- Detailed source scoring internals.
- Admin operation traces.

---

## 3. Repository Structure

### 3.1 Top-Level Files

| Path | Purpose |
|---|---|
| `index.ts` | Main bot entrypoint. Runs scan, dev loop, shadow report, performance report. |
| `package.json` | Scripts and dependencies. |
| `config/bot.json` | Main paper trading and risk configuration. |
| `config/wallets.json` | Manually tracked source wallets. |
| `.env` | Local runtime environment variables. |
| `.env.example` | Example environment file. |
| `README.md` | Quick-start project documentation. |
| `GITBOOK_DOCUMENTATION.md` | Extended GitBook/Notion documentation. |

### 3.2 Source Folders

| Path | Purpose |
|---|---|
| `src/agents/` | Signal, Risk Mitigation, and Overseer agents. |
| `src/dashboard/` | Dashboard server, read models, public UI, tracker UI. |
| `src/events/` | Agent event writer. |
| `src/providers/` | Polymarket provider facade. |
| `src/profiles/` | Conservative and Aggressive strategy profiles. |
| `src/clients.ts` | Gamma, Data API, CLOB REST, and CLOB WebSocket clients. |
| `src/config.ts` | Runtime config and environment loading. |
| `src/db.ts` | SQLite schema, persistence, analytics queries. |
| `src/engines.ts` | Market quality, signal generation, risk, paper execution, exits. |
| `src/shadowBacktest.ts` | Shadow-copy backtesting engine. |
| `src/telegram.ts` | Telegram commands and alerts. |
| `src/walletIntelligence.ts` | Wallet scoring, discovery, category inference, score adjustments. |
| `src/paperTradeLedgerFile.ts` | CSV paper-trade ledger exporter. |
| `src/exportPaperLedger.ts` | CLI export entrypoint for paper ledger CSV. |

### 3.3 Data Folder

| Path | Purpose |
|---|---|
| `data/polymarket-paper-bot.sqlite` | Main SQLite database. |
| `data/paper-trade-ledger.csv` | Exported paper trade ledger. |
| `data/telegram-state.json` | Stored Telegram admin chat state. |

The `data/` folder is ignored by Git.

---

## 4. Installation

### 4.1 Requirements

- Node.js.
- npm.
- Windows PowerShell, macOS terminal, or Linux shell.

The current project uses TypeScript through `tsx`.

### 4.2 Install Dependencies

```powershell
cd C:\dev\PMarke
npm install
```

### 4.3 Create Environment File

```powershell
Copy-Item .env.example .env
```

Then edit `.env`.

### 4.4 Minimal Environment

The default API endpoints are already included in `.env.example`.

Minimum useful config:

```env
GAMMA_API_URL=https://gamma-api.polymarket.com
DATA_API_URL=https://data-api.polymarket.com
CLOB_API_URL=https://clob.polymarket.com
CLOB_WS_URL=wss://ws-subscriptions-clob.polymarket.com/ws/market
BOT_DB_PATH=./data/polymarket-paper-bot.sqlite
```

### 4.5 Optional Telegram Environment

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_ADMIN_CHAT_ID=
TELEGRAM_PUBLIC_CHAT_ID=
TELEGRAM_CHAT_ID=
```

### 4.6 Optional Public Tracker Environment

```env
PUBLIC_TRACKER_NAME=StratiFi Paper Tracker
PUBLIC_TRACKER_WALLET_ADDRESS=
PUBLIC_TRACKER_DISCLOSURE=Paper trading tracker. No live Polymarket orders are placed by this bot.
```

### 4.7 Optional Dashboard Publishing Environment

```env
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_ANON_KEY=
```

### 4.8 Optional Admin Dashboard Token

```env
ADMIN_DASHBOARD_TOKEN=
```

If `ADMIN_DASHBOARD_TOKEN` is set, non-localhost admin access requires the token.

---

## 5. Commands

### 5.1 One-Time Scan

```powershell
npm run scan
```

Runs one market/wallet discovery cycle without placing paper orders.

### 5.2 Continuous Paper Bot

```powershell
npm run dev
```

Runs the continuous paper bot loop.

This command now runs a preflight hook that stops the previous recorded dev bot process before starting a new one. It uses a PID file:

```text
data/polymarket-paper-bot.dev.pid
```

This is intentionally scoped to the recorded bot process only. It does not broadly kill all Node processes.

### 5.3 Dashboard

```powershell
npm run dashboard
```

Open:

```text
http://localhost:8787
```

### 5.4 Public Follower Tracker

```text
http://localhost:8787/tracker
```

The tracker page is designed for followers. It displays:

- Public tracker name.
- Public wallet address label.
- Paper equity.
- Paper total PnL.
- Available cash.
- Open paper positions.
- Closed paper trades.
- Recent trade feed.
- Recent signals.

### 5.5 Performance Report

```powershell
npm run performance
```

Prints local paper PnL, open positions, closed positions, win rate, orders, fills, and signals.

### 5.6 Shadow Backtest Report

```powershell
npm run shadow
```

Runs a scan and prints shadow-copy backtest performance.

### 5.7 Export Paper Ledger

```powershell
npm run export-ledger
```

Exports the full paper trade ledger to:

```text
data/paper-trade-ledger.csv
```

Override path:

```env
PAPER_TRADE_LEDGER_PATH=./data/my-ledger.csv
```

### 5.8 Tests

```powershell
npm run test
```

### 5.9 Typecheck

```powershell
npm run typecheck
```

---

## 6. Configuration

### 6.1 Main Bot Config

Main config file:

```text
config/bot.json
```

Example:

```json
{
  "paperMode": true,
  "bankroll": 500,
  "minPositionSize": 2,
  "maxPositionSize": 4,
  "maxOpenExposure": 35,
  "reserveCashPct": 0.2,
  "maxDailyLoss": 15,
  "maxLossStreak": 4,
  "maxTradesPerDay": 120,
  "minSignalConfidence": 68,
  "minWalletScore": 50,
  "minAlignedWallets": 1,
  "maxSpread": 0.08,
  "minLiquidity": 750,
  "minOrderBookDepth": 30,
  "minTimeToResolutionHours": 1,
  "maxTimeToResolutionHours": 168,
  "limitOrderTtlMs": 90000,
  "takeProfitPct": 0.12,
  "stopLossPct": 0.07,
  "maxPositionHoldHours": 24,
  "scanIntervalMs": 30000
}
```

### 6.2 Bankroll Settings

| Setting | Meaning |
|---|---|
| `bankroll` | Starting paper capital. |
| `minPositionSize` | Smallest allowed paper position in USDC. |
| `maxPositionSize` | Largest allowed paper position in USDC. |
| `maxOpenExposure` | Maximum open paper exposure. |
| `reserveCashPct` | Percentage of bankroll protected from normal entries. |

### 6.3 Risk Settings

| Setting | Meaning |
|---|---|
| `maxDailyLoss` | Daily realized loss limit. |
| `maxLossStreak` | Loss streak pause threshold. |
| `maxTradesPerDay` | Maximum daily paper trades. |
| `minSignalConfidence` | Minimum confidence required for trade candidates. |
| `minWalletScore` | Minimum wallet score for alignment. |
| `minAlignedWallets` | Minimum source-wallet alignment count. |

### 6.4 Market Quality Settings

| Setting | Meaning |
|---|---|
| `maxSpread` | Maximum allowed order-book spread. |
| `minLiquidity` | Minimum market liquidity. |
| `minOrderBookDepth` | Minimum order-book depth. |
| `minTimeToResolutionHours` | Rejects markets too close to resolution. |
| `maxTimeToResolutionHours` | Rejects far-dated markets that could lock capital. |

### 6.5 Exit Settings

| Setting | Meaning |
|---|---|
| `takeProfitPct` | Take-profit threshold. |
| `stopLossPct` | Stop-loss threshold. |
| `spreadExitThreshold` | Exit pressure from widening spread. |
| `priceReversalPct` | Exit pressure from price reversal. |
| `maxPositionHoldHours` | Maximum paper position hold time. |

### 6.6 Discovery Settings

| Setting | Meaning |
|---|---|
| `discoveryEnabled` | Enables wallet discovery. |
| `discoveryMarketLimit` | Maximum markets used for discovery. |
| `discoveryTradesPerMarket` | Trades pulled per market. |
| `minDiscoveryTrades` | Minimum trades needed to rank discovered wallet. |
| `minDiscoveryVolume` | Minimum volume needed to rank discovered wallet. |
| `maxDiscoveredWallets` | Maximum discovered wallets saved/ranked. |
| `autoTrackDiscoveredWallets` | Allows discovered wallets to become signal sources. |

### 6.7 Shadow Backtest Settings

| Setting | Meaning |
|---|---|
| `shadowBacktestEnabled` | Enables shadow-copy simulations. |
| `shadowCopyDelayMs` | Simulated delay after source-wallet buy. |
| `shadowMaxEntryPriceMovePct` | Maximum allowed copy-entry penalty. |
| `shadowPositionSize` | Simulated shadow position size. |
| `shadowHistoryLimit` | Maximum historical trades used per wallet. |

### 6.8 Deep History Settings

| Setting | Meaning |
|---|---|
| `deepHistoryEnabled` | Enables paginated wallet history pulls. |
| `deepHistoryWalletLimit` | Number of wallets to pull deeper history for. |
| `deepHistoryPages` | Pages fetched per wallet. |
| `deepHistoryPageSize` | Trades per page. |
| `resolutionBackfillLimit` | Historical market snapshots refreshed per scan. |

---

## 7. System Architecture

### 7.1 Three-Agent Design

StratiFi is organized around three agents:

1. Signal Agent.
2. Risk Mitigation Agent.
3. Overseer Agent.

Each agent has clear responsibilities.

### 7.2 Signal Agent

The Signal Agent owns:

- Market discovery.
- Source-wallet discovery.
- Source-wallet scoring.
- Signal creation.
- Shadow backtesting.
- Wallet history backfill.
- Market metadata backfill.

It can create:

- `TRADE_CANDIDATE`
- `WATCHLIST`
- `NO_TRADE`

It cannot:

- Approve trades.
- Size positions.
- Execute paper entries.
- Manage exits.

### 7.3 Risk Mitigation Agent

The Risk Mitigation Agent owns:

- Final trade approval.
- Rejection decisions.
- Conservative/Aggressive profile evaluation.
- Position sizing.
- Exposure checks.
- Market quality checks.
- Capital lockup protection.
- Reserve cash protection.

It can return:

- `APPROVE`
- `REDUCE_SIZE`
- `REJECT`
- `PAUSE_TRADING`

### 7.4 Overseer Agent

The Overseer Agent owns:

- Monitoring open paper positions.
- Updating current marks.
- Evaluating exit rules.
- Closing paper positions.
- Writing trade updates and trade close events.

### 7.5 Provider Boundary

Agents do not call raw APIs directly. They use a `PolymarketProvider` facade.

This separates agent logic from API-specific details around:

- Gamma API.
- Data API.
- CLOB REST.
- CLOB WebSocket.

---

## 8. Data Sources

### 8.1 Gamma API

Used for:

- Active market metadata.
- Market questions.
- Outcomes.
- Token IDs.
- Market resolution fields where available.

### 8.2 Polymarket Data API

Used for:

- Public wallet trade activity.
- Wallet positions where available.
- Recent market trades.

### 8.3 CLOB REST

Used for:

- Order-book snapshots.
- Best bid/ask.
- Depth.
- Spread.

### 8.4 CLOB WebSocket

Used for:

- Market updates.
- Best bid/ask updates.
- Last-trade price updates.

---

## 9. Wallet Discovery

### 9.1 How Discovery Works

The bot scans active markets, pulls public trade activity, groups trades by wallet, and calculates wallet statistics.

It looks at:

- Trade count.
- Buy count.
- Sell count.
- Unique markets.
- Volume.
- Average trade size.
- Approximate realized PnL.
- Profit factor.
- Win rate.
- Average return.
- Drawdown.
- Hold time.
- Recent activity.
- Category consistency.
- Open-position preview where available.
- Resolved outcome history where available.

### 9.2 Wallet Discovery Filters

Weak wallets are filtered out if they fail:

- Minimum trade count.
- Minimum volume.
- Sample confidence.
- Category sample quality.
- Basic copyability checks.

### 9.3 Wallet Discovery Output

Discovered wallets are saved in SQLite and shown privately/admin-side with exact addresses. Public dashboard views show only source-strength abstractions.

### 9.4 Auto Tracking

If `autoTrackDiscoveredWallets` is enabled, strong discovered wallets can become active sources for signal generation.

---

## 10. Wallet Scoring

### 10.1 Scoring Goals

Wallet scoring is designed to answer two questions:

1. Does this wallet appear to trade well?
2. Can StratiFi realistically copy it?

### 10.2 Main Score Components

Wallet scoring includes:

- Overall reputation.
- Copyability score.
- Category consistency.
- Hot score.
- Exit behavior.
- Sample confidence.

### 10.3 Overall Reputation

Overall reputation considers:

- Trade count.
- Total volume.
- Unique markets.
- Approximate returns.
- Approximate profit factor.
- Wilson-adjusted win quality.
- Drawdown.
- Exit behavior.

### 10.4 Copyability Score

Copyability considers:

- Overall score.
- Category consistency.
- Recent activity.
- Exit behavior.
- Copyability penalties.

Copyability penalties include:

- Single-market concentration.
- No sell history.
- Very fast trading.
- High drawdown.
- Weak evidence.
- Extremely short average hold time.

### 10.5 Sample Confidence

Small samples are capped. A wallet with a tiny perfect record should not outrank a wallet with a larger, repeatable history.

Evidence caps include:

- Fewer than 5 trades cannot rank strongly.
- Fewer than 10 trades remain capped.
- Fewer than 20 trades are flagged as under the preferred category sample.
- Fewer than 3 closed trades are capped.
- Wallets with no sell history are capped.

### 10.6 Category Consistency

The bot infers market category from market text and slug.

Categories:

- Politics.
- Sports.
- Crypto.
- Macro.
- Company.
- Culture.
- Other.

A wallet can be strong in one category and weak in another.

### 10.7 Wilson Lower Bound

Win rate is adjusted using a Wilson lower-bound estimate. This prevents tiny perfect samples from being overrated.

### 10.8 Shadow Performance Adjustment

Shadow-copy performance can adjust source scores:

- Positive shadow results can modestly lift scores.
- Weak shadow results can demote scores.
- Realized shadow exits count more than fallback marks.
- Fallback-heavy samples are weaker evidence.

### 10.9 Paper Performance Adjustment

Paper-copy performance can also nudge scores:

- Positive marked paper performance can lift score.
- Negative paper performance can demote score.
- Multi-source signals split attribution.
- Higher confidence signals carry more attribution weight.
- Small samples are flagged.

---

## 11. Signal Generation

### 11.1 Signal Inputs

Signal generation uses:

- Active markets.
- Recent market trades.
- Scored source wallets.
- Market category.
- Current order books.
- Config thresholds.

### 11.2 Signal Alignment

A signal is created when one or more scored wallets buy the same market outcome.

The bot checks:

- Wallet score.
- Buy side.
- Market ID or condition ID match.
- Outcome match.
- Minimum aligned source count.
- Token ID availability.
- Limit price availability.

### 11.3 Signal Confidence

Signal confidence is built from:

- Number of aligned wallets.
- Average source score.
- Entry price component.
- Category-matched shadow performance.

### 11.4 Signal States

| State | Meaning |
|---|---|
| `TRADE_CANDIDATE` | Meets confidence threshold and can go to risk. |
| `WATCHLIST` | Interesting but below trade threshold. |
| `NO_TRADE` | Not actionable. |

---

## 12. Risk Management

### 12.1 Risk Goals

Risk management protects the paper bankroll from:

- Bad market quality.
- Excessive exposure.
- Low-confidence signals.
- Overtrading.
- Daily losses.
- Loss streaks.
- Markets too close to resolution.
- Markets too far from resolution.
- Thin order books.
- Wide spreads.

### 12.2 Market Quality Checks

Market quality rejects markets when:

- Market is inactive.
- Market is closed.
- Market is archived.
- Market is not accepting orders.
- Liquidity is too low.
- Order book is missing.
- Spread is too wide.
- Depth is too low.
- Market is too close to resolution.
- Market is too far from resolution.

### 12.3 Exposure Protection

The bot checks:

- Current open exposure.
- Maximum open exposure.
- Active exposure cap after reserve cash.
- Remaining exposure.
- Minimum position size.

### 12.4 Dust Protection

If remaining exposure is below `minPositionSize`, the bot rejects the trade instead of creating microscopic paper fills.

### 12.5 Reserve Cash

`reserveCashPct` protects a portion of bankroll from normal entries so higher-quality opportunities are not blocked by fully deployed capital.

### 12.6 Capital Lockup Protection

`maxTimeToResolutionHours` rejects far-dated markets to avoid trapping capital in slow markets.

### 12.7 Conservative Profile

Conservative profile:

- Higher confidence requirement.
- Accepts only safer risk states.
- Smaller sizing.
- Smaller exposure.

### 12.8 Aggressive Profile

Aggressive profile:

- Lower confidence requirement.
- Can accept controlled warning states.
- Larger sizing.
- Larger exposure.

---

## 13. Paper Execution

### 13.1 Order Creation

When risk approves a signal, the Paper Execution Engine creates a paper limit order.

The order includes:

- Signal ID.
- Strategy profile.
- Market ID.
- Token ID.
- Outcome.
- Side.
- Price.
- Size.
- Expiration time.

### 13.2 Fill Simulation

The engine checks executable order-book liquidity.

For buys, it fills against asks at or below the limit price.

For sells, it fills against bids at or above the limit price.

### 13.3 Partial Fills

If available liquidity is smaller than remaining order size, the order becomes `PARTIAL`.

### 13.4 Expired Orders

If the order is not filled before its TTL, it becomes `EXPIRED`.

### 13.5 Position Merging

Multiple fills into the same market/token/profile are merged into a single open position with updated average entry price.

### 13.6 Position Tracking

Positions track:

- Profile.
- Market.
- Token.
- Outcome.
- Size.
- Average entry.
- Current price.
- Realized PnL.
- Opened time.
- Updated time.
- Status.

---

## 14. Exit Management

### 14.1 Exit Inputs

The Overseer Agent evaluates:

- Current best bid.
- Last trade price.
- Current mark.
- Spread.
- Depth.
- Position age.
- Entry price.
- Exit rules.

### 14.2 Exit Triggers

Potential exit triggers:

- Take profit reached.
- Stop loss reached.
- Spread widened.
- Volume spike.
- Tracked wallet reducing.
- Price reversal from local high.
- Max hold time reached.
- Aging loser.
- Liquidity deteriorated.

### 14.3 Exit Decisions

| Decision | Meaning |
|---|---|
| `HOLD` | Keep position open. |
| `PARTIAL_EXIT` | Partial exit signal. |
| `FULL_EXIT` | Close the paper position. |

Current implementation closes full exits.

---

## 15. Shadow Copy Backtesting

### 15.1 Purpose

Shadow-copy backtesting evaluates whether StratiFi could realistically copy a wallet after detection delay and entry penalty.

### 15.2 Shadow Entry

Shadow entry:

- Starts from source buy price.
- Adds delay/copy penalty.
- Uses configured shadow position size.

### 15.3 Shadow Exit Priority

Shadow exits are selected in this order:

1. Later source sell after detection.
2. Resolved market outcome.
3. Latest observed market tape price.
4. Source-price fallback.

### 15.4 Shadow Metrics

Tracked metrics:

- Total candidates.
- Simulated trades.
- Skipped trades.
- PnL.
- Wins.
- Losses.
- Win rate.
- Average return.
- Realized exits.
- Marked exits.
- Fallback exits.
- Category performance.

### 15.5 How Shadow Results Affect Scores

Shadow results can:

- Improve source score.
- Demote source score.
- Flag low sample.
- Flag fallback-heavy evidence.
- Flag underperformance.
- Flag outperformance.

---

## 16. Dashboard

### 16.1 Local Dashboard

Run:

```powershell
npm run dashboard
```

Open:

```text
http://localhost:8787
```

### 16.2 Dashboard Sections

The dashboard includes:

- Overview.
- Order Health.
- Intelligence Trends.
- Capital Lockup.
- Wallet Discovery.
- Agent Activity.
- Profile Comparison.
- Signal Board.
- Telegram Alerts.
- Risk Review.
- Rejected Signals.
- Open Positions.
- Category Performance.
- Source Intelligence.
- Closed Trades.
- Trade Ledger.
- Treasury Simulation.
- Wallet Intelligence.

### 16.3 Public Safety

The public dashboard does not expose source wallet addresses. Source intelligence is abstracted into:

- Strength bands.
- Category.
- Evidence.
- Trade count.
- Volume band.
- Flags.
- Reliability mix.

### 16.4 Admin Dashboard API

Admin endpoint:

```text
/api/admin/dashboard
```

If `ADMIN_DASHBOARD_TOKEN` is set, access requires:

```http
Authorization: Bearer YOUR_TOKEN
```

or:

```text
/api/admin/dashboard?token=YOUR_TOKEN
```

---

## 17. Public Follower Tracker

### 17.1 Purpose

The follower tracker is designed as a public-facing page for followers to watch bot activity without exposing private source intelligence.

### 17.2 Tracker URL

```text
http://localhost:8787/tracker
```

### 17.3 Tracker API

```text
/api/tracker
```

### 17.4 Tracker Shows

The tracker displays:

- Public tracker name.
- Configured public wallet address.
- Paper equity.
- Total paper PnL.
- Available paper cash.
- Win rate.
- Live paper trade feed.
- Open paper positions.
- Recent signals.
- Closed paper trades.

### 17.5 Tracker Does Not Show

The tracker does not show:

- Source wallet addresses.
- Private admin events.
- Raw provider payloads.
- Exact source scoring internals.

### 17.6 Tracker Configuration

```env
PUBLIC_TRACKER_NAME=StratiFi Paper Tracker
PUBLIC_TRACKER_WALLET_ADDRESS=0xYourPublicWallet
PUBLIC_TRACKER_DISCLOSURE=Paper trading tracker. No live Polymarket orders are placed by this bot.
```

### 17.7 Current Tracker Limitation

The tracker currently displays paper trading data and a configured public wallet address. It does not yet fetch live on-chain wallet balances.

To make it a true live wallet tracker, the next integration should:

- Connect to the relevant chain/RPC.
- Read public wallet balances.
- Read live positions or exchange balances if available.
- Match live trades against paper/live bot events.

---

## 18. Telegram

### 18.1 Telegram Setup

Create a Telegram bot through BotFather, then set:

```env
TELEGRAM_BOT_TOKEN=your_token
```

Optional explicit chat routing:

```env
TELEGRAM_ADMIN_CHAT_ID=123456789
TELEGRAM_PUBLIC_CHAT_ID=@YourPublicChannel
```

### 18.2 Admin vs Public Routing

Admin chat receives:

- Commands.
- Risk summaries.
- Errors.
- Operational controls.

Public chat receives:

- Approved paper buy signals.
- Paper entries.
- Paper exits.

### 18.3 Telegram Commands

| Command | Purpose |
|---|---|
| `/start` | Menu and controls. |
| `/status` | Bot health and cycle stats. |
| `/scan` | Manual one-shot scan. |
| `/discover` | Discover wallet candidates. |
| `/topwallets` | Ranked wallet intelligence. |
| `/agents` | Agent activity summary. |
| `/bankroll` | Paper bankroll/equity/PnL. |
| `/pnl` | Alias for bankroll. |
| `/ledger` | Paper trade PnL and balance trail. |
| `/performance` | Paper PnL report. |
| `/positions` | Open paper positions. |
| `/close <number-or-id>` | Close one paper position. |
| `/closeall` | Close every open paper position after confirmation. |
| `/shadow` | Shadow-copy report. |
| `/risk` | Risk configuration. |
| `/risklog` | Recent risk decisions and blockers. |
| `/wallets` | Tracked/discovered wallets. |
| `/pause` | Pause scheduled cycles. |
| `/resume` | Resume scheduled cycles. |

### 18.4 Telegram Trade Alerts

Paper entry alerts include:

- Outcome.
- Market.
- Entry price.
- Size.
- Shares.
- Trade PnL.
- Total PnL.
- Equity.
- Available cash.

Paper exit alerts include:

- Outcome.
- Market.
- Exit mark.
- Exit value.
- Realized trade PnL.
- Total PnL.
- Equity.
- Available cash.
- Exit reason.

---

## 19. Paper Trade Ledger

### 19.1 SQLite Source of Truth

Paper trading data is persisted in SQLite.

Important tables:

- `paper_orders`
- `paper_fills`
- `positions`
- `signals`
- `risk_events`
- `exit_events`

### 19.2 CSV Export

The bot also exports a single CSV file:

```text
data/paper-trade-ledger.csv
```

### 19.3 CSV Columns

The CSV includes:

- `created_at_iso`
- `created_at_ms`
- `type`
- `profile`
- `market_id`
- `outcome`
- `price`
- `shares`
- `notional_usd`
- `realized_pnl_usd`
- `unrealized_pnl_usd`
- `total_pnl_usd`
- `equity_usd`
- `available_cash_usd`

### 19.4 Automatic Export

During `npm run dev`, the CSV refreshes after paper entries and exits.

### 19.5 Manual Export

```powershell
npm run export-ledger
```

### 19.6 Why the CSV Matters

The CSV gives you one simple dataset for:

- Reviewing performance.
- Sharing paper results.
- Building analytics.
- Importing into Notion, Sheets, or BI tools.
- Backtesting strategy improvements.
- Auditing decisions.

---

## 20. Database Model

### 20.1 `tracked_wallets`

Stores manually configured wallets.

### 20.2 `wallet_scores`

Stores latest source-wallet score state.

### 20.3 `discovered_wallets`

Stores wallets discovered from public Polymarket activity.

### 20.4 `markets`

Stores market metadata, outcomes, token IDs, resolution fields, and raw payloads.

### 20.5 `orderbook_snapshots`

Stores order book snapshots for analysis and execution simulation.

### 20.6 `signals`

Stores generated trade signals.

### 20.7 `risk_events`

Stores risk decisions and rejection reasons.

### 20.8 `paper_orders`

Stores paper limit orders.

### 20.9 `paper_fills`

Stores simulated fills.

### 20.10 `positions`

Stores open and closed paper positions.

### 20.11 `exit_events`

Stores exit decisions.

### 20.12 `agent_events`

Stores public/private agent event ledger.

### 20.13 `wallet_trades`

Stores normalized source-wallet trade history.

### 20.14 `source_score_snapshots`

Stores score history for source drift and degradation analysis.

### 20.15 `shadow_trades`

Stores shadow-copy simulations.

### 20.16 `paper_source_feedback`

Stores source-score feedback from paper performance.

---

## 21. Operational Workflow

### 21.1 Local Development Workflow

1. Install dependencies.
2. Configure `.env`.
3. Run one scan.
4. Review output.
5. Start continuous bot.
6. Start dashboard.
7. Monitor Telegram and dashboard.

Commands:

```powershell
npm install
npm run scan
npm run dev
npm run dashboard
```

### 21.2 Recommended Runtime Setup

Use separate terminals:

Terminal 1:

```powershell
npm run dev
```

Terminal 2:

```powershell
npm run dashboard
```

### 21.3 Avoiding Duplicate Bot Loops

Only run one `npm run dev` loop per SQLite database. Multiple bot loops can create SQLite write contention or duplicate paper behavior.

The `predev` hook kills the previous recorded dev bot process to reduce this risk.

### 21.4 Handling Fetch Failures

Occasional `fetch failed` errors can happen because of:

- Provider timeout.
- Network hiccup.
- API rate limits.
- Temporary Polymarket/Gamma issues.
- WebSocket instability.

The bot catches errors and continues on future cycles.

### 21.5 Checking If Bot Is Running

Options:

- Check the terminal running `npm run dev`.
- Use Telegram `/status`.
- Check dashboard updates.
- Check for Node processes.
- Check recent rows in SQLite or CSV ledger.

---

## 22. Public Launch Checklist

### 22.1 Before Sharing Tracker

Confirm:

- Public tracker name is set.
- Public wallet address is set.
- Disclosure text is accurate.
- Dashboard server is running.
- Paper data is updating.
- Source wallet addresses are not exposed.
- Telegram routing is correct.

### 22.2 Suggested Disclosure

```text
This is a public paper-trading tracker. It shows simulated trading activity and research signals. It is not financial advice and does not represent live order execution.
```

### 22.3 What Followers Can See

Followers can see:

- Paper balance.
- Paper PnL.
- Open paper positions.
- Closed paper trades.
- Recent signals.
- Running trade feed.

### 22.4 What Followers Should Not See

Followers should not see:

- Source wallet addresses.
- Private admin controls.
- Raw provider payloads.
- Internal scoring payloads.
- API keys.
- Telegram admin chat IDs.

---

## 23. Troubleshooting

### 23.1 `fetch failed`

Usually means an external API request failed temporarily. If the bot continues running, this is not fatal.

Actions:

- Wait for next cycle.
- Check internet connection.
- Check provider status.
- Reduce scan aggressiveness.
- Increase scan interval.

### 23.2 `database is locked`

Usually means multiple processes are writing to SQLite.

Actions:

- Stop duplicate bot loops.
- Run only one `npm run dev`.
- Dashboard can run alongside the bot, but extra bot loops should not.

### 23.3 Telegram Does Not Respond

Check:

- `TELEGRAM_BOT_TOKEN`.
- Bot has received `/start`.
- Admin chat ID.
- Network.
- Bot process is running.

### 23.4 Public Channel Alerts Do Not Send

Check:

- `TELEGRAM_PUBLIC_CHAT_ID`.
- Bot is added to the channel.
- Bot has permission to post.
- Channel username uses `@ChannelUsername`.

### 23.5 Dashboard Does Not Start

Check:

- Port `8787` availability.
- Node/npm install.
- TypeScript errors with `npm run typecheck`.
- Runtime errors in dashboard logs.

### 23.6 `spawn EPERM` With `tsx`

This can occur in restricted sandbox environments when `tsx`/`esbuild` cannot spawn a helper process.

In a normal local terminal, run:

```powershell
npm run dashboard
```

or:

```powershell
npm run dev
```

### 23.7 CSV Ledger Missing

Run:

```powershell
npm run export-ledger
```

Check:

```text
data/paper-trade-ledger.csv
```

---

## 24. Security and Privacy

### 24.1 Current Security Posture

The bot is paper-only and does not use private keys.

### 24.2 Sensitive Data

Sensitive data includes:

- `.env`.
- Telegram token.
- Supabase service role key.
- Admin dashboard token.
- Source wallet addresses.
- Raw provider payloads.

### 24.3 Git Safety

The repo ignores:

- `.env`
- `.env.*`
- `data/`
- `node_modules/`
- logs

### 24.4 Public Dashboard Safety

Public dashboard and tracker read models are designed to avoid exposing source wallet addresses.

### 24.5 Admin Dashboard Safety

The admin dashboard can expose private intelligence. Protect it with:

```env
ADMIN_DASHBOARD_TOKEN=strong-secret-token
```

---

## 25. Testing

### 25.1 Typecheck

```powershell
npm run typecheck
```

### 25.2 Unit Tests

```powershell
npm run test
```

Current tests cover:

- Wallet scoring.
- Wallet discovery.
- Resolved market attribution.
- Market quality.
- Signal generation.
- Risk decisions.
- Paper execution.
- Position merging.
- Profile performance.
- Order health.
- Paper source attribution.
- Intelligence trends.
- Exit logic.
- Agent event persistence.
- Wallet trade history dedupe.
- Shadow backtesting.
- Public dashboard privacy.
- Telegram routing.

---

## 26. Current Limitations

### 26.1 Paper Only

The system does not place live orders.

### 26.2 Approximate Wallet PnL

Public wallet history may miss older entries or exits. Approximate PnL should be treated as a ranking signal, not proof.

### 26.3 Resolution Coverage

Resolved outcome analysis depends on provider payload coverage. The system has improved winner parsing, but some markets may still lack clean resolution data.

### 26.4 Public Tracker Balance

The tracker currently displays paper balance and a configured public wallet address. It does not yet fetch a real wallet balance.

### 26.5 Shadow Backtest Quality

Shadow-copy backtests are useful but not perfect. Fallback-heavy samples are weaker than realized source exits.

### 26.6 Live Trading Readiness

Live trading requires additional work:

- Key management.
- Signing.
- Real order placement.
- Real order cancellation.
- Live balance reconciliation.
- Fail-safe kill switches.
- Stronger monitoring.
- More forward-tested paper data.

---

## 27. Roadmap

### 27.1 Immediate Next Steps

1. Run continuous paper trading to collect forward data.
2. Tune source scoring thresholds.
3. Tune risk settings based on rejected-signal logs.
4. Improve tracker publishing/deployment.
5. Add real public wallet balance integration.

### 27.2 Intelligence Improvements

1. Improve full source position reconstruction.
2. Expand resolved-market reconciliation.
3. Track wallet degradation over longer windows.
4. Demote wallets whose paper-copy performance underperforms raw history.
5. Add richer category-level trend analytics.

### 27.3 Product Improvements

1. Publish follower tracker publicly.
2. Add follower-friendly trade explanations.
3. Add weekly performance summaries.
4. Add downloadable CSV from dashboard.
5. Add shareable public performance cards.

### 27.4 Live Trading Prerequisites

Before live trading:

1. Collect enough forward paper trades.
2. Review strategy performance by category.
3. Confirm drawdown behavior.
4. Validate order execution assumptions.
5. Add live-wallet balance tracking.
6. Add secure key management.
7. Add hard kill switch.
8. Add live order reconciliation.

---

## 28. Client-Facing Summary

StratiFi is now a paper-trading intelligence system for Polymarket. It discovers wallets, scores them for realistic copyability, generates trade candidates, applies risk controls, simulates entries and exits, logs every paper trade, tracks running paper balance, and exposes results through Telegram, dashboard, follower tracker, and CSV exports.

The system is designed to build enough forward paper-trading data before enabling any live trading. This keeps the strategy transparent, testable, and safer to evaluate.

The next major product step is turning the follower tracker into a public-facing live performance page, then connecting a real public wallet balance once live trading infrastructure is intentionally added.
