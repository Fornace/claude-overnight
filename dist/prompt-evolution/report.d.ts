/**
 * Markdown report generator for prompt-evolution runs.
 *
 * Design: make generator artefacts (JSON discipline, noise) legible so the
 * reader can't mistake a Kimi-can't-JSON failure for a bad prompt.
 *   - parse/schema/content as top-level columns, not buried in gmean
 *   - per-case stddev when reps>1 (noise floor)
 *   - per-model breakdown + cross-model stddev when multi-model
 *   - explicit parse-failure count per variant
 */
import type { VariantRow, EvolutionResult } from "./types.js";
export interface ReportOpts {
    runId: string;
    promptPath: string;
    target: string;
    evalModel: string;
    evalModels?: string[];
    repetitions?: number;
    generations: number;
    baselineText?: string;
}
export declare function generateReport(opts: ReportOpts, result: EvolutionResult, generationMatrices: VariantRow[][], testMatrix?: VariantRow[]): string;
