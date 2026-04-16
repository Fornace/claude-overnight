#!/usr/bin/env node
/** Ephemeral-port matrix for cursor-composer (macOS: watch Keychain during smoke). See README. */

import { spawn, execSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, existsSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

function loadToken() {
  const a = process.env.CURSOR_API_KEY?.trim();
  if (a) return a;
  const b = process.env.CURSOR_AUTH_TOKEN?.trim();
  if (b) return b;
  const store = join(homedir(), ".claude", "claude-overnight", "providers.json");
  try {
    const j = JSON.parse(readFileSync(store, "utf8"));
    const p = j?.providers?.find((x) => x?.cursorProxy && x?.cursorApiKey?.trim());
    if (p?.cursorApiKey?.trim()) return p.cursorApiKey.trim();
  } catch {
    /* ignore */
  }
  return null;
}

function resolveComposerCli() {
  try {
    const require = createRequire(join(REPO_ROOT, "package.json"));
    const pkgJson = require.resolve("cursor-composer-in-claude/package.json");
    const root = dirname(pkgJson);
    const cli = join(root, "dist", "cli.js");
    return existsSync(cli) ? cli : null;
  } catch {
    return null;
  }
}

function resolveAgentNodeScript() {
  let sysNode = null;
  let agentJs = null;
  try {
    sysNode = execSync("which node 2>/dev/null", { timeout: 3_000, encoding: "utf-8", shell: "bash" }).trim() || null;
    const agentPath = execSync("command -v agent 2>/dev/null || command -v cursor-agent 2>/dev/null", {
      timeout: 3_000,
      encoding: "utf-8",
      shell: "bash",
    }).trim();
    if (agentPath) {
      const agentDir = dirname(realpathSync(agentPath));
      const indexPath = `${agentDir}/index.js`;
      if (existsSync(indexPath)) agentJs = indexPath;
    }
  } catch {
    /* ignore */
  }
  return { sysNode, agentJs };
}

function killTree(child) {
  if (!child?.pid) return;
  try {
    child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
}

function ensurePool() {
  try {
    const src = join(homedir(), ".cursor", "cli-config.json");
    if (!existsSync(src)) return null;
    const buf = readFileSync(src);
    const dirs = [];
    for (let i = 1; i <= 5; i++) {
      const d = join(homedir(), ".cursor-api-proxy", "accounts", `pool-${i}`);
      try {
        mkdirSync(d, { recursive: true });
        writeFileSync(join(d, "cli-config.json"), buf);
        dirs.push(d);
      } catch {
        /* ignore */
      }
    }
    return dirs.length > 0 ? dirs.join(",") : null;
  } catch {
    return null;
  }
}

function baseProxyEnv(token, agentPaths) {
  const bridgeKey =
    process.env.CURSOR_BRIDGE_API_KEY?.trim() || token;
  /** @type {Record<string, string>} */
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)),
    CI: "true",
    CURSOR_BRIDGE_API_KEY: bridgeKey,
    CURSOR_SKIP_KEYCHAIN: "1",
    CURSOR_API_KEY: token,
    CURSOR_AUTH_TOKEN: token,
    // Mirrors src/providers.ts: CLI streaming path (not ACP) to accept
    // opus/sonnet *-thinking-* friendly names; chat-only off to avoid
    // temp-HOME Keychain waits on macOS; account pool for parallel safety.
    CURSOR_BRIDGE_USE_ACP: "0",
    CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE: "false",
  };
  const pool = ensurePool();
  if (pool) env.CURSOR_CONFIG_DIRS = pool;
  if (agentPaths.sysNode && agentPaths.agentJs) {
    env.CURSOR_AGENT_NODE = agentPaths.sysNode;
    env.CURSOR_AGENT_SCRIPT = agentPaths.agentJs;
  }
  return env;
}

