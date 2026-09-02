import type { ClosedWalletPosition, CryptoReferenceTick, LeaderboardCategory, LeaderboardPeriod, MarketSnapshot, MarketStreamUpdate, OrderBookSnapshot, PriceLevel, RuntimeEnv, Side, TraderLeaderboardEntry, WalletPosition, WalletTrade } from "./types.js";

export class GammaClient {
  constructor(private baseUrl: string) {}

  async getWeatherMarkets(input: {
    eventLimit: number;
    endDateMin: number;
    endDateMax: number;
  }): Promise<MarketSnapshot[]> {
    const url = new URL("/events/keyset", this.baseUrl);
    url.searchParams.set("active", "true");
    url.searchParams.set("closed", "false");
    url.searchParams.set("archived", "false");
    url.searchParams.set("limit", String(Math.max(1, Math.min(500, Math.floor(input.eventLimit)))));
    url.searchParams.set("title_search", "highest temperature");
    url.searchParams.set("order", "endDate");
    url.searchParams.set("ascending", "true");
    url.searchParams.set("end_date_min", new Date(input.endDateMin).toISOString());
    url.searchParams.set("end_date_max", new Date(input.endDateMax).toISOString());
    const raw = await getJson<{ events?: unknown[] }>(url);
    const events = Array.isArray(raw.events) ? raw.events as Array<Record<string, unknown>> : [];
    const markets: MarketSnapshot[] = [];
    const seen = new Set<string>();
    for (const event of events) {
      if (!/^highest temperature in /i.test(String(event.title ?? ""))) continue;
      const nested = Array.isArray(event.markets) ? event.markets as Array<Record<string, unknown>> : [];
      const eventId = String(event.id ?? "");
      const eventSlug = stringOrUndefined(event.slug);
      for (const item of nested) {
        const market = normalizeMarket({
          ...item,
          eventId,
          eventSlug,
          eventMarketCount: nested.length
        });
        if (!market.id || market.clobTokenIds.length === 0 || seen.has(market.id)) continue;
        seen.add(market.id);
        markets.push(market);
      }
    }
    return markets;
  }

