export type Side = "BUY" | "SELL";
export type OutcomeSide = "YES" | "NO" | string;
export type TradingMode = "BACKTEST" | "PAPER" | "LIVE" | "SHADOW";
export type OrderExecutionPolicy = "FAK" | "FOK";
export type AgentName =
  | "Signal Agent"
  | "Wallet Research Agent"
  | "Strategy Research Agent"
  | "Execution Research Agent"
  | "Weather Strategy Agent"
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
export type MarketCategory = "politics" | "sports" | "crypto" | "macro" | "company" | "culture" | "weather" | "other";

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
  /** First time this source trade was persisted locally. Used to exclude historical backfill from forward evidence. */
  observedAt?: number;
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

export type LeaderboardCategory = "OVERALL" | "POLITICS" | "SPORTS" | "ESPORTS" | "CRYPTO" | "CULTURE" | "ECONOMICS" | "TECH" | "FINANCE" | "WEATHER" | "MENTIONS";
export type LeaderboardPeriod = "DAY" | "WEEK" | "MONTH" | "ALL";

export interface TraderLeaderboardEntry {
  rank: number;
  wallet: string;
  name?: string;
  pnl: number;
  volume: number;
  category: LeaderboardCategory;
  period: LeaderboardPeriod;
}

export interface ClosedWalletPosition {
  wallet: string;
  marketId: string;
  tokenId?: string;
  title: string;
  outcome: string;
  avgPrice: number;
  totalBought: number;
  realizedPnl: number;
  curPrice?: number;
  timestamp: number;
  raw?: unknown;
}

export type WalletResearchArchetype =
  | "DIRECTIONAL_SPECIALIST"
  | "MAKER_SPECIALIST"
  | "PAIRED_OUTCOME_ARBITRAGE"
  | "EXIT_OR_UNWIND"
  | "MIXED_OR_UNPROVEN";

export type WalletResearchRecommendation = "SHADOW_DIRECTIONAL" | "MODEL_EDGE_ONLY" | "DO_NOT_COPY" | "RESEARCH_ONLY";

export interface WalletResearchReport {
  wallet: string;
  name?: string;
  firstObservedAt: number;
  archetype: WalletResearchArchetype;
  recommendation: WalletResearchRecommendation;
  researchScore: number;
  executionCompatibilityScore: number;
  leaderboardAppearances: number;
  leaderboardPeriods: LeaderboardPeriod[];
  leaderboardCategories: LeaderboardCategory[];
  leaderboardPnl: number;
  leaderboardVolume: number;
  recentTrades: number;
  recentBuys: number;
  recentSells: number;
  closedPositions: number;
  closedPnl: number;
  closedWinRate: number;
  resolvedPredictions: number;
  predictionBrier?: number;
  predictionAccuracy?: number;
  estimatedMakerShare: number;
  copyableAt10Rate: number;
  twoOutcomeMarketRate: number;
  roundTripMarketRate: number;
  medianBuyNotional: number;
  avgBuyPrice: number;
  top3ProfitConcentration: number;
  patterns: string[];
  reasons: string[];
  updatedAt: number;
}

export type StrategyCluster =
  | "WEATHER_FORECASTING"
  | "CRYPTO_THRESHOLD"
  | "POLITICAL_NEWS"
  | "MENTION_EVENT"
  | "MACRO_RELEASE"
  | "SPORTS_INFORMATION"
  | "PAIRED_OUTCOME_ARBITRAGE"
  | "MAKER_PRICING"
  | "CROSS_MARKET_LATENCY"
  | "GENERAL_EVENT";

export type ExecutionResearchStrategy = "MAKER_PAIR" | "BINARY_PAIR_ARB" | "THRESHOLD_LADDER_ARB" | "NEG_RISK_ARB" | "CROSS_MARKET_LATENCY";

export interface ExecutionResearchCandidate {
  id: string;
  strategy: ExecutionResearchStrategy;
  policyVersion: string;
  eventKey: string;
  marketIds: string[];
  tokenIds: string[];
  observedAt: number;
  expiresAt: number;
  notionalUsd: number;
  expectedGrossEdgeUsd: number;
  expectedNetEdgeUsd: number;
  details: Record<string, unknown>;
}

export interface ExecutionResearchResult {
  id: string;
  candidateId: string;
  strategy: ExecutionResearchStrategy;
  policyVersion: string;
  eventKey: string;
  status: "COMPLETE" | "NO_FILL" | "EXPIRED" | "HEDGE_MISS";
  pnlUsd: number;
  capitalUsd: number;
  returnPct: number;
  filledLegs: number;
  latencyMs: number;
  adverseSelection5m?: number;
  resolvedAt: number;
  details: Record<string, unknown>;
}

export interface ExecutionResearchScorecard {
  strategy: ExecutionResearchStrategy;
  policyVersion: string;
  since: number;
  candidates: number;
  resolved: number;
  completed: number;
  hedgeMisses: number;
  economicOutcomes: number;
  noFill: number;
  pnlUsd: number;
  capitalUsd: number;
  returnPct: number;
  wins: number;
  losses: number;
  winRate: number;
  distinctEvents: number;
  distinctMarkets: number;
  medianLatencyMs?: number;
  averageAdverseSelection5m?: number;
  promotionEligible: boolean;
  promotionReason: string;
}

export interface StrategyHypothesis {
  id: string;
  cluster: StrategyCluster;
  title: string;
  thesis: string;
  entryRule: string;
  exitRule: string;
  requiredData: string[];
  sourceWallets: string[];
  sourceWalletCount: number;
  evidenceScore: number;
  status: "RESEARCH" | "VALIDATING" | "PAPER_ELIGIBLE" | "REJECTED" | "DATA_REQUIRED";
  updatedAt: number;
}

export interface StrategyBacktestResult {
  id: string;
  hypothesisId: string;
  cluster: StrategyCluster;
  testKind: "INDEPENDENT_FORECAST_SKILL" | "WALK_FORWARD_PROBABILITY" | "PROSPECTIVE_MARKET_PNL" | "DATA_AVAILABILITY";
  independentFromLeadWallets: boolean;
  sampleSize: number;
  passed: boolean;
  metrics: Record<string, number | string | boolean | null>;
  reason: string;
  createdAt: number;
}

