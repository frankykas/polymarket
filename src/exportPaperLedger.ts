import { loadBotConfig, loadRuntimeEnv } from "./config.js";
import { BotDatabase } from "./db.js";
import { exportPaperTradeLedgerFile } from "./paperTradeLedgerFile.js";

const env = loadRuntimeEnv();
const config = loadBotConfig();
const db = new BotDatabase(env.dbPath);

try {
  const result = exportPaperTradeLedgerFile(db, config.bankroll);
  console.log(`Exported ${result.rows} paper trade ledger row(s) to ${result.path}.`);
} finally {
  db.close();
}