  async getMarkets(limit: number): Promise<MarketSnapshot[]> {
    const requested = Math.max(1, Math.floor(limit));
    const markets: MarketSnapshot[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;

    try {
      while (markets.length < requested) {
        const url = new URL("/markets/keyset", this.baseUrl);
        url.searchParams.set("active", "true");
        url.searchParams.set("closed", "false");
        url.searchParams.set("archived", "false");
        url.searchParams.set("enableOrderBook", "true");
        url.searchParams.set("limit", String(Math.min(100, requested - markets.length)));
        url.searchParams.set("order", "volume24hr");
        url.searchParams.set("ascending", "false");
        if (cursor) url.searchParams.set("after_cursor", cursor);

        const raw = await getJson<{ markets?: unknown[]; next_cursor?: unknown }>(url);
        const page = Array.isArray(raw.markets) ? raw.markets : [];
        for (const item of page) {
          const market = normalizeMarket(item);
          if (!market.id || market.clobTokenIds.length === 0 || seen.has(market.id)) continue;
          seen.add(market.id);
          markets.push(market);
          if (markets.length >= requested) break;
        }
        const nextCursor = typeof raw.next_cursor === "string" && raw.next_cursor ? raw.next_cursor : undefined;
        if (page.length === 0 || !nextCursor || nextCursor === cursor) break;
        cursor = nextCursor;
      }
      if (markets.length > 0) return markets;
    } catch {
      // Keep the legacy endpoint as a compatibility fallback while Gamma rolls
      // out keyset pagination across environments.
    }

    return this.getMarketsLegacy(requested);
  }

  private async getMarketsLegacy(limit: number): Promise<MarketSnapshot[]> {
    const url = new URL("/markets", this.baseUrl);
    url.searchParams.set("active", "true");
    url.searchParams.set("closed", "false");
    url.searchParams.set("archived", "false");
    url.searchParams.set("enableOrderBook", "true");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("order", "volume24hr");
    url.searchParams.set("ascending", "false");
    const raw = await getJson<unknown[]>(url);
    return raw.map(normalizeMarket).filter((market) => market.clobTokenIds.length > 0);
  }

  async getMarketById(marketId: string): Promise<MarketSnapshot | undefined> {
    const candidates = [
      `/markets/${encodeURIComponent(marketId)}`,
      `/markets?id=${encodeURIComponent(marketId)}`,
      `/markets?condition_ids=${encodeURIComponent(marketId)}`,
      `/markets?conditionIds=${encodeURIComponent(marketId)}`,
      `/markets?conditionId=${encodeURIComponent(marketId)}`
    ];

    for (const path of candidates) {
      try {
        const raw = await getJson<unknown>(new URL(path, this.baseUrl));
        const markets = Array.isArray(raw) ? raw.map(normalizeMarket) : [normalizeMarket(raw)];
        const exact = markets.find((market) => market.id === marketId || market.conditionId === marketId);
        return exact ?? markets[0];
      } catch {
        continue;
      }
    }
    return undefined;
  }

  async getEventMarkets(eventId: string): Promise<MarketSnapshot[]> {
    try {
      const raw = await getJson<Record<string, unknown>>(new URL(`/events/${encodeURIComponent(eventId)}`, this.baseUrl));
      const nested = Array.isArray(raw.markets) ? raw.markets : [];
      const completeCount = nested.length;
      const normalizedEventId = String(raw.id ?? eventId);
      const eventSlug = stringOrUndefined(raw.slug);
      return nested
        .map((item) => normalizeMarket({
          ...(item as Record<string, unknown>),
          eventId: normalizedEventId,
          eventSlug,
          eventMarketCount: completeCount
        }))
        .filter((market) => market.id && market.clobTokenIds.length > 0);
    } catch {
      return [];
    }
  }
}

export class DataClient {
  constructor(private baseUrl: string) {}

  async getMarketTrades(marketId: string, limit: number): Promise<WalletTrade[]> {
    const candidates = [
      `/trades?market=${marketId}&limit=${limit}`,
      `/trades?markets=${marketId}&limit=${limit}`,
      `/activity?market=${marketId}&type=TRADE&limit=${limit}`
    ];

    for (const path of candidates) {
      try {
        const data = await getJson<unknown[]>(new URL(path, this.baseUrl));
        const trades = data.map((item) => normalizeWalletTrade(undefined, item)).filter((trade): trade is WalletTrade => Boolean(trade));
        if (trades.length > 0) return trades;
      } catch {
        continue;
      }
    }
    return [];
  }

  async getWalletTrades(wallet: string, limit: number): Promise<WalletTrade[]> {
    return this.getWalletTradesPage(wallet, limit, 0);
  }

  async getWalletTradesPage(wallet: string, limit: number, offset: number): Promise<WalletTrade[]> {
    const candidates = [
      `/trades?user=${wallet}&limit=${limit}&offset=${offset}&takerOnly=true`,
      `/activity?user=${wallet}&limit=${limit}&offset=${offset}`,
      `/trades?address=${wallet}&limit=${limit}&offset=${offset}`
    ];

    for (const path of candidates) {
      try {
        const data = await getJson<unknown[]>(new URL(path, this.baseUrl));
        const trades = data.map((item) => normalizeWalletTrade(wallet, item)).filter((trade): trade is WalletTrade => Boolean(trade));
        if (trades.length > 0) return trades;
      } catch {
        continue;
      }
    }
    return [];
  }

  async getWalletTradesByRole(wallet: string, limit: number, takerOnly: boolean): Promise<WalletTrade[]> {
    try {
      const url = new URL("/trades", this.baseUrl);
      url.searchParams.set("user", wallet);
      url.searchParams.set("limit", String(Math.max(1, Math.min(10_000, Math.floor(limit)))));
      url.searchParams.set("takerOnly", String(takerOnly));
      const data = await getJson<unknown[]>(url);
      return data.map((item) => normalizeWalletTrade(wallet, item)).filter((trade): trade is WalletTrade => Boolean(trade));
    } catch {
      return [];
    }
  }

