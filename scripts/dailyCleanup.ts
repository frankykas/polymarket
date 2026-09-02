import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadBotConfig, loadRuntimeEnv } from "../src/config.js";

interface CleanupOptions {
  apply: boolean;
  keepDays: number;
  keepRows: number;
  vacuum: boolean;
}

interface TableRule {
  table: string;
  column: string;
  keepRows: number;
  keepDays?: number;
  reason: string;
  /** Rows that are promotion/audit evidence and must never be aged out. */
  preserveWhere?: string;
}

const options = parseOptions(process.argv.slice(2));
const env = loadRuntimeEnv();
const config = loadBotConfig();
const dbPath = resolve(env.dbPath);
const dataDir = resolve(dirname(dbPath));
const performanceStartAt = Math.max(0, config.performanceStartAt ?? 0);

const tableRules: TableRule[] = [
  { table: "orderbook_snapshots", column: "created_at", keepRows: Math.min(options.keepRows, 1000), keepDays: options.keepDays, reason: "high-volume market microstructure snapshots" },
  { table: "bot_run_logs", column: "created_at", keepRows: Math.min(options.keepRows, 800), keepDays: options.keepDays, reason: "runtime log history" },
  { table: "agent_events", column: "created_at", keepRows: Math.min(options.keepRows, 800), keepDays: options.keepDays, reason: "agent narration/event history" },
  { table: "risk_events", column: "created_at", keepRows: Math.min(options.keepRows, 1000), keepDays: options.keepDays, reason: "non-economic risk decision history", preserveWhere: "signal_id IN (SELECT signal_id FROM paper_orders WHERE side = 'BUY')" },
  {
    table: "signals", column: "created_at", keepRows: Math.min(options.keepRows, 1000), keepDays: options.keepDays,
    reason: "unselected signal/watchlist history",
    preserveWhere: `id IN (SELECT signal_id FROM paper_orders WHERE side = 'BUY')
      OR id IN (SELECT signal_id FROM weather_opportunities WHERE signal_id IS NOT NULL AND status IN ('SELECTED', 'RESOLVED'))
      OR id IN (SELECT signal_id FROM strategy_opportunities WHERE signal_id IS NOT NULL AND status IN ('RESEARCH_SELECTED', 'SELECTED', 'RESOLVED'))`
  },
  { table: "source_score_snapshots", column: "created_at", keepRows: Math.min(options.keepRows, 1200), keepDays: options.keepDays, reason: "source score time series" },
  { table: "shadow_trades", column: "created_at", keepRows: Math.min(options.keepRows, 2500), keepDays: options.keepDays, reason: "shadow simulation history", preserveWhere: "forward_eligible = 1" },
  {
    table: "wallet_trades", column: "timestamp", keepRows: Math.min(options.keepRows, 3000), keepDays: options.keepDays,
    reason: "pre-epoch source-wallet history",
    preserveWhere: performanceStartAt > 0 ? `timestamp >= ${performanceStartAt}` : undefined
  },
  // Orders, fills, exit decisions, and paper attribution are the economic
  // ledger. They are intentionally absent from retention rules: deleting any
  // of them makes strategy/category P&L and execution parity unreproducible.
  { table: "weather_opportunities", column: "created_at", keepRows: Math.min(options.keepRows, 2500), keepDays: options.keepDays, reason: "independent weather opportunity history", preserveWhere: "status IN ('SELECTED', 'RESOLVED')" },
  { table: "strategy_opportunities", column: "created_at", keepRows: Math.min(options.keepRows, 2500), keepDays: options.keepDays, reason: "independent strategy opportunity history", preserveWhere: "status IN ('SELECTED', 'RESOLVED')" },
  { table: "strategy_backtests", column: "created_at", keepRows: Math.min(options.keepRows, 1000), keepDays: Math.max(options.keepDays, 30), reason: "independent strategy validation history" }
];

const generatedFilePatterns = [
  /^paper-trade-ledger\..*\.csv$/,
  /^dashboard-snapshot\..*\.json$/,
  /^health\..*\.json$/,
  /\.tmp$/,
  /\.bak$/
];

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/database is locked/i.test(message)) {
    console.error("Cleanup could not acquire the SQLite write lock.");
    console.error("Stop pmarke-bot first, or run: systemctl start pmarke-cleanup.service");
    process.exit(2);
  }
  throw error;
}

function main(): void {
  console.log(`StratiFi daily cleanup (${options.apply ? "apply" : "dry-run"})`);
  console.log(`DB: ${dbPath}`);
  console.log(`Policy: keep newest ${options.keepRows} rows max, keep rows from last ${options.keepDays} day(s), preserve economic and forward evidence.`);

  if (!existsSync(dbPath)) {
    console.log("No SQLite DB found. Cleaning generated files only.");
    cleanupGeneratedFiles();
    return;
  }

  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 30000");
    for (const rule of tableRules) cleanupTable(db, rule);
    cleanupGeneratedFiles();
    if (options.apply) {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      if (options.vacuum) {
        console.log("VACUUM starting. This can take a while and needs free disk space.");
        db.exec("VACUUM");
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      }
    }
  } finally {
    db.close();
  }
  console.log("Done.");
}

function cleanupTable(db: DatabaseSync, rule: TableRule): void {
  if (!tableExists(db, rule.table)) {
    console.log(`${rule.table}: skipped, table missing`);
    return;
  }
  const before = countRows(db, rule.table);
  const cutoff = Date.now() - rule.keepDays * 24 * 60 * 60 * 1000;
  const preserveClause = rule.preserveWhere ? `AND NOT (${rule.preserveWhere})` : "";
  const removable = db.prepare(`
    SELECT COUNT(*) as count
    FROM ${rule.table}
    WHERE ${rule.column} < ?
      ${preserveClause}
      AND rowid NOT IN (
        SELECT rowid FROM ${rule.table}
        ORDER BY ${rule.column} DESC
        LIMIT ?
      )
  `).get(cutoff, rule.keepRows) as { count: number };
  const removeCount = Number(removable.count ?? 0);
  console.log(`${rule.table}: ${before} rows, remove ${removeCount} (${rule.reason})`);
  if (!options.apply || removeCount === 0) return;
  db.prepare(`
    DELETE FROM ${rule.table}
    WHERE ${rule.column} < ?
      ${preserveClause}
      AND rowid NOT IN (
        SELECT rowid FROM ${rule.table}
        ORDER BY ${rule.column} DESC
        LIMIT ?
      )
  `).run(cutoff, rule.keepRows);
  console.log(`${rule.table}: ${before} -> ${countRows(db, rule.table)}`);
}

function cleanupGeneratedFiles(): void {
  if (!existsSync(dataDir)) return;
  for (const name of readdirSync(dataDir)) {
    if (!generatedFilePatterns.some((pattern) => pattern.test(name))) continue;
    const path = join(dataDir, name);
    if (!statSync(path).isFile()) continue;
    console.log(`generated file: ${path}${options.apply ? " removed" : " would remove"}`);
    if (options.apply) rmSync(path, { force: true });
  }
}

function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { name: string } | undefined;
  return Boolean(row);
}

function countRows(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as { count: number };
  return Number(row.count ?? 0);
}

function parseOptions(args: string[]): CleanupOptions {
  const apply = args.includes("--apply");
  const vacuum = args.includes("--vacuum");
  return {
    apply,
    vacuum,
    keepDays: numberArg(args, "--keep-days", 1),
    keepRows: numberArg(args, "--keep-rows", 3000)
  };
}

function numberArg(args: string[], name: string, fallback: number): number {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(args[index + 1]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
