/**
 * Prompt evolution orchestration.
 *
 * Usage (programmatic):
 *   import { evolvePrompt } from "./prompt-evolution/index.js";
 *   await evolvePrompt({
 *     promptPath: "10_planning/10-3_plan",
 *     cases: PLAN_CASES,
 *     model: "claude-haiku-4-5",
 *     generations: 3,
 *   });
 *
 * The loop:
 *   1. Seed population from existing prompt variants (TIGHT, STANDARD, LARGE)
 *   2. Evaluate all variants against all cases → matrix
 *   3. Curate: keep elites + diverse variants
 *   4. Mutate worst-performing variants using failure traces
 *   5. Repeat
 */
import type { JudgeOpts } from "./llm-judge.js";
import type { BenchmarkCase, EvolutionResult } from "./types.js";
export interface EvolveOpts {
    /** Prompt file path, e.g. "10_planning/10-3_plan" or "mcp-browser/planning" */
    promptPath: string;
    /** Benchmark cases to evaluate against */
    cases: BenchmarkCase[];
    /** Model for evaluation (fast/cheap) */
    evalModel: string;
    /** Model for mutation (can be smarter) */
    mutateModel?: string;
    /** Number of evolution generations */
    generations?: number;
    /** Population size cap */
    populationCap?: number;
    /** Stop early if no improvement for N generations (default: 3) */
    plateauGenerations?: number;
    /** Current canon gmean (0 if none) */
    canonGmean?: number;
    /** Optional logging callback */
    onLog?: (text: string) => void;
    /** Base URL override */
    baseUrl?: string;
    /** Auth token override */
    authToken?: string;
    /** Optional seed prompt text (for non-file prompts like MCP-browser) */
    seedText?: string;
    /** Target project label for persistence */
    target?: string;
    /** Run ID override (auto-generated if omitted) */
    runId?: string;
    /** Extra eval models for cross-model variance. If set, every case runs on each model. */
    evalModels?: string[];
    /** Repetitions per (variant, case, model). Default 1. Recommended ≥3 for noise floor. */
    repetitions?: number;
    /** Max in-flight eval calls. Default 8. Raise for slow endpoints, lower for strict rate limits. */
    concurrency?: number;
    /** Adaptive sampling cap (opt-in). Keeps adding reps to noisy cells up to this count. */
    adaptiveReps?: {
        cap: number;
        threshold?: number;
    };
    /**
     * Fraction of cases to hold out for a post-evolution validation eval.
     * When > 0 and < 1: evolution (mutation + curation) sees only the
     * train side; the final reported numbers are on the held-out test
     * side, which fixes the selection bias in "best gmean after picking
     * the best". Split is deterministic by case hash, so the same case
     * always lands on the same side across reruns.
     */
    testFraction?: number;
    /** Optional llm-judge — replaces the heuristic content score for top-N variants each gen. */
    judge?: JudgeOpts & {
        topN?: number;
    };
}
export declare function evolvePrompt(opts: EvolveOpts): Promise<EvolutionResult>;
