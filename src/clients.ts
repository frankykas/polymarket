import type { MarketSnapshot, OrderBookSnapshot, PriceLevel, RuntimeEnv, WalletPosition, WalletTrade } from "./types.js";

export class GammaClient {
  constructor(private baseUrl: string) {}

  async getMarkets(limit: number): Promise<MarketSnapshot[]> {
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
    const candidates = [
      `/trades?user=${wallet}&limit=${limit}`,
      `/activity?user=${wallet}&limit=${limit}`,
      `/trades?address=${wallet}&limit=${limit}`
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
}

export class ClobMarketWebSocket {
  private socket?: WebSocket;
  private stopped = false;
  private reconnectTimer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;
  private tokenIds: string[] = [];
  private handlers: Array<(book: Partial<OrderBookSnapshot> & { tokenId: string }) => void> = [];

  constructor(private url: string) {}

  onUpdate(handler: (book: Partial<OrderBookSnapshot> & { tokenId: string }) => void): void {
    this.handlers.push(handler);
  }

  connect(tokenIds: string[]): void {
    this.tokenIds = [...new Set(tokenIds)];
    if (this.tokenIds.length === 0) return;
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.socket?.close();
  }

  private open(): void {
    if (this.stopped) return;
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener("open", () => {
      this.subscribe();
      this.pingTimer = setInterval(() => this.send({ type: "ping" }), 10000);
    });
    this.socket.addEventListener("message", (event) => this.handleMessage(String(event.data)));
    this.socket.addEventListener("close", () => this.scheduleReconnect());
    this.socket.addEventListener("error", () => this.scheduleReconnect());
  }

  private subscribe(): void {
    this.send({
      type: "subscribe",
      assets_ids: this.tokenIds
    });
  }

  private send(payload: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(payload));
  }

  private scheduleReconnect(): void {
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
        const eventType = String(item.event_type ?? item.type ?? "");
        const tokenId = String(item.asset_id ?? item.token_id ?? item.assetId ?? "");
        if (!tokenId) continue;
        if (eventType === "book") {
          const book = normalizeOrderBook(tokenId, item);
          this.emit(book);
        } else if (eventType === "price_change" || eventType === "best_bid_ask" || eventType === "last_trade_price") {
          this.emit(normalizeSocketPrice(tokenId, item));
        }
      }
    } catch {
      return;
    }
  }

  private emit(book: Partial<OrderBookSnapshot> & { tokenId: string }): void {
    for (const handler of this.handlers) handler(book);
  }
}

export function makeClients(env: RuntimeEnv): { gamma: GammaClient; data: DataClient; clob: ClobClient } {
  return {
    gamma: new GammaClient(env.gammaApiUrl),
    data: new DataClient(env.dataApiUrl),
    clob: new ClobClient(env.clobApiUrl)
  };
}

async function getJson<T>(url: URL): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const response = await fetch(url, {
    signal: controller.signal,
    headers: {
      accept: "application/json",
      "user-agent": "polymarket-wallet-paper-bot/0.1"
    }
  }).finally(() => clearTimeout(timeout));
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return (await response.json()) as T;
}

function normalizeMarket(raw: unknown): MarketSnapshot {
  const item = raw as Record<string, unknown>;
  return {
    id: String(item.id ?? item.market ?? item.conditionId ?? ""),
    conditionId: stringOrUndefined(item.conditionId),
    question: String(item.question ?? item.title ?? "Untitled market"),
    slug: stringOrUndefined(item.slug),
    active: Boolean(item.active),
    closed: Boolean(item.closed),
    archived: Boolean(item.archived),
    acceptingOrders: item.acceptingOrders === undefined ? true : Boolean(item.acceptingOrders),
    endDate: stringOrUndefined(item.endDate ?? item.endDateIso),
    liquidity: numberFrom(item.liquidityNum ?? item.liquidityClob ?? item.liquidity),
    volume24h: numberFrom(item.volume24hrClob ?? item.volume24hr ?? item.volume24h ?? item.volume),
    clobTokenIds: parseStringArray(item.clobTokenIds),
    outcomes: parseStringArray(item.outcomes),
    outcomePrices: parseNumberArray(item.outcomePrices),
    raw
  };
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
    lastTradePrice: numberOrUndefined(item.price ?? item.last_trade_price),
    timestamp: Date.now()
  };
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
