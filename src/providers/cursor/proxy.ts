// Cursor proxy lifecycle: health check, start/restart, kill stale listeners, preflight.
import { mkdirSync, openSync, closeSync, existsSync, realpathSync, unlinkSync } from "fs";
import { tmpdir } from "node:os";
import { join, dirname } from "path";
import { execSync, spawn } from "child_process";
import chalk from "chalk";
import { VERSION } from "../../core/_version.js";
import { getProxyPort, buildProxyUrl } from "../../core/proxy-port.js";
import { loadProviders } from "../store.js";
import {
  PROXY_DEFAULT_URL,
  cursorProxyOutLogPath,
  cursorProxyFetchOpts,
  resolveAgentPaths,
  resolveCursorComposerCli,
  getEmbeddedComposerProxyVersion,
  resolveCursorAgentToken,
  resolveCursorProxyKey,
  ensureCursorAccountPool,
  warnMacCursorAgentShellPatchIfNeeded,
} from "./env.js";
import { cursorProxyRateLimiter, apiEndpointLimiter } from "../../core/rate-limiter.js";

// Shared rate limiter for all proxy HTTP calls (health checks, preflight, probes).
const _proxyRl = cursorProxyRateLimiter;

// ── Health check ──

interface ProxyHealth {
  /** /health responded ok. */
  ok: boolean;
  /** Version reported by /health JSON, if any. */
  version?: string;
  /** Verified to be cursor-composer-in-claude (either /health ok or /v1/models has a `data` array). */
  verified: boolean;
}

/**
 * Single round-trip probe: tries /health first, falls back to /v1/models shape check.
 * Returns flags so callers can choose between "is it healthy?", "what version?", and
 * "is it actually cursor-composer-in-claude vs. some other listener?" without re-fetching.
 */
async function probeProxyHealth(baseUrl = PROXY_DEFAULT_URL): Promise<ProxyHealth> {
  const url = baseUrl.replace(/\/$/, "");
  const fetchOpts = { method: "GET" as const, signal: AbortSignal.timeout(3_000), ...cursorProxyFetchOpts() };

  try {
    await _proxyRl.waitIfNeeded();
    const res = await fetch(`${url}/health`, fetchOpts);
    if (res.ok) {
      _proxyRl.record();
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; version?: string };
      return { ok: true, verified: true, version: typeof json.version === "string" ? json.version : undefined };
    }
  } catch {}

  try {
    await _proxyRl.waitIfNeeded();
    const res = await fetch(`${url}/v1/models`, fetchOpts);
    if (!res.ok) return { ok: false, verified: false };
    _proxyRl.record();
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: false, verified: Array.isArray(json["data"]) };
  } catch {
    return { ok: false, verified: false };
  }
}

export async function healthCheckCursorProxy(baseUrl = PROXY_DEFAULT_URL): Promise<boolean> {
  return (await probeProxyHealth(baseUrl)).ok;
}

/**
 * Kill whatever process is listening on the given port.
 * Uses TCP LISTEN only — plain `lsof -ti :PORT` also matches *clients*.
 */
