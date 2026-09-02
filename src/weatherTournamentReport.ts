import { loadBotConfig, loadRuntimeEnv } from "./config.js";
import { BotDatabase } from "./db.js";
import { buildWeatherTournamentReport, WEATHER_TOURNAMENT_VERSION } from "./weatherStrategyTournament.js";

const config = loadBotConfig();
const env = loadRuntimeEnv();
const db = new BotDatabase(env.dbPath, config.performanceStartAt);

try {
  const observations = db.getWeatherTournamentObservations(WEATHER_TOURNAMENT_VERSION);
  const report = buildWeatherTournamentReport({ observations, marketForId: (marketId) => db.getMarketById(marketId) });
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Weather strategy tournament: ${report.tournamentVersion}`);
    console.log(`Decision checkpoints: ${report.screenAt} resolved station-days / ${report.finalAt} final`);
    for (const arm of report.arms) {
      console.log([
        `\n${arm.armLabel} [${arm.decision}]`,
        `observed/resolved: ${arm.observations}/${arm.resolved}; executable resolved: ${arm.eligibleResolved}`,
        `executable P&L: $${arm.pnlUsd.toFixed(2)} on $${arm.capitalUsd.toFixed(2)} (${(arm.returnPct * 100).toFixed(2)}%)`,
        `Brier model/market/improvement: ${formatOptional(arm.modelBrierScore)} / ${formatOptional(arm.marketBrierScore)} / ${formatOptional(arm.brierImprovement)}`,
        arm.decisionReason
      ].join("\n"));
    }
  }
} finally {
  db.close();
}

function formatOptional(value: number | undefined): string {
  return value === undefined ? "n/a" : value.toFixed(4);
}
