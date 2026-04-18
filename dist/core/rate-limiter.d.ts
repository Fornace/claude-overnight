/** Thrown when an API call hits the hard rate-limit gate. Callers should
 *  catch this and trigger their standard retry/backoff flow. */
export declare class RateLimitError extends Error {
    constructor(message?: string);
}
export interface RateLimiterConfig {
    maxRequests: number;
    windowMs: number;
    minIntervalMs?: number;
}
export declare class RateLimiter {
    private readonly maxRequests;
    private readonly windowMs;
    private readonly minIntervalMs;
    private readonly timestamps;
    private lastRequestAt;
    constructor(config: RateLimiterConfig);
    record(): void;
    get currentCount(): number;
    canRequest(): boolean;
    waitIfNeeded(): Promise<number>;
    waitMs(): number;
    reset(): void;
    /** Hard gate: throws RateLimitError if the window is full. Unlike
     *  `waitIfNeeded()` which blocks, this fails fast so callers can trigger
     *  their retry/backoff flow. */
    assertCanRequest(): void;
    private evict;
}
/** Shared rate limiter for SDK query calls — enforced globally across all workers. */
export declare const sdkQueryRateLimiter: RateLimiter;
/** Shared rate limiter for Cursor proxy direct fetches — enforced globally. */
export declare const cursorProxyRateLimiter: RateLimiter;
/** Shared rate limiter for direct API endpoint calls — guards against rapid
 *  bursts across all HTTP-based API paths (preflight, probes, health checks). */
export declare const apiEndpointLimiter: RateLimiter;
/** Reset all rate limiter state (useful for testing or manual recovery). */
export declare function resetAllRateLimiters(): void;
