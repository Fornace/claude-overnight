// Provider registry: types + persistence (~/.claude/claude-overnight/providers.json).
// Kept separate from env-building/picker so the store can be mocked in tests.
import { existsSync, chmodSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { clearTokenCache } from "../core/auth.js";
import { readJsonOrNull, writeJson } from "../core/fs-helpers.js";

/**
 * A non-Anthropic model provider reachable via an Anthropic-compatible endpoint
 * (e.g. DashScope for Qwen, OpenRouter, a local proxy). Stored user-level.
 */
export interface ProviderConfig {
  id: string;
  displayName: string;
  baseURL: string;
  model: string;
  /** Env var name holding the key — preferred over inline `key` (nothing on disk). */
  keyEnv?: string;
  /** Inline API key. Stored plaintext in providers.json (mode 0600). */
  key?: string;
  /** When true, use JWT token auth instead of raw API keys. */
  useJWT?: boolean;
  /** When true, this provider routes through cursor-composer-in-claude. */
  cursorProxy?: boolean;
  /** API key for cursor-composer-in-claude (fallback when CURSOR_BRIDGE_API_KEY unset). */
  cursorApiKey?: string;
}

const STORE_PATH = join(homedir(), ".claude", "claude-overnight", "providers.json");

export function getStorePath(): string { return STORE_PATH; }

export function loadProviders(): ProviderConfig[] {
  const parsed = readJsonOrNull<{ providers?: unknown[] }>(STORE_PATH);
  return Array.isArray(parsed?.providers) ? parsed.providers.filter(isValidProvider) : [];
}

export function saveProvider(p: ProviderConfig): void {
  writeStore(loadProviders().filter(x => x.id !== p.id).concat(p));
}

export function deleteProvider(id: string): void {
  if (!existsSync(STORE_PATH)) return;
  writeStore(loadProviders().filter(x => x.id !== id));
}

function writeStore(providers: ProviderConfig[]): void {
  writeJson(STORE_PATH, { providers });
  try { chmodSync(STORE_PATH, 0o600); } catch {}
  clearTokenCache();
}

function isValidProvider(p: any): p is ProviderConfig {
  return p && typeof p.id === "string" && typeof p.baseURL === "string"
    && typeof p.model === "string" && typeof p.displayName === "string";
}
