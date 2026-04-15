import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import chalk from "chalk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { ask, select, selectKey } from "./cli.js";
import { getBearerToken, clearTokenCache } from "./auth.js";

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
    // cursor-api-proxy: routes through local proxy, no real API key needed
    base.ANTHROPIC_BASE_URL = p.baseURL;
    base.ANTHROPIC_AUTH_TOKEN = process.env.CURSOR_BRIDGE_API_KEY || "unused";
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
        name: "claude-sonnet-4-6",
        value: { kind: "anthropic", model: { value: "claude-sonnet-4-6", displayName: "claude-sonnet-4-6", description: "default (model list unavailable)" } as ModelInfo },
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

/**
 * Health check: GET /health on the proxy. Returns true if proxy is reachable.
 */
export async function healthCheckCursorProxy(baseUrl = PROXY_DEFAULT_URL): Promise<boolean> {
  const url = `${baseUrl.replace(/\/$/, "")}/health`;
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(3_000) });
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
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return [];
    const json = await res.json() as { data?: Array<{ id: string; name?: string }> };
    return (json.data || []).map(m => m.id).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Known Cursor model recommendations — short hints to guide users.
 */
const CURSOR_MODEL_HINTS: Record<string, string> = {
  "auto": "fast — delegates to best available model",
  "composer": "Cursor Composer — good for focused tasks",
  "composer-2": "Cursor Composer 2 — latest, strongest Cursor model",
};

function cursorModelHint(modelId: string): string {
  const m = modelId.toLowerCase();
  if (CURSOR_MODEL_HINTS[m]) return CURSOR_MODEL_HINTS[m];
  if (m.includes("opus")) return "Opus-tier Cursor model";
  if (m.includes("sonnet")) return "Sonnet-tier Cursor model";
  if (m.includes("haiku")) return "Haiku-tier Cursor model (fast)";
  return "Cursor model";
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
      label: "Cursor authentication",
      check: () => {
        try {
          const out = execSync("agent --list-models", { stdio: "pipe", timeout: 10_000 });
          return out.toString().trim().length > 0;
        } catch { return false; }
      },
      autoCmd: "agent login",
      manualCmd: "agent login",
      successMsg: "Cursor authenticated",
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

/**
 * Interactive setup guide for cursor-api-proxy.
 * Walks through CLI install, login, and proxy start.
 * Returns true when proxy is running and healthy.
 */
export async function setupCursorProxy(): Promise<boolean> {
  console.log(chalk.dim("\n  Cursor API Proxy Setup"));
  console.log(chalk.dim("  " + "─".repeat(40)));
  console.log(chalk.dim("  We need three things: Cursor CLI, authentication, and the proxy server.\n"));

  const steps = setupSteps();

  for (const step of steps) {
    if (step.check()) {
      console.log(chalk.green(`  ✓ ${step.successMsg}`));
      continue;
    }

    console.log(chalk.yellow(`\n  ${step.label} not found`));
    const choice = await selectKey(`  Set up ${step.label}:`, [
      { key: "a", desc: "uto (run command)" },
      { key: "m", desc: "anual (show command)" },
      { key: "s", desc: "kip (I'll handle it)" },
    ]);

    if (choice === "a") {
      if (step.label === "Cursor authentication") {
        // agent login needs interactive browser — run it directly
        console.log(chalk.dim(`  Running: ${step.autoCmd}`));
        console.log(chalk.dim("  (A browser window will open for login)\n"));
        try {
          execSync(step.autoCmd, { stdio: "inherit", timeout: 120_000 });
          console.log(chalk.green(`  ✓ ${step.successMsg}`));
        } catch {
          console.log(chalk.yellow("  Login failed — try manual mode"));
          // Fall through to manual display
        }
      } else if (step.label === "cursor-api-proxy server") {
        // Don't auto-start the proxy server here — it blocks. Just verify it's installable.
        console.log(chalk.dim(`  Install check: ${step.autoCmd} --help`));
        try {
          execSync("npx cursor-api-proxy --help", { stdio: "pipe", timeout: 30_000 });
          console.log(chalk.green(`  ✓ cursor-api-proxy installed`));
          console.log(chalk.yellow(`  → Start it in another terminal: ${chalk.bold("npx cursor-api-proxy")}`));
          const ready = await selectKey(`  Is the proxy running now?`, [
            { key: "y", desc: "es" },
            { key: "n", desc: "ot yet" },
          ]);
          if (ready === "y") {
            if (await healthCheckCursorProxy()) {
              console.log(chalk.green(`  ✓ Proxy connected`));
              return true;
            }
          }
        } catch {
          console.log(chalk.red("  cursor-api-proxy not installed. Install with: npm install -g cursor-api-proxy"));
        }
      } else {
        console.log(chalk.dim(`  Running: ${step.autoCmd}`));
        try {
          execSync(step.autoCmd, { stdio: "inherit", timeout: 60_000 });
          console.log(chalk.green(`  ✓ ${step.successMsg}`));
        } catch {
          console.log(chalk.yellow("  Command failed — try manual mode"));
        }
      }
    } else if (choice === "m") {
      console.log(chalk.cyan(`\n  Run this command:`));
      console.log(chalk.white(`    ${step.manualCmd}`));
      if (step.label === "cursor-api-proxy server") {
        console.log(chalk.yellow(`    Then start the proxy: ${chalk.bold("npx cursor-api-proxy")}`));
      }
      console.log();
      const done = await selectKey(`  Done?`, [
        { key: "y", desc: "es" },
        { key: "n", desc: "ot yet" },
      ]);
      if (done === "y" && step.label === "cursor-api-proxy server") {
        if (await healthCheckCursorProxy()) {
          console.log(chalk.green(`  ✓ Proxy connected`));
          return true;
        }
      }
    } else {
      console.log(chalk.dim(`  Skipped: ${step.label}`));
    }
  }

  // Final health check
  if (await healthCheckCursorProxy()) {
    console.log(chalk.green("\n  ✓ Proxy is running and healthy"));
    return true;
  }
  console.log(chalk.yellow("\n  Proxy not reachable yet. You can start it later and add it via 'Cursor' in the model picker."));
  return false;
}

// ── Cursor model picker sub-flow ──

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
    console.log(chalk.yellow("  Proxy is not running at " + PROXY_DEFAULT_URL));
    const choice = await selectKey(`  What next?`, [
      { key: "s", desc: "etup guide" },
      { key: "r", desc: "etry" },
      { key: "c", desc: "ancel" },
    ]);
    if (choice === "s") {
      const ok = await setupCursorProxy();
      if (!ok) return null;
    } else if (choice === "r") {
      return pickCursorModel();
    } else {
      return null;
    }
  }

  // Fetch live models
  const modelIds = await fetchCursorModels();
  if (modelIds.length === 0) {
    console.log(chalk.yellow("  No models returned from proxy"));
    return null;
  }

  const picked = await select("  Select a Cursor model:", modelIds.map(id => ({
    name: id,
    value: id,
    hint: cursorModelHint(id),
  })), 0);

  // Save as a cursor proxy provider
  const provider: ProviderConfig = {
    id: `cursor-${picked}`,
    displayName: `Cursor: ${picked}`,
    baseURL: PROXY_DEFAULT_URL,
    model: picked,
    cursorProxy: true,
  };
  saveProvider(provider);
  console.log(chalk.green(`  ✓ Saved as provider: ${provider.displayName}`));

  return { model: picked, providerId: provider.id, provider };
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