  async getWalletClosedPositions(wallet: string, limit: number): Promise<ClosedWalletPosition[]> {
    const requested = Math.max(1, Math.min(500, Math.floor(limit)));
    const result: ClosedWalletPosition[] = [];
    for (let offset = 0; offset < requested; offset += 50) {
      try {
        const url = new URL("/closed-positions", this.baseUrl);
        url.searchParams.set("user", wallet);
        url.searchParams.set("limit", String(Math.min(50, requested - result.length)));
        url.searchParams.set("offset", String(offset));
        url.searchParams.set("sortBy", "TIMESTAMP");
        url.searchParams.set("sortDirection", "DESC");
        const data = await getJson<unknown[]>(url);
        const page = data.map((item) => normalizeClosedWalletPosition(wallet, item)).filter((position): position is ClosedWalletPosition => Boolean(position));
        result.push(...page);
        if (data.length < 50) break;
      } catch {
        break;
      }
    }
    return result.slice(0, requested);
  }

  async getTraderLeaderboard(input: {
    category: LeaderboardCategory;
    period: LeaderboardPeriod;
    limit?: number;
  }): Promise<TraderLeaderboardEntry[]> {
    try {
      const url = new URL("/v1/leaderboard", this.baseUrl);
      url.searchParams.set("category", input.category);
      url.searchParams.set("timePeriod", input.period);
      url.searchParams.set("orderBy", "PNL");
      url.searchParams.set("limit", String(Math.max(1, Math.min(50, input.limit ?? 30))));
      const data = await getJson<unknown[]>(url);
      return data.map((item) => normalizeLeaderboardEntry(item, input.category, input.period)).filter((entry): entry is TraderLeaderboardEntry => Boolean(entry));
    } catch {
      return [];
    }
  }

  async getWalletPositions(wallet: string): Promise<WalletPosition[]> {
    const candidates = [
      `/positions?user=${wallet}`,
      `/positions?user=${wallet}&sizeThreshold=0`,
      `/v1/positions?user=${wallet}`
    ];

    for (const path of candidates) {
      try {
        const data = await getJson<unknown[]>(new URL(path, this.baseUrl));
        return data.map((item) => normalizeWalletPosition(wallet, item)).filter((position): position is WalletPosition => Boolean(position));
      } catch {
        continue;
      }
    }
    return [];
  }
}

export class ClobClient {
  constructor(private baseUrl: string) {}

  async getOrderBook(tokenId: string, marketId?: string): Promise<OrderBookSnapshot | undefined> {
    const paths = [`/book?token_id=${tokenId}`, `/book?token_id=${tokenId}&depth=50`];
    for (const path of paths) {
      try {
        const raw = await getJson<unknown>(new URL(path, this.baseUrl));
        return normalizeOrderBook(tokenId, raw, marketId);
      } catch {
        continue;
      }
    }
    return undefined;
  }

  async getTickSize(tokenId: string): Promise<number | undefined> {
    const paths = [`/tick-size?token_id=${tokenId}`, `/tick-size/${tokenId}`];
    for (const path of paths) {
      try {
        const raw = await getJson<unknown>(new URL(path, this.baseUrl));
        const tick = tickSizeFrom(raw);
        if (tick !== undefined) return tick;
      } catch {
        continue;
      }
    }
    return undefined;
  }
}

export class ClobMarketWebSocket {
  private socket?: WebSocket;
  private stopped = false;
  private reconnectTimer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;
  private tokenIds: string[] = [];
  private subscriptionKey = "";
  private socketGeneration = 0;
  private handlers: Array<(update: MarketStreamUpdate) => void> = [];

  constructor(private url: string) {}