function killProcessOnPort(port: number): number | null {
  try {
    const pid = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null`, {
      timeout: 5_000, encoding: "utf-8",
    }).trim().split("\n")[0];
    if (!pid || !/^\d+$/.test(pid)) return null;
    execSync(`kill -9 ${pid} 2>/dev/null`, { timeout: 5_000 });
    return parseInt(pid, 10);
  } catch {
    return null;
  }
}

async function isPortInUse(port: number, host = "127.0.0.1"): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok || res.status >= 400;
  } catch {
    return false;
  }
}

/**
 * If the listener can't be proven to be this install's bundled proxy, kill
 * it and start the bundled CLI.
 */
async function maybeRestartStaleProxy(baseUrl: string, url: URL, port: number): Promise<boolean> {
  const embedded = getEmbeddedComposerProxyVersion();
  const { version: runningV, ok: healthOk } = await probeProxyHealth(baseUrl);

  if (!embedded) {
    console.log(chalk.dim(JSON.stringify({
      claudeOvernight: VERSION,
      cursorComposerExpected: null,
      cursorComposerRunning: runningV ?? "unknown",
    })));
    return true;
  }

  if (runningV && runningV === embedded) {
    console.log(chalk.dim(JSON.stringify({
      claudeOvernight: VERSION,
      cursorComposerExpected: embedded,
      cursorComposerRunning: runningV,
    })));
    return true;
  }

  if (process.env.CURSOR_OVERNIGHT_ALLOW_EXTERNAL_PROXY === "1" && healthOk) {
    console.log(chalk.yellow(`  ⚠ External proxy detected (v${runningV ?? "unknown"}) on port ${port} — trusting it (CURSOR_OVERNIGHT_ALLOW_EXTERNAL_PROXY=1)`));
    return true;
  }

  if (process.env.CURSOR_OVERNIGHT_NO_PROXY_RESTART === "1" && healthOk && runningV) {
    console.log(chalk.yellow(`  ⚠ External proxy v${runningV} on port ${port} — skipping restart (CURSOR_OVERNIGHT_NO_PROXY_RESTART=1)`));
    return true;
  }

  const reason = !runningV
    ? `proxy does not report a version in /health — replacing with bundled v${embedded}`
    : `running proxy is v${runningV} but this install bundles cursor-composer-in-claude v${embedded}`;
  console.log(chalk.yellow(`  ⚠ ${reason} — restarting…`));
  killProcessOnPort(port);
  await new Promise(r => setTimeout(r, 500));
  return startProxyProcess(baseUrl, url, port);
}

export interface EnsureProxyOptions {
  forceRestart?: boolean;
  projectRoot?: string;
}

/**
 * Auto-start the cursor-composer-in-claude as a detached background process.
 * Handles already-running, stale external listeners, version mismatch, and
 * per-project port resolution. Returns true when reachable.
 */
export async function ensureCursorProxyRunning(baseUrl = PROXY_DEFAULT_URL, opts?: EnsureProxyOptions): Promise<boolean> {
  warnMacCursorAgentShellPatchIfNeeded();

  const resolvedPort: number | null = opts?.projectRoot && baseUrl === PROXY_DEFAULT_URL
    ? getProxyPort(opts.projectRoot)
    : null;
  const effectiveBaseUrl = resolvedPort != null ? buildProxyUrl(resolvedPort) : baseUrl;
  const url = new URL(effectiveBaseUrl);
  const port = resolvedPort ?? (parseInt(url.port, 10) || 80);
  const forceRestart = opts?.forceRestart ?? false;

  // When a token is available, replace unknown listeners by default so the bundled
  // proxy always inherits the token. Opt out: CURSOR_OVERNIGHT_NO_PROXY_RESTART=1.
  const token = resolveCursorAgentToken();
  const skipTokenRestart = process.env.CURSOR_OVERNIGHT_NO_PROXY_RESTART === "1";
  const effectiveForce = forceRestart || (!!token && !skipTokenRestart);

  if (effectiveForce && resolveCursorComposerCli()) {
    console.log(chalk.dim(`  Replacing listener on port ${port} with bundled cursor-composer-in-claude…`));
    killProcessOnPort(port);
    await new Promise(r => setTimeout(r, 500));
    return startProxyProcess(baseUrl, url, port);
  }

  const initial = await probeProxyHealth(baseUrl);
  if (initial.ok) return maybeRestartStaleProxy(baseUrl, url, port);

  if (await isPortInUse(port, url.hostname)) {
    if (initial.verified) {
      console.log(chalk.dim(`  Proxy verified at port ${port}`));
      return maybeRestartStaleProxy(baseUrl, url, port);
    }

    if (!forceRestart) {
      console.log(chalk.yellow(`  ⚠ Something is on port ${port} but it's not cursor-composer-in-claude — killing stale process…`));
    }
    const killedPid = killProcessOnPort(port);
    if (killedPid) {
      console.log(chalk.green(`  ✓ Killed stale process PID ${killedPid} on port ${port}`));
      await new Promise(r => setTimeout(r, 500));
      return startProxyProcess(baseUrl, url, port);
    }
    console.log(chalk.yellow(`  ⚠ Couldn't kill process on port ${port} — attempting to start proxy anyway…`));
    return startProxyProcess(baseUrl, url, port);
  }

  return startProxyProcess(baseUrl, url, port);
}

