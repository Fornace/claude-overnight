import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTurn, beginTurn, endTurn, updateTurn, allTurns, focusedTurn, cycleFocused, getTurn, peakContextTurn, resetTurns, } from "../core/turns.js";
beforeEach(() => { resetTurns(); });
describe("createTurn", () => {
    it("creates a turn with pending status", () => {
        const t = createTurn("plan", "Planning", "plan-1", "claude-sonnet-4-6");
        assert.equal(t.id, "plan-1");
        assert.equal(t.phase, "plan");
        assert.equal(t.label, "Planning");
        assert.equal(t.model, "claude-sonnet-4-6");
        assert.equal(t.status, "pending");
    });
    it("creates a turn without model", () => {
        const t = createTurn("swarm", "Worker", "swarm-1");
        assert.equal(t.model, undefined);
    });
    it("appends to the registry", () => {
        createTurn("plan", "A", "a");
        createTurn("swarm", "B", "b");
        assert.equal(allTurns().length, 2);
    });
});
describe("beginTurn / endTurn", () => {
    it("beginTurn sets running status and startedAt", () => {
        const t = createTurn("plan", "P", "p1");
        const before = Date.now();
        beginTurn(t);
        assert.equal(t.status, "running");
        assert.ok(t.startedAt >= before);
    });
    it("endTurn marks done with timestamp", () => {
        const t = createTurn("plan", "P", "p1");
        beginTurn(t);
        const before = Date.now();
        endTurn(t);
        assert.equal(t.status, "done");
        assert.ok(t.finishedAt >= before);
    });
    it("endTurn accepts custom status", () => {
        const t = createTurn("plan", "P", "p1");
        beginTurn(t);
        endTurn(t, "error");
        assert.equal(t.status, "error");
    });
});
describe("updateTurn", () => {
    it("patches arbitrary fields", () => {
        const t = createTurn("swarm", "Agent", "s1");
        beginTurn(t);
        updateTurn(t, { contextTokens: 5000, peakContextTokens: 8000, costUsd: 0.03 });
        assert.equal(t.contextTokens, 5000);
        assert.equal(t.peakContextTokens, 8000);
        assert.equal(t.costUsd, 0.03);
    });
});
describe("allTurns / getTurn", () => {
    it("returns a live view of all turns", () => {
        createTurn("plan", "A", "a");
        createTurn("swarm", "B", "b");
        assert.equal(allTurns().length, 2);
    });
    it("finds a turn by id", () => {
        createTurn("plan", "A", "a");
        const found = getTurn("a");
        assert.ok(found);
        assert.equal(found.label, "A");
        assert.equal(getTurn("nonexistent"), undefined);
    });
});
describe("focusedTurn / cycleFocused", () => {
    it("returns undefined when no turns", () => {
        assert.equal(focusedTurn(), undefined);
    });
    it("returns the first turn initially, clamps to last if out of range", () => {
        createTurn("plan", "First", "f1");
        createTurn("swarm", "Second", "s1");
        const f = focusedTurn();
        assert.ok(f);
        assert.equal(f.label, "First");
    });
    it("cycles forward and backward", () => {
        createTurn("plan", "A", "a");
        createTurn("swarm", "B", "b");
        createTurn("review-wave", "C", "c");
        assert.equal(focusedTurn().label, "A");
        cycleFocused(1);
        assert.equal(focusedTurn().label, "B");
        cycleFocused(1);
        assert.equal(focusedTurn().label, "C");
        cycleFocused(1);
        assert.equal(focusedTurn().label, "A");
        cycleFocused(-1);
        assert.equal(focusedTurn().label, "C");
    });
    it("does nothing when no turns", () => {
        cycleFocused(5);
        assert.equal(focusedTurn(), undefined);
    });
});
describe("peakContextTurn", () => {
    it("returns undefined when no running turns", () => {
        const t = createTurn("swarm", "S", "s1");
        endTurn(t);
        assert.equal(peakContextTurn(), undefined);
    });
    it("returns the running turn with highest contextTokens", () => {
        const a = createTurn("swarm", "A", "a");
        beginTurn(a);
        updateTurn(a, { contextTokens: 3000 });
        const b = createTurn("swarm", "B", "b");
        beginTurn(b);
        updateTurn(b, { contextTokens: 7000 });
        const c = createTurn("swarm", "C", "c");
        beginTurn(c);
        updateTurn(c, { contextTokens: 5000 });
        const peak = peakContextTurn();
        assert.ok(peak);
        assert.equal(peak.id, "b");
    });
    it("ignores turns with zero contextTokens", () => {
        const t = createTurn("plan", "P", "p1");
        beginTurn(t);
        assert.equal(peakContextTurn(), undefined);
    });
    it("ignores non-running turns even if they have context", () => {
        const a = createTurn("swarm", "A", "a");
        beginTurn(a);
        updateTurn(a, { contextTokens: 1000 });
        endTurn(a);
        const b = createTurn("swarm", "B", "b");
        beginTurn(b);
        updateTurn(b, { contextTokens: 500 });
        const peak = peakContextTurn();
        assert.ok(peak);
        assert.equal(peak.id, "b");
    });
});
describe("resetTurns", () => {
    it("clears all turns and resets focus", () => {
        createTurn("plan", "A", "a");
        createTurn("swarm", "B", "b");
        resetTurns();
        assert.equal(allTurns().length, 0);
        assert.equal(focusedTurn(), undefined);
    });
});
