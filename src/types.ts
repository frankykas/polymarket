export type Side = "BUY" | "SELL";
export type OutcomeSide = "YES" | "NO" | string;
export type TradingMode = "BACKTEST" | "PAPER" | "LIVE" | "SHADOW";
export type AgentName =
  | "Signal Agent"
  | "Market Intelligence Agent"
  | "Microstructure Agent"
  | "Wallet Intelligence Agent"
  | "Decision Council"
  | "Risk Mitigation Agent"
  | "Overseer Agent"
  | "Treasury Simulation";
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
  shadowTradeCount?: number;
  shadowSimulated?: number;
  shadowRealized?: number;
  shadowPnl?: number;
  shadowAvgReturnPct?: number;
  shadowWinRate?: number;
  shadowScoreImpact?: number;
  shadowCategoryImpacts?: Partial<Record<MarketCategory, number>>;
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
  microstructureScore?: number;
  microstructureState?: MicrostructureReport["state"];
  microstructureReasons?: string[];
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

export interface MarketIntelligenceBrief {
  id: string;
  marketId: string;
  category: MarketCategory;
  thesis: "BULLISH_SIGNAL" | "WATCH" | "REJECT_CONTEXT" | "NEUTRAL";
  confidenceModifier: number;
  contextScore: number;
  timeToResolutionHours?: number;
  signalFreshness: "FRESH" | "STALE" | "UNKNOWN";
  catalystTags: string[];
  publicSummary: string;
  privateNotes: string[];
  createdAt: number;
}

export interface MicrostructureReport {
  id: string;
  marketId: string;
  score: number;
  state: "EXECUTABLE" | "THIN" | "WIDE" | "STALE" | "UNKNOWN";
  bestSpread?: number;
  worstSpread?: number;
  totalDepth: number;
  executableAskDepth: number;
  priceImpactForMinSize: number;
  dataAgeMs: number;
  reasons: string[];
  createdAt: number;
}

export interface WalletIntelligenceReport {
  id: string;
  signalId: string;
  marketId: string;
  state: "INDEPENDENT" | "CLUSTERED" | "WEAK_EVIDENCE" | "UNKNOWN";
  score: number;
  alignedWallets: number;
  independentSourceCount: number;
  clusterPenalty: number;
  timingSpreadMs?: number;
  avgCopyabilityScore: number;
  avgSampleConfidence: number;
  confidenceModifier: number;
  reasons: string[];
  createdAt: number;
}

export interface AgentVote {
  agent: AgentName;
  vote: "APPROVE" | "WATCH" | "REJECT";
  score: number;
  reason: string;
}

export interface AgentDebateDecision {
  id: string;
  signalId: string;
  marketId: string;
  outcome: OutcomeSide;
  votes: AgentVote[];
  consensus: "APPROVE" | "WATCH" | "REJECT";
  consensusScore: number;
  publicSummary: string;
  createdAt: number;
}

export interface IntelligenceReviewContext {
  marketIntelligence?: MarketIntelligenceBrief;
  microstructure?: MicrostructureReport;
  walletIntelligence?: WalletIntelligenceReport;
  debate?: AgentDebateDecision;
}

