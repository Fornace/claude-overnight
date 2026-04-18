import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter, RateLimitError, sdkQueryRateLimiter, cursorProxyRateLimiter, apiEndpointLimiter, resetAllRateLimiters, acquireSdkQueryRateLimit } from "../core/rate-limiter.js";
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
describe("shared singleton instances", () => {
    it("sdkQueryRateLimiter is a single shared instance", () => {
        // Recording on the singleton should affect canRequest
        const rl = sdkQueryRateLimiter;
        const before = rl.currentCount;
        rl.record();
        assert.equal(rl.currentCount, before + 1);
    });
    it("cursorProxyRateLimiter is a single shared instance", () => {
        const rl = cursorProxyRateLimiter;
        const before = rl.currentCount;
        rl.record();
        assert.equal(rl.currentCount, before + 1);
    });
    it("resetAllRateLimiters clears all singletons", () => {
        // Pollute the singletons first
        sdkQueryRateLimiter.record();
        cursorProxyRateLimiter.record();
        apiEndpointLimiter.record();
        assert.ok(sdkQueryRateLimiter.currentCount > 0);
        assert.ok(cursorProxyRateLimiter.currentCount > 0);
        assert.ok(apiEndpointLimiter.currentCount > 0);
        resetAllRateLimiters();
        assert.equal(sdkQueryRateLimiter.currentCount, 0);
        assert.equal(cursorProxyRateLimiter.currentCount, 0);
        assert.equal(apiEndpointLimiter.currentCount, 0);
    });
    it("apiEndpointLimiter is a single shared instance", () => {
        const rl = apiEndpointLimiter;
        const before = rl.currentCount;
        rl.record();
        assert.equal(rl.currentCount, before + 1);
    });
});
describe("RateLimitError", () => {
    it("is a proper Error subclass", () => {
        const err = new RateLimitError("custom message");
        assert.ok(err instanceof Error);
        assert.equal(err.name, "RateLimitError");
        assert.equal(err.message, "custom message");
    });
    it("has a default message", () => {
        const err = new RateLimitError();
        assert.equal(err.message, "rate limit exceeded");
    });
});
describe("assertCanRequest", () => {
    it("does not throw when under limit", () => {
        const rl = new RateLimiter({ maxRequests: 3, windowMs: 10000 });
        assert.doesNotThrow(() => rl.assertCanRequest());
    });
    it("throws RateLimitError when window is full", () => {
        const rl = new RateLimiter({ maxRequests: 2, windowMs: 60000 });
        rl.record();
        rl.record();
        assert.throws(() => rl.assertCanRequest(), RateLimitError);
    });
    it("throws RateLimitError when min interval not elapsed", () => {
        const rl = new RateLimiter({ maxRequests: 10, windowMs: 10000, minIntervalMs: 5000 });
        rl.record();
        assert.throws(() => rl.assertCanRequest(), RateLimitError);
    });
    it("includes useful info in error message when window full", () => {
        const rl = new RateLimiter({ maxRequests: 2, windowMs: 30000 });
        rl.record();
        rl.record();
        try {
            rl.assertCanRequest();
            assert.fail("should have thrown");
        }
        catch (err) {
            assert.ok(err.message.includes("2/2"), `expected "2/2" in message: ${err.message}`);
            assert.ok(err.message.includes("resets in"), `expected "resets in" in message: ${err.message}`);
        }
    });
    it("passes after reset", () => {
        const rl = new RateLimiter({ maxRequests: 1, windowMs: 60000 });
        rl.record();
        assert.throws(() => rl.assertCanRequest(), RateLimitError);
        rl.reset();
        assert.doesNotThrow(() => rl.assertCanRequest());
    });
});
describe("RateLimiter.acquire", () => {
    it("bypasses throttle when skipWhen returns true", async () => {
        const rl = new RateLimiter({ maxRequests: 2, windowMs: 150, minIntervalMs: 1 });
        rl.record();
        rl.record();
        const t0 = Date.now();
        await rl.acquire({ skipWhen: () => true });
        assert.ok(Date.now() - t0 < 40);
    });
    it("enforces window when skipWhen absent", async () => {
        const rl = new RateLimiter({ maxRequests: 2, windowMs: 150, minIntervalMs: 1 });
        await rl.acquire();
        rl.record();
        await rl.acquire();
        rl.record();
        const t0 = Date.now();
        await rl.acquire();
        assert.ok(Date.now() - t0 >= 80, "expected sliding-window wait");
    });
});
describe("acquireSdkQueryRateLimit", () => {
    const prevProxy = process.env.CURSOR_PROXY_URL;
    afterEach(() => {
        resetAllRateLimiters();
        if (prevProxy === undefined)
            delete process.env.CURSOR_PROXY_URL;
        else
            process.env.CURSOR_PROXY_URL = prevProxy;
    });
    it("bypasses SDK limiter when CURSOR_PROXY_URL is set", async () => {
        process.env.CURSOR_PROXY_URL = "http://127.0.0.1:9999";
        resetAllRateLimiters();
        sdkQueryRateLimiter.record();
        sdkQueryRateLimiter.record();
        const logs = [];
        const orig = console.log;
        console.log = (...args) => {
            logs.push(args.map(String).join(" "));
            orig.apply(console, args);
        };
        try {
            const t0 = Date.now();
            await acquireSdkQueryRateLimit();
            assert.ok(Date.now() - t0 < 50);
            assert.ok(logs.some((l) => l.includes("[rate-limiter] Skipping SDK rate limit")));
        }
        finally {
            console.log = orig;
        }
    });
    it("enforces SDK limiter when CURSOR_PROXY_URL is unset", async () => {
        delete process.env.CURSOR_PROXY_URL;
        resetAllRateLimiters();
        await acquireSdkQueryRateLimit();
        sdkQueryRateLimiter.record();
        const t0 = Date.now();
        await acquireSdkQueryRateLimit();
        const elapsed = Date.now() - t0;
        assert.ok(elapsed >= 2400, `expected min-interval wait ~2500ms, got ${elapsed}ms`);
    });
});
