import { existsSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKMessage, SDKResultMessage, SDKResultError, SDKAssistantMessage,
  SDKPartialAssistantMessage, SDKRateLimitEvent,
} from "@anthropic-ai/claude-agent-sdk";
import { NudgeError } from "./types.js";
import type { Task, AgentState, SwarmPhase, PermMode, MergeStrategy, RateLimitWindow } from "./types.js";
import { gitExec, autoCommit, mergeAllBranches, warnDirtyTree, cleanStaleWorktrees, writeSwarmLog } from "./merge.js";
import type { MergeResult } from "./merge.js";

const SIMPLIFY_PROMPT = `You just finished your task. Now review and simplify your changes.

Run \`git diff\` to see what you changed, then fix any issues:

1. **Reuse**: Search the codebase — did you write something that already exists? Use existing utilities, helpers, patterns instead.
2. **Quality**: Redundant state, copy-paste with slight variation, leaky abstractions, unnecessary wrappers/nesting, comments that narrate what the code does? Delete them.
3. **Efficiency**: Redundant computations, sequential operations that could be parallel, unnecessary existence checks before operations, unbounded data structures, missing cleanup?

Less code is better. Delete and simplify rather than add. Fix directly — no need to explain.`;

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
  usageCap?: number;
  allowExtraUsage?: boolean;
  extraUsageBudget?: number;
  baseCostUsd?: number;
}

export class Swarm {
  readonly agents: AgentState[] = [];
  readonly logs: { time: number; agentId: number; text: string }[] = [];
  private readonly allLogs: { time: number; agentId: number; text: string }[] = [];
  readonly startedAt = Date.now();
  readonly total: number;

  completed = 0;
  failed = 0;
  totalCostUsd = 0;
  totalInputTokens = 0;
  totalOutputTokens = 0;
  phase: SwarmPhase = "running";
  aborted = false;
  cappedOut = false;
  mergeResults: MergeResult[] = [];

  rateLimitUtilization = 0;
  rateLimitResetsAt?: number;
  rateLimitWindows: Map<string, RateLimitWindow> = new Map();
  rateLimitPaused = 0;
  isUsingOverage = false;
  overageCostUsd = 0;

  /** Live-adjustable concurrency target. Workers above this count exit on the next task boundary. */
  targetConcurrency: number;
  /** When true, dispatch is frozen — workers wait without starting new tasks. */
  paused = false;
  /** Wall-clock ms of the last sign of real progress (assistant msg, tool use, result). */
  lastProgressAt = Date.now();
  /** 0 = normal, 1 = halved once, 2 = halved twice, 3 = long cooldown at c=1, 4 = aborted. */
  stallLevel = 0;
  /** Last time the watchdog took an action; used to debounce escalations. */
  private stallActionAt = 0;
  /** Live worker coroutine count (not agents). */
  private workerCount = 0;
  /** Growable list of worker promises; run() awaits until empty. */
  private workerPromises: Promise<void>[] = [];

  private queue: Task[];
  private config: SwarmConfig;
  private nextId = 0;
  private worktreeBase?: string;
  private activeQueries = new Set<{ close: () => void }>();
  private cleanedUp = false;
  logFile?: string;
  readonly model: string | undefined;
  usageCap: number | undefined;
  readonly allowExtraUsage: boolean;
  extraUsageBudget: number | undefined;
  readonly baseCostUsd: number;
  mergeBranch?: string;

  constructor(config: SwarmConfig) {
    if (!config.tasks.length) throw new Error("SwarmConfig: tasks array must not be empty");
    if (config.concurrency < 1) throw new Error("SwarmConfig: concurrency must be >= 1");
    if (!config.cwd) throw new Error("SwarmConfig: cwd must be a non-empty string");

    const seen = new Set<string>();
    for (const task of config.tasks) {
      if (seen.has(task.prompt)) console.warn(`SwarmConfig: duplicate task prompt: "${task.prompt.slice(0, 80)}"`);
      seen.add(task.prompt);
    }

    this.config = config;
    this.model = config.model;
    this.usageCap = config.usageCap;
    this.allowExtraUsage = config.allowExtraUsage ?? false;
    this.extraUsageBudget = config.extraUsageBudget;
    this.baseCostUsd = config.baseCostUsd ?? 0;
    this.queue = [...config.tasks];
    this.total = config.tasks.length;
    this.targetConcurrency = config.concurrency;
  }

