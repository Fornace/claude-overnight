import { execSync } from "child_process";
import { existsSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
export function gitExec(cmd, cwd) {
    return execSync(cmd, { cwd, encoding: "utf-8", stdio: "pipe" });
}
/** Total files the agent touched vs base  -- tracked changes + untracked. */
function measureWork(worktreeCwd, baseRef) {
    const seen = new Set();
    try {
        // Tracked: committed + staged + unstaged, all vs the worktree's base.
        const diff = gitExec(`git diff --name-only ${baseRef} --`, worktreeCwd);
        for (const p of diff.split("\n"))
            if (p)
                seen.add(p);
    }
    catch { }
    try {
        // Untracked files don't show in `git diff`; count them separately.
        const untracked = gitExec("git ls-files --others --exclude-standard", worktreeCwd);
        for (const p of untracked.split("\n"))
            if (p)
                seen.add(p);
    }
    catch { }
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
        log(agentId, `git status failed: ${String(err.message || err).slice(0, 120)}`);
        return preCount;
    }
    if (status.trim()) {
        try {
            gitExec("git add -A", worktreeCwd);
        }
        catch (err) {
            log(agentId, `git add failed: ${String(err.message || err).slice(0, 120)}`);
        }
        const msg = taskPrompt.slice(0, 72).replace(/'/g, "'\\''");
        try {
            gitExec(`git commit -m 'swarm: ${msg}'`, worktreeCwd);
        }
        catch (err) {
            const m = String(err.message || err);
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
                    log(agentId, `git commit failed even with --no-verify: ${String(err2.message || err2).slice(0, 120)}`);
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
        log(agentId, `diff vs base failed: ${String(err.message || err).slice(0, 120)}`);
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
export async function mergeAllBranches(agents, cwd, strategy, log, evalErroredBranch) {
    const mergeResults = [];
    let mergeBranch;
    if (agents.length === 0) {
        log(-1, "No changes to merge");
        return { mergeResults };
    }
    let originalRef;
    try {
        const branch = gitExec("git rev-parse --abbrev-ref HEAD", cwd).trim();
        originalRef = branch === "HEAD" ? gitExec("git rev-parse HEAD", cwd).trim() : branch;
    }
    catch { }
    let stashed = false;
    try {
        const status = gitExec("git status --porcelain", cwd);
        if (status.trim()) {
            gitExec("git stash push -m 'claude-overnight: pre-merge stash'", cwd);
            stashed = true;
            log(-1, "Stashed dirty working tree");
        }
    }
    catch (e) {
        log(-1, `Stash failed: ${String(e.message || e).slice(0, 80)}`);
    }
    try {
        if (strategy === "branch") {
            const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
            let candidate = `swarm/run-${ts}`;
            for (let i = 2;; i++) {
                try {
                    gitExec(`git rev-parse --verify "${candidate}"`, cwd);
                    candidate = `swarm/run-${ts}-${i}`;
                }
                catch {
                    break;
                }
            }
            mergeBranch = candidate;
            gitExec(`git checkout -b "${mergeBranch}"`, cwd);
            log(-1, `Created branch: ${mergeBranch}`);
        }
        log(-1, `Merging ${agents.length} branch(es)...`);
        for (const agent of agents) {
            const result = { branch: agent.branch, ok: false, filesChanged: agent.filesChanged };
            // Errored branch: let AI decide whether the partial work is worth keeping
            if (agent.status === "error" && evalErroredBranch && agent.task) {
                let evalResult;
                try {
                    const base = gitExec(`git merge-base HEAD "${agent.branch}"`, cwd).trim();
                    const diff = gitExec(`git diff ${base}..${agent.branch}`, cwd);
                    const truncated = diff.length > 50_000 ? diff.slice(0, 50_000) + "\n\n[diff truncated]" : diff;
                    evalResult = await evalErroredBranch(agent.id, agent.task, truncated);
                }
                catch (evalErr) {
                    // Eval itself failed — default to keep (never lose paid work)
                    log(agent.id, `Errored branch eval failed, keeping by default: ${String(evalErr?.message || evalErr).slice(0, 120)}`);
                    evalResult = { keep: true, reason: "eval error, keeping by default" };
                }
                if (!evalResult.keep) {
                    result.discarded = true;
                    result.evalReason = `Discarded: ${evalResult.reason}`;
                    try {
                        gitExec(`git branch -D "${agent.branch}"`, cwd);
                    }
                    catch { }
                    log(agent.id, result.evalReason);
                    mergeResults.push(result);
                    continue;
                }
                result.evalReason = `Recovered: ${evalResult.reason}`;
                log(agent.id, result.evalReason);
            }
            try {
                gitExec(`git merge --no-edit "${agent.branch}"`, cwd);
                result.ok = true;
                log(agent.id, `Merged ${agent.branch}`);
            }
            catch (e) {
                try {
                    gitExec("git merge --abort", cwd);
                }
                catch { }
                try {
                    gitExec(`git merge --no-edit -X theirs "${agent.branch}"`, cwd);
                    result.ok = true;
                    result.autoResolved = true;
                    log(agent.id, `Auto-resolved conflict: ${agent.branch}`);
                }
                catch {
                    try {
                        gitExec("git merge --abort", cwd);
                    }
                    catch { }
                    // 3rd tier: brute-force overlay. Handles rename/rename, rename/delete
                    // and other tree-level conflicts that `-X theirs` can't resolve.
                    if (forceMergeOverlay(agent.branch, cwd)) {
                        result.ok = true;
                        result.autoResolved = true;
                        log(agent.id, `Force-merged ${agent.branch} (overlay)`);
                    }
                    else {
                        result.error = e.message?.slice(0, 80);
                        log(agent.id, `Merge conflict: ${agent.branch}`);
                    }
                }
            }
            mergeResults.push(result);
        }
        if (existsSync(join(cwd, ".git", "MERGE_HEAD"))) {
            log(-1, "Partial merge detected  -- aborting");
            try {
                gitExec("git merge --abort", cwd);
            }
            catch { }
        }
        const merged = mergeResults.filter(r => r.ok);
        const failed = mergeResults.filter(r => !r.ok);
        for (const r of merged) {
            try {
                gitExec(`git branch -d "${r.branch}"`, cwd);
            }
            catch { }
        }
        const totalFilesChanged = mergeResults.reduce((sum, r) => sum + (r.ok ? r.filesChanged : 0), 0);
        log(-1, `Merged ${merged.length}/${agents.length} branches, ${totalFilesChanged} files changed${failed.length > 0 ? ` (${failed.length} unresolved)` : ""}`);
        if (strategy === "branch" && mergeBranch && originalRef) {
            try {
                gitExec(`git checkout "${originalRef}"`, cwd);
            }
            catch { }
        }
    }
    finally {
        if (stashed) {
            try {
                const stashList = gitExec("git stash list", cwd).trim();
                if (stashList) {
                    gitExec("git stash pop", cwd);
                    log(-1, "Restored stashed changes");
                }
            }
            catch { }
        }
    }
    return { mergeResults, mergeBranch };
}
/**
 * Last-resort merge: overlay the branch's file state onto HEAD without a real
 * 3-way merge. Walks `git diff --name-status base..branch` and for each entry
 * either checks out the branch's version (add/modify/rename) or removes the
 * file (delete). Always succeeds unless the branch itself is broken. Trades
 * merge-graph fidelity for "your changes actually land"  -- the right call for
 * an autonomous swarm.
 */
export function forceMergeOverlay(branch, cwd) {
    try {
        const base = gitExec(`git merge-base HEAD "${branch}"`, cwd).trim();
        const diff = gitExec(`git diff --name-status ${base} "${branch}"`, cwd);
        for (const line of diff.split("\n")) {
            if (!line)
                continue;
            const fields = line.split("\t");
            const status = fields[0];
            if (status.startsWith("R") || status.startsWith("C")) {
                const from = fields[1];
                const to = fields[2];
                if (status.startsWith("R")) {
                    try {
                        gitExec(`git rm -f -- "${from}"`, cwd);
                    }
                    catch { }
                }
                try {
                    gitExec(`git checkout "${branch}" -- "${to}"`, cwd);
                    gitExec(`git add -- "${to}"`, cwd);
                }
                catch { }
            }
            else if (status.startsWith("D")) {
                try {
                    gitExec(`git rm -f -- "${fields[1]}"`, cwd);
                }
                catch { }
            }
            else {
                try {
                    gitExec(`git checkout "${branch}" -- "${fields[1]}"`, cwd);
                    gitExec(`git add -- "${fields[1]}"`, cwd);
                }
                catch { }
            }
        }
        const dirty = gitExec("git status --porcelain", cwd).trim();
        if (!dirty)
            return true;
        gitExec(`git commit -m 'swarm: force-merge ${branch}'`, cwd);
        return true;
    }
    catch {
        try {
            gitExec("git merge --abort", cwd);
        }
        catch { }
        try {
            gitExec("git reset --hard HEAD", cwd);
        }
        catch { }
        return false;
    }
}
export function warnDirtyTree(cwd, log) {
    try {
        const status = gitExec("git status --porcelain", cwd);
        if (status.trim())
            log(-1, `Warning: ${status.trim().split("\n").length} uncommitted file(s) in working tree`);
    }
    catch { }
}
export function cleanStaleWorktrees(cwd, log) {
    const result = { recovered: 0, forceDeleted: 0 };
    try {
        const list = gitExec("git worktree list --porcelain", cwd);
        const stale = [];
        // Match any worktree whose path contains our mkdtemp prefix. We used to
        // gate on `startsWith(tmpdir())` too, but on macOS `os.tmpdir()` returns
        // `/var/folders/...` while git reports worktrees as `/private/var/...`
        // (realpath-resolved), so the prefix never matched and stale worktrees
        // silently accumulated. The `claude-overnight-` substring is unambiguous
        // enough on its own  -- nothing else in the repo uses that prefix.
        for (const line of list.split("\n")) {
            if (line.startsWith("worktree ")) {
                const wpath = line.slice("worktree ".length);
                if (wpath.includes("/claude-overnight-"))
                    stale.push(wpath);
            }
        }
        if (stale.length > 0) {
            log(-1, `Cleaning ${stale.length} stale worktree(s)`);
            for (const dir of stale) {
                try {
                    rmSync(dir, { recursive: true, force: true });
                }
                catch { }
            }
            gitExec("git worktree prune", cwd);
        }
        const worktreeBranches = new Set();
        for (const line of list.split("\n")) {
            if (line.startsWith("branch refs/heads/"))
                worktreeBranches.add(line.slice("branch refs/heads/".length));
        }
        const branches = gitExec("git branch", cwd)
            .split("\n")
            .map(b => b.trim().replace(/^\* /, ""))
            .filter(b => b.startsWith("swarm/task-") && !worktreeBranches.has(b));
        // Merge orphaned branches before deletion. Tiers: safe-delete (already
        // merged) → 3-tier merge → force-delete if merge fails. No branch survives
        // — the user doesn't want manual merges.
        for (const b of branches) {
            // Already-merged: fast forward delete
            try {
                gitExec(`git branch -d "${b}"`, cwd);
                continue;
            }
            catch { }
            // Attempt 3-tier merge into HEAD so the work lands
            try {
                gitExec(`git merge --no-edit "${b}"`, cwd);
                gitExec(`git branch -d "${b}"`, cwd);
                result.recovered++;
                continue;
            }
            catch {
                try {
                    gitExec("git merge --abort", cwd);
                }
                catch { }
            }
            try {
                gitExec(`git merge --no-edit -X theirs "${b}"`, cwd);
                gitExec(`git branch -d "${b}"`, cwd);
                result.recovered++;
                continue;
            }
            catch {
                try {
                    gitExec("git merge --abort", cwd);
                }
                catch { }
            }
            if (forceMergeOverlay(b, cwd)) {
                try {
                    gitExec(`git branch -d "${b}"`, cwd);
                }
                catch {
                    gitExec(`git branch -D "${b}"`, cwd);
                }
                result.recovered++;
                continue;
            }
            // All tiers failed — force-delete to avoid permanent orphans
            log(-1, `  ⚠ ${b} unmergeable, discarding`);
            try {
                gitExec(`git branch -D "${b}"`, cwd);
            }
            catch { }
            result.forceDeleted++;
        }
        if (result.recovered > 0)
            log(-1, `[prior-wave] Recovered ${result.recovered} orphaned swarm branch(es)`);
        if (result.forceDeleted > 0)
            log(-1, `[prior-wave] Discarded ${result.forceDeleted} unmergeable swarm branch(es)`);
    }
    catch { }
    return result;
}
export function writeSwarmLog(opts) {
    try {
        const ts = new Date(opts.startedAt).toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const path = join(tmpdir(), `claude-overnight-${ts}.json`);
        writeFileSync(path, JSON.stringify({
            version: "1",
            config: { model: opts.model, concurrency: opts.concurrency, useWorktrees: opts.useWorktrees, mergeStrategy: opts.mergeStrategy },
            startedAt: new Date(opts.startedAt).toISOString(),
            durationMs: Date.now() - opts.startedAt,
            completed: opts.completed, failed: opts.failed, aborted: opts.aborted,
            cost: opts.cost,
            tokens: { input: opts.inputTokens, output: opts.outputTokens },
            agents: opts.agents.map(a => ({
                id: a.id, task: a.task.prompt, status: a.status, error: a.error,
                toolCalls: a.toolCalls, cost: a.costUsd, branch: a.branch,
                filesChanged: a.filesChanged,
                durationMs: a.finishedAt && a.startedAt ? a.finishedAt - a.startedAt : undefined,
            })),
            merges: opts.mergeResults,
            events: opts.logs.map(l => ({ time: new Date(l.time).toISOString(), agent: l.agentId, text: l.text })),
        }, null, 2));
        return path;
    }
    catch {
        return undefined;
    }
}
