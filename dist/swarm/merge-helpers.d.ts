export declare function gitExec(cmd: string, cwd: string): string;
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
export declare function cleanStaleWorktrees(cwd: string, log: (id: number, msg: string) => void): {
    recovered: number;
    forceDeleted: number;
};
