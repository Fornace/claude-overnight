// Tool-use smoke: boot proxy + spawn bin + wait for an actual tool invocation.
// Proves the SDK streams tool_use blocks through the proxy in runtime shape.
import { PTYProcess, canSpawnPty } from "../dist/__tests__/pty-helpers.js";
import { ensureCursorProxyRunning, healthCheckCursorProxy } from "../dist/providers/cursor-proxy.js";
import { PROXY_DEFAULT_URL } from "../dist/providers/cursor-env.js";
import { resolve } from "path";

const T0 = Date.now();
const log = (s) => console.log(`[+${((Date.now()-T0)/1000).toFixed(1)}s] ${s}`);

if (!canSpawnPty()) { log("PTY unavailable, skipping"); process.exit(0); }

log("Checking proxy…");
let ready = await healthCheckCursorProxy(PROXY_DEFAULT_URL);
if (!ready && process.env.CURSOR_API_KEY) {
  log("Starting proxy…");
  ready = await ensureCursorProxyRunning(PROXY_DEFAULT_URL);
}
if (!ready) { log("No proxy and no key — giving up"); process.exit(1); }
log(`Proxy: up`);

process.env.ANTHROPIC_BASE_URL = PROXY_DEFAULT_URL;
process.env.ANTHROPIC_AUTH_TOKEN = process.env.CURSOR_API_KEY || "";
process.env.NO_PREFLIGHT = "1";

const BIN = resolve("dist/bin.js");
const FIX = resolve("src/__tests__/fixtures/e2e-tool-use.json");
log(`Spawning ${BIN}`);
const p = new PTYProcess("node", [BIN, "--file", FIX]);

try {
  log("Waiting for swarm 'active'…");
  await p.waitFor("active", 25_000);
  log("Waiting for Read tool on README.md…");
  // handleMsg logs tool invocations; the agent row / events log show the tool name.
  // Match either the tool name or the filename target.
  const hit = await p.waitFor(/Read[\s\S]{0,120}README|README[\s\S]{0,40}md/, 45_000);
  log(`TOOL USE OBSERVED: ${JSON.stringify(hit.slice(0, 80))}`);
  log("SUCCESS");
  p.kill();
  process.exit(0);
} catch (e) {
  log(`FAIL: ${e.message?.slice(0, 200)}`);
  log("--- last 1200 chars of output ---");
  console.log(p.text().slice(-1200));
  p.kill();
  process.exit(1);
}