/**
 * Immutable point-in-time external forecast.  These rows are evidence, not a
 * cache: once observed they must never be rewritten or historically backfilled.
 */
export interface MacroForecastVintage {
  id: string;
  source: "CLEVELAND_FED_INFLATION_NOWCAST";
  sourceUrl: string;
  referencePeriod: string;
  referenceYear: number;
  referenceMonth: number;
  fetchedAt: number;
  sourceUpdatedAt: number;
  headlineMom?: number;
  coreMom?: number;
  headlineYoy?: number;
  coreYoy?: number;
}

export interface StrategyOpportunity {
  id: string;
  signalId?: string;
  strategyId: string;
  cluster: "CRYPTO_THRESHOLD" | "MACRO_RELEASE";
  marketId: string;
  tokenId: string;
  outcome: OutcomeSide;
  spec: Record<string, string | number | boolean | null>;
  fairProbability: number;
  marketProbability: number;
  probabilityEdge: number;
  expectedValuePct: number;
  uncertainty: number;
  agreement: number;
  modelSampleSize: number;
  modelVersion?: string;
  modelName?: string;
  policyVersion: string;
  strategyEventKey: string;
  /** Passed the frozen prediction/market gates and is eligible for no-trade forward evidence. */
  researchEligible?: boolean;
  status: "CANDIDATE" | "SELECTED" | "RESEARCH_QUALIFIED" | "RESEARCH_SELECTED" | "WATCHLIST" | "REJECTED" | "RESOLVED";
  reason: string;
  createdAt: number;
}

export interface StrategyForwardScorecard extends WeatherForwardScorecard {
  strategyId: string;
  cluster: StrategyOpportunity["cluster"];
}

/** Append-only record of a strategy selection at the moment it entered review. */
export interface ForwardSelection {
  id: string;
  strategyId: string;
  cluster: StrategyCluster;
  marketId: string;
  tokenId: string;
  outcome: OutcomeSide;
  policyVersion: string;
  strategyEventKey: string;
  selectionStage: "RESEARCH" | "PAPER_REVIEW";
  selectedAt: number;
  selection: WeatherOpportunity | StrategyOpportunity;
}

export interface WalkForwardMetrics {
  executable: number;
  pnl: number;
  avgReturnPct: number;
  winRate: number;
  sourceSellRatio: number;
}

export interface CleanWalkForwardReport {
  calculatedAt: number;
  splitAt?: number;
  endAt?: number;
  wallets: number;
  markets: number;
  trainRows: number;
  testRows: number;
  promotedSources: number;
  gatePassingOos: WalkForwardMetrics;
  allTestSources: WalkForwardMetrics;
  passed: boolean;
  reason: string;
}

export interface DailyCoreScorecard {
  schemaVersion: 1 | 2 | 3 | 4;
  snapshotDate: string;
  createdAt: number;
  policyFingerprint: string;
  actualPaper: PerformanceReport;
  cleanWalkForward: CleanWalkForwardReport;
  forwardShadow: ForwardShadowScorecard;
  independentStrategies: {
    macroCpi: StrategyForwardScorecard;
    cryptoThreshold: StrategyForwardScorecard;
    weather: WeatherForwardScorecard;
  };
  executionResearch?: Record<ExecutionResearchStrategy, ExecutionResearchScorecard>;
  primaryResearch: {
    cluster: "MACRO_RELEASE";
    stage: "RESEARCH" | "EXPERIMENTAL_PAPER" | "STANDARD_PAPER" | "LIVE_READY";
    walkForwardPassed: boolean;
    cleanForwardPositive: boolean;
    researchPromotionEligible: boolean;
    experimentalPaperEligible: boolean;
    standardPaperEligible: boolean;
    liveReady: boolean;
    promotionEligible: boolean;
    reason: string;
  };
  livePromotionGate: {
    passed: boolean;
    reason: string;
    selectedStrategyId?: string;
    selectedCluster?: StrategyCluster;
    selectedStage?: "RESEARCH" | "FORWARD_VALIDATION" | "EXPERIMENTAL_PAPER" | "STANDARD_PAPER";
    strategyEvidencePassed?: boolean;
    paperCanaryEligible?: boolean;
    liveExecutionCodeReady?: boolean;
    blockers?: string[];
    nextMilestone?: string;
  };
}

export interface DailyScorecardSnapshot {
  id: string;
  snapshotDate: string;
  policyFingerprint: string;
  scorecard: DailyCoreScorecard;
  createdAt: number;
}

export interface WeatherMarketSpec {
  city: string;
  stationCode?: string;
  targetDate: string;
  unit: "C" | "F";
  bucket: "EXACT" | "RANGE" | "AT_MOST" | "AT_LEAST";
  lower?: number;
  upper?: number;
}

export interface WeatherOpportunity {
  id: string;
  signalId?: string;
  marketId: string;
  tokenId: string;
  outcome: OutcomeSide;
  spec: WeatherMarketSpec;
  fairProbability: number;
  marketProbability: number;
  probabilityEdge: number;
  expectedValuePct: number;
  uncertainty: number;
  agreement: number;
  forecastSampleSize: number;
  /** Point-in-time executable ask VWAP for the configured research size. Undefined when the book could not fill it. */
  executableEntryPrice?: number;
  /** Point-in-time midpoint used as the market probability benchmark. */
  marketMidProbability?: number;
  executableSizeUsd?: number;
  entryFeeUsd?: number;
  stationValidationPassed?: boolean;
  stationSkillSampleSize?: number;
  stationSkillMaeUpper95C?: number;
  resolutionTimestamp?: number;
  /** Frozen paper-exit experiment associated with this observation. */
  exitPolicy?: "GENERIC_MARK_TO_MARKET" | "HOLD_TO_RESOLUTION";
  /** Frozen prospective policy that classified this row. Prevents old/backfilled rows entering promotion evidence. */
  policyVersion?: string;
  /** One independent exposure unit (for weather: station/city plus target date). */
  strategyEventKey?: string;
  status: "CANDIDATE" | "SELECTED" | "RESEARCH_QUALIFIED" | "RESEARCH_SELECTED" | "WATCHLIST" | "REJECTED" | "RESOLVED";
  reason: string;
  createdAt: number;
}

