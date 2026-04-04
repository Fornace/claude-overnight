import { execSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { query } from "@anthropic-ai/claude-agent-sdk";
export class Swarm {
    agents = [];
    logs = [];
    startedAt = Date.now();
    total;
    completed = 0;
    failed = 0;
    totalCostUsd = 0;
    totalInputTokens = 0;
    totalOutputTokens = 0;
    phase = "running";
    mergeResults = [];
    // Rate limit tracking for auto-concurrency
    rateLimitUtilization = 0;
    rateLimitStatus = "";
    rateLimitResetsAt;
    queue;
    config;
    nextId = 0;
    worktreeBase;
    constructor(config) {
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
    async run() {
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
    log(agentId, text) {
        this.logs.push({ time: Date.now(), agentId, text });
        if (this.logs.length > 300)
            this.logs.splice(0, this.logs.length - 150);
    }
    // ── Worker loop with auto-concurrency throttling ──
    async worker() {
        while (this.queue.length > 0) {
            await this.throttle();
            const task = this.queue.shift();
            await this.runAgent(task);
        }
    }
    async throttle() {
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
            if (delay > 0)
                await sleep(delay);
        }
    }
    // ── Agent execution ──
    async runAgent(task) {
        const id = this.nextId++;
        const agent = {
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
            }
            catch (e) {
                this.log(id, `Worktree failed: ${e.message?.slice(0, 60)}`);
            }
        }
        this.log(id, `Starting: ${task.prompt.slice(0, 60)}`);
        try {
            for await (const msg of query({
                prompt: this.config.useWorktrees
                    ? `You are working in an isolated git worktree. Focus only on this task. Do NOT commit your changes — the framework handles that.\n\n${task.prompt}`
                    : task.prompt,
                options: {
                    cwd: agentCwd,
                    model: task.model || this.config.model,
                    permissionMode: "bypassPermissions",
                    allowDangerouslySkipPermissions: true,
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
        }
        catch (err) {
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
    autoCommit(agent, worktreeCwd) {
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
        }
        catch {
            // No changes or commit failed — fine
        }
    }
    // ── Merge all worktree branches back ──
    async mergeAll() {
        this.phase = "merging";
        const branches = this.agents
            .filter((a) => a.branch && a.status === "done" && (a.filesChanged ?? 0) > 0);
        if (branches.length === 0) {
            this.log(-1, "No changes to merge");
            return;
        }
        this.log(-1, `Merging ${branches.length} branch(es)...`);
        for (const agent of branches) {
            const result = {
                branch: agent.branch,
                ok: false,
                filesChanged: agent.filesChanged ?? 0,
            };
            try {
                exec(`git merge --no-edit "${agent.branch}"`, this.config.cwd);
                result.ok = true;
                this.log(agent.id, `Merged ${agent.branch}`);
            }
            catch (e) {
                // Abort failed merge
                try {
                    exec("git merge --abort", this.config.cwd);
                }
                catch { }
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
            }
            catch { }
        }
    }
    // ── Message handler ──
    handleMsg(agent, msg) {
        switch (msg.type) {
            case "assistant": {
                const m = msg;
                if (!m.message?.content)
                    break;
                for (const block of m.message.content) {
                    if (block.type === "tool_use") {
                        agent.currentTool = block.name;
                        agent.toolCalls++;
                        this.log(agent.id, block.name);
                    }
                    else if (block.type === "text" && block.text) {
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
                        this.log(agent.id, cb.name);
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
                else if (ev.type === "content_block_stop") {
                    agent.currentTool = undefined;
                }
                break;
            }
            case "result": {
                const r = msg;
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
                }
                else {
                    agent.status = "error";
                    agent.error = r.subtype;
                    this.failed++;
                    this.log(agent.id, r.subtype);
                }
                break;
            }
            case "rate_limit_event": {
                const rl = msg;
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
function exec(cmd, cwd) {
    return execSync(cmd, { cwd, encoding: "utf-8", stdio: "pipe" });
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