  onUpdate(handler: (update: MarketStreamUpdate) => void): void {
    this.handlers.push(handler);
  }

  connect(tokenIds: string[]): void {
    this.tokenIds = [...new Set(tokenIds)];
    if (this.tokenIds.length === 0) return;
    const nextKey = this.tokenIds.slice().sort().join("|");
    if (nextKey === this.subscriptionKey && this.socket && this.socket.readyState !== WebSocket.CLOSED) return;
    this.subscriptionKey = nextKey;
    this.stopped = false;
    this.closeCurrentSocket();
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.subscriptionKey = "";
    this.closeCurrentSocket();
  }

  private closeCurrentSocket(): void {
    this.socketGeneration += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.reconnectTimer = undefined;
    this.pingTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) socket.close();
  }

  private open(): void {
    if (this.stopped) return;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    const generation = ++this.socketGeneration;
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener("open", () => {
      if (generation !== this.socketGeneration) return;
      this.subscribe();
      this.pingTimer = setInterval(() => this.send("PING"), 10000);
    });
    this.socket.addEventListener("message", (event) => {
      if (generation === this.socketGeneration) this.handleMessage(String(event.data));
    });
    this.socket.addEventListener("close", () => this.scheduleReconnect(generation));
    this.socket.addEventListener("error", () => this.scheduleReconnect(generation));
  }

  private subscribe(): void {
    this.send({
      assets_ids: this.tokenIds,
      type: "market",
      custom_feature_enabled: true
    });
  }

  private send(payload: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(typeof payload === "string" ? payload : JSON.stringify(payload));
  }

  private scheduleReconnect(generation: number): void {
    if (generation !== this.socketGeneration) return;
    if (this.stopped || this.reconnectTimer) return;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.open();
    }, 3000);
  }

  private handleMessage(text: string): void {
    try {
      const message = JSON.parse(text) as Record<string, unknown> | Array<Record<string, unknown>>;
      const messages = Array.isArray(message) ? message : [message];
      for (const item of messages) {
        for (const update of normalizeMarketStreamMessage(item)) this.emit(update);
      }
    } catch {
      return;
    }
  }

  private emit(update: MarketStreamUpdate): void {
    for (const handler of this.handlers) handler(update);
  }
}

export class CryptoReferenceWebSocket {
  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private stopped = true;
  private handlers: Array<(tick: CryptoReferenceTick) => void> = [];

  constructor(private url: string) {}

  onTick(handler: (tick: CryptoReferenceTick) => void): void {
    this.handlers.push(handler);
  }

  connect(): void {
    if (!this.stopped && this.socket && this.socket.readyState !== WebSocket.CLOSED) return;
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED && this.socket.readyState !== WebSocket.CLOSING) this.socket.close();
    this.socket = undefined;
  }

  private open(): void {
    if (this.stopped) return;
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener("message", (event) => {
      try {
        const tick = normalizeCryptoReferenceMessage(JSON.parse(String(event.data)) as unknown);
        if (tick) for (const handler of this.handlers) handler(tick);
      } catch {
        return;
      }
    });
    this.socket.addEventListener("close", () => this.scheduleReconnect());
    this.socket.addEventListener("error", () => this.scheduleReconnect());
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.open();
    }, 3000);
  }
}

export function normalizeCryptoReferenceMessage(raw: unknown, receivedAt = Date.now()): CryptoReferenceTick | undefined {
  const envelope = raw as Record<string, unknown>;
  const item = envelope.data && typeof envelope.data === "object" ? envelope.data as Record<string, unknown> : envelope;
  const symbol = String(item.s ?? "").toUpperCase();
  if (symbol !== "BTCUSDT" && symbol !== "ETHUSDT") return undefined;
  const bid = numberFrom(item.b);
  const ask = numberFrom(item.a);
  if (!(bid > 0 && ask > 0 && ask >= bid)) return undefined;
  return {
    symbol,
    bid,
    ask,
    price: (bid + ask) / 2,
    exchangeTimestamp: optionalTimestamp(item.E ?? item.T),
    receivedAt
  };
}

