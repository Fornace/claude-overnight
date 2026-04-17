import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentState, Task } from "../types.js";
import { Swarm } from "../swarm.js";

function makeSwarm() {
  const tasks: Task[] = [{ id: "t0", prompt: "do" }];
  return new Swarm({ tasks, concurrency: 1, cwd: "/tmp", model: "claude-sonnet-4-6" });
}

function makeAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 0,
    task: { id: "t0", prompt: "do" },
    status: "running",
    toolCalls: 0,
    contextTokens: 0,
    ...overrides,
  };
}

function fakeAssistant(input: number, cacheRead = 0, cacheCreate = 0) {
  return {
    type: "assistant",
    message: {
      content: [],
      usage: {
        input_tokens: input,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreate,
      },
    },
  };
}

describe("context token accumulation", () => {
  it("tracks the latest turn total (input + cache) across assistant messages", () => {
    const swarm = makeSwarm();
    const agent = makeAgent();
    (swarm as any).agents.push(agent);

    (swarm as any).handleMsg(agent, fakeAssistant(1000, 500, 0));
    assert.equal(agent.contextTokens, 1500);
    assert.equal(agent.peakContextTokens, 1500);

    // A smaller next turn (e.g. post-compaction) must drop the reported value.
    (swarm as any).handleMsg(agent, fakeAssistant(800, 200, 0));
    assert.equal(agent.contextTokens, 1000);
    assert.equal(agent.peakContextTokens, 1500); // peak preserved

    // A larger turn reflects the new occupancy and raises the peak.
    (swarm as any).handleMsg(agent, fakeAssistant(2000, 1000, 100));
    assert.equal(agent.contextTokens, 3100);
    assert.equal(agent.peakContextTokens, 3100);
  });

  it("is resilient to missing usage", () => {
    const swarm = makeSwarm();
    const agent = makeAgent();
    (swarm as any).agents.push(agent);
    (swarm as any).handleMsg(agent, { type: "assistant", message: { content: [] } });
    assert.equal(agent.contextTokens, 0);
    assert.equal(agent.peakContextTokens ?? 0, 0);
  });

  it("logs a saturation warning when crossing 80% of safeContext", () => {
    const swarm = makeSwarm();
    const agent = makeAgent();
    (swarm as any).agents.push(agent);

    // Sonnet 4.6 safeContext = 60_000; 80% = 48_000. Use 50_000.
    (swarm as any).handleMsg(agent, fakeAssistant(50_000, 0, 0));
    const logs = swarm.logs;
    const warned = logs.some(e => e.agentId === agent.id && e.text.includes("context"));
    assert.equal(warned, true, "expected a context saturation log entry");

    // Second crossing must not spam the log.
    const warnCountBefore = logs.filter(e => e.text.includes("context")).length;
    (swarm as any).handleMsg(agent, fakeAssistant(55_000, 0, 0));
    const warnCountAfter = swarm.logs.filter(e => e.text.includes("context")).length;
    assert.equal(warnCountAfter, warnCountBefore, "warning must fire only once per agent");
  });
});
