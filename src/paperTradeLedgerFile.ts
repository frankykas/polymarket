import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BotDatabase } from "./db.js";
import type { PaperTradeLedgerEntry } from "./types.js";

const DEFAULT_LEDGER_PATH = "data/paper-trade-ledger.csv";

export function exportPaperTradeLedgerFile(
  db: BotDatabase,
  bankroll: number,
  path = process.env.PAPER_TRADE_LEDGER_PATH || DEFAULT_LEDGER_PATH
): { path: string; rows: number } {
  const rows = db.getPaperTradeLedger(bankroll, 100_000).reverse();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, toCsv(rows), "utf8");
  return { path, rows: rows.length };
}

function toCsv(rows: PaperTradeLedgerEntry[]): string {
  const headers = [
    "created_at_iso",
    "created_at_ms",
    "type",
    "profile",
    "market_id",
    "outcome",
    "price",
    "shares",
    "notional_usd",
    "realized_pnl_usd",
    "unrealized_pnl_usd",
    "total_pnl_usd",
    "equity_usd",
    "available_cash_usd"
  ];
  return [
    headers.join(","),
    ...rows.map((row) => [
      new Date(row.createdAt).toISOString(),
      row.createdAt,
      row.type,
      row.profile ?? "",
      row.marketId,
      row.outcome,
      row.price,
      row.size,
      row.notional,
      row.realizedPnl,
      row.unrealizedPnl,
      row.totalPnl,
      row.equity,
      row.availableCash
    ].map(csvCell).join(","))
  ].join("\n") + "\n";
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
