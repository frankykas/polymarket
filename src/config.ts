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
    telegramChatId: process.env.TELEGRAM_CHAT_ID || undefined
  };
}

export function loadBotConfig(path = "config/bot.json"): BotConfig {
  const raw = JSON.parse(readFileSync(resolve(path), "utf8")) as BotConfig;
  return {
    ...raw,
    paperMode: true,
    scanIntervalMs: Number(process.env.SCAN_INTERVAL_MS || raw.scanIntervalMs),
    walletActivityLimit: Number(process.env.WALLET_ACTIVITY_LIMIT || raw.walletActivityLimit),
    marketScanLimit: Number(process.env.MARKET_SCAN_LIMIT || raw.marketScanLimit)
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
