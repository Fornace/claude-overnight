import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import chalk from "chalk";
import { RATE_LIMIT_WINDOW_SHORT } from "../core/types.js";
import { gitExec, mergeAllBranches, warnDirtyTree, cleanStaleWorktrees, writeSwarmLog } from "./merge.js";
import { ensureCursorProxyRunning, PROXY_DEFAULT_URL } from "../providers/index.js";
import { sleep } from "./errors.js";
import { runAgent as runAgentImpl, buildErroredBranchEvaluator } from "./agent-run.js";
export class Swarm {
    agents = [];
    logs = [];
    allLogs = [];
    /** @internal -- friend surface for swarm-message-handler. */
    _agentTurns = new Map();
    startedAt = Date.now();
    total;
    completed = 0;
    failed = 0;
    totalCostUsd = 0;
    totalInputTokens = 0;
    totalOutputTokens = 0;
    phase = "running";
    aborted = false;
    cappedOut = false;
    mergeResults = [];
    /** Prior-wave orphan branches recovered during stale worktree cleanup. */
    staleRecovered = 0;
    /** Prior-wave orphan branches discarded as unmergeable. */
    staleForceDeleted = 0;
    rateLimitUtilization = 0;
    rateLimitResetsAt;
    rateLimitWindows = new Map();
    rateLimitPaused = 0;
    /** Wall-clock ms the global rate-limit wait started. Reset to undefined once nothing is blocked. */
    rateLimitBlockedSince;
    isUsingOverage = false;
    overageCostUsd = 0;
    /** @internal -- friend surface for swarm-message-handler. */
    rateLimitExplained = false;
    rateLimitWakers = [];
    /** Live-adjustable concurrency target. Workers above this count exit on the next task boundary. */
    targetConcurrency;
    /** When true, dispatch is frozen  -- workers wait without starting new tasks. */
    paused = false;
    /** Wall-clock ms of the last sign of real progress (assistant msg, tool use, result). */
    lastProgressAt = Date.now();
    /** 0 = normal, 1 = halved once, 2 = halved twice, 3 = long cooldown at c=1, 4 = aborted. */
    stallLevel = 0;
    /** Last time the watchdog took an action; used to debounce escalations. */
    stallActionAt = 0;
    /** Live worker coroutine count (not agents). */
    workerCount = 0;
    /** Growable list of worker promises; run() awaits until empty. */
    workerPromises = [];
    /** @internal -- friend surface for swarm-agent-run. */
    queue;
    /** @internal -- friend surface for swarm-message-handler. */
    config;
    /** @internal -- friend surface for swarm-agent-run. */
    nextId = 0;
    /** @internal -- friend surface for swarm-agent-run. */
    worktreeBase;
    /** @internal -- friend surface for swarm-agent-run. */
    activeQueries = new Set();
    cleanedUp = false;
    // Per-agent open tool_use block: cursor-composer-in-claude v0.9 opens the block
    // with empty `input` and streams the real payload via `input_json_delta`, so we
    // need to wait for content_block_stop before we can log the file/path target.
    /** @internal -- friend surface for swarm-message-handler. */
    pendingTools = new WeakMap();
    /** @internal -- friend surface for swarm-message-handler. */
    ctxWarned = new WeakSet();
    logFile;
    model;
    usageCap;
    allowExtraUsage;
    extraUsageBudget;
    baseCostUsd;
    mergeBranch;
    /** Permission mode read from config on each agent dispatch. Writable for mid-run changes.
     *  @internal -- friend surface for swarm-agent-run. */
    _permMode;
    constructor(config) {
        if (!config.tasks.length)
            throw new Error("SwarmConfig: tasks array must not be empty");
        if (config.concurrency < 1)
            throw new Error("SwarmConfig: concurrency must be >= 1");
        if (!config.cwd)
            throw new Error("SwarmConfig: cwd must be a non-empty string");
        const seen = new Set();
        for (const task of config.tasks) {
            if (seen.has(task.prompt))
                console.warn(`SwarmConfig: duplicate task prompt: "${task.prompt.slice(0, 80)}"`);
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
    setConcurrency(n) {
        if (!Number.isFinite(n) || n < 1)
            return;
        const prev = this.targetConcurrency;
        if (n === prev)
            return;
        this.targetConcurrency = n;
        this.log(-1, `Concurrency changed: ${prev} → ${n}`);
        if (n > prev && this.queue.length > 0 && !this.aborted && !this.cappedOut) {
            const toSpawn = Math.min(n - this.workerCount, this.queue.length);
            for (let i = 0; i < toSpawn; i++)
                this.workerPromises.push(this.worker());
        }
    }
    /** Freeze/resume dispatch without killing the run. Paused workers block at the top of their loop. */
    setPaused(b) {
        if (this.paused === b)
            return;
        this.paused = b;
        this.log(-1, b ? "Dispatch paused" : "Dispatch resumed");
        if (b) {
            // Instant: interrupt every active SDK session so agents stop mid-turn.
            // After the interrupt, the for await loop exits, runOnce returns, and
            // runAgent detects this.paused and re-queues the task with resume info.
            this.activeQueries.forEach(q => { q.interrupt().catch(() => { }); });
            this.log(-1, "Pausing agents…");
        }
    }
    /** Returns the rate-limit window currently holding the swarm back  -- rejected first, then highest utilization. */
    mostConstrainedWindow() {
        const windows = Array.from(this.rateLimitWindows.values());
        if (windows.length === 0)
            return undefined;
        const rejected = windows.find(w => w.status === "rejected" && (!w.resetsAt || w.resetsAt > Date.now()));
        if (rejected)
            return rejected;
        return windows.reduce((a, b) => (a.utilization >= b.utilization ? a : b));
    }
    /** @internal -- friend surface for swarm-agent-run. */
    windowTag() {
        const w = this.mostConstrainedWindow();
        if (!w)
            return "";
        const name = RATE_LIMIT_WINDOW_SHORT[w.type] ?? w.type.replace(/_/g, " ");
        return ` (${name} window)`;
    }
    /** Cancellable sleep used by rate-limit waits. `retryRateLimitNow()` wakes every pending sleeper.
     *  @internal -- friend surface for swarm-agent-run. */
    rateLimitSleep(ms) {
        return new Promise(resolve => {
            let done = false;
            const finish = () => {
                if (done)
                    return;
                done = true;
                clearTimeout(timer);
                const i = this.rateLimitWakers.indexOf(finish);
                if (i >= 0)
                    this.rateLimitWakers.splice(i, 1);
                resolve();
            };
            const timer = setTimeout(finish, ms);
            this.rateLimitWakers.push(finish);
        });
    }
    /** Force-wake every rate-limit sleeper and clear the reset timestamp so the next attempt fires immediately. */
    retryRateLimitNow() {
        const n = this.rateLimitWakers.length;
        if (n === 0) {
            this.log(-1, "Retry-now: no workers waiting on rate limit");
            return;
        }
        this.rateLimitResetsAt = undefined;
        this.rateLimitUtilization = 0;
        const wakers = this.rateLimitWakers.slice();
        this.rateLimitWakers.length = 0;
        for (const w of wakers)
            w();
        this.log(-1, `Retry-now: woke ${n} worker(s)  -- hitting API immediately (may be rejected again)`);
    }
    /** Live-adjust the overage spend cap. `undefined` = unlimited. If already over the new cap, stop dispatch. */
    setExtraUsageBudget(n) {
        if (this.extraUsageBudget === n)
            return;
        const prev = this.extraUsageBudget;
        this.extraUsageBudget = n;
        const fmt = (v) => v != null ? `$${v}` : "unlimited";
        this.log(-1, `Extra usage budget: ${fmt(prev)} → ${fmt(n)}`);
        if (n != null && this.isUsingOverage && this.overageCostUsd >= n) {
            this.capForOverage(`Extra usage budget $${n} exceeded ($${this.overageCostUsd.toFixed(2)} spent)  -- stopping dispatch`);
        }
    }
    /** Live-adjust the worker model. Picked up by next agent dispatch. */
    setModel(m) {
        if (this.model === m)
            return;
        const prev = this.model;
        this.model = m;
        this.log(-1, `Worker model: ${prev} → ${m}`);
    }
    /** Live-adjust the SDK permission mode. Picked up by next agent dispatch. */
    setPermissionMode(m) {
        if (this._permMode === m)
            return;
        const prev = this._permMode ?? "auto";
        this._permMode = m;
        const label = m === "bypassPermissions" ? "yolo" : m;
        this.log(-1, `Permission mode: ${prev === "bypassPermissions" ? "yolo" : prev} → ${label}`);
    }
    async run() {
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
            for (let i = 0; i < n; i++)
                this.workerPromises.push(this.worker());
            // setConcurrency() can grow workerPromises during execution, so drain in a loop.
            while (this.workerPromises.length > 0) {
                const batch = this.workerPromises.slice();
                this.workerPromises.length = 0;
                await Promise.all(batch);
            }
            if (this.config.useWorktrees) {
                this.phase = "merging";
                const branches = this.agents.filter(a => a.branch && (a.filesChanged ?? 0) > 0)
                    .map(a => ({ id: a.id, branch: a.branch, filesChanged: a.filesChanged ?? 0, status: a.status, task: a.task.prompt }));
                const evalErrored = buildErroredBranchEvaluator(this);
                const result = await mergeAllBranches(branches, this.config.cwd, this.config.mergeStrategy ?? "yolo", (id, text) => this.log(id, text), evalErrored);
                this.mergeResults = result.mergeResults;
                if (result.mergeBranch)
                    this.mergeBranch = result.mergeBranch;
            }
            this.phase = "done";
        }
        finally {
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
    abort() {
        this.aborted = true;
        this.queue.length = 0;
        this.activeQueries.forEach(q => { q.interrupt().catch(() => { }); });
        this.activeQueries.clear();
    }
    /** Re-queue all errored agents' tasks for retry within this wave. */
    requeueFailed() {
        const errored = this.agents.filter(a => a.status === "error");
        if (errored.length === 0)
            return 0;
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
    log(agentId, text) {
        const entry = { time: Date.now(), agentId, text };
        this.logs.push(entry);
        this.allLogs.push(entry);
        this.logSequence++;
        if (this.logs.length > 300)
            this.logs.splice(0, this.logs.length - 150);
    }
    cleanup() {
        if (this.cleanedUp)
            return;
        this.cleanedUp = true;
        if (this.worktreeBase) {
            try {
                rmSync(this.worktreeBase, { recursive: true, force: true });
            }
            catch { }
            try {
                gitExec("git worktree prune", this.config.cwd);
            }
            catch { }
        }
    }
    // ── Worker loop ──
    async worker() {
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
                while (this.paused && !this.aborted && !this.cappedOut)
                    await sleep(500);
                await this.throttle();
                if (this.cappedOut || this.aborted)
                    break;
                if (this.workerCount > this.targetConcurrency)
                    return;
                const task = this.queue.shift();
                if (!task)
                    break;
                try {
                    await this.runAgent(task);
                }
                catch (err) {
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
        }
        finally {
            this.workerCount--;
        }
    }
    /** Mark real progress  -- resets stall state. Called on any assistant/tool/result message.
     *  @internal -- friend surface for swarm-message-handler. */
    markProgress() {
        this.lastProgressAt = Date.now();
        if (this.stallLevel > 0 && this.lastProgressAt > this.stallActionAt)
            this.stallLevel = 0;
    }
    /**
     * Stall watchdog. Called each time a worker finishes a rate-limit wait. Escalates when
     * the whole swarm has been stuck with no progress for a while:
     *   L1 @ 5m → halve concurrency
     *   L2 @ 10m → halve again
     *   L3 @ 15m+ at c=1 → force a 10-minute cooldown instead of hammering every 60s
     *   L4 @ 30m → abort the run so it can be resumed later without burning the budget
     */
    /** @internal -- friend surface for swarm-agent-run. */
    checkStall() {
        const stalledFor = Date.now() - this.lastProgressAt;
        if (stalledFor < 5 * 60_000)
            return;
        // Debounce so multiple workers waking at once don't double-escalate.
        if (Date.now() - this.stallActionAt < 60_000)
            return;
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
    capForOverage(reason) {
        if (this.cappedOut)
            return;
        this.cappedOut = true;
        this.queue.length = 0;
        this.log(-1, reason);
    }
    async throttle() {
        if (this.cappedOut)
            return;
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
            if (this.aborted || this.cappedOut)
                return;
            const cap = this.usageCap;
            const capExceeded = cap != null && cap < 1 && this.rateLimitUtilization >= cap;
            const rejected = this.rateLimitResetsAt && this.rateLimitResetsAt > Date.now();
            // Proactive: check per-window rejections even when rateLimitResetsAt isn't set
            const windowRejected = this.windowRejectedReset();
            // Proactive: near-critical utilization (no cap set but API is clearly strained)
            const nearCritical = cap == null && this.rateLimitUtilization >= 0.95;
            if (!capExceeded && !rejected && !windowRejected && !nearCritical)
                break;
            const fallbackMs = Math.min(300_000, 60_000 * (1 + consecutiveWaits * 2));
            const waitMs = (rejected || windowRejected)
                ? Math.max(5000, (windowRejected ?? this.rateLimitResetsAt) - Date.now())
                : nearCritical
                    ? 30_000 * (1 + consecutiveWaits)
                    : fallbackMs;
            const reason = capExceeded
                ? `Usage at ${Math.round(this.rateLimitUtilization * 100)}% (cap ${Math.round(cap * 100)}%)`
                : nearCritical
                    ? `Near-critical utilization ${Math.round(this.rateLimitUtilization * 100)}%`
                    : `Rate limited${this.windowTag()}`;
            this.log(-1, `${reason}  -- waiting ${Math.ceil(waitMs / 1000)}s then retrying ([r] to retry now)`);
            if (this.rateLimitPaused === 0)
                this.rateLimitBlockedSince = Date.now();
            this.rateLimitPaused++;
            await this.rateLimitSleep(waitMs);
            this.rateLimitPaused--;
            if (this.rateLimitPaused === 0)
                this.rateLimitBlockedSince = undefined;
            this.rateLimitUtilization = 0;
            this.rateLimitResetsAt = undefined;
            consecutiveWaits++;
            this.checkStall();
            if (this.aborted || this.cappedOut)
                return;
        }
    }
    /** Returns the nearest future resetsAt from any rejected window, or undefined. */
    windowRejectedReset() {
        let nearest;
        for (const w of this.rateLimitWindows.values()) {
            if (w.status === "rejected" && w.resetsAt && w.resetsAt > Date.now()) {
                if (!nearest || w.resetsAt < nearest)
                    nearest = w.resetsAt;
            }
        }
        return nearest;
    }
    // ── Agent execution ──
    async runAgent(task) {
        await runAgentImpl(this, task);
    }
    /** @internal -- friend surface for swarm-agent-run. */
    agentSummary(agent) {
        const dur = (agent.finishedAt ?? Date.now()) - (agent.startedAt ?? Date.now());
        const m = Math.floor(dur / 60000);
        const s = Math.round((dur % 60000) / 1000);
        const verb = agent.status === "error" ? "errored" : "done";
        const files = agent.filesChanged != null ? `, ${agent.filesChanged} files changed` : "";
        return `Agent ${agent.id} ${verb}: ${m}m ${s}s, ${agent.toolCalls} tools${files}`;
    }
}
