export function indexHtml(): string {
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>StratiFi Viewing Portal</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #07111f;
      --panel: #0d1828;
      --panel-soft: #10243d;
      --ink: #eef6ff;
      --muted: #8fa7c3;
      --line: #1e3550;
      --green: #29d391;
      --red: #ff6b7a;
      --amber: #f4b84f;
      --blue: #39a8ff;
      --blue-strong: #1179e6;
      --teal: #25d0c4;
      --plum: #a78bfa;
      --shadow: 0 18px 52px rgba(0, 0, 0, 0.32);
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      background:
        radial-gradient(circle at top left, rgba(57, 168, 255, 0.18), transparent 34rem),
        linear-gradient(145deg, #06101d 0%, #091625 52%, #07111f 100%);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    .app-shell { min-height: 100vh; display: grid; grid-template-columns: 248px minmax(0, 1fr); }
    .sidebar {
      position: sticky;
      top: 0;
      height: 100vh;
      padding: 24px 18px;
      background: linear-gradient(180deg, #081321 0%, #0b1c30 100%);
      color: #f8fafc;
      display: flex;
      flex-direction: column;
      gap: 28px;
    }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand-mark {
      width: 40px;
      height: 40px;
      border-radius: 8px;
      display: block;
      filter: drop-shadow(0 10px 22px rgba(0, 220, 255, 0.18));
    }
    .brand strong, .brand span { display: block; }
    .brand span { margin-top: 2px; color: #91b8dc; font-size: 12px; }
    .nav-list { display: grid; gap: 6px; }
    .nav-list a {
      color: #dcecff;
      text-decoration: none;
      padding: 11px 12px;
      border-radius: 8px;
      font-size: 14px;
    }
    .nav-list a:hover, .nav-list a:focus { background: rgba(57, 168, 255, 0.14); outline: none; }
    .sidebar-status {
      margin-top: auto;
      padding: 12px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 8px;
      display: flex;
      align-items: center;
      gap: 8px;
      color: #cbd5e1;
      font-size: 13px;
    }
    .status-dot {
      width: 9px;
      height: 9px;
      border-radius: 999px;
      background: #20c997;
      box-shadow: 0 0 0 5px rgba(32, 201, 151, 0.14);
    }
    .main { min-width: 0; padding: 24px; }
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 24px; }
    .eyebrow { margin: 0 0 6px; color: var(--blue); text-transform: uppercase; font-size: 12px; font-weight: 800; }
    h1, h2, h3, p { margin-top: 0; }
    h1 { margin-bottom: 0; font-size: clamp(30px, 4vw, 46px); line-height: 1.02; }
    h2 { margin-bottom: 4px; font-size: 20px; }
    .view-only-pill {
      min-height: 40px;
      display: inline-flex;
      align-items: center;
      gap: 9px;
      padding: 0 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      color: var(--ink);
      font-size: 13px;
      font-weight: 800;
      white-space: nowrap;
    }
    .section {
      margin-bottom: 22px;
      padding: 20px;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
    }
    .section-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 18px; margin-bottom: 16px; }
    .section-header p { margin-bottom: 0; color: var(--muted); font-size: 14px; }
    .compact { margin-bottom: 12px; }
    .timestamp { color: var(--muted); font-size: 13px; white-space: nowrap; }
    .metric-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 14px; }
    .metric-card, .profile-card, .comparison-card, .treasury-item, .wallet-card {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: linear-gradient(180deg, #0f2035 0%, #0b1727 100%);
    }
    .metric-card { padding: 14px; min-width: 0; }
    .metric-label { color: var(--muted); font-size: 12px; font-weight: 700; text-transform: uppercase; }
    .metric-value { margin-top: 9px; font-size: 26px; font-weight: 800; overflow-wrap: anywhere; }
    .metric-note { margin-top: 4px; color: var(--muted); font-size: 13px; line-height: 1.35; }
    .profile-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .profile-card { padding: 16px; }
    .profile-card h3 { margin-bottom: 12px; font-size: 17px; }
    .profile-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
    .stat-block span, .comparison-row span, .treasury-item span, .wallet-card span {
      display: block;
      color: var(--muted);
      font-size: 12px;
    }
    .stat-block strong, .comparison-row strong, .treasury-item strong, .wallet-card strong {
      display: block;
      margin-top: 4px;
      font-size: 15px;
    }
    .two-column { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(320px, 0.75fr); gap: 18px; }
    .activity-feed { display: grid; gap: 10px; max-height: 482px; overflow: auto; padding-right: 4px; }
    .activity-item, .telegram-alert { border-left: 4px solid var(--blue); background: #0a1626; border-radius: 8px; padding: 12px; }
    .activity-item.risk { border-color: var(--amber); }
    .activity-item.overseer { border-color: var(--teal); }
    .activity-item.treasury { border-color: var(--plum); }
    .telegram-feed { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .telegram-alert.signal { border-color: var(--blue); }
    .telegram-alert.entry { border-color: var(--amber); }
    .telegram-alert.closed { border-color: var(--green); }
    .telegram-alert.summary { border-color: var(--plum); }
    .activity-top { display: flex; justify-content: space-between; gap: 10px; color: var(--muted); font-size: 12px; }
    .activity-title { margin: 6px 0 4px; font-weight: 800; }
    .activity-reason { color: var(--muted); font-size: 13px; line-height: 1.45; }
    .comparison-panel, .treasury-panel, .wallet-panel { display: grid; gap: 10px; }
    .comparison-card, .treasury-item, .wallet-card { padding: 14px; }
    .comparison-row { display: flex; justify-content: space-between; gap: 12px; padding: 9px 0; border-bottom: 1px solid var(--line); }
    .comparison-row:last-child { border-bottom: 0; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; min-width: 860px; }
    th, td { padding: 12px 10px; border-bottom: 1px solid var(--line); text-align: left; white-space: nowrap; font-size: 13px; }
    th { color: var(--muted); font-size: 12px; text-transform: uppercase; }
    tbody tr:hover { background: rgba(57, 168, 255, 0.08); }
    .truncate { max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .badge {
      display: inline-flex;
      align-items: center;
      height: 24px;
      padding: 0 8px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 800;
      border: 1px solid transparent;
    }
    .badge.good { color: var(--green); background: rgba(41, 211, 145, 0.12); border-color: rgba(41, 211, 145, 0.36); }
    .badge.warn { color: var(--amber); background: rgba(244, 184, 79, 0.13); border-color: rgba(244, 184, 79, 0.38); }
    .badge.bad { color: var(--red); background: rgba(255, 107, 122, 0.12); border-color: rgba(255, 107, 122, 0.38); }
    .badge.neutral { color: var(--blue); background: rgba(57, 168, 255, 0.13); border-color: rgba(57, 168, 255, 0.36); }
    .positive { color: var(--green); font-weight: 800; }
    .negative { color: var(--red); font-weight: 800; }
    .treasury-layout { align-items: start; }
    .wallet-address { overflow-wrap: anywhere; font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; font-size: 13px; }
    .bar { height: 9px; overflow: hidden; background: #17283c; border-radius: 999px; margin-top: 10px; }
    .bar-fill { height: 100%; background: linear-gradient(90deg, var(--blue-strong), var(--teal)); width: var(--value); }
    .empty { color: var(--muted); padding: 14px 0; }
    @media (max-width: 1100px) {
      .app-shell { grid-template-columns: 1fr; }
      .sidebar { position: static; height: auto; }
      .nav-list { grid-template-columns: repeat(4, minmax(0, 1fr)); }
      .metric-grid, .profile-grid, .two-column, .telegram-feed { grid-template-columns: 1fr; }
    }
    @media (max-width: 680px) {
      .main { padding: 16px; }
      .topbar, .section-header { flex-direction: column; }
      .nav-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .profile-stats, .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
  </style>
</head>
<body>
  <div class="app-shell">
    <aside class="sidebar" aria-label="Main navigation">
      <div class="brand">
        <img class="brand-mark" src="/stratifi-mark.svg" alt="" aria-hidden="true">
        <div>
          <strong>StratiFi</strong>
          <span>Agent Framework</span>
        </div>
      </div>
      <nav class="nav-list">
        <a href="#overview">Overview</a>
        <a href="#discovery">Discovery</a>
        <a href="#agents">Agent Feed</a>
        <a href="#orders">Order Health</a>
        <a href="#trends">Trends</a>
        <a href="#ledger">Trade Ledger</a>
        <a href="#lockup">Capital Lockup</a>
        <a href="#signals">Signals</a>
        <a href="#telegram">Telegram</a>
        <a href="#risk">Risk Review</a>
        <a href="#rejections">Rejected Signals</a>
        <a href="#positions">Positions</a>
        <a href="#treasury">Treasury</a>
        <a href="#wallets">Wallets</a>
      </nav>
      <div class="sidebar-status"><span class="status-dot"></span> Paper trading active</div>
    </aside>
    <main class="main">
      <header class="topbar">
        <div>
          <p class="eyebrow">Public transparency dashboard</p>
          <h1>StratiFi Viewing Portal</h1>
        </div>
        <div class="view-only-pill"><span class="status-dot"></span> View only</div>
      </header>
      <section id="overview" class="section">
        <div class="section-header">
          <div>
            <h2>Overview</h2>
            <p>Read-only Polymarket paper trading visibility across wallet intelligence, risk checks, and paper outcomes</p>
          </div>
          <div class="timestamp" id="lastUpdated">Loading</div>
        </div>
        <div class="metric-grid" id="metricGrid"></div>
        <div class="profile-grid" id="profileGrid"></div>
      </section>
      <section id="orders" class="section">
        <div class="section-header">
          <div>
            <h2>Order Health</h2>
            <p>Paper execution quality, stale orders, fill rate, and dust-order protection</p>
          </div>
          <div class="timestamp">Paper execution only</div>
        </div>
        <div class="metric-grid" id="orderHealthGrid"></div>
      </section>
      <section id="trends" class="section">
        <div class="section-header">
          <div>
            <h2>Intelligence Trends</h2>
            <p>Category shadow-copy drift, paper order flow, and per-agent throughput</p>
          </div>
          <div class="timestamp">Rolling windows</div>
        </div>
        <div class="metric-grid" id="trendGrid"></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Window</th><th>Category</th><th>Shadow Trades</th><th>Realised</th><th>Shadow PNL</th><th>Average ROI</th><th>Orders</th><th>Fills</th><th>Agents</th></tr></thead>
            <tbody id="trendTable"></tbody>
          </table>
        </div>
      </section>
      <section id="lockup" class="section">
        <div class="section-header">
          <div>
            <h2>Capital Lockup</h2>
            <p>Reserve cash, active exposure capacity, and long-dated paper capital protection</p>
          </div>
          <div class="timestamp">Long-dated entries rejected by Risk</div>
        </div>
        <div class="metric-grid" id="capitalLockupGrid"></div>
      </section>
      <section id="discovery" class="section">
        <div class="section-header">
          <div>
            <h2>Wallet Discovery</h2>
            <p>Source-quality audit based on copyability, consistency, evidence, category fit, and shadow-copy results</p>
          </div>
          <div class="timestamp">Source addresses hidden publicly</div>
        </div>
        <div class="metric-grid discovery-grid" id="discoveryGrid"></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Source Class</th><th>Status</th><th>Quality</th><th>Category Edge</th><th>Commitment</th><th>Risk</th><th>Signal Usefulness</th><th>Reason</th></tr></thead>
            <tbody id="walletDiscoveryTable"></tbody>
          </table>
        </div>
      </section>
      <section id="agents" class="section two-column">
        <div>
          <div class="section-header compact"><div><h2>Agent Activity</h2><p>Signal Agent to Risk Mitigation Agent to Overseer Agent</p></div></div>
          <div class="activity-feed" id="activityFeed"></div>
        </div>
        <div>
          <div class="section-header compact"><div><h2>Profile Comparison</h2><p>Paper results grouped by the profile that approved each entry</p></div></div>
          <div class="comparison-panel" id="comparisonPanel"></div>
        </div>
      </section>
      <section id="signals" class="section">
        <div class="section-header"><div><h2>Signal Board</h2><p>Tracked wallet activity converted into structured candidates</p></div></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Signal</th><th>Market</th><th>Outcome</th><th>Source Strength</th><th>Consistency</th><th>Category</th><th>Activity</th><th>State</th></tr></thead>
            <tbody id="signalsTable"></tbody>
          </table>
        </div>
      </section>
      <section id="telegram" class="section">
        <div class="section-header">
          <div><h2>Telegram Alerts</h2><p>Public-safe alert history inferred from signal, trade, and event records</p></div>
          <div class="timestamp">No public commands</div>
        </div>
        <div class="telegram-feed" id="telegramFeed"></div>
      </section>
      <section id="risk" class="section">
        <div class="section-header"><div><h2>Risk Review</h2><p>Every signal must pass validation before paper execution</p></div></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Signal</th><th>Profile</th><th>Depth</th><th>Spread</th><th>Resolution</th><th>Position</th><th>Risk</th><th>Decision</th></tr></thead>
          <tbody id="riskTable"></tbody>
        </table>
        </div>
      </section>
      <section id="rejections" class="section">
        <div class="section-header"><div><h2>Rejected Signals</h2><p>Latest risk failures with concrete blocker details for tuning</p></div></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Time</th><th>Market</th><th>Outcome</th><th>Confidence</th><th>Risk</th><th>Profile</th><th>Exposure</th><th>Reason</th></tr></thead>
            <tbody id="rejectedSignalsTable"></tbody>
          </table>
        </div>
      </section>
      <section id="positions" class="section">
        <div class="section-header"><div><h2>Open Positions</h2><p>Trades handed to the Overseer after paper entry</p></div></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Position</th><th>Market</th><th>Outcome</th><th>Profile</th><th>Shares</th><th>Entry Cost</th><th>Current Value</th><th>Unrealised</th><th>State</th></tr></thead>
            <tbody id="openTradesTable"></tbody>
          </table>
        </div>
      </section>
      <section class="section">
        <div class="section-header"><div><h2>Category Performance</h2><p>Shadow-copy performance by Polymarket category</p></div></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Category</th><th>Trades</th><th>Win Rate</th><th>Net ROI</th><th>Realised PNL</th><th>Avg Hold</th><th>Max DD</th></tr></thead>
            <tbody id="categoryTable"></tbody>
          </table>
        </div>
      </section>
      <section class="section">
        <div class="section-header"><div><h2>Source Intelligence</h2><p>Category-specific source history, reconstructed source positions, and degradation watch</p></div></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Category</th><th>Sources</th><th>Avg Copyability</th><th>Avg Score</th><th>Evidence</th><th>Shadow Impact</th><th>Trades</th><th>High Reliability</th></tr></thead>
            <tbody id="sourceCategoryTable"></tbody>
          </table>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Source</th><th>Category</th><th>Start</th><th>Latest</th><th>Score Change</th><th>Copy Change</th><th>Snapshots</th><th>Status</th></tr></thead>
            <tbody id="sourceDegradationTable"></tbody>
          </table>
        </div>
      </section>
      <section class="section">
        <div class="section-header"><div><h2>Closed Trades</h2><p>Realised paper outcomes and exit prices</p></div></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Position</th><th>Market</th><th>Outcome</th><th>Profile</th><th>Entry Cost</th><th>Exit Value</th><th>Realised PNL</th><th>Net ROI</th><th>Reason</th></tr></thead>
            <tbody id="closedTradesTable"></tbody>
          </table>
        </div>
      </section>
      <section id="ledger" class="section">
        <div class="section-header"><div><h2>Trade Ledger</h2><p>Paper entries and exits with running PNL, equity, and available cash</p></div></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Time</th><th>Type</th><th>Market</th><th>Outcome</th><th>Profile</th><th>Notional</th><th>Realised</th><th>Total PNL</th><th>Equity</th><th>Cash</th></tr></thead>
            <tbody id="ledgerTable"></tbody>
          </table>
        </div>
      </section>
      <section id="treasury" class="section two-column treasury-layout">
        <div>
          <div class="section-header compact"><div><h2>Treasury Simulation</h2><p>Paper capital and realised-profit-only allocation model</p></div></div>
          <div class="treasury-panel" id="treasuryPanel"></div>
        </div>
        <div id="wallets">
          <div class="section-header compact"><div><h2>Wallet Intelligence</h2><p>Tracked source consistency and signal usefulness</p></div></div>
          <div class="wallet-panel" id="walletPanel"></div>
        </div>
      </section>
    </main>
  </div>
  <script>
    const fmtUsd = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
    const fmtNum = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
    const fmtPct = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 });
    let lastGeneratedAt = Date.now();

    async function loadDashboard() {
      const response = await fetch("/api/dashboard", { cache: "no-store" });
      render(await response.json());
    }

    function render(data) {
      lastGeneratedAt = data.generatedAt;
      tick();
      renderMetrics(data);
      renderProfiles(data);
      renderOrderHealth(data);
      renderTrends(data);
      renderExposure(data);
      renderCapitalLockup(data);
      renderDiscovery(data);
      renderActivity(data);
      renderComparison(data);
      renderSignals(data);
      renderTelegramAlerts(data);
      renderRisk(data);
      renderRejectedSignals(data);
      renderOpenTrades(data);
      renderCategories(data);
      renderSourceIntelligence(data);
      renderClosedTrades(data);
      renderLedger(data);
      renderTreasury(data);
      renderWallet(data);
    }

    function renderMetrics(data) {
      const p = data.performance;
      const s = data.shadow;
      const source = data.sourceSummary;
      const capital = data.capital || {};
      const bankroll = capital.startingBankroll || totalBankroll(data);
      const value = capital.equity ?? (bankroll + p.totalPnl);
      const rejectionCount = data.risk.filter((item) => item.decision === "REJECT").reduce((sum, item) => sum + item.count, 0);
      const rows = [
        ["Live Since", data.logs.at(-1) ? new Date(data.logs.at(-1).createdAt).toLocaleDateString() : "Pending", "Public stats begin after scans run"],
        ["Data Feed", "Healthy", "Provider details hidden"],
        ["Paper Capital", fmtUsd.format(bankroll), "Configured simulation bankroll"],
        ["Portfolio Value", fmtUsd.format(value), tonePct(p.totalPnl / bankroll) + " paper Net ROI"],
        ["Available Cash", fmtUsd.format(capital.availableCash ?? bankroll), fmtUsd.format(capital.deployedCost ?? p.openCost ?? 0) + " deployed"],
        ["Open Value", fmtUsd.format(capital.openValue ?? p.openValue ?? 0), "Marked from latest paper position prices"],
        ["Total PnL", fmtUsd.format(p.totalPnl), p.openPositions + " open / " + p.closedPositions + " closed"],
        ["Win Rate", fmtPct.format(p.winRate || 0), p.wins + " wins / " + p.losses + " losses"],
        ["Signals Found", fmtNum.format(p.signals), p.approvedSignals + " approved for paper orders"],
        ["Risk Failed", fmtNum.format(rejectionCount), "Grouped by risk decision reason"],
        ["Shadow Trades", fmtNum.format(s.simulated), s.skipped + " skipped"],
        ["Shadow PnL", fmtUsd.format(s.pnl), tonePct(s.avgReturnPct) + " average return"],
        ["Open Trades", fmtNum.format(p.openPositions), "Overseer monitored"],
        ["Source Quality", source.reliabilityMix, "Average source strength " + fmtNum.format(source.avgCopyabilityScore)]
      ];
      renderCards("metricGrid", rows);
    }

    function renderProfiles(data) {
      const rejected = data.risk.filter((item) => item.decision === "REJECT").reduce((sum, item) => sum + item.count, 0);
      const notes = {
        Conservative: "Strict confidence and SAFE-only risk rules",
        Aggressive: "Allows controlled WARNING risk states"
      };
      document.getElementById("profileGrid").replaceChildren(...data.profiles.map((profile) => {
        const card = el("article", "profile-card");
        card.append(el("h3", "", profile.profile + " Profile"));
        const stats = el("div", "profile-stats");
        const rows = [
          ["Capital", fmtUsd.format(profile.bankroll + profile.totalPnl)],
          ["Net ROI", tonePct(profile.totalPnl / profile.bankroll)],
          ["Win rate", fmtPct.format(profile.winRate || 0)],
          ["Drawdown", fmtUsd.format(profile.maxDrawdown)],
          ["Trades", String(profile.paperOrders)],
          ["Rejected", String(profile.rejectedSignals || rejected)],
          ["PNL", fmtUsd.format(profile.totalPnl)],
          ["Status", "ACTIVE"]
        ];
        stats.replaceChildren(...rows.map(([label, value]) => statBlock(label, value)));
        card.append(stats, el("div", "metric-note", notes[profile.profile] || "Profile rules active"));
        return card;
      }));
    }

    function renderOrderHealth(data) {
      const h = data.orderHealth || {};
      const staleStatus = h.staleOpenOrders > 0 ? "Needs review" : "Clean";
      const dustStatus = h.dustFilledOrders > 0 ? String(h.dustFilledOrders) : "Blocked";
      renderCards("orderHealthGrid", [
        ["Filled Orders", fmtNum.format(h.filledOrders || 0), fmtPct.format(h.fillRate || 0) + " lifetime fill rate"],
        ["Open Orders", fmtNum.format(h.openOrders || 0), h.staleOpenOrders + " stale / expired by TTL"],
        ["Expired Orders", fmtNum.format(h.expiredOrders || 0), "Old no-fill orders are archived"],
        ["Avg Fill Size", fmtUsd.format(h.avgFilledNotional || 0), fmtNum.format(h.recentFills24h || 0) + " fills in 24h"],
        ["Dust Fills", dustStatus, "New orders below minimum are rejected"],
        ["Order State", staleStatus, "Partial " + fmtNum.format(h.partialOrders || 0) + " / Cancelled " + fmtNum.format(h.cancelledOrders || 0)]
      ]);
    }

    function renderTrends(data) {
      const shadow = data.trends?.shadowCategories || [];
      const orders = data.trends?.orderHealth || [];
      const agents = data.trends?.agentThroughput || [];
      const shadowPnl = shadow.reduce((sum, item) => sum + (item.pnl || 0), 0);
      const createdOrders = orders.reduce((sum, item) => sum + (item.createdOrders || 0), 0);
      const filledNotional = orders.reduce((sum, item) => sum + (item.filledNotional || 0), 0);
      const agentEvents = agents.reduce((sum, item) => sum + (item.events || 0), 0);
      renderCards("trendGrid", [
        ["Category Drift", fmtUsd.format(shadowPnl), shadow.length + " category/day points"],
        ["Order Flow", fmtNum.format(createdOrders), fmtUsd.format(filledNotional) + " filled notional"],
        ["Agent Throughput", fmtNum.format(agentEvents), agents.length + " hourly agent points"],
        ["Degradation Watch", fmtNum.format((data.sourceDegradation || []).filter((item) => item.status === "DEGRADING").length), "Sources weakening over the window"]
      ]);
      const latestOrders = orders.at(-1) || {};
      const latestAgentCount = agents.slice(-6).reduce((sum, item) => sum + (item.events || 0), 0);
      const rows = shadow.slice(-12).reverse().map((item) => [
        new Date(item.bucketStart).toLocaleDateString(),
        title(item.category),
        String(item.simulated),
        String(item.realized),
        fmtUsd.format(item.pnl),
        tonePct(item.avgReturnPct),
        String(latestOrders.createdOrders || 0),
        String(latestOrders.fills || 0),
        String(latestAgentCount)
      ]);
      renderTable("trendTable", rows, [], "No trend points yet.");
    }

    function renderExposure(data) {
      const e = data.exposure || {};
      const l = data.capitalLockup || {};
      const f = data.paperFeedback || {};
      const remaining = e.remainingExposure ?? 0;
      const exposureNote = e.status === "FULL"
        ? "New buys paused until exposure drops"
        : e.status === "NEAR_CAP"
          ? "Risk agent is close to pausing new buys"
          : "Risk agent can approve new buys";
      renderCards("discoveryGrid", [
        ["Discovery State", "Active", "Consistency-weighted quality audit"],
        ["Exposure Status", e.status || "Pending", exposureNote],
        ["Remaining Exposure", fmtUsd.format(remaining), fmtPct.format(e.usedPct || 0) + " used of active cap"],
        ["Reserve Cash", fmtUsd.format(l.reserveCash || 0), fmtPct.format(l.reserveCashPct || 0) + " protected from normal entries"],
        ["Long-Dated Capital", fmtUsd.format(l.longDatedCapital || 0), (l.longDatedPositions || 0) + " positions beyond max horizon"],
        ["Paper Feedback", fmtNum.format(f.sources || 0) + " sources", "Avg score impact " + fmtNum.format(f.avgScoreImpact || 0)]
      ]);
    }

    function renderCapitalLockup(data) {
      const e = data.exposure || {};
      const l = data.capitalLockup || {};
      const longest = l.longestResolutionHours ? Math.round(l.longestResolutionHours) + "h" : "None";
      renderCards("capitalLockupGrid", [
        ["Reserve Cash", fmtUsd.format(l.reserveCash || 0), fmtPct.format(l.reserveCashPct || 0) + " protected from normal entries"],
        ["Active Trading Cap", fmtUsd.format(l.activeTradingCap || 0), "Max available to active paper entries"],
        ["Open Exposure", fmtUsd.format(e.openExposure || 0), fmtPct.format(e.usedPct || 0) + " of active cap used"],
        ["Remaining Exposure", fmtUsd.format(e.remainingExposure || 0), e.status || "Pending"],
        ["Max Resolution Window", Math.round(l.maxTimeToResolutionHours || 0) + "h", "Markets beyond this are rejected"],
        ["Long-Dated Capital", fmtUsd.format(l.longDatedCapital || 0), (l.longDatedPositions || 0) + " positions beyond window"],
        ["Longest Open Horizon", longest, "Current open-position resolution horizon"],
        ["Lockup Policy", "Active", "Keeps paper capital out of slow dead-money markets"]
      ]);
    }

    function renderDiscovery(data) {
      const rows = data.wallets.map((wallet) => [
        "#" + wallet.rank + " Source",
        wallet.sourceStrength >= 75 ? "MONITORED" : wallet.sourceStrength >= 55 ? "CANDIDATE" : "PROBATION",
        quality(wallet.sourceStrength),
        title(wallet.category),
        Math.round(wallet.sampleConfidence * 100) + "%",
        wallet.flags.length ? "Review" : "Controlled",
        quality(wallet.categoryStrength),
        wallet.tradeCount + " trades, " + wallet.uniqueMarkets + " markets"
      ]);
      renderTable("walletDiscoveryTable", rows, [1]);
    }

    function renderActivity(data) {
      const events = data.events.length ? data.events : data.logs.map((log) => ({
        agent: "Signal Agent",
        type: log.level,
        message: log.message,
        createdAt: log.createdAt
      }));
      const feed = document.getElementById("activityFeed");
      if (!events.length) return empty(feed, "No public agent activity yet.");
      feed.replaceChildren(...events.slice(0, 16).map((event) => {
        const item = el("article", "activity-item " + agentClass(event.agent));
        item.append(
          meta(new Date(event.createdAt).toLocaleTimeString(), event.agent || "System"),
          el("div", "activity-title", event.type || "Event"),
          el("div", "activity-reason", event.message)
        );
        return item;
      }));
    }

    function renderComparison(data) {
      const conservative = data.profiles.find((profile) => profile.profile === "Conservative") || emptyProfile("Conservative");
      const aggressive = data.profiles.find((profile) => profile.profile === "Aggressive") || emptyProfile("Aggressive");
      const rows = [
        ["Total trades", conservative.paperOrders, aggressive.paperOrders],
        ["Win rate", fmtPct.format(conservative.winRate || 0), fmtPct.format(aggressive.winRate || 0)],
        ["Realised PNL", fmtUsd.format(conservative.realizedPnl), fmtUsd.format(aggressive.realizedPnl)],
        ["Max drawdown", fmtUsd.format(conservative.maxDrawdown), fmtUsd.format(aggressive.maxDrawdown)],
        ["Rejections", conservative.rejectedSignals, aggressive.rejectedSignals],
        ["Avg hold", minutes(conservative.avgHoldMinutes), minutes(aggressive.avgHoldMinutes)]
      ];
      const card = el("article", "comparison-card");
      card.replaceChildren(...rows.map(([label, conservative, aggressive]) => {
        const row = el("div", "comparison-row");
        row.append(el("span", "", label), el("strong", "", conservative + " / " + aggressive));
        return row;
      }));
      document.getElementById("comparisonPanel").replaceChildren(card);
    }

    function renderSignals(data) {
      const rows = data.signals.map((signal) => [
        signal.id,
        signal.market,
        signal.outcome,
        signal.confidence >= 80 ? "Strong" : signal.confidence >= 65 ? "Medium" : "Weak",
        String(signal.confidence),
        "Market",
        signal.alignedSourceCount + " sources",
        signal.decision
      ]);
      renderTable("signalsTable", rows, [7], "No signals stored yet.");
    }

    function renderTelegramAlerts(data) {
      const alerts = [
        ...data.signals.slice(0, 3).map((signal) => ({
          type: "signal",
          time: new Date(signal.createdAt).toLocaleTimeString(),
          title: signal.decision === "TRADE_CANDIDATE" ? "Signal Detected" : "Signal Scored",
          body: signal.market + " / " + signal.outcome + ". Confidence " + signal.confidence + ".",
          footer: "Sent to Risk Mitigation Agent"
        })),
        ...data.positions.slice(0, 2).map((position) => ({
          type: "entry",
          time: new Date(position.openedAt).toLocaleTimeString(),
          title: "Paper Entry Open",
          body: position.market + " / " + position.outcome + " at " + position.avgEntryPrice.toFixed(3) + ".",
          footer: "Paper trading only"
        })),
        ...data.closedPositions.slice(0, 2).map((position) => ({
          type: "closed",
          time: new Date(position.updatedAt).toLocaleTimeString(),
          title: "Position Closed",
          body: position.market + " closed at " + fmtUsd.format(position.realizedPnl) + " paper PnL.",
          footer: "Exit recorded by Overseer"
        }))
      ];
      const feed = document.getElementById("telegramFeed");
      if (!alerts.length) return empty(feed, "No public-safe Telegram alert history yet.");
      feed.replaceChildren(...alerts.map((alert) => {
        const item = el("article", "telegram-alert " + alert.type);
        item.append(meta(alert.time, "Telegram"), el("div", "activity-title", alert.title), el("div", "activity-reason", alert.body), el("div", "metric-note", alert.footer));
        return item;
      }));
    }

    function renderRisk(data) {
      const rows = data.risk.map((item, index) => [
        "RISK-" + String(index + 1).padStart(3, "0"),
        item.profile || "Profile rules",
        "Checked",
        "Checked",
        "Checked",
        fmtUsd.format(item.decision === "APPROVE" ? 1 : 0),
        item.decision === "REJECT" ? "HIGH_RISK" : item.decision === "REDUCE_SIZE" ? "WARNING" : "SAFE",
        item.decision
      ]);
      renderTable("riskTable", rows, [6, 7], "No risk decisions stored yet.");
    }

    function renderRejectedSignals(data) {
      const rows = (data.rejectedSignals || []).map((item) => {
        const details = item.details || {};
        const qualityReasons = details.marketQualityReasons || [];
        return [
          new Date(item.createdAt).toLocaleTimeString(),
          item.marketId || "Unknown",
          item.outcome || "Unknown",
          item.confidence ?? "Unknown",
          item.riskState || "Unknown",
          item.profile || "None",
          details.openExposure !== undefined ? fmtUsd.format(details.openExposure) : "Unknown",
          qualityReasons.length ? qualityReasons.join("; ") : item.reason
        ];
      });
      renderTable("rejectedSignalsTable", rows, [4, 5], "No rejected signals stored yet.");
    }

    function renderOpenTrades(data) {
      const rows = data.positions.map((position) => [
        position.id,
        position.market,
        position.outcome,
        position.profile || "Unassigned",
        fmtNum.format(position.size),
        fmtUsd.format(position.entryCost || position.avgEntryPrice * position.size),
        fmtUsd.format(position.currentValue || position.currentPrice * position.size),
        fmtUsd.format(position.unrealizedPnl),
        "HOLDING"
      ]);
      renderTable("openTradesTable", rows, [8], "No open paper positions.");
    }

    function renderCategories(data) {
      const rows = data.shadowCategories.map((item) => [
        title(item.category),
        String(item.simulated),
        fmtPct.format(item.winRate || 0),
        tonePct(item.avgReturnPct),
        fmtUsd.format(item.pnl),
        "Pending",
        "Pending"
      ]);
      renderTable("categoryTable", rows, [], "No shadow category performance yet.");
    }

    function renderSourceIntelligence(data) {
      const sourceRows = (data.sourceCategories || []).map((item) => [
        title(item.category),
        String(item.sources),
        fmtNum.format(item.avgCopyabilityScore),
        fmtNum.format(item.avgScore),
        fmtPct.format(item.avgSampleConfidence || 0),
        fmtNum.format(item.avgShadowImpact),
        fmtNum.format(item.totalTrades),
        String(item.highReliability)
      ]);
      renderTable("sourceCategoryTable", sourceRows, [], "No source category history yet.");

      const degradationRows = (data.sourceDegradation || []).map((item) => [
        item.source,
        title(item.category),
        fmtNum.format(item.startScore),
        fmtNum.format(item.latestScore),
        signed(item.scoreChange),
        item.copyabilityChange === undefined ? "Pending" : signed(item.copyabilityChange),
        String(item.snapshots),
        item.status
      ]);
      renderTable("sourceDegradationTable", degradationRows, [7], "No score drift history yet.");
    }

    function renderClosedTrades(data) {
      const rows = data.closedPositions.map((position) => [
        position.id,
        position.market,
        position.outcome,
        position.profile || "Unassigned",
        fmtUsd.format(position.entryCost || position.avgEntryPrice * position.size),
        fmtUsd.format(position.exitValue || position.currentPrice * position.size),
        fmtUsd.format(position.realizedPnl),
        tonePct(position.returnPct),
        "Closed"
      ]);
      renderTable("closedTradesTable", rows, [], "No closed paper positions yet.");
    }

    function renderLedger(data) {
      const rows = (data.tradeLedger || []).map((item) => [
        new Date(item.createdAt).toLocaleString(),
        item.type,
        item.marketId,
        item.outcome,
        item.profile || "Shared",
        fmtUsd.format(item.notional),
        fmtUsd.format(item.realizedPnl),
        fmtUsd.format(item.totalPnl),
        fmtUsd.format(item.equity),
        fmtUsd.format(item.availableCash)
      ]);
      renderTable("ledgerTable", rows, [1], "No paper trade ledger yet.");
    }

    function renderTreasury(data) {
      const p = data.performance;
      const capital = data.capital || {};
      const bankroll = capital.startingBankroll || totalBankroll(data);
      const current = capital.equity ?? (bankroll + p.totalPnl);
      const rows = [
        ["Starting Paper Capital", fmtUsd.format(bankroll)],
        ["Current Paper Capital", fmtUsd.format(current)],
        ["Available Cash", fmtUsd.format(capital.availableCash ?? bankroll)],
        ["Deployed to Open Positions", fmtUsd.format(capital.deployedCost ?? p.openCost ?? 0)],
        ["Open Position Value", fmtUsd.format(capital.openValue ?? p.openValue ?? 0)],
        ["Base Protected Capital", fmtUsd.format(bankroll)],
        ["Safety Buffer Target", fmtUsd.format(bankroll * 2)],
        ["Buffer Status", current >= bankroll * 2 ? "PROTECTED" : "BUFFER_UNDER_TARGET"],
        ["Distributable Excess", fmtUsd.format(Math.max(0, current - bankroll * 2))],
        ["Simulated Buyback", "Paused"],
        ["Buyback & Burn Weekly", fmtUsd.format(0)],
        ["Treasury Compounded", fmtUsd.format(0)],
        ["Active Trading Days", "Pending"]
      ];
      const panel = document.getElementById("treasuryPanel");
      panel.replaceChildren(...rows.map(([label, value]) => {
        const item = el("div", "treasury-item");
        item.append(el("span", "", label), el("strong", "", value));
        return item;
      }));
    }

    function renderWallet(data) {
      const top = data.wallets[0];
      const confidence = top ? Math.round(top.sampleConfidence * 100) : 0;
      const rows = [
        ["Source privacy", "Source addresses hidden"],
        ["Consistency score", top ? String(top.categoryStrength) : "Pending"],
        ["Signals / approved / rejected", data.performance.signals + " / " + data.performance.approvedSignals + " / pending"],
        ["Win rate / shadow ROI / weighting", fmtPct.format(data.performance.winRate || 0) + " / " + tonePct(data.shadow.avgReturnPct) + " / " + fmtNum.format(data.sourceSummary.avgShadowImpact)]
      ];
      const panel = document.getElementById("walletPanel");
      const privacy = el("article", "wallet-card");
      privacy.append(el("span", "", rows[0][0]), el("strong", "wallet-address", rows[0][1]));
      const bar = el("div", "bar");
      const fill = el("div", "bar-fill");
      fill.style.setProperty("--value", confidence + "%");
      bar.append(fill);
      privacy.append(bar);
      panel.replaceChildren(privacy, ...rows.slice(1).map(([label, value]) => {
        const card = el("article", "wallet-card");
        card.append(el("span", "", label), el("strong", "", value));
        return card;
      }));
    }

    function renderCards(id, rows) {
      document.getElementById(id).replaceChildren(...rows.map(([label, value, note]) => {
        const card = el("article", "metric-card");
        card.append(el("div", "metric-label", label), el("div", "metric-value", value), el("div", "metric-note", note));
        return card;
      }));
    }

    function renderTable(id, rows, statusColumns = [], emptyMessage = "No data yet.") {
      const tbody = document.getElementById(id);
      if (!rows.length) {
        const row = document.createElement("tr");
        const cell = el("td", "empty", emptyMessage);
        cell.colSpan = 9;
        row.append(cell);
        tbody.replaceChildren(row);
        return;
      }
      tbody.replaceChildren(...rows.map((cells) => {
        const row = document.createElement("tr");
        cells.forEach((cell, index) => {
          const td = document.createElement("td");
          if (index === 1) td.className = "truncate";
          if (statusColumns.includes(index)) {
            const badge = el("span", "badge " + badgeClass(cell), cell);
            td.append(badge);
          } else {
            const text = String(cell);
            if (text.startsWith("+") || text.startsWith("-") || text.startsWith("$-")) {
              td.append(el("span", moneyClass(text), text));
            } else {
              td.textContent = text;
            }
          }
          row.append(td);
        });
        return row;
      }));
    }

    function statBlock(label, value) {
      const block = el("div", "stat-block");
      const strong = el("strong", value === "ACTIVE" ? "badge good" : value.startsWith("-") ? "negative" : value.startsWith("+") ? "positive" : "", value);
      block.append(el("span", "", label), strong);
      return block;
    }

    function totalBankroll(data) {
      return data.profiles.reduce((sum, profile) => sum + profile.bankroll, 0) || 200;
    }

    function emptyProfile(profile) {
      return {
        profile,
        bankroll: 10000,
        paperOrders: 0,
        rejectedSignals: 0,
        realizedPnl: 0,
        totalPnl: 0,
        winRate: 0,
        maxDrawdown: 0,
        avgHoldMinutes: 0
      };
    }

    function minutes(value) {
      if (!value) return "Pending";
      if (value < 60) return Math.round(value) + "m";
      return Math.floor(value / 60) + "h " + Math.round(value % 60) + "m";
    }

    function empty(root, message) {
      root.replaceChildren(el("div", "empty", message));
    }

    function meta(left, right) {
      const top = el("div", "activity-top");
      top.append(el("span", "", left), el("span", "", right));
      return top;
    }

    function badgeClass(value) {
      if (["EXECUTED", "SAFE", "HOLDING", "PARTIAL_SELL", "PROTECTED", "APPROVE", "TRADE_CANDIDATE", "MONITORED"].includes(String(value))) return "good";
      if (["WARNING", "WATCHING", "SCORED", "BUFFER_UNDER_TARGET", "REDUCE_SIZE", "CANDIDATE", "WATCHLIST"].includes(String(value))) return "warn";
      if (["DISCARDED", "HIGH_RISK", "REJECTED", "REJECT", "STOPPED_OUT", "PROBATION"].includes(String(value))) return "bad";
      return "neutral";
    }

    function moneyClass(value) {
      return String(value).includes("-") ? "negative" : "positive";
    }

    function agentClass(agent) {
      if (agent === "Risk Mitigation Agent") return "risk";
      if (agent === "Overseer Agent") return "overseer";
      if (agent === "Treasury Simulation") return "treasury";
      return "signal";
    }

    function quality(value) {
      return value >= 75 ? "Strong" : value >= 50 ? "Medium" : "Weak";
    }

    function tonePct(value) {
      const sign = value > 0 ? "+" : "";
      return sign + fmtPct.format(value || 0);
    }

    function signed(value) {
      const sign = value > 0 ? "+" : "";
      return sign + fmtNum.format(value || 0);
    }

    function title(value) {
      return String(value || "other").replace(/\b\w/g, (char) => char.toUpperCase());
    }

    function tick() {
      const seconds = Math.max(0, Math.floor((Date.now() - lastGeneratedAt) / 1000));
      document.getElementById("lastUpdated").textContent = seconds < 2 ? "Updated now" : "Updated " + seconds + "s ago";
    }

    function el(tag, className = "", value = "") {
      const node = document.createElement(tag);
      if (className) node.className = className;
      node.textContent = value;
      return node;
    }

    loadDashboard().catch((error) => {
      console.error(error);
      document.getElementById("lastUpdated").textContent = "Dashboard API unavailable";
    });
    setInterval(tick, 1000);
    setInterval(() => loadDashboard().catch(console.error), 15000);
  </script>
</body>
</html>`;
}
