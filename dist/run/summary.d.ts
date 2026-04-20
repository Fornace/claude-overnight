import type { BranchRecord, WaveSummary } from "../core/types.js";
export interface FinalNarrativeDeps {
    cwd: string;
    runDir: string;
    objective?: string;
    previousKnowledge: string;
    workerModel: string;
    fastModel?: string;
    waveHistory: WaveSummary[];
}
/** Generate a longer narrative summary at run end. Awaited (not fire-and-forget)
 *  because the caller wants the text inline in the final status block. */
export declare function generateFinalNarrative(deps: FinalNarrativeDeps, phase: string): Promise<string>;
export type ExitReason = "done" | "budget-exhausted" | "user-interrupted" | "planner-gave-up" | "circuit-breaker" | "stalled";
export interface SummaryArgs {
    runDir: string;
    runBranch?: string;
    objective?: string;
    waveNum: number;
    runStartedAt: number;
    branches: BranchRecord[];
    waveHistory: WaveSummary[];
    accCost: number;
    accCompleted: number;
    accFailed: number;
    accTools: number;
    accIn: number;
    accOut: number;
    remaining: number;
    lastCapped: boolean;
    lastAborted: boolean;
    stopping: boolean;
    trulyDone: boolean;
    exitReason: ExitReason;
    peakWorkerCtxTokens: number;
    peakWorkerCtxPct: number;
    currentSwarmLogFile?: string;
    narrativeDeps: FinalNarrativeDeps;
}
export declare function printFinalSummary(args: SummaryArgs): Promise<void>;
