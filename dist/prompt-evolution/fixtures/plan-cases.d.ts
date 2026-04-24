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
export declare const PLAN_CASES: BenchmarkCase[];
