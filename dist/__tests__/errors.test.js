import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { StreamStalledError, isStreamStalledError, isTransientError as isTransientErrorProd, } from "../swarm/errors.js";
// Copied from src/swarm.ts (not exported)
class AgentTimeoutError extends Error {
    constructor(silentMs) {
        super(`Agent silent for ${Math.round(silentMs / 1000)}s  -- assumed hung`);
        this.name = "AgentTimeoutError";
    }
}
function isTransientError(err) {
    if (err instanceof AgentTimeoutError)
        return false;
    const msg = String(err?.message || err).toLowerCase();
    const status = err?.status ?? err?.statusCode;
    if (status === 429 ||
        (status != null && status >= 500 && status < 600) ||
        msg.includes("rate limit") ||
        msg.includes("overloaded") ||
        msg.includes("econnreset") ||
        msg.includes("etimedout") ||
        msg.includes("socket hang up") ||
        msg.includes("epipe") ||
        msg.includes("econnrefused") ||
        msg.includes("ehostunreach") ||
        msg.includes("network error") ||
        msg.includes("fetch failed") ||
        msg.includes("aborted")) {
        return true;
    }
    const cause = err?.cause;
    if (cause && cause !== err)
        return isTransientError(cause);
    return false;
}
describe("isTransientError", () => {
    it("returns true for 429 status", () => {
        const err = Object.assign(new Error("Too Many Requests"), { status: 429 });
        assert.equal(isTransientError(err), true);
    });
    it("returns true for 500 status", () => {
        const err = Object.assign(new Error("Internal Server Error"), { status: 500 });
        assert.equal(isTransientError(err), true);
    });
    it("returns false for 404 status (not transient)", () => {
        const err = Object.assign(new Error("Not Found"), { status: 404 });
        assert.equal(isTransientError(err), false);
    });
    it("returns false for AgentTimeoutError", () => {
        const err = new AgentTimeoutError(30_000);
        assert.equal(isTransientError(err), false);
    });
    it("returns true for error with 'rate limit' message", () => {
        const err = new Error("Rate limit exceeded, please slow down");
        assert.equal(isTransientError(err), true);
    });
    it("returns true for error with 'econnreset' message", () => {
        const err = new Error("read ECONNRESET");
        assert.equal(isTransientError(err), true);
    });
    it("returns false for regular Error with no status", () => {
        const err = new Error("Something broke");
        assert.equal(isTransientError(err), false);
    });
    it("returns false for null input", () => {
        assert.equal(isTransientError(null), false);
    });
    it("returns false for undefined input", () => {
        assert.equal(isTransientError(undefined), false);
    });
    it("returns true for 'fetch failed' message", () => {
        assert.equal(isTransientError(new Error("fetch failed")), true);
    });
    it("returns true for 'network error' message", () => {
        assert.equal(isTransientError(new Error("network error")), true);
    });
    it("returns true for 'econnrefused' message", () => {
        assert.equal(isTransientError(new Error("connect ECONNREFUSED")), true);
    });
    it("returns true for 'aborted' message", () => {
        assert.equal(isTransientError(new Error("The operation was aborted")), true);
    });
    it("follows .cause chain for transient errors", () => {
        const inner = Object.assign(new Error("overloaded"), {});
        const outer = Object.assign(new Error("wrapper"), { cause: inner });
        assert.equal(isTransientError(outer), true);
    });
    it("does not infinite-loop on self-referencing cause", () => {
        const err = new Error("loop");
        err.cause = err;
        assert.equal(isTransientError(err), false);
    });
});
describe("StreamStalledError", () => {
    it("carries elapsed and timeoutMs", () => {
        const err = new StreamStalledError(20_123, 15_000);
        assert.equal(err.elapsed, 20_123);
        assert.equal(err.timeoutMs, 15_000);
        assert.ok(err.message.includes("15000"));
    });
});
describe("isStreamStalledError", () => {
    it("returns true for StreamStalledError instances", () => {
        assert.equal(isStreamStalledError(new StreamStalledError(1, 2)), true);
    });
    it("returns false for other errors", () => {
        assert.equal(isStreamStalledError(new Error("x")), false);
        assert.equal(isStreamStalledError(null), false);
    });
    it("treats StreamStalledError as non-transient in production classifier", () => {
        assert.equal(isTransientErrorProd(new StreamStalledError(20_000, 15_000)), false);
    });
});
