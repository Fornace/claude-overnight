/**
 * LLM-judge pass over a built evaluation matrix.
 *
 * Split out of evaluator.ts to keep each file under the 500-line cap and
 * because the judge has its own concerns (top-N eligibility, batch vs
 * online path, crash-resumable state).
 *
 * The judge REPLACES the heuristic content score with a semantic grade.
 * We only judge top-N variants per generation to cap cost — a judge call
 * per (variant, case, model) on a large population explodes fast.
 */
import { type JudgeOpts } from "./llm-judge.js";
import type { BenchmarkCase, EvaluationResult } from "./types.js";
import type { EvalOpts } from "./evaluator.js";
export declare function runJudge(variants: Array<{
    id: string;
    text: string;
}>, cases: BenchmarkCase[], models: string[], aggregated: Map<string, EvaluationResult>, judge: JudgeOpts & {
    topN?: number;
}, opts: EvalOpts): Promise<void>;