  get active() { return this.agents.filter(a => a.status === "running").length; }
  get blocked() { return this.agents.filter(a => a.status === "running" && a.blockedAt != null).length; }
  get pending() { return this.queue.length; }

  /** Live-adjust concurrency. Shrinks by having excess workers exit on next task boundary; grows by spawning new workers. */
  setConcurrency(n: number): void {
    if (!Number.isFinite(n) || n < 1) return;
    const prev = this.targetConcurrency;
    if (n === prev) return;
    this.targetConcurrency = n;
    this.log(-1, `Concurrency changed: ${prev} → ${n}`);
    if (n > prev && this.queue.length > 0 && !this.aborted && !this.cappedOut) {
      const toSpawn = Math.min(n - this.workerCount, this.queue.length);
      for (let i = 0; i < toSpawn; i++) this.workerPromises.push(this.worker());
    }
  }

  /** Freeze/resume dispatch without killing the run. Paused workers block at the top of their loop. */
  setPaused(b: boolean): void {
    if (this.paused === b) return;
    this.paused = b;
    this.log(-1, b ? "Dispatch paused" : "Dispatch resumed");
  }

  /** Live-adjust the overage spend cap. `undefined` = unlimited. If already over the new cap, stop dispatch. */
  setExtraUsageBudget(n: number | undefined): void {
    if (this.extraUsageBudget === n) return;
    const prev = this.extraUsageBudget;
    this.extraUsageBudget = n;
    const fmt = (v: number | undefined) => v != null ? `$${v}` : "unlimited";
    this.log(-1, `Extra usage budget: ${fmt(prev)} → ${fmt(n)}`);
    if (n != null && this.isUsingOverage && this.overageCostUsd >= n) {
      this.capForOverage(`Extra usage budget $${n} exceeded ($${this.overageCostUsd.toFixed(2)} spent) — stopping dispatch`);
    }
  }

  async run(): Promise<void> {
    try {
      if (this.config.useWorktrees) {
        warnDirtyTree(this.config.cwd, (id, text) => this.log(id, text));
        cleanStaleWorktrees(this.config.cwd, (id, text) => this.log(id, text));
        this.worktreeBase = mkdtempSync(join(tmpdir(), "claude-overnight-"));
        this.log(-1, `Worktrees: ${this.worktreeBase}`);
      }
      this.phase = "running";
      const n = Math.min(this.targetConcurrency, this.queue.length);
      for (let i = 0; i < n; i++) this.workerPromises.push(this.worker());
      // setConcurrency() can grow workerPromises during execution, so drain in a loop.
      while (this.workerPromises.length > 0) {
        const batch = this.workerPromises.slice();
        this.workerPromises.length = 0;
        await Promise.all(batch);
      }
      if (this.config.useWorktrees) {
        this.phase = "merging";
        const branches = this.agents.filter(a => a.branch && a.status === "done" && (a.filesChanged ?? 0) > 0)
          .map(a => ({ id: a.id, branch: a.branch!, filesChanged: a.filesChanged ?? 0 }));
        const result = mergeAllBranches(branches, this.config.cwd, this.config.mergeStrategy ?? "yolo", (id, text) => this.log(id, text));
        this.mergeResults = result.mergeResults;
        if (result.mergeBranch) this.mergeBranch = result.mergeBranch;
      }
      this.phase = "done";
    } finally {
      this.cleanup();
      this.logFile = writeSwarmLog({
        startedAt: this.startedAt, model: this.config.model, concurrency: this.targetConcurrency,
        useWorktrees: this.config.useWorktrees, mergeStrategy: this.config.mergeStrategy,
        completed: this.completed, failed: this.failed, aborted: this.aborted,
        cost: this.totalCostUsd, inputTokens: this.totalInputTokens, outputTokens: this.totalOutputTokens,
        agents: this.agents, mergeResults: this.mergeResults, logs: this.allLogs,
      });
    }
  }

