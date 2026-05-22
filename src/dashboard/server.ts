import { createServer, type ServerResponse } from "node:http";
import { BotDatabase } from "../db.js";
import { loadRuntimeEnv } from "../config.js";
import { buildDashboardReadModel } from "./readModel.js";

const env = loadRuntimeEnv();
const db = new BotDatabase(env.dbPath);
const port = Number(process.env.DASHBOARD_PORT || 8787);

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (url.pathname === "/api/dashboard") {
    sendJson(response, buildDashboardReadModel(db));
    return;
  }
  if (url.pathname === "/api/health") {
    sendJson(response, { ok: true, mode: "PAPER", generatedAt: Date.now() });
    return;
  }
  if (url.pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(indexHtml());
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

function sendJson(response: ServerResponse, body: unknown): void {
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(body));
}

function indexHtml(): string {
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>StratiFi Dashboard</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #111316;
      --panel: #191d22;
      --panel-2: #20262c;
      --line: #303841;
      --text: #f4f1e8;
      --muted: #a8b0b8;
      --green: #36d399;
      --teal: #34c6d3;
      --amber: #f2b84b;
      --red: #f87171;
      --ink: #0b0d10;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    header {
      min-height: 220px;
      padding: 28px;
      border-bottom: 1px solid var(--line);
      background:
        linear-gradient(120deg, rgba(52, 198, 211, 0.16), transparent 42%),
        linear-gradient(90deg, #111316, #171b20);
    }
    .topbar, main { max-width: 1380px; margin: 0 auto; }
    .topbar { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
    h1 { margin: 0; font-size: 40px; line-height: 1.05; font-weight: 760; }
    .subtitle { margin: 10px 0 0; color: var(--muted); max-width: 760px; line-height: 1.5; }
    .status { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    .pill {
      border: 1px solid var(--line);
      background: rgba(25, 29, 34, 0.84);
      border-radius: 8px;
      padding: 8px 10px;
      color: var(--muted);
      font-size: 13px;
      white-space: nowrap;
    }
    .pill strong { color: var(--text); }
    main { padding: 22px 28px 40px; }
    .metrics {
      display: grid;
      grid-template-columns: repeat(6, minmax(132px, 1fr));
      gap: 12px;
      margin-top: -64px;
      margin-bottom: 18px;
    }
    .metric, .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: 0 16px 30px rgba(0, 0, 0, 0.18);
    }
    .metric { min-height: 102px; padding: 14px; }
    .label { color: var(--muted); font-size: 12px; text-transform: uppercase; }
    .value { margin-top: 8px; font-size: 27px; font-weight: 740; }
    .delta { margin-top: 8px; color: var(--muted); font-size: 13px; }
    .grid { display: grid; grid-template-columns: 1.15fr 0.85fr; gap: 14px; }
    .panel { padding: 16px; min-width: 0; }
    .panel h2 { margin: 0 0 12px; font-size: 16px; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { border-bottom: 1px solid var(--line); padding: 10px 8px; text-align: left; font-size: 13px; vertical-align: middle; }
    th { color: var(--muted); font-weight: 650; }
    td { color: #e9edf0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .good { color: var(--green); }
    .warn { color: var(--amber); }
    .bad { color: var(--red); }
    .tag { display: inline-block; border-radius: 6px; padding: 3px 7px; background: var(--panel-2); color: var(--muted); }
    .bars { display: grid; gap: 10px; }
    .bar-row { display: grid; grid-template-columns: 74px 1fr 84px; gap: 10px; align-items: center; font-size: 13px; }
    .track { height: 10px; border-radius: 6px; background: #2a3037; overflow: hidden; }
    .fill { height: 100%; width: 0; background: var(--teal); }
    .feed { display: grid; gap: 10px; }
    .event { border-left: 3px solid var(--teal); padding: 8px 10px; background: var(--panel-2); border-radius: 6px; }
    .event .meta { color: var(--muted); font-size: 12px; margin-bottom: 3px; }
    .empty { color: var(--muted); padding: 18px 0; }
    @media (max-width: 1120px) {
      .metrics { grid-template-columns: repeat(3, 1fr); margin-top: -44px; }
      .grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 720px) {
      header { padding: 20px; }
      h1 { font-size: 31px; }
      .topbar { display: block; }
      .status { justify-content: flex-start; margin-top: 16px; }
      main { padding: 18px 14px 32px; }
      .metrics { grid-template-columns: repeat(2, 1fr); margin-top: -28px; }
      th:nth-child(4), td:nth-child(4), th:nth-child(5), td:nth-child(5) { display: none; }
    }
  </style>
</head>
<body>
  <header>
    <div class="topbar">
      <div>
        <h1>StratiFi</h1>
        <p class="subtitle">Paper-trading command center for wallet intelligence, shadow-copy evidence, source quality, and agent decisions.</p>
      </div>
      <div class="status">
        <span class="pill">Mode <strong id="mode">PAPER</strong></span>
        <span class="pill">Updated <strong id="updated">loading</strong></span>
      </div>
    </div>
  </header>
  <main>
    <section class="metrics" id="metrics"></section>
    <section class="grid">
      <div class="panel">
        <h2>Source Intelligence</h2>
        <table>
          <thead><tr><th>Rank</th><th>Category</th><th class="num">Strength</th><th class="num">Evidence</th><th class="num">Trades</th><th>Flags</th></tr></thead>
          <tbody id="wallets"></tbody>
        </table>
      </div>
      <div class="panel">
        <h2>Shadow Performance By Category</h2>
        <div class="bars" id="shadowCategories"></div>
      </div>
      <div class="panel">
        <h2>Recent Signals</h2>
        <table>
          <thead><tr><th>Decision</th><th>Outcome</th><th class="num">Conf</th><th class="num">Price</th><th>Reason</th></tr></thead>
          <tbody id="signals"></tbody>
        </table>
      </div>
      <div class="panel">
        <h2>Agent Event Feed</h2>
        <div class="feed" id="events"></div>
      </div>
      <div class="panel">
        <h2>Open Paper Positions</h2>
        <table>
          <thead><tr><th>Outcome</th><th class="num">Size</th><th class="num">Entry</th><th class="num">Mark</th><th class="num">PnL</th></tr></thead>
          <tbody id="positions"></tbody>
        </table>
      </div>
      <div class="panel">
        <h2>Run Logs</h2>
        <div class="feed" id="logs"></div>
      </div>
    </section>
  </main>
  <script>
    const fmtUsd = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
    const fmtPct = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 });
    const fmtNum = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

    async function loadDashboard() {
      const response = await fetch("/api/dashboard", { cache: "no-store" });
      const data = await response.json();
      render(data);
    }

    function render(data) {
      text("mode", data.mode);
      text("updated", new Date(data.generatedAt).toLocaleTimeString());
      renderMetrics(data);
      renderWallets(data.wallets);
      renderShadowCategories(data.shadowCategories);
      renderSignals(data.signals);
      renderPositions(data.positions);
      renderEvents(data.events);
      renderLogs(data.logs);
    }

    function renderMetrics(data) {
      const p = data.performance;
      const s = data.shadow;
      const source = data.sourceSummary;
      const metrics = [
        ["Total PnL", fmtUsd.format(p.totalPnl), p.openPositions + " open / " + p.closedPositions + " closed", p.totalPnl >= 0 ? "good" : "bad"],
        ["Shadow PnL", fmtUsd.format(s.pnl), s.simulated + " simulated", s.pnl >= 0 ? "good" : "bad"],
        ["Win Rate", fmtPct.format(p.winRate || 0), p.wins + " wins / " + p.losses + " losses", "good"],
        ["Signals", fmtNum.format(p.signals), p.approvedSignals + " paper orders", ""],
        ["Sources", fmtNum.format(source.totalSources), source.highReliability + " high reliability", ""],
        ["Shadow Impact", fmtNum.format(source.avgShadowImpact), "avg source adjustment", source.avgShadowImpact >= 0 ? "good" : "bad"]
      ];
      const root = byId("metrics");
      root.replaceChildren(...metrics.map(([label, value, delta, tone]) => {
        const el = node("div", "metric");
        el.append(node("div", "label", label), node("div", "value " + tone, value), node("div", "delta", delta));
        return el;
      }));
    }

    function renderWallets(wallets) {
      const body = byId("wallets");
      if (!wallets.length) return emptyTable(body, 6, "Run npm run scan to populate source intelligence.");
      body.replaceChildren(...wallets.map((wallet) => tr([
        "#" + wallet.rank,
        wallet.category,
        num(wallet.sourceStrength),
        num(Math.round(wallet.sampleConfidence * 100) + "%"),
        num(wallet.tradeCount),
        wallet.flags.slice(0, 2).join(", ") || "clean"
      ])));
    }

    function renderShadowCategories(categories) {
      const root = byId("shadowCategories");
      if (!categories.length) return root.replaceChildren(node("div", "empty", "No shadow category data yet."));
      const max = Math.max(...categories.map((item) => Math.abs(item.pnl)), 1);
      root.replaceChildren(...categories.map((item) => {
        const row = node("div", "bar-row");
        const fill = node("div", "fill");
        fill.style.width = Math.max(4, Math.abs(item.pnl) / max * 100) + "%";
        fill.style.background = item.pnl >= 0 ? "var(--green)" : "var(--red)";
        const track = node("div", "track");
        track.append(fill);
        row.append(node("div", "", item.category), track, node("div", "num " + (item.pnl >= 0 ? "good" : "bad"), fmtUsd.format(item.pnl)));
        row.title = item.simulated + " simulated, " + fmtPct.format(item.winRate) + " win rate, " + fmtPct.format(item.fallbackRate) + " fallback marks";
        return row;
      }));
    }

    function renderSignals(signals) {
      const body = byId("signals");
      if (!signals.length) return emptyTable(body, 5, "No signals stored yet.");
      body.replaceChildren(...signals.map((signal) => tr([
        signal.decision,
        signal.outcome,
        num(signal.confidence),
        num(signal.limitPrice.toFixed(3)),
        signal.reason
      ])));
    }

    function renderPositions(positions) {
      const body = byId("positions");
      if (!positions.length) return emptyTable(body, 5, "No open paper positions.");
      body.replaceChildren(...positions.map((position) => tr([
        position.outcome,
        num(position.size.toFixed(2)),
        num(position.avgEntryPrice.toFixed(3)),
        num(position.currentPrice.toFixed(3)),
        num(fmtUsd.format(position.unrealizedPnl), position.unrealizedPnl >= 0 ? "good" : "bad")
      ])));
    }

    function renderEvents(events) {
      const root = byId("events");
      if (!events.length) return root.replaceChildren(node("div", "empty", "No public agent events yet."));
      root.replaceChildren(...events.slice(0, 8).map((event) => {
        const el = node("div", "event");
        el.append(node("div", "meta", event.agent + " / " + event.type + " / " + new Date(event.createdAt).toLocaleTimeString()), node("div", "", event.message));
        return el;
      }));
    }

    function renderLogs(logs) {
      const root = byId("logs");
      if (!logs.length) return root.replaceChildren(node("div", "empty", "No run logs yet."));
      root.replaceChildren(...logs.map((log) => {
        const el = node("div", "event");
        el.style.borderLeftColor = log.level === "ERROR" ? "var(--red)" : log.level === "WARN" ? "var(--amber)" : "var(--teal)";
        el.append(node("div", "meta", log.level + " / " + new Date(log.createdAt).toLocaleTimeString()), node("div", "", log.message));
        return el;
      }));
    }

    function emptyTable(body, cols, message) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = cols;
      cell.className = "empty";
      cell.textContent = message;
      row.append(cell);
      body.replaceChildren(row);
    }

    function tr(values) {
      const row = document.createElement("tr");
      for (const value of values) {
        if (value && typeof value === "object" && value.kind === "num") {
          const cell = node("td", "num " + (value.tone || ""), value.value);
          row.append(cell);
        } else {
          row.append(node("td", "", String(value)));
        }
      }
      return row;
    }

    function num(value, tone = "") { return { kind: "num", value: String(value), tone }; }
    function text(id, value) { byId(id).textContent = value; }
    function byId(id) { return document.getElementById(id); }
    function node(tag, className = "", value = "") {
      const el = document.createElement(tag);
      if (className) el.className = className;
      el.textContent = value;
      return el;
    }

    loadDashboard().catch(console.error);
    setInterval(() => loadDashboard().catch(console.error), 15000);
  </script>
</body>
</html>`;
}
