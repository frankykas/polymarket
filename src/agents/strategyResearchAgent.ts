import { randomId } from "../db.js";
import type { BotDatabase } from "../db.js";
import type { AgentEventWriter } from "../events/eventWriter.js";
import type {
  BotConfig,
  StrategyBacktestResult,
  StrategyCluster,
  StrategyHypothesis,
  WalletResearchReport
} from "../types.js";

interface HypothesisTemplate {
  title: string;
  thesis: string;
  entryRule: string;
  exitRule: string;
  requiredData: string[];
}

const TEMPLATES: Record<StrategyCluster, HypothesisTemplate> = {
  WEATHER_FORECASTING: {
    title: "Ensemble weather fair-value dislocation",
    thesis: "Station-matched ensemble distributions can price daily temperature buckets more accurately than the current ask.",
    entryRule: "Buy an outcome only when calibrated ensemble fair probability clears the live ask by the configured edge and EV gates.",
    exitRule: "Use portfolio stops/take-profit controls and settle against the market's named station.",
    requiredData: ["market resolution station", "multi-model ensembles", "live order book", "historical forecast errors"]
  },
  CRYPTO_THRESHOLD: {
    title: "Crypto threshold distribution model",
    thesis: "Options-implied and realized volatility can price date-specific crypto thresholds independently of wallet activity.",
    entryRule: "Trade only when a volatility-calibrated terminal distribution clears fees, spread, and model uncertainty.",
    exitRule: "Reprice continuously; exit when edge closes or risk limits trigger.",
    requiredData: ["spot history", "options surface", "market rules", "live order book"]
  },
  POLITICAL_NEWS: {
    title: "Political base-rate and news update model",
    thesis: "Base rates plus time-stamped primary-source updates may identify slow repricing without copying a wallet.",
    entryRule: "Enter only after a pre-registered evidence update produces a calibrated probability edge.",
    exitRule: "Exit on contradictory primary evidence, edge convergence, or risk controls.",
    requiredData: ["primary-source event feed", "historical base rates", "resolution rules", "live order book"]
  },
  MENTION_EVENT: {
    title: "Mention-event intensity model",
    thesis: "Historical speaking rates and scheduled-event context can estimate mention probability.",
    entryRule: "Trade when an independently estimated mention probability clears market and execution costs.",
    exitRule: "Stop entering after event start; settle from the specified transcript source.",
    requiredData: ["historical transcripts", "event schedule", "entity aliases", "market rules"]
  },
  MACRO_RELEASE: {
    title: "Macro release surprise distribution",
    thesis: "Consensus dispersion and leading data can estimate release buckets before publication.",
    entryRule: "Trade only a preregistered release model with out-of-sample calibration and positive net EV.",
    exitRule: "Exit before/at release according to tested execution policy.",
    requiredData: ["vintage macro data", "consensus history", "release calendar", "live order book"]
  },
  SPORTS_INFORMATION: {
    title: "Sports information timing model",
    thesis: "Lineups, injuries, and consensus odds may expose stale prediction-market prices.",
    entryRule: "Research only until an independent odds and news archive passes walk-forward validation.",
    exitRule: "Close before event start unless the in-play strategy is independently validated.",
    requiredData: ["historical bookmaker odds", "lineup/injury feed", "event results", "market tape"]
  },
  PAIRED_OUTCOME_ARBITRAGE: {
    title: "Paired-outcome mispricing",
    thesis: "Some wallet profits may come from buying complete or complementary sets below terminal value.",
    entryRule: "Enter atomically only when all paired legs are executable and total cost plus fees is below guaranteed payout.",
    exitRule: "Hold the complete set to conversion or unwind only at a locked positive return.",
    requiredData: ["complete market outcome graph", "all-leg order books", "fees", "conversion rules"]
  },
  MAKER_PRICING: {
    title: "Passive maker spread capture",
    thesis: "Maker-dominant wallet results may reflect queue placement and spread capture, not directional prediction.",
    entryRule: "Quote only after a queue-aware fill model demonstrates positive adverse-selection-adjusted EV.",
    exitRule: "Cancel on toxic flow and keep inventory inside a fixed risk band.",
    requiredData: ["tick-level books", "queue estimates", "maker fills", "fee/reward schedule"]
  },
  CROSS_MARKET_LATENCY: {
    title: "Cross-market latency dislocation",
    thesis: "Short-lived moves in an external reference venue may lead stale executable prediction-market quotes.",
    entryRule: "Observe only prospective reference moves and enter the shadow ledger at the contemporaneous ask after all fees.",
    exitRule: "Exit at the executable bid after the frozen holding interval and charge both entry and exit costs.",
    requiredData: ["exchange-timestamped reference feed", "tick-level market books", "receive latency", "executable depth"]
  },
  GENERAL_EVENT: {
    title: "General event calibrated base-rate model",
    thesis: "Repeated event classes may support independent base-rate pricing.",
    entryRule: "No entry until the event class has a clean historical label set and walk-forward calibration.",
    exitRule: "Reprice on evidence updates and obey portfolio risk controls.",
    requiredData: ["historical event labels", "resolution rules", "time-stamped market tape"]
  }
};

