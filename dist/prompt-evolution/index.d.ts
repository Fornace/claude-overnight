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
import type { BenchmarkCase, VariantRow, LearningEntry } from "./types.js";
export interface EvolveOpts {
    /** Prompt file path, e.g. "10_planning/10-3_plan" */
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
    /** Current canon gmean (0 if none) */
    canonGmean?: number;
    /** Optional logging callback */
    onLog?: (text: string) => void;
    /** Base URL override */
    baseUrl?: string;
    /** Auth token override */
    authToken?: string;
}
export interface EvolutionResult {
    bestVariant: VariantRow;
    allRows: VariantRow[];
    learningLog: LearningEntry[];
}
export declare function evolvePrompt(opts: EvolveOpts): Promise<EvolutionResult>;
