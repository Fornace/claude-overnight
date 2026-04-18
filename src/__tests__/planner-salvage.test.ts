import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { salvageFromFile } from "../planner/planner.js";

// Regression test for 1.11.x plan-phase loss-of-work:
// `runPlannerQuery` can throw "Planner query failed after retries" after the
// orchestrate agent already wrote a valid tasks.json via its Write tool.
// Before the fix, those tasks were discarded. `salvageFromFile` recovers them.

const tmp = mkdtempSync(join(tmpdir(), "planner-salvage-"));
const logs: string[] = [];
const onLog = (text: string) => { logs.push(text); };

after(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

function writeTasks(name: string, content: string): string {
  const p = join(tmp, name);
  writeFileSync(p, content);
  return p;
}

describe("salvageFromFile", () => {
  it("returns null when outFile is undefined", () => {
    assert.equal(salvageFromFile(undefined, 10, onLog, "x"), null);
  });

  it("returns null when file does not exist", () => {
    assert.equal(salvageFromFile(join(tmp, "nope.json"), 10, onLog, "x"), null);
  });

  it("returns null when file is not JSON", () => {
    const p = writeTasks("garbage.json", "not json at all");
    assert.equal(salvageFromFile(p, 10, onLog, "x"), null);
  });

  it("returns null when tasks array is empty", () => {
    const p = writeTasks("empty.json", JSON.stringify({ tasks: [] }));
    assert.equal(salvageFromFile(p, 10, onLog, "x"), null);
  });

  it("recovers valid tasks from on-disk JSON", () => {
    const p = writeTasks("good.json", JSON.stringify({
      tasks: [
        { prompt: "Refactor the auth middleware to use JWT verification" },
        { prompt: "Add integration tests for the payment reconciliation flow" },
        { prompt: "Optimize the project detail endpoint with SQL aggregates" },
      ],
    }));
    const result = salvageFromFile(p, 10, onLog, "Planner query failed after retries");
    assert.ok(result, "should salvage tasks");
    assert.equal(result!.length, 3);
    // post-processed: ids assigned sequentially
    assert.deepEqual(result!.map(t => t.id), ["0", "1", "2"]);
  });

  it("accepts string-form task entries", () => {
    const p = writeTasks("strings.json", JSON.stringify({
      tasks: [
        "Refactor the auth middleware completely",
        "Add tests to the payment flow",
      ],
    }));
    const result = salvageFromFile(p, 10, onLog, "x");
    assert.ok(result);
    assert.equal(result!.length, 2);
  });

  it("filters tasks with empty prompts via postProcess but keeps single-word prompts", () => {
    const p = writeTasks("short.json", JSON.stringify({
      tasks: [
        { prompt: "" },
        { prompt: "   " },
        { prompt: "fix" },
        { prompt: "implement new feature properly end-to-end" },
      ],
    }));
    const result = salvageFromFile(p, 10, onLog, "x");
    assert.ok(result);
    assert.equal(result!.length, 2);
    assert.deepEqual(result!.map(t => t.prompt), ["fix", "implement new feature properly end-to-end"]);
  });

  it("logs a salvage event when recovery succeeds", () => {
    logs.length = 0;
    const p = writeTasks("logged.json", JSON.stringify({
      tasks: [{ prompt: "Rebuild the gantt chart rendering pipeline" }],
    }));
    const result = salvageFromFile(p, 10, onLog, "Planner query failed after retries");
    assert.ok(result);
    const hit = logs.find(l => l.includes("salvaged") && l.includes("Planner query failed after retries"));
    assert.ok(hit, `expected salvage log line  -- got: ${logs.join(" | ")}`);
  });
});
