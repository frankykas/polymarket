import { loadBotConfig, loadRuntimeEnv } from "../config.js";
import { BotDatabase } from "../db.js";
import { buildDashboardReadModel } from "./readModel.js";

const env = loadRuntimeEnv();
const config = loadBotConfig();

if (!env.supabaseUrl || !env.supabaseServiceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required to publish dashboard snapshots.");
}

const db = new BotDatabase(env.dbPath, config.performanceStartAt);

try {
  const payload = buildDashboardReadModel(
    db,
    config.bankroll,
    config.minPositionSize,
    config.maxOpenExposure,
    config.reserveCashPct,
    config.maxTimeToResolutionHours
  );
  const response = await fetch(`${env.supabaseUrl}/rest/v1/dashboard_snapshots`, {
    method: "POST",
    headers: {
      apikey: env.supabaseServiceRoleKey,
      authorization: `Bearer ${env.supabaseServiceRoleKey}`,
      "content-type": "application/json",
      prefer: "return=representation"
    },
    body: JSON.stringify({ payload })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Supabase publish failed: HTTP ${response.status} ${body}`);
  }

  const result = await response.json() as Array<{ id?: number; created_at?: string }>;
  const row = result[0];
  console.log(`Published dashboard snapshot${row?.id ? ` #${row.id}` : ""}${row?.created_at ? ` at ${row.created_at}` : ""}.`);
} finally {
  db.close();
}
