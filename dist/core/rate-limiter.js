// Sliding-window rate limiter for outbound API calls.
// Prevents hammering the Anthropic API / Cursor proxy by enforcing a minimum
// interval between requests and tracking recent request volume.
export class RateLimiter {
    maxRequests;
    windowMs;
    minIntervalMs;
    timestamps = [];
    lastRequestAt = 0;
    constructor(config) {
        this.maxRequests = config.maxRequests;
        this.windowMs = config.windowMs;
        this.minIntervalMs = config.minIntervalMs ?? Math.floor(config.windowMs / config.maxRequests);
    }
    record() {
        const now = Date.now();
        this.timestamps.push(now);
        this.lastRequestAt = now;
        this.evict();
    }
    get currentCount() {
        this.evict();
        return this.timestamps.length;
    }
    canRequest() {
        this.evict();
        return this.timestamps.length < this.maxRequests
            && (Date.now() - this.lastRequestAt) >= this.minIntervalMs;
    }
    async waitIfNeeded() {
        const waited = this.waitMs();
        if (waited > 0)
            await new Promise(r => setTimeout(r, waited));
        return waited;
    }
    waitMs() {
        this.evict();
        const volumeWait = this.timestamps.length >= this.maxRequests
            ? this.timestamps[0] + this.windowMs - Date.now()
            : 0;
        const intervalWait = Math.max(0, this.minIntervalMs - (Date.now() - this.lastRequestAt));
        return Math.max(volumeWait, intervalWait, 0);
    }
    reset() {
        this.timestamps.length = 0;
        this.lastRequestAt = 0;
    }
    evict() {
        const cutoff = Date.now() - this.windowMs;
        let i = 0;
        while (i < this.timestamps.length && this.timestamps[i] < cutoff)
            i++;
        if (i > 0)
            this.timestamps.splice(0, i);
    }
}
export function cursorProxyRateLimiter() {
    return new RateLimiter({ maxRequests: 4, windowMs: 10_000 });
}
export function sdkQueryRateLimiter() {
    return new RateLimiter({ maxRequests: 2, windowMs: 5_000 });
}
