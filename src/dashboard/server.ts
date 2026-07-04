import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadBotConfig, loadRuntimeEnv } from "../config.js";
import { BotDatabase } from "../db.js";
import { adminControlHtml } from "./adminControlView.js";
import { landingHtml } from "./landingView.js";
import { buildAdminDashboardReadModel, buildDashboardReadModel, buildPublicTrackerReadModel } from "./readModel.js";
import { trackerHtml } from "./trackerView.js";
import { indexHtml } from "./view.js";

const execFileAsync = promisify(execFile);
const env = loadRuntimeEnv();
const config = loadBotConfig();
const db = new BotDatabase(env.dbPath);
const port = Number(process.env.DASHBOARD_PORT || 8787);
const publicDir = join(process.cwd(), "public");

const server = createServer((request, response) => {
  void handleRequest(request, response).catch((error: unknown) => {
    console.error(error);
    sendJson(response, { error: error instanceof Error ? error.message : "Internal server error." }, 500);
  });
});

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
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
  if (url.pathname === "/api/admin/control/status") {
    if (!canAccessAdmin(request, url)) {
      sendJson(response, { error: "Admin control access denied." }, 401);
      return;
    }
    sendJson(response, await getServiceStatus());
    return;
  }
  if (url.pathname === "/api/admin/control/logs") {
    if (!canAccessAdmin(request, url)) {
      sendJson(response, { error: "Admin control access denied." }, 401);
      return;
    }
    sendJson(response, await getServiceLogs(url.searchParams.get("service")));
    return;
  }
  if (url.pathname === "/api/admin/control/action") {
    if (!canAccessAdmin(request, url)) {
      sendJson(response, { error: "Admin control access denied." }, 401);
      return;
    }
    if (request.method !== "POST") {
      sendJson(response, { error: "Method not allowed." }, 405);
      return;
    }
    const body = await readJsonBody<{ action?: string }>(request);
    sendJson(response, await runAdminAction(body.action));
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
  if (url.pathname === "/admin") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(adminControlHtml());
    return;
  }
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not found");
}

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

async function getServiceStatus(): Promise<{ bot: string; dashboard: string; generatedAt: number }> {
  const [bot, dashboard] = await Promise.all([
    serviceState("pmarke-bot"),
    serviceState("pmarke-dashboard")
  ]);
  return { bot, dashboard, generatedAt: Date.now() };
}

async function serviceState(service: string): Promise<string> {
  const result = await runCommand("systemctl", ["is-active", service], { timeoutMs: 10000, allowFailure: true });
  return result.stdout.trim() || result.stderr.trim() || "unknown";
}

async function getServiceLogs(service: string | null): Promise<{ service: string; output: string }> {
  const unit = service === "dashboard" ? "pmarke-dashboard" : "pmarke-bot";
  const result = await runCommand("journalctl", ["-u", unit, "-n", "160", "--no-pager"], { timeoutMs: 10000, allowFailure: true });
  return { service: unit, output: commandOutput(result) };
}

async function runAdminAction(action: string | undefined): Promise<{ action: string; output: string }> {
  if (!action) throw new Error("Missing admin action.");
  if (action === "start-bot") return runSystemctlAction(action, ["start", "pmarke-bot"]);
  if (action === "stop-bot") return runSystemctlAction(action, ["stop", "pmarke-bot"]);
  if (action === "restart-bot") return runSystemctlAction(action, ["restart", "pmarke-bot"]);
  if (action === "restart-dashboard") return runSystemctlAction(action, ["restart", "pmarke-dashboard"]);
  if (action === "performance") {
    const result = await runCommand("npm", ["run", "performance"], { timeoutMs: 120000, allowFailure: true });
    return { action, output: commandOutput(result) };
  }
  if (action === "scan") return runSafeScan();
  throw new Error(`Unsupported admin action: ${action}`);
}

async function runSystemctlAction(action: string, args: string[]): Promise<{ action: string; output: string }> {
  const result = await runCommand("systemctl", args, { timeoutMs: 30000, allowFailure: true });
  return { action, output: commandOutput(result) || `${action} finished.` };
}

async function runSafeScan(): Promise<{ action: string; output: string }> {
  const output: string[] = [];
  output.push("$ systemctl stop pmarke-bot");
  output.push(commandOutput(await runCommand("systemctl", ["stop", "pmarke-bot"], { timeoutMs: 30000, allowFailure: true })));
  try {
    output.push("$ npm run scan");
    output.push(commandOutput(await runCommand("npm", ["run", "scan"], { timeoutMs: 180000, allowFailure: true })));
  } finally {
    output.push("$ systemctl start pmarke-bot");
    output.push(commandOutput(await runCommand("systemctl", ["start", "pmarke-bot"], { timeoutMs: 30000, allowFailure: true })));
  }
  return { action: "scan", output: output.filter(Boolean).join("\n\n") };
}

async function runCommand(
  command: string,
  args: string[],
  options: { timeoutMs: number; allowFailure?: boolean }
): Promise<{ stdout: string; stderr: string; code?: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: process.cwd(),
      timeout: options.timeoutMs,
      maxBuffer: 1024 * 1024
    });
    return { stdout, stderr };
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string; code?: number; message?: string };
    if (!options.allowFailure) throw error;
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? result.message ?? "Command failed.",
      code: result.code
    };
  }
}

function commandOutput(result: { stdout: string; stderr: string; code?: number }): string {
  const sections = [];
  if (result.stdout.trim()) sections.push(result.stdout.trim());
  if (result.stderr.trim()) sections.push(result.stderr.trim());
  if (result.code !== undefined && result.code !== 0) sections.push(`exit code: ${result.code}`);
  return sections.join("\n");
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}
