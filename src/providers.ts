import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, realpathSync, readdirSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { execSync, spawn } from "child_process";
import chalk from "chalk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { ask, select, selectKey } from "./cli.js";
import { getBearerToken, clearTokenCache } from "./auth.js";
import { DEFAULT_MODEL } from "./models.js";
import {
  CURSOR_PRIORITY_MODELS,
  CURSOR_KNOWN_MODELS,
  KNOWN_CURSOR_MODEL_IDS,
  cursorModelHint,
} from "./cursor-models.js";

// ── Types ──

/**
 * A non-Anthropic model provider reachable via an Anthropic-compatible endpoint
 * (e.g. DashScope for Qwen, OpenRouter, a local proxy). Stored user-level so a
 * key configured once works across every repo.
 */
export interface ProviderConfig {
  id: string;
  displayName: string;
  baseURL: string;
  model: string;
  /** Env var name holding the key  -- preferred over inline `key` (nothing on disk). */
  keyEnv?: string;
  /** Inline API key. Stored plaintext in providers.json (mode 0600). */
  key?: string;
  /** When true, use JWT token auth instead of raw API keys. The bearer token is embedded in a short-lived JWT. */
  useJWT?: boolean;
  /** When true, this provider routes through cursor-api-proxy (special env/health-check handling). */
  cursorProxy?: boolean;
  /** API key for cursor-api-proxy. Stored in providers.json (0600), used as fallback when CURSOR_BRIDGE_API_KEY env is not set. */
  cursorApiKey?: string;
}

// ── Store ──

const STORE_PATH = join(homedir(), ".claude", "claude-overnight", "providers.json");

export function getStorePath(): string { return STORE_PATH; }

export function loadProviders(): ProviderConfig[] {
  try {
    const raw = readFileSync(STORE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.providers)) return parsed.providers.filter(isValidProvider);
  } catch {}
  return [];
}

export function saveProvider(p: ProviderConfig): void {
  const all = loadProviders().filter(x => x.id !== p.id);
  all.push(p);
  mkdirSync(join(homedir(), ".claude", "claude-overnight"), { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify({ providers: all }, null, 2), "utf-8");
  try { chmodSync(STORE_PATH, 0o600); } catch {}
  clearTokenCache();
}

export function deleteProvider(id: string): void {
  const all = loadProviders().filter(x => x.id !== id);
  if (!existsSync(STORE_PATH)) return;
  writeFileSync(STORE_PATH, JSON.stringify({ providers: all }, null, 2), "utf-8");
  try { chmodSync(STORE_PATH, 0o600); } catch {}
  clearTokenCache();
}

function isValidProvider(p: any): p is ProviderConfig {
  return p && typeof p.id === "string" && typeof p.baseURL === "string"
    && typeof p.model === "string" && typeof p.displayName === "string";
}

// ── Key resolution ──

export function resolveKey(p: ProviderConfig): string | null {
  if (p.keyEnv) {
    const v = process.env[p.keyEnv];
    return v && v.trim() ? v : null;
  }
  return p.key && p.key.trim() ? p.key : null;
}

/**
 * Build the env overrides for a custom provider. Returns a full merged env
 * (including current process.env) because the SDK replaces, not merges, when
 * you pass `options.env`.
 */
export function envFor(p: ProviderConfig): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) base[k] = v;

  if (p.cursorProxy) {
    base.ANTHROPIC_BASE_URL = p.baseURL;
    const key = process.env.CURSOR_BRIDGE_API_KEY || p.cursorApiKey;
    base.ANTHROPIC_AUTH_TOKEN = key || "unused";
    delete base.ANTHROPIC_API_KEY;
    return base;
  }

  const key = resolveKey(p);
  if (!key) throw new Error(`Provider "${p.id}" has no API key (${p.keyEnv ? `env ${p.keyEnv} is empty` : "inline key missing"})`);
  base.ANTHROPIC_BASE_URL = p.baseURL;

  if (p.useJWT) {
    base.ANTHROPIC_AUTH_TOKEN = getBearerToken(p.id, p.model, key, p.baseURL);
  } else {
    base.ANTHROPIC_AUTH_TOKEN = key;
  }

  delete base.ANTHROPIC_API_KEY;
  return base;
}

// ── Picker UI ──

type PickerItem = { kind: "anthropic"; model: ModelInfo } | { kind: "provider"; provider: ProviderConfig } | { kind: "cursor" } | { kind: "other" };

export interface ModelPick {
  model: string;
  providerId?: string;
  provider?: ProviderConfig;
}

/**
 * Show a unified picker: Anthropic models (from SDK), saved custom providers,
 * and an "Other…" entry that walks the user through adding a new provider.
 * Returns the selected model string and, if it's a custom provider, the id.
 */
