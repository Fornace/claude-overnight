/**
 * Scoring logic for prompt evolution benchmarks.
 *
 * Goals:
 * - Fast, deterministic, no extra LLM calls for basic criteria.
 * - Multi-dimensional so we don't over-fit to one metric.
 * - Normalised 0–1 so different dimensions are comparable.
 */
import type { BenchmarkCase, ScoreDimensions, EvaluationResult } from "./types.js";
export declare function scoreOutput(raw: string, parsed: unknown, costUsd: number, durationMs: number, c: BenchmarkCase): EvaluationResult;
/** Geometric mean of score dimensions — rewards balanced performance */
export declare function gmean(scores: ScoreDimensions): number;
/** Arithmetic mean for quick human reading */
export declare function amean(scores: ScoreDimensions): number;
