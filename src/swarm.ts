import { execSync } from "child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKMessage,
  SDKResultMessage,
  SDKAssistantMessage,
  SDKPartialAssistantMessage,
  SDKRateLimitEvent,
} from "@anthropic-ai/claude-agent-sdk";
import type { Task, AgentState, SwarmPhase, PermMode, MergeStrategy } from "./types.js";

export interface SwarmConfig {
  tasks: Task[];
  concurrency: number;
  cwd: string;
  model?: string;
  allowedTools?: string[];
  useWorktrees?: boolean;
  permissionMode?: PermMode;
  agentTimeoutMs?: number;
  maxRetries?: number;
  mergeStrategy?: MergeStrategy;
}

export interface MergeResult {
  branch: string;
  ok: boolean;
  autoResolved?: boolean;
  error?: string;
  filesChanged: number;
}

export class Swarm {
  readonly agents: AgentState[] = [];
  readonly logs: { time: number; agentId: number; text: string }[] = [];
  readonly startedAt = Date.now();
  readonly total: number;

  completed = 0;
  failed = 0;
  totalCostUsd = 0;
  totalInputTokens = 0;
  totalOutputTokens = 0;
  phase: SwarmPhase = "running";
  aborted = false;
  mergeResults: MergeResult[] = [];

  // Rate limit tracking for auto-concurrency
  rateLimitUtilization = 0;
  rateLimitStatus: string = "";
  private rateLimitResetsAt?: number;

  private queue: Task[];
  private config: SwarmConfig;
  private nextId = 0;
  private worktreeBase?: string;
  private cleanedUp = false;
  logFile?: string;

  constructor(config: SwarmConfig) {
    if (!config.tasks.length) {
      throw new Error("SwarmConfig: tasks array must not be empty");
    }
    if (config.concurrency < 1) {
      throw new Error("SwarmConfig: concurrency must be >= 1");
    }
    if (!config.cwd) {
      throw new Error("SwarmConfig: cwd must be a non-empty string");
    }

    // Warn on duplicate prompts (non-fatal)
    const seen = new Set<string>();
    for (const task of config.tasks) {
      if (seen.has(task.prompt)) {
        console.warn(`SwarmConfig: duplicate task prompt: "${task.prompt.slice(0, 80)}"`);
      }
      seen.add(task.prompt);
    }

    this.config = config;
    this.queue = [...config.tasks];
    this.total = config.tasks.length;
  }

  get active() {
    return this.agents.filter((a) => a.status === "running").length;
  }
  get pending() {
    return this.queue.length;
  }

  async run(): Promise<void> {
    try {
      if (this.config.useWorktrees) {
        this.warnDirtyTree();
        this.cleanStaleWorktrees();
        this.worktreeBase = mkdtempSync(join(tmpdir(), "claude-swarm-"));
        this.log(-1, `Worktrees: ${this.worktreeBase}`);
      }

      this.phase = "running";
      const n = Math.min(this.config.concurrency, this.queue.length);
      await Promise.all(Array.from({ length: n }, () => this.worker()));

      if (this.config.useWorktrees) {
        await this.mergeAll();
      }
      this.phase = "done";
    } finally {
      this.cleanup();
      this.writeLogFile();
    }
  }

  abort(): void {
    this.aborted = true;
    this.queue.length = 0;
  }

  log(agentId: number, text: string) {
    this.logs.push({ time: Date.now(), agentId, text });
    if (this.logs.length > 300) this.logs.splice(0, this.logs.length - 150);
  }

  // ── Worker loop with auto-concurrency throttling ──

  private async worker(): Promise<void> {
    let tasksProcessed = 0;
    while (this.queue.length > 0 && !this.aborted) {
      await this.throttle();
      const task = this.queue.shift();
      if (!task) break;
      try {
        await this.runAgent(task);
      } catch (err: any) {
        // Safety net: one agent must never kill the worker loop
        this.log(-1, `Worker error: ${String(err?.message || err).slice(0, 80)}`);
      }
      tasksProcessed++;
    }
    this.log(-1, `Worker finished (${tasksProcessed} tasks)`);
  }

  private async throttle(): Promise<void> {
    // Hard block: rate limit rejected — wait until reset
    if (this.rateLimitResetsAt) {
      const waitMs = this.rateLimitResetsAt - Date.now();
      if (waitMs > 0) {
        this.log(-1, `Rate limited, pausing ${Math.ceil(waitMs / 1000)}s`);
        await sleep(waitMs);
      }
      this.rateLimitResetsAt = undefined;
    }
    // Soft throttle: 0-15s proportional to 75-100% utilization
    else if (this.rateLimitUtilization > 0.75) {
      const delay = Math.floor((this.rateLimitUtilization - 0.75) * 60000);
      this.log(-1, `Soft throttle: ${Math.round(this.rateLimitUtilization * 100)}% utilization, pausing ${(delay / 1000).toFixed(1)}s`);
      await sleep(delay);
    }
  }

