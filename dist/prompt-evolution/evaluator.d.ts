/**
 * Evaluation matrix runner.
 *
 * rows    = variants
 * columns = cases (optionally × models)
 * cells   = EvaluationResult with multi-dimensional scores
 *
 * Repetitions (N) give us a noise floor: the same (variant, case) is run N
 * times and results aggregate to mean + stddev. Without this we can't tell
 * whether 56.7 vs 37.4 is signal or variance.
 *
 * Multi-model runs (models[].length > 1) give us cross-model stddev: a
 * prompt that only works on one generator is fragile.
 *
 * All HTTP calls go through `transport.callModel` so tests can inject a
 * deterministic mock (see prompt-evolution-discrimination.test.ts).
 */
import { type JudgeOpts } from "./llm-judge.js";
import { type CallModel } from "./transport.js";
import type { BenchmarkCase, VariantRow, PromptVars } from "./types.js";
export interface EvalOpts {
    /** Primary generator model (retained for single-model compat). */
    model: string;
    /** Multiple generator models — enables cross-model scoring. Overrides `model` when ≥2 entries. */
    models?: string[];
    /** Base URL for the API endpoint */
    baseUrl?: string;
    /** Auth token */
    authToken?: string;
    /** Max tokens per evaluation */
    maxTokens?: number;
    /** Concurrency for parallel case evaluation */
    concurrency?: number;
    /** Per-call HTTP timeout. Defaults to 120s — bad endpoints can hang otherwise. */
    timeoutMs?: number;
    /** Repetitions per (variant, case, model). Default 1 — opt-in to 3+ for noise floor. */
    repetitions?: number;
    /**
     * Adaptive sampling: after initial `repetitions`, keep adding one rep per cell
     * where any score-dim σ exceeds `threshold`, up to `cap` total reps. Prevents
     * wasted reps on already-stable cells while driving noisy ones down.
     */
    adaptiveReps?: {
        cap: number;
        threshold?: number;
    };
    /** Inject an llm-judge call per case; content dimension is replaced by judge score. */
    judge?: JudgeOpts & {
        topN?: number;
    };
    /** Transport override for tests. */
    callModel?: CallModel;
    /** Optional callback for progress */
    onProgress?: (done: number, total: number, caseName: string, variantId: string) => void;
}
export declare function buildMatrix(variants: Array<{
    id: string;
    promptPath: string;
    generation: number;
    text: string;
}>, cases: BenchmarkCase[], opts: EvalOpts): Promise<VariantRow[]>;
/** Render a prompt variant given its source path and optional variant name */
export declare function renderVariant(promptPath: string, variant: string | undefined, vars: PromptVars): string;
