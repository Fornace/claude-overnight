import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scoreOutput, gmean } from "../prompt-evolution/scorer.js";
import { curate, formatMatrix } from "../prompt-evolution/curator.js";
import type { BenchmarkCase, VariantRow, ScoreDimensions } from "../prompt-evolution/types.js";

describe("scorer", () => {
  const baseCase: BenchmarkCase = {
    name: "test",
    hash: "abc123",
    promptPath: "10_planning/10-3_plan",
    variant: "TIGHT",
    vars: { objective: "fix bug", budget: 5 },
    criteria: {
      independentTasks: true,
      specificTasks: true,
      requiredJsonFields: ["tasks"],
    },
  };

  it("scores perfect output at 1.0 across content heuristics", () => {
    const raw = JSON.stringify({ tasks: [
      { prompt: "Fix off-by-one in src/paginate.ts line 42" },
      { prompt: "Add test for src/paginate.test.ts covering edge cases" },
      { prompt: "Update docs in src/paginate.md" },
      { prompt: "Run pnpm test in src/ folder" },
      { prompt: "Verify fix in src/staging.ts" },
    ]});
    const parsed = JSON.parse(raw);
    const result = scoreOutput(raw, parsed, 0.001, 2000, baseCase);

    assert.equal(result.scores.parse, 1);
    assert.equal(result.scores.schema, 1);
    assert.ok(result.scores.content >= 0.79, `content should be high, got ${result.scores.content}`);
    assert.equal(result.notes.length, 0);
  });

  it("penalizes empty task array even with valid schema (budget sanity)", () => {
    const raw = JSON.stringify({ tasks: [] });
    const parsed = JSON.parse(raw);
    const result = scoreOutput(raw, parsed, 0.001, 2000, baseCase);

    assert.equal(result.scores.parse, 1);
    assert.equal(result.scores.schema, 1);
    assert.ok(result.scores.content < 1, `content should be penalized, got ${result.scores.content}`);
    assert.ok(result.notes.some((n) => n.includes("Empty tasks")));
  });

  it("penalizes task count that vastly exceeds budget", () => {
    const tasks = Array.from({ length: 50 }, (_, i) => ({ prompt: `task ${i} in src/file${i}.ts` }));
    const raw = JSON.stringify({ tasks });
    const parsed = JSON.parse(raw);
    const result = scoreOutput(raw, parsed, 0.001, 2000, baseCase);

    assert.ok(result.scores.content < 0.8, `content should be penalized for 50 tasks vs budget=5, got ${result.scores.content}`);
    assert.ok(result.notes.some((n) => n.includes("vastly exceeds budget")));
  });

  it("penalizes dependent tasks", () => {
    const raw = JSON.stringify({ tasks: [
      { prompt: "Refactor auth module" },
      { prompt: "After auth refactor, update tests" },
    ]});
    const parsed = JSON.parse(raw);
    const result = scoreOutput(raw, parsed, 0.001, 2000, baseCase);

    assert.ok(result.scores.content < 1);
    assert.ok(result.notes.some((n) => n.includes("dependencies")));
  });

  it("scores invalid JSON at zero", () => {
    const result = scoreOutput("not json", null, 0.001, 2000, baseCase);
    assert.equal(result.scores.parse, 0);
    assert.equal(result.scores.schema, 0);
    assert.equal(result.scores.content, 0);
  });

  it("computes geometric mean", () => {
    const scores: ScoreDimensions = { parse: 1, schema: 1, content: 1, costEfficiency: 1, speed: 1 };
    assert.equal(gmean(scores), 1);

    const half: ScoreDimensions = { parse: 0.5, schema: 0.5, content: 0.5, costEfficiency: 0.5, speed: 0.5 };
    assert.equal(gmean(half), 0.5);
  });
});

describe("curator", () => {
  function makeRow(id: string, g: number, scores: Partial<ScoreDimensions> = {}): VariantRow {
    const s: ScoreDimensions = {
      parse: scores.parse ?? g,
      schema: scores.schema ?? g,
      content: scores.content ?? g,
      costEfficiency: scores.costEfficiency ?? g,
      speed: scores.speed ?? g,
    };
    return {
      variantId: id,
      promptPath: "test",
      generation: 0,
      text: "",
      results: new Map(),
      aggregate: s,
      gmean: g,
    };
  }

  it("promotes the best variant when above threshold", () => {
    const rows = [
      makeRow("a", 0.9),
      makeRow("b", 0.7),
      makeRow("c", 0.5),
    ];
    const d = curate(rows, 0.85, { eliteCount: 2, diversityCount: 0 });
    assert.ok(d.promoted.includes("a"));
    assert.ok(d.kept.includes("a"));
    assert.ok(d.quarantined.includes("c"));
  });

  it("does not promote if improvement is below threshold", () => {
    const rows = [makeRow("a", 0.86)];
    const d = curate(rows, 0.85);
    assert.equal(d.promoted.length, 0);
    assert.ok(d.kept.includes("a"));
  });

  it("keeps diverse variants via novelty", () => {
    const rows = [
      makeRow("a", 0.9, { parse: 1, schema: 0.8, content: 0.9, costEfficiency: 0.9, speed: 0.9 }),
      makeRow("b", 0.85, { parse: 0.8, schema: 1, content: 0.8, costEfficiency: 0.9, speed: 0.9 }),
      makeRow("c", 0.5, { parse: 0.5, schema: 0.5, content: 0.5, costEfficiency: 0.5, speed: 0.5 }),
    ];
    const d = curate(rows, 0, { eliteCount: 1, diversityCount: 1 });
    // a is elite, b should be kept for diversity because it trades parse for schema
    assert.ok(d.kept.includes("a"));
    assert.ok(d.kept.includes("b"));
    assert.ok(d.quarantined.includes("c"));
  });

  it("formats matrix without crashing", () => {
    const rows = [
      makeRow("variant-one", 0.85),
      makeRow("variant-two", 0.72),
    ];
    const out = formatMatrix(rows, ["case-a", "case-b"]);
    assert.ok(out.includes("variant-one"));
    assert.ok(out.includes("85.0"));
  });
});
