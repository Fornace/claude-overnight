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
    private evict;
}
export declare function cursorProxyRateLimiter(): RateLimiter;
export declare function sdkQueryRateLimiter(): RateLimiter;
