/**
 * Benchmark fixtures for the planner prompt (10_planning/10-3_plan).
 *
 * Each case renders the prompt with `vars`, sends it to a generator model, and
 * scores the JSON output. The deterministic scorer checks parse / schema /
 * budget-band / independence / specificity. When an llm-judge is enabled the
 * judge reads objective + output and overrides the content dimension.
 *
 * We deliberately do NOT encode expected task counts: those were author-guessed
 * and made the benchmark circular (high score == "matches Francesco's intuition").
 * The case's `vars.budget` already tells the model how many tasks to produce; an
 * output that's empty or 5× over budget is a prompt failure we catch on the
 * content dim, everything in between is the judge's call.
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
      independentTasks: true,
      specificTasks: false,
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
      independentTasks: true,
      specificTasks: false,
      requiredJsonFields: ["tasks"],
    },
  },
  // ── Failure-mode cases ──
  // A good planner prompt shouldn't collapse on these. A bad one will either
  // invent tasks out of thin air or return garbage.
  {
    name: "failure-ambiguous-noun",
    hash: "",
    promptPath: "10_planning/10-3_plan",
    variant: "STANDARD",
    vars: {
      // "dashboard" could mean the admin dashboard or the analytics dashboard;
      // a good prompt asks or splits; a bad one picks wrong.
      objective: "Improve the dashboard.",
      budget: 6,
      concurrency: 3,
      contextConstraintNote: contextConstraintNote("claude-sonnet-4-6"),
    },
    criteria: {
      independentTasks: true,
      specificTasks: false,
      requiredJsonFields: ["tasks"],
    },
  },
  {
    name: "failure-already-done",
    hash: "",
    promptPath: "10_planning/10-3_plan",
    variant: "TIGHT",
    vars: {
      // A good prompt should notice and produce few or zero tasks. A bad one
      // invents redundant work to hit the budget.
      objective: "Add TypeScript types to src/index.ts (the file already has full typings).",
      budget: 4,
      concurrency: 2,
      contextConstraintNote: contextConstraintNote("claude-sonnet-4-6"),
    },
    criteria: {
      independentTasks: true,
      specificTasks: true,
      requiredJsonFields: ["tasks"],
    },
  },
  {
    name: "failure-crosscut",
    hash: "",
    promptPath: "10_planning/10-3_plan",
    variant: "STANDARD",
    vars: {
      // Genuinely cross-cutting — the independence heuristic will be stressed.
      // A well-designed prompt should admit sequence where it's real instead
      // of faking independence.
      objective: "Introduce a request-id header: generate in middleware, propagate to downstream services, log in every request line, expose in error responses, and cover with integration tests.",
      budget: 9,
      concurrency: 3,
      contextConstraintNote: contextConstraintNote("claude-sonnet-4-6"),
    },
    criteria: {
      independentTasks: false, // real dependencies exist here
      specificTasks: true,
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
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) - h + key.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36).slice(0, 8);
}
