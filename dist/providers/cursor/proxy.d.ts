export declare function healthCheckCursorProxy(baseUrl?: string): Promise<boolean>;
export interface EnsureProxyOptions {
    forceRestart?: boolean;
    projectRoot?: string;
}
/**
 * Auto-start the cursor-composer-in-claude as a detached background process.
 * Handles already-running, stale external listeners, version mismatch, and
 * per-project port resolution. Returns true when reachable.
 */
export declare function ensureCursorProxyRunning(baseUrl?: string, opts?: EnsureProxyOptions): Promise<boolean>;
/**
 * HTTP POST /v1/messages preflight — same end-to-end validation as a claude
 * CLI run without per-check CLI spawn overhead. Parallel-safe.
 */
export declare function preflightCursorProxyViaHttp(p: {
    baseURL?: string;
    model: string;
}, timeoutMs: number, opts?: {
    onProgress?: (msg: string) => void;
}): Promise<{
    ok: true;
} | {
    ok: false;
    error: string;
}>;