export async function pickModel(
  label: string,
  anthropicModels: ModelInfo[],
  currentModelId?: string,
): Promise<ModelPick> {
  for (;;) {
    const saved = loadProviders();
    const items: Array<{ name: string; value: PickerItem; hint?: string }> = [];
    for (const m of anthropicModels) {
      items.push({ name: m.displayName, value: { kind: "anthropic", model: m }, hint: m.description });
    }
    // Network-failed fallback: ensure the picker always has at least one Anthropic
    // entry so the user isn't trapped if they cancel the Other… form.
    if (anthropicModels.length === 0) {
      items.push({
        name: DEFAULT_MODEL,
        value: { kind: "anthropic", model: { value: DEFAULT_MODEL, displayName: DEFAULT_MODEL, description: "default (model list unavailable)" } as ModelInfo },
        hint: "default  -- Anthropic model list unavailable",
      });
    }
    for (const p of saved) {
      const keySrc = p.keyEnv ? `env ${p.keyEnv}` : "stored key";
      const cursorTag = p.cursorProxy ? chalk.dim(" · cursor") : "";
      items.push({ name: `${p.displayName}${cursorTag}`, value: { kind: "provider", provider: p }, hint: `${p.model} · ${keySrc}` });
    }
    items.push({ name: chalk.green("Cursor…"), value: { kind: "cursor" }, hint: "Cursor API Proxy — composer, composer-2, auto, etc." });
    items.push({ name: chalk.cyan("Other…"), value: { kind: "other" }, hint: "Qwen 3.6 Plus, OpenRouter, or any Anthropic-compatible endpoint" });

    let defaultIdx = 0;
    if (currentModelId) {
      const i = items.findIndex(it => {
        if (it.value.kind === "anthropic") return it.value.model.value === currentModelId;
        if (it.value.kind === "provider") return it.value.provider.id === currentModelId || it.value.provider.model === currentModelId;
        return false;
      });
      if (i >= 0) defaultIdx = i;
    }

    const picked = await select(label, items, defaultIdx);
    if (picked.kind === "anthropic") return { model: picked.model.value };
    if (picked.kind === "provider") {
      return { model: picked.provider.model, providerId: picked.provider.id, provider: picked.provider };
    }
    if (picked.kind === "cursor") {
      const cursorPick = await pickCursorModel();
      if (cursorPick) return cursorPick;
      // user cancelled cursor picker — loop back
      continue;
    }
    const added = await promptNewProvider();
    if (added) {
      saveProvider(added);
      return { model: added.model, providerId: added.id, provider: added };
    }
    // user cancelled "Other…"  -- loop back to picker
  }
}

async function promptNewProvider(): Promise<ProviderConfig | null> {
  console.log(chalk.dim("\n  Add a custom provider (Anthropic-compatible endpoint)"));
  console.log(chalk.dim("  Leave blank to cancel.\n"));

  const displayName = await ask(`  ${chalk.cyan("Name")} ${chalk.dim("(e.g. 'Qwen Coder'):")} `);
  if (!displayName) return null;
  const id = slugify(displayName);

  const baseURLRaw = await ask(`\n  ${chalk.cyan("Base URL")} ${chalk.dim("(e.g. https://dashscope-intl.aliyuncs.com/apps/anthropic for Qwen 3.6 Plus):")} `);
  if (!baseURLRaw) return null;
  const baseURL = normalizeBaseURL(baseURLRaw);

  const model = await ask(`\n  ${chalk.cyan("Model id")} ${chalk.dim("(e.g. qwen3.6-plus):")} `);
  if (!model) return null;

  const keyMode = await select(`  ${chalk.cyan("API key source")}:`, [
    { name: "Paste key now", value: "inline", hint: "stored plaintext in ~/.claude/claude-overnight/providers.json (0600)" },
    { name: "Read from env var", value: "env", hint: "nothing written to disk" },
  ]);

  if (keyMode === "env") {
    const envName = await ask(`\n  ${chalk.cyan("Env var name")} ${chalk.dim(`(e.g. CO_KEY_${id.toUpperCase()}):`)} `);
    if (!envName) return null;
    if (!process.env[envName]) {
      console.log(chalk.yellow(`\n  ⚠ ${envName} is not set in the current shell  -- you'll need to export it before running.`));
    }
    const useJWT = await select(`  ${chalk.cyan("Auth method")}:`, [
      { name: "JWT tokens", value: "jwt", hint: "short-lived tokens, raw keys never passed to agents" },
      { name: "Raw API key", value: "raw", hint: "key sent directly with every request" },
    ]);
    return { id, displayName, baseURL, model, keyEnv: envName, useJWT: useJWT === "jwt" };
  }

  const key = await ask(`\n  ${chalk.cyan("API key")}: `);
  if (!key) return null;
  const useJWT = await select(`  ${chalk.cyan("Auth method")}:`, [
    { name: "JWT tokens", value: "jwt", hint: "short-lived tokens, raw keys never passed to agents" },
    { name: "Raw API key", value: "raw", hint: "key sent directly with every request" },
  ]);
  return { id, displayName, baseURL, model, key, useJWT: useJWT === "jwt" };
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "provider";
}

/** Strip trailing slashes and common endpoint suffixes users paste by mistake. */
function normalizeBaseURL(raw: string): string {
  let url = raw.trim().replace(/\/+$/, "");
  url = url.replace(/\/v1\/messages$/i, "").replace(/\/messages$/i, "");
  return url;
}

// ── Pre-flight validation ──

/**
 * Cheap auth check: spawn a 1-turn query against the provider and fail fast
 * if the key is wrong or the endpoint is unreachable. Timeout is aggressive
 * so misconfig doesn't delay the main run.
 */
