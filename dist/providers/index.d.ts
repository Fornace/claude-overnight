import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
export { PROXY_DEFAULT_URL, isCursorProxyProvider, bundledComposerProxyShellCommand, readCursorProxyLogTail, warnMacCursorAgentShellPatchIfNeeded, hasCursorAgentToken, getCursorAgentToken, } from "./cursor-env.js";
export { healthCheckCursorProxy, ensureCursorProxyRunning } from "./cursor-proxy.js";
export type { EnsureProxyOptions } from "./cursor-proxy.js";
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
export interface ModelPick {
    model: string;
    providerId?: string;
    provider?: ProviderConfig;
}
export type EnvResolver = (model?: string) => Record<string, string> | undefined;
export declare function getStorePath(): string;
export declare function loadProviders(): ProviderConfig[];
export declare function saveProvider(p: ProviderConfig): void;
export declare function deleteProvider(id: string): void;
export declare function resolveKey(p: ProviderConfig): string | null;
/**
 * Build the env overrides for a custom provider. Returns a merged env
 * (including current process.env) because the SDK replaces, not merges, when
 * you pass `options.env`.
 */
export declare function envFor(p: ProviderConfig): Record<string, string>;
/**
 * Show a unified picker: Anthropic models, saved custom providers, Cursor,
 * and an "Other…" entry that walks the user through adding a new provider.
 */
export declare function pickModel(label: string, anthropicModels: ModelInfo[], currentModelId?: string): Promise<ModelPick>;
/**
 * Cheap auth check: 1-turn query against the provider, fail fast on misconfig.
 */
export declare function preflightProvider(p: ProviderConfig, cwd: string, timeoutMs?: number, opts?: {
    onProgress?: (msg: string) => void;
}): Promise<{
    ok: true;
} | {
    ok: false;
    error: string;
}>;
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
