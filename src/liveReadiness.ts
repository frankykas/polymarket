import type { BotConfig, LiveReadinessReport } from "./types.js";

export function formatPlainLiveReadinessReport(report: LiveReadinessReport, config: BotConfig): string {
  const m = report.metrics;
  const lines = [
    `StratiFi Live Readiness (${report.lookbackHours}h)`,
    "",
    `Verdict: ${report.status} (${report.score}/100)`,
    `Executable PnL: ${money(m.executableTotalPnl)} | Stored PnL: ${money(m.storedTotalPnl)}`,
    `Realized: ${money(m.realizedPnl)} | Executable unrealized: ${money(m.executableUnrealizedPnl)}`,
    `Open: ${m.openPositions} position(s), ${money(m.openExposure)} exposure, ${m.noBidOpenPositions} no-bid`,
    "",
    "Execution",
    `FOK entries: ${m.fokEntryFills}/${m.fokEntryOrders} filled, ${pct(m.fokEntryMissRate)} missed`,
    `Exits: ${m.exitFills}/${m.exitOrders} filled/partial, ${pct(m.exitMissRate)} missed`,
    `Entry slippage: avg ${cents(m.avgEntrySlippage)}, max ${cents(m.maxEntrySlippage)} (limit ${cents(config.maxEntrySlippage ?? 0.03)})`,
    `Exit slippage: avg ${cents(m.avgExitSlippage)}, max ${cents(m.maxExitSlippage)} (limit ${cents(config.maxExitSlippage ?? config.maxEntrySlippage ?? 0.03)})`,
    `Entry depth: avg ${m.avgEntryDepthMultiple.toFixed(2)}x (target ${(config.entryBookDepthMultiple ?? 3).toFixed(2)}x)`,
    "",
    "Trade Quality",
    `Closed trades: ${m.closedPositions} | Wins/losses: ${m.wins}/${m.losses} | Win rate: ${pct(m.winRate)}`,
    `Source-sell: ${m.sourceSellExits}/${m.sourceSellDetections} exits (${optionalPct(m.sourceSellSuccessRate)})`,
    `Take-profit exits: ${m.takeProfitExitFills} fill(s), ${m.takeProfitExitMisses} miss(es) (${optionalPct(m.takeProfitFillRate)} fill rate)`,
    `Urgent exits: ${m.urgentExitFills} fill(s), ${m.urgentExitMisses} miss(es) (${optionalPct(m.urgentExitFillRate)} fill rate)`,
    `No-bid watchdog rate: ${pct(m.noBidWatchRate)}`,
    "",
    "Blockers",
    ...(report.blockers.length ? report.blockers.map((item) => `- ${item}`) : ["- none"]),
    "",
    "Warnings",
    ...(report.warnings.length ? report.warnings.map((item) => `- ${item}`) : ["- none"])
  ];
  return lines.join("\n");
}

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function optionalPct(value: number | undefined): string {
  return value === undefined ? "n/a" : pct(value);
}

function cents(value: number): string {
  return `${(value * 100).toFixed(1)}c`;
}