export function normalizeMarketStreamMessage(item: Record<string, unknown>, receivedAt = Date.now()): MarketStreamUpdate[] {
  const eventType = String(item.event_type ?? item.type ?? "").toLowerCase();
  if (eventType === "price_change" && Array.isArray(item.price_changes)) {
    return item.price_changes.flatMap((rawChange) => {
      const change = rawChange as Record<string, unknown>;
      return normalizeMarketStreamMessage({ ...item, ...change, price_changes: undefined }, receivedAt);
    });
  }
  const tokenId = String(item.asset_id ?? item.token_id ?? item.assetId ?? "");
  if (!tokenId) return [];
  const exchangeTimestamp = optionalTimestamp(item.timestamp ?? item.event_timestamp ?? item.trade_timestamp);
  const marketId = stringOrUndefined(item.market);
  if (eventType === "book") {
    const book = normalizeOrderBook(tokenId, item, marketId);
    return [{ ...book, eventType: "BOOK", exchangeTimestamp, receivedAt, timestamp: receivedAt, raw: item }];
  }
  if (eventType === "price_change" || eventType === "best_bid_ask" || eventType === "last_trade_price" || eventType === "tick_size_change") {
    const normalized = normalizeSocketPrice(tokenId, item);
    const tradePrice = numberOrUndefined(item.price ?? item.last_trade_price);
    const tradeSize = numberOrUndefined(item.size ?? item.trade_size);
    const sideText = String(item.side ?? "").toUpperCase();
    const bookDelta = eventType === "price_change"
      && tradePrice !== undefined
      && tradeSize !== undefined
      && (sideText === "BUY" || sideText === "SELL")
      ? { price: tradePrice, size: tradeSize, side: sideText as Side }
      : undefined;
    const trade = eventType === "last_trade_price" && tradePrice !== undefined && tradeSize !== undefined
      ? { price: tradePrice, size: tradeSize, side: (sideText === "BUY" || sideText === "SELL" ? sideText : undefined) as Side | undefined }
      : undefined;
    return [{
      ...normalized,
      marketId,
      eventType: eventType === "price_change" ? "PRICE_CHANGE" : eventType === "best_bid_ask" ? "BEST_BID_ASK" : eventType === "tick_size_change" ? "TICK_SIZE_CHANGE" : "LAST_TRADE",
      exchangeTimestamp,
      receivedAt,
      timestamp: receivedAt,
      lastTradePrice: eventType === "last_trade_price" ? tradePrice : undefined,
      bookDelta,
      trade,
      raw: item
    }];
  }
  if (eventType === "market_resolved") {
    return [{ tokenId, marketId, eventType: "MARKET_RESOLVED", exchangeTimestamp, receivedAt, timestamp: receivedAt, raw: item }];
  }
  return [];
}

export function makeClients(env: RuntimeEnv): { gamma: GammaClient; data: DataClient; clob: ClobClient } {
  return {
    gamma: new GammaClient(env.gammaApiUrl),
    data: new DataClient(env.dataApiUrl),
    clob: new ClobClient(env.clobApiUrl)
  };
}

async function getJson<T>(url: URL): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "user-agent": "polymarket-wallet-paper-bot/0.1"
        }
      });
      if (response.ok) return (await response.json()) as T;
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable) throw new NonRetryableHttpError(`HTTP ${response.status} for ${url}`);
      lastError = new Error(`HTTP ${response.status} for ${url}`);
      if (attempt < 2) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await delay(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(5000, retryAfter * 1000) : 500 * (attempt + 1));
      }
    } catch (error) {
      if (error instanceof NonRetryableHttpError) throw error;
      lastError = error;
      if (attempt < 2) await delay(500 * (attempt + 1));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`request failed for ${url}`);
}

