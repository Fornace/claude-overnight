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
export declare function getStorePath(): string;
export declare function loadProviders(): ProviderConfig[];
export declare function saveProvider(p: ProviderConfig): void;
export declare function deleteProvider(id: string): void;
