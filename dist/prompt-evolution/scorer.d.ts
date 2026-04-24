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