/** @type {Array<{ id: string; set?: Record<string, string>; del?: string[] }>} */
function buildMatrix(includeDanger) {
  const rows = [
    { id: "01-overnight-parity" },
    { id: "02-acp-on-regress", set: { CURSOR_BRIDGE_USE_ACP: "1" } },
    { id: "03-chat-only-regress", set: { CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE: "true" } },
    { id: "04-no-pool-regress", del: ["CURSOR_CONFIG_DIRS"] },
    { id: "05-skip-keychain-off", set: { CURSOR_SKIP_KEYCHAIN: "0" } },
    { id: "06-ci-off", set: { CI: "0" } },
    { id: "07-no-agent-node-override", del: ["CURSOR_AGENT_NODE", "CURSOR_AGENT_SCRIPT"] },
    { id: "08-bridge-key-only-for-agent", del: ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"] },
    { id: "09-verbose", set: { CURSOR_BRIDGE_VERBOSE: "true" } },
    { id: "10-max-mode", set: { CURSOR_BRIDGE_MAX_MODE: "true" } },
    { id: "11-prompt-via-stdin", set: { CURSOR_BRIDGE_PROMPT_VIA_STDIN: "true" } },
    { id: "12-force-bridge", set: { CURSOR_BRIDGE_FORCE: "true" } },
  ];
  if (includeDanger) {
    rows.push({
      id: "99-danger-no-cursor-keys",
      del: ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN", "CURSOR_BRIDGE_API_KEY", "CURSOR_CONFIG_DIRS"],
      set: { CURSOR_SKIP_KEYCHAIN: "0", CI: "0" },
    });
  }
  return rows;
}

function mergeRow(base, row) {
  const env = { ...base, ...row.set };
  for (const k of row.del ?? []) {
    delete env[k];
  }
  return env;
}

function captureAcpLine(stdout, stderr, timeoutMs) {
  let buf = "";
  return new Promise((resolve) => {
    const finish = (line) => {
      cleanup();
      resolve(line);
    };
    const cleanup = () => {
      clearTimeout(to);
      clearInterval(poll);
      stdout?.removeListener("data", onData);
      stderr?.removeListener("data", onData);
    };
    const onData = (chunk) => {
      buf += String(chunk);
      tryMatch();
    };
    const tryMatch = () => {
      const m = buf.match(/- ACP:[^\n]*/);
      if (m) finish(m[0].trim());
    };
    stdout?.on("data", onData);
    stderr?.on("data", onData);
    const poll = setInterval(tryMatch, 40);
    const to = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
  });
}

async function main() {
  const argv = new Set(process.argv.slice(2));
  const quick = argv.has("--quick");
  const includeDanger = argv.has("--include-danger");
  const portBase = Number(process.env.MATRIX_PORT_BASE || 18965);
  const modelsRaw = process.env.MATRIX_MODELS?.trim();
  const models = modelsRaw
    ? modelsRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : [process.env.MATRIX_MODEL || "composer-2"];
  const msgTimeoutMs = Number(process.env.MATRIX_MSG_TIMEOUT_MS || 120_000);

  const token = loadToken();
  if (!token) {
    console.error("No API key: set CURSOR_API_KEY or add cursorApiKey to ~/.claude/claude-overnight/providers.json (cursorProxy).");
    process.exit(1);
  }
  const cli = resolveComposerCli();
  if (!cli) {
    console.error("cursor-composer-in-claude not found (npm install).");
    process.exit(1);
  }
  const agentPaths = resolveAgentNodeScript();
  const base = baseProxyEnv(token, agentPaths);
  const matrix = buildMatrix(includeDanger);
  const modelStride = matrix.length + 8;

  console.log(`Composer CLI: ${cli}`);
  console.log(`Agent override: ${agentPaths.sysNode && agentPaths.agentJs ? `${agentPaths.sysNode} + ${agentPaths.agentJs}` : "(none)"}`);
  console.log(`Port base: ${portBase} | Models: ${models.join(", ")} | Smoke: ${quick ? "OFF" : "ON"} | Rows/model: ${matrix.length}\n`);

  for (let mi = 0; mi < models.length; mi++) {
    const model = models[mi];
    const portBaseM = portBase + mi * modelStride;
    console.log(`\n╔══ Model: ${model} (ports ${portBaseM}–${portBaseM + matrix.length - 1}) ══╗\n`);

    const report = [];

    for (let i = 0; i < matrix.length; i++) {
    const row = matrix[i];
    const port = portBaseM + i;
    const env = mergeRow(base, row);
    env.CURSOR_BRIDGE_PORT = String(port);
    const baseUrl = `http://127.0.0.1:${port}`;
    const authHeader = { Authorization: `Bearer ${token}` };

    process.stdout.write(`\n── ${row.id} (port ${port}) ──\n`);

    const child = spawn(process.execPath, [cli], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    const acpLine = await captureAcpLine(child.stdout, child.stderr, 12_000);
    process.stdout.write(acpLine ? `${acpLine}\n` : "(no ACP line in 12s — check stderr)\n");
    if (!acpLine) {
      console.error("  (tip: ensure ports " + portBaseM + "–" + (portBaseM + matrix.length - 1) + " are free)");
    }

    const t0 = Date.now();
    let healthMs = null;
    for (let j = 0; j < 60; j++) {
      try {
        const r = await fetch(`${baseUrl}/health`, {
          headers: authHeader,
          signal: AbortSignal.timeout(2_000),
        });
        if (r.ok) {
          healthMs = Date.now() - t0;
          break;
        }
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (healthMs == null) {
      console.log("health: FAIL (no response)");
      report.push({ id: row.id, acp: acpLine, healthMs: null, smoke: "skipped (no health)" });
      killTree(child);
      await new Promise((r) => setTimeout(r, 800));
      continue;
    }
    console.log(`health: OK (${healthMs}ms)`);

    let smoke = quick ? "skipped (--quick)" : "pending";
    if (!quick) {
      try {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), msgTimeoutMs);
        const res = await fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: { ...authHeader, "content-type": "application/json" },
          body: JSON.stringify({
            model,
            max_tokens: 24,
            stream: false,
            messages: [{ role: "user", content: "Reply with exactly: ok" }],
          }),
          signal: ctrl.signal,
        });
        clearTimeout(to);
        smoke = res.ok ? `HTTP ${res.status}` : `HTTP ${res.status} ${(await res.text()).slice(0, 120)}`;
      } catch (e) {
        smoke = e instanceof Error ? e.message : String(e);
      }
    }
    console.log(`smoke: ${smoke}`);
    report.push({ id: row.id, acp: acpLine, healthMs, smoke });

    killTree(child);
    await new Promise((r) => setTimeout(r, 1_200));
    }

    console.log(`\n──────── Summary — ${model} ────────`);
    for (const r of report) {
      const acpShort = r.acp ? r.acp.replace(/^- ACP:\s*/, "") : "—";
      console.log(`${r.id.padEnd(28)} | health ${r.healthMs ?? "—"}ms | ${acpShort} | ${r.smoke}`);
    }
  }

  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
