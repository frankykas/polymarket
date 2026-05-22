export type Side = "BUY" | "SELL";
export type OutcomeSide = "YES" | "NO" | string;
export type TradingMode = "BACKTEST" | "PAPER" | "LIVE" | "SHADOW";
export type AgentName = "Signal Agent" | "Risk Mitigation Agent" | "Overseer Agent" | "Treasury Simulation";
export type EventVisibility = "PUBLIC" | "PRIVATE";
export type StrategyProfileName = "Conservative" | "Aggressive";
export type RiskStateLabel = "SAFE" | "WARNING" | "HIGH_RISK";
export type MarketCategory = "politics" | "sports" | "crypto" | "macro" | "company" | "culture" | "other";

export interface AgentEvent {
  id: string;
  type: string;
  agent: AgentName;
  visibility: EventVisibility;
  message: string;
  payload?: unknown;
  createdAt: number;
}

export interface StrategyProfile {
  name: StrategyProfileName;
  enabled: boolean;
  minConfidence: number;
  maxPositionPct: number;
  maxOpenExposurePct: number;
  maxOpenTrades: number;
  allowedRiskStates: RiskStateLabel[];
  nearCapPct: number;
}

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

export interface WalletPosition {
  wallet: string;
  marketId?: string;
  tokenId?: string;
  outcome?: string;
  size: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  raw?: unknown;
}

export interface DiscoveredWallet {
  address: string;
  score: number;
  copyabilityScore: number;
  hotScore: number;
  categoryConsistencyScore: number;
  exitBehaviorScore: number;
  sampleConfidence: number;
  dominantCategory: MarketCategory;
  tradeCount: number;
  buyCount: number;
  sellCount: number;
  uniqueMarkets: number;
  totalVolume: number;
  avgTradeSize: number;
  realizedPnlApprox: number;
  profitFactorApprox: number;
  winRateApprox: number;
  avgReturnPctApprox: number;
  maxDrawdownApprox: number;
  avgHoldMinutesApprox: number;
  openPositionCount: number;
  openPositionValue: number;
  openPositionPnlApprox: number;
  resolvedMarkets: number;
  resolvedWins: number;
  resolvedLosses: number;
  resolvedWinRate: number;
  flags: string[];
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface WalletScore {
  wallet: string;
  label?: string;
  score: number;
  copyabilityScore?: number;
  hotScore?: number;
  categoryConsistencyScore?: number;
  sampleConfidence?: number;
  dominantCategory?: MarketCategory;
  resolvedMarkets?: number;
  resolvedWins?: number;
  resolvedLosses?: number;
  resolvedWinRate?: number;
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
  resolved?: boolean;
  winningOutcome?: string;
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
  profile?: StrategyProfileName;
  confidence?: number;
  riskState?: RiskStateLabel;
  shadow?: boolean;
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

export interface PerformanceReport {
  openPositions: number;
  closedPositions: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  wins: number;
  losses: number;
  winRate: number;
  paperOrders: number;
  paperFills: number;
  signals: number;
  approvedSignals: number;
}

export interface ShadowTrade {
  id: string;
  wallet: string;
  marketId: string;
  tokenId?: string;
  outcome: OutcomeSide;
  sourceTimestamp: number;
  detectedAt: number;
  sourcePrice: number;
  simulatedEntryPrice?: number;
  simulatedExitPrice?: number;
  sizeUsd: number;
  pnl: number;
  returnPct: number;
  status: "SIMULATED" | "SKIPPED";
  exitReason?: string;
  rejectionReason?: string;
  createdAt: number;
}

export interface ShadowBacktestReport {
  total: number;
  simulated: number;
  skipped: number;
  pnl: number;
  wins: number;
  losses: number;
  winRate: number;
  avgReturnPct: number;
}

export interface BotConfig {
  paperMode: true;
  bankroll: number;
  minPositionSize: number;
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
  discoveryEnabled: boolean;
  discoveryMarketLimit: number;
  discoveryTradesPerMarket: number;
  minDiscoveryTrades: number;
  minDiscoveryVolume: number;
  maxDiscoveredWallets: number;
  autoTrackDiscoveredWallets: boolean;
  shadowBacktestEnabled: boolean;
  shadowCopyDelayMs: number;
  shadowMaxEntryPriceMovePct: number;
  shadowPositionSize: number;
  shadowHistoryLimit: number;
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
