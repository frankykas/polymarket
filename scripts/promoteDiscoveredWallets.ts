import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadDotEnv } from "../src/config.js";
import type { TrackedWallet } from "../src/types.js";

interface CandidateRow {
  address: string;
  score: number;
  copyability_score: number;
  hot_score: number;
  category_consistency_score: number;
  sample_confidence: number;
  dominant_category: string | null;
  trade_count: number;
  unique_markets: number;
  total_volume: number;
  realized_pnl_approx: number;
}

loadDotEnv();

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const limit = numberArg("--limit", 8);
const minScore = numberArg("--min-score", 45);
const minTrades = numberArg("--min-trades", 10);
const minMarkets = numberArg("--min-markets", 1);
const dbPath = valueArg("--db", process.env.BOT_DB_PATH || "./data/polymarket-paper-bot.sqlite");
const walletsPath = valueArg("--wallets", "config/wallets.json");

if (!existsSync(resolve(dbPath))) {
  throw new Error(`Database not found: ${dbPath}`);
}

const db = new DatabaseSync(resolve(dbPath), { readOnly: true });
const candidates = db.prepare(`
  SELECT address, score, copyability_score, hot_score, category_consistency_score,
         sample_confidence, dominant_category, trade_count, unique_markets,
         total_volume, realized_pnl_approx
  FROM discovered_wallets
  WHERE score >= ?
    AND trade_count >= ?
    AND unique_markets >= ?
  ORDER BY score DESC, copyability_score DESC, trade_count DESC
  LIMIT ?
`).all(minScore, minTrades, minMarkets, limit) as unknown as CandidateRow[];
db.close();

console.log("StratiFi discovered-wallet promotion");
console.log(`DB: ${dbPath}`);
console.log(`Policy: score >= ${minScore}, trades >= ${minTrades}, markets >= ${minMarkets}, limit ${limit}`);

if (candidates.length === 0) {
  console.log("No candidates matched. Run a wider scan or lower the dry-run thresholds for local plumbing tests.");
  process.exit(0);
}

console.table(candidates.map((wallet) => ({
  wallet: `${wallet.address.slice(0, 10)}...${wallet.address.slice(-6)}`,
  score: wallet.score,
  copy: wallet.copyability_score,
  hot: wallet.hot_score,
  category: wallet.dominant_category ?? "unknown",
  trades: wallet.trade_count,
  markets: wallet.unique_markets,
  volume: wallet.total_volume.toFixed(2),
  pnl: wallet.realized_pnl_approx.toFixed(2)
})));

if (!apply) {
  console.log("Dry run only. Re-run with --apply to write config/wallets.json.");
  process.exit(0);
}

const existing = existsSync(resolve(walletsPath))
  ? JSON.parse(readFileSync(resolve(walletsPath), "utf8")) as TrackedWallet[]
  : [];
const byAddress = new Map(existing.map((wallet) => [wallet.address.toLowerCase(), wallet]));

for (const candidate of candidates) {
  const address = candidate.address.toLowerCase();
  byAddress.set(address, {
    address,
    label: `discovered-score-${Math.round(candidate.score)}`,
    enabled: true
  });
}

writeFileSync(resolve(walletsPath), `${JSON.stringify([...byAddress.values()], null, 2)}\n`);
console.log(`Promoted ${candidates.length} discovered wallet(s) into ${walletsPath}.`);

function valueArg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function numberArg(name: string, fallback: number): number {
  const value = valueArg(name, "");
  return value === "" ? fallback : Number(value);
}
