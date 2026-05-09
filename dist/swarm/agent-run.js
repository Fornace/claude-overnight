import { rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { NudgeError } from "../core/types.js";
import { gitExec, autoCommit } from "./merge.js";
import { createTurn, beginTurn, endTurn, updateTurn } from "../core/turns.js";
import { withCursorWorkspaceHeader, getAgentTimeout } from "./config.js";
import { renderPrompt } from "../prompts/load.js";
import { AgentTimeoutError, StreamStalledError, isRateLimitError, isStreamStalledError, isTransientError, sleep } from "./errors.js";
import { handleMsg, checkStreamHealth, NO_CONTENT_TIMEOUT_MS } from "./message-handler.js";
import { getModelCapability } from "../core/models.js";
import { sdkQueryRateLimiter, acquireSdkQueryRateLimit } from "../core/rate-limiter.js";
import { StreamSink } from "../core/transcripts.js";
import { StallGuard, StallMonitor, runWithStallRotation } from "../core/stall-guard.js";
import { writeCandidate } from "../skills/scribe.js";
import { buildL0Stub, buildRecipeStub } from "../skills/injection.js";
export { buildErroredBranchEvaluator } from "./branch-evaluator.js";
export async function runAgent(host, task) {
    // Guard: if pause was triggered between dispatch and here, re-queue immediately.
    // The worker already shifted this task, so unshift puts it back for resume.
    if (host.paused) {
        host.queue.unshift(task);
        return;
    }
    const id = host.nextId++;
    const agent = { id, task, status: "running", startedAt: Date.now(), toolCalls: 0, contextTokens: 0, model: task.model || host.model };
    host.agents.push(agent);
    const turn = createTurn("swarm", `Agent ${id}`, `swarm-${id}`, agent.model);
    beginTurn(turn);
    host._agentTurns.set(id, turn);
    const agentCwd = setupAgentWorktree(host, id, task, agent);
    const effectiveModelInit = task.model || host.model;
    const contextKey = sessionContextKey(effectiveModelInit, agentCwd, host.config.envForModel?.(effectiveModelInit));
    // Drop a saved sessionId whose (provider, model, cwd) no longer matches the
    // live one. Otherwise the first resume call fails with "No conversation found
    // with session ID" and burns an attempt before any tool use. See
    // Task.resumeContextKey for the why.
    if (task.resumeSessionId && task.resumeContextKey && task.resumeContextKey !== contextKey) {
        host.log(id, `Dropping stale resume id (context changed: ${task.resumeContextKey} → ${contextKey})`);
        task = { ...task, resumeSessionId: undefined, resumeContextKey: undefined };
    }
    const isResumed = !!task.resumeSessionId;
    host.log(id, isResumed ? `Resuming: ${task.prompt.slice(0, 60)}` : `Starting: ${task.prompt.slice(0, 60)}`);
    const maxRetries = host.config.maxRetries ?? 2;
    const inactivityMs = host.config.agentTimeoutMs ?? getAgentTimeout();
    const rl = sdkQueryRateLimiter;
    // Hoisted so the catch block can read the session captured during the turn
    // when routing a pause-interrupt through the requeue path.
    let resumeSessionId = task.resumeSessionId;
    // Carry the resume session forward only if the prior turn isn't already
    // close to filling its context window. A saturated session would resume
    // with little room to do real work and would auto-compact (or hit the
    // window) almost immediately — cheaper to start the next attempt fresh.
    const carrySession = () => {
        if (!resumeSessionId)
            return false;
        const safe = getModelCapability(effectiveModelInit ?? "").safeContext;
        const used = agent.peakContextTokens ?? agent.contextTokens ?? 0;
        if (safe > 0 && used >= safe * 0.85) {
            host.log(id, `Discarding resume id (context ${used}/${safe} tokens, near saturation)`);
            return false;
        }
        return true;
    };
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
            const backoffMs = Math.min(30000, 1000 * 2 ** (attempt - 1)) * (0.5 + Math.random());
            host.log(id, `Retry ${attempt}/${maxRetries} in ${Math.round(backoffMs)}ms`);
            await sleep(backoffMs);
            agent.status = "running";
            agent.error = undefined;
            agent.finishedAt = undefined;
        }
        try {
            let resumePrompt = "Continue. Complete the task.";
            let agentFinalText = "";
            const effectiveModel = task.model || host.model;
            const resolveFallback = () => withCursorWorkspaceHeader(StallMonitor.instance.getFallbackEnv(effectiveModel), agentCwd);
            const runOneStream = async (isResume, promptText, env) => {
                let sessionId;
                let lastActivity = Date.now();
                agent.lastContentTimestamp = Date.now();
                await acquireSdkQueryRateLimit();
                const agentQuery = query({
                    prompt: promptText,
                    options: {
                        cwd: agentCwd, model: effectiveModel,
                        permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
                        allowedTools: host.config.allowedTools, includePartialMessages: true, persistSession: true,
                        ...(isResume && resumeSessionId && { resume: resumeSessionId }),
                        ...(env && { env }),
                    },
                });
                const timeoutMs = isResume ? inactivityMs * 2 : inactivityMs;
                let timer;
                const watchdog = new Promise((_, reject) => {
                    const check = () => {
                        const lastContent = agent.lastContentTimestamp;
                        if (lastContent != null && !checkStreamHealth(lastContent, NO_CONTENT_TIMEOUT_MS)) {
                            const elapsed = Date.now() - lastContent;
                            agentQuery.interrupt().catch(() => agentQuery.close());
                            reject(new StreamStalledError(elapsed, NO_CONTENT_TIMEOUT_MS));
                            return;
                        }
                        const silent = Date.now() - lastActivity;
                        if (silent >= timeoutMs) {
                            agentQuery.interrupt().catch(() => agentQuery.close());
                            reject(isResume ? new AgentTimeoutError(silent) : new NudgeError(sessionId, silent));
                        }
                        else {
                            const gap = lastContent != null ? Date.now() - lastContent : 0;
                            const untilNoContent = lastContent != null ? Math.max(250, NO_CONTENT_TIMEOUT_MS - gap + 50) : Number.POSITIVE_INFINITY;
                            timer = setTimeout(check, Math.min(30_000, timeoutMs - silent + 1000, 5_000, untilNoContent));
                        }
                    };
                    timer = setTimeout(check, Math.min(5_000, timeoutMs));
                });
                host.activeQueries.add(agentQuery);
                if (host.paused) {
                    host.activeQueries.delete(agentQuery);
                    try {
                        agentQuery.close();
                    }
                    catch { }
                    return;
                }
                const sink = new StreamSink(`agent-${agent.id}`, agent.id);
                const sg = new StallGuard(sink, new AbortController());
                const stallPromise = new Promise((_, reject) => {
                    sg.on("stall", (err) => reject(err));
                });
                try {
                    await Promise.race([
                        (async () => {
                            for await (const msg of agentQuery) {
                                lastActivity = Date.now();
                                // Every SDK message variant carries `session_id` except the
                                // initial `system` init — treat its absence as "not yet known".
                                const sid = msg.session_id;
                                if (!sessionId && sid)
                                    sessionId = sid;
                                sink.append(msg);
                                handleMsg(host, agent, msg);
                                // Capture assistant text for skill proposal extraction.
                                if (msg.type === "assistant") {
                                    const content = msg.message?.content;
                                    if (Array.isArray(content)) {
                                        for (const part of content) {
                                            if (part?.type === "text" && typeof part.text === "string")
                                                agentFinalText += part.text;
                                        }
                                    }
                                }
                            }
                            sink.markFinished();
                        })(),
                        watchdog,
                        stallPromise,
                    ]);
                }
                finally {
                    sg.stop();
                    clearTimeout(timer);
                    host.activeQueries.delete(agentQuery);
                    if (sessionId)
                        resumeSessionId = sessionId;
                    try {
                        agentQuery.close();
                    }
                    catch { }
                    rl.record();
                }
            };
            const runTurn = (isResume, promptText) => runWithStallRotation({
                initialPrompt: promptText,
                initialIsResume: isResume,
                initialEnv: withCursorWorkspaceHeader(host.config.envForModel?.(effectiveModel), agentCwd),
                resolveFallbackEnv: resolveFallback,
                log: (text) => host.log(id, text),
                isAborted: () => host.aborted,
                defaultResumePrompt: resumePrompt,
                run: runOneStream,
            });
            const requeueIfPaused = () => {
                if (!host.paused || agent.status !== "running")
                    return false;
                agent.status = "paused";
                const carry = carrySession();
                host.log(id, carry ? "Paused mid-task (will resume)" : "Paused before first turn (will restart)");
                host.queue.unshift(carry
                    ? { ...task, resumeSessionId, resumeContextKey: contextKey, agentCwd }
                    : { ...task });
                return true;
            };
            const l0Stub = host.config.repoFingerprint
                ? buildL0Stub({ fingerprint: host.config.repoFingerprint, role: "worker", excludeSkill: task.abExcludeSkill }).text
                : "";
            const recipeStub = host.config.repoFingerprint
                ? buildRecipeStub({ fingerprint: host.config.repoFingerprint, tools: host.config.allowedTools })?.text
                : "";
            const freshPrompt = renderPrompt("20_execution/20-3_agent-wrap", {
                vars: {
                    useWorktrees: host.config.useWorktrees && !task.noWorktree,
                    l0Stub, recipeStub,
                    allowSkillProposals: host.config.allowSkillProposals,
                    taskPrompt: task.prompt,
                    postcondition: task.postcondition,
                },
            });
            const initialIsResume = !!resumeSessionId;
            const initialPrompt = initialIsResume ? resumePrompt : freshPrompt;
            try {
                await runTurn(initialIsResume, initialPrompt);
            }
            catch (nudgeErr) {
                if (nudgeErr instanceof NudgeError && resumeSessionId) {
                    host.log(id, `Silent ${Math.round(inactivityMs / 60000)}m  -- resuming with continue`);
                    await runTurn(true, resumePrompt);
                }
                else
                    throw nudgeErr;
            }
            if (requeueIfPaused())
                return;
            if (resumeSessionId && agent.status === "running") {
                try {
                    host.log(id, "Simplify pass");
                    resumePrompt = renderPrompt("20_execution/20-1_simplify");
                    await runTurn(true, resumePrompt);
                }
                catch {
                    host.log(id, "Simplify pass skipped");
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
                    host.failed++;
                    host.log(id, agent.error);
                }
                else {
                    agent.status = "done";
                    host.completed++;
                    recordSkillProposal(host, id, agentFinalText);
                }
            }
            break;
        }
        catch (err) {
            if (agent.status !== "running")
                break;
            // Pause throws (SDK interrupt surfaces as an exception on some transports).
            // Treat it like the clean-exit pause path — requeue and bail — instead of
            // marking the agent as errored, which would burn remaining-budget on every
            // live agent whenever the user hit `p`.
            if (host.paused) {
                agent.status = "paused";
                host.log(id, "Paused mid-task (interrupt thrown)");
                // Reuse resume info when we have a sessionId AND the prior context isn't
                // already saturated; otherwise restart fresh.
                const reuseSession = carrySession();
                host.queue.unshift(reuseSession
                    ? { ...task, resumeSessionId, resumeContextKey: contextKey, agentCwd }
                    : { ...task });
                return;
            }
            // Stream stall: the server went silent mid-response. If we captured a
            // sessionId, resume it instead of restarting  -- the model keeps the work
            // it already did. Freebie: doesn't count against maxRetries the first time.
            if (!host.aborted && isStreamStalledError(err) && resumeSessionId) {
                const elapsedS = Math.round(err.elapsed / 1000);
                host.log(id, `Stream stalled (${elapsedS}s silent)  -- resuming session`);
                if (attempt === 0)
                    attempt--;
                continue;
            }
            // Rate-limit errors: wait and retry WITHOUT burning the retry budget
            if (!host.aborted && isRateLimitError(err)) {
                const { counted } = await awaitRateLimitWindow(host, agent);
                if (!counted)
                    attempt--; // normal case: don't count against retries
                continue;
            }
            const canRetry = attempt < maxRetries && !host.aborted && isTransientError(err);
            if (canRetry) {
                host.log(id, `Transient error: ${String(err.message || err).slice(0, 80)}`);
                continue;
            }
            agent.status = "error";
            agent.error = String(err.message || err).slice(0, 120);
            agent.finishedAt = Date.now();
            host.failed++;
            host.log(id, agent.error);
        }
    }
    if (host.config.useWorktrees && agent.branch) {
        agent.filesChanged = autoCommit(agent.id, agent.task.prompt, agentCwd, agent.baseRef, (aid, text) => host.log(aid, text));
    }
    updateTurn(turn, { costUsd: agent.costUsd });
    endTurn(turn, agent.status === "done" ? "done" : agent.status === "paused" ? "stopped" : "error");
    host._agentTurns.delete(id);
    if (agent.status === "done")
        host.log(agent.id, host.agentSummary(agent));
}
/**
 * Bundled plugin path: plugins/lsp-first relative to the installed package.
 * Resolved off this module's path so it works when claude-overnight is
 * invoked from anywhere (npm link, global install, local dev).
 */
