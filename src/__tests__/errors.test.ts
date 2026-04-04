import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Copied from src/swarm.ts (not exported)
class AgentTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Agent timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = "AgentTimeoutError";
  }
}

function isTransientError(err: unknown): boolean {
  if (err instanceof AgentTimeoutError) return false;
  const msg = String((err as any)?.message || err).toLowerCase();
  const status: number | undefined =
    (err as any)?.status ?? (err as any)?.statusCode;
  return (
    status === 429 ||
    (status != null && status >= 500 && status < 600) ||
    msg.includes("rate limit") ||
    msg.includes("overloaded") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("socket hang up")
  );
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
});