  // ── Agent execution ──

  private async runAgent(task: Task): Promise<void> {
    const id = this.nextId++;
    const agent: AgentState = {
      id,
      task,
      status: "running",
      startedAt: Date.now(),
      toolCalls: 0,
    };
    this.agents.push(agent);

    // Create worktree if enabled
    let agentCwd = task.cwd || this.config.cwd;
    if (this.config.useWorktrees && this.worktreeBase) {
      try {
        const branch = `swarm/task-${id}`;
        const dir = join(this.worktreeBase, `agent-${id}`);
        exec(`git worktree add -b "${branch}" "${dir}" HEAD`, this.config.cwd);
        agentCwd = dir;
        agent.branch = branch;
        this.log(id, `Worktree: ${branch}`);
      } catch (e: any) {
        this.log(id, `Worktree failed: ${e.message?.slice(0, 60)}`);
      }
    }

    this.log(id, `Starting: ${task.prompt.slice(0, 60)}`);

    const maxRetries = this.config.maxRetries ?? 2;
    const timeoutMs = this.config.agentTimeoutMs ?? 5 * 60 * 1000;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const backoffMs = 1000 * 2 ** (attempt - 1);
        this.log(id, `Retry ${attempt}/${maxRetries} in ${backoffMs}ms`);
        await sleep(backoffMs);
        agent.status = "running";
        agent.error = undefined;
        agent.finishedAt = undefined;
      }

