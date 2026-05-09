import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderConfig } from "./store.js";
export type { ProviderConfig } from "./store.js";
export { loadProviders, saveProvider, deleteProvider, getStorePath, } from "./store.js";
export { PROXY_DEFAULT_URL, isCursorProxyProvider, bundledComposerProxyShellCommand, readCursorProxyLogTail, warnMacCursorAgentShellPatchIfNeeded, hasCursorAgentToken, getCursorAgentToken, healthCheckCursorProxy, ensureCursorProxyRunning, } from "./cursor/index.js";
export type { EnsureProxyOptions } from "./cursor/index.js";
export interface ModelPick {
    model: string;
    providerId?: string;
    provider?: ProviderConfig;
}
export type EnvResolver = (model?: string) => Record<string, string> | undefined;
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
