/**
 * Scoring logic for prompt evolution benchmarks.
 *
 * Split in three concerns, reported as separate dimensions so a JSON
 * discipline failure never masquerades as a content failure:
 *   parse   — was the output valid JSON (when expected)?
 *   schema  — did the object include the required fields?
 *   content — are the tasks independent / specific / in a sane budget band?
 *
 * Content is the only dimension that can optionally be replaced by an
 * llm-judge score (see llm-judge.ts). Everything else stays deterministic
 * so we can diff runs without paying for a judge call.
 */
import type { BenchmarkCase, ScoreDimensions, EvaluationResult } from "./types.js";
export interface ScoreInputs {
    /** Optional llm-judge output that overrides the deterministic `content` score. */
    judgeContent?: number;
    /** Judge's human-readable justification, attached to the result. */
    judgeJustification?: string;
    /** Model identity for multi-model runs. */
    model?: string;
}
export declare function scoreOutput(raw: string, parsed: unknown, costUsd: number, durationMs: number, c: BenchmarkCase, inputs?: ScoreInputs): EvaluationResult;
/** Geometric mean of score dimensions — rewards balanced performance */
export declare function gmean(scores: ScoreDimensions): number;
/** Arithmetic mean for quick human reading */
export declare function amean(scores: ScoreDimensions): number;
/** Aggregate multiple runs of the same (variant, case) into mean + stddev. */
export declare function aggregateReps(results: EvaluationResult[]): {
    mean: ScoreDimensions;
    stddev: ScoreDimensions;
};
/**
 * Bootstrap 95% confidence interval over a sample. Resamples with
 * replacement `iterations` times, takes the 2.5th and 97.5th percentile
 * of the resampled means. Used to decide whether two variants differ
 * for real or sit within each other's noise.
 */
export declare function bootstrapCI(values: number[], iterations?: number): [low: number, high: number];
/**
 * Paired sign-flip permutation test for the null hypothesis mean(diffs) = 0.
 *
 * More honest than "95% CIs overlap" for ranking variants:
 *   - non-parametric (no normality assumption — important for our bimodal
 *     parse-failure data)
 *   - respects pairing (same case, different variants → paired samples)
 *   - accounts for dependence between within-case outcomes
 *
 * Input: per-case paired differences (variantA_score - variantB_score).
 * Output: two-tailed p-value under H0: mean difference = 0.
 *
 * With `iterations=10000` the p-value has ±0.01 resolution, plenty for
 * the α=0.05 / α=0.01 decision thresholds we care about.
 */
export declare function pairedPermutationTest(diffs: number[], iterations?: number): {
    pValue: number;
    observed: number;
    effectSize: number;
};
/**
 * Kendall τ rank correlation between two same-length orderings of ids.
 * Returns 1.0 for identical rankings, -1.0 for reversed, 0 for random.
 * We use this to check whether splitting the reps in half produces the
 * same per-variant ordering twice — low τ means the benchmark is noise.
 */
export declare function kendallTau(rankA: string[], rankB: string[]): number;
