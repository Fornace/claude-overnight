/**
 * LLM-as-judge scoring for prompt evolution.
 *
 * Inspired by Hermes Agent's autoresearch skill and self-evolution repo:
 *   - Structured rubric (5 criteria × 1-5 scale, normalised to 0-1)
 *   - The judge sees the prompt, the case, and the model's raw output
 *   - Returns both a scalar score and human-readable justification
 *
 * When to use:
 *   - Content criteria that are too fuzzy for deterministic regex
 *     (e.g. "was the plan creative?", "did the response follow the spirit of the prompt?")
 *   - Final validation gate before promoting a variant to canon
 *
 * Cost: ~1 judge call per case per generation (~$0.002-0.01 each).
 */
import type { BenchmarkCase, ScoreDimensions } from "./types.js";
export interface JudgeOpts {
    model: string;
    baseUrl?: string;
    authToken?: string;
    maxTokens?: number;
    timeoutMs?: number;
}
export interface JudgeResult {
    /** 0-1 overall quality score */
    score: number;
    /** Dimension breakdown matching ScoreDimensions keys */
    dimensions: Partial<ScoreDimensions>;
    /** Human-readable rubric justification */
    justification: string;
}
/**
 * Score a single (case, output) pair with an LLM judge.
 *
 * The judge prompt is carefully structured to be reproducible:
 *   - Exact rubric with 1-5 Likert scale definitions
 *   - One-shot example in the prompt text
 *   - Forced JSON output schema
 */
export declare function judgeOutput(rawOutput: string, c: BenchmarkCase, opts: JudgeOpts): Promise<JudgeResult>;
export declare function buildJudgePrompt(rawOutput: string, c: BenchmarkCase): string;
export declare function parseJudgeOutput(raw: string): JudgeResult;
