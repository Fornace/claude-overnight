import type { MergeStrategy, AgentStatus, AgentState } from "../core/types.js";
import { gitExec, forceMergeOverlay, warnDirtyTree, cleanStaleWorktrees } from "./merge-helpers.js";
export { gitExec, forceMergeOverlay, warnDirtyTree, cleanStaleWorktrees };
export { autoCommit } from "./merge-autocommit.js";
export interface MergeResult {
    branch: string;
    ok: boolean;
    autoResolved?: boolean;
    error?: string;
    filesChanged: number;
    /** Eval reason for errored branches: "Discarded: <reason>" or "Recovered: <reason>". */
    evalReason?: string;
    /** When true, this branch was explicitly discarded by AI eval. */
    discarded?: boolean;
}
export interface MergeAllResult {
    mergeResults: MergeResult[];
    mergeBranch?: string;
}
export interface ErroredBranchEval {
    keep: boolean;
    reason: string;
}
export type ErroredBranchEvaluator = (agentId: number, task: string, diff: string) => Promise<ErroredBranchEval>;
export declare function mergeAllBranches(agents: {
    id: number;
    branch: string;
    filesChanged: number;
    status?: AgentStatus;
    task?: string;
}[], cwd: string, strategy: MergeStrategy, log: (id: number, msg: string) => void, evalErroredBranch?: ErroredBranchEvaluator): Promise<MergeAllResult>;
export declare function writeSwarmLog(opts: {
    startedAt: number;
    model?: string;
    concurrency: number;
    useWorktrees?: boolean;
    mergeStrategy?: string;
    completed: number;
    failed: number;
    aborted: boolean;
    cost: number;
    inputTokens: number;
    outputTokens: number;
    agents: AgentState[];
    mergeResults: MergeResult[];
    logs: {
        time: number;
        agentId: number;
        text: string;
    }[];
}): string | undefined;