      try {
        const perm = this.config.permissionMode ?? "auto";
        const agentQuery = query({
          prompt: this.config.useWorktrees
            ? `You are working in an isolated git worktree. Focus only on this task. Do NOT commit your changes — the framework handles that.\n\n${task.prompt}`
            : task.prompt,
          options: {
            cwd: agentCwd,
            model: task.model || this.config.model,
            permissionMode: perm,
            ...(perm === "bypassPermissions" && { allowDangerouslySkipPermissions: true }),
            allowedTools: this.config.allowedTools,
            includePartialMessages: true,
            persistSession: false,
          },
        });

        // Race against a real timer — fires even if the SDK yields nothing
        let timer: NodeJS.Timeout;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            agentQuery.close();
            reject(new AgentTimeoutError(timeoutMs));
          }, timeoutMs);
        });
        try {
          await Promise.race([
            (async () => {
              for await (const msg of agentQuery) {
                this.handleMsg(agent, msg);
              }
            })(),
            timeout,
          ]);
        } finally {
          clearTimeout(timer!);
        }

        if (agent.status === "running") {
          agent.status = "done";
          agent.finishedAt = Date.now();
          this.completed++;
          this.log(id, "Done");
        }
        break; // Success — exit retry loop
      } catch (err: any) {
        const canRetry = attempt < maxRetries && isTransientError(err);
        if (canRetry) {
          this.log(id, `Transient error: ${String(err.message || err).slice(0, 80)}`);
          continue;
        }
        agent.status = "error";
        agent.error = String(err.message || err).slice(0, 120);
        agent.finishedAt = Date.now();
        this.failed++;
        this.log(id, agent.error);
      }
    }

    // Auto-commit changes in worktree
    if (this.config.useWorktrees && agent.branch) {
      this.autoCommit(agent, agentCwd);
    }
  }

  // ── Auto-commit changes in worktree ──

  private autoCommit(agent: AgentState, worktreeCwd: string): void {
    if (!existsSync(worktreeCwd)) {
      this.log(agent.id, "Worktree directory gone, skipping commit");
      return;
    }

    let status: string;
    try {
      status = exec("git status --porcelain", worktreeCwd);
    } catch (err: any) {
      this.log(agent.id, `git status failed: ${String(err.message || err).slice(0, 120)}`);
      return;
    }

    if (!status.trim()) {
      agent.filesChanged = 0;
      return;
    }

    const lines = status.trim().split("\n").length;
    agent.filesChanged = lines;

    try {
      exec("git add -A", worktreeCwd);
    } catch (err: any) {
      this.log(agent.id, `git add failed: ${String(err.message || err).slice(0, 120)}`);
      return;
    }

    try {
      const msg = agent.task.prompt.slice(0, 72).replace(/'/g, "'\\''");
      exec(`git commit -m 'swarm: ${msg}'`, worktreeCwd);
      this.log(agent.id, `Committed ${lines} file(s)`);
    } catch (err: any) {
      const msg = String(err.message || err);
      if (!msg.includes("nothing to commit")) {
        this.log(agent.id, `git commit failed: ${msg.slice(0, 120)}`);
      }
    }
  }

  // ── Merge all worktree branches back ──

  mergeBranch?: string; // set when mergeStrategy is "branch"

  private async mergeAll(): Promise<void> {
    this.phase = "merging";
    const branches = this.agents
      .filter((a) => a.branch && a.status === "done" && (a.filesChanged ?? 0) > 0);

    if (branches.length === 0) {
      this.log(-1, "No changes to merge");
      return;
    }

    // "branch" strategy: create a new branch, merge there (current branch untouched)
    const strategy = this.config.mergeStrategy ?? "yolo";
    if (strategy === "branch") {
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      this.mergeBranch = `swarm/run-${ts}`;
      exec(`git checkout -b "${this.mergeBranch}"`, this.config.cwd);
      this.log(-1, `Created branch: ${this.mergeBranch}`);
    }

    this.log(-1, `Merging ${branches.length} branch(es)...`);
    for (const agent of branches) {
      const result: MergeResult = {
        branch: agent.branch!,
        ok: false,
        filesChanged: agent.filesChanged ?? 0,
      };
      try {
        exec(`git merge --no-edit "${agent.branch}"`, this.config.cwd);
        result.ok = true;
        this.log(agent.id, `Merged ${agent.branch}`);
      } catch (e: any) {
        // Abort failed merge, then retry with theirs strategy (keep agent's version)
        try { exec("git merge --abort", this.config.cwd); } catch {}
        try {
          exec(`git merge --no-edit -X theirs "${agent.branch}"`, this.config.cwd);
          result.ok = true;
          result.autoResolved = true;
          this.log(agent.id, `Auto-resolved conflict: ${agent.branch}`);
        } catch (e2: any) {
          try { exec("git merge --abort", this.config.cwd); } catch {}
          result.error = e.message?.slice(0, 80);
          this.log(agent.id, `Merge conflict: ${agent.branch}`);
        }
      }
      this.mergeResults.push(result);
    }

    // Clean up successfully merged task branches
    const merged = this.mergeResults.filter((r) => r.ok);
    const failed = this.mergeResults.filter((r) => !r.ok);
    for (const r of merged) {
      try { exec(`git branch -d "${r.branch}"`, this.config.cwd); } catch {}
    }

    this.log(-1, `Merged ${merged.length}/${branches.length} branches${failed.length > 0 ? ` (${failed.length} unresolved)` : ""}`);

    if (strategy === "branch" && this.mergeBranch) {
      // Switch back to the original branch
      try {
        exec("git checkout -", this.config.cwd);
      } catch {}
    }
  }

  // ── Cleanup & diagnostics ──

  cleanup(): void {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    if (this.worktreeBase) {
      // rmSync FIRST (remove dirs), then prune (clean git refs to removed dirs)
      try { rmSync(this.worktreeBase, { recursive: true, force: true }); } catch {}
      try { exec("git worktree prune", this.config.cwd); } catch {}
    }
  }

  private warnDirtyTree(): void {
    try {
      const status = exec("git status --porcelain", this.config.cwd);
      if (status.trim()) {
        const n = status.trim().split("\n").length;
        this.log(-1, `Warning: ${n} uncommitted file(s) in working tree`);
      }
    } catch {}
  }

  private cleanStaleWorktrees(): void {
    try {
      const list = exec("git worktree list --porcelain", this.config.cwd);
      const stale: string[] = [];
      for (const line of list.split("\n")) {
        if (line.startsWith("worktree ") && line.includes("claude-swarm-")) {
          stale.push(line.slice("worktree ".length));
        }
      }
      if (stale.length > 0) {
        this.log(-1, `Cleaning ${stale.length} stale worktree(s)`);
        for (const dir of stale) {
          try { rmSync(dir, { recursive: true, force: true }); } catch {}
        }
        exec("git worktree prune", this.config.cwd);
      }
      // Also clean orphaned swarm branches from previous runs
      const branches = exec("git branch", this.config.cwd)
        .split("\n")
        .map((b) => b.trim().replace(/^\* /, ""))
        .filter((b) => b.startsWith("swarm/"));
      for (const b of branches) {
        try { exec(`git branch -D "${b}"`, this.config.cwd); } catch {}
      }
      if (branches.length > 0) {
        this.log(-1, `Cleaned ${branches.length} stale swarm branch(es)`);
      }
    } catch {}
  }

  private writeLogFile(): void {
    try {
      const ts = new Date(this.startedAt).toISOString().replace(/[:.]/g, "-").slice(0, 19);
      this.logFile = join(tmpdir(), `claude-swarm-${ts}.json`);
      writeFileSync(this.logFile, JSON.stringify({
        startedAt: new Date(this.startedAt).toISOString(),
        durationMs: Date.now() - this.startedAt,
        completed: this.completed, failed: this.failed, aborted: this.aborted,
        cost: this.totalCostUsd,
        tokens: { input: this.totalInputTokens, output: this.totalOutputTokens },
        agents: this.agents.map(a => ({
          id: a.id, task: a.task.prompt, status: a.status, error: a.error,
          toolCalls: a.toolCalls, cost: a.costUsd, branch: a.branch,
          filesChanged: a.filesChanged,
          durationMs: a.finishedAt && a.startedAt ? a.finishedAt - a.startedAt : undefined,
        })),
        merges: this.mergeResults,
        events: this.logs.map(l => ({
          time: new Date(l.time).toISOString(), agent: l.agentId, text: l.text,
        })),
      }, null, 2));
    } catch {}
  }

  // ── Message handler ──

  private handleMsg(agent: AgentState, msg: SDKMessage): void {
    switch (msg.type) {
      case "assistant": {
        const m = msg as SDKAssistantMessage;
        if (!m.message?.content) break;
        for (const block of m.message.content) {
          if (block.type === "tool_use") {
            agent.currentTool = block.name;
            agent.toolCalls++;
            this.log(agent.id, block.name);
          } else if (block.type === "text" && block.text) {
            const line = block.text.trim().split("\n")[0]?.slice(0, 80);
            if (line) agent.lastText = line;
          }
        }
        break;
      }

      case "stream_event": {
        const s = msg as SDKPartialAssistantMessage;
        const ev = s.event;
        if (ev.type === "content_block_start") {
          const cb = (ev as any).content_block;
          if (cb?.type === "tool_use") {
            agent.currentTool = cb.name;
            agent.toolCalls++;
            this.log(agent.id, cb.name);
          }
        } else if (ev.type === "content_block_delta") {
          const delta = (ev as any).delta;
          if (delta?.type === "text_delta" && delta.text) {
            const t = delta.text.trim();
            if (t) agent.lastText = t.slice(0, 80);
          }
        } else if (ev.type === "content_block_stop") {
          agent.currentTool = undefined;
        }
        break;
      }

      case "result": {
        const r = msg as SDKResultMessage;
        agent.finishedAt = Date.now();
        agent.costUsd = r.total_cost_usd;
        this.totalCostUsd += r.total_cost_usd;
        if (r.usage) {
          this.totalInputTokens += r.usage.input_tokens ?? 0;
          this.totalOutputTokens += r.usage.output_tokens ?? 0;
        }
        if (r.subtype === "success") {
          agent.status = "done";
          this.completed++;
          this.log(agent.id, "Done");
        } else {
          agent.status = "error";
          agent.error = r.subtype;
          this.failed++;
          this.log(agent.id, r.subtype);
        }
        break;
      }

      case "rate_limit_event": {
        const rl = msg as SDKRateLimitEvent;
        const info = rl.rate_limit_info;
        this.rateLimitUtilization = info.utilization ?? 0;
        this.rateLimitStatus = info.status;
        if (info.status === "rejected" && info.resetsAt) {
          this.rateLimitResetsAt = info.resetsAt;
        }
        const pct = info.utilization != null ? `${Math.round(info.utilization * 100)}%` : "";
        this.log(agent.id, `Rate: ${info.status} ${pct}`);
        break;
      }
    }
  }
}

class AgentTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Agent timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = "AgentTimeoutError";
  }
}

function isTransientError(err: unknown): boolean {
  if (err instanceof AgentTimeoutError) return false;
  const msg = String(
    (err as any)?.message || err,
  ).toLowerCase();
  const status: number | undefined =
    (err as any)?.status ?? (err as any)?.statusCode;
  if (
    status === 429 ||
    (status != null && status >= 500 && status < 600) ||
    msg.includes("rate limit") ||
    msg.includes("overloaded") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("socket hang up") ||
    msg.includes("epipe") ||
    msg.includes("econnrefused") ||
    msg.includes("ehostunreach") ||
    msg.includes("network error") ||
    msg.includes("fetch failed") ||
    msg.includes("aborted")
  ) {
    return true;
  }
  const cause = (err as any)?.cause;
  if (cause && cause !== err) return isTransientError(cause);
  return false;
}

function exec(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf-8", stdio: "pipe" });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
