import { makeClients } from "./clients.js";
import { loadBotConfig, loadRuntimeEnv } from "./config.js";
import { BotDatabase } from "./db.js";
import { AgentEventWriter } from "./events/eventWriter.js";
import { PolymarketProvider } from "./providers/polymarketProvider.js";
import { WalletResearchAgent } from "./agents/walletResearchAgent.js";

const config = loadBotConfig();
const env = loadRuntimeEnv();
const db = new BotDatabase(env.dbPath, config.performanceStartAt);
const events = new AgentEventWriter(db);
const provider = new PolymarketProvider(makeClients(env));
const agent = new WalletResearchAgent(provider, db, events, config);

try {
  const reports = process.argv.includes("--cached")
    ? db.getWalletResearchReports(config.walletResearchCandidateLimit ?? 100)
    : await agent.refresh(true);
  console.log("Rolling All-Category Top-100 Wallet Research");
  console.log(`Candidates: ${reports.length} | direct auto-promotion: disabled`);
  console.log("");
  for (const report of reports.sort((a, b) => b.researchScore - a.researchScore)) {
    console.log(`${report.name || shortWallet(report.wallet)} [${report.archetype}] lead-score=${report.researchScore} execution-score=${report.executionCompatibilityScore} recommendation=${report.recommendation}`);
    console.log(`  periods=${report.leaderboardPeriods.join(",")} categories=${report.leaderboardCategories.join(",")} closed=${report.closedPositions} pnl=$${report.closedPnl.toFixed(2)} win=${pct(report.closedWinRate)}`);
    console.log(`  maker=${pct(report.estimatedMakerShare)} paired=${pct(report.twoOutcomeMarketRate)} median-buy=$${report.medianBuyNotional.toFixed(2)} $10-compatible=${pct(report.copyableAt10Rate)} (execution diagnostic only)`);
    if (report.predictionBrier !== undefined) console.log(`  resolved=${report.resolvedPredictions} brier=${report.predictionBrier.toFixed(3)} directional-accuracy=${pct(report.predictionAccuracy ?? 0)}`);
    for (const pattern of report.patterns) console.log(`  - ${pattern}`);
  }
  console.log("");
  console.log("MODEL_EDGE_ONLY means study the wallet's market-selection method; do not chase its fills. SHADOW_DIRECTIONAL still requires forward executable validation before paper eligibility.");
} finally {
  db.close();
}

function shortWallet(wallet: string): string {
  return `${wallet.slice(0, 8)}...${wallet.slice(-4)}`;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
