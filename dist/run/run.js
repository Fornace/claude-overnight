import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import chalk from "chalk";
import { computeRepoFingerprint } from "../core/fingerprint.js";
import { steerWave, STEER_SCHEMA } from "../planner/steering.js";
import { verifyWave } from "../planner/verifier.js";
import { getTotalPlannerCost, getPlannerRateLimitInfo, runPlannerQuery, setPlannerEnvResolver, attemptJsonParse } from "../planner/query.js";
import { buildEnvResolver, isCursorProxyProvider } from "../providers/index.js";
import { RunDisplay } from "../ui/ui.js";
import { renderSummary } from "../ui/summary.js";
import { readRunMemory, writeStatus, writeGoalUpdate, saveRunState, saveWaveSession, loadWaveHistory, recordBranches, archiveMilestone, writeSteerInbox, consumeSteerInbox, countSteerInbox, appendOvernightLogStart, updateOvernightLogEnd, } from "../state/state.js";
import { composeRunState } from "../state/run-state.js";
import { runPostRunReview } from "./review.js";
import { printFinalSummary } from "./summary.js";
import { runWaveLoop } from "./wave-loop.js";
import { renderPrompt } from "../prompts/load.js";
export async function executeRun(cfg) {
    const restore = () => { try {
        process.stdout.write("\x1B[?25h\n");
    }
    catch { } };
    const { objective, cwd, beforeWave: beforeWaveCmds, afterWave: afterWaveCmds, afterRun: afterRunCmds, runDir, previousKnowledge } = cfg;
    let { workerModel, plannerModel, fastModel, concurrency } = cfg;
    const envForModel = buildEnvResolver({
        plannerModel, plannerProvider: cfg.plannerProvider,
        workerModel, workerProvider: cfg.workerProvider,
        fastModel: cfg.fastModel, fastProvider: cfg.fastProvider,
    });
    setPlannerEnvResolver(envForModel);
    let { usageCap, flex } = cfg;
    const useWorktrees = cfg.useWorktrees;
    const mergeStrategy = cfg.mergeStrategy;
    mkdirSync(join(runDir, "reflections"), { recursive: true });
    mkdirSync(join(runDir, "milestones"), { recursive: true });
    mkdirSync(join(runDir, "sessions"), { recursive: true });
    let currentSwarm;
    let remaining;
    let currentTasks;
    const liveConfig = {
        remaining: 0, usageCap, concurrency, paused: false, dirty: false,
        extraUsageBudget: cfg.extraUsageBudget,
        workerModel, plannerModel, fastModel,
    };
    let waveNum;
    const waveHistory = [];
    let accCost, accCompleted, accFailed, accTools;
    let accIn = 0, accOut = 0;
    let peakWorkerCtxPct = 0, peakWorkerCtxTokens = 0;
    let lastCapped = false, lastAborted = false, objectiveComplete = false;
    let lastEstimate;
    const branches = [];
    // Skills telemetry accumulators
    let skillsPromoted = 0, skillsPatched = 0, skillsQuarantined = 0, skillsRejected = 0;
    if (cfg.resuming && cfg.resumeState) {
        const rs = cfg.resumeState;
        remaining = Math.max(1, rs.remaining);
        currentTasks = rs.currentTasks;
        waveNum = rs.waveNum;
        accCost = rs.accCost;
        accCompleted = rs.accCompleted;
        accFailed = rs.accFailed;
        accTools = rs.accTools ?? 0;
        accIn = rs.accIn ?? 0;
        accOut = rs.accOut ?? 0;
        branches.push(...rs.branches);
        flex = rs.flex;
        waveHistory.push(...loadWaveHistory(runDir));
        // Planning-phase resume starts at wave 0 (nothing ran before); all other
        // resumes bump to the next wave since rs.waveNum is the last completed one.
        const fromPlanning = rs.phase === "planning";
        if (fromPlanning && !existsSync(join(runDir, "goal.md")) && objective) {
            writeFileSync(join(runDir, "goal.md"), `## Original Objective\n${objective}`, "utf-8");
        }
        const detail = fromPlanning ? `${currentTasks.length} tasks from plan` : `${waveHistory.length} prior waves`;
        console.log(chalk.green(`\n  ✓ Resumed`) + chalk.dim(` · wave ${waveNum + 1} · ${remaining} remaining · $${accCost.toFixed(2)} spent · ${detail}\n`));
        if (!fromPlanning)
            waveNum++;
    }
    else {
        if (objective && !existsSync(join(runDir, "goal.md"))) {
            writeFileSync(join(runDir, "goal.md"), `## Original Objective\n${objective}`, "utf-8");
        }
        remaining = cfg.budget - cfg.thinkingUsed;
        currentTasks = cfg.tasks;
        waveNum = 0;
        if (cfg.thinkingHistory)
            waveHistory.push(cfg.thinkingHistory);
        accCost = cfg.thinkingCost;
        accCompleted = 0;
        accFailed = 0;
        accTools = cfg.thinkingTools;
        accIn = cfg.thinkingIn;
        accOut = cfg.thinkingOut;
    }
    liveConfig.remaining = remaining;
    liveConfig.usageCap = usageCap;
    const runInfoRef = {
        accIn, accOut, accCost, accCompleted, accFailed,
        sessionsBudget: cfg.budget, waveNum, remaining,
        model: workerModel, startedAt: cfg.runStartedAt,
        pendingSteer: countSteerInbox(runDir),
    };
    let display;
    const onSteer = (text) => {
        try {
            writeSteerInbox(runDir, text);
            runInfoRef.pendingSteer = countSteerInbox(runDir);
            if (currentSwarm)
                currentSwarm.log(-1, `Steer queued: ${text.slice(0, 80)}`);
        }
        catch { }
    };
    let askInFlight = false;
    const onAsk = (question) => {
        if (askInFlight)
            return;
        askInFlight = true;
        display.setAskBusy(true);
        display.setAsk({ question, answer: "", streaming: true });
        void (async () => {
            const plannerCostBefore = getTotalPlannerCost();
            try {
                const memory = readRunMemory(runDir, previousKnowledge || undefined);
                const cap = (s, max) => s && s.length > max ? s.slice(0, max) + "\n...(truncated)" : (s || "");
                const context = [
                    objective ? `Objective: ${objective}` : "",
                    memory.goal ? `Goal:\n${cap(memory.goal, 1500)}` : "",
                    memory.status ? `Current status:\n${cap(memory.status, 2000)}` : "",
                    memory.verifications ? `Latest verification:\n${cap(memory.verifications, 1500)}` : "",
                    memory.reflections ? `Latest reflections:\n${cap(memory.reflections, 1500)}` : "",
                    waveHistory.length ? `Waves completed: ${waveHistory.length}` : "",
                ].filter(Boolean).join("\n\n");
                const prompt = renderPrompt("60_runtime/60-1_ask", { vars: { context, question } });
                const answer = await runPlannerQuery(prompt, { cwd, model: plannerModel }, () => { });
                accCost += getTotalPlannerCost() - plannerCostBefore;
                syncRunInfo();
                display.setAsk({ question, answer: answer.trim() || "(no answer)", streaming: false });
            }
            catch (err) {
                accCost += getTotalPlannerCost() - plannerCostBefore;
                syncRunInfo();
                display.setAsk({ question, answer: "", streaming: false, error: err?.message?.slice(0, 200) || "ask failed" });
            }
            finally {
                askInFlight = false;
                display.setAskBusy(false);
            }
        })();
    };
    // Declared up here (before onQuit) so the 'q' callback can flip it.
    // The SIGINT/SIGTERM handler below reuses the same flag.
    let stopping = false;
    // onQuit: user pressed 'q'. Flip the runner's stopping flag so the wave loop
    // breaks cleanly (no advance to steering / post-run review) and abort the
    // live swarm so in-flight agents stop immediately.
    const onQuit = () => {
        if (stopping) {
            currentSwarm?.abort();
            return;
        }
        stopping = true;
        currentSwarm?.abort();
        try {
            display.appendSteeringEvent("Quit requested — stopping after current work.");
        }
        catch { }
    };
    display = new RunDisplay(runInfoRef, liveConfig, { onSteer, onAsk, onQuit });
    const rlGetter = () => {
        const rl = getPlannerRateLimitInfo();
        return { utilization: rl.utilization, isUsingOverage: rl.isUsingOverage, windows: rl.windows, resetsAt: rl.resetsAt };
    };
    const syncRunInfo = () => Object.assign(runInfoRef, { accIn, accOut, accCost, accCompleted, accFailed, waveNum, remaining });
    const buildSteeringContext = () => {
        let status;
        try {
            status = readFileSync(join(runDir, "status.md"), "utf-8");
        }
        catch { }
        return {
            objective: objective || undefined,
            status,
            lastWave: waveHistory[waveHistory.length - 1],
        };
    };
    const steeringLog = (text, kind) => {
        if (kind === "event")
            display.appendSteeringEvent(text);
        else
            display.updateSteeringStatus(text);
    };
    const runDebrief = (label) => {
        const debriefModel = fastModel || workerModel;
        const memory = readRunMemory(runDir, previousKnowledge || undefined);
        const cap = (s, n) => s && s.length > n ? s.slice(0, n) + "…" : (s || "");
        const context = [
            objective ? `Objective: ${objective}` : "",
            memory.status ? `Status:\n${cap(memory.status, 800)}` : "",
            waveHistory.length ? `Waves done: ${waveHistory.length}` : "",
            memory.reflections ? `Reflections:\n${cap(memory.reflections, 600)}` : "",
        ].filter(Boolean).join("\n\n");
        const prompt = renderPrompt("60_runtime/60-2_debrief", { vars: { label, context } });
        // Show in-flight feedback so the panel isn't empty while the planner thinks.
        display.setDebrief(`Summarizing ${label.toLowerCase().replace(/\.$/, "")}\u2026`);
        void runPlannerQuery(prompt, { cwd, model: debriefModel }, () => { })
            .then(text => { display.setDebrief(text.trim().slice(0, 210), label); })
            .catch(() => { display.setDebrief(undefined); });
    };
    // For flex + branch strategy: create one target branch (or restore on resume).
    // The run-branch + originalRef are persisted in run.json so resumes accumulate
    // into the original branch instead of spawning orphan swarm/run-* branches.
    let runBranch;
    let originalRef;
    if (cfg.resuming && cfg.resumeState) {
        runBranch = cfg.resumeState.runBranch;
        originalRef = cfg.resumeState.originalRef;
        if (runBranch) {
            try {
                execSync(`git checkout "${runBranch}"`, { cwd, encoding: "utf-8", stdio: "pipe" });
                console.log(chalk.dim(`  Resumed on branch: ${runBranch}\n`));
            }
            catch {
                console.log(chalk.yellow(`  ⚠ Could not check out run branch ${runBranch} — wave merges may diverge\n`));
            }
        }
    }
    if (flex && mergeStrategy === "branch" && useWorktrees && !runBranch) {
        try {
            originalRef = execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf-8", stdio: "pipe" }).trim();
            if (originalRef === "HEAD")
                originalRef = execSync("git rev-parse HEAD", { cwd, encoding: "utf-8", stdio: "pipe" }).trim();
            const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
            runBranch = `swarm/run-${ts}`;
            execSync(`git checkout -b "${runBranch}"`, { cwd, encoding: "utf-8", stdio: "pipe" });
            console.log(chalk.dim(`  Branch: ${runBranch}\n`));
        }
        catch { }
    }
    const waveMerge = (flex && runBranch) ? "yolo" : mergeStrategy;
    const runId = runDir.split(/[/\\]/).pop() ?? "";
    const repoFingerprint = computeRepoFingerprint(cwd);
    if (!cfg.resuming) {
        try {
            appendOvernightLogStart(cwd, runId, {
                objective: objective || "",
                model: workerModel,
                budget: cfg.budget,
                flex,
                usageCap,
                branch: runBranch,
            });
        }
        catch { }
    }
    const runStateBase = {
        cwd,
        id: `run-${new Date(cfg.runStartedAt).toISOString().slice(0, 19)}`,
        startedAt: new Date(cfg.runStartedAt).toISOString(),
        objective: objective ?? "",
        budget: cfg.budget,
        workerProviderId: cfg.workerProvider?.id,
        plannerProviderId: cfg.plannerProvider?.id,
        fastProviderId: cfg.fastProvider?.id,
        allowExtraUsage: cfg.allowExtraUsage ?? false,
        extraUsageBudget: cfg.extraUsageBudget,
        flex, useWorktrees, mergeStrategy,
        repoFingerprint,
        coachedObjective: cfg.coachedObjective,
        coachedAt: cfg.coachedAt,
        runBranch,
        originalRef,
    };
    const buildRunState = (varying) => composeRunState({ ...runStateBase, workerModel, plannerModel, fastModel, concurrency, usageCap }, { remaining: varying.remaining, waveNum, accCost, accCompleted, accFailed, accIn, accOut, accTools, branches }, { phase: varying.phase, currentTasks: varying.currentTasks });
    const gracefulStop = () => {
        if (stopping) {
            currentSwarm?.cleanup();
            display.stop();
            restore();
            process.exit(0);
        }
        stopping = true;
        currentSwarm?.abort();
    };
    process.on("SIGINT", gracefulStop);
    process.on("SIGTERM", gracefulStop);
    const crashHandler = (label, detail) => {
        try {
            saveRunState(runDir, buildRunState({ remaining, phase: "stopped", currentTasks }));
        }
        catch { }
        // Save partial wave session if swarm was running.
        if (currentSwarm?.agents.length) {
            try {
                saveWaveSession(runDir, waveNum, currentSwarm.agents, currentSwarm.totalCostUsd);
            }
            catch { }
        }
        display.stop();
        restore();
        console.error(chalk.red(`\n  ${label}: ${detail}`));
        process.exit(1);
    };
    const cleanupSwarm = () => { currentSwarm?.abort(); currentSwarm?.cleanup(); };
    process.on("uncaughtException", (err) => { cleanupSwarm(); crashHandler("Uncaught", err instanceof Error ? err.message : String(err)); });
    process.on("unhandledRejection", (reason) => { cleanupSwarm(); crashHandler("Unhandled", reason instanceof Error ? reason.message : String(reason)); });
    // Shared steering logic used by both resume-steering and in-loop steering
    const runSteering = async () => {
        let steered = false;
        // ── B1: Skip steering when ≥2 unresolved merge-failed branches exist ──
        const mergeFailedBranches = branches.filter(b => b.status === "merge-failed");
        if (mergeFailedBranches.length >= 2) {
            currentTasks = mergeFailedBranches.map((b, i) => ({
                id: `branch-retry-${i}`,
                prompt: renderPrompt("30_wave/30-3_branch-retry", { vars: { originalTask: b.taskPrompt } }),
                model: workerModel,
                postcondition: "pnpm run build",
            }));
            display.appendSteeringEvent(`Skipping steering — ${mergeFailedBranches.length} merge-failed branches form the wave`);
            return true;
        }
        let steerAttempts = 0;
        const MAX_STEER_ATTEMPTS = 2; // B2: retry threshold 3 → 2
        while (!steered && remaining > 0 && !stopping && steerAttempts < MAX_STEER_ATTEMPTS) {
            steerAttempts++;
            const plannerCostBefore = getTotalPlannerCost();
            try {
                const memory = readRunMemory(runDir, previousKnowledge || undefined);
                const appliedGuidance = memory.userGuidance;
                if (appliedGuidance)
                    display.appendSteeringEvent(`User directives applied: ${appliedGuidance.slice(0, 80)}`);
                const steer = await steerWave(objective, waveHistory, remaining, cwd, plannerModel, workerModel, fastModel, concurrency, steeringLog, memory, `steer-wave-${waveNum}-attempt-${steerAttempts}`);
                accCost += getTotalPlannerCost() - plannerCostBefore;
                syncRunInfo();
                if (steer.statusUpdate)
                    writeStatus(runDir, steer.statusUpdate);
                if (steer.goalUpdate)
                    writeGoalUpdate(runDir, steer.goalUpdate);
                if (typeof steer.estimatedSessionsRemaining === "number")
                    lastEstimate = steer.estimatedSessionsRemaining;
                const steerDir = join(runDir, "steering");
                mkdirSync(steerDir, { recursive: true });
                writeFileSync(join(steerDir, `wave-${waveNum}-attempt-${steerAttempts}.json`), JSON.stringify({
                    done: steer.done, reasoning: steer.reasoning,
                    taskCount: steer.tasks.length, statusUpdate: steer.statusUpdate, goalUpdate: steer.goalUpdate,
                    appliedGuidance: appliedGuidance || undefined,
                }, null, 2), "utf-8");
                if (appliedGuidance) {
                    consumeSteerInbox(runDir, waveNum);
                    runInfoRef.pendingSteer = countSteerInbox(runDir);
                }
                if (waveHistory.length > 0 && waveHistory.length % 5 === 0)
                    archiveMilestone(runDir, waveNum);
                if (steer.done || steer.tasks.length === 0) {
                    const hasVerification = waveHistory.some(w => w.tasks.some(t => t.prompt.toLowerCase().includes("verif")));
                    if (!hasVerification && remaining >= 1) {
                        display.appendSteeringEvent("Done blocked  -- auto-composing verification wave");
                        currentTasks = [{
                                id: "verify-0",
                                prompt: renderPrompt("30_wave/30-5_auto-verify"),
                                noWorktree: true, model: plannerModel, type: "verify",
                            }];
                        steered = true;
                        break;
                    }
                    objectiveComplete = true;
                    remaining = 0;
                    break;
                }
                // steerWave already resolves role strings ("worker"/"planner"/"fast") to concrete model IDs
                // using the current model variables, so tasks come back with a real model already.
                currentTasks = steer.tasks;
                steered = true;
            }
            catch (err) {
                accCost += getTotalPlannerCost() - plannerCostBefore;
                const rawPreview = err?.message?.slice(0, 200) || "(no details)";
                if (steerAttempts < MAX_STEER_ATTEMPTS) {
                    display.appendSteeringEvent(`Steering failed (attempt ${steerAttempts}/${MAX_STEER_ATTEMPTS})  -- retrying... ${rawPreview}`);
                    continue;
                }
                // ── B3: Decomposer fallback (replaces single-giant-fallback) ──
                display.appendSteeringEvent(`Steering failed ${MAX_STEER_ATTEMPTS}×  — decomposer fallback`);
                // First: try merge-failed recycling even if only 1 unresolved branch exists
                const stillFailed = branches.filter(b => b.status === "merge-failed");
                if (stillFailed.length >= 1) {
                    currentTasks = stillFailed.map((b, i) => ({
                        id: `branch-retry-${i}`,
                        prompt: renderPrompt("30_wave/30-3_branch-retry", { vars: { originalTask: b.taskPrompt } }),
                        model: workerModel,
                        postcondition: "pnpm run build",
                    }));
                    display.appendSteeringEvent(`Decomposer: ${stillFailed.length} merge-failed branch(es) retried as swarm tasks`);
                    steered = true;
                    break;
                }
                // Second: minimal-prompt planner query
                display.appendSteeringEvent("Decomposer: minimal planner query…");
                try {
                    let statusText = "";
                    try {
                        statusText = readFileSync(join(runDir, "status.md"), "utf-8");
                    }
                    catch { }
                    const minimalPrompt = renderPrompt("30_wave/30-4_decomposer-minimal", {
                        vars: { objective, status: statusText || "(none)" },
                    });
                    const minimalText = await runPlannerQuery(minimalPrompt, { cwd, model: plannerModel, outputFormat: STEER_SCHEMA, transcriptName: "decomposer-minimal", maxTurns: 40 }, () => { });
                    const parsed = attemptJsonParse(minimalText);
                    if (parsed?.tasks?.length > 0) {
                        currentTasks = parsed.tasks.map((t, i) => ({
                            id: `decompose-${i}`,
                            prompt: typeof t === "string" ? t : t.prompt,
                            model: workerModel,
                        }));
                        display.appendSteeringEvent(`Decomposer: ${currentTasks.length} tasks from minimal planner`);
                        steered = true;
                        break;
                    }
                }
                catch { }
                // Finally: halt
                display.appendSteeringEvent(`Decomposer: no tasks produced — halting`);
                return false;
            }
        }
        return steered;
    };
    // In non-flex mode with an objective, the verifier runs between waves instead of the steerer.
    const runVerifier = async () => {
        if (!objective)
            return false;
        const plannerCostBefore = getTotalPlannerCost();
        try {
            const result = await verifyWave(objective, currentTasks, waveHistory[waveHistory.length - 1], remaining, cwd, plannerModel, concurrency, steeringLog, `verify-wave-${waveNum}`);
            accCost += getTotalPlannerCost() - plannerCostBefore;
            syncRunInfo();
            if (result.statusUpdate)
                writeStatus(runDir, result.statusUpdate);
            if (typeof result.estimatedSessionsRemaining === "number")
                lastEstimate = result.estimatedSessionsRemaining;
            if (result.done || result.tasks.length === 0) {
                objectiveComplete = result.done;
                remaining = 0;
                return false;
            }
            currentTasks = result.tasks;
            return true;
        }
        catch (err) {
            accCost += getTotalPlannerCost() - plannerCostBefore;
            display.appendSteeringEvent(`Verifier failed: ${err?.message?.slice(0, 200) || "(no details)"}`);
            return false;
        }
    };
    // Resume: steer immediately if no queued tasks
    if (cfg.resuming && flex && currentTasks.length === 0 && remaining > 0) {
        display.setSteering(rlGetter, buildSteeringContext());
        display.start();
        await runSteering();
    }
    // Start unified display
    if (!display.runInfo.startedAt)
        display.runInfo.startedAt = cfg.runStartedAt;
    display.start();
    // ── Main wave loop (extracted to wave-loop.ts) ──
    const { runAnotherRound: _runAnotherRound } = await runWaveLoop(
    // host
    {
        get currentSwarm() { return currentSwarm; },
        set currentSwarm(v) { currentSwarm = v; },
        get remaining() { return remaining; },
        set remaining(v) { remaining = v; },
        get currentTasks() { return currentTasks; },
        set currentTasks(v) { currentTasks = v; },
        get waveNum() { return waveNum; },
        set waveNum(v) { waveNum = v; },
        get accCost() { return accCost; },
        set accCost(v) { accCost = v; },
        get accIn() { return accIn; },
        set accIn(v) { accIn = v; },
        get accOut() { return accOut; },
        set accOut(v) { accOut = v; },
        get accCompleted() { return accCompleted; },
        set accCompleted(v) { accCompleted = v; },
        get accFailed() { return accFailed; },
        set accFailed(v) { accFailed = v; },
        get accTools() { return accTools; },
        set accTools(v) { accTools = v; },
        peakWorkerCtxPct, peakWorkerCtxTokens,
        get lastCapped() { return lastCapped; },
        set lastCapped(v) { lastCapped = v; },
        get lastAborted() { return lastAborted; },
        set lastAborted(v) { lastAborted = v; },
        get objectiveComplete() { return objectiveComplete; },
        set objectiveComplete(v) { objectiveComplete = v; },
        liveConfig,
        get workerModel() { return workerModel; },
        set workerModel(v) { workerModel = v; },
        get plannerModel() { return plannerModel; },
        set plannerModel(v) { plannerModel = v; },
        get fastModel() { return fastModel; },
        set fastModel(v) { fastModel = v; },
        get concurrency() { return concurrency; },
        set concurrency(v) { concurrency = v; },
        get usageCap() { return usageCap; },
        set usageCap(v) { usageCap = v; },
        branches,
        waveHistory,
        repoFingerprint,
        runId,
        allowSkillProposals: true,
    }, 
    // ctx
    {
        cwd, runDir, agentTimeoutMs: cfg.agentTimeoutMs,
        envForModel: envForModel,
        beforeWaveCmds, afterWaveCmds,
        flex, useWorktrees, waveMerge,
        budget: cfg.budget,
        cursorProxy: [cfg.workerProvider, cfg.plannerProvider, cfg.fastProvider].some(p => p && isCursorProxyProvider(p)),
        allowExtraUsage: cfg.allowExtraUsage ?? false,
        extraUsageBudget: cfg.extraUsageBudget ?? 0,
        lastEstimate,
        display,
        runSteering,
        runVerifier,
        buildSteeringContext,
        rlGetter,
        isStopping: () => stopping,
        syncRunInfo,
        buildRunState,
        renderSummary,
        runDebrief,
        recordBranches: (agents, mergeResults, currentWave) => {
            recordBranches(agents, mergeResults, branches, currentWave);
        },
        onLibrarianResult: (p, pa, q, r) => {
            skillsPromoted += p;
            skillsPatched += pa;
            skillsQuarantined += q;
            skillsRejected += r;
        },
    });
    display.stop();
    // ── Finalize ──
    const trulyDone = objectiveComplete || (!flex && remaining <= 0);
    // User-initiated quit (or abort via 'q' / SIGINT / stall-watchdog) ⇒ save as
    // "stopped" so resume.ts offers the run and the incomplete work comes back.
    const userQuit = stopping || lastAborted;
    const wasCapped = lastCapped && !userQuit;
    const finalPhase = trulyDone ? "done"
        : userQuit ? "stopped"
            : wasCapped ? "capped"
                : remaining <= 0 ? "capped"
                    : "stopped";
    // Preserve currentTasks when stopped mid-wave so resume has the leftover work.
    const finalTasks = finalPhase === "stopped" ? currentTasks : [];
    saveRunState(runDir, buildRunState({ remaining, phase: finalPhase, currentTasks: finalTasks }));
    // Post-run final review: comprehensive review of the entire diff before shipping.
    // This can take several minutes — keep the display alive so the user sees the
    // review agent working in real time instead of staring at a frozen terminal.
    // Skip entirely when the user quit — they asked to stop, don't burn budget.
    if (flex && remaining > 0 && waveNum > 0 && !userQuit) {
        console.log(chalk.dim(`\n  Final review: scanning full run diff\u2026`));
        display.start();
        const finalReview = await runPostRunReview(objective || "", {
            cwd, plannerModel, concurrency,
            remaining, usageCap, allowExtraUsage: cfg.allowExtraUsage,
            extraUsageBudget: cfg.extraUsageBudget, baseCostUsd: accCost,
            envForModel, mergeStrategy: waveMerge, useWorktrees,
        }, (reviewSwarm) => {
            currentSwarm = reviewSwarm;
            display.setWave(reviewSwarm);
            display.resume();
        });
        display.stop();
        if (finalReview) {
            accCost += finalReview.costUsd;
            accIn += finalReview.inputTokens;
            accOut += finalReview.outputTokens;
            accCompleted += finalReview.completed;
            remaining = Math.max(0, remaining - finalReview.completed);
        }
    }
    if (trulyDone) {
        try {
            for (const dir of ["designs", "reflections", "verifications"])
                rmSync(join(runDir, dir), { recursive: true, force: true });
        }
        catch { }
    }
    try {
        updateOvernightLogEnd(cwd, runId, {
            cost: accCost,
            completed: accCompleted,
            failed: accFailed,
            waves: waveNum + 1,
            phase: finalPhase,
            elapsedSec: Math.round((Date.now() - cfg.runStartedAt) / 1000),
        });
    }
    catch { }
    if (runBranch && originalRef) {
        try {
            execSync(`git checkout "${originalRef}"`, { cwd, encoding: "utf-8", stdio: "pipe" });
        }
        catch { }
    }
    // After-run commands: run once after the entire run finishes (e.g. deploy).
    if (afterRunCmds) {
        const cmds = Array.isArray(afterRunCmds) ? afterRunCmds : [afterRunCmds];
        for (const cmd of cmds) {
            console.log(chalk.dim(`  After-run: ${cmd}`));
            try {
                const out = execSync(cmd, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
                if (out.trim())
                    console.log(chalk.dim(`  → ${out.trim().slice(0, 300)}`));
            }
            catch (err) {
                const msg = (err.stderr || err.stdout || err.message || "").trim().slice(0, 400);
                console.log(chalk.red(`  ✗ ${cmd}: ${msg}`));
            }
        }
        console.log("");
    }
    // Skills summary
    if (skillsPromoted || skillsPatched || skillsQuarantined || skillsRejected) {
        console.log(chalk.dim(`\n  Skills: promoted=${skillsPromoted} patched=${skillsPatched} quarantined=${skillsQuarantined} rejected=${skillsRejected}`));
    }
    await printFinalSummary({
        runDir, runBranch, objective, waveNum, runStartedAt: cfg.runStartedAt,
        branches, waveHistory,
        accCost, accCompleted, accFailed, accTools, accIn, accOut,
        remaining, lastCapped, lastAborted, stopping, trulyDone,
        peakWorkerCtxTokens, peakWorkerCtxPct,
        currentSwarmLogFile: currentSwarm?.logFile,
        narrativeDeps: {
            cwd, runDir, objective, previousKnowledge,
            workerModel, fastModel, waveHistory,
        },
    });
    if (accFailed > 0)
        process.exit(1);
    if (lastAborted || accCompleted === 0)
        process.exit(2);
}