/** Spawn the proxy process and wait for it to become healthy. */
async function startProxyProcess(baseUrl: string, _url: URL, port: number): Promise<boolean> {
  console.log(chalk.yellow(`\n  Proxy not running at ${baseUrl} — starting it for you…`));

  const [sysNode, agentJs] = resolveAgentPaths(3_000);

  const apiKeyStored = loadProviders().find(p => p.cursorProxy)?.cursorApiKey;
  const agentToken = resolveCursorAgentToken();
  if (!agentToken) {
    console.log(chalk.red(
      `  ✗ Cursor proxy needs a User API key so the agent does not use macOS Keychain (\`cursor-user\`).\n` +
      `    Set ${chalk.bold("CURSOR_API_KEY")} (${chalk.dim("Cursor dashboard → Integrations / API Keys")}) ` +
      `or complete the ${chalk.bold("Cursor…")} setup in claude-overnight (saved to providers.json).\n` +
      `    See: ${chalk.dim("https://cursor.com/docs/cli/headless")}`,
    ));
    return false;
  }

  const bridgeKey =
    process.env.CURSOR_BRIDGE_API_KEY?.trim() ||
    apiKeyStored?.trim() ||
    agentToken;

  const keySource = process.env.CURSOR_BRIDGE_API_KEY?.trim()
    ? "env CURSOR_BRIDGE_API_KEY"
    : (apiKeyStored?.trim() ? "providers.json (stored)" : "mirrored from CURSOR_API_KEY / token");

  const proxyVersion = getEmbeddedComposerProxyVersion() ?? "unknown";

  const composerCli = resolveCursorComposerCli();
  if (!composerCli) {
    console.log(chalk.yellow(`  ⚠ cursor-composer-in-claude is not installed (missing from node_modules). Run: npm install`));
    return false;
  }
  let cliResolved: string;
  try {
    cliResolved = realpathSync(composerCli);
  } catch {
    cliResolved = composerCli;
  }

  const proxyEnv: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined)
    ) as Record<string, string>,
    CI: "true",
    CURSOR_BRIDGE_API_KEY: bridgeKey,
    CURSOR_SKIP_KEYCHAIN: "1",
    CURSOR_API_KEY: agentToken,
    CURSOR_AUTH_TOKEN: agentToken,
    // CLI streaming path (not ACP). ACP is broken for friendly thinking-variant
    // model names; cursor-composer's resolveAcpModelConfigValue only matches
    // base `claude-opus-4-7` etc., so `*-thinking-high` returns
    // `{error: "Invalid model value"}` which acp-client swallows to exit-1.
    // The CLI path accepts all friendly names.
    CURSOR_BRIDGE_USE_ACP: "0",
    // "agent" omits --mode so cursor-agent runs full agentic mode. --mode plan/ask
    // are strictly read-only — Write/Bash calls exit 0 with empty stdout.
    CURSOR_BRIDGE_MODE: "agent",
    // cursor-composer chat-only mode fakes HOME to a temp dir; on macOS the agent still
    // waits on Keychain for `cursor-user`. Use the real workspace profile.
    CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE: "false",
    // Broad base so per-request `X-Cursor-Workspace` headers (set from each
    // agent's cwd in swarm.ts) validate under the proxy's `resolveWorkspace`
    // check. Without this, proxied agents in worktrees all resolve to the
    // proxy's startup cwd.
    CURSOR_BRIDGE_WORKSPACE: "/",
    // Inbound rate limiting on the proxy protects against runaway requests.
    // Default: 20 req/min per IP — enough for 5+ parallel agents while still
    // guarding against abuse. Override via CURSOR_BRIDGE_RATE_LIMIT_MAX=0 to
    // disable, or set custom values.
    CURSOR_BRIDGE_RATE_LIMIT_MAX: process.env.CURSOR_BRIDGE_RATE_LIMIT_MAX ?? "20",
    CURSOR_BRIDGE_RATE_LIMIT_WINDOW_MS: process.env.CURSOR_BRIDGE_RATE_LIMIT_WINDOW_MS ?? "60000",
  };
  if (sysNode && agentJs) {
    proxyEnv.CURSOR_AGENT_NODE = sysNode;
    proxyEnv.CURSOR_AGENT_SCRIPT = agentJs;
  }

  const pool = ensureCursorAccountPool(5);
  if (pool && !proxyEnv.CURSOR_CONFIG_DIRS) {
    proxyEnv.CURSOR_CONFIG_DIRS = pool.join(",");
  }

  console.log(chalk.dim(JSON.stringify({
    claudeOvernight: VERSION,
    spawnProxy: {
      pkg: "cursor-composer-in-claude",
      version: proxyVersion,
      cliPath: cliResolved,
      nodeExec: process.execPath,
      apiKey: keySource,
      agentCursorKey: "set (CURSOR_API_KEY / bridge / stored)",
      agentPaths: sysNode && agentJs ? { node: sysNode, script: agentJs } : undefined,
      childEnv: {
        CI: proxyEnv.CI,
        CURSOR_SKIP_KEYCHAIN: proxyEnv.CURSOR_SKIP_KEYCHAIN,
        CURSOR_BRIDGE_MODE: proxyEnv.CURSOR_BRIDGE_MODE,
        CURSOR_BRIDGE_USE_ACP: proxyEnv.CURSOR_BRIDGE_USE_ACP,
        CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE: proxyEnv.CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE,
        CURSOR_API_KEY: "(set)",
        accountPool: proxyEnv.CURSOR_CONFIG_DIRS ? `${proxyEnv.CURSOR_CONFIG_DIRS.split(",").length} dirs` : "disabled",
      },
    },
  })));

  try {
    // Capture proxy stdout+stderr to a log file — stdio:"ignore" was hiding
    // agent stderr so "cursor_cli_error" responses had no actionable context.
    const logPath = cursorProxyOutLogPath();
    try { mkdirSync(dirname(logPath), { recursive: true }); } catch {}
    const logFd = openSync(logPath, "a");
    console.log(chalk.dim(`  Spawning proxy… ${chalk.dim(`(logs: ${logPath})`)}`));
    const child = spawn(process.execPath, [composerCli, "--port", String(port)], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: proxyEnv,
    });

    child.unref();
    closeSync(logFd);

    const HEALTH_POLL_MS = 500;
    const HEALTH_MAX_POLLS = 30;
    for (let i = 0; i < HEALTH_MAX_POLLS; i++) {
      await new Promise(r => setTimeout(r, HEALTH_POLL_MS));
      const elapsed = ((i + 1) * HEALTH_POLL_MS / 1000).toFixed(1);
      const { ok, verified } = await probeProxyHealth(baseUrl);
      if (ok && verified) {
        console.log(chalk.green(`  ✓ Proxy started (PID ${child.pid}) and healthy after ${elapsed}s`));
        return true;
      }
      if (ok) {
        console.log(chalk.yellow(`  ⚠ /health ok but /v1/models failed — agent subprocess broken, continuing to retry…`));
      }
      if ((i + 1) % 4 === 0) {
        process.stdout.write(chalk.dim(`  · still waiting… (${elapsed}s)\n`));
      }
    }

    console.log(chalk.yellow(`  ⚠ Proxy process spawned (PID ${child.pid}) but not responding after 15s`));
    console.log(chalk.dim(`  It may still be initializing. You can check with: curl ${baseUrl}/health`));
    return false;
  } catch (err: any) {
    console.log(chalk.yellow(`  ⚠ Failed to auto-start proxy: ${String(err?.message || err).slice(0, 100)}`));
    return false;
  }
}

