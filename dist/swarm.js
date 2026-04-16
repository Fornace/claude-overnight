import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import chalk from "chalk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { NudgeError, RATE_LIMIT_WINDOW_SHORT } from "./types.js";
import { gitExec, autoCommit, mergeAllBranches, warnDirtyTree, cleanStaleWorktrees, writeSwarmLog } from "./merge.js";
import { ensureCursorProxyRunning } from "./providers.js";
const SIMPLIFY_PROMPT = `You just finished your task. Now review and simplify your changes.

Run \`git diff\` to see what you changed, then fix any issues:

1. **Reuse**: Search the codebase  -- did you write something that already exists? Use existing utilities, helpers, patterns instead. Hand-rolled string manipulation, manual path handling, custom env checks, ad-hoc type guards  -- all candidates for existing utilities.

2. **Quality**:
   - Redundant state: cached values that could be derived, observers that could be direct calls
   - Copy-paste with slight variation: near-duplicate blocks that should be unified
   - Leaky abstractions: exposing internals or breaking existing abstraction boundaries
   - Stringly-typed code: raw strings where enums/unions already exist
   - Unnecessary JSX nesting: wrappers that add no layout value
   - Comments narrating WHAT the code does  -- delete them; keep only non-obvious WHY

3. **Efficiency**:
   - Redundant computations, repeated file reads, duplicate API calls
   - Sequential operations that could be parallel
   - Hot-path bloat: new blocking work in startup or per-request paths
   - Recurring no-op updates: state/store updates inside polling loops that fire unconditionally  -- add change-detection guard
   - Unnecessary existence checks before operating (TOCTOU anti-pattern)
   - Memory: unbounded data structures, missing cleanup, event listener leaks

Less code is better. Delete and simplify rather than add. Fix directly  -- no need to explain.`;
export class Swarm {
    agents = [];
    logs = [];
    allLogs = [];
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
    rateLimitUtilization = 0;
    rateLimitResetsAt;
    rateLimitWindows = new Map();
    rateLimitPaused = 0;
    isUsingOverage = false;
    overageCostUsd = 0;
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
    queue;
    config;
    nextId = 0;
    worktreeBase;
    activeQueries = new Set();
    cleanedUp = false;
    logFile;
    model;
    usageCap;
    allowExtraUsage;
    extraUsageBudget;
    baseCostUsd;
    mergeBranch;
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
    windowTag() {
        const w = this.mostConstrainedWindow();
        if (!w)
            return "";
        const name = RATE_LIMIT_WINDOW_SHORT[w.type] ?? w.type.replace(/_/g, " ");
        return ` (${name} window)`;
    }
    /** Cancellable sleep used by rate-limit waits. `retryRateLimitNow()` wakes every pending sleeper. */
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
    async run() {
        try {
            if (this.config.useWorktrees) {
                warnDirtyTree(this.config.cwd, (id, text) => this.log(id, text));
                cleanStaleWorktrees(this.config.cwd, (id, text) => this.log(id, text));
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
                const branches = this.agents.filter(a => a.branch && a.status === "done" && (a.filesChanged ?? 0) > 0)
                    .map(a => ({ id: a.id, branch: a.branch, filesChanged: a.filesChanged ?? 0 }));
                const result = mergeAllBranches(branches, this.config.cwd, this.config.mergeStrategy ?? "yolo", (id, text) => this.log(id, text));
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
                        const restarted = await ensureCursorProxyRunning();
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
    /** Mark real progress  -- resets stall state. Called on any assistant/tool/result message. */
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
            this.rateLimitPaused++;
            await this.rateLimitSleep(waitMs);
            this.rateLimitPaused--;
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
        // Guard: if pause was triggered between dispatch and here, re-queue immediately.
        // The worker already shifted this task, so unshift puts it back for resume.
        if (this.paused) {
            this.queue.unshift(task);
            return;
        }
        const id = this.nextId++;
        const agent = { id, task, status: "running", startedAt: Date.now(), toolCalls: 0 };
        this.agents.push(agent);
        let agentCwd = task.agentCwd || task.cwd || this.config.cwd;
        if (this.config.useWorktrees && this.worktreeBase && !task.noWorktree && !task.agentCwd) {
            const branch = `swarm/task-${id}`;
            const dir = join(this.worktreeBase, `agent-${id}`);
            let baseRef;
            try {
                baseRef = gitExec("git rev-parse HEAD", this.config.cwd).trim();
            }
            catch { }
            let worktreeOk = false;
            for (let wt = 0; wt < 2 && !worktreeOk; wt++) {
                try {
                    gitExec(`git worktree add -b "${branch}" "${dir}" HEAD`, this.config.cwd);
                    worktreeOk = true;
                }
                catch (e) {
                    if (wt === 0) {
                        this.log(id, `Worktree failed, cleaning up: ${e.message?.slice(0, 50)}`);
                        try {
                            gitExec(`git branch -D "${branch}"`, this.config.cwd);
                        }
                        catch { }
                        try {
                            rmSync(dir, { recursive: true, force: true });
                        }
                        catch { }
                        try {
                            gitExec("git worktree prune", this.config.cwd);
                        }
                        catch { }
                    }
                }
            }
            if (worktreeOk) {
                agentCwd = dir;
                agent.branch = branch;
                agent.baseRef = baseRef;
                this.log(id, `Worktree: ${branch}`);
            }
            else {
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
                agent.status = "running";
                agent.error = undefined;
                agent.finishedAt = undefined;
            }
            try {
                const perm = this.config.permissionMode ?? "auto";
                let resumeSessionId = task.resumeSessionId;
                let resumePrompt = "Continue. Complete the task.";
                const runOnce = async (isResume) => {
                    const preamble = "Keep files under ~500 lines. If a file would exceed that, split it.\n\n";
                    const agentPrompt = isResume ? resumePrompt
                        : this.config.useWorktrees && !task.noWorktree
                            ? `You are working in an isolated git worktree. Focus only on this task. Do NOT commit your changes  -- the framework handles that.\n\n${preamble}${task.prompt}`
                            : `${preamble}${task.prompt}`;
                    const effectiveModel = task.model || this.config.model;
                    const envOverride = this.config.envForModel?.(effectiveModel);
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
                    let sessionId;
                    let lastActivity = Date.now();
                    let timer;
                    const watchdog = new Promise((_, reject) => {
                        const check = () => {
                            const silent = Date.now() - lastActivity;
                            if (silent >= timeoutMs) {
                                agentQuery.interrupt().catch(() => agentQuery.close());
                                reject(isResume ? new AgentTimeoutError(silent) : new NudgeError(sessionId, silent));
                            }
                            else {
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
                        try {
                            agentQuery.close();
                        }
                        catch { }
                        return;
                    }
                    try {
                        await Promise.race([
                            (async () => {
                                for await (const msg of agentQuery) {
                                    lastActivity = Date.now();
                                    if (!sessionId && "session_id" in msg)
                                        sessionId = msg.session_id;
                                    this.handleMsg(agent, msg);
                                }
                            })(),
                            watchdog,
                        ]);
                    }
                    finally {
                        clearTimeout(timer);
                        this.activeQueries.delete(agentQuery);
                        if (sessionId)
                            resumeSessionId = sessionId;
                        try {
                            agentQuery.close();
                        }
                        catch { }
                    }
                };
                // Helper: re-queue this task with resume info when paused mid-turn.
                const requeueIfPaused = () => {
                    if (!this.paused || agent.status !== "running")
                        return false;
                    agent.status = "paused";
                    this.log(id, "Paused mid-task");
                    if (resumeSessionId) {
                        this.queue.unshift({ ...task, resumeSessionId, agentCwd });
                    }
                    return true;
                };
                if (isResumed && resumeSessionId) {
                    // Resumed task: continue the existing SDK session
                    try {
                        await runOnce(true);
                    }
                    catch (nudgeErr) {
                        if (nudgeErr instanceof NudgeError && resumeSessionId) {
                            this.log(id, `Silent ${Math.round(inactivityMs / 60000)}m  -- resuming with continue`);
                            await runOnce(true);
                        }
                        else
                            throw nudgeErr;
                    }
                }
                else {
                    // Fresh task: start with the task prompt
                    try {
                        await runOnce(false);
                    }
                    catch (nudgeErr) {
                        if (nudgeErr instanceof NudgeError && resumeSessionId) {
                            this.log(id, `Silent ${Math.round(inactivityMs / 60000)}m  -- resuming with continue`);
                            await runOnce(true);
                        }
                        else
                            throw nudgeErr;
                    }
                }
                if (requeueIfPaused())
                    return;
                if (resumeSessionId && agent.status === "running") {
                    try {
                        this.log(id, "Simplify pass");
                        resumePrompt = SIMPLIFY_PROMPT;
                        await runOnce(true);
                    }
                    catch {
                        this.log(id, "Simplify pass skipped");
                    }
                }
                if (requeueIfPaused())
                    return;
                if (agent.status === "running") {
                    agent.finishedAt = Date.now();
                    const duration = agent.finishedAt - (agent.startedAt || agent.finishedAt);
                    if (agent.toolCalls === 0 && (agent.costUsd ?? 0) < 0.001 && duration < 15_000) {
                        agent.status = "error";
                        agent.error = "Agent did no work  -- exited without tool use";
                        this.failed++;
                        this.log(id, agent.error);
                    }
                    else {
                        agent.status = "done";
                        this.completed++;
                    }
                }
                break;
            }
            catch (err) {
                if (agent.status !== "running")
                    break;
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
                    if (freebie)
                        attempt--; // normal case: don't count against retries
                    continue;
                }
                const canRetry = attempt < maxRetries && !this.aborted && isTransientError(err);
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
        if (this.config.useWorktrees && agent.branch) {
            agent.filesChanged = autoCommit(agent.id, agent.task.prompt, agentCwd, agent.baseRef, (id, text) => this.log(id, text));
        }
        if (agent.status === "done")
            this.log(agent.id, this.agentSummary(agent));
    }
    agentSummary(agent) {
        const dur = (agent.finishedAt ?? Date.now()) - (agent.startedAt ?? Date.now());
        const m = Math.floor(dur / 60000);
        const s = Math.round((dur % 60000) / 1000);
        const verb = agent.status === "error" ? "errored" : "done";
        const files = agent.filesChanged != null ? `, ${agent.filesChanged} files changed` : "";
        return `Agent ${agent.id} ${verb}: ${m}m ${s}s, ${agent.toolCalls} tools${files}`;
    }
    // ── Message handler ──
    handleMsg(agent, msg) {
        // Any message that isn't a rate-limit event counts as real progress and
        // resets the stall watchdog + clears the per-agent blocked flag.
        if (msg.type !== "rate_limit_event") {
            this.markProgress();
            if (agent.blockedAt != null)
                agent.blockedAt = undefined;
        }
        switch (msg.type) {
            case "assistant": {
                const m = msg;
                if (!m.message?.content)
                    break;
                for (const block of m.message.content) {
                    if (block.type === "text" && block.text) {
                        const line = block.text.trim().split("\n")[0]?.slice(0, 80);
                        if (line)
                            agent.lastText = line;
                    }
                }
                break;
            }
            case "stream_event": {
                const s = msg;
                const ev = s.event;
                if (ev.type === "content_block_start") {
                    const cb = ev.content_block;
                    if (cb?.type === "tool_use") {
                        agent.currentTool = cb.name;
                        agent.toolCalls++;
                        const input = cb.input;
                        const target = input?.path ?? input?.file_path ?? (typeof input?.command === "string" ? input.command.split(" ").slice(0, 3).join(" ") : "");
                        this.log(agent.id, target ? `${cb.name} \u2192 ${target}` : cb.name);
                    }
                }
                else if (ev.type === "content_block_delta") {
                    const delta = ev.delta;
                    if (delta?.type === "text_delta" && delta.text) {
                        const t = delta.text.trim();
                        if (t)
                            agent.lastText = t.slice(0, 80);
                    }
                }
                break;
            }
            case "result": {
                const safeAdd = (v) => typeof v === 'number' && isFinite(v) && v >= 0 ? v : 0;
                const r = msg;
                agent.currentTool = undefined;
                agent.finishedAt = Date.now();
                const cost = safeAdd(r.total_cost_usd);
                agent.costUsd = cost;
                this.totalCostUsd += cost;
                if (this.isUsingOverage)
                    this.overageCostUsd += cost;
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
                    agent.status = "done";
                    this.completed++;
                }
                else {
                    agent.status = "error";
                    const parts = [r.subtype];
                    if (r.terminal_reason && r.terminal_reason !== "completed")
                        parts.push(r.terminal_reason);
                    const errs = r.errors;
                    if (Array.isArray(errs) && errs.length > 0) {
                        parts.push(errs[0]);
                        for (const e of errs.slice(1, 3))
                            this.log(agent.id, `err: ${String(e).slice(0, 160)}`);
                    }
                    agent.error = parts.join("  -- ").slice(0, 180);
                    this.failed++;
                    this.log(agent.id, agent.error);
                }
                break;
            }
            case "rate_limit_event": {
                const rl = msg;
                const info = rl.rate_limit_info;
                this.rateLimitUtilization = info.utilization ?? 0;
                if (info.resetsAt)
                    this.rateLimitResetsAt = info.resetsAt;
                else if (info.status !== "rejected")
                    this.rateLimitResetsAt = undefined;
                if (info.isUsingOverage)
                    this.isUsingOverage = true;
                const windowType = info.rateLimitType;
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
    constructor(silentMs) {
        super(`Agent silent for ${Math.round(silentMs / 1000)}s  -- assumed hung`);
        this.name = "AgentTimeoutError";
    }
}
function isRateLimitError(err) {
    const status = err?.status ?? err?.statusCode;
    if (status === 429)
        return true;
    const msg = String(err?.message || err).toLowerCase();
    if (msg.includes("rate limit") || msg.includes("rate_limit") || msg.includes("too many requests"))
        return true;
    const cause = err?.cause;
    if (cause && cause !== err)
        return isRateLimitError(cause);
    return false;
}
function isTransientError(err) {
    if (err instanceof AgentTimeoutError)
        return false;
    const msg = String(err?.message || err).toLowerCase();
    const status = err?.status ?? err?.statusCode;
    if (status === 429 || (status != null && status >= 500 && status < 600) ||
        msg.includes("rate limit") || msg.includes("overloaded") || msg.includes("econnreset") ||
        msg.includes("etimedout") || msg.includes("socket hang up") || msg.includes("epipe") ||
        msg.includes("econnrefused") || msg.includes("ehostunreach") || msg.includes("network error") ||
        msg.includes("fetch failed") || msg.includes("aborted"))
        return true;
    const cause = err?.cause;
    if (cause && cause !== err)
        return isTransientError(cause);
    return false;
}
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}