export async function preflightProvider(p: ProviderConfig, cwd: string, timeoutMs = 20_000): Promise<{ ok: true } | { ok: false; error: string }> {
  let env: Record<string, string>;
  try { env = envFor(p); } catch (err: any) { return { ok: false, error: err.message }; }

  let pq: ReturnType<typeof query> | undefined;
  try {
    pq = query({
      prompt: "Reply with exactly the word ok and nothing else.",
      options: {
        cwd,
        model: p.model,
        env,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 1,
        persistSession: false,
      },
    });
    const stream = pq;
    const consume = (async (): Promise<{ ok: true } | { ok: false; error: string }> => {
      for await (const msg of stream) {
        if (msg.type === "result") {
          if ((msg as any).subtype !== "success") {
            return { ok: false, error: String((msg as any).result || (msg as any).subtype || "unknown error").slice(0, 200) };
          }
          return { ok: true };
        }
      }
      return { ok: false, error: "no result received" };
    })();
    const timeout = new Promise<{ ok: false; error: string }>((resolve) => {
      setTimeout(() => {
        try { stream.interrupt().catch(() => stream.close()); } catch {}
        resolve({ ok: false, error: `timeout after ${Math.round(timeoutMs / 1000)}s` });
      }, timeoutMs);
    });
    return await Promise.race([consume, timeout]);
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err).slice(0, 200) };
  } finally {
    try { pq?.close(); } catch {}
  }
}

// ── Cursor API Proxy ──

export const PROXY_DEFAULT_URL = "http://127.0.0.1:8765";

/** Check if a provider routes through cursor-api-proxy. */
export function isCursorProxyProvider(p: ProviderConfig): boolean {
  return p.cursorProxy === true || p.baseURL === PROXY_DEFAULT_URL;
}

/** Resolve the cursor-api-proxy API key from env or providers.json. */
function resolveCursorProxyKey(): string | null {
  if (process.env.CURSOR_BRIDGE_API_KEY?.trim()) return process.env.CURSOR_BRIDGE_API_KEY.trim();
  const saved = loadProviders().find(p => p.cursorProxy);
  if (saved?.cursorApiKey?.trim()) return saved.cursorApiKey.trim();
  return null;
}

/** Build fetch options with the cursor proxy auth header if a key is available. */
function cursorProxyFetchOpts(): RequestInit {
  const key = resolveCursorProxyKey();
  return key ? { headers: { Authorization: `Bearer ${key}` } } : {};
}

/**
 * Health check: GET /health on the proxy. Returns true if proxy is reachable.
 * Passes the stored API key so the /health endpoint doesn't return 401.
 */
export async function healthCheckCursorProxy(baseUrl = PROXY_DEFAULT_URL): Promise<boolean> {
  const url = `${baseUrl.replace(/\/$/, "")}/health`;
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(3_000), ...cursorProxyFetchOpts() });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Fetch available Cursor models via GET /v1/models on the proxy.
 * Returns model IDs like ["auto", "composer", "composer-2", "opus-4.6", ...].
 */
export async function fetchCursorModels(baseUrl = PROXY_DEFAULT_URL): Promise<string[]> {
  const url = `${baseUrl.replace(/\/$/, "")}/v1/models`;
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(5_000), ...cursorProxyFetchOpts() });
    if (!res.ok) return [];
    const json = await res.json() as { data?: Array<{ id: string; name?: string }> };
    return (json.data || []).map(m => m.id).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Try to fetch live Cursor model IDs. Falls back to an empty array — the
 * caller merges with known constants, so the picker always has content.
 *
 * NOTE: `agent --list-models` segfaults with its bundled Node.js binary
 * (exit 139). We work around this by running with the system `node` instead.
 */
async function fetchLiveCursorModels(): Promise<string[]> {
  // Try the proxy first (works when the bundled node doesn't crash)
  const proxyModels = await fetchCursorModels();
  if (proxyModels.length > 0) return proxyModels;

  // Fallback: run the cursor-agent CLI with system node
  // Find the agent binary via command -v (alias-safe), then locate its index.js.
  try {
    // command -v handles symlinks and doesn't expand shell aliases
    const agentPath = execSync("command -v agent 2>/dev/null || command -v cursor-agent 2>/dev/null", {
      timeout: 3_000, encoding: "utf-8", shell: "bash",
    }).trim();
    if (!agentPath) return [];

    // Resolve the directory (realpathSync handles symlinks like agent → cursor-agent)
    const dir = dirname(realpathSync(agentPath));
    // The bundled index.js lives in the same directory as the agent script
    const indexPath = `${dir}/index.js`;
    const raw = execSync(`node "${indexPath}" --list-models 2>/dev/null`, {
      timeout: 10_000, encoding: "utf-8",
    });
    // Strip ANSI escape codes (cursor uses \x1B[2K\r etc.)
    const out = raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
    // Parse lines like "composer-2-fast - Composer 2 Fast"
    const ids: string[] = [];
    for (const line of out.split("\n")) {
      const match = line.match(/^([A-Za-z0-9][A-Za-z0-9._:/-]*)\s+-\s+/);
      if (match) ids.push(match[1]);
    }
    return ids;
  } catch {}

  return [];
}

/**
 * Verify something is actually cursor-api-proxy (not just any HTTP service on the port).
 * Tries /health first (proxy identity), then falls back to /v1/models shape check.
 * Returns true if it looks like the proxy.
 */
