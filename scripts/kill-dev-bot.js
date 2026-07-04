import { existsSync, readFileSync, unlinkSync } from "node:fs";

const pidPath = "data/polymarket-paper-bot.dev.pid";

if (!existsSync(pidPath)) {
  process.exit(0);
}

let pid;
try {
  const state = JSON.parse(readFileSync(pidPath, "utf8"));
  pid = Number(state.pid);
} catch {
  removePidFile();
  process.exit(0);
}

if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
  removePidFile();
  process.exit(0);
}

try {
  process.kill(pid, 0);
} catch {
  removePidFile();
  process.exit(0);
}

try {
  process.kill(pid, "SIGTERM");
  console.log(`Stopped previous Polymarket dev bot process ${pid}.`);
} catch (error) {
  console.warn(`Previous bot process ${pid} was recorded but could not be stopped: ${error instanceof Error ? error.message : String(error)}`);
}

removePidFile();

function removePidFile() {
  try {
    unlinkSync(pidPath);
  } catch {
    // Best-effort cleanup only.
  }
}
