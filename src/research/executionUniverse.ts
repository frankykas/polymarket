import type { MarketSnapshot } from "../types.js";

export interface ExecutionResearchUniverseEntry {
  market: MarketSnapshot;
  score: number;
  reasons: string[];
}

/**
 * Research-only market selection. Trading category gates intentionally do not
 * apply: the purpose is to learn whether an execution mechanism works before
 * any category can become eligible for paper trading.
 */
export function selectExecutionResearchUniverse(
  markets: MarketSnapshot[],
  input: { limit: number; minVolume24h: number }
): ExecutionResearchUniverseEntry[] {
  return markets
    .filter((market) =>
      market.active && !market.closed && !market.resolved && market.acceptingOrders &&
      market.clobTokenIds.length >= 2 &&
      (market.volume24h >= input.minVolume24h || isRewarded(market) || market.negRisk === true || isShortHorizonCryptoMarket(market))
    )
    .map((market) => {
      const reasons: string[] = [];
      let score = Math.log10(1 + Math.max(0, market.volume24h)) * 12 + Math.log10(1 + Math.max(0, market.liquidity)) * 8;
      if (isRewarded(market)) {
        score += 45;
        reasons.push("liquidity rewards configured");
      }
      if (market.feesEnabled) {
        score += 12;
        reasons.push("maker-rebate eligible fee market");
      }
      if (market.negRisk) {
        score += 35;
        reasons.push("negative-risk event graph");
      }
      if (market.negRiskAugmented) {
        score -= 8;
        reasons.push("augmented negative-risk safeguards required");
      }
      if (isShortHorizonCryptoMarket(market)) {
        score += 60;
        reasons.push("short-horizon crypto reference market");
      }
      if (isCryptoThresholdLadderMarket(market)) {
        score += 40;
        reasons.push("cross-market crypto threshold ladder");
      }
      if (market.clobTokenIds.length === 2) reasons.push("complete binary pair");
      return { market, score: Math.round(score * 100) / 100, reasons };
    })
    .sort((a, b) => b.score - a.score || b.market.volume24h - a.market.volume24h || a.market.id.localeCompare(b.market.id))
    .slice(0, Math.max(1, Math.floor(input.limit)));
}

export function isCryptoThresholdLadderMarket(market: MarketSnapshot): boolean {
  return Boolean(market.eventId) &&
    /bitcoin|ethereum|\bbtc\b|\beth\b/i.test(market.question) &&
    /\b(above|over|higher than|at least|below|under|lower than|at most)\s+\$?[\d,]+(?:\.\d+)?/i.test(market.question);
}

export function isShortHorizonCryptoMarket(market: MarketSnapshot, now = Date.now()): boolean {
  if (!/bitcoin|ethereum|\bbtc\b|\beth\b/i.test(market.question) || !/above|over|up|higher|increase|rise|below|under|down|lower|decrease|fall/i.test(market.question)) {
    return false;
  }
  if (!market.endDate) return false;
  const endsAt = Date.parse(market.endDate);
  const remaining = endsAt - now;
  return Number.isFinite(endsAt) && remaining > 0 && remaining <= 36 * 60 * 60_000;
}

export function includeCompleteNegativeRiskGraphs(
  base: ExecutionResearchUniverseEntry[],
  graphs: MarketSnapshot[][],
  limit: number
): ExecutionResearchUniverseEntry[] {
  const selected: ExecutionResearchUniverseEntry[] = [];
  const usedMarkets = new Set<string>();
  const rankedGraphs = graphs
    .filter(isCompleteStandardNegativeRiskGraph)
    .sort((a, b) => graphScore(b) - graphScore(a));

  for (const graph of rankedGraphs) {
    if (selected.length + graph.length > limit) continue;
    const entries = selectExecutionResearchUniverse(graph, { limit: graph.length, minVolume24h: 0 });
    if (entries.length !== graph.length) continue;
    for (const entry of entries) {
      selected.push({ ...entry, reasons: [...entry.reasons, "complete standard negative-risk graph"] });
      usedMarkets.add(entry.market.id);
    }
  }
  for (const entry of base) {
    if (selected.length >= limit) break;
    if (usedMarkets.has(entry.market.id)) continue;
    selected.push(entry);
    usedMarkets.add(entry.market.id);
  }
  return selected;
}

/** Reserve whole same-event crypto threshold families before the volume-ranked
 * universe is truncated. A partial ladder cannot prove monotonic pair pricing. */
export function includeCompleteThresholdLadderGroups(
  base: ExecutionResearchUniverseEntry[],
  markets: MarketSnapshot[],
  limit: number
): ExecutionResearchUniverseEntry[] {
  const grouped = new Map<string, MarketSnapshot[]>();
  for (const market of markets) {
    if (!isCryptoThresholdLadderMarket(market) || !market.eventId) continue;
    const direction = /\b(above|over|higher than|at least)\b/i.test(market.question) ? "ABOVE" : "BELOW";
    const asset = /bitcoin|\bbtc\b/i.test(market.question) ? "BTC" : "ETH";
    const key = `${market.eventId}:${asset}:${direction}`;
    const group = grouped.get(key) ?? [];
    group.push(market);
    grouped.set(key, group);
  }
  const completeGroups = [...grouped.values()]
    .filter((group) => group.length >= 2 && group.length <= 20)
    .map((group) => ({ group, score: graphScore(group) }))
    .sort((left, right) => right.score - left.score);
  const selected: ExecutionResearchUniverseEntry[] = [];
  const usedMarkets = new Set<string>();
  for (const { group } of completeGroups) {
    if (selected.length + group.length > limit) continue;
    const entries = selectExecutionResearchUniverse(group, { limit: group.length, minVolume24h: 0 });
    if (entries.length !== group.length) continue;
    for (const entry of entries) {
      selected.push({ ...entry, reasons: [...entry.reasons, "complete same-event threshold ladder"] });
      usedMarkets.add(entry.market.id);
    }
  }
  for (const entry of base) {
    if (selected.length >= limit) break;
    if (usedMarkets.has(entry.market.id)) continue;
    selected.push(entry);
    usedMarkets.add(entry.market.id);
  }
  return selected;
}

function isRewarded(market: MarketSnapshot): boolean {
  return (market.rewardsDailyRate ?? 0) > 0 ||
    ((market.rewardsMinSize ?? 0) > 0 && (market.rewardsMaxSpread ?? 0) > 0);
}

function isCompleteStandardNegativeRiskGraph(markets: MarketSnapshot[]): boolean {
  if (markets.length < 3 || markets.length > 40) return false;
  const eventId = markets[0].eventId;
  if (!eventId) return false;
  return markets.every((market) =>
    market.eventId === eventId &&
    market.eventMarketCount === markets.length &&
    market.negRisk === true &&
    market.negRiskAugmented !== true &&
    market.active && !market.closed && !market.resolved && market.acceptingOrders &&
    market.clobTokenIds.length === 2 &&
    !isOtherOutcome(market)
  );
}

function isOtherOutcome(market: MarketSnapshot): boolean {
  const raw = market.raw as Record<string, unknown> | undefined;
  return Boolean(raw?.negRiskOther) || /\bother\b|placeholder/i.test(`${market.question} ${String(raw?.groupItemTitle ?? "")}`);
}

function graphScore(markets: MarketSnapshot[]): number {
  return markets.reduce((sum, market) => sum + Math.log10(1 + Math.max(0, market.volume24h)), 0);
}
