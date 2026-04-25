/**
 * LLM-judge pass over a built evaluation matrix.
 *
 * The judge REPLACES the heuristic content score with a semantic grade.
 * We only judge top-N variants per generation to cap cost — a judge call
 * per (variant, case, model) on a large population explodes fast.
 */
import { type JudgeOpts } from "./llm-judge.js";
import type { BenchmarkCase, EvaluationResult } from "./types.js";
export declare function runJudge(variants: Array<{
    id: string;
    text: string;
}>, cases: BenchmarkCase[], models: string[], aggregated: Map<string, EvaluationResult>, judge: JudgeOpts & {
    topN?: number;
}): Promise<void>;