export interface WeatherTournamentObservation {
  id: string;
  tournamentVersion: string;
  armId: string;
  armLabel: string;
  horizonHours: number;
  horizonWindowHours: number;
  stationCode: string;
  targetDate: string;
  marketId: string;
  tokenId: string;
  outcome: OutcomeSide;
  fairProbability: number;
  marketProbability: number;
  executableEntryPrice?: number;
  probabilityEdge?: number;
  expectedReturnPct?: number;
  positionSizeUsd: number;
  entryFeeUsd: number;
  uncertainty: number;
  eligible: boolean;
  eligibilityReasons: string[];
  resolutionTimestamp: number;
  selectedAt: number;
}

export type WeatherTournamentDecision = "COLLECTING" | "KILL" | "CONTINUE_TO_100" | "PROSPECTIVE_WINNER";

export interface WeatherTournamentArmScorecard {
  tournamentVersion: string;
  armId: string;
  armLabel: string;
  horizonHours: number;
  observations: number;
  resolved: number;
  eligibleSelections: number;
  eligibleResolved: number;
  wins: number;
  losses: number;
  capitalUsd: number;
  pnlUsd: number;
  returnPct: number;
  modelBrierScore?: number;
  marketBrierScore?: number;
  brierImprovement?: number;
  decision: WeatherTournamentDecision;
  decisionReason: string;
}

export interface WeatherTournamentReport {
  generatedAt: number;
  tournamentVersion: string;
  screenAt: number;
  finalAt: number;
  arms: WeatherTournamentArmScorecard[];
}

export interface WeatherForwardScorecard {
  policyVersion: string;
  since: number;
  positionSizeUsd: number;
  observations: number;
  uniqueCandidates: number;
  executedCandidates: number;
  closedPaperPositions: number;
  resolved: number;
  unresolved: number;
  wins: number;
  losses: number;
  winRate: number;
  settlementPnl: number;
  settlementReturnPct: number;
  paperPnl: number;
  paperReturnPct: number;
  modelBrierScore?: number;
  marketBrierScore?: number;
  researchPromotionEligible: boolean;
  researchPromotionReason: string;
  experimentalPaperEligible: boolean;
  standardPaperEligible: boolean;
  promotionEligible: boolean;
  promotionReason: string;
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
  sourceSellShadowRealized?: number;
  sourceSellRealizedRatio?: number;
  liveExecutableShadowSimulated?: number;
  liveExecutableShadowPnl?: number;
  liveExecutableShadowAvgReturnPct?: number;
  liveExecutableShadowWinRate?: number;
  paperFilledOrders?: number;
  paperPnl?: number;
  paperAvgReturnPct?: number;
  paperScoreImpact?: number;
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
  /** Whether fills in this market are currently charged taker fees. */
  feesEnabled?: boolean;
  /** Polymarket fee-rate parameter used by fee = shares * rate * p * (1-p). */
  takerFeeRate?: number;
  /** Event graph fields used only by prospective execution research. */
  eventId?: string;
  eventSlug?: string;
  /** Number of markets returned by Gamma's complete event endpoint. */
  eventMarketCount?: number;
  negRisk?: boolean;
  negRiskAugmented?: boolean;
  rewardsMinSize?: number;
  rewardsMaxSpread?: number;
  rewardsDailyRate?: number;
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
  tickSize?: number;
  lastTradePrice?: number;
  timestamp: number;
  raw?: unknown;
}

export interface MarketStreamUpdate extends Partial<OrderBookSnapshot> {
  tokenId: string;
  eventType: "BOOK" | "PRICE_CHANGE" | "BEST_BID_ASK" | "LAST_TRADE" | "TICK_SIZE_CHANGE" | "MARKET_RESOLVED";
  exchangeTimestamp?: number;
  receivedAt: number;
  bookDelta?: {
    price: number;
    size: number;
    side: Side;
  };
  trade?: {
    price: number;
    size: number;
    side?: Side;
  };
  raw?: unknown;
}

export interface CryptoReferenceTick {
  symbol: "BTCUSDT" | "ETHUSDT";
  bid: number;
  ask: number;
  price: number;
  exchangeTimestamp?: number;
  receivedAt: number;
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
  sourceBuyTimestamp?: number;
  botDetectedTimestamp?: number;
  expectedEntryPrice?: number;
  expectedExitPrice?: number;
  expectedLiveExecutableReturnPct?: number;
  entryBookDepth?: number;
  entryDepthMultiple?: number;
  maxEntrySlippage?: number;
  sourceSellRealizedRatio?: number;
  parityStatus?: "PASS" | "FAIL" | "UNKNOWN";
  parityReason?: string;
  /** Distinguishes wallet-copy signals from independently generated model signals. */
  signalOrigin?: "WALLET_LEAD" | "INDEPENDENT_MODEL";
  strategyId?: string;
  strategyHypothesisId?: string;
  /** Frozen prospective policy responsible for this signal. */
  policyVersion?: string;
  /** Used to prevent correlated duplicate entries from consuming the portfolio. */
  strategyEventKey?: string;
  /** Frozen exit behavior for independently generated paper experiments. */
  exitPolicy?: "GENERIC_MARK_TO_MARKET" | "HOLD_TO_RESOLUTION";
  fairProbability?: number;
  marketProbability?: number;
  probabilityEdge?: number;
  expectedValuePct?: number;
  modelUncertainty?: number;
  modelAgreement?: number;
  forecastSampleSize?: number;
  /** A frozen no-trade prediction that may enter immutable forward research evidence. */
  researchEligible?: boolean;
  modelVersion?: string;
  modelName?: string;
  /** Strategy-defined resolution/release timestamp used instead of an unreliable market endDate. */
  resolutionTimestamp?: number;
  /** Shared live/shadow notional selected before risk and execution checks. */
  targetPositionSizeUsd?: number;
}

