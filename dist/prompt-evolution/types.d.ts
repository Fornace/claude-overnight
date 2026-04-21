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
    /** Expected task count (for planner prompts). null = don't check */
    expectedTaskCount?: number | null;
    /** Allowed deviation from expectedTaskCount (default 0.25 = ±25%) */
    taskCountTolerance?: number;
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
}
/** Row in the evaluation matrix: one variant across all cases */
export interface VariantRow {
    variantId: string;
    promptPath: string;
    generation: number;
    parentId?: string;
    /** Full prompt text */
    text: string;
    /** caseHash → result */
    results: Map<string, EvaluationResult>;
    /** Aggregated Pareto fitness vector */
    aggregate: ScoreDimensions;
    /** Overall scalar for quick sorting (geometric mean of dimensions) */
    gmean: number;
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