  abort(): void {
    this.aborted = true;
    this.queue.length = 0;
    this.activeQueries.forEach(q => q.close());
    this.activeQueries.clear();
  }

  /** Re-queue all errored agents' tasks for retry within this wave. */
  requeueFailed(): number {
    const errored = this.agents.filter(a => a.status === "error");
    if (errored.length === 0) return 0;
    for (const a of errored) {
      this.queue.push(a.task);
      a.status = "pending";
      a.error = undefined;
      a.finishedAt = undefined;
    }
    this.failed -= errored.length;
    this.log(-1, `Re-queued ${errored.length} failed task(s)`);
    return errored.length;
  }

  logSequence = 0;

  log(agentId: number, text: string) {
    const entry = { time: Date.now(), agentId, text };
    this.logs.push(entry);
    this.allLogs.push(entry);
    this.logSequence++;
    if (this.logs.length > 300) this.logs.splice(0, this.logs.length - 150);
  }

  cleanup(): void {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    if (this.worktreeBase) {
      try { rmSync(this.worktreeBase, { recursive: true, force: true }); } catch {}
      try { gitExec("git worktree prune", this.config.cwd); } catch {}
    }
  }

  // ── Worker loop ──

  private async worker(): Promise<void> {
    this.workerCount++;
    let tasksProcessed = 0;
    try {
      while (this.queue.length > 0 && !this.aborted && !this.cappedOut) {
        // Shrink: exit if we're above the live target.
        if (this.workerCount > this.targetConcurrency) {
          this.log(-1, `Worker exiting (concurrency shrunk to ${this.targetConcurrency})`);
          return;
        }
        // Pause: block here without holding a task, so unpausing resumes cleanly.
        while (this.paused && !this.aborted && !this.cappedOut) await sleep(500);
        await this.throttle();
        if (this.cappedOut || this.aborted) break;
        if (this.workerCount > this.targetConcurrency) return;
        const task = this.queue.shift();
        if (!task) break;
        try { await this.runAgent(task); }
        catch (err: any) { this.log(-1, `Worker error: ${String(err?.message || err).slice(0, 80)}`); }
        tasksProcessed++;
      }
      this.log(-1, `Worker finished (${tasksProcessed} tasks)`);
    } finally {
      this.workerCount--;
    }
  }

  /** Mark real progress — resets stall state. Called on any assistant/tool/result message. */
  private markProgress(): void {
    this.lastProgressAt = Date.now();
    if (this.stallLevel > 0 && this.lastProgressAt > this.stallActionAt) this.stallLevel = 0;
  }

  /**
   * Stall watchdog. Called each time a worker finishes a rate-limit wait. Escalates when
   * the whole swarm has been stuck with no progress for a while:
   *   L1 @ 5m → halve concurrency
   *   L2 @ 10m → halve again
   *   L3 @ 15m+ at c=1 → force a 10-minute cooldown instead of hammering every 60s
   *   L4 @ 30m → abort the run so it can be resumed later without burning the budget
   */
  private checkStall(): void {
    const stalledFor = Date.now() - this.lastProgressAt;
    if (stalledFor < 5 * 60_000) return;
    // Debounce so multiple workers waking at once don't double-escalate.
    if (Date.now() - this.stallActionAt < 60_000) return;

    if (stalledFor >= 30 * 60_000) {
      this.stallLevel = 4;
      this.stallActionAt = Date.now();
      this.log(-1, `Stalled ${Math.round(stalledFor / 60000)}m with no progress — aborting run so you can resume later`);
      this.abort();
      return;
    }
    if (this.targetConcurrency <= 1 && stalledFor >= 15 * 60_000) {
      this.stallLevel = 3;
      this.stallActionAt = Date.now();
      const until = Date.now() + 10 * 60_000;
      this.rateLimitResetsAt = until;
      this.log(-1, `Stalled at concurrency 1 for ${Math.round(stalledFor / 60000)}m — forcing 10m cooldown`);
      return;
    }
    if (this.stallLevel < 2 && this.targetConcurrency > 1) {
      const next = Math.max(1, Math.floor(this.targetConcurrency / 2));
      this.stallLevel++;
      this.stallActionAt = Date.now();
      this.log(-1, `Auto-throttle L${this.stallLevel}: concurrency ${this.targetConcurrency} → ${next} (stalled ${Math.round(stalledFor / 60000)}m)`);
      this.setConcurrency(next);
    }
  }

