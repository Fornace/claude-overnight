import { execSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
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
import type { Task, AgentState, SwarmPhase, PermMode } from "./types.js";

export interface SwarmConfig {
  tasks: Task[];
  concurrency: number;
  cwd: string;
  model?: string;
  allowedTools?: string[];
  useWorktrees?: boolean;
  permissionMode?: PermMode;
}

export interface MergeResult {
  branch: string;
  ok: boolean;
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
  mergeResults: MergeResult[] = [];

  // Rate limit tracking for auto-concurrency
  rateLimitUtilization = 0;
  rateLimitStatus: string = "";
  private rateLimitResetsAt?: number;

  private queue: Task[];
  private config: SwarmConfig;
  private nextId = 0;
  private worktreeBase?: string;

  constructor(config: SwarmConfig) {
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
    // Setup worktree base dir if needed
    if (this.config.useWorktrees) {
      this.worktreeBase = mkdtempSync(join(tmpdir(), "claude-swarm-"));
      this.log(-1, `Worktrees: ${this.worktreeBase}`);
    }

    this.phase = "running";
    const n = Math.min(this.config.concurrency, this.queue.length);
    await Promise.all(Array.from({ length: n }, () => this.worker()));

    // Merge phase
    if (this.config.useWorktrees) {
      await this.mergeAll();
    }
    this.phase = "done";
  }

  log(agentId: number, text: string) {
    this.logs.push({ time: Date.now(), agentId, text });
    if (this.logs.length > 300) this.logs.splice(0, this.logs.length - 150);
  }

  // ── Worker loop with auto-concurrency throttling ──

  private async worker(): Promise<void> {
    while (this.queue.length > 0) {
      await this.throttle();
      const task = this.queue.shift()!;
      await this.runAgent(task);
    }
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
    // Soft throttle: high utilization — add proportional delay
    else if (this.rateLimitUtilization > 0.75) {
      const delay = Math.floor((this.rateLimitUtilization - 0.5) * 15000);
      if (delay > 0) await sleep(delay);
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

    try {
      const perm = this.config.permissionMode ?? "auto";
      for await (const msg of query({
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
      })) {
        this.handleMsg(agent, msg);
      }
      if (agent.status === "running") {
        agent.status = "done";
        agent.finishedAt = Date.now();
        this.completed++;
        this.log(id, "Done");
      }
    } catch (err: any) {
      agent.status = "error";
      agent.error = String(err.message || err).slice(0, 120);
      agent.finishedAt = Date.now();
      this.failed++;
      this.log(id, agent.error);
    }

    // Auto-commit changes in worktree
    if (this.config.useWorktrees && agent.branch) {
      this.autoCommit(agent, agentCwd);
    }
  }

  // ── Auto-commit changes in worktree ──

  private autoCommit(agent: AgentState, worktreeCwd: string): void {
    try {
      const status = exec("git status --porcelain", worktreeCwd);
      if (!status.trim()) {
        agent.filesChanged = 0;
        return;
      }
      const lines = status.trim().split("\n").length;
      agent.filesChanged = lines;
      exec("git add -A", worktreeCwd);
      const msg = agent.task.prompt.slice(0, 72).replace(/"/g, '\\"');
      exec(`git commit -m "swarm: ${msg}"`, worktreeCwd);
      this.log(agent.id, `Committed ${lines} file(s)`);
    } catch {
      // No changes or commit failed — fine
    }
  }

  // ── Merge all worktree branches back ──

  private async mergeAll(): Promise<void> {
    this.phase = "merging";
    const branches = this.agents
      .filter((a) => a.branch && a.status === "done" && (a.filesChanged ?? 0) > 0);

    if (branches.length === 0) {
      this.log(-1, "No changes to merge");
      return;
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
        // Abort failed merge
        try { exec("git merge --abort", this.config.cwd); } catch {}
        result.error = e.message?.slice(0, 80);
        this.log(agent.id, `Merge conflict: ${agent.branch}`);
      }
      this.mergeResults.push(result);
    }

    // Cleanup worktrees (keep branches)
    if (this.worktreeBase) {
      try {
        exec("git worktree prune", this.config.cwd);
        rmSync(this.worktreeBase, { recursive: true, force: true });
      } catch {}
    }
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

function exec(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf-8", stdio: "pipe" });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
