import { DatabaseSync } from "node:sqlite";
import { loadBotConfig, loadRuntimeEnv } from "./config.js";
import type { BotConfig } from "./types.js";

// Counterfactual exit-policy replay.
//
// Exits are the single largest measured cost in the paper record: stop-outs account
// for essentially all realised losses while take-profits are strongly positive. That
// comparison is confounded, though -- a position that hit the stop is by definition
// one that moved against us, so "positions held longer do better" is partly
// survivorship. The only way to separate policy from selection is to hold the entry
// set fixed and re-run the same positions under different exit rules against the
// price path we actually observed.
//
// The `current` policy is replayed alongside the alternatives as a calibration
// check: if it does not roughly reproduce the realised PnL for the same positions,
// the harness is not modelling the live engine faithfully and the other columns
// should not be trusted.

interface PricePoint {
  t: number;
  bid: number;
}

interface ReplayPosition {
  id: string;
  marketId: string;
  tokenId: string;
  outcome: string;
  entryPrice: number;
  size: number;
  openedAt: number;
  closedAt: number;
  actualPnl: number;
  path: PricePoint[];
  sourceSellAt?: number;
}

interface PolicyResult {
  name: string;
  trades: number;
  wins: number;
  pnl: number;
  avgPnl: number;
  avgHoldMin: number;
  exitCounts: Record<string, number>;
}

const config = loadBotConfig();
const env = loadRuntimeEnv();
const db = new DatabaseSync(env.dbPath, { readOnly: true });

const HOLD_CAP_MS = (config.maxPositionHoldHours > 0 ? config.maxPositionHoldHours : 168) * 3_600_000;
const PATH_WINDOW_MS = Math.min(HOLD_CAP_MS, 12 * 3_600_000);
const MIN_PATH_POINTS = 5;

try {
  const positions = loadPositions();
  if (positions.length === 0) {
    console.log("No closed positions with usable order-book paths. Order-book retention may be too short.");
  } else {
    report(positions);
  }
} finally {
  db.close();
}

function loadPositions(): ReplayPosition[] {
  const rows = db.prepare(`
    SELECT id, market_id, token_id, outcome, avg_entry_price, size, opened_at, updated_at, realized_pnl
    FROM positions
    WHERE status='CLOSED' AND size > 0 AND avg_entry_price > 0
    ORDER BY opened_at DESC
  `).all() as unknown as Array<{
    id: string; market_id: string; token_id: string; outcome: string;
    avg_entry_price: number; size: number; opened_at: number; updated_at: number; realized_pnl: number;
  }>;

  // Path comes from the Overseer's own exit evaluations, not order-book snapshots.
  // Books are only persisted when the cached copy goes stale, so a position that
  // closes inside 30 minutes leaves ~0.2 snapshots behind and its drawdown is
  // invisible -- replaying against those produces a survivor-only sample that
  // fires no stops. Exit evaluations run on every Overseer pass for every open
  // position, so they capture the path at the granularity decisions were made.
  const pathStmt = db.prepare(`
    SELECT created_at AS t, best_bid AS bid
    FROM exit_events
    WHERE position_id = ? AND best_bid IS NOT NULL
    ORDER BY created_at ASC
  `);

  // The seeding wallets live on the signal that produced the entry order, so walk
  // position -> order -> signal to find who we were following, then look for the
  // first sell any of them made in the same market/outcome after we opened.
  const walletStmt = db.prepare(`
    SELECT s.aligned_wallets_json AS wallets
    FROM paper_orders o JOIN signals s ON s.id = o.signal_id
    WHERE o.side='BUY' AND o.market_id = ? AND o.token_id = ?
    ORDER BY ABS(o.created_at - ?) ASC LIMIT 1
  `);

  const sellStmt = db.prepare(`
    SELECT MIN(timestamp) AS t FROM wallet_trades
    WHERE side='SELL' AND market_id = ? AND lower(outcome) = lower(?)
      AND timestamp > ? AND lower(wallet) IN (SELECT value FROM json_each(?))
  `);

  const out: ReplayPosition[] = [];
  let skipped = 0;
  for (const row of rows) {
    const path = (pathStmt.all(row.id) as unknown as PricePoint[])
      .filter((p) => p.t >= row.opened_at && p.t <= row.opened_at + PATH_WINDOW_MS);
    if (path.length < MIN_PATH_POINTS) {
      skipped += 1;
      continue;
    }

    let sourceSellAt: number | undefined;
    const walletRow = walletStmt.get(row.market_id, row.token_id, row.opened_at) as unknown as { wallets?: string } | undefined;
    if (walletRow?.wallets) {
      try {
        const lowered = JSON.stringify((JSON.parse(walletRow.wallets) as string[]).map((w) => w.toLowerCase()));
        const sell = sellStmt.get(row.market_id, row.outcome, row.opened_at, lowered) as unknown as { t: number | null } | undefined;
        if (sell?.t) sourceSellAt = sell.t;
      } catch {
        // malformed wallet json -- treat as no observed source exit
      }
    }

    out.push({
      id: row.id,
      marketId: row.market_id,
      tokenId: row.token_id,
      outcome: row.outcome,
      entryPrice: row.avg_entry_price,
      size: row.size,
      openedAt: row.opened_at,
      closedAt: row.updated_at,
      actualPnl: row.realized_pnl,
      path,
      sourceSellAt
    });
  }
  if (skipped > 0) {
    console.log(`Note: ${skipped} closed position(s) skipped for having fewer than ${MIN_PATH_POINTS} recorded marks.`);
    console.log("Positions closed before exit-mark recording was added will never qualify.");
    console.log("");
  }
  return out;
}

