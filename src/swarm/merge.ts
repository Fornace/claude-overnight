import { existsSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { MergeStrategy, AgentStatus, AgentState } from "../core/types.js";
import {
  gitExec,
  forceMergeOverlay,
  warnDirtyTree,
  cleanStaleWorktrees,
} from "./merge-helpers.js";

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

export type ErroredBranchEvaluator = (
  agentId: number,
  task: string,
  diff: string,
) => Promise<ErroredBranchEval>;

export async function mergeAllBranches(
  agents: { id: number; branch: string; filesChanged: number; status?: AgentStatus; task?: string }[],
  cwd: string, strategy: MergeStrategy,
  log: (id: number, msg: string) => void,
  evalErroredBranch?: ErroredBranchEvaluator,
): Promise<MergeAllResult> {
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

      // Errored branch: let AI decide whether the partial work is worth keeping
      if (agent.status === "error" && evalErroredBranch && agent.task) {
        let evalResult: ErroredBranchEval;
        try {
          const base = gitExec(`git merge-base HEAD "${agent.branch}"`, cwd).trim();
          const diff = gitExec(`git diff ${base}..${agent.branch}`, cwd);
          const truncated = diff.length > 50_000 ? diff.slice(0, 50_000) + "\n\n[diff truncated]" : diff;
          evalResult = await evalErroredBranch(agent.id, agent.task, truncated);
        } catch (evalErr: any) {
          // Eval itself failed — default to keep (never lose paid work)
          log(agent.id, `Errored branch eval failed, keeping by default: ${String(evalErr?.message || evalErr).slice(0, 120)}`);
          evalResult = { keep: true, reason: "eval error, keeping by default" };
        }

        if (!evalResult.keep) {
          result.discarded = true;
          result.evalReason = `Discarded: ${evalResult.reason}`;
          try { gitExec(`git branch -D "${agent.branch}"`, cwd); } catch {}
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
      } catch (e: any) {
        try { gitExec("git merge --abort", cwd); } catch {}
        try {
          gitExec(`git merge --no-edit -X theirs "${agent.branch}"`, cwd);
          result.ok = true;
          result.autoResolved = true;
          log(agent.id, `Auto-resolved conflict: ${agent.branch}`);
        } catch {
          try { gitExec("git merge --abort", cwd); } catch {}
          // 3rd tier: brute-force overlay. Handles rename/rename, rename/delete
          // and other tree-level conflicts that `-X theirs` can't resolve.
          if (forceMergeOverlay(agent.branch, cwd)) {
            result.ok = true;
            result.autoResolved = true;
            log(agent.id, `Force-merged ${agent.branch} (overlay)`);
          } else {
            result.error = e.message?.slice(0, 80);
            log(agent.id, `Merge conflict: ${agent.branch}`);
          }
        }
      }
      mergeResults.push(result);
    }

    if (existsSync(join(cwd, ".git", "MERGE_HEAD"))) {
      log(-1, "Partial merge detected  -- aborting");
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