export class StrategyResearchAgent {
  constructor(private db: BotDatabase, private events: AgentEventWriter, private config: BotConfig) {}

  refresh(reports: WalletResearchReport[], now = Date.now()): StrategyHypothesis[] {
    if (this.config.strategyResearchEnabled === false) return this.db.getStrategyHypotheses();
    const cached = this.db.getStrategyHypotheses();
    const newestReport = Math.max(0, ...reports.map((report) => report.updatedAt));
    const implementedClusters = new Set<StrategyCluster>([
      ...(this.config.weatherStrategyEnabled !== false ? ["WEATHER_FORECASTING" as const] : []),
      ...(this.config.cryptoThresholdStrategyEnabled !== false ? ["CRYPTO_THRESHOLD" as const] : []),
      ...(this.config.macroCpiStrategyEnabled !== false ? ["MACRO_RELEASE" as const] : []),
      ...(this.config.executionResearchEnabled !== false
        ? ["CROSS_MARKET_LATENCY" as const, "MAKER_PRICING" as const, "PAIRED_OUTCOME_ARBITRAGE" as const]
        : [])
    ]);
    const implementationStateCurrent = [...implementedClusters].every((cluster) =>
      cached.some((hypothesis) => hypothesis.cluster === cluster && hypothesis.status !== "DATA_REQUIRED")
    );
    if (cached.length > 0 && implementationStateCurrent && Math.min(...cached.map((hypothesis) => hypothesis.updatedAt)) >= newestReport) return cached;
    const grouped = new Map<StrategyCluster, WalletResearchReport[]>();
    for (const report of reports) {
      for (const cluster of clustersFor(report)) {
        grouped.set(cluster, [...(grouped.get(cluster) ?? []), report]);
      }
    }
    // Implemented independent models must remain visible and testable even in a
    // refresh where no currently ranked wallet happens to seed that cluster.
    if (this.config.weatherStrategyEnabled !== false && !grouped.has("WEATHER_FORECASTING")) grouped.set("WEATHER_FORECASTING", []);
    if (this.config.cryptoThresholdStrategyEnabled !== false && !grouped.has("CRYPTO_THRESHOLD")) grouped.set("CRYPTO_THRESHOLD", []);
    if (this.config.macroCpiStrategyEnabled !== false && !grouped.has("MACRO_RELEASE")) grouped.set("MACRO_RELEASE", []);
    if (this.config.executionResearchEnabled !== false && !grouped.has("CROSS_MARKET_LATENCY")) grouped.set("CROSS_MARKET_LATENCY", []);
    if (this.config.executionResearchEnabled !== false && !grouped.has("MAKER_PRICING")) grouped.set("MAKER_PRICING", []);
    if (this.config.executionResearchEnabled !== false && !grouped.has("PAIRED_OUTCOME_ARBITRAGE")) grouped.set("PAIRED_OUTCOME_ARBITRAGE", []);

    const hypotheses: StrategyHypothesis[] = [];
    for (const [cluster, clusterReports] of grouped) {
      const template = TEMPLATES[cluster];
      const independentlyImplemented = cluster === "WEATHER_FORECASTING" ||
        (cluster === "CRYPTO_THRESHOLD" && this.config.cryptoThresholdStrategyEnabled !== false) ||
        (cluster === "MACRO_RELEASE" && this.config.macroCpiStrategyEnabled !== false) ||
        (["CROSS_MARKET_LATENCY", "MAKER_PRICING", "PAIRED_OUTCOME_ARBITRAGE"] as StrategyCluster[]).includes(cluster) && this.config.executionResearchEnabled !== false;
      const prior = cached.find((hypothesis) => hypothesis.cluster === cluster);
      const sourceWallets = clusterReports.length > 0
        ? [...new Set(clusterReports.map((report) => report.wallet.toLowerCase()))]
        : prior?.sourceWallets ?? [];
      const evidenceScore = clusterReports.length > 0
        ? Math.round(average(clusterReports.map((report) => report.researchScore)))
        : prior?.evidenceScore ?? 0;
      const hypothesis: StrategyHypothesis = {
        id: `hypothesis_${cluster.toLowerCase()}`,
        cluster,
        ...template,
        sourceWallets,
        sourceWalletCount: sourceWallets.length,
        evidenceScore,
        status: independentlyImplemented ? "VALIDATING" : "DATA_REQUIRED",
        updatedAt: now
      };
      this.db.saveStrategyHypothesis(hypothesis);
      hypotheses.push(hypothesis);

      if (!independentlyImplemented) {
        const audit: StrategyBacktestResult = {
          id: randomId("backtest"),
          hypothesisId: hypothesis.id,
          cluster,
          testKind: "DATA_AVAILABILITY",
          independentFromLeadWallets: true,
          sampleSize: 0,
          passed: false,
          metrics: { dataReady: false },
          reason: `Not promoted: independent ${template.requiredData.join(", ")} dataset is not yet available; wallet P&L is lead evidence, not a backtest.`,
          createdAt: now
        };
        this.db.saveStrategyBacktest(audit);
      }
    }

    this.events.write({
      type: "strategy_research.handoff",
      agent: "Strategy Research Agent",
      visibility: "PUBLIC",
      message: `Clustered ${reports.length} researched wallets into ${hypotheses.length} strategy hypothesis set(s); no wallet P&L was counted as independent validation.`,
      payload: hypotheses.map((hypothesis) => ({
        id: hypothesis.id,
        cluster: hypothesis.cluster,
        leads: hypothesis.sourceWalletCount,
        status: hypothesis.status,
        evidenceScore: hypothesis.evidenceScore
      }))
    });
    return hypotheses;
  }
}

export function clustersFor(report: WalletResearchReport): StrategyCluster[] {
  if (report.archetype === "MAKER_SPECIALIST") return ["MAKER_PRICING"];
  if (report.archetype === "PAIRED_OUTCOME_ARBITRAGE") return ["PAIRED_OUTCOME_ARBITRAGE"];
  const clusters = new Set<StrategyCluster>();
  for (const category of report.leaderboardCategories) {
    if (category === "WEATHER") clusters.add("WEATHER_FORECASTING");
    else if (category === "CRYPTO") clusters.add("CRYPTO_THRESHOLD");
    else if (category === "POLITICS") clusters.add("POLITICAL_NEWS");
    else if (category === "MENTIONS") clusters.add("MENTION_EVENT");
    else if (category === "ECONOMICS" || category === "FINANCE") clusters.add("MACRO_RELEASE");
    else if (category === "SPORTS" || category === "ESPORTS") clusters.add("SPORTS_INFORMATION");
  }
  if (clusters.size === 0) clusters.add("GENERAL_EVENT");
  return [...clusters];
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}
