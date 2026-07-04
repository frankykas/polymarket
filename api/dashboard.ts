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
    sendJson(response, result.status, { error: "Failed to read dashboard snapshot." });
    return;
  }

  const rows = await result.json() as Array<{ payload: unknown; created_at: string }>;
  if (!rows[0]) {
    sendJson(response, 404, { error: "No dashboard snapshot has been published yet." });
    return;
  }
  sendJson(response, 200, rows[0].payload);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(body));
}