async function verifyCursorProxy(baseUrl = PROXY_DEFAULT_URL): Promise<boolean> {
  const url = baseUrl.replace(/\/$/, "");
  const opts = cursorProxyFetchOpts();
  // /health is the most reliable proxy identity check — works even when
  // /v1/models fails due to agent subprocess crash (macOS segfault).
  try {
    const res = await fetch(`${url}/health`, { method: "GET", signal: AbortSignal.timeout(3_000), ...opts });
    if (res.ok) return true;
  } catch {}
  // Fallback: check /v1/models response shape
  try {
    const res = await fetch(`${url}/v1/models`, { method: "GET", signal: AbortSignal.timeout(3_000), ...opts });
    if (!res.ok) return false;
    const json = await res.json() as any;
    return Array.isArray(json?.data);
  } catch {
    return false;
  }
}

/**
 * Kill whatever process is bound to the given port. Uses `lsof` on macOS /
 * `fuser` on Linux. Returns the PID that was killed, or null if nothing found
 * or permission denied.
 */
function killProcessOnPort(port: number, host = "127.0.0.1"): number | null {
  try {
    // macOS / BSD: lsof -ti :PORT gives just the PID
    const pid = execSync(`lsof -ti :${port} 2>/dev/null`, {
      timeout: 5_000, encoding: "utf-8",
    }).trim().split("\n")[0];
    if (!pid || !/^\d+$/.test(pid)) return null;
    execSync(`kill -9 ${pid} 2>/dev/null`, { timeout: 5_000 });
    return parseInt(pid, 10);
  } catch {
    return null;
  }
}

/**
 * Check whether something is already listening on the proxy port.
 * Returns true if any process bound the port (another instance, Cursor CLI, etc.).
 */
async function isPortInUse(port: number, host = "127.0.0.1"): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok || res.status >= 400; // any response means something is listening
  } catch {
    return false;
  }
}

/**
 * Find the system `node` binary path. Uses `which` to bypass any bundled node.
 */
function resolveSystemNode(): string | null {
  try {
    return execSync("which node 2>/dev/null", {
      timeout: 3_000, encoding: "utf-8", shell: "bash",
    }).trim() || null;
  } catch { return null; }
}

/**
 * Find the cursor-agent's index.js. Mirrors the logic in fetchLiveCursorModels:
 * resolves the `agent` symlink to find the version directory containing index.js.
 */
function resolveAgentIndexJs(): string | null {
  try {
    const agentPath = execSync("command -v agent 2>/dev/null || command -v cursor-agent 2>/dev/null", {
      timeout: 3_000, encoding: "utf-8", shell: "bash",
    }).trim();
    if (!agentPath) return null;
    const dir = dirname(realpathSync(agentPath));
    const indexPath = `${dir}/index.js`;
    return existsSync(indexPath) ? indexPath : null;
  } catch { return null; }
}

/**
 * Patch the proxy's env.js to use CURSOR_AGENT_NODE + CURSOR_AGENT_SCRIPT on Unix.
 *
 * The proxy already reads these env vars (lines 152-153 of env.js) but only uses
 * them on Windows in resolveAgentCommand(). We inject a Unix code path before the
 * final `return { command: cmd, args, env }` so that when these vars are set,
 * the proxy spawns system node with the agent script instead of the bundled node
 * (which segfaults with --list-models on macOS).
 *
 * Safe to call repeatedly — the patch is idempotent.
 */
function patchProxyEnvJs(proxyDir: string): boolean {
  const envJs = join(proxyDir, "dist", "lib", "env.js");
  if (!existsSync(envJs)) return false;
  const src = readFileSync(envJs, "utf-8");

  // Check if already patched
  if (src.includes("/* claude-overnight patch */")) return true;

  const patch = `\n/* claude-overnight patch: use CURSOR_AGENT_NODE+SCRIPT on unix */\n` +
    `if (platform !== "win32" && loaded.agentNode && loaded.agentScript) {\n` +
    `  return { command: loaded.agentNode, args: [loaded.agentScript, ...args], env: { ...env, CURSOR_INVOKED_AS: "agent" }, agentScriptPath: loaded.agentScript };\n` +
    `}`;

  // Insert before the final return in resolveAgentCommand
  const target = "    return { command: cmd, args, env };\n}";
  if (!src.includes(target)) {
    // Try minified variant
    const target2 = "return{command:cmd,args,env}}";
    if (!src.includes(target2)) return false;
    writeFileSync(envJs, src.replace(target2, patch + "\n" + target2), "utf-8");
  } else {
    writeFileSync(envJs, src.replace(target, patch + "\n" + target), "utf-8");
  }
  return true;
}

/**
 * Patch the proxy's token-cache.js to skip the macOS keychain read.
 *
 * The proxy calls `security find-generic-password -s "cursor-access-token" -w`
 * after every agent run to cache tokens for its multi-account pool feature.
 * This triggers a macOS keychain popup even though the key is not needed for
 * auth (the cursor-agent subprocess handles its own auth). We neutralize it.
 *
 * Safe to call repeatedly — the patch is idempotent.
 */
