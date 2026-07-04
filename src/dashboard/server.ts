import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadBotConfig, loadRuntimeEnv } from "../config.js";
import { BotDatabase } from "../db.js";
import { landingHtml } from "./landingView.js";
import { buildAdminDashboardReadModel, buildDashboardReadModel, buildPublicTrackerReadModel } from "./readModel.js";
import { trackerHtml } from "./trackerView.js";
import { indexHtml } from "./view.js";

const env = loadRuntimeEnv();
const config = loadBotConfig();
const db = new BotDatabase(env.dbPath);
const port = Number(process.env.DASHBOARD_PORT || 8787);
const publicDir = join(process.cwd(), "public");

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const dashboard = (): ReturnType<typeof buildDashboardReadModel> => buildDashboardReadModel(
    db,
    config.bankroll,
    config.minPositionSize,
    config.maxOpenExposure,
    config.reserveCashPct,
    config.maxTimeToResolutionHours
  );
  if (url.pathname === "/api/dashboard") {
    sendJson(response, dashboard());
    return;
  }
  if (url.pathname === "/api/tracker") {
    sendJson(response, buildPublicTrackerReadModel(dashboard(), {
      name: env.publicTrackerName,
      walletAddress: env.publicTrackerWalletAddress,
      disclosure: env.publicTrackerDisclosure
    }));
    return;
  }
  if (url.pathname === "/api/admin/dashboard") {
    if (!canAccessAdmin(request, url)) {
      sendJson(response, { error: "Admin dashboard access denied." }, 401);
      return;
    }
    sendJson(response, buildAdminDashboardReadModel(db));
    return;
  }
  if (url.pathname === "/api/health") {
    sendJson(response, { ok: true, mode: "PAPER", generatedAt: Date.now() });
    return;
  }
  if (url.pathname === "/stratifi-logo.svg" || url.pathname === "/stratifi-mark.svg") {
    sendSvg(response, url.pathname.slice(1));
    return;
  }
  if (url.pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(landingHtml());
    return;
  }
  if (url.pathname === "/dashboard") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(indexHtml());
    return;
  }
  if (url.pathname === "/tracker") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(trackerHtml());
    return;
  }
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not found");
});

server.listen(port, () => {
  console.log(`StratiFi dashboard running at http://localhost:${port}`);
});

process.on("SIGINT", () => {
  db.close();
  server.close(() => process.exit(0));
});

function sendJson(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(body));
}

function sendSvg(response: ServerResponse, filename: string): void {
  try {
    const svg = readFileSync(join(publicDir, filename), "utf8");
    response.writeHead(200, {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=3600"
    });
    response.end(svg);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

function canAccessAdmin(request: IncomingMessage, url: URL): boolean {
  const token = env.adminDashboardToken;
  const providedToken = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? url.searchParams.get("token") ?? undefined;
  if (token) return providedToken === token;
  const host = request.headers.host?.split(":")[0]?.toLowerCase() ?? "localhost";
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}
