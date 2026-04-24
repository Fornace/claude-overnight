/**
 * Small shared helpers used by both evaluator.ts and evaluator-judge.ts.
 * Extracted to break the import cycle that would otherwise form between
 * the two (both call averageDimensions, judge also needs gmean aggregates).
 */

import type { ScoreDimensions } from "./types.js";

export function averageDimensions(scores: ScoreDimensions[]): ScoreDimensions {
  if (scores.length === 0) return { parse: 0, schema: 0, content: 0, costEfficiency: 0, speed: 0 };
  const n = scores.length;
  return {
    parse: scores.reduce((a, b) => a + b.parse, 0) / n,
    schema: scores.reduce((a, b) => a + b.schema, 0) / n,
    content: scores.reduce((a, b) => a + b.content, 0) / n,
    costEfficiency: scores.reduce((a, b) => a + b.costEfficiency, 0) / n,
    speed: scores.reduce((a, b) => a + b.speed, 0) / n,
  };
}