function patchProxyTokenCacheJs(proxyDir: string): boolean {
  const tcJs = join(proxyDir, "dist", "lib", "token-cache.js");
  if (!existsSync(tcJs)) return false;
  const src = readFileSync(tcJs, "utf-8");

  // Check if already patched
  if (src.includes("/* claude-overnight patch: skip keychain */")) return true;

  const patch = `\n/* claude-overnight patch: skip keychain */\n` +
    `return undefined;`;

  // Replace the entire execSync chain inside readKeychainToken (multi-line)
  const target = `const t = execSync('security find-generic-password -s "cursor-access-token" -w', { stdio: ["pipe", "pipe", "pipe"], timeout: 5000 })
            .toString()
            .trim();`;
  if (!src.includes(target)) return false;
  writeFileSync(tcJs, src.replace(target, patch + "\n// " + target.replace(/\n/g, "\n// ")), "utf-8");
  return true;
}

/**
 * Find the cursor-api-proxy package directory (npx cache or global install).
 */
function findProxyPackageDir(): string | null {
  try {
    // Try npx cache first
    const npmCacheRoot = join(homedir(), ".npm", "_npx");
    if (existsSync(npmCacheRoot)) {
      const dirs = readdirSync(npmCacheRoot);
      for (const d of dirs) {
        const candidate = join(npmCacheRoot, d, "node_modules", "cursor-api-proxy");
        if (existsSync(join(candidate, "dist", "lib", "env.js"))) return candidate;
      }
    }
  } catch {}
  // Try global install
  try {
    const globalDir = execSync("npm root -g 2>/dev/null", {
      timeout: 5_000, encoding: "utf-8", shell: "bash",
    }).trim();
    if (globalDir && existsSync(join(globalDir, "cursor-api-proxy", "dist", "lib", "env.js"))) {
      return join(globalDir, "cursor-api-proxy");
    }
  } catch {}
  return null;
}

/**
 * Auto-start the cursor-api-proxy as a detached background process.
 *
 * When the proxy is started, we also configure it to use system Node.js
 * for spawning the cursor-agent subprocess. The agent's bundled Node.js
 * segfaults with --list-models on macOS (exit 139), so we resolve the
 * system `node` binary and the agent's index.js, patch the proxy's env.js
 * to respect CURSOR_AGENT_NODE/SCRIPT on Unix, and pass those env vars.
 *
 * Handles:
 *  - Proxy already running and verified → returns true immediately
 *  - Something on the port but not our proxy → warns, skips spawn
 *  - Port in use by nothing responsive → returns true (something bound it)
 *  - Proxy not running → spawns `npx cursor-api-proxy` detached, waits for health
 *  - Spawn fails (not installed) → returns false, caller falls back to manual instructions
 *
 * When `forceRestart` is true and a stale process is on the port, it will be
 * killed and the proxy restarted.
 *
 * Returns true when the proxy is reachable at PROXY_DEFAULT_URL.
 */
export async function ensureCursorProxyRunning(baseUrl = PROXY_DEFAULT_URL, forceRestart = false): Promise<boolean> {
  const url = new URL(baseUrl);
  const port = parseInt(url.port, 10) || 80;

  // Always patch the npx cache on startup so proxy skips keychain reads.
  // Idempotent — safe to call on every run.
  const proxyDir = findProxyPackageDir();
  if (proxyDir) patchProxyTokenCacheJs(proxyDir);

  // Already healthy?
  if (await healthCheckCursorProxy(baseUrl)) {
    // Proxy was running before the patch — restart it to load the patched token-cache.js.
    console.log(chalk.dim(`  Proxy already running — restarting to pick up keychain patch…`));
    const killedPid = killProcessOnPort(port, url.hostname);
    if (killedPid) {
      await new Promise(r => setTimeout(r, 500));
      return startProxyProcess(baseUrl, url, port);
    }
    return true;
  }

  // Something bound the port — verify it's actually the cursor proxy
  if (await isPortInUse(port, url.hostname)) {
    const isProxy = await verifyCursorProxy(baseUrl);
    if (isProxy) {
      console.log(chalk.dim(`  Proxy verified at port ${port}`));
      return true;
    }

    // Stale process on the port — kill it if forceRestart, or try automatically
    if (!forceRestart) {
      console.log(chalk.yellow(`  ⚠ Something is on port ${port} but it's not cursor-api-proxy — killing stale process…`));
    }
    const killedPid = killProcessOnPort(port, url.hostname);
    if (killedPid) {
      console.log(chalk.green(`  ✓ Killed stale process PID ${killedPid} on port ${port}`));
      await new Promise(r => setTimeout(r, 500));
      return startProxyProcess(baseUrl, url, port);
    }
    // Couldn't kill (permission denied, already gone) — try starting anyway
    console.log(chalk.yellow(`  ⚠ Couldn't kill process on port ${port} — attempting to start proxy anyway…`));
    return startProxyProcess(baseUrl, url, port);
  }

  // Port is free — auto-start the proxy
  return startProxyProcess(baseUrl, url, port);
}

