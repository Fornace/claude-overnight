import { existsSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import chalk from "chalk";
import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKMessage, SDKResultMessage, SDKResultError, SDKAssistantMessage,
  SDKPartialAssistantMessage, SDKRateLimitEvent,
} from "@anthropic-ai/claude-agent-sdk";
import { NudgeError, RATE_LIMIT_WINDOW_SHORT, extractToolTarget, sumUsageTokens, type PermMode } from "../core/types.js";
import type { Task, AgentState, SwarmPhase, MergeStrategy, RateLimitWindow, AITurn } from "../core/types.js";
import { gitExec, autoCommit, mergeAllBranches, warnDirtyTree, cleanStaleWorktrees, writeSwarmLog } from "./merge.js";
import type { MergeResult, ErroredBranchEvaluator } from "./merge.js";
import { ensureCursorProxyRunning, PROXY_DEFAULT_URL } from "../providers/index.js";

/**
 * Proxied Cursor models ignore SDK `cwd` and use their own workspace
 * resolution. Inject `X-Cursor-Workspace` via ANTHROPIC_CUSTOM_HEADERS so the
 * proxy's per-request workspace override points at this agent's cwd.
 * Requires the proxy to run with `CURSOR_BRIDGE_WORKSPACE=/` (or a parent of
 * all worktree paths) so the header value passes the safety check.
 */
function withCursorWorkspaceHeader(
  env: Record<string, string> | undefined,
  cwd: string,
): Record<string, string> | undefined {
  if (!env) return undefined;
  if (env.ANTHROPIC_BASE_URL !== PROXY_DEFAULT_URL) return env;
  const hdr = `X-Cursor-Workspace: ${cwd}`;
  const existing = env.ANTHROPIC_CUSTOM_HEADERS?.trim();
  return {
    ...env,
    ANTHROPIC_CUSTOM_HEADERS: existing
      ? `${existing}\n${hdr}`
      : hdr,
  };
}
import { getModelCapability } from "../core/models.js";
import { createTurn, beginTurn, endTurn, updateTurn } from "../core/turns.js";

const SIMPLIFY_PROMPT = `You just finished your task. Review and simplify your changes.

Invoke the \`simplify\` skill to review your changes for reuse, quality, and efficiency, then fix any issues found.`;

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
  /** Per-task env overrides: given a model id, return the env to pass to `query()` (or undefined for Anthropic default). */
  envForModel?: (model?: string) => Record<string, string> | undefined;
  /** When true, the run uses cursor-composer-in-claude. The swarm will attempt to restart it if it crashes mid-run. */
  cursorProxy?: boolean;
}

export class Swarm {
  readonly agents: AgentState[] = [];
  readonly logs: { time: number; agentId: number; text: string }[] = [];
  private readonly allLogs: { time: number; agentId: number; text: string }[] = [];
  private readonly _agentTurns: Map<number, AITurn> = new Map();
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

  /** Prior-wave orphan branches recovered during stale worktree cleanup. */
  staleRecovered = 0;
  /** Prior-wave orphan branches discarded as unmergeable. */
  staleForceDeleted = 0;

  rateLimitUtilization = 0;
  rateLimitResetsAt?: number;
  rateLimitWindows: Map<string, RateLimitWindow> = new Map();
  rateLimitPaused = 0;
  /** Wall-clock ms the global rate-limit wait started. Reset to undefined once nothing is blocked. */
  rateLimitBlockedSince?: number;
  isUsingOverage = false;
  overageCostUsd = 0;
  private rateLimitExplained = false;
  private rateLimitWakers: (() => void)[] = [];