  private capForOverage(reason: string): void {
    if (this.cappedOut) return;
    this.cappedOut = true;
    this.queue.length = 0;
    this.log(-1, reason);
  }

  private async throttle(): Promise<void> {
    if (this.cappedOut) return;

    // Hard stop: overage budget exhausted (only legitimate cap)
    if (this.isUsingOverage && this.extraUsageBudget != null && this.overageCostUsd >= this.extraUsageBudget) {
      this.capForOverage(`Extra usage budget $${this.extraUsageBudget} reached ($${this.overageCostUsd.toFixed(2)} spent) — stopping dispatch`);
      return;
    }

    // Wait loop: keep waiting until the blocking condition clears
    // isUsingOverage is purely informational — the API enforces overage via 429s
    // which the retry loop handles. Throttle only gates on actual rejections and user cap.
    let consecutiveWaits = 0;
    for (;;) {
      if (this.aborted || this.cappedOut) return;
      const cap = this.usageCap;
      const capExceeded = cap != null && cap < 1 && this.rateLimitUtilization >= cap;
      const rejected = this.rateLimitResetsAt && this.rateLimitResetsAt > Date.now();
      if (!capExceeded && !rejected) break;

      const fallbackMs = Math.min(300_000, 60_000 * (1 + consecutiveWaits * 2));
      const waitMs = this.rateLimitResetsAt && this.rateLimitResetsAt > Date.now()
        ? Math.max(5000, this.rateLimitResetsAt - Date.now())
        : fallbackMs;
      const reason = capExceeded
        ? `Usage at ${Math.round(this.rateLimitUtilization * 100)}% (cap ${Math.round(cap! * 100)}%)`
        : "Rate limited";
      this.log(-1, `${reason} — waiting ${Math.ceil(waitMs / 1000)}s then retrying`);
      this.rateLimitPaused++;
      await sleep(waitMs);
      this.rateLimitPaused--;
      this.rateLimitUtilization = 0;
      this.rateLimitResetsAt = undefined;
      consecutiveWaits++;
      this.checkStall();
      if (this.aborted || this.cappedOut) return;
    }
  }

  // ── Agent execution ──

  private async runAgent(task: Task): Promise<void> {
    const id = this.nextId++;
    const agent: AgentState = { id, task, status: "running", startedAt: Date.now(), toolCalls: 0 };
    this.agents.push(agent);

    let agentCwd = task.cwd || this.config.cwd;
    if (this.config.useWorktrees && this.worktreeBase && !task.noWorktree) {
      const branch = `swarm/task-${id}`;
      const dir = join(this.worktreeBase, `agent-${id}`);
      let baseRef: string | undefined;
      try { baseRef = gitExec("git rev-parse HEAD", this.config.cwd).trim(); } catch {}
      let worktreeOk = false;
      for (let wt = 0; wt < 2 && !worktreeOk; wt++) {
        try {
          gitExec(`git worktree add -b "${branch}" "${dir}" HEAD`, this.config.cwd);
          worktreeOk = true;
        } catch (e: any) {
          if (wt === 0) {
            this.log(id, `Worktree failed, cleaning up: ${e.message?.slice(0, 50)}`);
            try { gitExec(`git branch -D "${branch}"`, this.config.cwd); } catch {}
            try { rmSync(dir, { recursive: true, force: true }); } catch {}
            try { gitExec("git worktree prune", this.config.cwd); } catch {}
          }
        }
      }
      if (worktreeOk) {
        agentCwd = dir;
        agent.branch = branch;
        agent.baseRef = baseRef;
        this.log(id, `Worktree: ${branch}`);
      } else {
        this.log(id, `Worktree failed after retry — running without isolation`);
      }
    }

    this.log(id, `Starting: ${task.prompt.slice(0, 60)}`);
    const maxRetries = this.config.maxRetries ?? 2;
    const inactivityMs = this.config.agentTimeoutMs ?? 15 * 60 * 1000;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const backoffMs = Math.min(30000, 1000 * 2 ** (attempt - 1)) * (0.5 + Math.random());
        this.log(id, `Retry ${attempt}/${maxRetries} in ${Math.round(backoffMs)}ms`);
        await sleep(backoffMs);
        agent.status = "running"; agent.error = undefined; agent.finishedAt = undefined;
      }

