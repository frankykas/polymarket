import { loadBotConfig, loadRuntimeEnv } from "./config.js";
import { BotDatabase } from "./db.js";
import { runShadowBacktest, summarizeShadowPerformanceByWallet } from "./shadowBacktest.js";
import type { BotConfig, MarketSnapshot, WalletTrade } from "./types.js";

// Latency sensitivity of the copy edge.
//
// The project thesis is "which wallets can be realistically followed at our size,
// WITH OUR LATENCY". The shadow model assumes shadowCopyDelayMs (10s), but measured
// copy lag on filled entries is ~25 minutes -- the model certifies wallets at a copy
// speed the bot does not have. This re-runs the same source history at a range of
// assumed latencies so the edge can be read off as a function of delay rather than
// assumed away.
//
// Latency enters twice: it penalises the entry price, and it moves `detectedAt`,
// which decides whether a source sell happened late enough for us to have mirrored
// it. Both matter, so the whole backtest is re-run per latency rather than adjusting
// a summary figure.

const baseConfig = loadBotConfig();
const env = loadRuntimeEnv();
const db = new BotDatabase(env.dbPath);

const LATENCIES_MS = [10_000, 60_000, 300_000, 900_000, 1_530_000, 3_600_000];
const WALLET_LIMIT = Number(process.env.LATENCY_WALLET_LIMIT || 25);
const HISTORY_LIMIT = Number(process.env.LATENCY_HISTORY_LIMIT || 1500);

try {
  const wallets = db.getWalletsWithShadowEvidence(WALLET_LIMIT);
  if (wallets.length === 0) {
    console.log("No wallets with shadow evidence yet.");
  } else {
    run(wallets);
  }
} finally {
  db.close();
}

function run(wallets: string[]): void {
  const histories = new Map<string, WalletTrade[]>();
  const marketIds = new Set<string>();
  for (const wallet of wallets) {
    const trades = db.getWalletTradeHistory(wallet, HISTORY_LIMIT);
    if (trades.length === 0) continue;
    histories.set(wallet, trades);
    for (const trade of trades) {
      if (trade.marketId) marketIds.add(trade.marketId);
      if (trade.conditionId) marketIds.add(trade.conditionId);
    }
  }
  const markets: MarketSnapshot[] = db.getMarketsByIds([...marketIds]);

  console.log("Copy-Edge Latency Sensitivity");
  console.log(`Wallets: ${histories.size}  |  history/wallet: up to ${HISTORY_LIMIT} trades  |  markets: ${markets.length}`);
  console.log(`Configured shadowCopyDelayMs: ${baseConfig.shadowCopyDelayMs}ms  |  measured live copy lag: ~25.5 min`);
  console.log("");
  console.log(
    "assumed lag".padEnd(14) + "exec".padStart(8) + "win%".padStart(8) +
    "avgRet%".padStart(10) + "pnl".padStart(12) + "  gate(ret>3% & win>=45%)"
  );
  console.log("-".repeat(74));

  const minReturn = baseConfig.liveExecutableMinReturnPct ?? 0.03;
  const minWinRate = baseConfig.minLiveExecutableShadowWinRateForTrading ?? 0.45;

  for (const latency of LATENCIES_MS) {
    const config: BotConfig = { ...baseConfig, shadowCopyDelayMs: latency };
    const all = [];
    for (const [wallet, trades] of histories) {
      all.push(...runShadowBacktest(wallet, trades, markets, config, Date.now()));
    }
    const perf = summarizeShadowPerformanceByWallet(all);

    let execN = 0;
    let execPnl = 0;
    let retSum = 0;
    let wins = 0;
    let decided = 0;
    let walletsPassing = 0;
    for (const p of perf.values()) {
      const n = p.liveExecutableSimulated ?? 0;
      const pnl = p.liveExecutablePnl ?? 0;
      const ret = p.liveExecutableAvgReturnPct ?? 0;
      const winRate = p.liveExecutableWinRate ?? 0;
      execN += n;
      execPnl += pnl;
      retSum += ret * n;
      if (n > 0) {
        wins += winRate * n;
        decided += n;
      }
      if (n >= 3 && pnl > 0 && ret > minReturn && winRate >= minWinRate) walletsPassing += 1;
    }
    const avgRet = execN > 0 ? (retSum / execN) * 100 : 0;
    const winPct = decided > 0 ? (wins / decided) * 100 : 0;
    console.log(
      `${formatLag(latency)}`.padEnd(14) +
      String(execN).padStart(8) +
      `${winPct.toFixed(1)}`.padStart(8) +
      `${avgRet.toFixed(2)}`.padStart(10) +
      `$${execPnl.toFixed(2)}`.padStart(12) +
      `  ${walletsPassing} wallet(s)`
    );
  }

  console.log("");
  console.log("Same source history throughout; only the assumed copy delay changes.");
  console.log("If the edge only exists at low assumed latency, it is not reachable at the lag we actually run at.");
}

function formatLag(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}
