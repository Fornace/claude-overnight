import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentState } from "../types.js";
import { Swarm } from "../swarm.js";

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
