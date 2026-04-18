import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentState } from "../core/types.js";
import { Swarm } from "../swarm/swarm.js";

function makeSwarm() {
  return new Swarm({
    tasks: [{ id: "t-0", prompt: "do something" }],
    concurrency: 1,
    cwd: "/tmp",
    useWorktrees: false,
  });
}

function makeAgent(): AgentState {
  return {
    id: 0,
    task: { id: "t-0", prompt: "do something" },
    status: "running",
    startedAt: Date.now(),
    toolCalls: 0,
  };
}

describe("rate_limit_event with status=rejected", () => {
  it("throws so the runAgent retry path catches it", () => {
    const swarm = makeSwarm();
    const agent = makeAgent();
    const handler = (swarm as unknown as { handleMsg: (a: AgentState, m: unknown) => void }).handleMsg.bind(swarm);
    assert.throws(
      () => handler(agent, {
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", utilization: 1, resetsAt: undefined },
      }),
      /rate limit/i,
    );
  });

  it("sets rateLimitResetsAt to a fallback when the SDK omits resetsAt", () => {
    const swarm = makeSwarm();
    const before = Date.now();
    const handler = (swarm as unknown as { handleMsg: (a: AgentState, m: unknown) => void }).handleMsg.bind(swarm);
    try {
      handler(makeAgent(), {
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", utilization: 1 },
      });
    } catch {}
    assert.ok(swarm.rateLimitResetsAt != null && swarm.rateLimitResetsAt > before, "rateLimitResetsAt must be set");
    assert.ok(swarm.rateLimitResetsAt! - before >= 30_000, "fallback should be ≥30s in the future");
  });

  it("respects an SDK-provided resetsAt when present", () => {
    const swarm = makeSwarm();
    const provided = Date.now() + 5 * 60_000;
    const handler = (swarm as unknown as { handleMsg: (a: AgentState, m: unknown) => void }).handleMsg.bind(swarm);
    try {
      handler(makeAgent(), {
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", utilization: 1, resetsAt: provided },
      });
    } catch {}
    assert.equal(swarm.rateLimitResetsAt, provided);
  });

  it("does not throw on non-rejected status events", () => {
    const swarm = makeSwarm();
    const handler = (swarm as unknown as { handleMsg: (a: AgentState, m: unknown) => void }).handleMsg.bind(swarm);
    assert.doesNotThrow(() => handler(makeAgent(), {
      type: "rate_limit_event",
      rate_limit_info: { status: "warning", utilization: 0.9 },
    }));
    assert.doesNotThrow(() => handler(makeAgent(), {
      type: "rate_limit_event",
      rate_limit_info: { status: "ok", utilization: 0.4 },
    }));
  });
});

describe("mostConstrainedWindow", () => {
  it("returns undefined when no windows known", () => {
    const swarm = makeSwarm();
    assert.equal(swarm.mostConstrainedWindow(), undefined);
  });

  it("prefers a rejected window over higher-utilization ok windows", () => {
    const swarm = makeSwarm();
    swarm.rateLimitWindows.set("five_hour", { type: "five_hour", utilization: 0.5, status: "rejected", resetsAt: Date.now() + 60_000 });
    swarm.rateLimitWindows.set("seven_day", { type: "seven_day", utilization: 0.95, status: "ok" });
    assert.equal(swarm.mostConstrainedWindow()?.type, "five_hour");
  });

  it("falls back to highest utilization when none rejected", () => {
    const swarm = makeSwarm();
    swarm.rateLimitWindows.set("five_hour", { type: "five_hour", utilization: 0.3, status: "ok" });
    swarm.rateLimitWindows.set("seven_day", { type: "seven_day", utilization: 0.8, status: "ok" });
    assert.equal(swarm.mostConstrainedWindow()?.type, "seven_day");
  });

  it("ignores stale rejected windows (resetsAt in the past)", () => {
    const swarm = makeSwarm();
    swarm.rateLimitWindows.set("five_hour", { type: "five_hour", utilization: 0.2, status: "rejected", resetsAt: Date.now() - 1000 });
    swarm.rateLimitWindows.set("seven_day", { type: "seven_day", utilization: 0.9, status: "ok" });
    assert.equal(swarm.mostConstrainedWindow()?.type, "seven_day");
  });
});

describe("retryRateLimitNow", () => {
  it("does not clear resetsAt when no workers are waiting", () => {
    const swarm = makeSwarm();
    const reset = Date.now() + 60_000;
    swarm.rateLimitResetsAt = reset;
    swarm.retryRateLimitNow();
    assert.equal(swarm.rateLimitResetsAt, reset);
  });

  it("wakes a pending rate-limit sleeper and clears resetsAt", async () => {
    const swarm = makeSwarm();
    swarm.rateLimitResetsAt = Date.now() + 60_000;
    const sleep = (swarm as unknown as { rateLimitSleep: (ms: number) => Promise<void> }).rateLimitSleep.bind(swarm);
    const start = Date.now();
    const p = sleep(60_000);
    setTimeout(() => swarm.retryRateLimitNow(), 10);
    await p;
    assert.ok(Date.now() - start < 1000, "sleep should wake well before the 60s timeout");
    assert.equal(swarm.rateLimitResetsAt, undefined);
  });
});

describe("agentSummary", () => {
  it("says 'errored' when the agent is in error state", () => {
    const swarm = makeSwarm();
    const summary = (swarm as unknown as { agentSummary: (a: AgentState) => string }).agentSummary.bind(swarm);
    const agent: AgentState = {
      id: 7, task: { id: "t-x", prompt: "x" }, status: "error",
      startedAt: Date.now() - 5000, finishedAt: Date.now(), toolCalls: 0,
    };
    assert.match(summary(agent), /Agent 7 errored:/);
  });

  it("says 'done' when the agent completed", () => {
    const swarm = makeSwarm();
    const summary = (swarm as unknown as { agentSummary: (a: AgentState) => string }).agentSummary.bind(swarm);
    const agent: AgentState = {
      id: 3, task: { id: "t-x", prompt: "x" }, status: "done",
      startedAt: Date.now() - 5000, finishedAt: Date.now(), toolCalls: 4,
    };
    assert.match(summary(agent), /Agent 3 done:/);
  });
});