function resolveLspFirstPluginDir() {
    try {
        // dist/swarm/agent-run.js → ../../plugins/lsp-first
        const here = dirname(fileURLToPath(import.meta.url));
        const candidate = resolve(here, "..", "..", "plugins", "lsp-first");
        if (existsSync(join(candidate, "hooks", "lsp-first-guard.js")))
            return candidate;
    }
    catch { }
    return undefined;
}
/**
 * Look for an LSP MCP server (cclsp / serena) in the user's Claude config.
 * Cheap substring check — if nothing's configured, don't install the hook
 * (it would block Grep without offering the agent any alternative).
 */
let _lspMcpPresent;
function hasLspMcp() {
    if (_lspMcpPresent !== undefined)
        return _lspMcpPresent;
    const candidates = [
        join(process.env.HOME ?? "", ".claude.json"),
        join(process.env.HOME ?? "", ".config", "claude", "claude.json"),
    ];
    for (const p of candidates) {
        try {
            if (!existsSync(p))
                continue;
            const text = readFileSync(p, "utf-8");
            if (/\b(cclsp|serena)\b/.test(text)) {
                _lspMcpPresent = true;
                return true;
            }
        }
        catch { }
    }
    _lspMcpPresent = false;
    return false;
}
/** Write a project-level settings file that registers the lsp-first hook. */
function installLspFirstHookInto(worktreeDir) {
    if (!hasLspMcp())
        return; // fail-safe — no LSP, no enforcement
    const pluginDir = resolveLspFirstPluginDir();
    if (!pluginDir)
        return;
    const hookPath = join(pluginDir, "hooks", "lsp-first-guard.js");
    const settings = {
        hooks: {
            PreToolUse: [
                { matcher: "Grep", hooks: [{ type: "command", command: `node ${JSON.stringify(hookPath).slice(1, -1)}` }] },
            ],
        },
    };
    const dir = join(worktreeDir, ".claude");
    mkdirSync(dir, { recursive: true });
    // settings.local.json is gitignored by Claude Code convention — won't pollute the agent's commit.
    writeFileSync(join(dir, "settings.local.json"), JSON.stringify(settings, null, 2), "utf-8");
}
/**
 * Stable per-(provider, model, cwd) tag for scoping `resume` session ids.
 * Provider matters because Cursor proxy and Anthropic direct keep separate
 * backend session stores; cwd matters because the SDK keys its on-disk session
 * cache by project path, so a recreated worktree under a new path can't find
 * the prior conversation. Model is included for completeness.
 */
