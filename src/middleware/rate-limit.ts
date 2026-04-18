// Express-style rate-limit middleware for HTTP API endpoints.
// Tracks requests per key (IP, API key, etc.) using a sliding window
// and returns 429 with Retry-After when limits are exceeded.

import { createHash } from "node:crypto";

export interface RateLimitOptions {
  /** Max requests allowed in the window. */
  maxRequests: number;
  /** Window size in milliseconds. */
  windowMs: number;
  /** How to derive the rate-limit key from the request. Defaults to remote address. */
  keyFn?: (req: IncomingRequest) => string;
  /** Custom response body when rate limited. */
  message?: string | ((info: RateLimitInfo) => string);
  /** Custom status code. Defaults to 429. */
  statusCode?: number;
}

export interface IncomingRequest {
  remoteAddress?: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface RateLimitInfo {
  /** The key used for this request. */
  key: string;
  /** Number of requests in the current window (including this one). */
  current: number;
  /** Max requests allowed. */
  limit: number;
  /** When the current window resets (ms epoch). */
  resetAt: number;
}

interface WindowEntry {
  count: number;
  resetAt: number;
}

export function rateLimit(opts: RateLimitOptions) {
  const windows = new Map<string, WindowEntry>();
  const { maxRequests, windowMs } = opts;
  const keyFn = opts.keyFn ?? ((req) => req.remoteAddress ?? hashHeaders(req.headers));
  const statusCode = opts.statusCode ?? 429;

  return function rateLimitMiddleware(
    req: IncomingRequest,
    next: (info?: { status: number; headers: Record<string, string>; body: string }) => void,
  ): void {
    const now = Date.now();
    const key = keyFn(req);
    let entry = windows.get(key);

    // Expire stale windows
    if (entry && now >= entry.resetAt) {
      windows.delete(key);
      entry = undefined;
    }

    if (!entry) {
      entry = { count: 1, resetAt: now + windowMs };
      windows.set(key, entry);
    } else {
      entry.count++;
    }

    const info: RateLimitInfo = {
      key,
      current: entry.count,
      limit: maxRequests,
      resetAt: entry.resetAt,
    };

    const headers: Record<string, string> = {
      "X-RateLimit-Limit": String(maxRequests),
      "X-RateLimit-Remaining": String(Math.max(0, maxRequests - entry.count)),
      "X-RateLimit-Reset": String(Math.ceil(entry.resetAt / 1000)),
    };

    if (entry.count > maxRequests) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      headers["Retry-After"] = String(retryAfter);
      const body = typeof opts.message === "function"
        ? opts.message(info)
        : opts.message ?? JSON.stringify({ error: "rate limit exceeded", retryAfter });
      next({ status: statusCode, headers, body });
    } else {
      next();
    }
  };
}

/** Deterministic fallback key when remoteAddress is unavailable. */
function hashHeaders(headers: Record<string, string | string[] | undefined>): string {
  const raw = [
    headers["x-forwarded-for"],
    headers["x-real-ip"],
    headers["cf-connecting-ip"],
  ].find(v => typeof v === "string" && v.length > 0) ?? "anonymous";
  return createHash("sha256").update(String(raw)).digest("hex").slice(0, 16);
}

// ── Pre-built middleware instances for common API endpoints ──

/** Rate limit: 30 requests per minute per IP. Suitable for general API endpoints. */
export const apiRateLimit = rateLimit({ maxRequests: 30, windowMs: 60_000 });

/** Rate limit: 10 requests per minute per IP. Stricter limit for expensive operations. */
export const strictRateLimit = rateLimit({ maxRequests: 10, windowMs: 60_000 });

/** Rate limit: 5 requests per 10 seconds per IP. Burst protection for health checks. */
export const healthRateLimit = rateLimit({ maxRequests: 5, windowMs: 10_000 });
