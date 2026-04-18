// Express-style rate-limit middleware for HTTP API endpoints.
// Tracks requests per key (IP, API key, etc.) using a sliding window
// and returns 429 with Retry-After when limits are exceeded.
import { createHash } from "node:crypto";
export function rateLimit(opts) {
    const windows = new Map();
    const { maxRequests, windowMs } = opts;
    const keyFn = opts.keyFn ?? ((req) => req.remoteAddress ?? hashHeaders(req.headers));
    const statusCode = opts.statusCode ?? 429;
    return function rateLimitMiddleware(req, next) {
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
        }
        else {
            entry.count++;
        }
        const info = {
            key,
            current: entry.count,
            limit: maxRequests,
            resetAt: entry.resetAt,
        };
        const headers = {
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
        }
        else {
            next();
        }
    };
}
/** Deterministic fallback key when remoteAddress is unavailable. */
function hashHeaders(headers) {
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