class NonRetryableHttpError extends Error {}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeMarket(raw: unknown): MarketSnapshot {
  const item = raw as Record<string, unknown>;
  const events = Array.isArray(item.events) ? item.events as Array<Record<string, unknown>> : [];
  const event = events[0];
  const feeSchedule = item.feeSchedule && typeof item.feeSchedule === "object" && !Array.isArray(item.feeSchedule)
    ? item.feeSchedule as Record<string, unknown>
    : undefined;
  const rewardRates = [item.clobRewards, item.rewards, event?.clobRewards, event?.rewards]
    .flatMap((value) => Array.isArray(value) ? value : [])
    .map((value) => numberFrom((value as Record<string, unknown>).rewardsDailyRate ?? (value as Record<string, unknown>).ratePerDay ?? (value as Record<string, unknown>).rate_per_day))
    .filter((value) => value > 0);
  const winningOutcome = winningOutcomeFrom(item);
  const outcomes = parseStringArray(item.outcomes);
  const outcomePrices = parseNumberArray(item.outcomePrices ?? item.outcome_prices);
  const terminalPrices = outcomes.length > 0 && outcomePrices.length === outcomes.length && outcomePrices.some((price) => price >= 0.999);
  const resolved = Boolean(
    item.resolved ||
    item.isResolved ||
    item.resolutionStatus === "resolved" ||
    (item.closed && winningOutcome) ||
    (winningOutcome && terminalPrices)
  );
  return {
    id: String(item.id ?? item.market ?? item.conditionId ?? ""),
    conditionId: stringOrUndefined(item.conditionId),
    question: String(item.question ?? item.title ?? "Untitled market"),
    slug: stringOrUndefined(item.slug),
    active: Boolean(item.active) && !resolved,
    closed: Boolean(item.closed) || resolved,
    archived: Boolean(item.archived),
    acceptingOrders: !resolved && (item.acceptingOrders === undefined ? true : Boolean(item.acceptingOrders)),
    resolved,
    winningOutcome,
    endDate: stringOrUndefined(item.endDate ?? item.endDateIso),
    liquidity: numberFrom(item.liquidityNum ?? item.liquidityClob ?? item.liquidity),
    volume24h: numberFrom(item.volume24hrClob ?? item.volume24hr ?? item.volume24h ?? item.volume),
    clobTokenIds: parseStringArray(item.clobTokenIds),
    outcomes,
    outcomePrices,
    feesEnabled: item.feesEnabled === undefined ? undefined : Boolean(item.feesEnabled),
    takerFeeRate: numberOrUndefined(feeSchedule?.rate ?? item.takerFeeRate ?? item.feeRate),
    eventId: stringOrUndefined(item.eventId ?? item.event_id ?? event?.id ?? event?.eventId),
    eventSlug: stringOrUndefined(item.eventSlug ?? item.event_slug ?? event?.slug),
    eventMarketCount: numberOrUndefined(item.eventMarketCount) ?? (Array.isArray(event?.markets) ? event.markets.length : undefined),
    negRisk: Boolean(item.negRisk ?? item.enableNegRisk ?? event?.negRisk ?? event?.enableNegRisk),
    negRiskAugmented: Boolean(item.negRiskAugmented ?? event?.negRiskAugmented),
    rewardsMinSize: numberOrUndefined(item.rewardsMinSize ?? item.rewards_min_size),
    rewardsMaxSpread: numberOrUndefined(item.rewardsMaxSpread ?? item.rewards_max_spread),
    rewardsDailyRate: rewardRates.length > 0 ? rewardRates.reduce((sum, value) => sum + value, 0) : undefined,
    raw
  };
}

