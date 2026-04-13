import { execSync } from "child_process";
import { existsSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { AgentState, MergeStrategy } from "./types.js";

export function gitExec(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf-8", stdio: "pipe" });
}

export interface MergeResult {
  branch: string;
  ok: boolean;
  autoResolved?: boolean;
  error?: string;
  filesChanged: number;
}

export function autoCommit(
  agentId: number, taskPrompt: string, worktreeCwd: string,
  log: (id: number, msg: string) => void,
): number {
  if (!existsSync(worktreeCwd)) { log(agentId, "Worktree directory gone, skipping commit"); return 0; }
  let status: string;
  try { status = gitExec("git status --porcelain", worktreeCwd); }
  catch (err: any) { log(agentId, `git status failed: ${String(err.message || err).slice(0, 120)}`); return 0; }
  if (!status.trim()) return 0;
  const lines = status.trim().split("\n").length;
  try { gitExec("git add -A", worktreeCwd); }
  catch (err: any) { log(agentId, `git add failed: ${String(err.message || err).slice(0, 120)}`); return lines; }
  try {
    const msg = taskPrompt.slice(0, 72).replace(/'/g, "'\\''");
    gitExec(`git commit -m 'swarm: ${msg}'`, worktreeCwd);
    log(agentId, `Committed ${lines} file(s)`);
  } catch (err: any) {
    const msg = String(err.message || err);
    if (!msg.includes("nothing to commit")) log(agentId, `git commit failed: ${msg.slice(0, 120)}`);
  }
  return lines;
}

export interface MergeAllResult {
  mergeResults: MergeResult[];
  mergeBranch?: string;
}

export function mergeAllBranches(
  agents: { id: number; branch: string; filesChanged: number }[],
  cwd: string, strategy: MergeStrategy,
  log: (id: number, msg: string) => void,
): MergeAllResult {
  const mergeResults: MergeResult[] = [];
  let mergeBranch: string | undefined;

  if (agents.length === 0) { log(-1, "No changes to merge"); return { mergeResults }; }

  let originalRef: string | undefined;
  try {
    const branch = gitExec("git rev-parse --abbrev-ref HEAD", cwd).trim();
    originalRef = branch === "HEAD" ? gitExec("git rev-parse HEAD", cwd).trim() : branch;
  } catch {}

  let stashed = false;
  try {
    const status = gitExec("git status --porcelain", cwd);
    if (status.trim()) {
      gitExec("git stash push -m 'claude-overnight: pre-merge stash'", cwd);
      stashed = true;
      log(-1, "Stashed dirty working tree");
    }
  } catch (e: any) { log(-1, `Stash failed: ${String(e.message || e).slice(0, 80)}`); }

  try {
    if (strategy === "branch") {
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      let candidate = `swarm/run-${ts}`;
      for (let i = 2; ; i++) {
        try { gitExec(`git rev-parse --verify "${candidate}"`, cwd); candidate = `swarm/run-${ts}-${i}`; }
        catch { break; }
      }
      mergeBranch = candidate;
      gitExec(`git checkout -b "${mergeBranch}"`, cwd);
      log(-1, `Created branch: ${mergeBranch}`);
    }

    log(-1, `Merging ${agents.length} branch(es)...`);
    for (const agent of agents) {
      const result: MergeResult = { branch: agent.branch, ok: false, filesChanged: agent.filesChanged };
      try {
        gitExec(`git merge --no-edit "${agent.branch}"`, cwd);
        result.ok = true;
        log(agent.id, `Merged ${agent.branch}`);
      } catch (e: any) {
        try { gitExec("git merge --abort", cwd); } catch {}
        try {
          gitExec(`git merge --no-edit -X theirs "${agent.branch}"`, cwd);
          result.ok = true;
          result.autoResolved = true;
          log(agent.id, `Auto-resolved conflict: ${agent.branch}`);
        } catch {
          try { gitExec("git merge --abort", cwd); } catch {}
          result.error = e.message?.slice(0, 80);
          log(agent.id, `Merge conflict: ${agent.branch}`);
        }
      }
      mergeResults.push(result);
    }

    if (existsSync(join(cwd, ".git", "MERGE_HEAD"))) {
      log(-1, "Partial merge detected — aborting");
      try { gitExec("git merge --abort", cwd); } catch {}
    }

    const merged = mergeResults.filter(r => r.ok);
    const failed = mergeResults.filter(r => !r.ok);
    for (const r of merged) { try { gitExec(`git branch -d "${r.branch}"`, cwd); } catch {} }
    const totalFilesChanged = mergeResults.reduce((sum, r) => sum + (r.ok ? r.filesChanged : 0), 0);
    log(-1, `Merged ${merged.length}/${agents.length} branches, ${totalFilesChanged} files changed${failed.length > 0 ? ` (${failed.length} unresolved)` : ""}`);

    if (strategy === "branch" && mergeBranch && originalRef) {
      try { gitExec(`git checkout "${originalRef}"`, cwd); } catch {}
    }
  } finally {
    if (stashed) {
      try {
        const stashList = gitExec("git stash list", cwd).trim();
        if (stashList) { gitExec("git stash pop", cwd); log(-1, "Restored stashed changes"); }
      } catch {}
    }
  }

  return { mergeResults, mergeBranch };
}

export function warnDirtyTree(cwd: string, log: (id: number, msg: string) => void): void {
  try {
    const status = gitExec("git status --porcelain", cwd);
    if (status.trim()) log(-1, `Warning: ${status.trim().split("\n").length} uncommitted file(s) in working tree`);
  } catch {}
}

export function cleanStaleWorktrees(cwd: string, log: (id: number, msg: string) => void): void {
  try {
    const list = gitExec("git worktree list --porcelain", cwd);
    const stale: string[] = [];
    // Match any worktree whose path contains our mkdtemp prefix. We used to
    // gate on `startsWith(tmpdir())` too, but on macOS `os.tmpdir()` returns
    // `/var/folders/...` while git reports worktrees as `/private/var/...`
    // (realpath-resolved), so the prefix never matched and stale worktrees
    // silently accumulated. The `claude-overnight-` substring is unambiguous
    // enough on its own — nothing else in the repo uses that prefix.
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
    for (const b of branches) { try { gitExec(`git branch -D "${b}"`, cwd); } catch {} }
    if (branches.length > 0) log(-1, `Cleaned ${branches.length} stale swarm branch(es)`);
  } catch {}
}

export function writeSwarmLog(opts: {
  startedAt: number; model?: string; concurrency: number;
  useWorktrees?: boolean; mergeStrategy?: string;
  completed: number; failed: number; aborted: boolean;
  cost: number; inputTokens: number; outputTokens: number;
  agents: AgentState[]; mergeResults: MergeResult[];
  logs: { time: number; agentId: number; text: string }[];
}): string | undefined {
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
  } catch { return undefined; }
}
