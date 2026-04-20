#!/usr/bin/env node
// One-shot smoke: render every migrated prompt and print head/tail + length.
import { renderPrompt } from "../dist/prompts/load.js";

const cases = [
  ["10_planning/10-1_identify-themes", { vars: { count: 4, objective: "ship feature X" } }],
  ["10_planning/10-2_thinking-tasks", { vars: { theme: "auth", objective: "ship feature X", designDir: ".claude-overnight/latest/designs", index: 0, previousKnowledge: "auth uses sessions" } }],
  ["10_planning/10-2_thinking-tasks", { vars: { theme: "auth", objective: "ship feature X", designDir: ".claude-overnight/latest/designs", index: 0 } }],
  ["10_planning/10-3_plan", { variant: "TIGHT",     vars: { objective: "do X", budget: 5,  concurrency: 3, contextConstraintNote: "(ctx note)" } }],
  ["10_planning/10-3_plan", { variant: "STANDARD",  vars: { objective: "do X", budget: 20, concurrency: 5, flexNote: "wave 1 of N", contextConstraintNote: "(ctx note)" } }],
  ["10_planning/10-3_plan", { variant: "LARGE",     vars: { objective: "do X", budget: 50, concurrency: 8, contextConstraintNote: "(ctx note)" } }],
  ["10_planning/10-4_orchestrate", { vars: { objective: "do X", designDocs: "## Design 1\nX", budget: 10, concurrency: 3, contextConstraintNote: "(ctx note)", flexNote: "wave 1 of N", fileInstruction: "Write to /tmp/x." } }],
  ["10_planning/10-5_refine", { vars: { objective: "do X", previousTasks: "1. Foo\n2. Bar", feedback: "split task 2", scaleNote: "Target ~5 tasks.", concurrency: 3, contextConstraintNote: "(ctx note)" } }],
  ["30_wave/30-2_verify", { vars: { objective: "do X", lastWave: "Wave 1:\n  - [done] Foo (3 files)", pendingTasks: "  1. Bar", concurrency: 3, remainingBudget: 7 } }],
  ["30_wave/30-1_steer", { vars: { objective: "do X", recentText: "Wave 1:\n  - [done] Foo (3 files)", remainingBudget: 7, concurrency: 3, contextConstraintNote: "(ctx note)", waveCount: 1, longArchetypes: true, workerModel: "claude-sonnet-4-5", fastModel: "claude-haiku-4-5" } }],
  ["30_wave/30-1_steer", { vars: { objective: "do X", userGuidance: "focus on auth", goal: "ship", status: "wave 4 done", milestones: "M1\nM2", previousRuns: "before", recentText: "Wave 4:\n  - [done] Foo", designs: "design", reflections: "reflect", verifications: "verify ok", remainingBudget: 7, concurrency: 3, contextConstraintNote: "(ctx note)", waveCount: 4, shortArchetypes: true, workerModel: "claude-sonnet-4-5", fastModel: "claude-haiku-4-5" } }],

  // Phase 2 additions
  ["50_review/50-1_review", { variant: "WAVE" }],
  ["50_review/50-1_review", { variant: "RUN", vars: { objective: "ship X" } }],
  ["50_review/50-2_summary", { vars: { phase: "complete", objective: "ship X", goal: "ship", status: "wave 3 ok", waveCount: 3, reflections: "ok", verifications: "ok" } }],
  ["40_skills/40-2_branch-evaluator", { vars: { task: "refactor login", diff: "+ added foo" } }],
  ["40_skills/40-3_librarian-wrap", { vars: { data: '{"canon":[]}' } }],
  ["20_execution/20-1_simplify", {}],
  ["20_execution/20-3_agent-wrap", { vars: { useWorktrees: true, l0Stub: "L0 hint", recipeStub: "recipe X", allowSkillProposals: true, taskPrompt: "Refactor foo()", postcondition: "pnpm test" } }],
  ["20_execution/20-3_agent-wrap", { vars: { taskPrompt: "Just do X" } }],
  ["00_setup/00-2_coach-wrapper", { variant: "WRAP", vars: { skill: "(skill body)", userMessage: "(facts)" } }],
  ["00_setup/00-2_coach-wrapper", { variant: "AMEND", vars: { previousPrompt: "(prev)", amendment: "make it Y" } }],
  ["_shared/retry-json", { vars: { originalPrompt: "(big planner prompt)" } }],
  ["_shared/non-claude-json-wrap", { vars: { innerPrompt: "(steering prompt body)" } }],
  ["_shared/flex-note", { vars: { remainingBudget: 50 } }],
  ["30_wave/30-3_branch-retry", { vars: { originalTask: "Refactor login flow" } }],
  ["30_wave/30-4_decomposer-minimal", { vars: { objective: "ship X", status: "wave 3 ok" } }],
  ["30_wave/30-4_decomposer-minimal", { vars: { status: "(none)" } }],
  ["30_wave/30-5_auto-verify", {}],
  ["30_wave/30-6_retry-suffix", { variant: "POSTFAILED", vars: { taskPrompt: "Build foo", postcondition: "pnpm test", output: "FAIL: x" } }],
  ["30_wave/30-6_retry-suffix", { variant: "NOFILES", vars: { taskPrompt: "Build foo" } }],
  ["30_wave/30-7_steer-retry", { vars: { snippet: "{not parseable}" } }],
  ["60_runtime/60-1_ask", { vars: { context: "Objective: X", question: "what's done?" } }],
  ["60_runtime/60-2_debrief", { vars: { label: "Wave 3 done.", context: "Objective: X" } }],
  ["60_runtime/60-3_plan-chat", { variant: "THEMES", vars: { objective: "X", themesList: "1. auth\n2. ui", question: "why?" } }],
  ["60_runtime/60-3_plan-chat", { variant: "TASKS", vars: { objective: "X", tasksList: "1. Foo\n2. Bar", question: "why?" } }],
  ["60_runtime/60-4_build-fix", { variant: "FILE", vars: { file: "src/foo.ts", cmd: "pnpm typecheck", errors: "TS2304: Cannot find name" } }],
  ["60_runtime/60-4_build-fix", { variant: "ALL", vars: { cmd: "pnpm build", errors: "TS2304" } }],
];

let pass = 0, fail = 0;
for (const [file, opts] of cases) {
  try {
    const out = renderPrompt(file, opts);
    const head = out.split("\n").slice(0, 2).join(" ⏎ ");
    const tail = out.split("\n").slice(-2).join(" ⏎ ");
    console.log(`✓ ${file}${opts.variant ? ` [${opts.variant}]` : ""} (${out.length} chars)`);
    console.log(`  head: ${head.slice(0, 90)}`);
    console.log(`  tail: ${tail.slice(-90)}`);
    // Sanity assertions
    if (out.includes("{{")) { console.log(`  ⚠ unfilled placeholder found`); fail++; continue; }
    if (out.includes("<!--")) { console.log(`  ⚠ unstripped HTML comment`); fail++; continue; }
    pass++;
  } catch (err) {
    console.log(`✗ ${file}${opts.variant ? ` [${opts.variant}]` : ""}: ${err.message}`);
    fail++;
  }
}
console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
