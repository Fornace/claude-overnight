import { existsSync } from "fs";
import { gitExec, silentGit, gitErrMsg } from "./merge-helpers.js";
/** Total files the agent touched vs base  -- tracked changes + untracked. */
function measureWork(worktreeCwd, baseRef) {
    const seen = new Set();
    // Tracked: committed + staged + unstaged, all vs the worktree's base.
    // Untracked: don't show in diff, so list separately.
    const diff = silentGit(`git diff --name-only ${baseRef} --`, worktreeCwd) ?? "";
    const untracked = silentGit("git ls-files --others --exclude-standard", worktreeCwd) ?? "";
    for (const p of diff.split("\n"))
        if (p)
            seen.add(p);
    for (const p of untracked.split("\n"))
        if (p)
            seen.add(p);
    return seen.size;
}
export function autoCommit(agentId, taskPrompt, worktreeCwd, baseRef, log) {
    if (!existsSync(worktreeCwd)) {
        log(agentId, "Worktree directory gone, skipping commit");
        return 0;
    }
    if (!baseRef)
        return 0;
    // Measure actual work BEFORE committing. This captures reality even if a
    // pre-commit hook rejects the commit: we used to silently return 0 in that
    // case and the worktree cleanup would destroy the changes.
    const preCount = measureWork(worktreeCwd, baseRef);
    let status;
    try {
        status = gitExec("git status --porcelain", worktreeCwd);
    }
    catch (err) {
        log(agentId, `git status failed: ${gitErrMsg(err)}`);
        return preCount;
    }
    if (status.trim()) {
        try {
            gitExec("git add -A", worktreeCwd);
        }
        catch (err) {
            log(agentId, `git add failed: ${gitErrMsg(err)}`);
        }
        const msg = taskPrompt.slice(0, 72).replace(/'/g, "'\''");
        try {
            gitExec(`git commit -m 'swarm: ${msg}'`, worktreeCwd);
        }
        catch (err) {
            const m = gitErrMsg(err, Number.MAX_SAFE_INTEGER);
            if (!m.includes("nothing to commit")) {
                // Hook-gated project: the user's pre-commit hooks rejected a
                // potentially work-in-progress commit (lint errors, type errors,
                // whatever). Retry bypassing hooks  -- this is swarm scaffolding,
                // not a user-facing commit. Without this the branch stays empty,
                // the merge gate drops it, and the work is destroyed when the
                // worktree is cleaned up.
                try {
                    gitExec(`git commit --no-verify -m 'swarm: ${msg}'`, worktreeCwd);
                    log(agentId, `Commit hooks bypassed (rejected swarm WIP commit)`);
                }
                catch (err2) {
                    log(agentId, `git commit failed even with --no-verify: ${gitErrMsg(err2)}`);
                }
            }
        }
    }
    // Authoritative post-commit count: this is what `mergeAllBranches` will
    // actually see on the branch.
    let landed = 0;
    try {
        const diff = gitExec(`git diff --name-only ${baseRef}..HEAD`, worktreeCwd);
        landed = diff.trim().split("\n").filter(Boolean).length;
    }
    catch (err) {
        log(agentId, `diff vs base failed: ${gitErrMsg(err)}`);
    }
    // Red-flag: work existed before the commit attempt but didn't land on the
    // branch. Surfaces silent data loss (stuck hooks, writes outside the
    // worktree, gitignored targets) that used to look like "agent did 0 work".
    if (landed === 0 && preCount > 0) {
        log(agentId, `${preCount} file(s) touched but did NOT land on branch  -- check hooks / gitignore / absolute paths`);
        return preCount;
    }
    if (landed > 0)
        log(agentId, `${landed} file(s) changed`);
    return landed;
}