// ── Preflight via HTTP (bypasses CLI spawn) ──

/**
 * HTTP POST /v1/messages preflight — same end-to-end validation as a claude
 * CLI run without per-check CLI spawn overhead. Parallel-safe.
 */
export async function preflightCursorProxyViaHttp(
  p: { baseURL?: string; model: string },
  timeoutMs: number,
  opts?: { onProgress?: (msg: string) => void },
): Promise<{ ok: true } | { ok: false; error: string }> {
  opts?.onProgress?.(`checking ${p.model} (proxy auth)…`);
  const baseURL = (p.baseURL || PROXY_DEFAULT_URL).replace(/\/$/, "");
  const key = resolveCursorProxyKey();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers["authorization"] = `Bearer ${key}`;

  const overallDeadlineAt = Date.now() + timeoutMs;
  const remaining = () => Math.max(1_000, overallDeadlineAt - Date.now());
  const authBudget = Math.max(5_000, Math.floor(timeoutMs / 2));

  const authErr = await postProxyMessages(baseURL, headers, p.model, "ok", authBudget, opts, "still waiting");
  if (authErr) return { ok: false, error: authErr };

  opts?.onProgress?.(`probing write capability…`);
  const probeErr = await probeCursorWriteCapability(baseURL, headers, p.model, remaining(), opts);
  if (probeErr) return { ok: false, error: probeErr };
  return { ok: true };
}

