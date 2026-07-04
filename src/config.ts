import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BotConfig, RuntimeEnv, TrackedWallet } from "./types.js";

const DEFAULT_ENV: RuntimeEnv = {
  gammaApiUrl: "https://gamma-api.polymarket.com",
  dataApiUrl: "https://data-api.polymarket.com",
  clobApiUrl: "https://clob.polymarket.com",
  clobWsUrl: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
  dbPath: "./data/polymarket-paper-bot.sqlite"
};

export function loadDotEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}

export function loadRuntimeEnv(): RuntimeEnv {
  loadDotEnv();
  return {
    gammaApiUrl: process.env.GAMMA_API_URL || DEFAULT_ENV.gammaApiUrl,
    dataApiUrl: process.env.DATA_API_URL || DEFAULT_ENV.dataApiUrl,
    clobApiUrl: process.env.CLOB_API_URL || DEFAULT_ENV.clobApiUrl,
    clobWsUrl: process.env.CLOB_WS_URL || DEFAULT_ENV.clobWsUrl,
    dbPath: process.env.BOT_DB_PATH || DEFAULT_ENV.dbPath,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || undefined,
    telegramAdminChatId: process.env.TELEGRAM_ADMIN_CHAT_ID || undefined,
    telegramPublicChatId: process.env.TELEGRAM_PUBLIC_CHAT_ID || undefined,
    telegramChatId: process.env.TELEGRAM_CHAT_ID || undefined,
    supabaseUrl: process.env.SUPABASE_URL || undefined,
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || undefined,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || undefined,
    adminDashboardToken: process.env.ADMIN_DASHBOARD_TOKEN || undefined,
    publicTrackerName: process.env.PUBLIC_TRACKER_NAME || "StratiFi Paper Tracker",
    publicTrackerWalletAddress: process.env.PUBLIC_TRACKER_WALLET_ADDRESS || undefined,
    publicTrackerDisclosure: process.env.PUBLIC_TRACKER_DISCLOSURE || "Paper trading tracker. No live Polymarket orders are placed by this bot."
  };
}

export function loadBotConfig(path = "config/bot.json"): BotConfig {
  const raw = JSON.parse(readFileSync(resolve(path), "utf8")) as BotConfig;
  return {
    ...raw,
    paperMode: true,
    reserveCashPct: Number(process.env.RESERVE_CASH_PCT || (raw.reserveCashPct ?? 0.2)),
    maxTimeToResolutionHours: Number(process.env.MAX_TIME_TO_RESOLUTION_HOURS || (raw.maxTimeToResolutionHours ?? 720)),
    maxPositionHoldHours: Number(process.env.MAX_POSITION_HOLD_HOURS || (raw.maxPositionHoldHours ?? 72)),
    scanIntervalMs: Number(process.env.SCAN_INTERVAL_MS || raw.scanIntervalMs),
    walletActivityLimit: Number(process.env.WALLET_ACTIVITY_LIMIT || raw.walletActivityLimit),
    marketScanLimit: Number(process.env.MARKET_SCAN_LIMIT || raw.marketScanLimit),
    deepHistoryEnabled: String(process.env.DEEP_HISTORY_ENABLED ?? raw.deepHistoryEnabled ?? "true") !== "false",
    deepHistoryWalletLimit: Number(process.env.DEEP_HISTORY_WALLET_LIMIT || (raw.deepHistoryWalletLimit ?? 8)),
    deepHistoryPages: Number(process.env.DEEP_HISTORY_PAGES || (raw.deepHistoryPages ?? 3)),
    deepHistoryPageSize: Number(process.env.DEEP_HISTORY_PAGE_SIZE || (raw.deepHistoryPageSize ?? 100)),
    resolutionBackfillLimit: Number(process.env.RESOLUTION_BACKFILL_LIMIT || (raw.resolutionBackfillLimit ?? 120))
  };
}

export function loadTrackedWallets(path = "config/wallets.json"): TrackedWallet[] {
  const wallets = JSON.parse(readFileSync(resolve(path), "utf8")) as TrackedWallet[];
  return wallets
    .filter((wallet) => wallet.enabled)
    .map((wallet) => ({
      ...wallet,
      address: wallet.address.toLowerCase()
    }));
}