/** Spawn the proxy process and wait for it to become healthy. */
async function startProxyProcess(baseUrl: string, url: URL, port: number): Promise<boolean> {
  console.log(chalk.yellow(`\n  Proxy not running at ${baseUrl} — starting it for you…`));

  // Resolve system node and agent index.js so the proxy doesn't use the
  // agent's bundled node (segfaults with --list-models on macOS).
  const sysNode = resolveSystemNode();
  const agentJs = resolveAgentIndexJs();
  let patchedProxy = false;
  if (sysNode && agentJs) {
    const proxyDir = findProxyPackageDir();
    if (proxyDir) {
      patchedProxy = patchProxyEnvJs(proxyDir);
      if (patchedProxy) {
        console.log(chalk.dim(`  Using system node for agent subprocess: ${sysNode}`));
      } else {
        console.log(chalk.yellow(`  ⚠ Couldn't patch proxy env.js — /v1/models may fail`));
      }
    }
  }

  const proxyEnv: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined)
    ) as Record<string, string>,
    CURSOR_BRIDGE_API_KEY: process.env.CURSOR_BRIDGE_API_KEY
      || loadProviders().find(p => p.cursorProxy)?.cursorApiKey
      || "unused",
  };
  if (patchedProxy && sysNode && agentJs) {
    proxyEnv.CURSOR_AGENT_NODE = sysNode;
    proxyEnv.CURSOR_AGENT_SCRIPT = agentJs;
  }

  try {
    const child = spawn("npx", ["cursor-api-proxy"], {
      detached: true,
      stdio: "ignore",
      env: proxyEnv,
    });

    child.unref(); // let it outlive this process

    // Wait up to 15s for the proxy to become healthy
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (await healthCheckCursorProxy(baseUrl)) {
        console.log(chalk.green(`  ✓ Proxy started (PID ${child.pid}) and healthy`));
        return true;
      }
    }

    console.log(chalk.yellow(`  ⚠ Proxy process spawned but not responding after 15s`));
    console.log(chalk.dim(`  It may still be initializing. You can check with: curl ${baseUrl}/health`));
    return false;
  } catch (err: any) {
    console.log(chalk.yellow(`  ⚠ Failed to auto-start proxy: ${String(err?.message || err).slice(0, 100)}`));
    return false;
  }
}

// ── Cursor Proxy Setup Guide ──

interface SetupStep {
  label: string;
  check: () => boolean;
  autoCmd: string;
  manualCmd: string;
  successMsg: string;
}

function setupSteps(): SetupStep[] {
  return [
    {
      label: "Cursor agent CLI",
      check: () => {
        try { execSync("which agent", { stdio: "pipe" }); return true; } catch { return false; }
      },
      autoCmd: "curl https://cursor.com/install -fsS | bash",
      manualCmd: "curl https://cursor.com/install -fsS | bash",
      successMsg: "Cursor CLI found",
    },
    {
      label: "Cursor API key",
      check: () => {
        const key = process.env.CURSOR_BRIDGE_API_KEY;
        return !!key && key.trim().length > 0;
      },
      autoCmd: "",
      manualCmd: "",
      successMsg: "Cursor API key configured",
    },
    {
      label: "cursor-api-proxy server",
      check: () => {
        try { execSync("npx cursor-api-proxy --help", { stdio: "pipe", timeout: 10_000 }); return true; } catch { return false; }
      },
      autoCmd: "npx cursor-api-proxy",
      manualCmd: "npx cursor-api-proxy",
      successMsg: "cursor-api-proxy available",
    },
  ];
}

const CURSOR_KEY_PROVIDER_ID = "cursor";

/** Persist the Cursor API key into providers.json. Updates any existing cursor proxy provider,
 * or creates a sentinel entry so the key survives across sessions. */
function saveCursorApiKey(key: string): void {
  const existing = loadProviders().filter(p => p.cursorProxy);
  if (existing.length > 0) {
    const p = existing[0];
    p.cursorApiKey = key;
    saveProvider(p);
  } else {
    const sentinel: ProviderConfig = {
      id: CURSOR_KEY_PROVIDER_ID,
      displayName: "Cursor (API key)",
      baseURL: PROXY_DEFAULT_URL,
      model: "auto",
      cursorProxy: true,
      cursorApiKey: key,
    };
    saveProvider(sentinel);
  }
}

/** Prompt the user for a Cursor API key and persist it. Returns true if saved. */
async function promptAndSaveCursorKey(): Promise<boolean> {
  console.log(chalk.dim(`  Get your API key from https://cursor.com/dashboard/integrations`));
  console.log(chalk.dim(`  (Scroll to the "API Keys" section at the bottom of the page)\n`));
  const key = await ask(`  ${chalk.cyan("API key")}: `);
  if (key && key.trim()) {
    const trimmed = key.trim();
    process.env.CURSOR_BRIDGE_API_KEY = trimmed;
    saveCursorApiKey(trimmed);
    return true;
  }
  console.log(chalk.yellow("  No key provided — skipped"));
  return false;
}

/**
 * Full install + configure flow for cursor-api-proxy.
 * Walks through CLI install, API key config, and proxy start.
 * Only needed when the quick auto-start (`ensureCursorProxyRunning`) fails —
 * e.g. npx can't find the package or the user has no API key yet.
 * Returns true when proxy is running and healthy.
 */
