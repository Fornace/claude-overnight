import { execSync } from "child_process";
import { rmSync } from "fs";

export function gitExec(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf-8", stdio: "pipe" });
}

/**
 * Last-resort merge: overlay the branch's file state onto HEAD without a real
 * 3-way merge. Walks `git diff --name-status base..branch` and for each entry
 * either checks out the branch's version (add/modify/rename) or removes the
 * file (delete). Always succeeds unless the branch itself is broken. Trades
 * merge-graph fidelity for "your changes actually land"  -- the right call for
 * an autonomous swarm.
 */
export function forceMergeOverlay(branch: string, cwd: string): boolean {
  try {
    const base = gitExec(`git merge-base HEAD "${branch}"`, cwd).trim();
    const diff = gitExec(`git diff --name-status ${base} "${branch}"`, cwd);
    for (const line of diff.split("\n")) {
      if (!line) continue;
      const fields = line.split("\t");
      const status = fields[0];
      if (status.startsWith("R") || status.startsWith("C")) {
        const from = fields[1]; const to = fields[2];
        if (status.startsWith("R")) { try { gitExec(`git rm -f -- "${from}"`, cwd); } catch {} }
        try { gitExec(`git checkout "${branch}" -- "${to}"`, cwd); gitExec(`git add -- "${to}"`, cwd); } catch {}
      } else if (status.startsWith("D")) {
        try { gitExec(`git rm -f -- "${fields[1]}"`, cwd); } catch {}
      } else {
        try { gitExec(`git checkout "${branch}" -- "${fields[1]}"`, cwd); gitExec(`git add -- "${fields[1]}"`, cwd); } catch {}
      }
    }
    const dirty = gitExec("git status --porcelain", cwd).trim();
    if (!dirty) return true;
    gitExec(`git commit -m 'swarm: force-merge ${branch}'`, cwd);
    return true;
  } catch {
    try { gitExec("git merge --abort", cwd); } catch {}
    try { gitExec("git reset --hard HEAD", cwd); } catch {}
    return false;
  }
}

export function warnDirtyTree(cwd: string, log: (id: number, msg: string) => void): void {
  try {
    const status = gitExec("git status --porcelain", cwd);
    if (status.trim()) log(-1, `Warning: ${status.trim().split("\n").length} uncommitted file(s) in working tree`);
  } catch {}
}

export function cleanStaleWorktrees(cwd: string, log: (id: number, msg: string) => void): { recovered: number; forceDeleted: number } {
  const result = { recovered: 0, forceDeleted: 0 };
  try {
    const list = gitExec("git worktree list --porcelain", cwd);
    const stale: string[] = [];
    // Match any worktree whose path contains our mkdtemp prefix. We used to
    // gate on `startsWith(tmpdir())` too, but on macOS `os.tmpdir()` returns
    // `/var/folders/...` while git reports worktrees as `/private/var/...`
    // (realpath-resolved), so the prefix never matched and stale worktrees
    // silently accumulated. The `claude-overnight-` substring is unambiguous
    // enough on its own  -- nothing else in the repo uses that prefix.
    for (const line of list.split("\n")) {
      if (line.startsWith("worktree ")) {
        const wpath = line.slice("worktree ".length);
        if (wpath.includes("/claude-overnight-")) stale.push(wpath);
      }
    }
    if (stale.length > 0) {
      log(-1, `Cleaning ${stale.length} stale worktree(s)`);
      for (const dir of stale) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
      gitExec("git worktree prune", cwd);
    }
    const worktreeBranches = new Set<string>();
    for (const line of list.split("\n")) {
      if (line.startsWith("branch refs/heads/")) worktreeBranches.add(line.slice("branch refs/heads/".length));
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
      try { gitExec(`git branch -d "${b}"`, cwd); continue; } catch {}
      // Attempt 3-tier merge into HEAD so the work lands
      try { gitExec(`git merge --no-edit "${b}"`, cwd); gitExec(`git branch -d "${b}"`, cwd); result.recovered++; continue; } catch { try { gitExec("git merge --abort", cwd); } catch {} }
      try { gitExec(`git merge --no-edit -X theirs "${b}"`, cwd); gitExec(`git branch -d "${b}"`, cwd); result.recovered++; continue; } catch { try { gitExec("git merge --abort", cwd); } catch {} }
      if (forceMergeOverlay(b, cwd)) { try { gitExec(`git branch -d "${b}"`, cwd); } catch { gitExec(`git branch -D "${b}"`, cwd); } result.recovered++; continue; }
      // All tiers failed — force-delete to avoid permanent orphans
      log(-1, `  ⚠ ${b} unmergeable, discarding`);
      try { gitExec(`git branch -D "${b}"`, cwd); } catch {}
      result.forceDeleted++;
    }
    if (result.recovered > 0) log(-1, `[prior-wave] Recovered ${result.recovered} orphaned swarm branch(es)`);
    if (result.forceDeleted > 0) log(-1, `[prior-wave] Discarded ${result.forceDeleted} unmergeable swarm branch(es)`);
  } catch {}
  return result;
}
