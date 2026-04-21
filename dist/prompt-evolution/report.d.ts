/**
 * Markdown report generator for prompt-evolution runs.
 *
 * Generates a structured report similar to Hermes autoresearch:
 *   - Executive summary with best variant metrics
 *   - Per-generation matrix breakdown
 *   - Learning log with fitness deltas
 *   - Prompt diff (best vs baseline)
 *   - Actionable recommendations
 */
import type { VariantRow, EvolutionResult } from "./types.js";
export interface ReportOpts {
    runId: string;
    promptPath: string;
    target: string;
    evalModel: string;
    generations: number;
    baselineText?: string;
}
export declare function generateReport(opts: ReportOpts, result: EvolutionResult, generationMatrices: VariantRow[][]): string;