export interface RiskDecision {
  decision: "APPROVE" | "REJECT" | "REDUCE_SIZE" | "PAUSE_TRADING";
  positionSize: number;
  reason: string;
  profile?: StrategyProfileName;
  confidence?: number;
  riskState?: RiskStateLabel;
  shadow?: boolean;
  sizingMethod?: "CONFIDENCE_BUCKET" | "FRACTIONAL_KELLY" | "EXPERIMENTAL_FLAT" | "SHADOW_PARITY_FLAT";
  fullKellyFraction?: number;
  fractionalKelly?: number;
  liquidityCap?: number;
  exposureCap?: number;
  drawdownMultiplier?: number;
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
  state: "INDEPENDENT" | "MODEL_INDEPENDENT" | "CLUSTERED" | "WEAK_EVIDENCE" | "UNKNOWN";
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
  sourceScores?: Array<{
    wallet: string;
    score: number;
    copyabilityScore?: number;
    shadowScoreImpact?: number;
    shadowPnl?: number;
    shadowSimulated?: number;
    shadowRealized?: number;
    sourceSellRealizedRatio?: number;
    liveExecutableShadowPnl?: number;
    liveExecutableShadowAvgReturnPct?: number;
    liveExecutableShadowSimulated?: number;
    categoryConsistencyScore?: number;
    sampleConfidence?: number;
    flags: string[];
  }>;
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
  executionPolicy?: OrderExecutionPolicy;
  /** Fee-rate parameter captured when the order is created. */
  feeRate?: number;
  missedReason?: string;
  partialFillReason?: string;
}

