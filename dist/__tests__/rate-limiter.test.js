import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "../core/rate-limiter.js";
describe("RateLimiter", () => {
    it("allows requests when under limit", () => {
        const rl = new RateLimiter({ maxRequests: 3, windowMs: 1000 });
        assert.equal(rl.canRequest(), true);
        assert.equal(rl.currentCount, 0);
    });
    it("blocks after maxRequests within window", () => {
        const rl = new RateLimiter({ maxRequests: 2, windowMs: 5000 });
        rl.record();
        rl.record();
        assert.equal(rl.currentCount, 2);
        assert.equal(rl.canRequest(), false);
    });
    it("enforces minInterval between requests", () => {
        const rl = new RateLimiter({ maxRequests: 10, windowMs: 10000, minIntervalMs: 500 });
        rl.record();
        assert.equal(rl.canRequest(), false);
        const wait = rl.waitMs();
        assert.ok(wait >= 490 && wait <= 510, "wait should be ~500ms, got " + wait);
    });
    it("evicts expired timestamps", () => {
        const rl = new RateLimiter({ maxRequests: 2, windowMs: 50 });
        rl.record();
        rl.record();
        assert.equal(rl.currentCount, 2);
    });
    it("default minInterval is windowMs / maxRequests", () => {
        const rl = new RateLimiter({ maxRequests: 4, windowMs: 10000 });
        rl.record();
        const wait = rl.waitMs();
        assert.ok(wait >= 2400 && wait <= 2600, "wait should be ~2500ms, got " + wait);
    });
    it("reset clears all state", () => {
        const rl = new RateLimiter({ maxRequests: 1, windowMs: 60000 });
        rl.record();
        assert.equal(rl.canRequest(), false);
        rl.reset();
        assert.equal(rl.canRequest(), true);
        assert.equal(rl.currentCount, 0);
    });
    it("waitMs returns 0 when under limit and interval elapsed", () => {
        const rl = new RateLimiter({ maxRequests: 5, windowMs: 1000, minIntervalMs: 1 });
        assert.equal(rl.waitMs(), 0);
    });
});