type ExitRule = (ctx: {
  point: PricePoint;
  position: ReplayPosition;
  cost: number;
  heldMs: number;
}) => string | undefined;

function policies(cfg: BotConfig): Array<{ name: string; rule: ExitRule }> {
  const tp = cfg.takeProfitAbs ?? 0.1;
  const stop = cfg.stopLossAbs ?? 0.1;
  return [
    {
      name: "current (abs stop 0.10)",
      rule: ({ point, position }) => {
        const move = point.bid - position.entryPrice;
        if (move <= -stop) return "stop";
        if (move >= tp) return "take-profit";
        return undefined;
      }
    },
    {
      name: "no stop",
      rule: ({ point, position }) => (point.bid - position.entryPrice >= tp ? "take-profit" : undefined)
    },
    {
      name: "wide abs stop 0.20",
      rule: ({ point, position }) => {
        const move = point.bid - position.entryPrice;
        if (move <= -0.2) return "stop";
        if (move >= tp) return "take-profit";
        return undefined;
      }
    },
    {
      name: "notional stop 20%",
      rule: ({ point, position, cost }) => {
        const pnl = position.size * (point.bid - position.entryPrice);
        if (pnl <= -0.2 * cost) return "stop";
        if (point.bid - position.entryPrice >= tp) return "take-profit";
        return undefined;
      }
    },
    {
      name: "notional stop 35%",
      rule: ({ point, position, cost }) => {
        const pnl = position.size * (point.bid - position.entryPrice);
        if (pnl <= -0.35 * cost) return "stop";
        if (point.bid - position.entryPrice >= tp) return "take-profit";
        return undefined;
      }
    },
    {
      name: "source-follow only",
      rule: () => undefined
    }
  ];
}

function simulate(position: ReplayPosition, rule: ExitRule, useSourceExit = true): { pnl: number; exitReason: string; heldMs: number } {
  const cost = position.size * position.entryPrice;
  for (const point of position.path) {
    const heldMs = point.t - position.openedAt;
    if (useSourceExit && position.sourceSellAt !== undefined && point.t >= position.sourceSellAt) {
      return { pnl: position.size * (point.bid - position.entryPrice), exitReason: "source-sell", heldMs };
    }
    const triggered = rule({ point, position, cost, heldMs });
    if (triggered) {
      return { pnl: position.size * (point.bid - position.entryPrice), exitReason: triggered, heldMs };
    }
    if (heldMs >= HOLD_CAP_MS) break;
  }
  const last = position.path[position.path.length - 1];
  return {
    pnl: position.size * (last.bid - position.entryPrice),
    exitReason: "horizon",
    heldMs: last.t - position.openedAt
  };
}

function report(positions: ReplayPosition[]): void {
  const withSource = positions.filter((p) => p.sourceSellAt !== undefined).length;
  console.log("Counterfactual Exit-Policy Replay");
  console.log(`Database: ${env.dbPath}`);
  console.log(`Positions replayed: ${positions.length} (${withSource} with an observed source sell)`);
  console.log(`Path window: ${(PATH_WINDOW_MS / 3_600_000).toFixed(0)}h  |  hold cap: ${(HOLD_CAP_MS / 3_600_000).toFixed(0)}h`);
  console.log(`Actual realised PnL on this same set: $${positions.reduce((s, p) => s + p.actualPnl, 0).toFixed(2)}`);
  console.log("");

  const results: PolicyResult[] = [];
  for (const { name, rule } of policies(config)) {
    const sims = positions.map((p) => simulate(p, rule));
    const pnl = sims.reduce((s, r) => s + r.pnl, 0);
    const wins = sims.filter((r) => r.pnl > 0).length;
    const exitCounts: Record<string, number> = {};
    for (const r of sims) exitCounts[r.exitReason] = (exitCounts[r.exitReason] ?? 0) + 1;
    results.push({
      name,
      trades: sims.length,
      wins,
      pnl,
      avgPnl: pnl / sims.length,
      avgHoldMin: sims.reduce((s, r) => s + r.heldMs, 0) / sims.length / 60_000,
      exitCounts
    });
  }

  const pad = (s: string, n: number) => s.padEnd(n);
  const padL = (s: string, n: number) => s.padStart(n);
  console.log(`${pad("policy", 26)}${padL("trades", 7)}${padL("win%", 7)}${padL("PnL", 10)}${padL("avg", 8)}${padL("hold(m)", 9)}  exits`);
  console.log("-".repeat(96));
  for (const r of results.sort((a, b) => b.pnl - a.pnl)) {
    const exits = Object.entries(r.exitCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(" ");
    console.log(
      pad(r.name, 26) + padL(String(r.trades), 7) + padL(`${((r.wins / r.trades) * 100).toFixed(1)}%`, 7) +
      padL(`$${r.pnl.toFixed(2)}`, 10) + padL(`$${r.avgPnl.toFixed(2)}`, 8) +
      padL(r.avgHoldMin.toFixed(0), 9) + "  " + exits
    );
  }

  const current = results.find((r) => r.name.startsWith("current"));
  const actual = positions.reduce((s, p) => s + p.actualPnl, 0);
  console.log("");
  console.log("Calibration");
  console.log(`  replayed 'current' policy: $${(current?.pnl ?? 0).toFixed(2)}`);
  console.log(`  actual realised:           $${actual.toFixed(2)}`);
  console.log(`  gap:                       $${((current?.pnl ?? 0) - actual).toFixed(2)}`);
  console.log("  A large gap means the harness is not reproducing the live engine; treat other rows with caution.");
  console.log("");
  console.log("Replay exits fill at the observed best bid, applied identically to every policy.");
  console.log("Entries are held fixed, so differences are attributable to the exit rule alone.");
}
