import type { ClobClient, DataClient, GammaClient } from "../clients.js";
import type { MarketSnapshot, OrderBookSnapshot, WalletPosition, WalletTrade } from "../types.js";

export interface PolymarketClients {
  gamma: GammaClient;
  data: DataClient;
  clob: ClobClient;
}

export class PolymarketProvider {
  constructor(private clients: PolymarketClients) {}

  getActiveMarkets(limit: number): Promise<MarketSnapshot[]> {
    return this.clients.gamma.getMarkets(limit);
  }

  getMarketById(marketId: string): Promise<MarketSnapshot | undefined> {
    return this.clients.gamma.getMarketById(marketId);
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

  getOrderBook(tokenId: string, marketId?: string): Promise<OrderBookSnapshot | undefined> {
    return this.clients.clob.getOrderBook(tokenId, marketId);
  }
}