/** POST /v1/messages with shared rate-limiter waits, AbortController timeout, periodic onProgress. */
async function postProxyMessages(
  baseURL: string,
  headers: Record<string, string>,
  model: string,
  userContent: string,
  timeoutMs: number,
  opts: { onProgress?: (msg: string) => void } | undefined,
  progressLabel: string,
): Promise<string | null> {
  const controller = new AbortController();
  let elapsed = 0;
  const PROGRESS_INTERVAL_MS = 3_000;
  const progressTimer = setInterval(() => {
    elapsed += PROGRESS_INTERVAL_MS;
    opts?.onProgress?.(`${progressLabel}… (${(elapsed / 1000).toFixed(1)}s)`);
  }, PROGRESS_INTERVAL_MS);
  const deadline = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Wait out both window budgets — preflight runs auth+write back-to-back, so
    // hard-asserting here trips the 1s min interval on the second probe.
    await apiEndpointLimiter.waitIfNeeded();
    await _proxyRl.waitIfNeeded();
    // max_tokens must accommodate thinking tokens for `*-thinking-*` variants —
    // 1 leaves zero reasoning budget and crashes the subprocess.
    const res = await fetch(`${baseURL}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, max_tokens: 4096, messages: [{ role: "user", content: userContent }] }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return `HTTP ${res.status}: ${text.slice(0, 200)}`;
    }
    await res.text().catch(() => "");
    _proxyRl.record();
    apiEndpointLimiter.record();
    return null;
  } catch (err: any) {
    if (err?.name === "AbortError") return `timeout after ${Math.round(timeoutMs / 1000)}s`;
    return String(err?.message || err).slice(0, 200);
  } finally {
    clearTimeout(deadline);
    clearInterval(progressTimer);
  }
}

/**
 * Ask the proxy to create a unique marker file via its Bash tool; verify the
 * file appeared on disk. Catches `CURSOR_BRIDGE_MODE=plan|ask` regressions
 * where Write/Bash silently drop (exit 0, empty body).
 */
async function probeCursorWriteCapability(
  baseURL: string,
  headers: Record<string, string>,
  model: string,
  timeoutMs: number,
  opts?: { onProgress?: (msg: string) => void },
): Promise<string | null> {
  const marker = `co-probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const probeFile = join(tmpdir(), `${marker}.txt`);
  try { unlinkSync(probeFile); } catch {}
  const prompt =
    `Run this exact shell command via your Bash tool, then reply with only the word DONE:\n` +
    `printf 'ok' > ${probeFile}`;

  const err = await postProxyMessages(baseURL, headers, model, prompt, timeoutMs, opts, "write probe");
  if (err) return `write probe: ${err}`;

  if (!existsSync(probeFile)) {
    return (
      `write probe: cursor returned without creating the marker file. ` +
      `Most likely cause: CURSOR_BRIDGE_MODE=plan|ask (silent read-only mode). ` +
      `Upgrade cursor-composer-in-claude to ≥0.9.3 and set CURSOR_BRIDGE_MODE=agent (or unset).`
    );
  }
  try { unlinkSync(probeFile); } catch {}
  return null;
}
