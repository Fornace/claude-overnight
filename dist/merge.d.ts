import type { AgentState, MergeStrategy } from "./types.js";
export declare function gitExec(cmd: string, cwd: string): string;
export interface MergeResult {
    branch: string;
    ok: boolean;
    autoResolved?: boolean;
    error?: string;
    filesChanged: number;
}
export declare function autoCommit(agentId: number, taskPrompt: string, worktreeCwd: string, baseRef: string | undefined, log: (id: number, msg: string) => void): number;
export interface MergeAllResult {
    mergeResults: MergeResult[];
    mergeBranch?: string;
}
export declare function mergeAllBranches(agents: {
    id: number;
    branch: string;
    filesChanged: number;
}[], cwd: string, strategy: MergeStrategy, log: (id: number, msg: string) => void): MergeAllResult;
/**
 * Last-resort merge: overlay the branch's file state onto HEAD without a real
 * 3-way merge. Walks `git diff --name-status base..branch` and for each entry
 * either checks out the branch's version (add/modify/rename) or removes the
 * file (delete). Always succeeds unless the branch itself is broken. Trades
 * merge-graph fidelity for "your changes actually land"  -- the right call for
 * an autonomous swarm.
 */
export declare function forceMergeOverlay(branch: string, cwd: string): boolean;
export declare function warnDirtyTree(cwd: string, log: (id: number, msg: string) => void): void;
export declare function cleanStaleWorktrees(cwd: string, log: (id: number, msg: string) => void): void;
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
