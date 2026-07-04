import { mkdirSync, writeFileSync } from "node:fs";
import { landingHtml } from "./landingView.js";
import { trackerHtml } from "./trackerView.js";
import { indexHtml } from "./view.js";

mkdirSync("public", { recursive: true });
writeFileSync("public/index.html", landingHtml(), "utf8");
writeFileSync("public/dashboard.html", indexHtml(), "utf8");
writeFileSync("public/tracker.html", trackerHtml(), "utf8");
writeFileSync("public/health.json", JSON.stringify({ ok: true, mode: "PAPER", generatedAt: Date.now(), source: "static-export" }), "utf8");
console.log("Exported Vercel landing page, dashboard shell, and tracker shell to public/.");

process.exit(0);
