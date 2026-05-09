/**
 * Harvest real objectives from past claude-overnight runs to build
 * benchmark cases from ground truth instead of synthetic ones.
 *
 * Source: <cwd>/.claude-overnight/runs/<runId>/
 *   - goal.md     — the original objective the user ran with
 *   - state.json  — RunState: phase ("done"/"capped"/"stopped"), accCompleted, budget
 *
 * Coarse fitness signal: `state.phase === "done"` and accCompleted/budget
 * close to 1 means the user kept running to completion — the plan was
 * actionable. Cases with "stopped" phase are likely broken plans.
 *
 * We do NOT pretend to have a per-case ground-truth plan. The harvested
 * cases are meant to be scored with the llm-judge: real objective + a
 * heuristic that the run actually finished.
 */

import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { BenchmarkCase } from "../types.js";
import { readFileOrEmpty, readJsonOrNull } from "../../core/fs-helpers.js";

export interface HarvestOpts {
  /** Repo root — harvest looks under <cwd>/.claude-overnight/runs/ */
  cwd: string;
  /** Which promptPath to target in the generated cases. */
  promptPath: string;
  /** Variant to attach to every harvested case. Default: STANDARD. */
  variant?: string;
  /** Max cases to return (newest first). */
  limit?: number;
  /** Only include runs whose phase matches — default ["done"] (successful runs). */
  phaseAllowlist?: Array<"done" | "capped" | "stopped" | "planning">;
}

export function harvestRealCases(opts: HarvestOpts): BenchmarkCase[] {
  const runsDir = join(opts.cwd, ".claude-overnight", "runs");
  if (!existsSync(runsDir)) return [];

  const allow = new Set(opts.phaseAllowlist ?? ["done"]);
  const limit = opts.limit ?? 10;
  const variant = opts.variant ?? "STANDARD";

  type Entry = { id: string; objective: string; budget: number; startedAt: string };
  const entries: Entry[] = [];

  for (const id of readdirSync(runsDir)) {
    const runDir = join(runsDir, id);
    const state = readJsonOrNull<{
      phase?: string; budget?: number; startedAt?: string; accCompleted?: number;
    }>(join(runDir, "state.json"));
    if (!state) continue;
    if (state.phase && !allow.has(state.phase as "done" | "capped" | "stopped" | "planning")) continue;
    const objective = extractObjective(readFileOrEmpty(join(runDir, "goal.md")));
    if (!objective) continue;
    entries.push({
      id,
      objective,
      budget: typeof state.budget === "number" && state.budget > 0 ? state.budget : 8,
      startedAt: state.startedAt ?? "",
    });
  }

  entries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return entries.slice(0, limit).map((e) => toCase(e, opts.promptPath, variant));
}

function extractObjective(goalMd: string): string {
  // goal.md is written as "## Original Objective\n<text>" — grab everything
  // under the first header, or fall back to the whole file.
  const m = goalMd.match(/##\s+[^\n]*\n([\s\S]+)$/);
  const body = (m ? m[1] : goalMd).trim();
  return body.slice(0, 2000); // keep cases shaped like the synthetic ones
}

function toCase(e: { id: string; objective: string; budget: number }, promptPath: string, variant: string): BenchmarkCase {
  const c: BenchmarkCase = {
    name: `real:${e.id.slice(0, 12)}`,
    hash: "",
    promptPath,
    variant,
    vars: {
      objective: e.objective,
      budget: e.budget,
      concurrency: Math.min(6, Math.max(2, Math.ceil(e.budget / 2))),
      contextConstraintNote: "Context budget: use the claude-sonnet-4-6 model's context window efficiently.",
    },
    criteria: {
      independentTasks: true,
      specificTasks: false,
      requiredJsonFields: ["tasks"],
    },
  };
  c.hash = hashCase(c);
  return c;
}

function hashCase(c: BenchmarkCase): string {
  const key = `${c.promptPath}:${c.variant ?? "default"}:${JSON.stringify(c.vars)}`;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36).slice(0, 8);
}