      try {
        const perm = this.config.permissionMode ?? "auto";
        let resumeSessionId: string | undefined;
        let resumePrompt = "Continue. Complete the task.";

        const runOnce = async (isResume: boolean): Promise<void> => {
          const preamble = "Keep files under ~500 lines. If a file would exceed that, split it.\n\n";
          const agentPrompt = isResume ? resumePrompt
            : this.config.useWorktrees && !task.noWorktree
              ? `You are working in an isolated git worktree. Focus only on this task. Do NOT commit your changes — the framework handles that.\n\n${preamble}${task.prompt}`
              : `${preamble}${task.prompt}`;

          const agentQuery = query({
            prompt: agentPrompt,
            options: {
              cwd: agentCwd, model: task.model || this.config.model, permissionMode: perm,
              ...(perm === "bypassPermissions" && { allowDangerouslySkipPermissions: true }),
              allowedTools: this.config.allowedTools, includePartialMessages: true, persistSession: true,
              ...(isResume && resumeSessionId && { resume: resumeSessionId }),
            },
          });

          const timeoutMs = isResume ? inactivityMs * 2 : inactivityMs;
          let sessionId: string | undefined;
          let lastActivity = Date.now();
          let timer: NodeJS.Timeout;
          const watchdog = new Promise<never>((_, reject) => {
            const check = () => {
              const silent = Date.now() - lastActivity;
              if (silent >= timeoutMs) {
                agentQuery.interrupt().catch(() => agentQuery.close());
                reject(isResume ? new AgentTimeoutError(silent) : new NudgeError(sessionId, silent));
              } else {
                timer = setTimeout(check, Math.min(30_000, timeoutMs - silent + 1000));
              }
            };
            timer = setTimeout(check, timeoutMs);
          });
          this.activeQueries.add(agentQuery);
          try {
            await Promise.race([
              (async () => {
                for await (const msg of agentQuery) {
                  lastActivity = Date.now();
                  if (!sessionId && "session_id" in (msg as any)) sessionId = (msg as any).session_id;
                  this.handleMsg(agent, msg);
                }
              })(),
              watchdog,
            ]);
          } finally {
            clearTimeout(timer!);
            this.activeQueries.delete(agentQuery);
            if (sessionId) resumeSessionId = sessionId;
            try { agentQuery.close(); } catch {}
          }
        };

        try { await runOnce(false); }
        catch (nudgeErr) {
          if (nudgeErr instanceof NudgeError && resumeSessionId) {
            this.log(id, `Silent ${Math.round(inactivityMs / 60000)}m — resuming with continue`);
            await runOnce(true);
          } else throw nudgeErr;
        }

        if (resumeSessionId && agent.status === "running") {
          try { this.log(id, "Simplify pass"); resumePrompt = SIMPLIFY_PROMPT; await runOnce(true); }
          catch { this.log(id, "Simplify pass skipped"); }
        }

        if (agent.status === "running") {
          agent.finishedAt = Date.now();
          const duration = agent.finishedAt - (agent.startedAt || agent.finishedAt);
          if (agent.toolCalls === 0 && (agent.costUsd ?? 0) < 0.001 && duration < 15_000) {
            agent.status = "error"; agent.error = "Agent did no work — exited without tool use"; this.failed++;
            this.log(id, agent.error);
          } else {
            agent.status = "done"; this.completed++;
          }
        }
        break;
      } catch (err: any) {
        if (agent.status !== "running") break;
        // Rate-limit errors: wait and retry WITHOUT burning the retry budget
        if (!this.aborted && isRateLimitError(err)) {
          const waitMs = this.rateLimitResetsAt && this.rateLimitResetsAt > Date.now()
            ? Math.max(5000, this.rateLimitResetsAt - Date.now())
            : 120_000;
          // If the whole swarm has been making zero progress for a while, stop giving
          // rate-limit retries a free pass — force them to count against maxRetries so
          // we eventually surrender instead of looping forever.
          const globallyStalled = Date.now() - this.lastProgressAt > 15 * 60_000;
          const freebie = !globallyStalled;
          this.log(id, `Rate limited — waiting ${Math.ceil(waitMs / 1000)}s${freebie ? " (attempt not counted)" : " (counted — swarm stalled)"}`);
          agent.blockedAt = Date.now();
          this.rateLimitPaused++;
          await sleep(waitMs);
          this.rateLimitPaused--;
          agent.blockedAt = undefined;
          this.isUsingOverage = false;
          this.rateLimitUtilization = 0;
          this.rateLimitResetsAt = undefined;
          this.checkStall();
          if (freebie) attempt--; // normal case: don't count against retries
          continue;
        }
        const canRetry = attempt < maxRetries && !this.aborted && isTransientError(err);
        if (canRetry) { this.log(id, `Transient error: ${String(err.message || err).slice(0, 80)}`); continue; }
        agent.status = "error"; agent.error = String(err.message || err).slice(0, 120);
        agent.finishedAt = Date.now(); this.failed++;
        this.log(id, agent.error);
      }
    }

    if (this.config.useWorktrees && agent.branch) {
      agent.filesChanged = autoCommit(agent.id, agent.task.prompt, agentCwd, agent.baseRef, (id, text) => this.log(id, text));
    }
    if (agent.status === "done") this.log(agent.id, this.agentSummary(agent));
  }

  private agentSummary(agent: AgentState): string {
    const dur = (agent.finishedAt ?? Date.now()) - (agent.startedAt ?? Date.now());
    const m = Math.floor(dur / 60000);
    const s = Math.round((dur % 60000) / 1000);
    const verb = agent.status === "error" ? "errored" : "done";
    const files = agent.filesChanged != null ? `, ${agent.filesChanged} files changed` : "";
    return `Agent ${agent.id} ${verb}: ${m}m ${s}s, ${agent.toolCalls} tools${files}`;
  }

  // ── Message handler ──

  private handleMsg(agent: AgentState, msg: SDKMessage): void {
    // Any message that isn't a rate-limit event counts as real progress and
    // resets the stall watchdog + clears the per-agent blocked flag.
    if (msg.type !== "rate_limit_event") {
      this.markProgress();
      if (agent.blockedAt != null) agent.blockedAt = undefined;
    }
    switch (msg.type) {
      case "assistant": {
        const m = msg as SDKAssistantMessage;
        if (!m.message?.content) break;
        for (const block of m.message.content) {
          if (block.type === "text" && block.text) {
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
          if (cb?.type === "tool_use") { agent.currentTool = cb.name; agent.toolCalls++; this.log(agent.id, cb.name); }
        } else if (ev.type === "content_block_delta") {
          const delta = (ev as any).delta;
          if (delta?.type === "text_delta" && delta.text) {
            const t = delta.text.trim();
            if (t) agent.lastText = t.slice(0, 80);
          }
        }
        break;
      }
      case "result": {
        const safeAdd = (v: unknown) => typeof v === 'number' && isFinite(v) && v >= 0 ? v : 0;
        const r = msg as SDKResultMessage;
        agent.currentTool = undefined; agent.finishedAt = Date.now();
        const cost = safeAdd(r.total_cost_usd);
        agent.costUsd = cost; this.totalCostUsd += cost;
        if (this.isUsingOverage) this.overageCostUsd += cost;
        if (r.usage) {
          this.totalInputTokens += safeAdd(r.usage.input_tokens);
          this.totalOutputTokens += safeAdd(r.usage.output_tokens);
        }

        // Surface SDK diagnostics so silent failures stop looking like "did no work".
        const denials = r.permission_denials ?? [];
        if (denials.length > 0) {
          const tools = Array.from(new Set(denials.map(d => d.tool_name))).join(", ");
          this.log(agent.id, `${denials.length} permission denial(s): ${tools}`);
        }
        if (r.terminal_reason && r.terminal_reason !== "completed") {
          this.log(agent.id, `terminal: ${r.terminal_reason}`);
        }
        if (r.stop_reason && r.stop_reason !== "end_turn" && r.stop_reason !== "stop_sequence") {
          this.log(agent.id, `stop: ${r.stop_reason}`);
        }
        if (typeof r.num_turns === "number" && r.num_turns > 0) {
          this.log(agent.id, `${r.num_turns} turns`);
        }

        if (r.subtype === "success") {
          agent.status = "done"; this.completed++;
        } else {
          agent.status = "error";
          const parts: string[] = [r.subtype];
          if (r.terminal_reason && r.terminal_reason !== "completed") parts.push(r.terminal_reason);
          const errs = (r as SDKResultError).errors;
          if (Array.isArray(errs) && errs.length > 0) {
            parts.push(errs[0]);
            for (const e of errs.slice(1, 3)) this.log(agent.id, `err: ${String(e).slice(0, 160)}`);
          }
          agent.error = parts.join(" — ").slice(0, 180);
          this.failed++; this.log(agent.id, agent.error);
        }
        break;
      }
      case "rate_limit_event": {
        const rl = msg as SDKRateLimitEvent;
        const info = rl.rate_limit_info;
        this.rateLimitUtilization = info.utilization ?? 0;
        if (info.resetsAt) this.rateLimitResetsAt = info.resetsAt;
        else if (info.status !== "rejected") this.rateLimitResetsAt = undefined;
        if ((info as any).isUsingOverage) this.isUsingOverage = true;
        const windowType = (info as any).rateLimitType as string | undefined;
        if (windowType) {
          this.rateLimitWindows.set(windowType, {
            type: windowType, utilization: info.utilization ?? 0, status: info.status, resetsAt: info.resetsAt,
          });
        }
        const pct = info.utilization != null ? `${Math.round(info.utilization * 100)}%` : "";
        const overageTag = this.isUsingOverage ? " [EXTRA]" : "";
        this.log(agent.id, `Rate: ${info.status} ${pct}${overageTag}${windowType ? ` (${windowType})` : ""}`);
        if (info.status === "rejected") {
          if (!this.rateLimitResetsAt || this.rateLimitResetsAt <= Date.now()) {
            this.rateLimitResetsAt = Date.now() + 60_000;
          }
          throw new Error("rate limit rejected — retrying");
        }
        break;
      }
    }
  }
}

