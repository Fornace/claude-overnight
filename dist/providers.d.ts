import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
/**
 * Shell command to run the same bundled proxy CLI we spawn in-process (never `npx`/global).
 */
export declare function bundledComposerProxyShellCommand(): string | null;
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
    /** When true, this provider routes through cursor-composer-in-claude (special env/health-check handling). */
    cursorProxy?: boolean;
    /** API key for cursor-composer-in-claude. Stored in providers.json (0600), used as fallback when CURSOR_BRIDGE_API_KEY env is not set. */
    cursorApiKey?: string;
}
export declare function getStorePath(): string;
export declare function loadProviders(): ProviderConfig[];
export declare function saveProvider(p: ProviderConfig): void;
export declare function deleteProvider(id: string): void;
export declare function resolveKey(p: ProviderConfig): string | null;
/**
 * Build the env overrides for a custom provider. Returns a full merged env
 * (including current process.env) because the SDK replaces, not merges, when
 * you pass `options.env`.
 */
export declare function envFor(p: ProviderConfig): Record<string, string>;
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
export declare function pickModel(label: string, anthropicModels: ModelInfo[], currentModelId?: string): Promise<ModelPick>;
/**
 * Cheap auth check: spawn a 1-turn query against the provider and fail fast
 * if the key is wrong or the endpoint is unreachable. Timeout is aggressive
 * so misconfig doesn't delay the main run.
 */
export declare function preflightProvider(p: ProviderConfig, cwd: string, timeoutMs?: number, opts?: {
    onProgress?: (msg: string) => void;
}): Promise<{
    ok: true;
} | {
    ok: false;
    error: string;
}>;
export declare const PROXY_DEFAULT_URL = "http://127.0.0.1:8765";
/** Check if a provider routes through cursor-composer-in-claude. */
export declare function isCursorProxyProvider(p: ProviderConfig): boolean;
/** True if ~/.zshrc / ~/.zprofile contain the `run_cursor_agent` workaround (see README). */
export declare function hasCursorMacAgentZshPatch(): boolean;
/**
 * On macOS, if the Cursor `agent` / `cursor-agent` CLI is installed but the zsh
 * workaround is missing, print once. See README: macOS Cursor agent shell patch.
 */
export declare function warnMacCursorAgentShellPatchIfNeeded(): void;
/** True when a User API key (or bridge key) is available for Cursor agent + proxy. */
export declare function hasCursorAgentToken(): boolean;
/** Resolved token for tests/diagnostics (never log the return value). */
export declare function getCursorAgentToken(): string | null;
/**
 * Health check: GET /health on the proxy. Returns true if proxy is reachable.
 * Passes the stored API key so the /health endpoint doesn't return 401.
 */
export declare function healthCheckCursorProxy(baseUrl?: string): Promise<boolean>;
/**
 * Fetch available Cursor models via GET /v1/models on the proxy.
 * Returns model IDs like ["auto", "composer", "composer-2", "opus-4.6", ...].
 */
export declare function fetchCursorModels(baseUrl?: string): Promise<string[]>;
/**
 * Auto-start the cursor-composer-in-claude as a detached background process.
 *
 * Passes CURSOR_AGENT_NODE/SCRIPT so the fork uses system Node.js for the
 * agent subprocess (avoids segfaults with --list-models on macOS).
 *
 * Handles:
 *  - Proxy already running and verified → returns true immediately
 *  - Something on the port but not our proxy → warns, kills, restarts
 *  - Proxy not running → spawns detached, waits for health
 *  - Spawn fails → returns false, caller falls back to manual instructions
 *
 * When `forceRestart` is true, any listener on the port is killed and the
 * bundled proxy is spawned (same as a version mismatch).
 *
 * Returns true when the proxy is reachable at PROXY_DEFAULT_URL.
 */
export declare function ensureCursorProxyRunning(baseUrl?: string, forceRestart?: boolean): Promise<boolean>;
/**
 * Full install + configure flow for cursor-composer-in-claude.
 * Walks through CLI install, API key config, and proxy start.
 * Only needed when the quick auto-start (`ensureCursorProxyRunning`) fails —
 * e.g. dependencies not installed or the user has no API key yet.
 * Returns true when proxy is running and healthy.
 */
export declare function setupCursorProxy(): Promise<boolean>;
export type EnvResolver = (model?: string) => Record<string, string> | undefined;
/**
 * Build a single resolver that swarm.ts and planner-query.ts share. Maps a
 * model string to the env overrides that should be passed to `query()`.
 * Returns undefined for Anthropic-native models (let the SDK use process.env).
 */
export declare function buildEnvResolver(opts: {
    plannerModel: string;
    plannerProvider?: ProviderConfig;
    workerModel: string;
    workerProvider?: ProviderConfig;
    fastModel?: string;
    fastProvider?: ProviderConfig;
}): EnvResolver;