function sessionContextKey(model, cwd, env) {
    const isCursor = !!(env?.CURSOR_API_KEY || env?.CURSOR_AUTH_TOKEN || env?.CURSOR_BRIDGE_MODE);
    const baseUrl = env?.ANTHROPIC_BASE_URL?.trim();
    const provider = isCursor ? "cursor" : baseUrl ? `url:${baseUrl}` : "anthropic";
    return `${provider}|${model ?? "default"}|${cwd}`;
}
/**
 * Create the per-agent worktree (if isolation is enabled and the task allows
 * it), install the optional lsp-first hook, and return the cwd the SDK should
 * run in. Mutates `agent.branch`/`agent.baseRef` on success. On retry+failure,
 * falls back to running without isolation rather than aborting.
 */
function setupAgentWorktree(host, id, task, agent) {
    const fallback = task.agentCwd || task.cwd || host.config.cwd;
    if (!host.config.useWorktrees || !host.worktreeBase || task.noWorktree || task.agentCwd)
        return fallback;
    const branch = `swarm/task-${id}`;
    const dir = join(host.worktreeBase, `agent-${id}`);
    let baseRef;
    try {
        baseRef = gitExec("git rev-parse HEAD", host.config.cwd).trim();
    }
    catch { }
    let worktreeOk = false;
    for (let wt = 0; wt < 2 && !worktreeOk; wt++) {
        try {
            gitExec(`git worktree add -b "${branch}" "${dir}" HEAD`, host.config.cwd);
            worktreeOk = true;
        }
        catch (e) {
            if (wt === 0) {
                host.log(id, `Worktree failed, cleaning up: ${e.message?.slice(0, 50)}`);
                try {
                    gitExec(`git branch -D "${branch}"`, host.config.cwd);
                }
                catch { }
                try {
                    rmSync(dir, { recursive: true, force: true });
                }
                catch { }
                try {
                    gitExec("git worktree prune", host.config.cwd);
                }
                catch { }
            }
        }
    }
    if (!worktreeOk) {
        host.log(id, `Worktree failed after retry  -- running without isolation`);
        return fallback;
    }
    agent.branch = branch;
    agent.baseRef = baseRef;
    host.log(id, `Worktree: ${branch}`);
    // Opt-in: install the bundled lsp-first hook into this worktree so the
    // spawned agent blocks Grep on code symbols and is nudged to cclsp/LSP
    // tools instead. Enabled via CLAUDE_OVERNIGHT_LSP_FIRST=1 (or =true).
    if (/^(1|true|yes)$/i.test(process.env.CLAUDE_OVERNIGHT_LSP_FIRST ?? "")) {
        try {
            installLspFirstHookInto(dir);
        }
        catch (e) {
            host.log(id, `lsp-first install skipped: ${String(e?.message || e).slice(0, 60)}`);
        }
    }
    return dir;
}
/**
 * Wait for the active rate-limit window to clear, mutating host counters so
 * the UI reflects the block. Returns whether the wait should count against
 * `maxRetries` — when the whole swarm has been making zero progress for a
 * while, retries are no longer free and we eventually surrender.
 */
