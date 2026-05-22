import { createServer, type ServerResponse } from "node:http";
import { BotDatabase } from "../db.js";
import { loadRuntimeEnv } from "../config.js";
import { buildAdminDashboardReadModel, buildDashboardReadModel } from "./readModel.js";

const env = loadRuntimeEnv();
const db = new BotDatabase(env.dbPath);
const port = Number(process.env.DASHBOARD_PORT || 8787);

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (url.pathname === "/api/dashboard") {
    sendJson(response, buildDashboardReadModel(db));
    return;
  }
  if (url.pathname === "/api/admin/dashboard") {
    sendJson(response, buildAdminDashboardReadModel(db));
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
      --cyan: #20f0de;
      --blue: #168fff;
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
        radial-gradient(circle at 18% 12%, rgba(32, 240, 222, 0.28), transparent 28%),
        radial-gradient(circle at 82% 20%, rgba(22, 143, 255, 0.18), transparent 30%),
        linear-gradient(120deg, rgba(52, 198, 211, 0.16), transparent 42%),
        linear-gradient(90deg, #111316, #171b20);
    }
    .topbar, main { max-width: 1380px; margin: 0 auto; }
    .topbar { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
    .brand {
      display: grid;
      grid-template-columns: 96px minmax(0, 1fr);
      gap: 18px;
      align-items: center;
      max-width: 780px;
    }
    .brand-mark {
      width: 96px;
      aspect-ratio: 1;
      filter: drop-shadow(0 14px 28px rgba(0, 194, 255, 0.18));
    }
    .brand-word {
      font-size: 48px;
      line-height: 1;
      font-weight: 780;
      color: #f8f9fb;
    }
    .brand-word .accent {
      color: #16a4ff;
    }
    .brand-line {
      margin-top: 12px;
      color: #f5f7f9;
      font-size: 13px;
      font-weight: 760;
      text-transform: uppercase;
      letter-spacing: 3px;
    }
    .brand-line .teal { color: #19e5d1; }
    .brand-line .blue { color: #168fff; }
    .subtitle { margin: 16px 0 0; color: var(--muted); max-width: 760px; line-height: 1.5; }
    .nav {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 18px;
    }
    .tab {
      border: 1px solid var(--line);
      background: rgba(25, 29, 34, 0.74);
      color: var(--muted);
      border-radius: 8px;
      padding: 9px 12px;
      font: inherit;
      cursor: pointer;
    }
    .tab.active {
      color: var(--text);
      border-color: rgba(32, 240, 222, 0.58);
      background: linear-gradient(135deg, rgba(32, 240, 222, 0.18), rgba(22, 143, 255, 0.13));
    }
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
    .metric, .panel, .hero-panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: 0 16px 30px rgba(0, 0, 0, 0.18);
    }
    .hero-panel {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 1px;
      overflow: hidden;
      margin-bottom: 14px;
      background: var(--line);
    }
    .agent-lane {
      min-height: 128px;
      padding: 16px;
      background: linear-gradient(180deg, #1b2026, #171b20);
      position: relative;
    }
    .agent-lane::after {
      content: "";
      position: absolute;
      left: 16px;
      right: 16px;
      bottom: 0;
      height: 3px;
      background: linear-gradient(90deg, var(--cyan), var(--blue));
      opacity: 0.8;
    }
    .agent-name { font-size: 15px; font-weight: 760; }
    .agent-role { margin-top: 8px; color: var(--muted); font-size: 13px; line-height: 1.45; }
    .agent-stat { margin-top: 14px; color: var(--text); font-size: 22px; font-weight: 760; }
    .metric { min-height: 102px; padding: 14px; }
    .label { color: var(--muted); font-size: 12px; text-transform: uppercase; }
    .value { margin-top: 8px; font-size: 27px; font-weight: 740; }
    .delta { margin-top: 8px; color: var(--muted); font-size: 13px; }
    .grid { display: grid; grid-template-columns: 1.15fr 0.85fr; gap: 14px; }
    .admin-grid { display: none; grid-template-columns: 1.05fr 0.95fr; gap: 14px; }
    body.admin .public-grid, body.admin .metrics, body.admin .hero-panel { display: none; }
    body.admin .admin-grid { display: grid; }
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
    .spark {
      width: 100%;
      height: 180px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #11161b;
    }
    .address {
      color: var(--cyan);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
    }
    .wide { grid-column: 1 / -1; }
    .empty { color: var(--muted); padding: 18px 0; }
    @media (max-width: 1120px) {
      .metrics { grid-template-columns: repeat(3, 1fr); margin-top: -44px; }
      .grid, .admin-grid, .hero-panel { grid-template-columns: 1fr; }
    }
    @media (max-width: 720px) {
      header { padding: 20px; }
      .brand { grid-template-columns: 72px minmax(0, 1fr); gap: 12px; }
      .brand-mark { width: 72px; }
      .brand-word { font-size: 34px; }
      .brand-line { font-size: 10px; letter-spacing: 1.7px; }
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
        <div class="brand" aria-label="StratiFi">
          <svg class="brand-mark" viewBox="0 0 120 120" role="img" aria-label="StratiFi mark">
            <defs>
              <linearGradient id="stratifiMark" x1="24" y1="10" x2="92" y2="110" gradientUnits="userSpaceOnUse">
                <stop offset="0" stop-color="#2ffff0"/>
                <stop offset="0.48" stop-color="#02c6df"/>
                <stop offset="1" stop-color="#075bff"/>
              </linearGradient>
              <filter id="markGlow" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="2.5" result="blur"/>
                <feColorMatrix in="blur" type="matrix" values="0 0 0 0 0.08 0 0 0 0 0.95 0 0 0 0 1 0 0 0 0.5 0"/>
                <feMerge>
                  <feMergeNode/>
                  <feMergeNode in="SourceGraphic"/>
                </feMerge>
              </filter>
            </defs>
            <path filter="url(#markGlow)" d="M87 9 34 34C19 41 13 58 23 72c4 6 10 10 17 13l25 11-38 17c-3 1-5-1-4-4l7-35 41-18-37-16 60-29c4-2 7 1 6 5l-8 29c-1 5-4 8-9 10L55 69l28 13c14 7 17 24 4 35H61c9-6 8-14-1-18L25 83C3 73-1 43 22 30L84 1c4-2 7 3 3 8Z" fill="url(#stratifiMark)"/>
            <path d="M23 83c9 5 22 11 39 17 6 2 8 7 4 12h18c8-9 5-22-6-27L47 70 25 80c-2 1-3 2-2 3Z" fill="#0455df" opacity="0.55"/>
            <path d="M91 14 35 40c-12 6-17 19-9 29" fill="none" stroke="#9ffff5" stroke-width="3" stroke-linecap="round" opacity="0.65"/>
          </svg>
          <div>
            <div class="brand-word">Strati<span class="accent">Fi</span></div>
            <div class="brand-line"><span class="teal">AI-Assisted</span> &bull; Prediction Markets &bull; <span class="blue">Intelligence</span></div>
          </div>
        </div>
        <p class="subtitle">Paper-trading command center for wallet intelligence, shadow-copy evidence, source quality, and agent decisions.</p>
        <nav class="nav" aria-label="Dashboard sections">
          <button class="tab active" data-view="public">Overview</button>
          <button class="tab" data-view="admin">Admin Intelligence</button>
        </nav>
      </div>
      <div class="status">
        <span class="pill">Mode <strong id="mode">PAPER</strong></span>
        <span class="pill">Updated <strong id="updated">loading</strong></span>
      </div>
    </div>
  </header>
  <main>
    <section class="hero-panel" id="agentLanes"></section>
    <section class="metrics" id="metrics"></section>
    <section class="grid public-grid">
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
    <section class="admin-grid">
      <div class="panel wide">
        <h2>Agent Handoff Trace</h2>
        <div class="feed" id="handoffTrace"></div>
      </div>
      <div class="panel">
        <h2>Admin Source Wallets</h2>
        <table>
          <thead><tr><th>Wallet</th><th>Category</th><th class="num">Score</th><th class="num">Trades</th><th>Flags</th></tr></thead>
          <tbody id="adminWallets"></tbody>
        </table>
      </div>
      <div class="panel">
        <h2>Source Score Drift</h2>
        <canvas class="spark" id="scoreDrift" width="740" height="260"></canvas>
      </div>
      <div class="panel">
        <h2>Wallet Score Table</h2>
        <table>
          <thead><tr><th>Wallet</th><th class="num">Score</th><th>Rel</th><th class="num">Shadow</th><th>Category</th></tr></thead>
          <tbody id="walletScores"></tbody>
        </table>
      </div>
      <div class="panel">
        <h2>Risk Decisions</h2>
        <div class="feed" id="riskSummary"></div>
      </div>
    </section>
  </main>
  <script>
    const fmtUsd = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
    const fmtPct = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 });
    const fmtNum = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

    async function loadDashboard() {
      const [publicResponse, adminResponse] = await Promise.all([
        fetch("/api/dashboard", { cache: "no-store" }),
        fetch("/api/admin/dashboard", { cache: "no-store" })
      ]);
      const data = await publicResponse.json();
      const admin = await adminResponse.json();
      render(data, admin);
    }

    function render(data, admin) {
      text("mode", data.mode);
      text("updated", new Date(data.generatedAt).toLocaleTimeString());
      renderAgentLanes(data, admin);
      renderMetrics(data);
      renderWallets(data.wallets);
      renderShadowCategories(data.shadowCategories);
      renderSignals(data.signals);
      renderPositions(data.positions);
      renderEvents(data.events);
      renderLogs(data.logs);
      renderAdmin(admin);
    }

    document.querySelectorAll(".tab").forEach((button) => {
      button.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
        document.body.classList.toggle("admin", button.dataset.view === "admin");
      });
    });

    function renderAgentLanes(data, admin) {
      const lanes = [
        ["Signal Agent", "Discovers markets, scores source wallets, and creates trade candidates.", data.signals.length + " recent signals"],
        ["Risk Mitigation Agent", "Approves, rejects, or resizes candidates using profile-aware risk gates.", admin.risk.length + " risk reason groups"],
        ["Overseer Agent", "Monitors paper positions, exits, PnL, and operating state.", data.positions.length + " open positions"]
      ];
      byId("agentLanes").replaceChildren(...lanes.map(([name, role, stat]) => {
        const el = node("div", "agent-lane");
        el.append(node("div", "agent-name", name), node("div", "agent-role", role), node("div", "agent-stat", stat));
        return el;
      }));
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

    function renderAdmin(admin) {
      renderAdminWallets(admin.wallets);
      renderWalletScores(admin.walletScores);
      renderRiskSummary(admin.risk);
      renderHandoffTrace(admin.handoffTrace);
      renderScoreDrift(admin.scoreHistory);
    }

    function renderAdminWallets(wallets) {
      const body = byId("adminWallets");
      if (!wallets.length) return emptyTable(body, 5, "No admin wallet data yet.");
      body.replaceChildren(...wallets.slice(0, 12).map((wallet) => tr([
        address(wallet.address),
        wallet.category,
        num(wallet.score),
        num(wallet.tradeCount),
        wallet.flags.slice(0, 2).join(", ") || "clean"
      ])));
    }

    function renderWalletScores(scores) {
      const body = byId("walletScores");
      if (!scores.length) return emptyTable(body, 5, "No wallet scores yet.");
      body.replaceChildren(...scores.slice(0, 12).map((score) => tr([
        address(score.wallet),
        num(score.score),
        score.reliability,
        num(score.shadowScoreImpact ?? 0, (score.shadowScoreImpact ?? 0) >= 0 ? "good" : "bad"),
        score.category || "other"
      ])));
    }

    function renderRiskSummary(risk) {
      const root = byId("riskSummary");
      if (!risk.length) return root.replaceChildren(node("div", "empty", "No risk decisions stored yet."));
      root.replaceChildren(...risk.slice(0, 8).map((item) => {
        const el = node("div", "event");
        el.style.borderLeftColor = item.decision === "APPROVE" ? "var(--green)" : item.decision === "REDUCE_SIZE" ? "var(--amber)" : "var(--red)";
        el.append(node("div", "meta", item.decision + " / " + item.count + "x / " + new Date(item.latestAt).toLocaleString()), node("div", "", item.reason));
        return el;
      }));
    }

    function renderHandoffTrace(events) {
      const root = byId("handoffTrace");
      if (!events.length) return root.replaceChildren(node("div", "empty", "No agent handoff events yet."));
      root.replaceChildren(...events.slice(0, 16).map((event) => {
        const el = node("div", "event");
        const color = event.agent === "Signal Agent" ? "var(--cyan)" : event.agent === "Risk Mitigation Agent" ? "var(--amber)" : "var(--blue)";
        el.style.borderLeftColor = color;
        el.append(node("div", "meta", event.agent + " / " + event.type + " / " + event.visibility + " / " + new Date(event.createdAt).toLocaleString()), node("div", "", event.message));
        return el;
      }));
    }

    function renderScoreDrift(history) {
      const canvas = byId("scoreDrift");
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#11161b";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const points = [...history].reverse().slice(-60);
      drawGrid(ctx, canvas);
      if (!points.length) {
        ctx.fillStyle = "#a8b0b8";
        ctx.fillText("No score history yet.", 24, 36);
        return;
      }
      drawLine(ctx, canvas, points.map((point) => point.score), "#20f0de");
      drawLine(ctx, canvas, points.map((point) => point.copyabilityScore ?? point.score), "#168fff");
      ctx.fillStyle = "#f4f1e8";
      ctx.fillText("Score", 22, 24);
      ctx.fillStyle = "#168fff";
      ctx.fillText("Copyability", 82, 24);
    }

    function drawGrid(ctx, canvas) {
      ctx.strokeStyle = "#26313a";
      ctx.lineWidth = 1;
      for (let y = 40; y < canvas.height; y += 44) {
        ctx.beginPath();
        ctx.moveTo(20, y);
        ctx.lineTo(canvas.width - 20, y);
        ctx.stroke();
      }
    }

    function drawLine(ctx, canvas, values, color) {
      const min = 0;
      const max = 100;
      const pad = 22;
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      values.forEach((value, index) => {
        const x = pad + (values.length === 1 ? 0 : index / (values.length - 1) * (canvas.width - pad * 2));
        const y = canvas.height - pad - ((value - min) / (max - min)) * (canvas.height - pad * 2);
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
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
        } else if (value && typeof value === "object" && value.kind === "address") {
          const cell = node("td", "address", value.value);
          row.append(cell);
        } else {
          row.append(node("td", "", String(value)));
        }
      }
      return row;
    }

    function num(value, tone = "") { return { kind: "num", value: String(value), tone }; }
    function address(value) { return { kind: "address", value: String(value) }; }
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
