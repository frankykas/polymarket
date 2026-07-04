import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadRuntimeEnv } from "../src/config.js";

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
}

const options = parseOptions(process.argv.slice(2));
const env = loadRuntimeEnv();
const dbPath = resolve(env.dbPath);
const dataDir = resolve(dirname(dbPath));

const tableRules: TableRule[] = [
  { table: "orderbook_snapshots", column: "created_at", keepRows: Math.min(options.keepRows, 1000), keepDays: options.keepDays, reason: "high-volume market microstructure snapshots" },
  { table: "bot_run_logs", column: "created_at", keepRows: Math.min(options.keepRows, 800), keepDays: options.keepDays, reason: "runtime log history" },
  { table: "agent_events", column: "created_at", keepRows: Math.min(options.keepRows, 800), keepDays: options.keepDays, reason: "agent narration/event history" },
  { table: "risk_events", column: "created_at", keepRows: Math.min(options.keepRows, 1000), keepDays: options.keepDays, reason: "risk decision history" },
  { table: "signals", column: "created_at", keepRows: Math.min(options.keepRows, 1000), keepDays: options.keepDays, reason: "signal history" },
  { table: "source_score_snapshots", column: "created_at", keepRows: Math.min(options.keepRows, 1200), keepDays: options.keepDays, reason: "source score time series" },
  { table: "shadow_trades", column: "created_at", keepRows: Math.min(options.keepRows, 2500), keepDays: options.keepDays, reason: "shadow simulation history" },
  { table: "wallet_trades", column: "timestamp", keepRows: Math.min(options.keepRows, 3000), keepDays: options.keepDays, reason: "source wallet raw trade history" },
  { table: "paper_source_feedback", column: "created_at", keepRows: Math.min(options.keepRows, 800), keepDays: options.keepDays, reason: "paper source feedback history" },
  { table: "paper_fills", column: "timestamp", keepRows: Math.min(options.keepRows, 1500), keepDays: options.keepDays, reason: "paper fill history" },
  { table: "paper_orders", column: "created_at", keepRows: Math.min(options.keepRows, 1500), keepDays: options.keepDays, reason: "paper order history" },
  { table: "exit_events", column: "created_at", keepRows: Math.min(options.keepRows, 800), keepDays: options.keepDays, reason: "position exit decision history" }
];

const generatedFilePatterns = [
  /^polymarket-paper-bot\.dev\.pid$/,
  /^paper-trade-ledger\..*\.csv$/,
  /^dashboard-snapshot\..*\.json$/,
  /^health\..*\.json$/,
  /\.tmp$/,
  /\.bak$/
];

main();

function main(): void {
  console.log(`StratiFi daily cleanup (${options.apply ? "apply" : "dry-run"})`);
  console.log(`DB: ${dbPath}`);
  console.log(`Policy: keep newest ${options.keepRows} rows max, keep rows from last ${options.keepDays} day(s), preserve current state tables.`);

  if (!existsSync(dbPath)) {
    console.log("No SQLite DB found. Cleaning generated files only.");
    cleanupGeneratedFiles();
    return;
  }

  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 30000");
    db.exec("PRAGMA journal_mode = DELETE");
    for (const rule of tableRules) cleanupTable(db, rule);
    cleanupGeneratedFiles();
    if (options.apply) {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      if (options.vacuum) {
        console.log("VACUUM starting. This can take a while and needs free disk space.");
        db.exec("VACUUM");
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
  const removable = db.prepare(`
    SELECT COUNT(*) as count
    FROM ${rule.table}
    WHERE ${rule.column} < ?
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
