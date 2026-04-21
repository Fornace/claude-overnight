/**
 * Evaluation matrix runner.
 *
 * Given a set of prompt variants and benchmark cases, produces a matrix:
 *   rows    = variants
 *   columns = cases
 *   cells   = EvaluationResult with multi-dimensional scores
 *
 * Uses direct HTTP fetch (not the full Agent SDK) so it's fast and works with
 * any Anthropic-compatible endpoint (OpenRouter, local proxies, etc.).
 */
import type { BenchmarkCase, VariantRow, PromptVars } from "./types.js";
export interface EvalOpts {
    /** Model to run evaluations with. Should be fast/cheap (haiku, flash, etc.) */
    model: string;
    /** Base URL for the API endpoint */
    baseUrl?: string;
    /** Auth token */
    authToken?: string;
    /** Max tokens per evaluation */
    maxTokens?: number;
    /** Concurrency for parallel case evaluation */
    concurrency?: number;
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
