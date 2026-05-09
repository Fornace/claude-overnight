export declare function gitExec(cmd: string, cwd: string): string;
/**
 * Run a git command and swallow failure. Returns the trimmed output, or
 * `undefined` if the command failed. Use for cleanup ops where "best effort"
 * is the contract — replaces the dozens of `try { gitExec(...) } catch {}`
 * blocks that the merge pipeline used to be peppered with.
 */
export declare function silentGit(cmd: string, cwd: string): string | undefined;
/** Truncated stringification of an unknown error. Shared by the swarm's
 *  `try { gitExec(...) } catch (e) { log("op failed: " + ...) }` pattern. */
export declare function gitErrMsg(err: unknown, max?: number): string;
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
