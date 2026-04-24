/**
 * Prompt evolution — types for benchmarking, scoring, and iterating prompt variants.
 *
 * Design goals:
 * - Multi-objective scoring (accuracy, cost, parse reliability) so we don't over-fit
 *   to a single metric.
 * - Deterministic case hashes so the same (prompt, case) pair is always identifiable.
 * - Minimal dependencies on the rest of the codebase so the module is testable in
 *   isolation.
 */
export interface PromptVars {
    [key: string]: string | number | boolean | undefined | null;
}
export interface BenchmarkCase {
    /** Human-readable label */
    name: string;
    /** Hash of the case inputs (auto-computed) */
    hash: string;
    /** Which prompt file this case targets */
    promptPath: string;
    /** Variant selector, if any */
    variant?: string;
    /** Template variables to render the prompt with */
    vars: PromptVars;
    /** Expected scoring criteria */
    criteria: Criteria;
    /** Optional system prompt override (for non-file prompts like MCP-browser) */
    systemPrompt?: string;
}
export interface Criteria {
    /** Should tasks be independent? (no "after", "then", "depends on") */
    independentTasks?: boolean;
    /** Should tasks mention specific files/functions? */
    specificTasks?: boolean;
    /** Expected JSON schema shape: object with required fields */
    requiredJsonFields?: string[];
}
export interface ScoreDimensions {
    /** 0–1: valid JSON when expected */
    parse: number;
    /** 0–1: output matches required schema fields */
    schema: number;
    /** 0–1: content quality (task count, independence, specificity) */
    content: number;
    /** 1 / (1 + costUsd) — cheaper is better, bounded */
    costEfficiency: number;
    /** 1 / (1 + durationMs/10000) — faster is better, bounded */
    speed: number;
}
export interface EvaluationResult {
    caseHash: string;
    caseName: string;
    variantId: string;
    promptPath: string;
    rawOutput: string;
    parsedOutput: unknown;
    costUsd: number;
    durationMs: number;
    scores: ScoreDimensions;
    /** Human-readable failure notes */
    notes: string[];
    /** Model that generated this output (for multi-model runs). */
    model?: string;
    /** Per-dimension standard deviation across repetitions (only set when reps > 1). */
    stddev?: ScoreDimensions;
    /** Number of repetitions that produced this aggregated result. */
    reps?: number;
    /** Set when an llm-judge was used to compute content. */
    judgeJustification?: string;
}
/** Row in the evaluation matrix: one variant across all cases */
export interface VariantRow {
    variantId: string;
    promptPath: string;
    generation: number;
    parentId?: string;
    /** Full prompt text */
    text: string;
    /** caseHash → result (per-model results keyed by caseHash:model when multi-model) */
    results: Map<string, EvaluationResult>;
    /** Aggregated Pareto fitness vector */
    aggregate: ScoreDimensions;
    /** Overall scalar for quick sorting (geometric mean of dimensions) */
    gmean: number;
    /** Cross-model stddev of gmean, if run on multiple generator models. */
    crossModelStddev?: number;
    /** Per-model aggregates for multi-model runs (model → aggregate dimensions). */
    perModel?: Record<string, ScoreDimensions>;
    /** Count of cases that failed to parse as JSON (orthogonal to content). */
    parseFailures?: number;
    /** Rep-level stddev of gmean. Populated when reps>1. */
    repsStddev?: number;
    /** 95% bootstrap CI for gmean over the case-level samples. */
    gmeanCI?: [low: number, high: number];
    /**
     * Kendall τ of per-variant rankings between first-half and second-half reps.
     * Same value for every row in the generation — it's a matrix-level metric.
     * Only meaningful when reps >= 4 (needs at least 2 per half).
     */
    rankStability?: number;
}
export interface MutationRequest {
    currentText: string;
    promptPath: string;
    failures: FailureTrace[];
    learningLog: LearningEntry[];
    siblingTexts: string[];
}
export interface FailureTrace {
    caseName: string;
    caseHash: string;
    rawOutput: string;
    notes: string[];
    scores: ScoreDimensions;
}
export interface LearningEntry {
    generation: number;
    mutationSummary: string;
    fitnessDelta: number;
    status: "improved" | "regressed" | "neutral";
}
export interface Mutant {
    variantId: string;
    text: string;
    generation: number;
    parentId: string;
    mutationSummary: string;
}
export interface CuratorDecision {
    promoted: string[];
    quarantined: string[];
    kept: string[];
}
export interface EvolutionResult {
    bestVariant: VariantRow;
    allRows: VariantRow[];
    learningLog: LearningEntry[];
    runId: string;
    reportPath?: string;
}
