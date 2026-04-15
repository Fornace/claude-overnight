import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import chalk from "chalk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { ask, select } from "./cli.js";

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
}

export function deleteProvider(id: string): void {
  const all = loadProviders().filter(x => x.id !== id);
  if (!existsSync(STORE_PATH)) return;
  writeFileSync(STORE_PATH, JSON.stringify({ providers: all }, null, 2), "utf-8");
  try { chmodSync(STORE_PATH, 0o600); } catch {}
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
  const key = resolveKey(p);
  if (!key) throw new Error(`Provider "${p.id}" has no API key (${p.keyEnv ? `env ${p.keyEnv} is empty` : "inline key missing"})`);
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) base[k] = v;
  base.ANTHROPIC_BASE_URL = p.baseURL;
  base.ANTHROPIC_AUTH_TOKEN = key;
  delete base.ANTHROPIC_API_KEY;
  return base;
}

// ── Picker UI ──

type PickerItem = { kind: "anthropic"; model: ModelInfo } | { kind: "provider"; provider: ProviderConfig } | { kind: "other" };

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
      items.push({ name: `${p.displayName}`, value: { kind: "provider", provider: p }, hint: `${p.model} · ${keySrc}` });
    }
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
    return { id, displayName, baseURL, model, keyEnv: envName };
  }

  const key = await ask(`\n  ${chalk.cyan("API key")}: `);
  if (!key) return null;
  return { id, displayName, baseURL, model, key };
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