  /** Live-adjustable concurrency target. Workers above this count exit on the next task boundary. */
  targetConcurrency: number;
  /** When true, dispatch is frozen  -- workers wait without starting new tasks. */
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
  private activeQueries = new Set<Query>();
  private cleanedUp = false;
  // Per-agent open tool_use block: cursor-composer-in-claude v0.9 opens the block
  // with empty `input` and streams the real payload via `input_json_delta`, so we
  // need to wait for content_block_stop before we can log the file/path target.
  private pendingTools = new WeakMap<AgentState, { name: string; input: Record<string, unknown>; buf: string; logged: boolean }>();
  private ctxWarned = new WeakSet<AgentState>();
  logFile?: string;
  model: string | undefined;
  usageCap: number | undefined;
  readonly allowExtraUsage: boolean;
  extraUsageBudget: number | undefined;
  readonly baseCostUsd: number;
  mergeBranch?: string;
  /** Permission mode read from config on each agent dispatch. Writable for mid-run changes. */
  private _permMode: PermMode | undefined;

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
    this._permMode = config.permissionMode;
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
    if (b) {
      // Instant: interrupt every active SDK session so agents stop mid-turn.
      // After the interrupt, the for await loop exits, runOnce returns, and
      // runAgent detects this.paused and re-queues the task with resume info.
      this.activeQueries.forEach(q => { q.interrupt().catch(() => {}); });
      this.log(-1, "Pausing agents…");
    }
  }

  /** Returns the rate-limit window currently holding the swarm back  -- rejected first, then highest utilization. */
  mostConstrainedWindow(): RateLimitWindow | undefined {
    const windows = Array.from(this.rateLimitWindows.values());
    if (windows.length === 0) return undefined;
    const rejected = windows.find(w => w.status === "rejected" && (!w.resetsAt || w.resetsAt > Date.now()));
    if (rejected) return rejected;
    return windows.reduce((a, b) => (a.utilization >= b.utilization ? a : b));
  }

  private windowTag(): string {
    const w = this.mostConstrainedWindow();
    if (!w) return "";
    const name = RATE_LIMIT_WINDOW_SHORT[w.type] ?? w.type.replace(/_/g, " ");
    return ` (${name} window)`;
  }

  /** Cancellable sleep used by rate-limit waits. `retryRateLimitNow()` wakes every pending sleeper. */
  private rateLimitSleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const i = this.rateLimitWakers.indexOf(finish);
        if (i >= 0) this.rateLimitWakers.splice(i, 1);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.rateLimitWakers.push(finish);
    });
  }

  /** Force-wake every rate-limit sleeper and clear the reset timestamp so the next attempt fires immediately. */
  retryRateLimitNow(): void {
    const n = this.rateLimitWakers.length;
    if (n === 0) {
      this.log(-1, "Retry-now: no workers waiting on rate limit");
      return;
    }
    this.rateLimitResetsAt = undefined;
    this.rateLimitUtilization = 0;
    const wakers = this.rateLimitWakers.slice();
    this.rateLimitWakers.length = 0;
    for (const w of wakers) w();
    this.log(-1, `Retry-now: woke ${n} worker(s)  -- hitting API immediately (may be rejected again)`);
  }

  /** Live-adjust the overage spend cap. `undefined` = unlimited. If already over the new cap, stop dispatch. */
  setExtraUsageBudget(n: number | undefined): void {
    if (this.extraUsageBudget === n) return;
    const prev = this.extraUsageBudget;
    this.extraUsageBudget = n;
    const fmt = (v: number | undefined) => v != null ? `$${v}` : "unlimited";
    this.log(-1, `Extra usage budget: ${fmt(prev)} → ${fmt(n)}`);
    if (n != null && this.isUsingOverage && this.overageCostUsd >= n) {
      this.capForOverage(`Extra usage budget $${n} exceeded ($${this.overageCostUsd.toFixed(2)} spent)  -- stopping dispatch`);
    }
  }

  /** Live-adjust the worker model. Picked up by next agent dispatch. */
  setModel(m: string): void {
    if (this.model === m) return;
    const prev = this.model;
    this.model = m;
    this.log(-1, `Worker model: ${prev} → ${m}`);
  }

  /** Live-adjust the SDK permission mode. Picked up by next agent dispatch. */
  setPermissionMode(m: PermMode): void {
    if (this._permMode === m) return;
    const prev = this._permMode ?? "auto";
    this._permMode = m;
    const label = m === "bypassPermissions" ? "yolo" : m;
    this.log(-1, `Permission mode: ${prev === "bypassPermissions" ? "yolo" : prev} → ${label}`);
  }

  async run(): Promise<void> {
    try {
      if (this.config.useWorktrees) {
        warnDirtyTree(this.config.cwd, (id, text) => this.log(id, text));
        const staleResult = cleanStaleWorktrees(this.config.cwd, (id, text) => this.log(id, text));
        this.staleRecovered = staleResult.recovered;
        this.staleForceDeleted = staleResult.forceDeleted;
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
        const branches = this.agents.filter(a => a.branch && (a.filesChanged ?? 0) > 0)
          .map(a => ({ id: a.id, branch: a.branch!, filesChanged: a.filesChanged ?? 0, status: a.status, task: a.task.prompt }));
        const evalErrored = this.buildErroredBranchEvaluator();
        const result = await mergeAllBranches(branches, this.config.cwd, this.config.mergeStrategy ?? "yolo", (id, text) => this.log(id, text), evalErrored);
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
    this.activeQueries.forEach(q => { q.interrupt().catch(() => {}); });
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
        catch (err: any) {
          const msg = String(err?.message || err).slice(0, 80);
          this.log(-1, `Worker error: ${msg}`);
          // If cursor proxy is in use and the task may have failed due to a proxy crash,
          // attempt to restart it before the next task.
          if (this.config.cursorProxy) {
            this.log(-1, "  Checking cursor proxy health…");
            const restarted = await ensureCursorProxyRunning(PROXY_DEFAULT_URL, { projectRoot: this.config.cwd });
            if (!restarted) {
              this.log(-1, chalk.yellow("  ⚠ Proxy still down — remaining tasks may fail"));
            }
          }
        }
        tasksProcessed++;
      }
      this.log(-1, `Worker finished (${tasksProcessed} tasks)`);
    } finally {
      this.workerCount--;
    }
  }

  /** Mark real progress  -- resets stall state. Called on any assistant/tool/result message. */
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
      this.log(-1, `Stalled ${Math.round(stalledFor / 60000)}m with no progress  -- aborting run so you can resume later`);
      this.abort();
      return;
    }
    if (this.targetConcurrency <= 1 && stalledFor >= 15 * 60_000) {
      this.stallLevel = 3;
      this.stallActionAt = Date.now();
      const until = Date.now() + 10 * 60_000;
      this.rateLimitResetsAt = until;
      this.log(-1, `Stalled at concurrency 1 for ${Math.round(stalledFor / 60000)}m  -- forcing 10m cooldown`);
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
      this.capForOverage(`Extra usage budget $${this.extraUsageBudget} reached ($${this.overageCostUsd.toFixed(2)} spent)  -- stopping dispatch`);
      return;
    }

    // Wait loop: keep waiting until the blocking condition clears
    // isUsingOverage is purely informational  -- the API enforces overage via 429s
    // which the retry loop handles. Throttle only gates on actual rejections and user cap.
    let consecutiveWaits = 0;
    for (;;) {
      if (this.aborted || this.cappedOut) return;
      const cap = this.usageCap;
      const capExceeded = cap != null && cap < 1 && this.rateLimitUtilization >= cap;
      const rejected = this.rateLimitResetsAt && this.rateLimitResetsAt > Date.now();
      // Proactive: check per-window rejections even when rateLimitResetsAt isn't set
      const windowRejected = this.windowRejectedReset();
      // Proactive: near-critical utilization (no cap set but API is clearly strained)
      const nearCritical = cap == null && this.rateLimitUtilization >= 0.95;
      if (!capExceeded && !rejected && !windowRejected && !nearCritical) break;

      const fallbackMs = Math.min(300_000, 60_000 * (1 + consecutiveWaits * 2));
      const waitMs = (rejected || windowRejected)
        ? Math.max(5000, (windowRejected ?? this.rateLimitResetsAt!) - Date.now())
        : nearCritical
          ? 30_000 * (1 + consecutiveWaits)
          : fallbackMs;
      const reason = capExceeded
        ? `Usage at ${Math.round(this.rateLimitUtilization * 100)}% (cap ${Math.round(cap! * 100)}%)`
        : nearCritical
          ? `Near-critical utilization ${Math.round(this.rateLimitUtilization * 100)}%`
          : `Rate limited${this.windowTag()}`;
      this.log(-1, `${reason}  -- waiting ${Math.ceil(waitMs / 1000)}s then retrying ([r] to retry now)`);
      if (this.rateLimitPaused === 0) this.rateLimitBlockedSince = Date.now();
      this.rateLimitPaused++;
      await this.rateLimitSleep(waitMs);
      this.rateLimitPaused--;
      if (this.rateLimitPaused === 0) this.rateLimitBlockedSince = undefined;
      this.rateLimitUtilization = 0;
      this.rateLimitResetsAt = undefined;
      consecutiveWaits++;
      this.checkStall();
      if (this.aborted || this.cappedOut) return;
    }
  }

  /** Returns the nearest future resetsAt from any rejected window, or undefined. */
  private windowRejectedReset(): number | undefined {
    let nearest: number | undefined;
    for (const w of this.rateLimitWindows.values()) {
      if (w.status === "rejected" && w.resetsAt && w.resetsAt > Date.now()) {
        if (!nearest || w.resetsAt < nearest) nearest = w.resetsAt;
      }
    }
    return nearest;
  }

  // ── Agent execution ──

  private async runAgent(task: Task): Promise<void> {
    // Guard: if pause was triggered between dispatch and here, re-queue immediately.
    // The worker already shifted this task, so unshift puts it back for resume.
    if (this.paused) {
      this.queue.unshift(task);
      return;
    }
    const id = this.nextId++;
    const agent: AgentState = { id, task, status: "running", startedAt: Date.now(), toolCalls: 0, contextTokens: 0, model: task.model || this.model };
    this.agents.push(agent);

    const turn = createTurn("swarm", `Agent ${id}`, `swarm-${id}`, agent.model);
    beginTurn(turn);
    this._agentTurns.set(id, turn);

    let agentCwd = task.agentCwd || task.cwd || this.config.cwd;
    if (this.config.useWorktrees && this.worktreeBase && !task.noWorktree && !task.agentCwd) {
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
        this.log(id, `Worktree failed after retry  -- running without isolation`);
      }
    }

    const isResumed = !!task.resumeSessionId;
    this.log(id, isResumed ? `Resuming: ${task.prompt.slice(0, 60)}` : `Starting: ${task.prompt.slice(0, 60)}`);
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
        const perm = this._permMode ?? "auto";
        let resumeSessionId: string | undefined = task.resumeSessionId;
        let resumePrompt = "Continue. Complete the task.";

        const runOnce = async (isResume: boolean): Promise<void> => {
          const preamble = "Keep files under ~500 lines. If a file would exceed that, split it.\n\n";
          const postBlock = task.postcondition
            ? `\n\nEXIT CRITERION — after you finish, the framework will run this shell check in cwd and reject a no-op if it fails:\n  $ ${task.postcondition}\nYour work is not done until that command exits 0. Don't claim no-op unless you can prove the check already passes.`
            : "";
          const agentPrompt = isResume ? resumePrompt
            : this.config.useWorktrees && !task.noWorktree
              ? `You are working in an isolated git worktree. Focus only on this task. Do NOT commit your changes  -- the framework handles that.\n\n${preamble}${task.prompt}${postBlock}`
              : `${preamble}${task.prompt}${postBlock}`;

          const effectiveModel = task.model || this.config.model;
          const envOverride = withCursorWorkspaceHeader(
            this.config.envForModel?.(effectiveModel),
            agentCwd,
          );
          const agentQuery = query({
            prompt: agentPrompt,
            options: {
              cwd: agentCwd, model: effectiveModel, permissionMode: perm,
              ...(perm === "bypassPermissions" && { allowDangerouslySkipPermissions: true }),
              allowedTools: this.config.allowedTools, includePartialMessages: true, persistSession: true,
              ...(isResume && resumeSessionId && { resume: resumeSessionId }),
              ...(envOverride && { env: envOverride }),
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
          // Guard: if pause was triggered between runAgent check and here, close the query
          // immediately so requeueIfPaused can catch it without running a turn.
          if (this.paused) {
            this.activeQueries.delete(agentQuery);
            try { agentQuery.close(); } catch {}
            return;
          }
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

        // Helper: re-queue this task with resume info when paused mid-turn.
        const requeueIfPaused = (): boolean => {
          if (!this.paused || agent.status !== "running") return false;
          agent.status = "paused";
          this.log(id, "Paused mid-task");
          if (resumeSessionId) {
            this.queue.unshift({ ...task, resumeSessionId, agentCwd });
          }
          return true;
        };

        if (isResumed && resumeSessionId) {
          // Resumed task: continue the existing SDK session
          try { await runOnce(true); }
          catch (nudgeErr) {
            if (nudgeErr instanceof NudgeError && resumeSessionId) {
              this.log(id, `Silent ${Math.round(inactivityMs / 60000)}m  -- resuming with continue`);
              await runOnce(true);
            } else throw nudgeErr;
          }
        } else {
          // Fresh task: start with the task prompt
          try { await runOnce(false); }
          catch (nudgeErr) {
            if (nudgeErr instanceof NudgeError && resumeSessionId) {
              this.log(id, `Silent ${Math.round(inactivityMs / 60000)}m  -- resuming with continue`);
              await runOnce(true);
            } else throw nudgeErr;
          }
        }
        if (requeueIfPaused()) return;

        if (resumeSessionId && agent.status === "running") {
          try { this.log(id, "Simplify pass"); resumePrompt = SIMPLIFY_PROMPT; await runOnce(true); }
          catch { this.log(id, "Simplify pass skipped"); }
        }
        if (requeueIfPaused()) return;

        if (agent.status === "running") {
          agent.finishedAt = Date.now();
          const duration = agent.finishedAt - (agent.startedAt || agent.finishedAt);
          if (agent.toolCalls === 0 && (agent.costUsd ?? 0) < 0.001 && duration < 15_000) {
            agent.status = "error"; agent.error = "Agent did no work  -- exited without tool use"; this.failed++;
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
          // rate-limit retries a free pass  -- force them to count against maxRetries so
          // we eventually surrender instead of looping forever.
          const globallyStalled = Date.now() - this.lastProgressAt > 15 * 60_000;
          const freebie = !globallyStalled;
          this.log(id, `Rate limited${this.windowTag()}  -- waiting ${Math.ceil(waitMs / 1000)}s${freebie ? " (attempt not counted)" : " (counted  -- swarm stalled)"} ([r] to retry now)`);
          agent.blockedAt = Date.now();
          this.rateLimitPaused++;
          await this.rateLimitSleep(waitMs);
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
    updateTurn(turn, { costUsd: agent.costUsd });
    endTurn(turn, agent.status === "done" ? "done" : agent.status === "paused" ? "stopped" : "error");
    this._agentTurns.delete(id);
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

  // ── Errored branch AI evaluator ──

  /**
   * Build an evaluator that calls the fast model (or worker fallback) to judge
   * whether an errored agent's partial work is coherent enough to merge.
   */
  private buildErroredBranchEvaluator(): ErroredBranchEvaluator | undefined {
    const evalModel = this.model;
    if (!evalModel) return undefined;
    const envFor = this.config.envForModel;

    return async (agentId: number, task: string, diff: string): Promise<{ keep: boolean; reason: string }> => {
      const prompt = `You are evaluating whether partial work from an agent that errored mid-task should be kept or discarded.

Task: "${task}"

Diff of changes:
\`\`\`
${diff}
\`\`\`

Is this partial work coherent enough to land? Consider:
- Does it implement a meaningful portion of the task?
- Are the changes self-consistent (no half-written functions, broken imports)?
- Would merging this improve or degrade the codebase?

Respond with JSON: {"keep": true/false, "reason": "brief explanation"}`;

      let eq: ReturnType<typeof query> | undefined;
      try {
        eq = query({
          prompt,
          options: {
            cwd: this.config.cwd,
            model: evalModel,
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            maxTurns: 1,
            persistSession: false,
            ...(envFor?.(evalModel) && {
              env: withCursorWorkspaceHeader(envFor!(evalModel), this.config.cwd)!,
            }),
          },
        });
        this.activeQueries.add(eq);
        let output = "";
        for await (const msg of eq) {
          if (msg.type === "assistant") {
            const am = msg as SDKAssistantMessage;
            if (am.message?.content) {
              for (const block of am.message.content) {
                if (block.type === "text" && block.text) output += block.text;
              }
            }
          }
          if (msg.type === "result") break;
        }

        // Parse JSON from the response
        const jsonMatch = output.match(/\{[\s\S]*"keep"\s*:\s*(true|false)[\s\S]*"reason"\s*:\s*"[^"]*"[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]) as { keep: boolean; reason: string };
            if (typeof parsed.keep === "boolean" && typeof parsed.reason === "string") return parsed;
          } catch {}
        }

        // Fallback: couldn't parse structured output — keep by default
        this.log(agentId, "Branch eval: could not parse model response, keeping by default");
        return { keep: true, reason: "model response unparseable, keeping by default" };
      } catch (err: any) {
        this.log(agentId, `Branch eval API error: ${String(err?.message || err).slice(0, 120)}`);
        return { keep: true, reason: "eval API error, keeping by default" };
      } finally {
        if (eq) {
          this.activeQueries.delete(eq);
          try { eq.close(); } catch {}
        }
      }
    };
  }

  // ── Message handler ──

  /** Log a tool invocation with a short target extracted from its input. */
  private logToolUse(agent: AgentState, name: string, input: Record<string, unknown>): void {
    const target = extractToolTarget(input);
    this.log(agent.id, target ? `${name} \u2192 ${target}` : name);
  }

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
        const u = m.message?.usage as { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
        if (u) {
          const turnTotal = sumUsageTokens(u);
          agent.contextTokens = turnTotal;
          if (turnTotal > (agent.peakContextTokens ?? 0)) agent.peakContextTokens = turnTotal;
          const turn = this._agentTurns.get(agent.id);
          if (turn) updateTurn(turn, { contextTokens: turnTotal, peakContextTokens: Math.max(turn.peakContextTokens ?? 0, turnTotal) });
          if (!this.ctxWarned.has(agent)) {
            const mdl = agent.task.model || this.config.model || "unknown";
            const safe = getModelCapability(mdl).safeContext;
            if (safe > 0 && turnTotal > safe * 0.8) {
              this.ctxWarned.add(agent);
              const pct = Math.round((turnTotal / safe) * 100);
              this.log(agent.id, `\u26A0 context ${pct}% of safe window — task may degrade`);
            }
          }
        }
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
          if (cb?.type === "tool_use") {
            agent.currentTool = cb.name; agent.toolCalls++;
            const input = (cb.input ?? {}) as Record<string, unknown>;
            const hasInput = Object.keys(input).length > 0;
            this.pendingTools.set(agent, { name: cb.name, input, buf: "", logged: hasInput });
            if (hasInput) this.logToolUse(agent, cb.name, input);
          } else if (cb?.type === "thinking" || cb?.type === "redacted_thinking") {
            agent.lastText = "thinking…";
          }
        } else if (ev.type === "content_block_delta") {
          const delta = (ev as any).delta;
          const pending = this.pendingTools.get(agent);
          if (delta?.type === "input_json_delta" && pending && typeof delta.partial_json === "string") {
            pending.buf += delta.partial_json;
            break;
          }
          // thinking_delta: `delta.thinking`; text_delta: `delta.text`.
          const raw = delta?.type === "text_delta" ? delta.text
            : delta?.type === "thinking_delta" ? delta.thinking
            : undefined;
          if (typeof raw === "string") {
            const t = raw.trim();
            if (t) agent.lastText = t.slice(-80);
          }
        } else if (ev.type === "content_block_stop") {
          const pending = this.pendingTools.get(agent);
          if (pending && !pending.logged) {
            if (pending.buf) {
              try { pending.input = JSON.parse(pending.buf) as Record<string, unknown>; } catch {}
            }
            this.logToolUse(agent, pending.name, pending.input);
            pending.logged = true;
          }
          this.pendingTools.delete(agent);
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
          agent.error = parts.join("  -- ").slice(0, 180);
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
          if (!this.rateLimitExplained) {
            this.rateLimitExplained = true;
            const name = windowType ? (RATE_LIMIT_WINDOW_SHORT[windowType] ?? windowType.replace(/_/g, " ")) : "Anthropic";
            const overageNote = this.isUsingOverage ? " even on overage" : "";
            this.log(-1, `${name} window is full${overageNote}  -- plan-level Anthropic limit, not a claude-overnight cap. Press [r] to retry now, [c] to lower concurrency, or wait for reset.`);
          }
          throw new Error("rate limit rejected  -- retrying");
        }
        break;
      }
    }
  }
}

class AgentTimeoutError extends Error {
  constructor(silentMs: number) {
    super(`Agent silent for ${Math.round(silentMs / 1000)}s  -- assumed hung`);
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