async function awaitRateLimitWindow(host, agent) {
    const waitMs = host.rateLimitResetsAt && host.rateLimitResetsAt > Date.now()
        ? Math.max(5000, host.rateLimitResetsAt - Date.now())
        : 120_000;
    const globallyStalled = Date.now() - host.lastProgressAt > 15 * 60_000;
    const counted = globallyStalled;
    host.log(agent.id, `Rate limited${host.windowTag()}  -- waiting ${Math.ceil(waitMs / 1000)}s${counted ? " (counted  -- swarm stalled)" : " (attempt not counted)"} ([r] to retry now)`);
    agent.blockedAt = Date.now();
    host.rateLimitPaused++;
    await host.rateLimitSleep(waitMs);
    host.rateLimitPaused--;
    agent.blockedAt = undefined;
    host.isUsingOverage = false;
    host.rateLimitUtilization = 0;
    host.rateLimitResetsAt = undefined;
    host.checkStall();
    return { counted };
}
/** Persist a ### SKILL CANDIDATE block (when present) for the scribe pipeline. */
function recordSkillProposal(host, agentId, finalText) {
    if (!host.repoFingerprint || host.runId == null)
        return;
    const proposal = extractSkillProposal(finalText);
    if (!proposal)
        return;
    writeCandidate({
        kind: "skill",
        proposedBy: `agent-${agentId}`,
        wave: host.waveNum ?? 0,
        runId: host.runId,
        fingerprint: host.repoFingerprint,
        trigger: proposal.trigger,
        body: proposal.body,
    });
}
/** Extract a ### SKILL CANDIDATE block from agent text. Returns undefined if not found. */
function extractSkillProposal(text) {
    const m = text.match(/###\s*SKILL CANDIDATE\s*\n([\s\S]+?)$/);
    if (!m)
        return undefined;
    const block = m[1].trim();
    const triggerM = block.match(/^trigger:\s*(.+)$/m);
    if (!triggerM)
        return undefined;
    const trigger = triggerM[1].trim().slice(0, 120);
    const bodyStart = block.indexOf("\nbody:");
    if (bodyStart < 0)
        return undefined;
    const body = block.slice(bodyStart + 6).trim();
    if (!body)
        return undefined;
    return { trigger, body };
}
