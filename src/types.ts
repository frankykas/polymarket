export type Side = "BUY" | "SELL";
export type OutcomeSide = "YES" | "NO" | string;

export interface TrackedWallet {
  address: string;
  label?: string;
  enabled: boolean;
}

export interface WalletTrade {
  wallet: string;
  marketId: string;
  conditionId?: string;
  tokenId?: string;
  outcome: OutcomeSide;
  side: Side;
  price: number;
  size: number;
  timestamp: number;
  raw?: unknown;
}

export interface WalletScore {
  wallet: string;
  label?: string;
  score: number;
  tradeCount: number;
  recentTradeCount: number;
  reliability: "LOW" | "MEDIUM" | "HIGH";
  flags: string[];
  updatedAt: number;
}

export interface MarketSnapshot {
  id: string;
  conditionId?: string;
  question: string;
  slug?: string;
  active: boolean;
  closed: boolean;
  archived: boolean;
  acceptingOrders: boolean;
  endDate?: string;
  liquidity: number;
  volume24h: number;
  clobTokenIds: string[];
  outcomes: string[];
  outcomePrices: number[];
  raw?: unknown;
}

export interface PriceLevel {
  price: number;
  size: number;
}

export interface OrderBookSnapshot {
  tokenId: string;
  marketId?: string;
  bids: PriceLevel[];
  asks: PriceLevel[];
  bestBid?: number;
  bestAsk?: number;
  spread?: number;
  depth: number;
  lastTradePrice?: number;
  timestamp: number;
  raw?: unknown;
}

export interface MarketQuality {
  approved: boolean;
  score: number;
  reasons: string[];
}

export interface TradeSignal {
  id: string;
  decision: "TRADE_CANDIDATE" | "NO_TRADE" | "WATCHLIST";
  marketId: string;
  conditionId?: string;
  tokenId: string;
  outcome: OutcomeSide;
  side: Side;
  confidence: number;
  limitPrice: number;
  alignedWallets: string[];
  reason: string;
  createdAt: number;
}

export interface RiskDecision {
  decision: "APPROVE" | "REJECT" | "REDUCE_SIZE" | "PAUSE_TRADING";
  positionSize: number;
  reason: string;
}

export interface PaperOrder {
  id: string;
  signalId: string;
  marketId: string;
  tokenId: string;
  outcome: OutcomeSide;
  side: Side;
  price: number;
  size: number;
  remainingSize: number;
  status: "OPEN" | "PARTIAL" | "FILLED" | "EXPIRED" | "CANCELLED";
  createdAt: number;
  expiresAt: number;
}

export interface PaperFill {
  id: string;
  orderId: string;
  marketId: string;
  tokenId: string;
  side: Side;
  price: number;
  size: number;
  timestamp: number;
}

export interface Position {
  id: string;
  marketId: string;
  tokenId: string;
  outcome: OutcomeSide;
  size: number;
  avgEntryPrice: number;
  currentPrice: number;
  realizedPnl: number;
  openedAt: number;
  updatedAt: number;
  status: "OPEN" | "CLOSED";
}

export interface ExitDecision {
  decision: "HOLD" | "PARTIAL_EXIT" | "FULL_EXIT";
  exitProbability: number;
  reason: string;
}

export interface BotConfig {
  paperMode: true;
  bankroll: number;
  maxPositionSize: number;
  maxOpenExposure: number;
  maxDailyLoss: number;
  maxLossStreak: number;
  maxTradesPerDay: number;
  minSignalConfidence: number;
  minWalletScore: number;
  minAlignedWallets: number;
  maxSpread: number;
  minLiquidity: number;
  minOrderBookDepth: number;
  minTimeToResolutionHours: number;
  limitOrderTtlMs: number;
  takeProfitPct: number;
  stopLossPct: number;
  volumeSpikeMultiplier: number;
  spreadExitThreshold: number;
  priceReversalPct: number;
  scanIntervalMs: number;
  walletActivityLimit: number;
  marketScanLimit: number;
  maxWatchedMarkets: number;
}

export interface RuntimeEnv {
  gammaApiUrl: string;
  dataApiUrl: string;
  clobApiUrl: string;
  clobWsUrl: string;
  dbPath: string;
  telegramBotToken?: string;
  telegramChatId?: string;
}
