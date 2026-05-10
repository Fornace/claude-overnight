import type { RunState, BranchRecord, AgentState, RunMemory, WaveSummary } from "../core/types.js";
/** Concatenate every `.md` in `dir` as `### name\n<body>` blocks. Empty if missing. */
export declare function readMdDir(dir: string): string;
export declare function readRunMemory(runDir: string, previousRuns?: string): RunMemory;
/** Read pending .md files in steer-inbox/ (top-level only, not processed/). */
export declare function readSteerInbox(runDir: string): string;
/** Count pending steer files without reading them. */
export declare function countSteerInbox(runDir: string): number;
/** Append a user directive to the inbox as its own timestamped file. Returns the file path. */
export declare function writeSteerInbox(runDir: string, text: string): string;
/** Move all pending .md files from steer-inbox/ into steer-inbox/processed/wave-N/. Returns moved count. */
export declare function consumeSteerInbox(runDir: string, waveNum: number): number;
export declare function writeStatus(baseDir: string, status: string): void;
export declare function writeGoalUpdate(baseDir: string, update: string): void;
export interface OvernightLogStart {
    objective: string;
    model: string;
    budget: number;
    flex: boolean;
    usageCap?: number;
    branch?: string;
}
export interface OvernightLogEnd {
    cost: number;
    completed: number;
    failed: number;
    waves: number;
    phase: string;
    elapsedSec: number;
}
export declare function appendOvernightLogStart(cwd: string, runId: string, meta: OvernightLogStart): void;
export declare function updateOvernightLogEnd(cwd: string, runId: string, meta: OvernightLogEnd): void;
export declare function saveRunState(runDir: string, state: RunState): void;
export declare function loadRunState(runDir: string): RunState | null;
export declare function findIncompleteRuns(rootDir: string, filterCwd: string): {
    dir: string;
    state: RunState;
}[];
export declare function findOrphanedDesigns(rootDir: string): string | null;
/**
 * Backfill run.json for pre-1.11.7 orphaned plans: runs where orchestrate's
 * agent wrote tasks.json via its Write tool but the process died before
 * executeRun ever got to saveRunState. Without this, those runs are invisible
 * to findIncompleteRuns forever.
 *
 * Idempotent: runs with an existing run.json are skipped. Synthesizes a
 * minimal "planning" state from what can be read off disk  -- dir name for
 * timestamp, task count for budget, sane defaults for everything else.
 * The cwd field is set to filterCwd so findIncompleteRuns picks it up on the
 * current project (which is safe  -- rootDir is already scoped to `cwd`).
 */
export declare function backfillOrphanedPlans(rootDir: string, filterCwd: string): number;
export declare function formatTimeAgo(isoStr: string): string;
export declare function showRunHistory(allRuns: {
    dir: string;
    state: RunState;
}[], filterCwd: string, resumable?: {
    dir: string;
}[]): Promise<void>;
export declare function readPreviousRunKnowledge(rootDir: string): string;
export declare function createRunDir(rootDir: string): string;
export declare function updateLatestSymlink(rootDir: string, runDir: string): void;
export declare function saveWaveSession(baseDir: string, waveNum: number, agents: AgentState[], totalCost: number): void;
export declare function loadWaveHistory(runDir: string): WaveSummary[];
export declare function recordBranches(agents: {
    branch?: string;
    task: {
        prompt: string;
    };
    status: string;
    filesChanged?: number;
    costUsd?: number;
}[], mergeResults: {
    branch: string;
    ok: boolean;
}[], branches: BranchRecord[], currentWave?: number): void;
export declare function autoMergeBranches(cwd: string, branches: BranchRecord[], onLog: (msg: string) => void): void;
export declare function archiveMilestone(baseDir: string, waveNum: number): void;
