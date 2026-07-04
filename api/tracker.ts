import type { IncomingMessage, ServerResponse } from "node:http";

export default async function handler(_request: IncomingMessage, response: ServerResponse): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    sendJson(response, 500, { error: "Supabase dashboard env is not configured." });
    return;
  }

  const result = await fetch(`${supabaseUrl}/rest/v1/dashboard_snapshots?select=payload,created_at&order=created_at.desc&limit=1`, {
    headers: {
      apikey: supabaseAnonKey,
      authorization: `Bearer ${supabaseAnonKey}`
    }
  });

  if (!result.ok) {
    sendJson(response, result.status, { error: "Failed to read tracker snapshot." });
    return;
  }

  const rows = await result.json() as Array<{ payload: Record<string, unknown>; created_at: string }>;
  const dashboard = rows[0]?.payload;
  if (!dashboard) {
    sendJson(response, 404, { error: "No dashboard snapshot has been published yet." });
    return;
  }

  sendJson(response, 200, {
    generatedAt: dashboard.generatedAt,
    name: process.env.PUBLIC_TRACKER_NAME || "StratiFi Paper Tracker",
    walletAddress: process.env.PUBLIC_TRACKER_WALLET_ADDRESS,
    disclosure: process.env.PUBLIC_TRACKER_DISCLOSURE || "Paper trading tracker. No live Polymarket orders are placed by this bot.",
    mode: "PAPER",
    capital: dashboard.capital,
    performance: dashboard.performance,
    tradeLedger: slice(dashboard.tradeLedger, 30),
    positions: slice(dashboard.positions, 20),
    closedPositions: slice(dashboard.closedPositions, 20),
    sourceSummary: dashboard.sourceSummary,
    recentSignals: slice(dashboard.signals, 12)
  });
}

function slice(value: unknown, limit: number): unknown[] {
  return Array.isArray(value) ? value.slice(0, limit) : [];
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(body));
}
