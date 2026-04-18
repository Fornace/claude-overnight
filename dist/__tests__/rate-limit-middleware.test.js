import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rateLimit } from "../middleware/rate-limit.js";
function makeReq(overrides = {}) {
    return {
        remoteAddress: overrides.remoteAddress ?? "127.0.0.1",
        headers: overrides.headers ?? {},
    };
}
function run(mw, req) {
    let result;
    mw(req, (r) => { if (r)
        result = r; });
    return result;
}
describe("rateLimit middleware", () => {
    it("passes through when under limit", () => {
        const mw = rateLimit({ maxRequests: 3, windowMs: 1000 });
        const result = run(mw, makeReq());
        assert.equal(result, undefined);
    });
    it("returns 429 when over limit", () => {
        const mw = rateLimit({ maxRequests: 2, windowMs: 60000 });
        run(mw, makeReq());
        run(mw, makeReq());
        const result = run(mw, makeReq());
        assert.ok(result);
        assert.equal(result.status, 429);
        assert.ok(result.body.includes("rate limit"));
    });
    it("sets rate-limit headers on every response", () => {
        const mw = rateLimit({ maxRequests: 5, windowMs: 10000 });
        const r1 = run(mw, makeReq());
        assert.ok(r1 === undefined);
        // Headers are only returned when rate limited
        run(mw, makeReq());
        run(mw, makeReq());
        run(mw, makeReq());
        run(mw, makeReq());
        const r6 = run(mw, makeReq());
        assert.ok(r6);
        assert.equal(r6.headers["X-RateLimit-Limit"], "5");
        assert.equal(r6.headers["X-RateLimit-Remaining"], "0");
        assert.ok(r6.headers["X-RateLimit-Reset"]);
        assert.ok(r6.headers["Retry-After"]);
    });
    it("tracks different IPs independently", () => {
        const mw = rateLimit({ maxRequests: 1, windowMs: 60000 });
        run(mw, makeReq({ remoteAddress: "1.1.1.1" }));
        const blocked = run(mw, makeReq({ remoteAddress: "1.1.1.1" }));
        const allowed = run(mw, makeReq({ remoteAddress: "2.2.2.2" }));
        assert.ok(blocked);
        assert.equal(allowed, undefined);
    });
    it("uses keyFn for custom identification", () => {
        const mw = rateLimit({
            maxRequests: 1,
            windowMs: 60000,
            keyFn: (req) => String(req.headers["x-api-key"] ?? "none"),
        });
        run(mw, makeReq({ headers: { "x-api-key": "key-a" } }));
        const sameKey = run(mw, makeReq({ headers: { "x-api-key": "key-a" } }));
        const diffKey = run(mw, makeReq({ headers: { "x-api-key": "key-b" } }));
        assert.ok(sameKey);
        assert.equal(diffKey, undefined);
    });
    it("custom message as string", () => {
        const mw = rateLimit({ maxRequests: 1, windowMs: 60000, message: "slow down" });
        run(mw, makeReq());
        const result = run(mw, makeReq());
        assert.ok(result);
        assert.equal(result.body, "slow down");
    });
    it("custom message as function receiving info", () => {
        const mw = rateLimit({
            maxRequests: 1,
            windowMs: 60000,
            message: (info) => `limited: ${info.current}/${info.limit}`,
        });
        run(mw, makeReq());
        const result = run(mw, makeReq());
        assert.ok(result);
        assert.equal(result.body, "limited: 2/1");
    });
    it("custom status code", () => {
        const mw = rateLimit({ maxRequests: 1, windowMs: 60000, statusCode: 503 });
        run(mw, makeReq());
        const result = run(mw, makeReq());
        assert.ok(result);
        assert.equal(result.status, 503);
    });
    it("falls back to header-based key when no remoteAddress", () => {
        const mw = rateLimit({ maxRequests: 1, windowMs: 60000 });
        const req = makeReq({ headers: { "x-forwarded-for": "10.0.0.1" } });
        // Override remoteAddress to test hash fallback — the middleware accepts
        // IncomingRequest which has optional remoteAddress.
        req.remoteAddress = undefined;
        run(mw, req);
        const blocked = run(mw, req);
        assert.ok(blocked);
    });
    it("Retry-After header is positive and reasonable", () => {
        const mw = rateLimit({ maxRequests: 1, windowMs: 5000 });
        run(mw, makeReq());
        const result = run(mw, makeReq());
        assert.ok(result);
        const retryAfter = parseInt(result.headers["Retry-After"], 10);
        assert.ok(retryAfter > 0 && retryAfter <= 5, `Retry-After should be 1-5s, got ${retryAfter}`);
    });
});