export async function setupCursorProxy(): Promise<boolean> {
  console.log(chalk.dim("\n  Configure cursor-api-proxy"));
  console.log(chalk.dim("  " + "─".repeat(40)));
  console.log(chalk.dim("  We need three things: Cursor CLI, an API key, and the proxy server.\n"));

  const steps = setupSteps();

  // ── Step 1: Cursor CLI ──
  const cliStep = steps[0];
  if (cliStep.check()) {
    console.log(chalk.green(`  ✓ ${cliStep.successMsg}`));
  } else {
    console.log(chalk.yellow(`\n  ${cliStep.label} not found`));
    const choice = await selectKey(`  Install ${cliStep.label}?`, [
      { key: "a", desc: "uto (run command)" },
      { key: "m", desc: "anual (show command)" },
      { key: "s", desc: "kip (I'll handle it)" },
    ]);
    if (choice === "a") {
      console.log(chalk.dim(`  Running: ${cliStep.autoCmd}`));
      try {
        execSync(cliStep.autoCmd, { stdio: "inherit", timeout: 60_000 });
        console.log(chalk.green(`  ✓ ${cliStep.successMsg}`));
      } catch {
        console.log(chalk.yellow("  Command failed — try manual mode"));
      }
    } else if (choice === "m") {
      console.log(chalk.cyan(`\n  Run this command:`));
      console.log(chalk.white(`    ${cliStep.manualCmd}\n`));
    } else {
      console.log(chalk.dim(`  Skipped: ${cliStep.label}`));
    }
  }

  // ── Step 2: API key ──
  const keyStep = steps[1];
  if (keyStep.check()) {
    console.log(chalk.green(`  ✓ ${keyStep.successMsg}`));
  } else {
    console.log(chalk.yellow(`\n  ${keyStep.label} not configured`));
    console.log(chalk.cyan(`  1. Open: https://cursor.com/dashboard/integrations`));
    console.log(chalk.cyan(`  2. Scroll to "API Keys" at the bottom of the page`));
    console.log(chalk.cyan(`  3. Copy your API key and paste it below\n`));
    if (await promptAndSaveCursorKey()) {
      console.log(chalk.green(`  ✓ ${keyStep.successMsg}`));
    } else {
      console.log(chalk.yellow("  No API key — the proxy won't authenticate without one."));
    }
  }

  // ── Step 3: Proxy server — auto-start if needed ──
  const proxyStep = steps[2];
  if (proxyStep.check()) {
    console.log(chalk.green(`  ✓ ${proxyStep.successMsg}`));
  } else {
    console.log(chalk.yellow(`\n  ${proxyStep.label} not installed`));
    const choice = await selectKey(`  Install and start it?`, [
      { key: "a", desc: "uto (install + start)" },
      { key: "m", desc: "anual (show commands)" },
      { key: "s", desc: "kip (I'll handle it)" },
    ]);
    if (choice === "a") {
      console.log(chalk.dim(`  Checking install…`));
      try {
        execSync("npx cursor-api-proxy --help", { stdio: "pipe", timeout: 15_000 });
        console.log(chalk.green(`  ✓ cursor-api-proxy is installed`));
      } catch {
        console.log(chalk.dim(`  Installing…`));
        try {
          execSync("npm install -g cursor-api-proxy", { stdio: "inherit", timeout: 120_000 });
          console.log(chalk.green(`  ✓ Installed`));
        } catch {
          console.log(chalk.yellow("  Install failed — try manual: npm install -g cursor-api-proxy"));
          return false;
        }
      }
    } else if (choice === "m") {
      console.log(chalk.cyan(`\n  Install:  ${chalk.bold("npm install -g cursor-api-proxy")}`));
      console.log(chalk.cyan(`  Start:    ${chalk.bold("npx cursor-api-proxy")}\n`));
      const ok = await selectKey(`  Started it?`, [
        { key: "r", desc: "eady" },
        { key: "c", desc: "ancel" },
      ]);
      if (ok === "c") return false;
    } else {
      console.log(chalk.dim(`  Skipped: ${proxyStep.label}`));
      return false;
    }
  }

  // Auto-start the proxy (detached background process)
  if (await ensureCursorProxyRunning()) return true;

  // Auto-start failed or not responding — offer manual fallback
  console.log(chalk.yellow(`\n  Couldn't start the proxy automatically. Start it manually:`));
  console.log(chalk.white(`    ${chalk.bold("npx cursor-api-proxy")}`));
  for (;;) {
    const choice = await selectKey(`  Proxy started?`, [
      { key: "r", desc: "etry (re-attempt auto-start + kill stale)" },
      { key: "c", desc: "ancel" },
    ]);
    if (choice === "r") {
      if (await ensureCursorProxyRunning(PROXY_DEFAULT_URL, true)) {
        console.log(chalk.green("\n  ✓ Proxy is running and healthy"));
        return true;
      }
      console.log(chalk.yellow(`  Still not reachable at ${PROXY_DEFAULT_URL}`));
    } else {
      return false;
    }
  }
}

// ── Cursor model picker sub-flow ──

interface CursorPickerItem {
  id: string;
  name: string;
  hint: string;
}

/**
 * Build the full list of cursor model picker items. Priority models go first,
 * then known models, then any extra live models we fetched. If there are more
 * than a handful extras, they get a "more..." sub-menu.
 */
