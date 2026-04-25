/**
 * Persistence layer for prompt-evolution runs.
 *
 * Each run gets its own directory under the store root:
 *   ~/.claude-overnight/prompt-evolution/<runId>/
 *     meta.json        — run configuration, timestamps
 *     matrix.jsonl     — one line per variant (full evaluation matrix)
 *     learning.jsonl   — mutation history with fitness deltas
 *     best.md          — human-readable report of the best variant
 *     prompts/         — snapshot of every prompt variant tested
 *
 * This makes every run fully inspectable after the fact and enables
 * longitudinal analysis ("did our planner prompts get better over time?").
 */
import type { VariantRow, LearningEntry, EvolutionResult } from "./types.js";
export interface RunMeta {
    runId: string;
    promptPath: string;
    target: string;
    evalModel: string;
    mutateModel: string;
    generations: number;
    populationCap: number;
    startedAt: string;
    finishedAt?: string;
    status: "running" | "done" | "failed";
    caseNames: string[];
}
export declare function runDir(runId: string): string;
/** Initialise a new run directory and write meta.json. */
export declare function initRun(meta: RunMeta): string;
/** Append a generation's matrix to matrix.jsonl. */
export declare function appendMatrix(runId: string, generation: number, rows: VariantRow[]): void;
/** Append learning entries. */
export declare function appendLearning(runId: string, entries: LearningEntry[]): void;
/** Snapshot every prompt variant text to prompts/<variantId>.md. */
export declare function snapshotPrompts(runId: string, rows: VariantRow[]): void;
/** Finalise the run: write best.md and update meta.json. */
export declare function finalizeRun(runId: string, result: EvolutionResult, metaPartial?: Partial<RunMeta>): void;
/** List all runs, newest first. */
export declare function listRuns(): Array<{
    runId: string;
    meta: RunMeta;
}>;
/** Read a full run for inspection. */
export declare function loadRun(runId: string): {
    meta: RunMeta;
    matrix: unknown[];
    learning: unknown[];
    bestMd: string;
};
