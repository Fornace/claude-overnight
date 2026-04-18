// Sliding-window rate limiter for outbound API calls.
// Prevents hammering the Anthropic API / Cursor proxy by enforcing a minimum
// interval between requests and tracking recent request volume.

export interface RateLimiterConfig {
  maxRequests: number;
  windowMs: number;
  minIntervalMs?: number;
}

export class RateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly minIntervalMs: number;
  private readonly timestamps: number[] = [];
  private lastRequestAt = 0;

  constructor(config: RateLimiterConfig) {
    this.maxRequests = config.maxRequests;
    this.windowMs = config.windowMs;
    this.minIntervalMs = config.minIntervalMs ?? Math.floor(config.windowMs / config.maxRequests);
  }

  record(): void {
    const now = Date.now();
    this.timestamps.push(now);
    this.lastRequestAt = now;
    this.evict();
  }

  get currentCount(): number {
    this.evict();
    return this.timestamps.length;
  }

  canRequest(): boolean {
    this.evict();
    return this.timestamps.length < this.maxRequests
      && (Date.now() - this.lastRequestAt) >= this.minIntervalMs;
  }

  async waitIfNeeded(): Promise<number> {
    const waited = this.waitMs();
    if (waited > 0) await new Promise(r => setTimeout(r, waited));
    return waited;
  }

  waitMs(): number {
    this.evict();
    const volumeWait = this.timestamps.length >= this.maxRequests
      ? this.timestamps[0] + this.windowMs - Date.now()
      : 0;
    const intervalWait = Math.max(0, this.minIntervalMs - (Date.now() - this.lastRequestAt));
    return Math.max(volumeWait, intervalWait, 0);
  }

  reset(): void {
    this.timestamps.length = 0;
    this.lastRequestAt = 0;
  }

  private evict(): void {
    const cutoff = Date.now() - this.windowMs;
    let i = 0;
    while (i < this.timestamps.length && this.timestamps[i] < cutoff) i++;
    if (i > 0) this.timestamps.splice(0, i);
  }
}

export function cursorProxyRateLimiter(): RateLimiter {
  return new RateLimiter({ maxRequests: 4, windowMs: 10_000 });
}

export function sdkQueryRateLimiter(): RateLimiter {
  return new RateLimiter({ maxRequests: 2, windowMs: 5_000 });
}