async function buildCursorPicker(): Promise<{ top: CursorPickerItem[]; more: CursorPickerItem[] }> {
  const liveIds = await fetchLiveCursorModels();
  const extra = new Set<string>();
  for (const id of liveIds) {
    if (!KNOWN_CURSOR_MODEL_IDS.has(id)) extra.add(id);
  }

  const top: CursorPickerItem[] = [
    ...CURSOR_PRIORITY_MODELS.map(m => ({ id: m.id, name: m.label, hint: m.hint })),
    ...CURSOR_KNOWN_MODELS.map(m => ({ id: m.id, name: m.label, hint: m.hint })),
  ];

  // Only a few extras? show them inline. Otherwise defer to "more...".
  const MORE_THRESHOLD = 6;
  const more: CursorPickerItem[] = [...extra].sort().map(id => ({
    id,
    name: id,
    hint: cursorModelHint(id),
  }));

  if (more.length <= MORE_THRESHOLD) {
    return { top: [...top, ...more], more: [] };
  }
  return { top, more };
}

async function pickCursorModel(): Promise<ModelPick | null> {
  console.log(chalk.dim("\n  Cursor API Proxy Models"));
  console.log(chalk.dim("  " + "─".repeat(40)));

  // Quick health check with spinner
  let frame = 0;
  const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const spinner = setInterval(() => {
    process.stdout.write(`\x1B[2K\r  ${chalk.cyan(BRAILLE[frame++ % BRAILLE.length])} ${chalk.dim("checking proxy...")}`);
  }, 120);
  const healthy = await healthCheckCursorProxy();
  clearInterval(spinner);
  process.stdout.write("\x1B[2K\r");

  if (!healthy) {
    // Try to auto-start the proxy (auto-kills stale processes)
    const autoStarted = await ensureCursorProxyRunning();
    if (autoStarted) {
      // Proxy is up now — proceed to model list
    } else {
      console.log(chalk.yellow("  Proxy is not running at " + PROXY_DEFAULT_URL));
      for (;;) {
        const choice = await selectKey(`  How to proceed?`, [
          { key: "r", desc: "etry (re-attempt auto-start + kill stale)" },
          { key: "i", desc: "nstall + configure (CLI, API key, server)" },
          { key: "c", desc: "ancel" },
        ]);
        if (choice === "r") {
          if (await ensureCursorProxyRunning(PROXY_DEFAULT_URL, true)) {
            console.log(chalk.green("  ✓ Proxy started"));
            break;
          }
          console.log(chalk.yellow(`  Still not reachable at ${PROXY_DEFAULT_URL}`));
        } else if (choice === "i") {
          const ok = await setupCursorProxy();
          if (!ok) return null;
          if (await healthCheckCursorProxy()) break;
          return null;
        } else {
          return null;
        }
      }
    }
  }

  const { top, more } = await buildCursorPicker();

  // If there are more models available, add a "more…" entry
  const items: Array<{ name: string; value: string; hint?: string }> = top.map(m => ({
    name: m.name,
    value: m.id,
    hint: m.hint,
  }));

  let hasMore = more.length > 0;
  if (hasMore) {
    items.push({ name: chalk.gray("more…"), value: "__more__", hint: `${more.length} additional models` });
  }

  const picked = await select("  Select a Cursor model:", items, 0);

  // Handle "more…" sub-menu
  if (picked === "__more__") {
    const moreItems = more.map(m => ({ name: m.name, value: m.id, hint: m.hint }));
    const morePicked = await select("  More Cursor models:", moreItems, 0);
    return saveCursorPick(morePicked);
  }

  return saveCursorPick(picked);
}

function saveCursorPick(modelId: string): ModelPick {
  const existingKey = loadProviders().find(p => p.id === CURSOR_KEY_PROVIDER_ID)?.cursorApiKey;
  const provider: ProviderConfig = {
    id: `cursor-${modelId}`,
    displayName: `Cursor: ${modelId}`,
    baseURL: PROXY_DEFAULT_URL,
    model: modelId,
    cursorProxy: true,
    ...(existingKey ? { cursorApiKey: existingKey } : {}),
  };
  saveProvider(provider);
  console.log(chalk.green(`  ✓ Saved as provider: ${provider.displayName}`));
  return { model: modelId, providerId: provider.id, provider };
}

// ── Env resolver for planner/executor roles ──

export type EnvResolver = (model?: string) => Record<string, string> | undefined;

/**
 * Build a single resolver that swarm.ts and planner-query.ts share. Maps a
 * model string to the env overrides that should be passed to `query()`.
 * Returns undefined for Anthropic-native models (let the SDK use process.env).
 */
export function buildEnvResolver(opts: {
  plannerModel: string;
  plannerProvider?: ProviderConfig;
  workerModel: string;
  workerProvider?: ProviderConfig;
  fastModel?: string;
  fastProvider?: ProviderConfig;
}): EnvResolver {
  const byModel = new Map<string, ProviderConfig>();
  if (opts.plannerProvider) byModel.set(opts.plannerModel, opts.plannerProvider);
  if (opts.workerProvider) byModel.set(opts.workerModel, opts.workerProvider);
  if (opts.fastProvider && opts.fastModel) byModel.set(opts.fastModel, opts.fastProvider);
  if (byModel.size === 0) return () => undefined;
  return (model) => {
    if (!model) return undefined;
    const p = byModel.get(model);
    return p ? envFor(p) : undefined;
  };
}
