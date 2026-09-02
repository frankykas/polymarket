import type { BotConfig, MarketCategory, TradeSignal, WalletTrade } from "./types.js";

export const DEFAULT_LIVE_SHADOW_POLICY_VERSION = "live-shadow-parity-v1";

export interface CategoryEligibility {
  eligible: boolean;
  reason: string;
}

/** One category policy shared by live paper signal generation and decision-grade shadow validation. */
export function categoryEligibility(category: MarketCategory, config: BotConfig): CategoryEligibility {
  if ((config.blockedMarketCategories ?? []).includes(category)) {
    return { eligible: false, reason: `blocked market category: ${category}` };
  }
  const allowlist = config.allowedMarketCategories ?? [];
  if (config.categoryTradingGateEnabled === true && !allowlist.includes(category)) {
    return { eligible: false, reason: `market category is not allowlisted: ${category}` };
  }
  if (config.categoryTradingGateEnabled !== true && allowlist.length > 0 && !allowlist.includes(category)) {
    return { eligible: false, reason: `market category is not allowlisted: ${category}` };
  }
  return { eligible: true, reason: `market category eligible: ${category}` };
}

/** Wallet-copy paper and shadow orders must use the same notional. */
export function walletCopyPositionSize(config: BotConfig): number {
  const requested = config.walletCopyFlatPositionSize ?? config.shadowPositionSize;
  const executableCeiling = Math.max(config.minPositionSize, config.maxPositionSize);
  return roundMoney(Math.min(executableCeiling, Math.max(config.minPositionSize, requested)));
}

export function signalTargetPositionSize(signal: TradeSignal, config: BotConfig): number {
  if (signal.signalOrigin === "INDEPENDENT_MODEL") {
    const requested = config.independentModelFlatPositionSize ?? config.minPositionSize;
    return roundMoney(Math.min(config.maxPositionSize, Math.max(config.minPositionSize, requested)));
  }
  return walletCopyPositionSize(config);
}

/**
 * Promotion evidence must have been observed prospectively. A trade downloaded by
 * deep-history backfill is useful for research, but it cannot prove that the bot
 * could have reacted to it live.
 */
export function isProspectiveWalletTrade(trade: WalletTrade, config: BotConfig, since = config.performanceStartAt ?? 0): boolean {
  if (trade.observedAt === undefined) return false;
  if (trade.timestamp < since || trade.observedAt < since) return false;
  const observationLag = trade.observedAt - trade.timestamp;
  const maxLag = config.forwardObservationMaxLagMs ?? config.maxSourceBuyAgeMs ?? config.shadowCopyDelayMs;
  return observationLag >= -60_000 && (maxLag <= 0 || observationLag <= maxLag);
}

export function liveShadowPolicyVersion(config: BotConfig): string {
  return config.liveShadowPolicyVersion ?? DEFAULT_LIVE_SHADOW_POLICY_VERSION;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}