function normalizeLeaderboardEntry(raw: unknown, category: LeaderboardCategory, period: LeaderboardPeriod): TraderLeaderboardEntry | undefined {
  const item = raw as Record<string, unknown>;
  const wallet = String(item.proxyWallet ?? item.wallet ?? "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(wallet)) return undefined;
  return {
    rank: Math.max(0, Math.floor(numberFrom(item.rank))),
    wallet,
    name: stringOrUndefined(item.userName ?? item.name),
    pnl: numberFrom(item.pnl),
    volume: numberFrom(item.vol ?? item.volume),
    category,
    period
  };
}

function normalizeClosedWalletPosition(wallet: string, raw: unknown): ClosedWalletPosition | undefined {
  const item = raw as Record<string, unknown>;
  const marketId = String(item.conditionId ?? item.market ?? "");
  if (!marketId) return undefined;
  return {
    wallet: wallet.toLowerCase(),
    marketId,
    tokenId: stringOrUndefined(item.asset),
    title: String(item.title ?? "Untitled market"),
    outcome: String(item.outcome ?? ""),
    avgPrice: numberFrom(item.avgPrice),
    totalBought: numberFrom(item.totalBought),
    realizedPnl: numberFrom(item.realizedPnl),
    curPrice: numberOrUndefined(item.curPrice),
    timestamp: timestampFrom(item.timestamp),
    raw
  };
}

function winningOutcomeFrom(item: Record<string, unknown>): string | undefined {
  const direct = stringOrUndefined(
    item.winningOutcome ??
    item.winner ??
    item.resolutionOutcome ??
    item.resolution ??
    item.winning_outcome
  );
  if (direct) return direct;

  const outcomes = parseStringArray(item.outcomes);
  const prices = parseNumberArray(item.outcomePrices ?? item.outcome_prices);
  if (outcomes.length > 0 && prices.length === outcomes.length) {
    const winnerIndex = prices.findIndex((price) => price >= 0.999);
    if (winnerIndex >= 0) return outcomes[winnerIndex];
  }

  const tokens = Array.isArray(item.tokens) ? item.tokens as Array<Record<string, unknown>> : [];
  const winningToken = tokens.find((token) => Boolean(token.winner ?? token.winning ?? token.isWinner));
  const tokenOutcome = winningToken ? stringOrUndefined(winningToken.outcome ?? winningToken.name) : undefined;
  if (tokenOutcome) return tokenOutcome;

  const markets = Array.isArray(item.markets) ? item.markets as Array<Record<string, unknown>> : [];
  for (const market of markets) {
    const nested = winningOutcomeFrom(market);
    if (nested) return nested;
  }
  return undefined;
}

function normalizeWalletTrade(wallet: string | undefined, raw: unknown): WalletTrade | undefined {
  const item = raw as Record<string, unknown>;
  const marketId = String(item.market ?? item.marketId ?? item.conditionId ?? item.condition_id ?? "");
  const tokenId = stringOrUndefined(item.asset ?? item.assetId ?? item.tokenId ?? item.token_id);
  const outcome = String(item.outcome ?? item.sideOutcome ?? item.title ?? "YES");
  const sideRaw = String(item.side ?? item.action ?? item.type ?? "BUY").toUpperCase();
  const price = numberFrom(item.price ?? item.avgPrice ?? item.lastPrice);
  const size = numberFrom(item.size ?? item.amount ?? item.shares);
  const timestamp = timestampFrom(item.timestamp ?? item.createdAt ?? item.time);
  const trader = String(wallet ?? item.proxyWallet ?? item.proxy_wallet ?? item.user ?? item.address ?? item.trader ?? "");
  if (!marketId || !trader || price <= 0 || size <= 0) return undefined;
  return {
    wallet: trader.toLowerCase(),
    marketId,
    conditionId: stringOrUndefined(item.conditionId ?? item.condition_id),
    tokenId,
    outcome,
    side: sideRaw.includes("SELL") ? "SELL" : "BUY",
    price,
    size,
    timestamp,
    raw
  };
}

function normalizeWalletPosition(wallet: string, raw: unknown): WalletPosition | undefined {
  const item = raw as Record<string, unknown>;
  const size = numberFrom(item.size ?? item.positionSize ?? item.tokens ?? item.balance);
  const currentValue = numberFrom(item.currentValue ?? item.value ?? item.marketValue ?? item.usdcValue);
  const cashPnl = numberFrom(item.cashPnl ?? item.pnl ?? item.realizedPnl ?? item.unrealizedPnl);
  const percentPnl = numberFrom(item.percentPnl ?? item.percentPnL ?? item.pnlPercent);
  if (size <= 0 && currentValue <= 0) return undefined;
  return {
    wallet: wallet.toLowerCase(),
    marketId: stringOrUndefined(item.conditionId ?? item.market ?? item.marketId),
    tokenId: stringOrUndefined(item.asset ?? item.assetId ?? item.tokenId),
    outcome: stringOrUndefined(item.outcome),
    size,
    currentValue,
    cashPnl,
    percentPnl,
    raw
  };
}

function normalizeOrderBook(tokenId: string, raw: unknown, marketId?: string): OrderBookSnapshot {
  const item = raw as Record<string, unknown>;
  const bids = parseLevels(item.bids);
  const asks = parseLevels(item.asks);
  const bestBid = bids.length > 0 ? Math.max(...bids.map((level) => level.price)) : undefined;
  const bestAsk = asks.length > 0 ? Math.min(...asks.map((level) => level.price)) : undefined;
  const spread = bestBid !== undefined && bestAsk !== undefined ? Math.max(0, bestAsk - bestBid) : undefined;
  return {
    tokenId,
    marketId: marketId ?? stringOrUndefined(item.market),
    bids,
    asks,
    bestBid,
    bestAsk,
    spread,
    depth: [...bids, ...asks].reduce((sum, level) => sum + level.size, 0),
    tickSize: tickSizeFrom(item),
    lastTradePrice: numberOrUndefined(item.last_trade_price ?? item.lastTradePrice),
    timestamp: Date.now(),
    raw
  };
}

function normalizeSocketPrice(tokenId: string, item: Record<string, unknown>): Partial<OrderBookSnapshot> & { tokenId: string } {
  const bestBid = numberOrUndefined(item.best_bid ?? item.bid);
  const bestAsk = numberOrUndefined(item.best_ask ?? item.ask);
  return {
    tokenId,
    bestBid,
    bestAsk,
    spread: bestBid !== undefined && bestAsk !== undefined ? Math.max(0, bestAsk - bestBid) : undefined,
    tickSize: tickSizeFrom(item),
    lastTradePrice: numberOrUndefined(item.price ?? item.last_trade_price),
    timestamp: Date.now()
  };
}

function tickSizeFrom(raw: unknown): number | undefined {
  const item = raw as Record<string, unknown>;
  const direct = numberOrUndefined(
    item.tick_size ??
    item.tickSize ??
    item.minimum_tick_size ??
    item.min_tick_size ??
    item.orderPriceMinTickSize
  );
  if (direct !== undefined && direct > 0) return direct;
  const value = raw as string | number;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = Number(value);
    return parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function parseLevels(value: unknown): PriceLevel[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((level) => {
      if (Array.isArray(level)) return { price: numberFrom(level[0]), size: numberFrom(level[1]) };
      const item = level as Record<string, unknown>;
      return { price: numberFrom(item.price), size: numberFrom(item.size) };
    })
    .filter((level) => level.price > 0 && level.size > 0);
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      return value.split(",").map((part) => part.trim()).filter(Boolean);
    }
  }
  return [];
}

function parseNumberArray(value: unknown): number[] {
  return parseStringArray(value).map(Number).filter((number) => Number.isFinite(number));
}

function numberFrom(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function numberOrUndefined(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return String(value);
}

function timestampFrom(value: unknown): number {
  if (typeof value === "number") return value > 10_000_000_000 ? value : value * 1000;
  if (typeof value === "string") {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return timestampFrom(asNumber);
    const date = Date.parse(value);
    if (Number.isFinite(date)) return date;
  }
  return Date.now();
}

function optionalTimestamp(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const timestamp = timestampFrom(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : undefined;
}
