import { existsSync } from "fs";
import { gitExec } from "./merge-helpers.js";

/** Total files the agent touched vs base  -- tracked changes + untracked. */
function measureWork(worktreeCwd: string, baseRef: string): number {
  const seen = new Set<string>();
  try {
    // Tracked: committed + staged + unstaged, all vs the worktree's base.
    const diff = gitExec(`git diff --name-only ${baseRef} --`, worktreeCwd);
    for (const p of diff.split("\n")) if (p) seen.add(p);
  } catch {}
  try {
    // Untracked files don't show in `git diff`; count them separately.
    const untracked = gitExec("git ls-files --others --exclude-standard", worktreeCwd);
    for (const p of untracked.split("\n")) if (p) seen.add(p);
  } catch {}
  return seen.size;
}

export function autoCommit(
  agentId: number, taskPrompt: string, worktreeCwd: string, baseRef: string | undefined,
  log: (id: number, msg: string) => void,
): number {
  if (!existsSync(worktreeCwd)) { log(agentId, "Worktree directory gone, skipping commit"); return 0; }
  if (!baseRef) return 0;

  // Measure actual work BEFORE committing. This captures reality even if a
  // pre-commit hook rejects the commit: we used to silently return 0 in that
  // case and the worktree cleanup would destroy the changes.
  const preCount = measureWork(worktreeCwd, baseRef);

  let status: string;
  try { status = gitExec("git status --porcelain", worktreeCwd); }
  catch (err: any) { log(agentId, `git status failed: ${String(err.message || err).slice(0, 120)}`); return preCount; }

  if (status.trim()) {
    try { gitExec("git add -A", worktreeCwd); }
    catch (err: any) { log(agentId, `git add failed: ${String(err.message || err).slice(0, 120)}`); }
    const msg = taskPrompt.slice(0, 72).replace(/'/g, "'\''");
    try {
      gitExec(`git commit -m 'swarm: ${msg}'`, worktreeCwd);
    } catch (err: any) {
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
        } catch (err2: any) {
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
  } catch (err: any) {
    log(agentId, `diff vs base failed: ${String(err.message || err).slice(0, 120)}`);
  }

  // Red-flag: work existed before the commit attempt but didn't land on the
  // branch. Surfaces silent data loss (stuck hooks, writes outside the
  // worktree, gitignored targets) that used to look like "agent did 0 work".
  if (landed === 0 && preCount > 0) {
    log(agentId, `${preCount} file(s) touched but did NOT land on branch  -- check hooks / gitignore / absolute paths`);
    return preCount;
  }
  if (landed > 0) log(agentId, `${landed} file(s) changed`);
  return landed;
}
