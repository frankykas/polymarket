export function adminControlHtml(): string {
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>StratiFi Admin Control</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #06101d;
      --panel: #0d1828;
      --panel-soft: #10243d;
      --ink: #eef6ff;
      --muted: #8fa7c3;
      --line: #1e3550;
      --green: #29d391;
      --red: #ff6b7a;
      --amber: #f4b84f;
      --blue: #39a8ff;
      --shadow: 0 18px 52px rgba(0, 0, 0, 0.32);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at top left, rgba(57, 168, 255, 0.16), transparent 34rem),
        linear-gradient(145deg, #06101d 0%, #091625 52%, #07111f 100%);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    button, input { font: inherit; }
    .shell { width: min(1180px, calc(100% - 32px)); margin: 0 auto; padding: 28px 0 42px; }
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 18px; margin-bottom: 22px; }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand img { width: 44px; height: 44px; border-radius: 8px; }
    h1 { margin: 0; font-size: clamp(24px, 3vw, 38px); letter-spacing: 0; }
    .subtle { margin: 4px 0 0; color: var(--muted); }
    .grid { display: grid; grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr); gap: 16px; align-items: start; }
    .panel {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(13, 24, 40, 0.86);
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    .panel h2 { margin: 0; padding: 16px 18px; font-size: 16px; border-bottom: 1px solid var(--line); }
    .content { padding: 18px; }
    .token-row { display: flex; gap: 10px; }
    .token-row input {
      width: 100%;
      min-width: 0;
      padding: 11px 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #071320;
      color: var(--ink);
    }
    .button-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 14px; }
    .button-grid button, .token-row button, .toolbar button {
      border: 1px solid transparent;
      border-radius: 8px;
      color: #f8fbff;
      background: var(--panel-soft);
      padding: 11px 12px;
      cursor: pointer;
      min-height: 44px;
    }
    button.primary { background: #1179e6; }
    button.green { background: #11875c; }
    button.amber { background: #94651a; }
    button.red { background: #9e2734; }
    button:hover { filter: brightness(1.08); }
    button:disabled { cursor: wait; opacity: 0.58; }
    .status-list { display: grid; gap: 10px; }
    .status-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(16, 36, 61, 0.55);
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 9px;
      border-radius: 999px;
      background: rgba(143, 167, 195, 0.14);
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }
    .pill.ok { color: var(--green); background: rgba(41, 211, 145, 0.12); }
    .pill.bad { color: var(--red); background: rgba(255, 107, 122, 0.12); }
    .toolbar { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
    pre {
      min-height: 420px;
      max-height: 70vh;
      overflow: auto;
      margin: 0;
      padding: 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #020914;
      color: #dcecff;
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .message { min-height: 22px; margin-top: 12px; color: var(--muted); }
    .message.error { color: var(--red); }
    @media (max-width: 860px) {
      .topbar { align-items: flex-start; flex-direction: column; }
      .grid { grid-template-columns: 1fr; }
      .button-grid { grid-template-columns: 1fr; }
      .token-row { flex-direction: column; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="topbar">
      <div class="brand">
        <img src="/stratifi-mark.svg" alt="">
        <div>
          <h1>Admin Control</h1>
          <p class="subtle">Private controls for the paper bot and dashboard services.</p>
        </div>
      </div>
      <a class="pill" href="/dashboard">Open dashboard</a>
    </section>

    <section class="grid">
      <div class="panel">
        <h2>Access</h2>
        <div class="content">
          <div class="token-row">
            <input id="token" type="password" autocomplete="current-password" placeholder="Admin token">
            <button class="primary" id="save-token">Unlock</button>
          </div>
          <p class="message" id="message"></p>
        </div>
      </div>

      <div class="panel">
        <h2>Service Status</h2>
        <div class="content">
          <div class="status-list">
            <div class="status-item"><strong>Bot</strong><span class="pill" id="bot-status">unknown</span></div>
            <div class="status-item"><strong>Dashboard</strong><span class="pill" id="dashboard-status">unknown</span></div>
            <div class="status-item"><strong>Updated</strong><span class="pill" id="updated-at">never</span></div>
          </div>
          <div class="button-grid">
            <button class="green" data-action="start-bot">Start bot</button>
            <button class="red" data-action="stop-bot">Stop bot</button>
            <button class="amber" data-action="restart-bot">Restart bot</button>
            <button class="amber" data-action="restart-dashboard">Restart dashboard</button>
            <button class="primary" data-action="scan">Run scan safely</button>
            <button data-action="performance">Run performance</button>
          </div>
        </div>
      </div>

      <div class="panel" style="grid-column: 1 / -1;">
        <h2>Logs</h2>
        <div class="content">
          <div class="toolbar">
            <button data-log="bot">Bot logs</button>
            <button data-log="dashboard">Dashboard logs</button>
            <button data-refresh>Refresh status</button>
          </div>
          <pre id="output">Enter the admin token to load controls.</pre>
        </div>
      </div>
    </section>
  </main>
  <script>
    const tokenInput = document.getElementById("token");
    const output = document.getElementById("output");
    const message = document.getElementById("message");
    const statusEls = {
      bot: document.getElementById("bot-status"),
      dashboard: document.getElementById("dashboard-status"),
      updated: document.getElementById("updated-at")
    };
    const saved = new URLSearchParams(location.search).get("token") || localStorage.getItem("stratifi_admin_token") || "";
    tokenInput.value = saved;

    function token() {
      return tokenInput.value.trim();
    }

    function headers() {
      return token() ? { authorization: "Bearer " + token() } : {};
    }

    function setMessage(text, isError = false) {
      message.textContent = text;
      message.className = "message" + (isError ? " error" : "");
    }

    function setBusy(isBusy) {
      document.querySelectorAll("button").forEach((button) => button.disabled = isBusy);
    }

    function setStatus(el, value) {
      el.textContent = value;
      el.className = "pill " + (value === "active" ? "ok" : value === "inactive" ? "" : "bad");
    }

    async function requestJson(url, options = {}) {
      const response = await fetch(url, { ...options, headers: { ...headers(), ...(options.headers || {}) } });
      const text = await response.text();
      let body;
      try { body = text ? JSON.parse(text) : {}; } catch { body = { output: text }; }
      if (!response.ok) throw new Error(body.error || text || "Request failed");
      return body;
    }

    async function refreshStatus() {
      const body = await requestJson("/api/admin/control/status");
      setStatus(statusEls.bot, body.bot);
      setStatus(statusEls.dashboard, body.dashboard);
      statusEls.updated.textContent = new Date(body.generatedAt).toLocaleString();
      return body;
    }

    async function runAction(action) {
      setBusy(true);
      setMessage("Running " + action + "...");
      output.textContent = "";
      try {
        const body = await requestJson("/api/admin/control/action", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action })
        });
        output.textContent = body.output || JSON.stringify(body, null, 2);
        setMessage("Done.");
        await refreshStatus();
      } catch (error) {
        output.textContent = String(error.message || error);
        setMessage(String(error.message || error), true);
      } finally {
        setBusy(false);
      }
    }

    async function loadLogs(service) {
      setBusy(true);
      setMessage("Loading logs...");
      try {
        const body = await requestJson("/api/admin/control/logs?service=" + encodeURIComponent(service));
        output.textContent = body.output || "";
        setMessage("Logs loaded.");
      } catch (error) {
        output.textContent = String(error.message || error);
        setMessage(String(error.message || error), true);
      } finally {
        setBusy(false);
      }
    }

    document.getElementById("save-token").addEventListener("click", async () => {
      localStorage.setItem("stratifi_admin_token", token());
      try {
        await refreshStatus();
        setMessage("Unlocked.");
        output.textContent = "Controls ready.";
      } catch (error) {
        setMessage(String(error.message || error), true);
      }
    });

    document.querySelectorAll("[data-action]").forEach((button) => {
      button.addEventListener("click", () => runAction(button.dataset.action));
    });
    document.querySelectorAll("[data-log]").forEach((button) => {
      button.addEventListener("click", () => loadLogs(button.dataset.log));
    });
    document.querySelector("[data-refresh]").addEventListener("click", () => refreshStatus().catch((error) => setMessage(String(error.message || error), true)));

    if (saved) refreshStatus().then(() => setMessage("Unlocked.")).catch(() => setMessage("Token required.", true));
  </script>
</body>
</html>`;
}
