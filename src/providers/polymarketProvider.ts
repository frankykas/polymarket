import type { ClobClient, DataClient, GammaClient } from "../clients.js";
import type { ClosedWalletPosition, LeaderboardCategory, LeaderboardPeriod, MarketSnapshot, OrderBookSnapshot, TraderLeaderboardEntry, WalletPosition, WalletTrade } from "../types.js";

export interface PolymarketClients {
  gamma: GammaClient;
  data: DataClient;
  clob: ClobClient;
}

export class PolymarketProvider {
  constructor(private clients: PolymarketClients) {}

  async getActiveMarkets(limit: number): Promise<MarketSnapshot[]> {
    const markets = await this.clients.gamma.getMarkets(limit);
    return markets.filter((market) => market.active && !market.closed && !market.resolved && market.acceptingOrders);
  }

  async getActiveWeatherMarkets(eventLimit: number, lookaheadHours: number, now = Date.now()): Promise<MarketSnapshot[]> {
    const markets = await this.clients.gamma.getWeatherMarkets({
      eventLimit,
      endDateMin: now,
      endDateMax: now + Math.max(1, lookaheadHours) * 3_600_000
    });
    return markets.filter((market) => market.active && !market.closed && !market.resolved && market.acceptingOrders);
  }

  getMarketById(marketId: string): Promise<MarketSnapshot | undefined> {
    return this.clients.gamma.getMarketById(marketId);
  }

  getEventMarkets(eventId: string): Promise<MarketSnapshot[]> {
    return this.clients.gamma.getEventMarkets(eventId);
  }

  getMarketTrades(marketId: string, limit: number): Promise<WalletTrade[]> {
    return this.clients.data.getMarketTrades(marketId, limit);
  }

  getWalletTrades(wallet: string, limit: number): Promise<WalletTrade[]> {
    return this.clients.data.getWalletTrades(wallet, limit);
  }

  getWalletTradesPage(wallet: string, limit: number, offset: number): Promise<WalletTrade[]> {
    return this.clients.data.getWalletTradesPage(wallet, limit, offset);
  }

  getWalletPositions(wallet: string): Promise<WalletPosition[]> {
    return this.clients.data.getWalletPositions(wallet);
  }

  getWalletTradesByRole(wallet: string, limit: number, takerOnly: boolean): Promise<WalletTrade[]> {
    return this.clients.data.getWalletTradesByRole(wallet, limit, takerOnly);
  }

  getWalletClosedPositions(wallet: string, limit: number): Promise<ClosedWalletPosition[]> {
    return this.clients.data.getWalletClosedPositions(wallet, limit);
  }

  getTraderLeaderboard(category: LeaderboardCategory, period: LeaderboardPeriod, limit = 30): Promise<TraderLeaderboardEntry[]> {
    return this.clients.data.getTraderLeaderboard({ category, period, limit });
  }

  getOrderBook(tokenId: string, marketId?: string): Promise<OrderBookSnapshot | undefined> {
    return this.clients.clob.getOrderBook(tokenId, marketId);
  }

  getTickSize(tokenId: string): Promise<number | undefined> {
    return this.clients.clob.getTickSize(tokenId);
  }
}
