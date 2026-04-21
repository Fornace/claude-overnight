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
export declare const PLAN_CASES: BenchmarkCase[];
