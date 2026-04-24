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
import type { BenchmarkCase } from "../types.js";
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
export declare function harvestRealCases(opts: HarvestOpts): BenchmarkCase[];
