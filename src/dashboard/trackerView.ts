export function trackerHtml(): string {
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>StratiFi Public Tracker</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #07111f;
      --panel: #0d1828;
      --panel-2: #10243d;
      --ink: #eff7ff;
      --muted: #98abc2;
      --line: #23405d;
      --green: #29d391;
      --red: #ff6b7a;
      --amber: #f4b84f;
      --blue: #39a8ff;
      --teal: #20d4c4;
      --purple: #a78bfa;
      --panel-soft: rgba(7, 17, 31, .58);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background:
        linear-gradient(rgba(7, 17, 31, 0.78), rgba(7, 17, 31, 0.96)),
        url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1400' height='900' viewBox='0 0 1400 900'%3E%3Crect width='1400' height='900' fill='%2307111f'/%3E%3Cg opacity='.34'%3E%3Cpath d='M0 650 C180 570 270 710 430 610 S720 430 900 520 1180 620 1400 460' fill='none' stroke='%2339a8ff' stroke-width='5'/%3E%3Cpath d='M0 720 C220 620 340 760 520 670 S810 500 990 590 1230 660 1400 530' fill='none' stroke='%2320d4c4' stroke-width='4'/%3E%3Cpath d='M0 420 C220 360 360 500 540 410 S820 230 1030 320 1220 410 1400 280' fill='none' stroke='%2329d391' stroke-width='3'/%3E%3C/g%3E%3Cg opacity='.22' fill='%23ffffff'%3E%3Ccircle cx='180' cy='650' r='8'/%3E%3Ccircle cx='430' cy='610' r='8'/%3E%3Ccircle cx='720' cy='430' r='8'/%3E%3Ccircle cx='990' cy='590' r='8'/%3E%3Ccircle cx='1220' cy='410' r='8'/%3E%3C/g%3E%3C/svg%3E") center/cover fixed;
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    .shell { min-height: 100vh; }
    header {
      min-height: 72vh;
      display: grid;
      align-content: end;
      padding: 28px;
      border-bottom: 1px solid var(--line);
    }
    .nav { position: absolute; top: 24px; left: 28px; right: 28px; display: flex; justify-content: space-between; align-items: center; gap: 16px; }
    .brand { display: flex; align-items: center; gap: 12px; font-weight: 900; }
    .mark { width: 42px; height: 42px; border-radius: 8px; display: block; filter: drop-shadow(0 10px 22px rgba(0, 220, 255, 0.18)); }
    .pill { border: 1px solid var(--line); background: rgba(13, 24, 40, 0.76); border-radius: 8px; padding: 10px 12px; color: var(--ink); font-size: 13px; font-weight: 800; }
    .hero { max-width: 1180px; width: 100%; margin: 0 auto; display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 28px; align-items: end; }
    h1 { margin: 0; font-size: clamp(42px, 8vw, 92px); line-height: 0.92; max-width: 850px; }
    .subtitle { margin: 18px 0 0; max-width: 720px; color: #c5d7ea; font-size: 18px; line-height: 1.5; }
    .wallet-box { border: 1px solid rgba(255,255,255,.18); background: rgba(8, 19, 33, .82); border-radius: 8px; padding: 18px; }
    .wallet-box span, .metric span, th { color: var(--muted); font-size: 12px; text-transform: uppercase; font-weight: 800; }
    .wallet { margin-top: 10px; overflow-wrap: anywhere; font-family: Consolas, monospace; font-size: 15px; color: #dff7ff; }
    main { padding: 24px 28px 42px; max-width: 1260px; margin: 0 auto; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 18px; }
    .metric, .panel { border: 1px solid var(--line); background: rgba(13, 24, 40, .94); border-radius: 8px; }
    .metric { padding: 16px; min-width: 0; }
    .metric strong { display: block; margin-top: 8px; font-size: clamp(22px, 3vw, 34px); overflow-wrap: anywhere; }
    .metric small { display: block; margin-top: 6px; color: var(--muted); line-height: 1.35; }
    .now-strip {
      display: grid;
      grid-template-columns: minmax(0, 1.1fr) repeat(3, minmax(150px, .55fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    .now-card {
      min-width: 0;
      padding: 16px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(13, 24, 40, .94);
    }
    .now-card span { color: var(--muted); font-size: 12px; text-transform: uppercase; font-weight: 800; }
    .now-card strong { display: block; margin-top: 8px; font-size: clamp(24px, 3vw, 42px); line-height: 1.05; }
    .now-card small { display: block; margin-top: 8px; color: var(--muted); line-height: 1.35; }
    .two { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(360px, .75fr); gap: 18px; align-items: start; }
    .panel { padding: 18px; margin-bottom: 18px; }
    .panel-head { display: flex; justify-content: space-between; gap: 14px; align-items: start; margin-bottom: 12px; }
    .closed-summary {
      display: grid;
      grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
      gap: 12px;
      margin-bottom: 14px;
    }
    .pnl-card, .stat-stack {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(7, 17, 31, .58);
      min-width: 0;
    }
    .pnl-card { padding: 16px; }
    .pnl-card span, .stat-row span { color: var(--muted); font-size: 12px; text-transform: uppercase; font-weight: 800; }
    .pnl-card strong {
      display: block;
      margin-top: 8px;
      font-size: 30px;
      line-height: 1.05;
      white-space: nowrap;
    }
    .pnl-card small { display: block; margin-top: 8px; color: var(--muted); }
    .stat-stack { display: grid; }
    .stat-row {
      min-width: 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 11px 12px;
      border-bottom: 1px solid var(--line);
    }
    .stat-row:last-child { border-bottom: 0; }
    .stat-row strong { font-size: 15px; white-space: nowrap; }
    .position-cards { display: grid; gap: 10px; }
    .position-card {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 132px;
      gap: 12px;
      padding: 14px;
      border: 1px solid rgba(35, 64, 93, .8);
      border-radius: 8px;
      background: rgba(7, 17, 31, .64);
    }
    .position-title { font-weight: 900; font-size: 17px; line-height: 1.25; }
    .position-meta { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 8px; color: var(--muted); font-size: 12px; }
    .position-money { display: grid; gap: 8px; text-align: right; align-content: center; }
    .position-money strong { font-size: 20px; }
    .agent-grid { display: grid; gap: 10px; }
    .agent-card {
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel-soft);
    }
    .agent-top { display: flex; justify-content: space-between; gap: 10px; align-items: center; margin-bottom: 7px; }
    .agent-name { font-weight: 900; }
    .state { font-size: 11px; font-weight: 900; color: var(--muted); text-transform: uppercase; }
    .state.ACTIVE { color: var(--green); }
    .state.QUIET { color: var(--amber); }
    .agent-message { color: #c6d7e8; font-size: 13px; line-height: 1.45; }
    .activity-feed { display: grid; gap: 8px; max-height: 440px; overflow: auto; padding-right: 2px; }
    .activity-item {
      border-left: 3px solid var(--blue);
      background: var(--panel-soft);
      border-radius: 8px;
      padding: 10px 11px;
    }
    .activity-item.LOG { border-left-color: var(--purple); }
    .activity-line { margin-top: 5px; color: #d8e8f8; font-size: 13px; line-height: 1.4; }
    h2 { margin: 0 0 4px; font-size: 21px; }
    p { margin: 0; color: var(--muted); }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; min-width: 760px; }
    th, td { padding: 12px 10px; border-bottom: 1px solid var(--line); text-align: left; white-space: nowrap; font-size: 13px; }
    tbody tr:hover { background: rgba(57, 168, 255, .08); }
    .positive { color: var(--green); font-weight: 900; }
    .negative { color: var(--red); font-weight: 900; }
    .badge { display: inline-flex; height: 24px; align-items: center; border-radius: 999px; padding: 0 8px; font-size: 12px; font-weight: 900; background: rgba(57,168,255,.13); color: var(--blue); border: 1px solid rgba(57,168,255,.34); }
    .trade-feed { display: grid; gap: 10px; }
    .trade-item { border-left: 4px solid var(--blue); background: rgba(7, 17, 31, .72); border-radius: 8px; padding: 12px; }
    .trade-item.exit { border-color: var(--green); }
    .trade-top { display: flex; justify-content: space-between; gap: 10px; color: var(--muted); font-size: 12px; }
    .trade-title { margin-top: 7px; font-weight: 900; }
    .trade-note { margin-top: 5px; color: var(--muted); font-size: 13px; line-height: 1.4; }
    .empty { color: var(--muted); padding: 14px 0; }
    footer { max-width: 1220px; margin: 0 auto; padding: 0 28px 28px; color: var(--muted); font-size: 13px; }
    @media (max-width: 980px) {
      header { min-height: 66vh; }
      .hero, .two, .grid, .now-strip, .closed-summary, .position-card { grid-template-columns: 1fr; }
      .position-money { text-align: left; grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .nav { position: static; margin-bottom: 80px; }
    }
    @media (max-width: 620px) {
      header, main, footer { padding-left: 16px; padding-right: 16px; }
      .nav { flex-direction: column; align-items: flex-start; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <div class="nav">
        <div class="brand"><img class="mark" src="/stratifi-mark.svg" alt="" aria-hidden="true"><span id="brandName">StratiFi</span></div>
        <div class="pill" id="freshness">Loading</div>
      </div>
      <div class="hero">
        <div>
          <h1 id="title">Public trading tracker</h1>
          <p class="subtitle" id="subtitle">Follow the bot's paper balance, open positions, and recent trade decisions as they update.</p>
        </div>
        <div class="wallet-box">
          <span>Public wallet</span>
          <div class="wallet" id="walletAddress">Not configured</div>
        </div>
      </div>
    </header>
    <main>
      <section class="now-strip" id="nowStrip"></section>
      <section class="grid" id="metrics"></section>
      <section class="two">
        <div>
          <section class="panel">
            <div class="panel-head"><div><h2>Live Trade Feed</h2><p>Running paper entries and exits with balance trail.</p></div><span class="badge">Paper</span></div>
            <div class="trade-feed" id="tradeFeed"></div>
          </section>
          <section class="panel">
            <div class="panel-head"><div><h2>Open Positions</h2><p>Markets currently open, paper cost, current value, and live unrealised PNL.</p></div></div>
            <div class="position-cards" id="openCards"></div>
            <div class="table-wrap"><table><thead><tr><th>Market</th><th>Outcome</th><th>Profile</th><th>Cost</th><th>Value</th><th>uPNL</th></tr></thead><tbody id="positions"></tbody></table></div>
          </section>
        </div>
        <div>
          <section class="panel">
            <div class="panel-head"><div><h2>Agent Telemetry</h2><p>Latest public handoffs from the three-agent loop.</p></div><span class="badge">Live</span></div>
            <div class="agent-grid" id="agents"></div>
          </section>
          <section class="panel">
            <div class="panel-head"><div><h2>Live Bot Log</h2><p>Recent scan, risk, and position-management activity.</p></div></div>
            <div class="activity-feed" id="activity"></div>
          </section>
          <section class="panel">
            <div class="panel-head"><div><h2>Recent Signals</h2><p>Source-aligned candidates sent through risk.</p></div></div>
            <div class="table-wrap"><table><thead><tr><th>Market</th><th>Outcome</th><th>Confidence</th><th>State</th></tr></thead><tbody id="signals"></tbody></table></div>
          </section>
          <section class="panel">
            <div class="panel-head"><div><h2>Closed Trades</h2><p>Realised paper outcomes with entry cost, exit value, and net PNL.</p></div></div>
            <section class="closed-summary" id="closedMetrics"></section>
            <div class="table-wrap"><table><thead><tr><th>Market</th><th>Category</th><th>Outcome</th><th>Sources</th><th>Confidence</th><th>Entry</th><th>Exit</th><th>PNL</th><th>ROI</th></tr></thead><tbody id="closed"></tbody></table></div>
          </section>
        </div>
      </section>
    </main>
    <footer id="disclosure">Paper trading tracker. No live Polymarket orders are placed by this bot.</footer>
  </div>
  <script>
    const fmtUsd = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", maximumFractionDigits: 2 });
    const fmtPct = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 });
    const fmtNum = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
    let lastGeneratedAt = Date.now();

    async function loadTracker() {
      const response = await fetch("/api/tracker", { cache: "no-store" });
      render(await response.json());
    }

    function render(data) {
      lastGeneratedAt = data.generatedAt;
      document.title = data.name;
      document.getElementById("brandName").textContent = data.name;
      document.getElementById("title").textContent = data.name;
      document.getElementById("subtitle").textContent = "Follow the bot's paper balance, open positions, and recent trade decisions as they update.";
      document.getElementById("walletAddress").textContent = data.walletAddress || "Set PUBLIC_TRACKER_WALLET_ADDRESS in .env";
      document.getElementById("disclosure").textContent = data.disclosure;
      renderMetrics(data);
      renderNow(data);
      renderTrades(data.tradeLedger || []);
      renderPositions(data.positions || []);
      renderOpenCards(data.positions || []);
      renderSignals(data.recentSignals || []);
      renderClosed(data.closedPositions || []);
      renderClosedMetrics(data.closedPositions || [], data.performance || {});
      renderAgents(data.agents || []);
      renderActivity(data.activity || []);
      tick();
    }

    function renderNow(data) {
      const ops = data.operations || {};
      cards("nowStrip", [
        ["Open Trades", String(ops.openPositionCount || 0), (ops.openPositionCount || 0) ? "Currently deployed in live paper markets" : "No active paper exposure"],
        ["Money In", fmtUsd.format(ops.openExposure || 0), "paper cost basis"],
        ["Current Value", fmtUsd.format(ops.openValue || 0), "marked from latest prices"],
        ["Sitting PNL", money(ops.unrealizedPnl || 0), tonePct(ops.avgOpenRoi || 0) + " open ROI"]
      ], "now-card");
    }

    function renderMetrics(data) {
      const bankroll = data.capital.startingBankroll || 0;
      const totalPnl = data.performance.totalPnl || 0;
      const roi = bankroll > 0 ? totalPnl / bankroll : 0;
      cards("metrics", [
        ["Equity", fmtUsd.format(data.capital.equity || 0), tonePct(roi) + " net paper ROI"],
        ["Total PNL", fmtUsd.format(totalPnl), fmtUsd.format(data.performance.realizedPnl || 0) + " realised"],
        ["Available Cash", fmtUsd.format(data.capital.availableCash || 0), fmtUsd.format(data.capital.deployedCost || 0) + " deployed"],
        ["Win Rate", fmtPct.format(data.performance.winRate || 0), (data.performance.wins || 0) + " wins / " + (data.performance.losses || 0) + " losses"]
      ]);
    }

    function renderTrades(items) {
      const feed = document.getElementById("tradeFeed");
      if (!items.length) return empty(feed, "No paper trades yet.");
      feed.replaceChildren(...items.slice(0, 12).map((item) => {
        const node = el("article", "trade-item " + (item.type === "EXIT" ? "exit" : "entry"));
        node.append(
          meta(new Date(item.createdAt).toLocaleTimeString(), item.type),
          el("div", "trade-title", item.outcome + " / " + short(item.marketId)),
          el("div", "trade-note", "Notional " + fmtUsd.format(item.notional) + " at " + fmtNum.format(item.price) + " | Total PNL " + fmtUsd.format(item.totalPnl) + " | Equity " + fmtUsd.format(item.equity))
        );
        return node;
      }));
    }

    function renderPositions(items) {
      rows("positions", items.map((item) => [
        short(item.market),
        item.outcome,
        item.profile || "Shared",
        fmtUsd.format(item.entryCost),
        fmtUsd.format(item.currentValue),
        money(item.unrealizedPnl)
      ]), "No open paper positions.");
    }

    function renderOpenCards(items) {
      const root = document.getElementById("openCards");
      if (!items.length) return empty(root, "No open paper trades right now.");
      root.replaceChildren(...items.slice(0, 8).map((item) => {
        const card = el("article", "position-card");
        const left = el("div");
        left.append(
          el("div", "position-title", short(item.market, 92)),
          metaLine([item.outcome, item.profile || "Shared", "opened " + age(item.openedAt)])
        );
        const right = el("div", "position-money");
        right.append(
          miniMoney("Invested", fmtUsd.format(item.entryCost || 0)),
          miniMoney("uPNL", money(item.unrealizedPnl || 0), item.unrealizedPnl)
        );
        card.append(left, right);
        return card;
      }));
    }

    function renderSignals(items) {
      rows("signals", items.map((item) => [
        short(item.market),
        item.outcome,
        String(item.confidence),
        item.decision
      ]), "No recent signals.");
    }

    function renderClosed(items) {
      rows("closed", items.map((item) => [
        short(item.market),
        item.category || "other",
        item.outcome,
        String(item.sourceCount || 0),
        item.signalConfidence !== undefined ? String(item.signalConfidence) : "-",
        fmtUsd.format(item.entryCost || 0),
        fmtUsd.format(item.exitValue || 0),
        money(item.realizedPnl),
        tonePct(item.returnPct)
      ]), "No closed paper trades.");
    }

    function renderClosedMetrics(items, performance) {
      const realized = performance.realizedPnl || items.reduce((sum, item) => sum + (item.realizedPnl || 0), 0);
      const wins = performance.wins || items.filter((item) => (item.realizedPnl || 0) > 0).length;
      const losses = performance.losses || items.filter((item) => (item.realizedPnl || 0) < 0).length;
      const avgRoi = items.length ? items.reduce((sum, item) => sum + (item.returnPct || 0), 0) / items.length : 0;
      const best = items.reduce((current, item) => Math.max(current, item.realizedPnl || 0), 0);
      const worst = items.reduce((current, item) => Math.min(current, item.realizedPnl || 0), 0);
      const root = document.getElementById("closedMetrics");
      const pnl = el("article", "pnl-card");
      pnl.append(
        el("span", "", "Realised PNL"),
        el("strong", realized < 0 ? "negative" : realized > 0 ? "positive" : "", money(realized)),
        el("small", "", wins + " wins / " + losses + " losses")
      );
      const stats = el("article", "stat-stack");
      stats.append(
        statRow("Closed trades", String(performance.closedPositions || items.length || 0)),
        statRow("Win rate", fmtPct.format(performance.winRate || 0)),
        statRow("Average ROI", tonePct(avgRoi)),
        statRow("Best / worst", money(best) + " / " + money(worst))
      );
      root.replaceChildren(pnl, stats);
    }

    function renderAgents(items) {
      const root = document.getElementById("agents");
      if (!items.length) return empty(root, "No agent handoffs recorded yet.");
      root.replaceChildren(...items.map((item) => {
        const card = el("article", "agent-card");
        const top = el("div", "agent-top");
        top.append(el("div", "agent-name", item.name), el("div", "state " + item.state, item.state));
        card.append(top, el("div", "agent-message", item.message), metaLine([item.updatedAt ? age(item.updatedAt) : "waiting"]));
        return card;
      }));
    }

    function renderActivity(items) {
      const root = document.getElementById("activity");
      if (!items.length) return empty(root, "No live activity yet.");
      root.replaceChildren(...items.slice(0, 18).map((item) => {
        const node = el("article", "activity-item " + item.type);
        node.append(
          meta(item.agent || item.level || item.type, age(item.createdAt)),
          el("div", "activity-line", item.message)
        );
        return node;
      }));
    }

    function cards(id, items, className = "metric") {
      document.getElementById(id).replaceChildren(...items.map(([label, value, note]) => {
        const node = el("article", className);
        node.append(el("span", "", label), el("strong", "", value), el("small", "", note));
        return node;
      }));
    }

    function rows(id, items, message) {
      const body = document.getElementById(id);
      if (!items.length) {
        const row = document.createElement("tr");
        const cell = el("td", "empty", message);
        cell.colSpan = 6;
        row.append(cell);
        body.replaceChildren(row);
        return;
      }
      body.replaceChildren(...items.map((cells) => {
        const row = document.createElement("tr");
        cells.forEach((cell) => {
          const td = document.createElement("td");
          if (String(cell).startsWith("+") || String(cell).startsWith("-") || String(cell).startsWith("$-")) td.className = String(cell).includes("-") ? "negative" : "positive";
          td.textContent = String(cell);
          row.append(td);
        });
        return row;
      }));
    }

    function money(value) {
      const sign = value > 0 ? "+" : "";
      return sign + fmtUsd.format(value || 0);
    }

    function tonePct(value) {
      const sign = value > 0 ? "+" : "";
      return sign + fmtPct.format(value || 0);
    }

    function short(value, length = 58) {
      const text = String(value || "Unknown");
      return text.length > length ? text.slice(0, Math.max(0, length - 3)) + "..." : text;
    }

    function empty(root, message) {
      root.replaceChildren(el("div", "empty", message));
    }

    function meta(left, right) {
      const top = el("div", "trade-top");
      top.append(el("span", "", left), el("span", "", right));
      return top;
    }

    function statRow(label, value) {
      const row = el("div", "stat-row");
      row.append(el("span", "", label), el("strong", String(value).includes("-") ? "negative" : String(value).startsWith("+") ? "positive" : "", value));
      return row;
    }

    function metaLine(parts) {
      const node = el("div", "position-meta");
      parts.forEach((part) => node.append(el("span", "", part)));
      return node;
    }

    function miniMoney(label, value, raw = 0) {
      const node = el("div");
      node.append(el("span", "", label), el("strong", raw < 0 ? "negative" : raw > 0 ? "positive" : "", value));
      return node;
    }

    function age(timestamp) {
      if (!timestamp) return "unknown";
      const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
      if (seconds < 60) return seconds + "s ago";
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return minutes + "m ago";
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return hours + "h ago";
      return Math.floor(hours / 24) + "d ago";
    }

    function tick() {
      const seconds = Math.max(0, Math.floor((Date.now() - lastGeneratedAt) / 1000));
      document.getElementById("freshness").textContent = seconds < 2 ? "Updated now" : "Updated " + seconds + "s ago";
    }

    function el(tag, className = "", text = "") {
      const node = document.createElement(tag);
      if (className) node.className = className;
      node.textContent = text;
      return node;
    }

    loadTracker().catch(() => {
      document.getElementById("freshness").textContent = "Tracker unavailable";
    });
    setInterval(tick, 1000);
    setInterval(() => loadTracker().catch(console.error), 10000);
  </script>
</body>
</html>`;
}
