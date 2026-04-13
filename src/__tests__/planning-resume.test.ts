import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findIncompleteRuns, saveRunState } from "../state.js";
import type { RunState } from "../types.js";

// Regression test for resume visibility of plan-phase runs.
// Before 1.11.7, findIncompleteRuns only returned runs with a run.json, but
// run.json was only written inside executeRun — so a plan-phase failure was
// invisible to the resume picker. 1.11.7 writes an early run.json with
// phase: "planning" and requires tasks.json on disk for it to be surfaced.

const tmp = mkdtempSync(join(tmpdir(), "planning-resume-"));
const cwd = "/fake/workspace";

after(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

function makeRun(id: string): string {
  const dir = join(tmp, "runs", id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function baseState(phase: RunState["phase"]): RunState {
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

describe("findIncompleteRuns — planning phase visibility", () => {
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
    assert.equal(found!.state.phase, "planning");
  });

  it("skips planning-phase runs missing tasks.json", () => {
    const dir = makeRun("2026-04-10T09-00-00");
    saveRunState(dir, baseState("planning"));
    // No tasks.json on disk — nothing to resume
    const runs = findIncompleteRuns(tmp, cwd);
    assert.equal(runs.find(r => r.dir === dir), undefined, "planning run without tasks.json should be filtered");
  });

  it("still surfaces steering-phase runs (existing behavior)", () => {
    const dir = makeRun("2026-04-11T18-00-00");
    saveRunState(dir, { ...baseState("steering"), waveNum: 2, accCost: 12.34 });
    const runs = findIncompleteRuns(tmp, cwd);
    const found = runs.find(r => r.dir === dir);
    assert.ok(found, "steering run should be visible");
    assert.equal(found!.state.phase, "steering");
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
