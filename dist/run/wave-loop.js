// Main wave loop for executeRun.
//
// Extracted from run.ts via the friend-class pattern (same as
// swarm-message-handler.ts). The loop body is moved verbatim; run.ts
// implements `WaveLoopHost` to expose mutable state and callbacks.
//
// Circuit breaker process.exit(3) stays here — loop logic is verbatim.
import { readFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import chalk from "chalk";
import { Swarm } from "../swarm/swarm.js";
import { contextFillInfo } from "../ui/render/render.js";
import { getModelCapability } from "../core/models.js";
import { isJWTAuthError } from "../core/auth.js";
import { saveRunState, saveWaveSession, } from "../state/state.js";
import { throttleBeforeWave } from "./throttle.js";
import { checkProjectHealth } from "./health.js";
import { runPostWaveReview } from "./review.js";
import { promptBudgetExtension } from "./budget.js";
export async function runWaveLoop(host, ctx) {
    let runAnotherRound = true;
    let healFailStreak = 0;
    let zeroFileWaves = 0;
    while (runAnotherRound) {
        runAnotherRound = false;
        while (host.remaining > 0 && host.currentTasks.length > 0 && !ctx.isStopping()) {
            // ── Health check ──
            {
                const healTasks = healFailStreak > 0 ? [] : checkProjectHealth(ctx.cwd);
                if (healTasks.length > 0 && host.remaining > 0) {
                    const healIds = healTasks.map(t => t.id);
                    const withoutDup = host.currentTasks.filter(t => !healIds.includes(t.id));
                    host.currentTasks = [...healTasks, ...withoutDup];
                    ctx.display.appendSteeringEvent(`Health check: build broken — queued ${healTasks.length} heal task(s)`);
                }
                else if (healTasks.length === 0 && healFailStreak > 0 && checkProjectHealth(ctx.cwd).length > 0) {
                    ctx.display.appendSteeringEvent(`Health check: build broken — heal skipped after ${healFailStreak} failed attempts, needs manual intervention`);
                    try {
                        const statusPath2 = join(ctx.runDir, "status.md");
                        const existing2 = existsSync(statusPath2) ? readFileSync(statusPath2, "utf-8") : "";
                        const marker = "## Heal blocked";
                        if (!existing2.includes(marker)) {
                            writeFileSync(statusPath2, `${existing2}${existing2 ? "\n\n" : ""}${marker}\nBuild has been broken for ${healFailStreak} waves, heal agents unable to fix — intervene manually.\n`, "utf-8");
                        }
                    }
                    catch { }
                }
            }
            if (host.currentTasks.length > host.remaining)
                host.currentTasks = host.currentTasks.slice(0, host.remaining);
            ctx.syncRunInfo();
            saveRunState(ctx.runDir, buildRunState(host, "steering", host.currentTasks));
            // ── Pre-wave rate limit gate ──
            await throttleBeforeWave(ctx.rlGetter, (text) => ctx.display.appendSteeringEvent(text), ctx.isStopping);
            if (ctx.isStopping())
                break;
            // ── Before-wave commands ──
            if (ctx.beforeWaveCmds) {
                const cmds = Array.isArray(ctx.beforeWaveCmds) ? ctx.beforeWaveCmds : [ctx.beforeWaveCmds];
                for (const cmd of cmds) {
                    ctx.display.appendSteeringEvent(`Before-wave: ${cmd}`);
                    try {
                        const out = execSync(cmd, { cwd: ctx.cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
                        if (out.trim())
                            ctx.display.appendSteeringEvent(`  → ${out.trim().slice(0, 200)}`);
                    }
                    catch (err) {
                        const msg = (err.stderr || err.stdout || err.message || "").trim().slice(0, 300);
                        ctx.display.appendSteeringEvent(`  ✗ ${cmd}: ${msg}`);
                    }
                }
            }
            // ── Swarm run ──
            const swarm = new Swarm({
                tasks: host.currentTasks, concurrency: host.concurrency, cwd: ctx.cwd, model: host.workerModel,
                permissionMode: host.permissionMode, allowedTools: undefined,
                useWorktrees: ctx.useWorktrees, mergeStrategy: ctx.waveMerge, agentTimeoutMs: ctx.agentTimeoutMs,
                usageCap: host.usageCap, allowExtraUsage: ctx.allowExtraUsage, extraUsageBudget: ctx.extraUsageBudget,
                baseCostUsd: host.accCost, envForModel: ctx.envForModel, cursorProxy: ctx.cursorProxy,
            });
            host.currentSwarm = swarm;
            ctx.display.setWave(swarm);
            ctx.display.resume();
            try {
                await swarm.run();
            }
            catch (err) {
                if (isJWTAuthError(err)) {
                    ctx.display.stop();
                    console.error(chalk.red(`\n  Authentication failed  -- check your API key or run: claude auth\n`));
                    process.exit(1);
                }
                if (swarm.agents.length > 0) {
                    try {
                        saveWaveSession(ctx.runDir, host.waveNum, swarm.agents, swarm.totalCostUsd);
                    }
                    catch { }
                }
                throw err;
            }
            ctx.display.pause();
            console.log(ctx.renderSummary(swarm));
            // ── Zero-work retry ──
            if (!swarm.aborted && !swarm.cappedOut && host.remaining > 0) {
                handleZeroWorkRetry(swarm, host, ctx);
            }
            // ── Stats rollup ──
            host.accCost += swarm.totalCostUsd;
            host.accIn += swarm.totalInputTokens;
            host.accOut += swarm.totalOutputTokens;
            host.accCompleted += swarm.completed;
            host.accFailed += swarm.failed;
            host.accTools += swarm.agents.reduce((sum, a) => sum + a.toolCalls, 0);
            for (const a of swarm.agents) {
                const tok = a.peakContextTokens ?? a.contextTokens ?? 0;
                if (tok <= 0)
                    continue;
                const mdl = a.task.model || swarm.model || "unknown";
                const safe = getModelCapability(mdl).safeContext;
                const { pct } = contextFillInfo(tok, safe);
                if (pct > host.peakWorkerCtxPct) {
                    host.peakWorkerCtxPct = pct;
                    host.peakWorkerCtxTokens = tok;
                }
            }
            host.remaining = Math.max(0, host.remaining - swarm.completed - swarm.failed);
            // ── Thinking-mode budget floor ──
            // Note: cfg.thinkingUsed is not on host; we approximate via 0 since
            // thinking phase is already accounted for in accCompleted at this point.
            // ── Live config dirty check ──
            if (host.liveConfig.dirty) {
                host.remaining = host.liveConfig.remaining;
                host.usageCap = host.liveConfig.usageCap;
                if (host.liveConfig.workerModel)
                    host.workerModel = host.liveConfig.workerModel;
                if (host.liveConfig.plannerModel)
                    host.plannerModel = host.liveConfig.plannerModel;
                if (host.liveConfig.fastModel !== undefined)
                    host.fastModel = host.liveConfig.fastModel;
                if (host.liveConfig.permissionMode)
                    host.permissionMode = host.liveConfig.permissionMode;
                host.concurrency = host.liveConfig.concurrency;
                host.liveConfig.dirty = false;
            }
            host.liveConfig.remaining = host.remaining;
            host.lastCapped = swarm.cappedOut;
            host.lastAborted = swarm.aborted;
            // ── Branch recording + wave save ──
            ctx.recordBranches(swarm.agents, swarm.mergeResults, host.waveNum);
            saveWaveSession(ctx.runDir, host.waveNum, swarm.agents, swarm.totalCostUsd);
            const attemptedPrompts = new Set(swarm.agents.map(a => a.task.prompt));
            const neverStarted = host.currentTasks.filter(t => !attemptedPrompts.has(t.prompt));
            saveRunState(ctx.runDir, buildRunState(host, "steering", neverStarted));
            // ── Overlay merge outcomes into wave history ──
            const failedMergeBranches = new Set(swarm.mergeResults.filter(r => !r.ok).map(r => r.branch));
            host.waveHistory.push({
                wave: host.waveNum,
                tasks: swarm.agents.map(a => {
                    const mergeFailed = a.branch && failedMergeBranches.has(a.branch);
                    return {
                        prompt: a.task.prompt,
                        status: a.status,
                        type: a.task.type,
                        filesChanged: mergeFailed ? 0 : a.filesChanged,
                        error: mergeFailed ? `merge-failed: branch ${a.branch} did not land` : a.error,
                    };
                }),
            });
            // ── Heal fail streak ──
            const lastWave = host.waveHistory[host.waveHistory.length - 1];
            const healTask = lastWave?.tasks.find(t => t.type === "heal");
            if (healTask && !healTask.filesChanged) {
                healFailStreak++;
            }
            else if (lastWave?.tasks.some(t => (t.type !== "heal") && (t.filesChanged ?? 0) > 0)) {
                healFailStreak = 0;
            }
            // ── Circuit breaker ──
            const nonHealFiles = lastWave?.tasks.filter(t => t.type !== "heal").reduce((sum, t) => sum + (t.filesChanged ?? 0), 0) ?? 0;
            if (nonHealFiles === 0 && host.waveNum > 0) {
                zeroFileWaves++;
                if (zeroFileWaves >= 2) {
                    ctx.display.appendSteeringEvent(`Circuit breaker: 2 consecutive waves produced no merged changes — halting to prevent budget drain`);
                    ctx.display.stop();
                    saveRunState(ctx.runDir, buildRunState(host, "stopped", []));
                    ctx.display.stop();
                    console.log(chalk.red(`\n  Circuit breaker: 2 consecutive waves produced no merged changes.`));
                    console.log(chalk.red(`  Halting to prevent budget drain. Run preserved at ${ctx.runDir}.`));
                    process.exit(3);
                }
            }
            else {
                zeroFileWaves = 0;
            }
            // ── Hook-blocked work ──
            const hookBlocked = swarm.agents.filter(a => swarm.logs.some(l => l.agentId === a.id && l.text.includes("did NOT land")));
            if (hookBlocked.length > 0) {
                const msg = `⚠ ${hookBlocked.length} agent(s) touched files that didn't land — check hooks/gitignore/absolute paths`;
                ctx.display.appendSteeringEvent(msg);
                try {
                    const existing = readFileSync(join(ctx.runDir, "status.md"), "utf-8");
                    if (!existing.includes(msg)) {
                        writeFileSync(join(ctx.runDir, "status.md"), existing + `\n\n${msg}`, "utf-8");
                    }
                }
                catch { }
            }
            // ── Merge-failed status.md + GC ──
            try {
                const unresolved = host.branches.filter(b => {
                    if (b.status !== "merge-failed")
                        return false;
                    try {
                        execSync(`git rev-parse --verify "${b.branch}"`, { cwd: ctx.cwd, stdio: "ignore" });
                        return true;
                    }
                    catch {
                        return false;
                    }
                });
                const statusPath = join(ctx.runDir, "status.md");
                const existing = existsSync(statusPath) ? readFileSync(statusPath, "utf-8") : "";
                const marker = "## Unresolved merge failures";
                const idx = existing.indexOf(marker);
                const base = idx >= 0 ? existing.slice(0, idx).replace(/\n+$/, "") : existing;
                let next = base;
                if (unresolved.length > 0) {
                    const list = unresolved.map(b => `  - ${b.branch} — ${b.taskPrompt.slice(0, 120)}`).join("\n");
                    next = `${base}${base ? "\n\n" : ""}${marker}\n${unresolved.length} branch(es) contain unmerged agent work. Resolve or discard before relying on those changes:\n${list}\n`;
                    ctx.display.appendSteeringEvent(`⚠ ${unresolved.length} unresolved merge failure(s) — see status.md`);
                }
                if (next !== existing)
                    writeFileSync(statusPath, next, "utf-8");
                const gcCandidates = host.branches.filter(b => b.status === "merge-failed" && b.firstFailedWave !== undefined && (host.waveNum - b.firstFailedWave) >= 2);
                let gcCount = 0;
                for (const b of gcCandidates) {
                    try {
                        execSync(`git branch -D "${b.branch}"`, { cwd: ctx.cwd, stdio: "ignore" });
                    }
                    catch { }
                    b.status = "discarded";
                    gcCount++;
                }
                if (gcCount > 0)
                    ctx.display.appendSteeringEvent(`GC: discarded ${gcCount} ghost branch(es) ≥2 waves old`);
            }
            catch { }
            // ── Debrief ──
            ctx.runDebrief(`Wave ${host.waveNum + 1} just finished.`);
            // ── After-wave commands ──
            if (ctx.afterWaveCmds && !swarm.aborted && !swarm.cappedOut) {
                const cmds = Array.isArray(ctx.afterWaveCmds) ? ctx.afterWaveCmds : [ctx.afterWaveCmds];
                for (const cmd of cmds) {
                    ctx.display.appendSteeringEvent(`After-wave: ${cmd}`);
                    try {
                        const out = execSync(cmd, { cwd: ctx.cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
                        if (out.trim())
                            ctx.display.appendSteeringEvent(`  → ${out.trim().slice(0, 200)}`);
                    }
                    catch (err) {
                        const msg = (err.stderr || err.stdout || err.message || "").trim().slice(0, 300);
                        ctx.display.appendSteeringEvent(`  ✗ ${cmd}: ${msg}`);
                    }
                }
            }
            // ── Post-wave review ──
            if (ctx.flex && host.remaining > 0 && !swarm.aborted && !swarm.cappedOut && host.waveNum > 0) {
                ctx.display.appendSteeringEvent(`Review: scanning wave ${host.waveNum + 1} diff\u2026`);
                const reviewResult = await runPostWaveReview({
                    cwd: ctx.cwd, plannerModel: host.plannerModel, permissionMode: host.permissionMode, concurrency: host.concurrency,
                    remaining: host.remaining, usageCap: host.usageCap, allowExtraUsage: ctx.allowExtraUsage,
                    extraUsageBudget: ctx.extraUsageBudget, baseCostUsd: host.accCost,
                    envForModel: ctx.envForModel, mergeStrategy: ctx.waveMerge, useWorktrees: ctx.useWorktrees,
                }, (reviewSwarm) => {
                    host.currentSwarm = reviewSwarm;
                    ctx.display.setWave(reviewSwarm);
                    ctx.display.resume();
                });
                if (reviewResult) {
                    host.accCost += reviewResult.costUsd;
                    host.accIn += reviewResult.inputTokens;
                    host.accOut += reviewResult.outputTokens;
                    host.accCompleted += reviewResult.completed;
                    host.remaining = Math.max(0, host.remaining - reviewResult.completed);
                    host.liveConfig.remaining = host.remaining;
                    ctx.display.appendSteeringEvent(`Post-wave review: ${reviewResult.completed} done${reviewResult.failed > 0 ? ` / ${reviewResult.failed} failed` : ""}`);
                }
            }
            if (!ctx.flex || host.remaining <= 0 || swarm.aborted || swarm.cappedOut)
                break;
            // ── Steering ──
            ctx.syncRunInfo();
            ctx.display.setSteering(ctx.rlGetter, ctx.buildSteeringContext());
            ctx.display.resume();
            const steered = await ctx.runSteering();
            if (!steered)
                break;
            host.waveNum++;
        } // end inner while
        // ── Budget exhaustion: offer to extend ──
        const exhaustedByBudget = !host.objectiveComplete && !ctx.isStopping() && !host.lastAborted && !host.lastCapped &&
            host.remaining <= 0;
        if (exhaustedByBudget) {
            const ext = await promptBudgetExtension({
                estimate: ctx.lastEstimate,
                spent: host.accCost,
                sessionsUsed: host.accCompleted + host.accFailed,
                budget: ctx.budget,
            });
            if (ext > 0) {
                host.remaining = ext;
                host.lastCapped = false;
                host.lastAborted = false;
                ctx.display.setSteering(ctx.rlGetter, ctx.buildSteeringContext());
                ctx.display.start();
                const steered = await ctx.runSteering();
                if (steered) {
                    host.waveNum++;
                    runAnotherRound = true;
                    continue;
                }
                ctx.display.stop();
            }
        }
    } // end outer while
    return { runAnotherRound };
}
// ── Helpers ──
function handleZeroWorkRetry(swarm, host, ctx) {
    const failedBranches = new Set(swarm.mergeResults.filter(r => !r.ok).map(r => r.branch));
    const postResults = new Map();
    for (const a of swarm.agents) {
        if (a.status !== "done" || !a.task.postcondition)
            continue;
        if (a.branch && failedBranches.has(a.branch))
            continue;
        try {
            const out = execSync(a.task.postcondition, { cwd: ctx.cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
            postResults.set(a.id, { ok: true, output: out.trim().slice(0, 400) });
        }
        catch (err) {
            const output = ((err.stderr || "") + "\n" + (err.stdout || err.message || "")).trim().slice(0, 400);
            postResults.set(a.id, { ok: false, output });
        }
    }
    const zeroWork = swarm.agents.filter(a => {
        if (a.status !== "done" || (a.task.type && a.task.type !== "execute"))
            return false;
        if ((a.filesChanged ?? 0) === 0)
            return true;
        const pr = postResults.get(a.id);
        return pr && !pr.ok;
    });
    if (zeroWork.length === 0)
        return;
    const noFiles = zeroWork.filter(a => (a.filesChanged ?? 0) === 0).length;
    const badPost = zeroWork.length - noFiles;
    ctx.display.appendSteeringEvent(`Retry: ${zeroWork.length} task(s) (${noFiles} with 0 files, ${badPost} failed postcondition)`);
    const retryTasks = zeroWork.map(a => {
        const pr = postResults.get(a.id);
        const postFailBlock = pr && !pr.ok
            ? `\n\nThe postcondition \`${a.task.postcondition}\` failed after your last attempt:\n${pr.output || "(no output)"}\n\nFix what makes the check fail and try again.`
            : `\n\nIMPORTANT: your last attempt made no file edits. If the fix truly needs no changes, say 'no-op:' at the start and explain why. Otherwise, make the actual edits.`;
        return {
            id: `${a.task.id}-retry`,
            prompt: `${a.task.prompt}${postFailBlock}`,
            type: "execute",
            postcondition: a.task.postcondition,
        };
    });
    const retrySwarm = new Swarm({
        tasks: retryTasks, concurrency: Math.min(host.concurrency, retryTasks.length), cwd: ctx.cwd, model: host.workerModel,
        permissionMode: host.permissionMode, allowedTools: undefined, useWorktrees: ctx.useWorktrees, mergeStrategy: ctx.waveMerge,
        agentTimeoutMs: ctx.agentTimeoutMs, usageCap: host.usageCap, allowExtraUsage: ctx.allowExtraUsage,
        extraUsageBudget: ctx.extraUsageBudget, baseCostUsd: host.accCost, envForModel: ctx.envForModel,
        cursorProxy: ctx.cursorProxy,
    });
    host.currentSwarm = retrySwarm;
    ctx.display.setWave(retrySwarm);
    ctx.display.resume();
    try {
        retrySwarm.run();
    }
    catch { }
    ctx.display.pause();
    host.accIn += retrySwarm.totalInputTokens;
    host.accOut += retrySwarm.totalOutputTokens;
    host.accTools += retrySwarm.agents.reduce((sum, a) => sum + a.toolCalls, 0);
    const retryFailedBranches = new Set(retrySwarm.mergeResults.filter(r => !r.ok).map(r => r.branch));
    const stillZero = retrySwarm.agents.filter(a => {
        if (a.status !== "done")
            return false;
        if ((a.filesChanged ?? 0) === 0)
            return true;
        if (!a.task.postcondition)
            return false;
        if (a.branch && retryFailedBranches.has(a.branch))
            return true;
        try {
            execSync(a.task.postcondition, { cwd: ctx.cwd, stdio: "ignore", timeout: 30_000 });
            return false;
        }
        catch {
            return true;
        }
    });
    for (const a of stillZero) {
        const why = (a.filesChanged ?? 0) === 0 ? "still changed 0 files" : "postcondition still failing";
        ctx.display.appendSteeringEvent(`RETRY FAILED: agent ${a.id} ${why} — task dropped as error`);
        a.error = a.error ?? `retry failed: ${why}`;
        host.accFailed++;
        host.remaining = Math.max(0, host.remaining - 1);
    }
    host.accCompleted += retrySwarm.completed;
    host.remaining = Math.max(0, host.remaining - retrySwarm.completed);
    swarm.agents.push(...retrySwarm.agents);
    swarm.completed += retrySwarm.completed;
    swarm.failed += stillZero.length;
    swarm.totalCostUsd += retrySwarm.totalCostUsd;
    swarm.totalInputTokens += retrySwarm.totalInputTokens;
    swarm.totalOutputTokens += retrySwarm.totalOutputTokens;
    host.liveConfig.remaining = host.remaining;
}
function buildRunState(host, phase, currentTasks) {
    return {
        remaining: host.remaining, phase, currentTasks,
        workerModel: host.workerModel, plannerModel: host.plannerModel, fastModel: host.fastModel,
        concurrency: host.concurrency, permissionMode: host.permissionMode,
        usageCap: host.usageCap, flex: true, waveNum: host.waveNum,
        accCost: host.accCost, accCompleted: host.accCompleted, accFailed: host.accFailed,
        accIn: host.accIn, accOut: host.accOut, accTools: host.accTools,
    };
}
