import type { ProviderConfig } from "../store.js";
export declare const PROXY_DEFAULT_URL = "http://127.0.0.1:8765";
/** Resolve system Node.js and agent index.js paths. Returns [nodePath, scriptPath] or [null, null]. */
export declare function resolveAgentPaths(timeoutMs?: number): [string | null, string | null];
/** Cache the resolved paths for use inside envFor. */
export declare function cachedAgentPaths(): [string | null, string | null];
/** Run the installed package CLI with `node` (avoids npx/npm invoking extra tooling on macOS). */
export declare function resolveCursorComposerCli(): string | null;
/** Version from the dependency bundled with claude-overnight (not `npx` cache). */
export declare function getEmbeddedComposerProxyVersion(): string | null;
/** Directory containing this package's `package.json` (works for global and local installs). */
export declare function getClaudeOvernightInstallRoot(): string;
/** Shell command to run the same bundled proxy CLI we spawn in-process (never `npx`/global). */
export declare function bundledComposerProxyShellCommand(): string | null;
/** Check if a provider routes through cursor-composer-in-claude. */
export declare function isCursorProxyProvider(p: ProviderConfig): boolean;
export declare function cursorProxyOutLogPath(): string;
export declare function cursorProxySessionsLogPath(): string;
/** Read the tail of both proxy logs for diagnostics. */
export declare function readCursorProxyLogTail(linesPerFile?: number): string | null;
/** Resolve the cursor-composer-in-claude API key from env or providers.json. */
export declare function resolveCursorProxyKey(): string | null;
/**
 * Token for the native Cursor `agent` binary — same order as cursor-composer `loadBridgeConfig`
 * (CURSOR_API_KEY → CURSOR_AUTH_TOKEN → bridge / stored).
 */
export declare function resolveCursorAgentToken(): string | null;
export declare function hasCursorAgentToken(): boolean;
/** Resolved token for tests/diagnostics (never log the return value). */
export declare function getCursorAgentToken(): string | null;
/** Build fetch options with the cursor proxy auth header if a key is available. */
export declare function cursorProxyFetchOpts(): RequestInit;
/**
 * Ensure an "account pool" of cloned config dirs exists under
 * `~/.cursor-api-proxy/accounts/pool-{1..N}`. Each clone is a copy of the
 * user's `~/.cursor/cli-config.json`. Gives each spawned agent its own
 * CURSOR_CONFIG_DIR so parallel cli-config.json writes don't race.
 */
export declare function ensureCursorAccountPool(poolSize?: number): string[] | null;
/** True if ~/.zshrc / ~/.zprofile contain the `run_cursor_agent` workaround. */
export declare function hasCursorMacAgentZshPatch(): boolean;
/** On macOS, warn once if the Cursor agent CLI is installed but the zsh workaround is missing. */
export declare function warnMacCursorAgentShellPatchIfNeeded(): void;
/** Fetch available Cursor models via GET /v1/models on the proxy. */
export declare function fetchCursorModels(baseUrl?: string): Promise<string[]>;
/**
 * Try to fetch live Cursor model IDs. Falls back to empty array — the caller
 * merges with known constants.
 *
 * NOTE: `agent --list-models` segfaults with its bundled Node.js binary
 * (exit 139). Run with system `node` instead.
 */
export declare function fetchLiveCursorModels(): Promise<string[]>;
