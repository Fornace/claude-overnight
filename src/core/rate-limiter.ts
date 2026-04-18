// Sliding-window rate limiter for outbound API calls.
// Prevents hammering the Anthropic API / Cursor proxy by enforcing a minimum
// interval between requests and tracking recent request volume.
//
// Shared singleton instances are exported so concurrent workers enforce
// a single global limit rather than each having their own independent window.

/** Thrown when an API call hits the hard rate-limit gate. Callers should
 *  catch this and trigger their standard retry/backoff flow. */
export class RateLimitError extends Error {
  constructor(message = "rate limit exceeded") {
    super(message);
    this.name = "RateLimitError";
  }
}

export interface RateLimiterConfig {
  maxRequests: number;
  windowMs: number;
  minIntervalMs?: number;
}

export interface AcquireOptions {
  /** When true, skip sliding-window / min-interval waits (caller still records after the request). */
  skipWhen?: () => boolean;
  /** Invoked once when `skipWhen()` returned true and the throttle was bypassed. */
  onBypass?: () => void;
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

  /** Wait until a request slot is available. Optional `skipWhen` bypasses the throttle entirely. */
  async acquire(options?: AcquireOptions): Promise<number> {
    if (options?.skipWhen?.()) {
      options.onBypass?.();
      return 0;
    }
    const waited = this.waitMs();
    if (waited > 0) await new Promise(r => setTimeout(r, waited));
    return waited;
  }

  async waitIfNeeded(): Promise<number> {
    return this.acquire();
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

  /** Hard gate: throws RateLimitError if the window is full. Unlike
   *  `waitIfNeeded()` which blocks, this fails fast so callers can trigger
   *  their retry/backoff flow. */
  assertCanRequest(): void {
    this.evict();
    if (this.timestamps.length >= this.maxRequests) {
      const resetMs = this.timestamps[0] + this.windowMs - Date.now();
      throw new RateLimitError(`rate limit: ${this.timestamps.length}/${this.maxRequests} in window, resets in ${Math.ceil(resetMs / 1000)}s`);
    }
    if ((Date.now() - this.lastRequestAt) < this.minIntervalMs) {
      throw new RateLimitError(`rate limit: min interval not elapsed`);
    }
  }

  private evict(): void {
    const cutoff = Date.now() - this.windowMs;
    let i = 0;
    while (i < this.timestamps.length && this.timestamps[i] < cutoff) i++;
    if (i > 0) this.timestamps.splice(0, i);
  }
}

// ── Shared singleton instances ──
// All callers share the same instance so concurrent workers enforce a
// single global rate limit rather than multiplying the allowed rate.

const _sdkQueryLimiter = new RateLimiter({ maxRequests: 2, windowMs: 5_000 });
const _cursorProxyLimiter = new RateLimiter({ maxRequests: 4, windowMs: 10_000 });
const _apiEndpointLimiter = new RateLimiter({ maxRequests: 6, windowMs: 15_000, minIntervalMs: 1_000 });

/** Shared rate limiter for SDK query calls — enforced globally across all workers. */
export const sdkQueryRateLimiter: RateLimiter = _sdkQueryLimiter;

/** Acquire SDK query slot. Skips the SDK sliding-window limiter when `CURSOR_PROXY_URL` is set (proxy has its own limiters). */
export async function acquireSdkQueryRateLimit(): Promise<number> {
  return _sdkQueryLimiter.acquire({
    skipWhen: () => !!process.env.CURSOR_PROXY_URL,
    onBypass: () => {
      console.log("[rate-limiter] Skipping SDK rate limit (Cursor proxy has its own limiter)");
    },
  });
}

/** Shared rate limiter for Cursor proxy direct fetches — enforced globally. */
export const cursorProxyRateLimiter: RateLimiter = _cursorProxyLimiter;

/** Shared rate limiter for direct API endpoint calls — guards against rapid
 *  bursts across all HTTP-based API paths (preflight, probes, health checks). */
export const apiEndpointLimiter: RateLimiter = _apiEndpointLimiter;

/** Reset all rate limiter state (useful for testing or manual recovery). */
export function resetAllRateLimiters(): void {
  _sdkQueryLimiter.reset();
  _cursorProxyLimiter.reset();
  _apiEndpointLimiter.reset();
}