export interface PaperFill {
  id: string;
  orderId: string;
  marketId: string;
  tokenId: string;
  side: Side;
  price: number;
  size: number;
  /** Taker fee charged by the paper simulator for this fill. */
  feeUsd?: number;
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

// Book state an exit decision was made against, recorded so the decision can be
// replayed later against alternative exit policies.
export interface ExitDecisionMark {
  bestBid?: number;
  bestAsk?: number;
  entryPrice?: number;
  size?: number;
}

export interface PerformanceReport {
  /** Inclusive timestamp for the currently displayed paper-performance epoch. */
  performanceStartAt?: number;
  openPositions: number;
  closedPositions: number;
  openCost: number;
  openValue: number;
  storedOpenValue?: number;
  executableOpenValue?: number;
  realizedPnl: number;
  unrealizedPnl: number;
  storedUnrealizedPnl?: number;
  executableUnrealizedPnl?: number;
  totalPnl: number;
  storedTotalPnl?: number;
  executableTotalPnl?: number;
  noBidOpenPositions?: number;
  wins: number;
  losses: number;
  winRate: number;
  paperOrders: number;
  paperFills: number;
  signals: number;
  approvedSignals: number;
}

export interface ParityScorecard {
  lookbackHours: number;
  orders: number;
  filledOrders: number;
  buyFills: number;
  sellFills: number;
  expiredOrders: number;
  partialOrders: number;
  fokMisses: number;
  fakPartialFills: number;
  buyNotional: number;
  sellNotional: number;
  realizedPnl: number;
  storedTotalPnl: number;
  executableTotalPnl: number;
  storedUnrealizedPnl: number;
  executableUnrealizedPnl: number;
  noBidOpenPositions: number;
  sourceExitChecks: number;
  sourceSellDetections: number;
  sourceSellExits: number;
  sourceSellMisses: number;
  takeProfitExitAttempts: number;
  takeProfitExitFills: number;
  exitMisses: number;
  parityRows: number;
  missedParityRows: number;
  avgEntrySlippage: number;
  maxEntrySlippage: number;
  avgExitSlippage: number;
  maxExitSlippage: number;
  avgEntryDepthMultiple: number;
  latestAt: number;
}

export type LiveReadinessStatus = "READY" | "WATCH" | "NOT_READY";

export interface LiveReadinessReport {
  lookbackHours: number;
  status: LiveReadinessStatus;
  score: number;
  blockers: string[];
  warnings: string[];
  metrics: {
    executableTotalPnl: number;
    storedTotalPnl: number;
    realizedPnl: number;
    executableUnrealizedPnl: number;
    openPositions: number;
    openExposure: number;
    noBidOpenPositions: number;
    noBidOpenPositionRate: number;
    closedPositions: number;
    wins: number;
    losses: number;
    winRate: number;
    filledOrders: number;
    buyFills: number;
    sellFills: number;
    fokEntryOrders: number;
    fokEntryFills: number;
    fokEntryMisses: number;
    fokEntryMissRate: number;
    exitOrders: number;
    exitFills: number;
    exitMisses: number;
    exitMissRate: number;
    sourceSellDetections: number;
    sourceSellExits: number;
    sourceSellSuccessRate?: number;
    takeProfitExitAttempts: number;
    takeProfitExitFills: number;
    takeProfitExitMisses: number;
    takeProfitFillRate?: number;
    urgentExitFills: number;
    urgentExitMisses: number;
    urgentExitFillRate?: number;
    noBidWatchRate: number;
    avgEntrySlippage: number;
    maxEntrySlippage: number;
    avgExitSlippage: number;
    maxExitSlippage: number;
    avgEntryDepthMultiple: number;
  };
}

export interface ProfilePerformanceReport {
  profile: StrategyProfileName;
  bankroll: number;
  openPositions: number;
  closedPositions: number;
  openCost: number;
  openValue: number;
  storedOpenValue?: number;
  executableOpenValue?: number;
  realizedPnl: number;
  unrealizedPnl: number;
  storedUnrealizedPnl?: number;
  executableUnrealizedPnl?: number;
  totalPnl: number;
  storedTotalPnl?: number;
  executableTotalPnl?: number;
  noBidOpenPositions?: number;
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
    sourceWalletCount?: number;
    sourceScores?: IntelligenceReviewContext["sourceScores"];
    entryPrice?: number;
    marketQualityAtApproval?: number;
    riskReasonAtApproval?: string;
    debateConsensus?: AgentDebateDecision["consensus"];
    debateScore?: number;
    debateVotes?: AgentVote[];
    openExposure?: number;
    dailyPnl?: number;
    lossStreak?: number;
    tradesToday?: number;
    sizingMethod?: RiskDecision["sizingMethod"];
    fullKellyFraction?: number;
    fractionalKelly?: number;
    liquidityCap?: number;
    exposureCap?: number;
    drawdownMultiplier?: number;
    fairProbability?: number;
    marketProbability?: number;
    expectedValuePct?: number;
    candidatePriority?: number;
    strategyEventKey?: string;
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
  /** First local observation time for the source trade. */
  sourceObservedAt?: number;
  detectedAt: number;
  sourcePrice: number;
  simulatedEntryPrice?: number;
  simulatedExitPrice?: number;
  sizeUsd: number;
  pnl: number;
  returnPct: number;
  liveExecutablePnl?: number;
  liveExecutableReturnPct?: number;
  liveExecutableStatus?: "EXECUTABLE" | "MISSED";
  liveExecutableReason?: string;
  liveExecutableEntryPrice?: number;
  liveExecutableExitPrice?: number;
  liveExecutableEntrySlippage?: number;
  liveExecutableExitSlippage?: number;
  status: "SIMULATED" | "SKIPPED";
  exitReason?: string;
  rejectionReason?: string;
  /** True only for prospectively observed evidence under the frozen policy. */
  forwardEligible?: boolean;
  policyVersion?: string;
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
  liveExecutablePnl?: number;
  liveExecutableSimulated?: number;
  liveExecutableWinRate?: number;
  liveExecutableAvgReturnPct?: number;
}

export interface ForwardShadowScorecard extends ShadowBacktestReport {
  since: number;
  missed: number;
  missedReasons: Array<{
    reason: string;
    count: number;
  }>;
  categories: Array<{
    category: MarketCategory;
    simulated: number;
    liveExecutableSimulated: number;
    liveExecutablePnl: number;
    liveExecutableWinRate: number;
    liveExecutableAvgReturnPct: number;
  }>;
}

export interface ShadowWalletPerformance {
  wallet: string;
  category?: MarketCategory;
  total: number;
  simulated: number;
  realized: number;
  sourceSellRealized?: number;
  marked: number;
  fallback: number;
  pnl: number;
  realizedPnl: number;
  sourceSellPnl?: number;
  wins: number;
  losses: number;
  winRate: number;
  avgReturnPct: number;
  realizedAvgReturnPct: number;
  sourceSellRealizedRatio?: number;
  liveExecutableSimulated?: number;
  liveExecutablePnl?: number;
  liveExecutableAvgReturnPct?: number;
  liveExecutableWinRate?: number;
}

export interface LiveExecutionEstimate {
  executable: boolean;
  policy: OrderExecutionPolicy;
  side: Side;
  requestedSizeUsd: number;
  requestedShares: number;
  filledShares: number;
  averageFillPrice?: number;
  limitPrice?: number;
  referencePrice?: number;
  slippage: number;
  maxSlippage: number;
  bookDepth: number;
  depthMultiple: number;
  fee: number;
  reason?: string;
  partialFillReason?: string;
}

export interface TradeParityMetric {
  id: string;
  positionId?: string;
  orderId?: string;
  signalId?: string;
  profile?: StrategyProfileName;
  marketId: string;
  tokenId: string;
  outcome: OutcomeSide;
  sourceBuyTimestamp?: number;
  botDetectedTimestamp?: number;
  orderSentTimestamp?: number;
  fillTimestamp?: number;
  shadowExpectedEntry?: number;
  shadowExpectedExit?: number;
  actualEntry?: number;
  actualExit?: number;
  entrySlippage?: number;
  exitSlippage?: number;
  missedReason?: string;
  partialFillReason?: string;
  executionPolicy?: OrderExecutionPolicy;
  entryBookDepth?: number;
  entryDepthMultiple?: number;
  expectedLiveExecutableReturnPct?: number;
  sourceSellRealizedRatio?: number;
  /** Durable source attribution; signals are retention-pruned. */
  alignedWallets?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface BotConfig {
  paperMode: true;
  /** Kill switch for new paper entries. Scanning, scoring, and open-position oversight continue. */
  newEntriesEnabled?: boolean;
  /** Inclusive timestamp used to start a fresh displayed/risk performance epoch without deleting audit history. */
  performanceStartAt?: number;
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
  /** Permit an exceptional single-source signal after all proof gates pass. Default false. */
  allowSingleSourceSignals?: boolean;
  /** Market categories excluded from the active discovery and signal universe. */
  blockedMarketCategories?: MarketCategory[];
  /** Optional positive category allowlist. Empty blocks all wallet-copy entries when categoryTradingGateEnabled is true. */
  allowedMarketCategories?: MarketCategory[];
  /** Enforce the positive category allowlist for wallet-copy entries. An empty list blocks wallet-copy entries. */
  categoryTradingGateEnabled?: boolean;
  /** Wallet activity is lead-generation only unless this explicit kill switch is enabled. */
  walletLeadTradingEnabled?: boolean;
  /** Periodically research persistent leaderboard wallets without auto-promoting them. */
  walletResearchEnabled?: boolean;
  /** Interval between expensive discovery/history/resolution/shadow source refreshes. Hot scans reuse audited scores between runs. */
  sourceScoringRefreshIntervalMs?: number;
  /** Minimum time between full leaderboard research refreshes. */
  walletResearchIntervalMs?: number;
  /** Maximum diversified leaderboard candidates profiled per refresh. */
  walletResearchCandidateLimit?: number;
  /** Recent all-role and taker-only trades inspected per research candidate. */
  walletResearchTradeLimit?: number;
  /** Closed positions inspected per research candidate. */
  walletResearchClosedPositionLimit?: number;
  /** Run deterministic strategy-cluster hypotheses after each wallet-research refresh. */
  strategyResearchEnabled?: boolean;
  /** Strategy cluster receiving first validation and reporting priority. */
  primaryResearchStrategy?: StrategyCluster;
  /** Run the independent weather fair-value scanner. */
  weatherStrategyEnabled?: boolean;
  /** Minimum absolute model-vs-market probability edge for a paper candidate. */
  weatherMinProbabilityEdge?: number;
  /** Maximum claimed model edge accepted for the prospective experiment; extreme disagreement is treated as model error. */
  weatherMaxProbabilityEdge?: number;
  /** Only these outcome labels may enter the prospective weather experiment. */
  weatherAllowedOutcomes?: string[];
  /** Prospective weather entry-price band, independent of wallet-copy price gates. */
  weatherMinEntryPrice?: number;
  weatherMaxEntryPrice?: number;
  /** Minimum net expected return on cost for a paper candidate. */
  weatherMinExpectedValuePct?: number;
  /** Maximum normalized ensemble uncertainty accepted for a paper candidate. */
  weatherMaxUncertainty?: number;
  /** Minimum hours to weather-market resolution. */
  weatherMinTimeToResolutionHours?: number;
  /** Number of days used by the forward-forecast skill validation. */
  weatherBacktestDays?: number;
  /** Re-run weather forecast-skill validation after this interval. */
  weatherBacktestIntervalMs?: number;
  /** Most frequently represented resolution stations validated independently per weather refresh. */
  weatherValidationStationLimit?: number;
  /** Completed-day lag for station forecast-skill validation; at least two days prevents incomplete actuals. */
  weatherValidationLagDays?: number;
  /** Timestamp at which the frozen weather policy began collecting promotion evidence. */
  weatherForwardPolicyStartAt?: number;
  /** Immutable identifier for the prospective weather policy. */
  weatherForwardPolicyVersion?: string;
  /** Resolved forward candidates required before the weather policy can be considered for promotion. */
  weatherForwardMinResolvedTrades?: number;
  /** Minimum settlement return required for promotion. */
  weatherForwardMinReturnPct?: number;
  /** Collect append-only, fixed-horizon weather challenger observations. This never places orders. */
  weatherTournamentEnabled?: boolean;
  /** Executable notional used by the research-only weather tournament. */
  weatherTournamentPositionSizeUsd?: number;
  /** Pull complete low-volume weather events from Gamma instead of relying on the global volume ranking. */
  weatherDedicatedDiscoveryEnabled?: boolean;
  /** Number of upcoming weather events fetched before local prioritization. */
  weatherDiscoveryEventFetchLimit?: number;
  /** Complete weather events admitted to the scoring loop, prioritizing validated stations. */
  weatherDiscoveryEventSelectLimit?: number;
  /** Forward window for dedicated weather-event discovery. */
  weatherDiscoveryLookaheadHours?: number;
  /** Paper-exit policy for newly selected weather observations. */
  weatherExitPolicy?: "GENERIC_MARK_TO_MARKET" | "HOLD_TO_RESOLUTION";
  /** Distinct concurrently open independent-model paper experiments. */
  independentModelMaxOpenTrades?: number;
  /** Run Binance-close crypto threshold probability models. */
  cryptoThresholdStrategyEnabled?: boolean;
  cryptoThresholdMinProbabilityEdge?: number;
  cryptoThresholdMaxProbabilityEdge?: number;
  cryptoThresholdMinEntryPrice?: number;
  cryptoThresholdMaxEntryPrice?: number;
  cryptoThresholdMinTimeToResolutionHours?: number;
  cryptoThresholdMaxTimeToResolutionHours?: number;
  cryptoThresholdBacktestIntervalMs?: number;
  cryptoThresholdForwardPolicyStartAt?: number;
  cryptoThresholdForwardPolicyVersion?: string;
  cryptoThresholdForwardMinResolvedTrades?: number;
  cryptoThresholdForwardMinReturnPct?: number;
  /** Run scheduled U.S. CPI release probability models using BLS data. */
  macroCpiStrategyEnabled?: boolean;
  macroCpiMinProbabilityEdge?: number;
  macroCpiMaxProbabilityEdge?: number;
  macroCpiMinEntryPrice?: number;
  macroCpiMaxEntryPrice?: number;
  macroCpiMinTimeToReleaseHours?: number;
  macroCpiMaxTimeToReleaseHours?: number;
  macroCpiBacktestIntervalMs?: number;
  macroCpiForwardPolicyStartAt?: number;
  macroCpiForwardPolicyVersion?: string;
  macroCpiForwardMinResolvedTrades?: number;
  macroCpiForwardMinReturnPct?: number;
  /** Flat paper stake for uncalibrated independent-model experiments. */
  independentModelFlatPositionSize?: number;
  /** Fixed wallet-copy notional shared by live paper and shadow execution. */
  walletCopyFlatPositionSize?: number;
  /** Enable EV/liquidity/risk-based sizing for independent model signals. */
  dynamicSizingEnabled?: boolean;
  /** Fraction of full Kelly used before uncertainty and risk reductions. */
  kellyFraction?: number;
  /** Maximum bankroll fraction for one dynamically sized position. */
  maxDynamicPositionPct?: number;
  /** Maximum share of executable ask depth consumed by an entry. */
  maxBookDepthPct?: number;
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
  /** When true, refresh source wallet trade history before reviewing open-position exits. */
  sourceExitPollingEnabled?: boolean;
  /** Minimum interval per source wallet between open-position source-sell refreshes. */
  sourceExitPollIntervalMs?: number;
  /** Number of latest source wallet trades to fetch while a copied position is open. */
  sourceExitWalletTradeLimit?: number;
  /** Cooldown after a losing stop-out on a token before it can be re-entered, in ms. 0 disables. */
  stopCooldownMs?: number;
  /** Cooldown after any entry in the same market/outcome, regardless of exit reason. */
  marketEntryCooldownMs?: number;
  /** Maximum age for a source BUY to be copyable. Old wallet history can score sources, but should not trigger fresh entries. */
  maxSourceBuyAgeMs?: number;
  /** Cooldown after any entry from the same source/market/outcome/profile, in ms. Prevents repeated chasing. */
  sourceEntryCooldownMs?: number;
  /** Minimum live-executable shadow sample needed before a source can trade. */
  minLiveExecutableShadowTradesForTrading?: number;
  /** Minimum live-executable shadow PnL needed before a source can trade. */
  minLiveExecutableShadowPnlForTrading?: number;
  /** Minimum live-executable shadow win rate needed for auto-promotion. */
  minLiveExecutableShadowWinRateForTrading?: number;
  /** Allow paper-only probation entries when no source currently passes the live-ready gate. */
  paperProbationTradingEnabled?: boolean;
  /** Minimum signal confidence for paper-only probation entries. */
  paperProbationMinSignalConfidence?: number;
  /** Minimum wallet score for paper-only probation sources. */
  paperProbationMinWalletScore?: number;
  /** Minimum copyability score for paper-only probation sources. */
  paperProbationMinCopyabilityScore?: number;
  /** Minimum source sample confidence for paper-only probation sources. */
  paperProbationMinSampleConfidence?: number;
  /** Minimum source-sell realization ratio for paper-only probation entries when available. */
  paperProbationMinSourceSellRatio?: number;
  /** Minimum entry book depth multiple for paper-only probation entries. */
  paperProbationEntryDepthMultiple?: number;
  /** Maximum entry slippage for paper-only probation entries. */
  paperProbationMaxEntrySlippage?: number;
  /** Minimum recent source trades required for paper-only probation sources. */
  paperProbationMinRecentTrades?: number;
  /** Reject probation sources once this many live-exec samples are non-profitable. */
  paperProbationKnownBadLiveExecTrades?: number;
  /** Reject sources whose own paper-copy history is materially negative. */
  blockPaperUnderperformers?: boolean;
  /** Minimum paper-copy filled orders before paper underperformance can block a source. */
  minPaperFillsForTrading?: number;
  /** Reject a source below this paper-copy average return once the sample is large enough. */
  minPaperAvgReturnPctForTrading?: number;
  /** Reject a source below this paper-copy PnL once the sample is large enough. */
  minPaperPnlForTrading?: number;
  /** Promote prior high-quality live-executable shadow wallets into the active scoring set. */
  liveExecutableAutoTrackEnabled?: boolean;
  /** Number of historical live-executable shadow winners to keep in the active scoring set. */
  liveExecutableAutoTrackLimit?: number;
  /** Persist per-cycle signal drop diagnostics so no-signal periods are explainable. */
  signalDiagnosticsEnabled?: boolean;
  /** Paper-only fallback that lets the bot collect live-executable evidence when no proven source pool exists. */
  paperExplorationEnabled?: boolean;
  /** Maximum paper-exploration trade candidates to allow in one scan cycle. */
  paperExplorationMaxCandidatesPerCycle?: number;
  /** Maximum age for paper-exploration source BUYs. Live-ready entries still use maxSourceBuyAgeMs. */
  paperExplorationMaxSourceBuyAgeMs?: number;
  /** Maximum time to resolution for paper-exploration entries. Live-ready entries still use maxTimeToResolutionHours. */
  paperExplorationMaxTimeToResolutionHours?: number;
  /** Minimum signal confidence for a paper-exploration candidate. */
  paperExplorationMinConfidence?: number;
  /** Minimum source-sell realization ratio required before paper exploration can bypass missing live-exec proof. */
  paperExplorationMinSourceSellRealizedRatio?: number;
  /** Minimum entry depth multiple for paper-exploration entries. */
  paperExplorationEntryDepthMultiple?: number;
  /** How often to persist public parity scorecards while monitoring open positions. */
  parityScorecardIntervalMs?: number;
  /** Minimum wait before resubmitting another failed exit order for the same position. */
  exitRetryCooldownMs?: number;
  /** Close paper positions at zero after this much time with no executable bid. 0 disables. */
  noBidPositionCloseAfterMs?: number;
  /** Close paper positions at their cached mark after this much time without a fresh order book. 0 disables. */
  noBookPositionCloseAfterMs?: number;
  /** Lookback window for the cached live-gate replay audit script. */
  replayAuditLookbackHours?: number;
  /** Wallet count for the cached live-gate replay audit script. */
  replayAuditWalletLimit?: number;
  volumeSpikeMultiplier: number;
  spreadExitThreshold: number;
  priceReversalPct: number;
  maxPositionHoldHours: number;
  scanIntervalMs: number;
  /** Bounded concurrency for market book retrieval and independent-strategy scoring. */
  signalMarketConcurrency?: number;
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
  /**
   * Lowest preliminary score that still deserves a shadow-copy audit. This is
   * intentionally below minWalletScore so shadow evidence can discover
   * copyable wallets that raw reputation underrates.
   */
  shadowCandidateMinScore?: number;
  /** Minimum simulated copy trades before a discovered/probation source can be promoted into live paper signals. */
  minShadowTradesForPromotion?: number;
  /** Minimum shadow PNL required before a discovered/probation source can be promoted into live paper signals. */
  minShadowPnlForPromotion?: number;
  /** Require shadow proof for auto-discovered/probation wallets before they can create trade candidates. */
  requireShadowProofForDiscovered?: boolean;
  /** Minimum sell/buy ratio required before a source can be treated as copyable. */
  minSellRatioForPromotion?: number;
  /** Minimum category consistency required before a discovered source can become tradeable. */
  minCategoryConsistencyForPromotion?: number;
  /** Minimum copyability score required before a discovered source can become tradeable. */
  minCopyabilityForPromotion?: number;
  shadowCopyDelayMs: number;
  shadowMaxEntryPriceMovePct: number;
  shadowPositionSize: number;
  /** Frozen identifier for prospective live/shadow parity evidence. */
  liveShadowPolicyVersion?: string;
  /** Maximum source-to-observation lag admitted as genuinely prospective evidence. */
  forwardObservationMaxLagMs?: number;
  shadowHistoryLimit: number;
  liveExecutableShadowEnabled?: boolean;
  liveParityGateEnabled?: boolean;
  entryOrderPolicy?: OrderExecutionPolicy;
  exitOrderPolicy?: OrderExecutionPolicy;
  liveExecutableMinReturnPct?: number;
  minSourceSellRealizedRatio?: number;
  entryBookDepthMultiple?: number;
  maxEntrySlippage?: number;
  maxExitSlippage?: number;
  /** Max sell slippage for source-sell, stop-loss, stale/no-book, and other urgent exits. */
  urgentExitSlippage?: number;
  /** Max sell slippage for take-profit exits. Defaults to maxExitSlippage. */
  takeProfitExitSlippage?: number;
  orderTickSize?: number;
  liveExecutionFeeRatePct?: number;
  maxOrderBookAgeMs?: number;
  deepHistoryEnabled: boolean;
  deepHistoryWalletLimit: number;
  deepHistoryPages: number;
  deepHistoryPageSize: number;
  resolutionBackfillLimit: number;
  /** Prospective execution research never creates paper or live orders. */
  executionResearchEnabled?: boolean;
  /** Stop opening new maker-policy observations while preserving frozen history and inventory reconciliation. */
  makerResearchEnabled?: boolean;
  /** Stop opening new cross-market latency observations while preserving frozen history. */
  crossMarketResearchEnabled?: boolean;
  executionResearchUniverseLimit?: number;
  executionResearchMinVolume24h?: number;
  executionResearchBookDepthLevels?: number;
  executionResearchPolicyStartAt?: number;
  executionResearchPolicyVersion?: string;
  executionResearchMinResolved?: number;
  executionResearchMinDistinctMarkets?: number;
  executionResearchMinReturnPct?: number;
  executionResearchMinWinRate?: number;
  makerResearchQuoteShares?: number;
  makerResearchPolicyStartAt?: number;
  makerResearchPolicyVersion?: string;
  makerResearchMinPairEdge?: number;
  /** Reject apparent maker edges above this value; extreme gaps are usually incomplete or incoherent books. */
  makerResearchMaxPairEdge?: number;
  /** Per-leg maker quote price band used to avoid noise-dominated extreme outcomes. */
  makerResearchMinQuotePrice?: number;
  makerResearchMaxQuotePrice?: number;
  /** Maximum spread accepted on either complementary token before opening a maker quote. */
  makerResearchMaxLegSpread?: number;
  /** Maximum receive-time difference between the two complementary order books. */
  makerResearchMaxBookTimestampSkewMs?: number;
  makerResearchQuoteTtlMs?: number;
  /** Minimum current opposite best-ask depth for either possible one-leg maker fill. */
  makerResearchMinHedgeDepthMultiple?: number;
  /** Maximum modeled loss on capital when immediately hedging either possible one-leg fill. */
  makerResearchMaxHedgeLossPct?: number;
  /** Maximum unmatched maker inventory, in outcome shares, before forced hedging. */
  makerResearchMaxInventoryShares?: number;
  /** Maximum time unmatched maker inventory may be carried before forced hedging. */
  makerResearchMaxInventoryAgeMs?: number;
  /** Hard deadline for a fresh REST book request before a forced hedge is scored as unavailable. */
  makerResearchHedgeRefreshTimeoutMs?: number;
  /** Reject and stop managing quotes when the local book is older than this. */
  makerResearchMaxBookAgeMs?: number;
  /** Inventory skew, in ticks, applied per quote-size unit of net exposure. */
  makerResearchInventorySkewTicks?: number;
  /** Cancel/requote when either quoted top price moves by this many ticks. */
  makerResearchRequoteTicks?: number;
  /** Do not quote this close to a known market end/catalyst. */
  makerResearchMinTimeToEndMs?: number;
  pairedResearchShares?: number;
  pairedResearchMinNetEdge?: number;
  binaryArbPolicyStartAt?: number;
  binaryArbPolicyVersion?: string;
  binaryArbExecutionLatencyMs?: number;
  binaryArbExecutionTimeoutMs?: number;
  binaryArbMaxBookAgeMs?: number;
  binaryArbMinDepthMultiple?: number;
  /** Prospective cross-market monotonic threshold-pair execution policy. */
  thresholdLadderPolicyStartAt?: number;
  thresholdLadderPolicyVersion?: string;
  thresholdLadderExecutionLatencyMs?: number;
  thresholdLadderExecutionTimeoutMs?: number;
  thresholdLadderMaxBookAgeMs?: number;
  thresholdLadderMaxBookTimestampSkewMs?: number;
  thresholdLadderMinDepthMultiple?: number;
  negRiskArbPolicyStartAt?: number;
  negRiskArbPolicyVersion?: string;
  crossMarketPolicyStartAt?: number;
  crossMarketPolicyVersion?: string;
  crossMarketResearchSizeUsd?: number;
  crossMarketMoveThresholdBps?: number;
  crossMarketMoveWindowMs?: number;
  crossMarketHoldMs?: number;
  crossMarketEntryLatencyMs?: number;
  crossMarketEntryTimeoutMs?: number;
  crossMarketMinEntryPrice?: number;
  crossMarketMaxEntryPrice?: number;
  crossMarketMaxSpread?: number;
  crossMarketMinDepthMultiple?: number;
  crossMarketMaxBookAgeMs?: number;
  crossMarketMaxMarketsPerSignal?: number;
  crossMarketSignalCooldownMs?: number;
  /** Official/live CPI nowcast input. It is stored prospectively and never backfilled into validation. */
  macroCpiNowcastEnabled?: boolean;
  macroCpiNowcastUrl?: string;
  macroCpiNowcastWeight?: number;
  macroCpiMaxNowcastAgeMs?: number;
}

export interface RuntimeEnv {
  gammaApiUrl: string;
  dataApiUrl: string;
  clobApiUrl: string;
  clobWsUrl: string;
  dbPath: string;
  researchTapeDir?: string;
  cryptoReferenceWsUrl?: string;
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