export interface PaperOrder {
  id: string;
  signalId: string;
  profile?: StrategyProfileName;
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
  profile?: StrategyProfileName;
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
  openCost: number;
  openValue: number;
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

export interface ProfilePerformanceReport {
  profile: StrategyProfileName;
  bankroll: number;
  openPositions: number;
  closedPositions: number;
  openCost: number;
  openValue: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  winRate: number;
  wins: number;
  losses: number;
  paperOrders: number;
  approvedSignals: number;
  rejectedSignals: number;
  openExposure: number;
  maxDrawdown: number;
  avgHoldMinutes: number;
  bestTradeReturnPct?: number;
  worstTradeReturnPct?: number;
}

export interface SourceScoreSummary {
  totalSources: number;
  highReliability: number;
  mediumReliability: number;
  lowReliability: number;
  avgScore: number;
  avgCopyabilityScore: number;
  avgShadowImpact: number;
}

export interface ShadowCategorySummary {
  category: MarketCategory;
  simulated: number;
  realized: number;
  pnl: number;
  winRate: number;
  avgReturnPct: number;
  fallbackRate: number;
}

export interface SourceScorePoint {
  wallet: string;
  score: number;
  copyabilityScore?: number;
  categoryConsistencyScore?: number;
  shadowScoreImpact?: number;
  tradeCount: number;
  reliability: WalletScore["reliability"];
  createdAt: number;
}

export interface AgentHandoffTrace {
  id: string;
  type: string;
  agent: AgentName;
  visibility: EventVisibility;
  message: string;
  payload?: unknown;
  createdAt: number;
}

export interface RiskEventSummary {
  decision: RiskDecision["decision"];
  profile?: StrategyProfileName;
  reason: string;
  count: number;
  latestAt: number;
}

export interface RecentRiskEvent {
  id: string;
  decision: RiskDecision["decision"];
  profile?: StrategyProfileName;
  signalId?: string;
  marketId?: string;
  outcome?: string;
  confidence?: number;
  riskState?: RiskStateLabel;
  positionSize: number;
  reason: string;
  details?: {
    marketQualityApproved?: boolean;
    marketQualityScore?: number;
    marketQualityReasons?: string[];
    marketIntelligenceScore?: number;
    marketIntelligenceThesis?: MarketIntelligenceBrief["thesis"];
    marketIntelligenceSummary?: string;
    microstructureScore?: number;
    microstructureState?: MicrostructureReport["state"];
    microstructureReasons?: string[];
    walletIntelligenceScore?: number;
    walletIntelligenceState?: WalletIntelligenceReport["state"];
    debateConsensus?: AgentDebateDecision["consensus"];
    debateScore?: number;
    debateVotes?: AgentVote[];
    openExposure?: number;
    dailyPnl?: number;
    lossStreak?: number;
    tradesToday?: number;
  };
  createdAt: number;
}

export interface OrderHealthReport {
  totalOrders: number;
  filledOrders: number;
  openOrders: number;
  expiredOrders: number;
  cancelledOrders: number;
  partialOrders: number;
  fillRate: number;
  staleOpenOrders: number;
  dustFilledOrders: number;
  avgFilledNotional: number;
  recentFills24h: number;
}

export interface ExposureHealthReport {
  maxOpenExposure: number;
  activeExposureCap: number;
  openExposure: number;
  remainingExposure: number;
  usedPct: number;
  status: "AVAILABLE" | "NEAR_CAP" | "FULL";
}

export interface CapitalLockupReport {
  reserveCashPct: number;
  reserveCash: number;
  activeTradingCap: number;
  maxTimeToResolutionHours: number;
  longDatedPositions: number;
  longDatedCapital: number;
  longestResolutionHours?: number;
}

export interface PaperSourcePerformance {
  wallet: string;
  filledOrders: number;
  pnl: number;
  avgReturnPct: number;
  scoreImpact: number;
}

export interface PaperSourceFeedbackSummary {
  sources: number;
  positiveSources: number;
  negativeSources: number;
  avgScoreImpact: number;
  latestAt: number;
}

export interface ShadowCategoryTrendPoint {
  bucketStart: number;
  category: MarketCategory;
  simulated: number;
  realized: number;
  pnl: number;
  avgReturnPct: number;
}

export interface OrderHealthTrendPoint {
  bucketStart: number;
  createdOrders: number;
  filledOrders: number;
  expiredOrders: number;
  partialOrders: number;
  fills: number;
  filledNotional: number;
}

export interface AgentThroughputPoint {
  bucketStart: number;
  agent: AgentName;
  events: number;
  publicEvents: number;
}

export interface WalletDegradationReport {
  wallet: string;
  label?: string;
  category?: MarketCategory;
  startScore: number;
  latestScore: number;
  scoreChange: number;
  startCopyabilityScore?: number;
  latestCopyabilityScore?: number;
  copyabilityChange?: number;
  snapshots: number;
  status: "IMPROVING" | "STABLE" | "DEGRADING";
  latestAt: number;
}

export interface SourceCategorySummary {
  category: MarketCategory;
  sources: number;
  avgCopyabilityScore: number;
  avgScore: number;
  avgSampleConfidence: number;
  avgShadowImpact: number;
  totalTrades: number;
  highReliability: number;
}

export interface ReconstructedSourcePosition {
  wallet: string;
  marketId: string;
  tokenId?: string;
  outcome: OutcomeSide;
  category: MarketCategory;
  netSize: number;
  costBasis: number;
  avgEntryPrice: number;
  realizedPnlApprox: number;
  lastTradeAt: number;
  status: "OPEN" | "CLOSED";
}

export interface PaperTradeLedgerEntry {
  id: string;
  type: "ENTRY" | "EXIT";
  profile?: StrategyProfileName;
  marketId: string;
  outcome: OutcomeSide;
  price: number;
  size: number;
  notional: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  equity: number;
  availableCash: number;
  createdAt: number;
}

export interface ShadowTrade {
  id: string;
  wallet: string;
  marketId: string;
  category?: MarketCategory;
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

export interface ShadowWalletPerformance {
  wallet: string;
  category?: MarketCategory;
  total: number;
  simulated: number;
  realized: number;
  marked: number;
  fallback: number;
  pnl: number;
  realizedPnl: number;
  wins: number;
  losses: number;
  winRate: number;
  avgReturnPct: number;
  realizedAvgReturnPct: number;
}

export interface BotConfig {
  paperMode: true;
  bankroll: number;
  minPositionSize: number;
  maxPositionSize: number;
  maxOpenExposure: number;
  reserveCashPct: number;
  maxDailyLoss: number;
  maxLossStreak: number;
  maxTradesPerDay: number;
  minSignalConfidence: number;
  minWalletScore: number;
  minAlignedWallets: number;
  /** Lowest outcome price StratiFi will treat as a trade candidate. Longshots below this are noise-dominated. Default 0.08. */
  minEntryPrice?: number;
  /** Highest outcome price StratiFi will treat as a trade candidate. Favorites above this have negative asymmetry. Default 0.92. */
  maxEntryPrice?: number;
  maxSpread: number;
  minLiquidity: number;
  minOrderBookDepth: number;
  minTimeToResolutionHours: number;
  maxTimeToResolutionHours: number;
  limitOrderTtlMs: number;
  takeProfitPct: number;
  stopLossPct: number;
  /** Absolute price (probability) drop that triggers a hard stop, e.g. 0.06. Falls back to stopLossPct when unset. */
  stopLossAbs?: number;
  /** Absolute price (probability) gain counted as a take-profit signal, e.g. 0.10. Falls back to takeProfitPct when unset. */
  takeProfitAbs?: number;
  /** When true, the Overseer exits a position once a seeding source wallet sells the same outcome. */
  sourceExitEnabled?: boolean;
  /** Cooldown after a losing stop-out on a token before it can be re-entered, in ms. 0 disables. */
  stopCooldownMs?: number;
  volumeSpikeMultiplier: number;
  spreadExitThreshold: number;
  priceReversalPct: number;
  maxPositionHoldHours: number;
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
  deepHistoryEnabled: boolean;
  deepHistoryWalletLimit: number;
  deepHistoryPages: number;
  deepHistoryPageSize: number;
  resolutionBackfillLimit: number;
}

export interface RuntimeEnv {
  gammaApiUrl: string;
  dataApiUrl: string;
  clobApiUrl: string;
  clobWsUrl: string;
  dbPath: string;
  telegramBotToken?: string;
  telegramAdminChatId?: string;
  telegramPublicChatId?: string;
  telegramChatId?: string;
  supabaseUrl?: string;
  supabaseServiceRoleKey?: string;
  supabaseAnonKey?: string;
  adminDashboardToken?: string;
  publicTrackerName?: string;
  publicTrackerWalletAddress?: string;
  publicTrackerDisclosure?: string;
}
