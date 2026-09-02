import { resolve } from "node:path";
import { loadBotConfig, loadRuntimeEnv } from "../config.js";
import { BotDatabase } from "../db.js";
import { fetchClevelandFedNowcast } from "./macroNowcast.js";

const config = loadBotConfig();
const env = loadRuntimeEnv();
if (config.macroCpiNowcastEnabled === false) {
  console.log("CPI nowcast collection is disabled.");
  process.exit(0);
}

const fetchedAt = Date.now();
const vintages = await fetchClevelandFedNowcast(config.macroCpiNowcastUrl, fetchedAt);
const db = new BotDatabase(resolve(env.dbPath), config.performanceStartAt);
try {
  let inserted = 0;
  for (const vintage of vintages) inserted += db.saveMacroForecastVintage(vintage) ? 1 : 0;
  console.log(`Cleveland Fed CPI nowcast: observed ${vintages.length} current period(s), inserted ${inserted} new immutable vintage(s).`);
  for (const vintage of vintages) {
    console.log(`${vintage.referencePeriod}: headline MoM=${vintage.headlineMom ?? "n/a"}, core MoM=${vintage.coreMom ?? "n/a"}, headline YoY=${vintage.headlineYoy ?? "n/a"}, core YoY=${vintage.coreYoy ?? "n/a"}; source updated ${new Date(vintage.sourceUpdatedAt).toISOString()}.`);
  }
} finally {
  db.close();
}
