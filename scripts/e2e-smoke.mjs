// Minimal e2e smoke: boot proxy + spawn bin + wait for "active".
// Designed to fail fast with rich timing so we know where it hangs.
import { PTYProcess, canSpawnPty } from "../dist/__tests__/pty-helpers.js";
import { ensureCursorProxyRunning, healthCheckCursorProxy } from "../dist/providers/cursor-proxy.js";
import { PROXY_DEFAULT_URL } from "../dist/providers/cursor-env.js";
import { resolve } from "path";

const T0 = Date.now();
const log = (s) => console.log(`[+${((Date.now()-T0)/1000).toFixed(1)}s] ${s}`);

if (!canSpawnPty()) { log("PTY unavailable, skipping"); process.exit(0); }

log("Checking proxy…");
let ready = await healthCheckCursorProxy(PROXY_DEFAULT_URL);
log(`Proxy health: ${ready ? "up" : "down"}`);
if (!ready && process.env.CURSOR_API_KEY) {
  log("Starting proxy…");
  ready = await ensureCursorProxyRunning(PROXY_DEFAULT_URL);
  log(`Proxy ensured: ${ready}`);
}
if (!ready) { log("No proxy and no key — giving up"); process.exit(1); }

process.env.ANTHROPIC_BASE_URL = PROXY_DEFAULT_URL;
process.env.ANTHROPIC_AUTH_TOKEN = process.env.CURSOR_API_KEY || "";
process.env.NO_PREFLIGHT = "1";

const BIN = resolve("dist/bin.js");
const FIX = resolve("src/__tests__/fixtures/e2e-tasks.json");
log(`Spawning ${BIN} --file ${FIX}`);
const p = new PTYProcess("node", [BIN, "--file", FIX]);

try {
  log("Waiting for 'active'…");
  const hit = await p.waitFor("active", 25_000);
  log(`MATCHED: ${JSON.stringify(hit)}`);
  log("SUCCESS");
  p.kill();
  process.exit(0);
} catch (e) {
  log(`FAIL: ${e.message?.slice(0, 200)}`);
  log("--- last 800 chars of output ---");
  console.log(p.text().slice(-800));
  p.kill();
  process.exit(1);
}
