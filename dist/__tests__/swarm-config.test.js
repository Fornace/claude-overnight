import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Swarm } from "../swarm.js";
// ── Helpers ──
function makeTasks(n) {
    return Array.from({ length: n }, (_, i) => ({
        id: `task-${i}`,
        prompt: `Do thing ${i}`,
    }));
}
function makeSwarm(overrides = {}) {
    return new Swarm({
        tasks: makeTasks(3),
        concurrency: 2,
        cwd: "/tmp",
        ...overrides,
    });
}
// ── Constructor ──
describe("Swarm constructor", () => {
    it("sets pending to the number of tasks", () => {
        const swarm = makeSwarm({ tasks: makeTasks(5) });
        assert.equal(swarm.pending, 5);
    });
    it("sets total to the number of tasks", () => {
        const swarm = makeSwarm({ tasks: makeTasks(7) });
        assert.equal(swarm.total, 7);
    });
    it("initialises phase to 'running'", () => {
        assert.equal(makeSwarm().phase, "running");
    });
    it("starts with zero completed, failed, cost, and tokens", () => {
        const swarm = makeSwarm();
        assert.equal(swarm.completed, 0);
        assert.equal(swarm.failed, 0);
        assert.equal(swarm.totalCostUsd, 0);
        assert.equal(swarm.totalInputTokens, 0);
        assert.equal(swarm.totalOutputTokens, 0);
    });
    it("starts with empty agents and mergeResults", () => {
        const swarm = makeSwarm();
        assert.deepEqual(swarm.agents, []);
        assert.deepEqual(swarm.mergeResults, []);
    });
    it("starts not aborted", () => {
        assert.equal(makeSwarm().aborted, false);
    });
    it("throws on an empty task list", () => {
        assert.throws(() => makeSwarm({ tasks: [] }), { message: /tasks array must not be empty/ });
    });
    it("copies the tasks array (does not alias the original)", () => {
        const tasks = makeTasks(2);
        const swarm = new Swarm({ tasks, concurrency: 1, cwd: "/tmp" });
        tasks.push({ id: "extra", prompt: "extra" });
        assert.equal(swarm.pending, 2, "queue should be unaffected by later mutation");
        assert.equal(swarm.total, 2);
    });
});
// ── abort() ──
describe("Swarm.abort()", () => {
    it("sets the aborted flag to true", () => {
        const swarm = makeSwarm();
        swarm.abort();
        assert.equal(swarm.aborted, true);
    });
    it("clears the queue so pending becomes 0", () => {
        const swarm = makeSwarm({ tasks: makeTasks(10) });
        assert.equal(swarm.pending, 10);
        swarm.abort();
        assert.equal(swarm.pending, 0);
    });
    it("does not change total", () => {
        const swarm = makeSwarm({ tasks: makeTasks(4) });
        swarm.abort();
        assert.equal(swarm.total, 4);
    });
    it("is safe to call twice", () => {
        const swarm = makeSwarm();
        swarm.abort();
        swarm.abort();
        assert.equal(swarm.aborted, true);
        assert.equal(swarm.pending, 0);
    });
});
// ── active getter ──
describe("Swarm.active", () => {
    it("returns 0 when no agents exist", () => {
        assert.equal(makeSwarm().active, 0);
    });
    it("counts only agents whose status is 'running'", () => {
        const swarm = makeSwarm();
        swarm.agents.push({ id: 0, task: makeTasks(1)[0], status: "running", toolCalls: 0 }, { id: 1, task: makeTasks(1)[0], status: "done", toolCalls: 0 }, { id: 2, task: makeTasks(1)[0], status: "running", toolCalls: 0 }, { id: 3, task: makeTasks(1)[0], status: "error", toolCalls: 0 });
        assert.equal(swarm.active, 2);
    });
    it("returns 0 when all agents are done or errored", () => {
        const swarm = makeSwarm();
        swarm.agents.push({ id: 0, task: makeTasks(1)[0], status: "done", toolCalls: 3 }, { id: 1, task: makeTasks(1)[0], status: "error", toolCalls: 1 });
        assert.equal(swarm.active, 0);
    });
});
// ── pending getter ──
describe("Swarm.pending", () => {
    it("reflects the initial queue length", () => {
        assert.equal(makeSwarm({ tasks: makeTasks(6) }).pending, 6);
    });
    it("drops to 0 after abort()", () => {
        const swarm = makeSwarm();
        swarm.abort();
        assert.equal(swarm.pending, 0);
    });
});