class AgentTimeoutError extends Error {
  constructor(silentMs: number) {
    super(`Agent silent for ${Math.round(silentMs / 1000)}s — assumed hung`);
    this.name = "AgentTimeoutError";
  }
}

function isRateLimitError(err: unknown): boolean {
  const status: number | undefined = (err as any)?.status ?? (err as any)?.statusCode;
  if (status === 429) return true;
  const msg = String((err as any)?.message || err).toLowerCase();
  if (msg.includes("rate limit") || msg.includes("rate_limit") || msg.includes("too many requests")) return true;
  const cause = (err as any)?.cause;
  if (cause && cause !== err) return isRateLimitError(cause);
  return false;
}

function isTransientError(err: unknown): boolean {
  if (err instanceof AgentTimeoutError) return false;
  const msg = String((err as any)?.message || err).toLowerCase();
  const status: number | undefined = (err as any)?.status ?? (err as any)?.statusCode;
  if (status === 429 || (status != null && status >= 500 && status < 600) ||
    msg.includes("rate limit") || msg.includes("overloaded") || msg.includes("econnreset") ||
    msg.includes("etimedout") || msg.includes("socket hang up") || msg.includes("epipe") ||
    msg.includes("econnrefused") || msg.includes("ehostunreach") || msg.includes("network error") ||
    msg.includes("fetch failed") || msg.includes("aborted")) return true;
  const cause = (err as any)?.cause;
  if (cause && cause !== err) return isTransientError(cause);
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
