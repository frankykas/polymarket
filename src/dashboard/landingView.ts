export function landingHtml(): string {
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>StratiFi | AI Market Prediction Intelligence</title>
  <meta name="description" content="StratiFi is an autonomous AI-assisted prediction market intelligence platform for wallet signals, risk review, paper trading validation, and transparent public reporting.">
  <style>
    :root {
      color-scheme: dark;
      --bg: #020205;
      --bg-2: #080511;
      --ink: #f7fbff;
      --soft: #d7e3ee;
      --muted: #9b8fb7;
      --line: rgba(221, 174, 255, 0.2);
      --line-strong: rgba(238, 198, 255, 0.42);
      --panel: rgba(15, 9, 24, 0.82);
      --panel-2: rgba(28, 13, 44, 0.9);
      --green: #2cf5a6;
      --teal: #2ce8da;
      --blue: #2191ff;
      --violet: #b85cff;
      --magenta: #ff47f3;
      --amber: #f8bf62;
      --red: #ff7080;
      --shadow: 0 38px 130px rgba(120, 38, 210, 0.28);
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    a { color: inherit; }
    .page {
      min-height: 100vh;
      overflow: hidden;
      background:
        radial-gradient(circle at 50% 0%, rgba(182, 64, 255, 0.42), transparent 28rem),
        radial-gradient(circle at 78% 42rem, rgba(39, 102, 255, 0.16), transparent 28rem),
        linear-gradient(180deg, rgba(2, 2, 5, 0.1), #020205 42rem),
        #020205;
    }
    .nav {
      position: fixed;
      top: 16px;
      left: 50%;
      z-index: 50;
      width: min(1180px, calc(100% - 32px));
      min-height: 66px;
      transform: translateX(-50%);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
      padding: 10px 12px 10px 16px;
      border: 1px solid rgba(238, 198, 255, 0.2);
      border-radius: 999px;
      background: rgba(6, 3, 11, 0.72);
      box-shadow: 0 20px 70px rgba(139, 55, 255, 0.16);
      backdrop-filter: blur(22px);
    }
    .brand {
      display: inline-flex;
      align-items: center;
      text-decoration: none;
      min-width: 0;
    }
    .brand img {
      display: block;
      width: clamp(146px, 14vw, 206px);
      height: auto;
      filter: drop-shadow(0 14px 24px rgba(0, 229, 255, 0.16));
    }
    .nav-links {
      display: flex;
      align-items: center;
      gap: 2px;
    }
    .nav-links a {
      min-height: 38px;
      display: inline-flex;
      align-items: center;
      padding: 0 12px;
      border-radius: 8px;
      color: #e5d7f7;
      text-decoration: none;
      font-size: 13px;
      font-weight: 850;
    }
    .nav-links a:hover,
    .nav-links a:focus {
      background: rgba(184, 92, 255, 0.14);
      outline: none;
    }
    .nav-actions { display: flex; align-items: center; gap: 8px; }
    .button {
      min-height: 42px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 0 14px;
      border: 1px solid rgba(238, 198, 255, 0.3);
      border-radius: 999px;
      background: rgba(20, 10, 32, 0.78);
      color: #f5fbff;
      text-decoration: none;
      font-size: 13px;
      font-weight: 950;
      white-space: nowrap;
      transition: transform 170ms ease, border-color 170ms ease, background 170ms ease;
    }
    .button:hover,
    .button:focus {
      transform: translateY(-1px);
      border-color: rgba(255, 71, 243, 0.62);
      outline: none;
    }
    .button.primary {
      border-color: rgba(255, 182, 255, 0.74);
      background: linear-gradient(135deg, #ffecff, #ff47f3 28%, #7b3cff 78%, #2ce8da);
      color: #09020f;
      box-shadow: 0 18px 56px rgba(213, 65, 255, 0.34);
    }
    .hero {
      position: relative;
      min-height: 105vh;
      display: grid;
      align-items: center;
      padding: 126px clamp(18px, 4vw, 58px) 84px;
      isolation: isolate;
    }
    #heroCanvas {
      position: absolute;
      inset: 0;
      z-index: -3;
      width: 100%;
      height: 100%;
      background: #020205;
    }
    .hero::before {
      content: "";
      position: absolute;
      inset: 0;
      z-index: -2;
      background:
        radial-gradient(circle at 50% -3rem, rgba(255, 79, 243, 0.72), rgba(160, 53, 255, 0.26) 15rem, transparent 30rem),
        radial-gradient(ellipse at 50% 20%, rgba(255, 255, 255, 0.16), transparent 18rem),
        linear-gradient(180deg, rgba(2, 2, 5, 0.08), rgba(2, 2, 5, 0.58) 48%, #020205 100%);
    }
    .hero::after {
      content: "";
      position: absolute;
      left: 50%;
      top: 7rem;
      z-index: -1;
      width: min(40rem, 82vw);
      height: min(18rem, 35vw);
      transform: translateX(-50%);
      border-radius: 0 0 999px 999px;
      background:
        radial-gradient(circle at 50% 0%, rgba(255, 238, 255, 0.92), rgba(255, 80, 238, 0.62) 24%, rgba(147, 61, 255, 0.24) 52%, transparent 72%);
      filter: blur(18px);
      opacity: 0.76;
      pointer-events: none;
    }
    .hero-inner {
      width: min(1180px, 100%);
      margin: 0 auto;
      display: grid;
      grid-template-columns: 1fr;
      gap: clamp(32px, 5vw, 62px);
      align-items: start;
      justify-items: center;
      text-align: center;
    }
    .eyebrow {
      width: fit-content;
      max-width: 100%;
      display: inline-flex;
      align-items: center;
      gap: 10px;
      margin: 0 auto 22px;
      padding: 9px 13px;
      border: 1px solid rgba(238, 198, 255, 0.28);
      border-radius: 999px;
      background: rgba(24, 10, 38, 0.68);
      color: #f3dcff;
      font-size: 12px;
      font-weight: 950;
    }
    .eyebrow::before {
      content: "";
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: var(--magenta);
      box-shadow: 0 0 0 6px rgba(255, 71, 243, 0.14);
      flex: 0 0 auto;
    }
    h1 {
      margin: 0;
      max-width: 900px;
      font-size: clamp(40px, 5.6vw, 76px);
      line-height: 1.04;
      font-weight: 650;
      text-wrap: balance;
    }
    .gradient-text {
      color: transparent;
      background: linear-gradient(90deg, #ffffff 0%, #f7ecff 34%, #ffcbff 55%, #cfa8ff 78%, #ffffff 100%);
      background-clip: text;
      -webkit-background-clip: text;
    }
    .hero-copy {
      max-width: 680px;
      margin: 18px auto 0;
      color: #cfc1df;
      font-size: clamp(15px, 1.65vw, 18px);
      line-height: 1.62;
    }
    .hero-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 12px; margin-top: 28px; }
    .trust-row {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
      width: min(780px, 100%);
      margin: 32px auto 0;
    }
    .trust-chip {
      min-height: 92px;
      padding: 16px;
      border: 1px solid rgba(238, 198, 255, 0.18);
      border-radius: 8px;
      background: linear-gradient(180deg, rgba(40, 16, 62, 0.58), rgba(8, 5, 14, 0.66));
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
    }
    .trust-chip strong { display: block; font-size: 28px; line-height: 1; font-weight: 420; color: #fff; }
    .trust-chip span { display: block; margin-top: 10px; color: var(--muted); font-size: 12px; line-height: 1.4; }
    .terminal {
      position: relative;
      width: min(1060px, 100%);
      min-height: 520px;
      padding: 1px;
      border: 1px solid rgba(255, 188, 255, 0.35);
      border-radius: 18px;
      background:
        linear-gradient(135deg, rgba(255, 236, 255, 0.9), rgba(255, 71, 243, 0.6), rgba(75, 41, 255, 0.25), rgba(44, 232, 218, 0.38));
      box-shadow:
        0 0 0 1px rgba(255, 255, 255, 0.08) inset,
        0 0 54px rgba(255, 71, 243, 0.34),
        0 42px 140px rgba(111, 40, 201, 0.32);
      transform: none;
      transform-origin: center;
    }
    .terminal::after {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      border-radius: 18px;
      background: linear-gradient(110deg, transparent 0%, rgba(255, 255, 255, 0.2) 42%, transparent 58%);
      transform: translateX(-100%);
      animation: sheen 7.5s ease-in-out infinite;
    }
    @keyframes sheen {
      0%, 38% { transform: translateX(-110%); opacity: 0; }
      50% { opacity: 1; }
      72%, 100% { transform: translateX(110%); opacity: 0; }
    }
    .terminal-shell {
      min-height: 518px;
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr);
      border: 1px solid rgba(5, 3, 10, 0.82);
      border-radius: 17px;
      overflow: hidden;
      background:
        radial-gradient(circle at 22% 12%, rgba(255, 71, 243, 0.22), transparent 20rem),
        radial-gradient(circle at 78% 88%, rgba(70, 108, 255, 0.2), transparent 21rem),
        rgba(5, 3, 10, 0.94);
    }
    .terminal-bar {
      min-height: 48px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      padding: 0 15px;
      border-bottom: 1px solid rgba(238, 198, 255, 0.12);
      color: var(--muted);
      font-size: 11px;
      font-weight: 950;
      text-transform: uppercase;
    }
    .dots { display: flex; gap: 7px; }
    .dots span {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: rgba(203, 223, 239, 0.35);
    }
    .live-pill {
      min-height: 25px;
      display: inline-flex;
      align-items: center;
      border: 1px solid rgba(255, 71, 243, 0.42);
      border-radius: 999px;
      padding: 0 9px;
      color: #ffd8ff;
      background: rgba(255, 71, 243, 0.1);
      font-size: 11px;
      font-weight: 950;
    }
    .tape {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 1px;
      background: rgba(238, 198, 255, 0.14);
    }
    .tape-item {
      min-height: 92px;
      padding: 15px;
      background: rgba(13, 7, 22, 0.92);
    }
    .tape-item span {
      display: block;
      color: var(--muted);
      font-size: 11px;
      font-weight: 950;
      text-transform: uppercase;
    }
    .tape-item strong {
      display: block;
      margin-top: 9px;
      font-size: clamp(18px, 2vw, 27px);
      line-height: 1;
    }
    .tape-item small {
      display: block;
      margin-top: 8px;
      color: #ffcbff;
      font-size: 11px;
      font-weight: 850;
    }
    .console-grid {
      display: grid;
      grid-template-columns: minmax(0, 0.82fr) minmax(0, 1.18fr);
      gap: 1px;
      min-height: 0;
      background: rgba(238, 198, 255, 0.12);
    }
    .agent-feed,
    .decision-core {
      min-width: 0;
      padding: 17px;
      background: rgba(7, 4, 13, 0.94);
    }
    .mini-label {
      margin-bottom: 14px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 950;
      text-transform: uppercase;
    }
    .agent-step {
      display: grid;
      grid-template-columns: 34px minmax(0, 1fr) auto;
      gap: 11px;
      align-items: center;
      padding: 13px 0;
      border-bottom: 1px solid rgba(170, 213, 237, 0.1);
    }
    .agent-code {
      width: 34px;
      height: 34px;
      display: grid;
      place-items: center;
      border: 1px solid rgba(255, 71, 243, 0.24);
      border-radius: 8px;
      background: rgba(255, 71, 243, 0.1);
      color: #ffd9ff;
      font-size: 12px;
      font-weight: 950;
    }
    .agent-step strong { display: block; font-size: 13px; }
    .agent-step small { display: block; margin-top: 4px; color: var(--muted); font-size: 11px; line-height: 1.35; }
    .state {
      color: #ffcbff;
      font-size: 11px;
      font-weight: 950;
    }
    .flow-card {
      margin-top: 14px;
      padding: 14px;
      border: 1px solid rgba(248, 191, 98, 0.26);
      border-radius: 8px;
      background: rgba(248, 191, 98, 0.08);
    }
    .flow-card strong { display: block; color: #ffe2a8; }
    .flow-card p { margin: 8px 0 0; color: var(--soft); font-size: 12px; line-height: 1.46; }
    .chart {
      height: 220px;
      border: 1px solid rgba(170, 213, 237, 0.14);
      border-radius: 8px;
      overflow: hidden;
      background:
        repeating-linear-gradient(90deg, rgba(170, 213, 237, 0.07) 0 1px, transparent 1px 48px),
        repeating-linear-gradient(0deg, rgba(170, 213, 237, 0.07) 0 1px, transparent 1px 42px),
        rgba(7, 17, 29, 0.74);
    }
    .chart svg { width: 100%; height: 100%; display: block; }
    .decision-card {
      margin-top: 14px;
      padding: 15px;
      border: 1px solid rgba(255, 71, 243, 0.24);
      border-radius: 8px;
      background:
        linear-gradient(135deg, rgba(255, 71, 243, 0.14), rgba(51, 71, 255, 0.08)),
        rgba(12, 6, 20, 0.78);
    }
    .decision-card h3 { margin: 0; font-size: 17px; }
    .decision-card p { margin: 9px 0 0; color: var(--soft); font-size: 13px; line-height: 1.5; }
    .verdict-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 9px;
      margin-top: 14px;
    }
    .verdict {
      min-height: 70px;
      padding: 11px;
      border: 1px solid rgba(238, 198, 255, 0.14);
      border-radius: 8px;
      background: rgba(5, 3, 10, 0.62);
    }
    .verdict span { display: block; color: var(--muted); font-size: 11px; }
    .verdict strong { display: block; margin-top: 7px; font-size: 14px; color: #ffcbff; }
    main { position: relative; z-index: 1; }
    section {
      padding: clamp(58px, 8vw, 104px) clamp(18px, 4vw, 58px);
      border-top: 1px solid rgba(238, 198, 255, 0.08);
    }
    .wrap {
      width: min(1220px, 100%);
      margin: 0 auto;
    }
    .proof-strip {
      padding-top: 0;
      border-top: 0;
    }
    .proof-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 1px;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--line);
      transform: translateY(-28px);
      box-shadow: 0 28px 90px rgba(106, 32, 188, 0.22);
    }
    .proof {
      min-height: 134px;
      padding: 20px;
      background: rgba(9, 5, 16, 0.96);
    }
    .proof span { display: block; color: var(--muted); font-size: 12px; font-weight: 950; text-transform: uppercase; }
    .proof strong { display: block; margin-top: 11px; font-size: 24px; line-height: 1.08; }
    .proof small { display: block; margin-top: 10px; color: var(--muted); line-height: 1.42; }
    .kicker {
      margin: 0 0 12px;
      color: #ffcbff;
      font-size: 13px;
      font-weight: 950;
      text-transform: uppercase;
    }
    h2 {
      margin: 0;
      max-width: 900px;
      font-size: clamp(32px, 4.6vw, 58px);
      line-height: 1.08;
      font-weight: 560;
      text-wrap: balance;
    }
    .lede {
      max-width: 820px;
      margin: 18px 0 0;
      color: #cfc1df;
      font-size: 18px;
      line-height: 1.68;
    }
    .split {
      display: grid;
      grid-template-columns: minmax(0, 0.92fr) minmax(0, 1.08fr);
      gap: clamp(28px, 6vw, 86px);
      align-items: start;
    }
    .system-map {
      display: grid;
      grid-template-columns: 0.72fr 1fr;
      gap: 16px;
      margin-top: 34px;
    }
    .timeline {
      display: grid;
      gap: 10px;
    }
    .step {
      display: grid;
      grid-template-columns: 46px minmax(0, 1fr);
      gap: 14px;
      padding: 15px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(13, 7, 22, 0.72);
    }
    .step b {
      width: 40px;
      height: 40px;
      display: grid;
      place-items: center;
      border-radius: 8px;
      background: rgba(255, 71, 243, 0.1);
      color: #ffd9ff;
      font-size: 13px;
    }
    .step strong { display: block; font-size: 16px; }
    .step span { display: block; margin-top: 5px; color: var(--muted); line-height: 1.42; font-size: 13px; }
    .ops-panel {
      min-height: 100%;
      padding: 20px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background:
        radial-gradient(circle at 80% 20%, rgba(255, 71, 243, 0.18), transparent 18rem),
        linear-gradient(150deg, rgba(108, 68, 255, 0.14), rgba(255, 71, 243, 0.06)),
        rgba(12, 6, 20, 0.82);
    }
    .matrix {
      display: grid;
      gap: 12px;
      margin-top: 18px;
    }
    .matrix-row {
      display: grid;
      grid-template-columns: 150px minmax(0, 1fr) 88px;
      gap: 12px;
      align-items: center;
      padding: 13px;
      border: 1px solid rgba(238, 198, 255, 0.14);
      border-radius: 8px;
      background: rgba(5, 3, 10, 0.58);
    }
    .matrix-row span { color: var(--muted); font-size: 12px; font-weight: 850; }
    .bar {
      height: 9px;
      overflow: hidden;
      border-radius: 999px;
      background: rgba(238, 198, 255, 0.1);
    }
    .fill {
      height: 100%;
      width: var(--value);
      border-radius: inherit;
      background: linear-gradient(90deg, #6f45ff, #ff47f3, #ffd8ff);
    }
    .matrix-row strong { color: #ffcbff; font-size: 12px; text-align: right; }
    .agent-grid,
    .cards,
    .dashboard-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 14px;
      margin-top: 32px;
    }
    .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .dashboard-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .card {
      min-height: 232px;
      padding: 23px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background:
        radial-gradient(circle at 75% 0%, rgba(255, 71, 243, 0.18), transparent 11rem),
        linear-gradient(150deg, rgba(106, 68, 255, 0.12), transparent 48%),
        rgba(10, 5, 17, 0.78);
      position: relative;
      overflow: hidden;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
      transition: transform 180ms ease, border-color 180ms ease, box-shadow 180ms ease;
    }
    .card::after {
      content: "";
      position: absolute;
      left: 22px;
      right: 22px;
      bottom: 0;
      height: 2px;
      background: linear-gradient(90deg, #ff47f3, #7b3cff, #2ce8da);
      opacity: 0.68;
    }
    .card:hover {
      transform: translateY(-4px);
      border-color: rgba(255, 188, 255, 0.46);
      box-shadow: 0 24px 70px rgba(173, 55, 255, 0.18);
    }
    .card h3 { margin: 0 0 12px; font-size: 23px; font-weight: 540; }
    .card p { margin: 0; color: var(--muted); line-height: 1.64; }
    .card ul {
      margin: 16px 0 0;
      padding: 0;
      list-style: none;
      display: grid;
      gap: 9px;
      color: #e4d7ef;
      line-height: 1.42;
    }
    .card li {
      display: grid;
      grid-template-columns: 18px minmax(0, 1fr);
      gap: 8px;
    }
    .card li::before {
      content: "";
      width: 8px;
      height: 8px;
      margin-top: 7px;
      border-radius: 999px;
      background: var(--magenta);
    }
    .wallet-lens {
      padding: 22px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background:
        radial-gradient(circle at 15% 0%, rgba(255, 71, 243, 0.2), transparent 15rem),
        rgba(12, 6, 20, 0.82);
      box-shadow: 0 24px 80px rgba(125, 41, 210, 0.22);
    }
    .lens-table {
      display: grid;
      gap: 8px;
      margin-top: 18px;
    }
    .lens-row {
      display: grid;
      grid-template-columns: 1fr 110px 110px;
      gap: 12px;
      align-items: center;
      padding: 13px;
      border: 1px solid rgba(238, 198, 255, 0.12);
      border-radius: 8px;
      background: rgba(5, 3, 10, 0.6);
    }
    .lens-row strong { display: block; font-size: 14px; }
    .lens-row span { display: block; margin-top: 5px; color: var(--muted); font-size: 12px; }
    .badge {
      width: fit-content;
      min-height: 25px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0 9px;
      border: 1px solid rgba(255, 71, 243, 0.28);
      border-radius: 999px;
      color: #ffd8ff;
      background: rgba(255, 71, 243, 0.08);
      font-size: 12px;
      font-weight: 950;
      white-space: nowrap;
    }
    .quote {
      background:
        radial-gradient(circle at 80% 50%, rgba(255, 71, 243, 0.2), transparent 24rem),
        linear-gradient(135deg, rgba(116, 68, 255, 0.16), rgba(255, 71, 243, 0.11)),
        rgba(8, 4, 14, 0.82);
    }
    .quote-text {
      max-width: 980px;
      margin: 0;
      font-size: clamp(32px, 4.8vw, 60px);
      line-height: 1.05;
      font-weight: 540;
      text-wrap: balance;
    }
    .quote-text small {
      display: block;
      max-width: 760px;
      margin-top: 18px;
      color: #cfc1df;
      font-size: 18px;
      font-weight: 500;
      line-height: 1.62;
    }
    .cta {
      min-height: 56vh;
      display: grid;
      align-items: center;
      background:
        radial-gradient(ellipse at 50% 100%, rgba(255, 71, 243, 0.42), transparent 30rem),
        radial-gradient(circle at 52% 42%, rgba(119, 68, 255, 0.18), transparent 22rem),
        linear-gradient(180deg, rgba(2, 2, 5, 0.86), rgba(11, 5, 18, 0.94));
    }
    footer {
      padding: 32px clamp(18px, 4vw, 58px);
      border-top: 1px solid var(--line);
      color: var(--muted);
      background: #020205;
    }
    .footer-inner {
      width: min(1220px, 100%);
      margin: 0 auto;
      display: flex;
      justify-content: space-between;
      gap: 18px;
      flex-wrap: wrap;
      font-size: 13px;
    }
    @media (max-width: 1120px) {
      .nav-links { display: none; }
      .hero-inner,
      .split,
      .system-map,
      .agent-grid,
      .cards,
      .dashboard-grid,
      .proof-grid { grid-template-columns: 1fr 1fr; }
      .terminal { transform: none; }
      .console-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 760px) {
      .nav { top: 10px; width: calc(100% - 20px); }
      .brand img { width: 136px; }
      .nav-actions .button:not(.primary) { display: none; }
      .hero { padding-top: 110px; }
      .hero-inner,
      .trust-row,
      .split,
      .system-map,
      .agent-grid,
      .cards,
      .dashboard-grid,
      .proof-grid,
      .tape,
      .verdict-grid,
      .lens-row { grid-template-columns: 1fr; }
      .terminal { min-height: auto; }
      .terminal-shell { min-height: auto; }
      .matrix-row { grid-template-columns: 1fr; }
      .matrix-row strong { text-align: left; }
      h1 { font-size: clamp(44px, 14vw, 68px); }
      .hero-copy,
      .lede { font-size: 16px; }
    }
  </style>
</head>
<body>
  <div class="page">
    <nav class="nav" aria-label="Primary navigation">
      <a class="brand" href="/"><img src="/stratifi-logo.svg" alt="StratiFi"></a>
      <div class="nav-links">
        <a href="#system">System</a>
        <a href="#agents">Agents</a>
        <a href="#wallets">Wallets</a>
        <a href="#risk">Risk</a>
        <a href="#proof">Proof</a>
      </div>
      <div class="nav-actions">
        <a class="button" href="/dashboard">Dashboard</a>
        <a class="button primary" href="/tracker">Live Tracker</a>
      </div>
    </nav>

    <header class="hero">
      <canvas id="heroCanvas" aria-hidden="true"></canvas>
      <div class="hero-inner">
        <div>
          <div class="eyebrow">Autonomous paper-validation layer online</div>
          <h1><span class="gradient-text">Market Intelligence<br>For Modern Markets</span></h1>
          <p class="hero-copy">StratiFi identifies wallet-driven signals, challenges them through risk review, tracks paper outcomes, and exposes public-safe performance without leaking proprietary source intelligence.</p>
          <div class="hero-actions">
            <a class="button primary" href="/tracker">View Public Tracker</a>
            <a class="button" href="/dashboard">Open Viewing Portal</a>
          </div>
          <div class="trust-row" aria-label="Operating highlights">
            <div class="trust-chip"><strong>3</strong><span>Agent layers for discovery, risk review, and oversight.</span></div>
            <div class="trust-chip"><strong>24h</strong><span>Forward paper tracking to build live market evidence.</span></div>
            <div class="trust-chip"><strong>Read-only</strong><span>Public transparency without private control access.</span></div>
          </div>
        </div>
        <aside class="terminal" aria-label="StratiFi command center preview">
          <div class="terminal-shell">
            <div class="terminal-bar">
              <div class="dots"><span></span><span></span><span></span></div>
              <span>StratiFi Decision Console</span>
              <span class="live-pill">Paper live</span>
            </div>
            <div class="tape">
              <div class="tape-item"><span>Signal queue</span><strong>42</strong><small>8 risk reviews</small></div>
              <div class="tape-item"><span>Source quality</span><strong>High</strong><small>Category scoped</small></div>
              <div class="tape-item"><span>Exposure state</span><strong>Clear</strong><small>Reserve protected</small></div>
              <div class="tape-item"><span>PNL trail</span><strong>Ledger</strong><small>Open and closed</small></div>
            </div>
            <div class="console-grid">
              <div class="agent-feed">
                <div class="mini-label">Agent handoff</div>
                <div class="agent-step"><span class="agent-code">SA</span><div><strong>Signal Agent</strong><small>Wallet alignment detected across market category.</small></div><span class="state">SCAN</span></div>
                <div class="agent-step"><span class="agent-code">RM</span><div><strong>Risk Mitigation</strong><small>Liquidity, spread, freshness, and exposure checked.</small></div><span class="state">PASS</span></div>
                <div class="agent-step"><span class="agent-code">OA</span><div><strong>Overseer</strong><small>Position tracked with balance and PNL trail.</small></div><span class="state">LIVE</span></div>
                <div class="flow-card">
                  <strong>Not every signal becomes a trade</strong>
                  <p>Rejected, watched, and shadow-tracked opportunities become evidence for future threshold tuning.</p>
                </div>
              </div>
              <div class="decision-core">
                <div class="mini-label">Decision quality</div>
                <div class="chart" aria-hidden="true">
                  <svg viewBox="0 0 520 220" preserveAspectRatio="none">
                    <path d="M0 178 C55 150 86 161 122 132 C168 96 199 124 241 91 C293 50 328 103 376 74 C422 46 463 62 520 22" fill="none" stroke="rgba(44,245,166,.95)" stroke-width="5"/>
                    <path d="M0 196 C72 180 103 189 154 166 C205 143 241 165 295 128 C351 89 395 126 520 77" fill="none" stroke="rgba(33,145,255,.76)" stroke-width="4"/>
                    <path d="M0 210 C74 194 141 190 204 164 C276 134 307 136 367 102 C427 69 475 49 520 39 L520 220 L0 220 Z" fill="rgba(44,245,166,.12)"/>
                    <circle cx="376" cy="74" r="7" fill="#2cf5a6"/>
                    <circle cx="520" cy="22" r="7" fill="#2ce8da"/>
                  </svg>
                </div>
                <div class="decision-card">
                  <h3>Candidate reviewed, not blindly copied.</h3>
                  <p>Source behavior is useful, but the market still has to support entry, exit, sizing, and treasury exposure before approval.</p>
                  <div class="verdict-grid">
                    <div class="verdict"><span>Confidence</span><strong>Elevated</strong></div>
                    <div class="verdict"><span>Execution</span><strong>Paper only</strong></div>
                    <div class="verdict"><span>Source data</span><strong>Protected</strong></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </header>

    <main>
      <section class="proof-strip">
        <div class="wrap proof-grid">
          <div class="proof"><span>Core stance</span><strong>Intelligence before execution</strong><small>Signals are structured and reviewed before they become candidates.</small></div>
          <div class="proof"><span>Wallet edge</span><strong>Consistency over hype</strong><small>Repeatable category behavior matters more than headline PNL.</small></div>
          <div class="proof"><span>Risk engine</span><strong>Rejecting is a feature</strong><small>Weak liquidity, stale timing, or bad exposure can stop a trade.</small></div>
          <div class="proof"><span>Transparency</span><strong>Proof without leakage</strong><small>Public outcomes are shown while source intelligence stays private.</small></div>
        </div>
      </section>

      <section id="system">
        <div class="wrap">
          <p class="kicker">How StratiFi works</p>
          <h2>A structured intelligence loop for prediction-market decisions.</h2>
          <p class="lede">The platform separates discovery, risk review, position management, accounting, and public reporting so a single module cannot control the entire lifecycle.</p>
          <div class="system-map">
            <div class="timeline">
              <div class="step"><b>01</b><div><strong>Discovery</strong><span>Wallet activity and market behavior are converted into candidate evidence.</span></div></div>
              <div class="step"><b>02</b><div><strong>Risk Review</strong><span>Liquidity, spread, exposure, source quality, and freshness are challenged.</span></div></div>
              <div class="step"><b>03</b><div><strong>Position Management</strong><span>Approved paper positions are monitored after entry by a separate layer.</span></div></div>
              <div class="step"><b>04</b><div><strong>Transparency</strong><span>Public-safe activity is surfaced through the tracker, dashboard, and alerts.</span></div></div>
            </div>
            <div class="ops-panel">
              <p class="mini-label">Signal quality matrix</p>
              <h3 style="margin:0;font-size:24px">Every decision is scored across source, market, and treasury context.</h3>
              <div class="matrix">
                <div class="matrix-row"><span>Source consistency</span><div class="bar"><div class="fill" style="--value: 84%"></div></div><strong>84%</strong></div>
                <div class="matrix-row"><span>Market quality</span><div class="bar"><div class="fill" style="--value: 68%"></div></div><strong>68%</strong></div>
                <div class="matrix-row"><span>Exit support</span><div class="bar"><div class="fill" style="--value: 73%"></div></div><strong>73%</strong></div>
                <div class="matrix-row"><span>Exposure fit</span><div class="bar"><div class="fill" style="--value: 91%"></div></div><strong>91%</strong></div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="agents">
        <div class="wrap">
          <p class="kicker">Three-agent architecture</p>
          <h2>No single agent owns the whole lifecycle.</h2>
          <div class="agent-grid">
            <article class="card"><h3>Signal Agent</h3><p>Discovers source activity and converts relevant behavior into structured market signals.</p><ul><li>Monitors wallet and market behavior.</li><li>Tracks category-specific source edge.</li><li>Provides evidence for risk review.</li></ul></article>
            <article class="card"><h3>Risk Mitigation Agent</h3><p>Challenges whether a signal is actually tradable under current market and treasury conditions.</p><ul><li>Checks liquidity, spread, and price impact.</li><li>Controls exposure and sizing.</li><li>Rejects weak or unsafe candidates.</li></ul></article>
            <article class="card"><h3>Overseer Agent</h3><p>Monitors open positions, exits, accounting, and operating state after approval.</p><ul><li>Tracks unrealized and realized PNL.</li><li>Maintains balance trails.</li><li>Supports recovery-state logic.</li></ul></article>
          </div>
        </div>
      </section>

      <section id="wallets">
        <div class="wrap split">
          <div>
            <p class="kicker">Wallet intelligence</p>
            <h2>Source quality is not a leaderboard.</h2>
            <p class="lede">A wallet can show positive activity and still be a poor source if the edge is not repeatable, category-relevant, timely, or copyable under current market conditions.</p>
          </div>
          <div class="wallet-lens">
            <p class="mini-label">Public-safe source lens</p>
            <div class="lens-table">
              <div class="lens-row"><div><strong>Category edge</strong><span>Source strength is judged per market type.</span></div><span class="badge">Abstracted</span><span class="badge">Protected</span></div>
              <div class="lens-row"><div><strong>Timing usefulness</strong><span>Late or exhausted signals can be rejected.</span></div><span class="badge">Reviewed</span><span class="badge">Logged</span></div>
              <div class="lens-row"><div><strong>Multi-source alignment</strong><span>Agreement helps only when sources are independent.</span></div><span class="badge">Weighted</span><span class="badge">Private</span></div>
              <div class="lens-row"><div><strong>Drawdown behavior</strong><span>Consistency matters more than one outsized win.</span></div><span class="badge">Scored</span><span class="badge">Evolving</span></div>
            </div>
          </div>
        </div>
      </section>

      <section id="risk">
        <div class="wrap">
          <p class="kicker">Risk first</p>
          <h2>Capital protection is the operating system.</h2>
          <div class="cards">
            <article class="card"><h3>Before entry</h3><p>Every candidate is reviewed for clarity, liquidity, spread, price impact, freshness, source quality, profile fit, and exposure.</p></article>
            <article class="card"><h3>During validation</h3><p>Paper results account for market conditions, slippage assumptions, fills, exit costs, and realistic position management.</p></article>
            <article class="card"><h3>During stress</h3><p>Recovery Mode can pause new entries while existing positions continue to be managed and system conditions are reviewed.</p></article>
            <article class="card"><h3>After close</h3><p>Realized outcomes drive performance reporting, future treasury routing, and the long-term buyback and burn direction once live.</p></article>
          </div>
        </div>
      </section>

      <section class="quote">
        <div class="wrap">
          <p class="quote-text">A good source in a bad market can still be rejected.<small>That is the difference between intelligence and blind copy trading. StratiFi is designed to reject weak, stale, unclear, or unsafe opportunities and learn from them.</small></p>
        </div>
      </section>

      <section id="proof">
        <div class="wrap">
          <p class="kicker">Public proof layer</p>
          <h2>Show the activity. Protect the edge.</h2>
          <p class="lede">The public experience is intentionally read-only: users can observe signals, decisions, trades, PNL trails, wallet address display, treasury state, Telegram alerts, and dashboard activity without changing system behavior.</p>
          <div class="dashboard-grid">
            <article class="card"><h3>Tracker</h3><p>Public wallet display, paper balance, open trades, closed trades, and PNL history.</p></article>
            <article class="card"><h3>Dashboard</h3><p>Agent feed, signal funnel, risk reviews, profile comparisons, and treasury view.</p></article>
            <article class="card"><h3>Telegram</h3><p>Broadcast layer for signals, entries, exits, summaries, and system state changes.</p></article>
            <article class="card"><h3>Protected internals</h3><p>Source addresses, scoring weights, provider details, and infrastructure rules stay private.</p></article>
          </div>
        </div>
      </section>

      <section class="cta">
        <div class="wrap">
          <p class="kicker">Watch the validation layer</p>
          <h2>StratiFi is built to prove discipline before scaling capital.</h2>
          <p class="lede">The tracker and viewing portal make the process visible while the intelligence engine continues collecting forward paper data.</p>
          <div class="hero-actions">
            <a class="button primary" href="/tracker">View Live Tracker</a>
            <a class="button" href="/dashboard">Open Dashboard</a>
          </div>
        </div>
      </section>
    </main>

    <footer>
      <div class="footer-inner">
        <span>StratiFi. Autonomous AI-assisted prediction market intelligence.</span>
        <span>Transparent outcomes. Protected intelligence.</span>
      </div>
    </footer>
  </div>

  <script>
    (function () {
      var canvas = document.getElementById("heroCanvas");
      if (!canvas) return;
      var ctx = canvas.getContext("2d");
      var width = 0;
      var height = 0;
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var nodes = [];

      function resize() {
        width = canvas.clientWidth;
        height = canvas.clientHeight;
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        nodes = [];
        var count = Math.max(34, Math.floor(width / 34));
        for (var i = 0; i < count; i += 1) {
          nodes.push({
            x: Math.random() * width,
            y: Math.random() * height,
            vx: (Math.random() - 0.5) * 0.26,
            vy: (Math.random() - 0.5) * 0.18,
            color: i % 4 === 0 ? "#2cf5a6" : i % 4 === 1 ? "#2ce8da" : i % 4 === 2 ? "#2191ff" : "#a98cff"
          });
        }
      }

      function drawGrid() {
        ctx.strokeStyle = "rgba(159, 186, 211, 0.06)";
        ctx.lineWidth = 1;
        for (var x = 0; x < width; x += 92) {
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, height);
          ctx.stroke();
        }
        for (var y = 0; y < height; y += 76) {
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(width, y);
          ctx.stroke();
        }
      }

      function draw(time) {
        ctx.clearRect(0, 0, width, height);
        var bg = ctx.createLinearGradient(0, 0, width, height);
        bg.addColorStop(0, "#04070d");
        bg.addColorStop(0.5, "#081827");
        bg.addColorStop(1, "#0b0f1c");
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, width, height);
        drawGrid();

        for (var i = 0; i < nodes.length; i += 1) {
          var node = nodes[i];
          node.x += node.vx;
          node.y += node.vy;
          if (node.x < 0 || node.x > width) node.vx *= -1;
          if (node.y < 0 || node.y > height) node.vy *= -1;
        }

        for (var a = 0; a < nodes.length; a += 1) {
          for (var b = a + 1; b < nodes.length; b += 1) {
            var first = nodes[a];
            var second = nodes[b];
            var dx = first.x - second.x;
            var dy = first.y - second.y;
            var distance = Math.sqrt(dx * dx + dy * dy);
            if (distance < 150) {
              ctx.strokeStyle = "rgba(89, 205, 255, " + (0.15 * (1 - distance / 150)) + ")";
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.moveTo(first.x, first.y);
              ctx.lineTo(second.x, second.y);
              ctx.stroke();
            }
          }
        }

        ctx.lineWidth = 2;
        for (var wave = 0; wave < 3; wave += 1) {
          ctx.beginPath();
          for (var p = 0; p <= width; p += 18) {
            var y = height * (0.58 + wave * 0.075) + Math.sin(p * 0.008 + time * 0.0007 + wave) * (30 + wave * 9);
            if (p === 0) ctx.moveTo(p, y);
            else ctx.lineTo(p, y);
          }
          ctx.strokeStyle = wave === 0 ? "rgba(44, 245, 166, 0.32)" : wave === 1 ? "rgba(33, 145, 255, 0.26)" : "rgba(169, 140, 255, 0.2)";
          ctx.stroke();
        }

        for (var n = 0; n < nodes.length; n += 1) {
          var dot = nodes[n];
          ctx.fillStyle = dot.color;
          ctx.globalAlpha = 0.74;
          ctx.beginPath();
          ctx.arc(dot.x, dot.y, 2.4, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
        }

        requestAnimationFrame(draw);
      }

      window.addEventListener("resize", resize);
      resize();
      requestAnimationFrame(draw);
    })();
  </script>
</body>
</html>`;
}
