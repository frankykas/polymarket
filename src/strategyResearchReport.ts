import { loadBotConfig, loadRuntimeEnv } from "./config.js";
import { BotDatabase } from "./db.js";

const config = loadBotConfig();
const env = loadRuntimeEnv();
const db = new BotDatabase(env.dbPath, config.performanceStartAt);

try {
  const hypotheses = db.getStrategyHypotheses();
  const tests = new Map(db.getLatestStrategyBacktests().map((result) => [result.hypothesisId, result]));
  const opportunities = db.getWeatherOpportunities(100);
  console.log("Independent Strategy Research Scorecard");
  console.log(`Hypotheses: ${hypotheses.length} | weather opportunities stored: ${opportunities.length}`);
  console.log("");
  for (const hypothesis of hypotheses.sort((a, b) => b.evidenceScore - a.evidenceScore)) {
    const result = tests.get(hypothesis.id);
    console.log(`${hypothesis.cluster}: ${hypothesis.title}`);
    console.log(`  lead wallets=${hypothesis.sourceWalletCount} lead evidence=${hypothesis.evidenceScore}/100 status=${hypothesis.status}`);
    console.log(`  independent test=${result?.testKind ?? "PENDING"} sample=${result?.sampleSize ?? 0} passed=${result?.passed ?? false}`);
    if (result) console.log(`  metrics=${JSON.stringify(result.metrics)}`);
    console.log(`  ${result?.reason ?? "No independent result stored yet."}`);
  }
  const candidates = opportunities.filter((item) => item.status === "CANDIDATE");
  console.log("");
  console.log(`Weather scanner: ${candidates.length} candidate(s), ${opportunities.filter((item) => item.status === "WATCHLIST").length} watchlist observation(s).`);
  for (const item of candidates.slice(0, 10)) {
    console.log(`  ${item.spec.city} ${item.spec.targetDate} ${item.outcome}: fair=${pct(item.fairProbability)} ask=${pct(item.marketProbability)} edge=${pct(item.probabilityEdge)} EV=${pct(item.expectedValuePct)}`);
  }
} finally {
  db.close();
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
