/**
 * Benchmark fixtures for the planner prompt (10_planning/10-3_plan).
 *
 * Each case is a synthetic scenario: we render the prompt with these vars,
 * send it to a model, and score the JSON output.
 *
 * Designing good benchmarks:
 * - Cover the three budget tiers (TIGHT, STANDARD, LARGE)
 * - Include edge cases (tiny objective, vague objective, cross-cutting concern)
 * - Make criteria objective enough to auto-score without an LLM judge
 */

import type { BenchmarkCase } from "../types.js";

function contextConstraintNote(model: string): string {
  return `Context budget: use the ${model} model's context window efficiently.`;
}

export const PLAN_CASES: BenchmarkCase[] = [
  {
    name: "tight-bugfix",
    hash: "",
    promptPath: "10_planning/10-3_plan",
    variant: "TIGHT",
    vars: {
      objective: "Fix the off-by-one error in the paginate() function that causes page 0 to show 1 item instead of 10.",
      budget: 5,
      concurrency: 3,
      contextConstraintNote: contextConstraintNote("claude-sonnet-4-6"),
    },
    criteria: {
      expectedTaskCount: 5,
      taskCountTolerance: 0.2,
      independentTasks: true,
      specificTasks: true,
      requiredJsonFields: ["tasks"],
    },
  },
  {
    name: "tight-typo",
    hash: "",
    promptPath: "10_planning/10-3_plan",
    variant: "TIGHT",
    vars: {
      objective: "Rename all occurrences of 'recieve' to 'receive' across the codebase.",
      budget: 3,
      concurrency: 3,
      contextConstraintNote: contextConstraintNote("claude-sonnet-4-6"),
    },
    criteria: {
      expectedTaskCount: 3,
      taskCountTolerance: 0.34, // ±1 for tiny counts
      independentTasks: true,
      specificTasks: true,
      requiredJsonFields: ["tasks"],
    },
  },
  {
    name: "standard-feature",
    hash: "",
    promptPath: "10_planning/10-3_plan",
    variant: "STANDARD",
    vars: {
      objective: "Add a complete user favorites system: database schema, API routes, client hooks, and error handling. Research existing patterns in the codebase first.",
      budget: 12,
      concurrency: 4,
      contextConstraintNote: contextConstraintNote("claude-sonnet-4-6"),
      flexNote: "wave 1 of 2",
    },
    criteria: {
      expectedTaskCount: 12,
      taskCountTolerance: 0.25,
      independentTasks: true,
      specificTasks: false, // missions can be broader
      requiredJsonFields: ["tasks"],
    },
  },
  {
    name: "standard-audit",
    hash: "",
    promptPath: "10_planning/10-3_plan",
    variant: "STANDARD",
    vars: {
      objective: "Audit all existing API routes for consistency, error handling, and input validation. Fix any issues found.",
      budget: 10,
      concurrency: 4,
      contextConstraintNote: contextConstraintNote("claude-sonnet-4-6"),
    },
    criteria: {
      expectedTaskCount: 10,
      taskCountTolerance: 0.25,
      independentTasks: true,
      specificTasks: false,
      requiredJsonFields: ["tasks"],
    },
  },
  {
    name: "large-refactor",
    hash: "",
    promptPath: "10_planning/10-3_plan",
    variant: "LARGE",
    vars: {
      objective: "Migrate the entire frontend from React class components to functional components with hooks. Update tests, stories, and documentation.",
      budget: 35,
      concurrency: 6,
      contextConstraintNote: contextConstraintNote("claude-opus-4-6"),
    },
    criteria: {
      expectedTaskCount: 35,
      taskCountTolerance: 0.2,
      independentTasks: true,
      specificTasks: false,
      requiredJsonFields: ["tasks"],
    },
  },
  {
    name: "large-greenfield",
    hash: "",
    promptPath: "10_planning/10-3_plan",
    variant: "LARGE",
    vars: {
      objective: "Build a complete real-time notification system from scratch: WebSocket server, event bus, deduplication, delivery guarantees, mobile push fallback, and admin dashboard.",
      budget: 40,
      concurrency: 8,
      contextConstraintNote: contextConstraintNote("claude-opus-4-6"),
    },
    criteria: {
      expectedTaskCount: 40,
      taskCountTolerance: 0.2,
      independentTasks: true,
      specificTasks: false,
      requiredJsonFields: ["tasks"],
    },
  },
  {
    name: "standard-vague",
    hash: "",
    promptPath: "10_planning/10-3_plan",
    variant: "STANDARD",
    vars: {
      objective: "Make the app faster.",
      budget: 8,
      concurrency: 4,
      contextConstraintNote: contextConstraintNote("claude-sonnet-4-6"),
    },
    criteria: {
      expectedTaskCount: 8,
      taskCountTolerance: 0.25,
      independentTasks: true,
      specificTasks: false, // vague objective → broader tasks are acceptable
      requiredJsonFields: ["tasks"],
    },
  },
];

// Auto-fill hashes so case identity is stable
for (const c of PLAN_CASES) {
  c.hash = hashCase(c);
}

function hashCase(c: BenchmarkCase): string {
  const key = `${c.promptPath}:${c.variant ?? "default"}:${JSON.stringify(c.vars)}`;
  // Simple stable hash — good enough for local evolution runs
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) - h + key.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36).slice(0, 8);
}
