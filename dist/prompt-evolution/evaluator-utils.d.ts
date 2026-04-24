/**
 * Small shared helpers used by both evaluator.ts and evaluator-judge.ts.
 * Extracted to break the import cycle that would otherwise form between
 * the two (both call averageDimensions, judge also needs gmean aggregates).
 */
import type { ScoreDimensions } from "./types.js";
export declare function averageDimensions(scores: ScoreDimensions[]): ScoreDimensions;
