import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findIncompleteRuns, saveRunState, backfillOrphanedPlans, loadRunState } from "../state.js";
// Regression test for resume visibility of plan-phase runs.
// Before 1.11.7, findIncompleteRuns only returned runs with a run.json, but
// run.json was only written inside executeRun  -- so a plan-phase failure was
// invisible to the resume picker. 1.11.7 writes an early run.json with
// phase: "planning" and requires tasks.json on disk for it to be surfaced.
// 1.11.14 also accepts designs/ on disk  -- a thinking-wave kill used to
// leave a run.json with phase "planning" but no tasks.json, silently hiding
// the run and throwing away the thinking spend.
const tmp = mkdtempSync(join(tmpdir(), "planning-resume-"));
const cwd = "/fake/workspace";
after(() => { try {
    rmSync(tmp, { recursive: true, force: true });
}
catch { } });
function makeRun(id) {
    const dir = join(tmp, "runs", id);
    mkdirSync(dir, { recursive: true });
    return dir;
}
function baseState(phase) {
    return {
        id: "r", objective: "do the thing", budget: 10, remaining: 10,
        workerModel: "opus", plannerModel: "opus", concurrency: 2, permissionMode: "auto",
        flex: true, useWorktrees: true, mergeStrategy: "yolo",
        waveNum: 0, currentTasks: [],
        accCost: 0, accCompleted: 0, accFailed: 0,
        branches: [], phase,
        startedAt: new Date().toISOString(), cwd,
        allowExtraUsage: false,
    };
}
describe("findIncompleteRuns  -- planning phase visibility", () => {
    it("surfaces a planning-phase run when tasks.json exists", () => {
        const dir = makeRun("2026-04-12T13-03-57");
        saveRunState(dir, baseState("planning"));
        writeFileSync(join(dir, "tasks.json"), JSON.stringify({
            tasks: [
                { prompt: "First substantial task to execute in wave 0" },
                { prompt: "Second substantial task to execute in wave 0" },
            ],
        }));
        const runs = findIncompleteRuns(tmp, cwd);
        assert.ok(runs.length >= 1, "should find the planning run");
        const found = runs.find(r => r.dir === dir);
        assert.ok(found, "the planning run should be in results");
        assert.equal(found.state.phase, "planning");
    });
    it("skips planning-phase runs with neither tasks.json nor designs", () => {
        const dir = makeRun("2026-04-10T09-00-00");
        saveRunState(dir, baseState("planning"));
        // No tasks.json and no designs/ on disk  -- nothing to resume
        const runs = findIncompleteRuns(tmp, cwd);
        assert.equal(runs.find(r => r.dir === dir), undefined, "empty planning run should be filtered");
    });
    it("surfaces a planning-phase run when only designs exist (killed thinking wave)", () => {
        const dir = makeRun("2026-04-13T11-28-00");
        saveRunState(dir, { ...baseState("planning"), accCost: 2.02, accCompleted: 1 });
        // No tasks.json, but the thinking wave produced design docs before the quit
        mkdirSync(join(dir, "designs"));
        writeFileSync(join(dir, "designs", "focus-0.md"), "# design\nsome content\n");
        const runs = findIncompleteRuns(tmp, cwd);
        const found = runs.find(r => r.dir === dir);
        assert.ok(found, "designs-only planning run should be surfaced for re-orchestration");
        assert.equal(found.state.phase, "planning");
        assert.equal(found.state.accCost, 2.02);
    });
    it("still surfaces steering-phase runs (existing behavior)", () => {
        const dir = makeRun("2026-04-11T18-00-00");
        saveRunState(dir, { ...baseState("steering"), waveNum: 2, accCost: 12.34 });
        const runs = findIncompleteRuns(tmp, cwd);
        const found = runs.find(r => r.dir === dir);
        assert.ok(found, "steering run should be visible");
        assert.equal(found.state.phase, "steering");
    });
    it("filters runs whose cwd does not match", () => {
        const dir = makeRun("2026-04-09T12-00-00");
        saveRunState(dir, { ...baseState("planning"), cwd: "/other/project" });
        writeFileSync(join(dir, "tasks.json"), JSON.stringify({ tasks: [{ prompt: "irrelevant task text here" }] }));
        const runs = findIncompleteRuns(tmp, cwd);
        assert.equal(runs.find(r => r.dir === dir), undefined, "different cwd should filter out");
    });
    it("does not surface completed runs regardless of phase", () => {
        const dir = makeRun("2026-04-08T12-51-08");
        saveRunState(dir, { ...baseState("done") });
        const runs = findIncompleteRuns(tmp, cwd);
        assert.equal(runs.find(r => r.dir === dir), undefined, "done runs should not appear");
    });
});
describe("backfillOrphanedPlans  -- pre-1.11.7 recovery", () => {
    const btmp = mkdtempSync(join(tmpdir(), "backfill-"));
    after(() => { try {
        rmSync(btmp, { recursive: true, force: true });
    }
    catch { } });
    function makeOrphan(id, taskPrompts) {
        const dir = join(btmp, "runs", id);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "tasks.json"), JSON.stringify({
            tasks: taskPrompts.map(p => ({ prompt: p })),
        }));
        return dir;
    }
    it("backfills a pre-1.11.7 orphan (tasks.json but no run.json)", () => {
        const dir = makeOrphan("2026-04-12T13-03-57", [
            "First substantial task written by orchestrate agent",
            "Second substantial task written by orchestrate agent",
            "Third substantial task written by orchestrate agent",
        ]);
        const count = backfillOrphanedPlans(btmp, cwd);
        assert.ok(count >= 1, "should backfill at least one");
        const state = loadRunState(dir);
        assert.ok(state, "run.json should now exist");
        assert.equal(state.phase, "planning");
        assert.equal(state.budget, 3);
        assert.equal(state.cwd, cwd);
        assert.match(state.objective, /recovered/);
        // Timestamp parsed from dir name
        assert.equal(state.startedAt, "2026-04-12T13:03:57.000Z");
    });
    it("is idempotent  -- does not re-write existing run.json", () => {
        // The previous test already backfilled 2026-04-12T13-03-57
        const dir = join(btmp, "runs", "2026-04-12T13-03-57");
        const before = loadRunState(dir);
        assert.ok(before);
        // Mutate state so we can detect if it's overwritten
        before.accCompleted = 999;
        saveRunState(dir, before);
        const count = backfillOrphanedPlans(btmp, cwd);
        assert.equal(count, 0, "should not backfill already-populated runs");
        const after2 = loadRunState(dir);
        assert.equal(after2.accCompleted, 999, "existing state should be preserved");
    });
    it("skips runs without tasks.json", () => {
        const dir = join(btmp, "runs", "2026-04-09T08-00-00");
        mkdirSync(dir, { recursive: true });
        // designs only, no tasks.json
        mkdirSync(join(dir, "designs"));
        writeFileSync(join(dir, "designs", "focus-0.md"), "# design doc");
        const count = backfillOrphanedPlans(btmp, cwd);
        assert.equal(count, 0);
        assert.equal(loadRunState(dir), null, "no run.json should be written");
    });
    it("skips runs with empty tasks array", () => {
        makeOrphan("2026-04-08T10-00-00", []);
        const count = backfillOrphanedPlans(btmp, cwd);
        assert.equal(count, 0);
    });
    it("the backfilled run is then visible to findIncompleteRuns", () => {
        // 2026-04-12T13-03-57 was backfilled in the first test
        const runs = findIncompleteRuns(btmp, cwd);
        const found = runs.find(r => r.dir.endsWith("2026-04-12T13-03-57"));
        assert.ok(found, "backfilled run should be surfaced by findIncompleteRuns");
        assert.equal(found.state.phase, "planning");
    });
});
