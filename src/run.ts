import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import chalk from "chalk";
import type { Task, PermMode, MergeStrategy, RunState, RunConfigBase, BranchRecord, WaveSummary, RunMemory } from "./types.js";
import { Swarm } from "./swarm.js";
import { steerWave } from "./steering.js";
import { getTotalPlannerCost, getPlannerRateLimitInfo, runPlannerQuery, setPlannerEnvResolver } from "./planner-query.js";
import type { ProviderConfig } from "./providers.js";
import { buildEnvResolver, isCursorProxyProvider } from "./providers.js";
import { RunDisplay } from "./ui.js";
import type { LiveConfig, RunInfo, SteeringContext } from "./ui.js";
import type { PlannerLog } from "./planner-query.js";
import { renderSummary } from "./render.js";
import { fmtTokens } from "./render.js";
import { isJWTAuthError } from "./auth.js";
import { selectKey, ask } from "./cli.js";
import {
  readRunMemory, writeStatus, writeGoalUpdate, saveRunState,
  saveWaveSession, loadWaveHistory, recordBranches, archiveMilestone,
  writeSteerInbox, consumeSteerInbox, countSteerInbox,
  appendOvernightLogStart, updateOvernightLogEnd,
} from "./state.js";

export interface RunConfig extends RunConfigBase {
  /** Tasks to execute. */
  tasks: Task[];
  /** High-level objective. */
  objective?: string;
  /** Custom provider for worker tasks (optional  -- Anthropic default when undefined). */
  workerProvider?: ProviderConfig;
  /** Custom provider for planner/steering calls (optional). */
  plannerProvider?: ProviderConfig;
  /** Custom provider for fast model tasks (optional). */
  fastProvider?: ProviderConfig;
  /** Per-agent timeout in ms. */
  agentTimeoutMs?: number;
  /** Working directory. */
  cwd: string;
  /** Allowlist of SDK tool names agents are permitted to use. */
  allowedTools?: string[];
  /** Shell command(s) to run in cwd before each wave starts (e.g. "pnpm run generate"). */
  beforeWave?: string | string[];
  /** Shell command(s) to run in cwd after each wave completes (e.g. "supabase db push"). */
  afterWave?: string | string[];
  /** Shell command(s) to run in cwd once after the entire run finishes (e.g. "vercel deploy"). */
  afterRun?: string | string[];
  /** Persisted run directory path. */
  runDir: string;
  /** Knowledge about the codebase from a pre-run thinking wave. */
  previousKnowledge: string;
  /** Whether this run is being resumed from a prior run.json. */
  resuming: boolean;
  /** State from the prior run (only set when resuming). */
  resumeState?: RunState;
  /** Sessions consumed by the pre-run thinking wave. */
  thinkingUsed: number;
  /** Cost of the pre-run thinking wave. */
  thinkingCost: number;
  /** Input tokens from the pre-run thinking wave. */
  thinkingIn: number;
  /** Output tokens from the pre-run thinking wave. */
  thinkingOut: number;
  /** Tool calls from the pre-run thinking wave. */
  thinkingTools: number;
  /** Wave summary from the pre-run thinking wave. */
  thinkingHistory?: WaveSummary;
  /** Unix timestamp (ms) when the run started. */
  runStartedAt: number;
}

export async function executeRun(cfg: RunConfig): Promise<void> {
  const restore = () => { try { process.stdout.write("\x1B[?25h\n"); } catch {} };
  const {
    objective, cwd, workerModel, plannerModel, fastModel, concurrency, permissionMode,
    allowedTools, beforeWave: beforeWaveCmds, afterWave: afterWaveCmds, afterRun: afterRunCmds, runDir, previousKnowledge,
  } = cfg;

  const envForModel = buildEnvResolver({
    plannerModel, plannerProvider: cfg.plannerProvider,
    workerModel, workerProvider: cfg.workerProvider,
    fastModel: cfg.fastModel, fastProvider: cfg.fastProvider,
  });
  setPlannerEnvResolver(envForModel);
  const modelMap = new Map<string, string>([
    ["planner", plannerModel],
    ["worker", workerModel],
  ]);
  if (fastModel) modelMap.set("fast", fastModel);
  let { usageCap, flex } = cfg;
  const useWorktrees = cfg.useWorktrees;
  const mergeStrategy = cfg.mergeStrategy;

  mkdirSync(join(runDir, "reflections"), { recursive: true });
  mkdirSync(join(runDir, "milestones"), { recursive: true });
  mkdirSync(join(runDir, "sessions"), { recursive: true });

  let currentSwarm: Swarm | undefined;
  let remaining: number;
  let currentTasks: Task[];
  const liveConfig: LiveConfig = {
    remaining: 0, usageCap, concurrency, paused: false, dirty: false,
    extraUsageBudget: cfg.extraUsageBudget,
  };
  let waveNum: number;
  const waveHistory: WaveSummary[] = [];
  let accCost: number, accCompleted: number, accFailed: number, accTools: number;
  let accIn = 0, accOut = 0;
  let lastCapped = false, lastAborted = false, objectiveComplete = false, lastHealed = false;
  let lastEstimate: number | undefined;
  const branches: BranchRecord[] = [];

  if (cfg.resuming && cfg.resumeState) {
    const rs = cfg.resumeState;
    remaining = Math.max(1, rs.remaining);
    currentTasks = rs.currentTasks;
    waveNum = rs.waveNum;
    accCost = rs.accCost; accCompleted = rs.accCompleted; accFailed = rs.accFailed;
    accTools = rs.accTools ?? 0; accIn = rs.accIn ?? 0; accOut = rs.accOut ?? 0;
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
    if (!fromPlanning) waveNum++;
  } else {
    if (objective && !existsSync(join(runDir, "goal.md"))) {
      writeFileSync(join(runDir, "goal.md"), `## Original Objective\n${objective}`, "utf-8");
    }
    remaining = cfg.budget - cfg.thinkingUsed;
    currentTasks = cfg.tasks;
    waveNum = 0;
    if (cfg.thinkingHistory) waveHistory.push(cfg.thinkingHistory);
    accCost = cfg.thinkingCost; accCompleted = 0; accFailed = 0;
    accTools = cfg.thinkingTools; accIn = cfg.thinkingIn; accOut = cfg.thinkingOut;
  }
  liveConfig.remaining = remaining;
  liveConfig.usageCap = usageCap;
  const runInfoRef: RunInfo = {
    accIn, accOut, accCost, accCompleted, accFailed,
    sessionsBudget: cfg.budget, waveNum, remaining,
    model: workerModel, startedAt: cfg.runStartedAt,
    pendingSteer: countSteerInbox(runDir),
  };
  let display!: RunDisplay;
  const onSteer = (text: string) => {
    try {
      writeSteerInbox(runDir, text);
      runInfoRef.pendingSteer = countSteerInbox(runDir);
      if (currentSwarm) currentSwarm.log(-1, `Steer queued: ${text.slice(0, 80)}`);
    } catch {}
  };
  let askInFlight = false;
  const onAsk = (question: string) => {
    if (askInFlight) return;
    askInFlight = true;
    display.setAskBusy(true);
    display.setAsk({ question, answer: "", streaming: true });
    void (async () => {
      const plannerCostBefore = getTotalPlannerCost();
      try {
        const memory = readRunMemory(runDir, previousKnowledge || undefined);
        const cap = (s: string, max: number) => s && s.length > max ? s.slice(0, max) + "\n...(truncated)" : (s || "");
        const memBlob = [
          objective ? `Objective: ${objective}` : "",
          memory.goal ? `Goal:\n${cap(memory.goal, 1500)}` : "",
          memory.status ? `Current status:\n${cap(memory.status, 2000)}` : "",
          memory.verifications ? `Latest verification:\n${cap(memory.verifications, 1500)}` : "",
          memory.reflections ? `Latest reflections:\n${cap(memory.reflections, 1500)}` : "",
          waveHistory.length ? `Waves completed: ${waveHistory.length}` : "",
        ].filter(Boolean).join("\n\n");
        const prompt = `You are answering a user question about an in-progress autonomous agent run. Use the context below; read files in the repo if needed. Answer concisely (a few sentences) and cite files or waves when relevant.\n\n${memBlob}\n\n---\nUser question: ${question}`;
        const answer = await runPlannerQuery(
          prompt,
          { cwd, model: plannerModel, permissionMode },
          () => { /* swallow ticker  -- don't clobber main status */ },
        );
        accCost += getTotalPlannerCost() - plannerCostBefore;
        syncRunInfo();
        display.setAsk({ question, answer: answer.trim() || "(no answer)", streaming: false });
      } catch (err: any) {
        accCost += getTotalPlannerCost() - plannerCostBefore;
        syncRunInfo();
        display.setAsk({ question, answer: "", streaming: false, error: err?.message?.slice(0, 200) || "ask failed" });
      } finally {
        askInFlight = false;
        display.setAskBusy(false);
      }
    })();
  };
  display = new RunDisplay(runInfoRef, liveConfig, { onSteer, onAsk });
  const rlGetter = () => {
    const rl = getPlannerRateLimitInfo();
    return { utilization: rl.utilization, isUsingOverage: rl.isUsingOverage, windows: rl.windows, resetsAt: rl.resetsAt };
  };
  const syncRunInfo = () => Object.assign(runInfoRef, { accIn, accOut, accCost, accCompleted, accFailed, waveNum, remaining });

  const buildSteeringContext = (): SteeringContext => {
    let status: string | undefined;
    try { status = readFileSync(join(runDir, "status.md"), "utf-8"); } catch {}
    return {
      objective: objective || undefined,
      status,
      lastWave: waveHistory[waveHistory.length - 1],
    };
  };
  const steeringLog: PlannerLog = (text, kind) => {
    if (kind === "event") display.appendSteeringEvent(text);
    else display.updateSteeringStatus(text);
  };

  const runDebrief = (label: string) => {
    const debriefModel = fastModel || workerModel;
    const memory = readRunMemory(runDir, previousKnowledge || undefined);
    const cap = (s: string, n: number) => s && s.length > n ? s.slice(0, n) + "…" : (s || "");
    const ctx = [
      objective ? `Objective: ${objective}` : "",
      memory.status ? `Status:\n${cap(memory.status, 800)}` : "",
      waveHistory.length ? `Waves done: ${waveHistory.length}` : "",
      memory.reflections ? `Reflections:\n${cap(memory.reflections, 600)}` : "",
    ].filter(Boolean).join("\n\n");
    const prompt = `${label}\n\n${ctx}\n\nWrite one short sentence (max 120 chars) summarising progress and what's next. No preamble.`;
    void runPlannerQuery(prompt, { cwd, model: debriefModel, permissionMode }, () => {})
      .then(text => { display.setDebrief(text.trim().slice(0, 140)); })
      .catch(() => {});
  };

  // For flex + branch strategy: create one target branch
  let runBranch: string | undefined;
  let originalRef: string | undefined;
  if (flex && mergeStrategy === "branch" && useWorktrees && !cfg.resuming) {
    try {
      originalRef = execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf-8", stdio: "pipe" }).trim();
      if (originalRef === "HEAD") originalRef = execSync("git rev-parse HEAD", { cwd, encoding: "utf-8", stdio: "pipe" }).trim();
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      runBranch = `swarm/run-${ts}`;
      execSync(`git checkout -b "${runBranch}"`, { cwd, encoding: "utf-8", stdio: "pipe" });
      console.log(chalk.dim(`  Branch: ${runBranch}\n`));
    } catch {}
  }
  const waveMerge: MergeStrategy = (flex && runBranch) ? "yolo" : mergeStrategy;

  const runId = runDir.split(/[/\\]/).pop() ?? "";
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
    } catch {}
  }

  const buildRunState = (varying: {
    remaining: number;
    phase: RunState["phase"];
    currentTasks: Task[];
  }): RunState => ({
    id: `run-${new Date().toISOString().slice(0, 19)}`, objective: objective ?? "", budget: cfg.budget,
    remaining, workerModel, plannerModel, fastModel,
    workerProviderId: cfg.workerProvider?.id, plannerProviderId: cfg.plannerProvider?.id,
    fastProviderId: cfg.fastProvider?.id,
    concurrency, permissionMode,
    usageCap, allowExtraUsage: cfg.allowExtraUsage, extraUsageBudget: cfg.extraUsageBudget,
    flex, useWorktrees, mergeStrategy, waveNum,
    currentTasks: varying.currentTasks,
    accCost, accCompleted, accFailed, accIn, accOut, accTools,
    branches, phase: varying.phase, startedAt: new Date(cfg.runStartedAt).toISOString(), cwd,
  });

  let stopping = false;
  const gracefulStop = () => {
    if (stopping) { currentSwarm?.cleanup(); display.stop(); restore(); process.exit(0); }
    stopping = true;
    currentSwarm?.abort();
  };
  process.on("SIGINT", gracefulStop);
  process.on("SIGTERM", gracefulStop);
  const crashHandler = (label: string, detail: string) => {
    try { saveRunState(runDir, buildRunState({ remaining, phase: "stopped", currentTasks })); } catch {}
    // Save partial wave session if swarm was running.
    if (currentSwarm?.agents.length) {
      try { saveWaveSession(runDir, waveNum, currentSwarm.agents, currentSwarm.totalCostUsd); } catch {}
    }
    display.stop(); restore();
    console.error(chalk.red(`\n  ${label}: ${detail}`));
    process.exit(1);
  };
  const cleanupSwarm = () => { currentSwarm?.abort(); currentSwarm?.cleanup(); };
  process.on("uncaughtException", (err) => { cleanupSwarm(); crashHandler("Uncaught", err instanceof Error ? err.message : String(err)); });
  process.on("unhandledRejection", (reason) => { cleanupSwarm(); crashHandler("Unhandled", reason instanceof Error ? reason.message : String(reason)); });

  // Shared steering logic used by both resume-steering and in-loop steering
  const runSteering = async (): Promise<boolean> => {
    let steered = false;
    let steerAttempts = 0;
    while (!steered && remaining > 0 && !stopping && steerAttempts < 3) {
      steerAttempts++;
      const plannerCostBefore = getTotalPlannerCost();
      try {
        const memory = readRunMemory(runDir, previousKnowledge || undefined);
        const appliedGuidance = memory.userGuidance;
        if (appliedGuidance) display.appendSteeringEvent(`User directives applied: ${appliedGuidance.slice(0, 80)}`);
        const steer = await steerWave(
          objective!, waveHistory, remaining, cwd, plannerModel, workerModel, fastModel,
          permissionMode, concurrency, steeringLog, memory,
        );
        accCost += getTotalPlannerCost() - plannerCostBefore;
        syncRunInfo();

        if (steer.statusUpdate) writeStatus(runDir, steer.statusUpdate);
        if (steer.goalUpdate) writeGoalUpdate(runDir, steer.goalUpdate);
        if (typeof steer.estimatedSessionsRemaining === "number") lastEstimate = steer.estimatedSessionsRemaining;
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
        if (waveHistory.length > 0 && waveHistory.length % 5 === 0) archiveMilestone(runDir, waveNum);

        if (steer.done || steer.tasks.length === 0) {
          const hasVerification = waveHistory.some(w => w.tasks.some(t => t.prompt.toLowerCase().includes("verif")));
          if (!hasVerification && remaining >= 1) {
            display.appendSteeringEvent("Done blocked  -- auto-composing verification wave");
            currentTasks = [{
              id: "verify-0",
              prompt: `## Verification: Build, run, and test the application end-to-end\n\nYou are the final gatekeeper before this run is marked complete. The steerer believes the objective is done. Your job: prove it or disprove it.\n\n1. Run the build (npm run build, or whatever this project uses). Report ALL errors.\n2. Start the dev server. If a port is taken, try another. If a dependency is missing, install it.\n3. Navigate key flows as a real user would. Check that the main features work.\n4. Write your findings to .claude-overnight/latest/verifications/final-verify.md\n\nBe relentless. Do not give up if the first approach fails. Search the codebase for dev login routes, test tokens, seed users, env vars, CLI auth commands, or any bypass.`,
              noWorktree: true, model: plannerModel,
            } as any];
            steered = true;
            break;
          }
          objectiveComplete = true;
          remaining = 0;
          break;
        }

        currentTasks = steer.tasks.map(t => ({
          ...t,
          model: t.model ? (modelMap.get(t.model) ?? t.model) : undefined,
        }));
        steered = true;
      } catch (err: any) {
        accCost += getTotalPlannerCost() - plannerCostBefore;
        if (steerAttempts < 3) {
          display.appendSteeringEvent(`Steering failed (attempt ${steerAttempts}/3)  -- retrying...`);
          continue;
        }
        display.appendSteeringEvent(`Steering failed ${steerAttempts}×  -- falling back`);
        let fallbackStatus = "";
        try { fallbackStatus = readFileSync(join(runDir, "status.md"), "utf-8"); } catch {}
        currentTasks = [{
          id: "fallback-0",
          prompt: `Steering couldn't decide the next step. Read the project, assess what's done vs. remaining, and do the most impactful work.\n\nObjective: ${objective}${fallbackStatus ? `\n\nStatus:\n${fallbackStatus}` : ""}`,
        }];
        steered = true;
        break;
      }
    }
    return steered;
  };

  // Resume: steer immediately if no queued tasks
  if (cfg.resuming && flex && currentTasks.length === 0 && remaining > 0) {
    display.setSteering(rlGetter, buildSteeringContext());
    display.start();
    await runSteering();
  }

  // Start unified display
  if (!display.runInfo.startedAt) display.runInfo.startedAt = cfg.runStartedAt;
  display.start();

  // ── Main wave loop (wrapped so exhaustion can prompt for an extension) ──
  let runAnotherRound = true;
  while (runAnotherRound) {
    runAnotherRound = false;
  while (remaining > 0 && currentTasks.length > 0 && !stopping) {
    // Health check: runs once per process start to fix a broken build before
    // any real work begins. Only triggers when there's nothing else queued --
    // it must NEVER override tasks that steering has already planned.
    if (!lastHealed) {
      lastHealed = true;
      // Only replace tasks with health fix if the queue was essentially empty.
      // Steering-planned tasks always take priority.
      const healTask = checkProjectHealth(cwd);
      if (healTask && remaining > 0 && currentTasks.length <= 1) {
        currentTasks = [healTask];
      }
    }
    if (currentTasks.length > remaining) currentTasks = currentTasks.slice(0, remaining);
    syncRunInfo();

    saveRunState(runDir, buildRunState({ remaining, phase: "steering", currentTasks }));

    // Pre-wave rate limit gate: don't spawn a new wave if the API is already
    // near a limit. This prevents wasting sessions on instant rejections.
    await throttleBeforeWave(
      () => getPlannerRateLimitInfo(),
      (text) => display.appendSteeringEvent(text),
      () => stopping,
    );
    if (stopping) break;

    // Before-wave commands: run in cwd before each wave starts (e.g. generate types from schema).
    if (beforeWaveCmds) {
      const cmds = Array.isArray(beforeWaveCmds) ? beforeWaveCmds : [beforeWaveCmds];
      for (const cmd of cmds) {
        display.appendSteeringEvent(`Before-wave: ${cmd}`);
        try {
          const out = execSync(cmd, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
          if (out.trim()) display.appendSteeringEvent(`  → ${out.trim().slice(0, 200)}`);
        } catch (err: any) {
          const msg = (err.stderr || err.stdout || err.message || "").trim().slice(0, 300);
          display.appendSteeringEvent(`  ✗ ${cmd}: ${msg}`);
        }
      }
    }

    const swarm = new Swarm({
      tasks: currentTasks, concurrency, cwd, model: workerModel, permissionMode, allowedTools,
      useWorktrees, mergeStrategy: waveMerge, agentTimeoutMs: cfg.agentTimeoutMs,
      usageCap, allowExtraUsage: cfg.allowExtraUsage, extraUsageBudget: cfg.extraUsageBudget,
      baseCostUsd: accCost, envForModel,
      cursorProxy: [cfg.workerProvider, cfg.plannerProvider, cfg.fastProvider].some(p => p && isCursorProxyProvider(p)),
    });
    currentSwarm = swarm;
    display.setWave(swarm);
    display.resume();
    try { await swarm.run(); }
    catch (err: unknown) {
      if (isJWTAuthError(err)) { display.stop(); restore(); console.error(chalk.red(`\n  Authentication failed  -- check your API key or run: claude auth\n`)); process.exit(1); }
      // Swarm crashed mid-execution  -- save partial results before propagating.
      // The pre-swarm saveRunState already preserved currentTasks for resume.
      // Also save the wave session with whatever agents completed.
      if (swarm.agents.length > 0) {
        try { saveWaveSession(runDir, waveNum, swarm.agents, swarm.totalCostUsd); } catch {}
      }
      throw err;
    }

    display.pause();
    console.log(renderSummary(swarm));

    accCost += swarm.totalCostUsd; accIn += swarm.totalInputTokens; accOut += swarm.totalOutputTokens;
    accCompleted += swarm.completed; accFailed += swarm.failed;
    accTools += swarm.agents.reduce((sum, a) => sum + a.toolCalls, 0);
    remaining = Math.max(0, remaining - swarm.completed - swarm.failed);
    const totalConsumed = accCompleted + accFailed + cfg.thinkingUsed;
    const expectedFloor = Math.max(0, cfg.budget - totalConsumed);
    if (remaining < expectedFloor) remaining = expectedFloor;
    if (liveConfig.dirty) {
      remaining = liveConfig.remaining;
      usageCap = liveConfig.usageCap;
      cfg.extraUsageBudget = liveConfig.extraUsageBudget;
      liveConfig.dirty = false;
    }
    liveConfig.remaining = remaining;
    lastCapped = swarm.cappedOut; lastAborted = swarm.aborted;
    recordBranches(swarm.agents, swarm.mergeResults, branches);
    saveWaveSession(runDir, waveNum, swarm.agents, swarm.totalCostUsd);
    // Tasks that never made it into the swarm (queue cleared on abort/cap)
    // are preserved as currentTasks so resume picks them up. Budget for these
    // wasn't decremented (only attempted agents were), so no refund needed.
    const attemptedPrompts = new Set(swarm.agents.map(a => a.task.prompt));
    const neverStarted = currentTasks.filter(t => !attemptedPrompts.has(t.prompt));
    saveRunState(runDir, buildRunState({ remaining, phase: "steering", currentTasks: neverStarted }));

    waveHistory.push({
      wave: waveNum,
      tasks: swarm.agents.map(a => ({ prompt: a.task.prompt, status: a.status, filesChanged: a.filesChanged, error: a.error })),
    });

    // Fire-and-forget debrief after each wave.
    runDebrief(`Wave ${waveNum + 1} just finished.`);

    // After-wave commands: run shell commands in cwd after each wave (e.g. "supabase db push").
    // Runs regardless of flex mode so migrations are applied before review/steering.
    if (afterWaveCmds && !swarm.aborted && !swarm.cappedOut) {
      const cmds = Array.isArray(afterWaveCmds) ? afterWaveCmds : [afterWaveCmds];
      for (const cmd of cmds) {
        display.appendSteeringEvent(`After-wave: ${cmd}`);
        try {
          const out = execSync(cmd, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
          if (out.trim()) display.appendSteeringEvent(`  → ${out.trim().slice(0, 200)}`);
        } catch (err: any) {
          const msg = (err.stderr || err.stdout || err.message || "").trim().slice(0, 300);
          display.appendSteeringEvent(`  ✗ ${cmd}: ${msg}`);
        }
      }
    }

    // Post-wave review: a single review agent against the consolidated diff.
    // Runs only when there was real work (not first wave, not abort/cap).
    if (flex && remaining > 0 && !swarm.aborted && !swarm.cappedOut && waveNum > 0) {
      const reviewResult = await runPostWaveReview({
        cwd, plannerModel, permissionMode, concurrency,
        remaining, usageCap, allowExtraUsage: cfg.allowExtraUsage,
        extraUsageBudget: cfg.extraUsageBudget, baseCostUsd: accCost,
        envForModel, mergeStrategy: waveMerge, useWorktrees,
      });
      if (reviewResult) {
        accCost += reviewResult.costUsd;
        accIn += reviewResult.inputTokens;
        accOut += reviewResult.outputTokens;
        accCompleted += reviewResult.completed;
        remaining = Math.max(0, remaining - reviewResult.completed);
        liveConfig.remaining = remaining;
        display.appendSteeringEvent(`Post-wave review: ${reviewResult.completed} done${reviewResult.failed > 0 ? ` / ${reviewResult.failed} failed` : ""}`);
      }
    }

    if (!flex || remaining <= 0 || swarm.aborted || swarm.cappedOut) break;

    syncRunInfo();
    display.setSteering(rlGetter, buildSteeringContext());
    display.resume();
    const steered = await runSteering();
    if (!steered) break;
    waveNum++;
  }

  display.stop();

  // ── Budget-exhausted: offer to extend with the same settings ──
  const exhaustedByBudget =
    !objectiveComplete && !stopping && !lastAborted && !lastCapped &&
    remaining <= 0 && !!process.stdin.isTTY;
  if (exhaustedByBudget) {
    const ext = await promptBudgetExtension({
      estimate: lastEstimate,
      spent: accCost,
      sessionsUsed: accCompleted + accFailed + cfg.thinkingUsed,
      budget: cfg.budget,
    });
    if (ext > 0) {
      remaining = ext;
      cfg.budget += ext;
      lastCapped = false;
      lastAborted = false;
      runInfoRef.sessionsBudget = cfg.budget;
      runInfoRef.remaining = remaining;
      liveConfig.remaining = remaining;
      liveConfig.usageCap = usageCap;
      display.setSteering(rlGetter, buildSteeringContext());
      display.start();
      const steered = await runSteering();
      if (steered) {
        waveNum++;
        runAnotherRound = true;
        continue;
      }
      display.stop();
    }
  }
  } // end outer extension loop

  // ── Finalize ──
  const trulyDone = objectiveComplete || (!flex && remaining <= 0);
  const wasCapped = lastCapped || lastAborted;
  const finalPhase = trulyDone ? "done" : wasCapped ? "capped" : remaining <= 0 ? "capped" : "stopped";
  saveRunState(runDir, buildRunState({ remaining, phase: finalPhase, currentTasks: [] }));

  // Post-run final review: comprehensive review of the entire diff before shipping.
  if (flex && remaining > 0 && waveNum > 0) {
    const finalReview = await runPostRunReview(
      objective || "", {
        cwd, plannerModel, permissionMode, concurrency,
        remaining, usageCap, allowExtraUsage: cfg.allowExtraUsage,
        extraUsageBudget: cfg.extraUsageBudget, baseCostUsd: accCost,
        envForModel, mergeStrategy: waveMerge, useWorktrees,
      },
    );
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
      for (const dir of ["designs", "reflections", "verifications"]) rmSync(join(runDir, dir), { recursive: true, force: true });
    } catch {}
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
  } catch {}
  if (runBranch && originalRef) {
    try { execSync(`git checkout "${originalRef}"`, { cwd, encoding: "utf-8", stdio: "pipe" }); } catch {}
  }

  // After-run commands: run once after the entire run finishes (e.g. deploy).
  if (afterRunCmds) {
    const cmds = Array.isArray(afterRunCmds) ? afterRunCmds : [afterRunCmds];
    for (const cmd of cmds) {
      console.log(chalk.dim(`  After-run: ${cmd}`));
      try {
        const out = execSync(cmd, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
        if (out.trim()) console.log(chalk.dim(`  → ${out.trim().slice(0, 300)}`));
      } catch (err: any) {
        const msg = (err.stderr || err.stdout || err.message || "").trim().slice(0, 400);
        console.log(chalk.red(`  ✗ ${cmd}: ${msg}`));
      }
    }
    console.log("");
  }

  // ── Final summary ──
  const waves = waveNum + 1;
  const elapsed = Math.round((Date.now() - cfg.runStartedAt) / 1000);
  const elapsedStr = elapsed < 60 ? `${elapsed}s` : elapsed < 3600 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${Math.floor(elapsed / 3600)}h ${Math.floor((elapsed % 3600) / 60)}m`;
  const totalMerged = branches.filter(b => b.status === "merged").length;
  const totalConflicts = branches.filter(b => b.status === "merge-failed").length;
  const termW = Math.max((process.stdout.columns ?? 80) || 80, 50);

  console.log("");
  const bannerChar = accFailed === 0 ? "=" : "-";
  console.log(chalk.green(`  ${bannerChar.repeat(Math.min(termW - 4, 60))}`));
  if (trulyDone) console.log(chalk.bold.green(`  CLAUDE OVERNIGHT  -- COMPLETE`));
  else if (remaining <= 0) console.log(chalk.bold.yellow(`  CLAUDE OVERNIGHT  -- BUDGET EXHAUSTED`));
  else if (lastCapped) console.log(chalk.bold.yellow(`  CLAUDE OVERNIGHT  -- BUDGET EXHAUSTED`));
  else if (stopping || lastAborted) console.log(chalk.bold.yellow(`  CLAUDE OVERNIGHT  -- INTERRUPTED`));
  else console.log(chalk.bold.yellow(`  CLAUDE OVERNIGHT  -- STOPPED`));
  console.log(chalk.green(`  ${bannerChar.repeat(Math.min(termW - 4, 60))}`));
  console.log("");

  const statRows = [
    [chalk.bold("Waves"), String(waves), chalk.bold("Sessions"), `${accCompleted} done${accFailed > 0 ? ` / ${accFailed} failed` : ""}${remaining > 0 ? ` (${remaining} remaining)` : ""}`],
    [chalk.bold("Cost"), chalk.green(`$${accCost.toFixed(2)}`), chalk.bold("Elapsed"), elapsedStr],
    [chalk.bold("Merged"), `${totalMerged} branches`, chalk.bold("Conflicts"), totalConflicts > 0 ? chalk.red(String(totalConflicts)) : chalk.green("0")],
    [chalk.bold("Tokens"), `${fmtTokens(accIn)} in / ${fmtTokens(accOut)} out`, chalk.bold("Tool calls"), String(accTools)],
  ];
  for (const [k1, v1, k2, v2] of statRows) console.log(`  ${k1}  ${v1.padEnd(20)}  ${k2}  ${v2}`);
  if (lastCapped) console.log(`  ${chalk.yellow(`Overage budget exhausted`)}`);
  console.log("");

  const statusFile = join(runDir, "status.md");
  try {
    const statusContent = readFileSync(statusFile, "utf-8").trim();
    if (statusContent) {
      console.log(chalk.dim(`  ${"─".repeat(Math.min(termW - 4, 60))}`));
      console.log(chalk.bold("  Status"));
      console.log("");
      for (const line of statusContent.split("\n")) console.log(`  ${line}`);
      console.log("");
    }
  } catch {}

  if (totalConflicts > 0) {
    console.log(chalk.dim(`  ${"─".repeat(Math.min(termW - 4, 60))}`));
    const conflictBranches = branches.filter(b => b.status === "merge-failed");
    console.log(chalk.red(`  Unresolved conflicts:`));
    for (const c of conflictBranches) console.log(chalk.red(`    ${c.branch}`));
    console.log(chalk.dim("  git merge <branch> to resolve"));
    console.log("");
  }

  console.log(chalk.dim(`  ${"─".repeat(Math.min(termW - 4, 60))}`));
  if (runBranch) console.log(chalk.dim(`  Branch: ${runBranch}  -- git merge ${runBranch}`));
  console.log(chalk.dim(`  Run: ${runDir}`));
  if (currentSwarm?.logFile) console.log(chalk.dim(`  Log: ${currentSwarm.logFile}`));
  console.log("");

  if (accFailed > 0) process.exit(1);
  if (lastAborted || accCompleted === 0) process.exit(2);
}

// ── Review helpers: post-wave and post-run quality gates ──

interface ReviewOpts {
  cwd: string;
  plannerModel: string;
  permissionMode: PermMode;
  concurrency: number;
  remaining: number;
  usageCap: number | undefined;
  allowExtraUsage: boolean;
  extraUsageBudget: number | undefined;
  baseCostUsd: number;
  envForModel: ((model?: string) => Record<string, string> | undefined) | undefined;
  mergeStrategy: MergeStrategy;
  useWorktrees: boolean;
}

interface ReviewResult {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  completed: number;
  failed: number;
}

function reviewPrompt(scope: "wave" | "run", objective?: string): string {
  const scopeLine = scope === "wave"
    ? "You are reviewing all changes made in the most recent wave of agent work."
    : `You are the final quality gate before this autonomous run completes.\n\nThe objective was: ${objective || "improve the codebase"}`;
  const diffCmd = scope === "wave"
    ? "Run `git diff` to see what changed."
    : "Run `git diff main` (or `git diff HEAD` if on the same branch) to see ALL changes made during this run.";
  const checks = scope === "wave"
    ? `1. **Missed reuse**: Did any agent write something that already exists elsewhere? Find existing utilities and suggest replacements.
2. **Quality issues**: Redundant state, copy-paste variations, leaky abstractions, stringly-typed code where enums exist, unnecessary JSX nesting, comments that narrate what the code does.
3. **Efficiency problems**: Redundant computations, sequential operations that could be parallel, hot-path bloat, recurring no-op updates, TOCTOU patterns, memory leaks.
4. **Merge conflicts or inconsistencies**: Changes that work against each other or break existing patterns.`
    : `1. **Architecture coherence**: Do the changes form a coherent whole, or are they a patchwork of independent edits that don't fit together?
2. **Missed reuse**: Any new code that duplicates existing functionality?
3. **Quality**: Redundant state, copy-paste variations, leaky abstractions, stringly-typed code, unnecessary nesting, narrative comments.
4. **Efficiency**: N+1 patterns, redundant computations, hot-path bloat, missing cleanup, unbounded data structures.
5. **Consistency**: Do all changes follow the project's existing patterns, conventions, and design system?
6. **Build and test**: Run the build and any existing tests. Fix any breakage.`;
  const close = scope === "wave"
    ? "Fix issues directly. Delete and simplify rather than add. If the code is already clean, skip."
    : "Fix issues directly. Delete and simplify. If the codebase is clean and the build passes, say so.";

  return `${scopeLine}

${diffCmd} Review for:

${checks}

${close}

No need to explain your changes  -- just fix them.`;
}

async function runReview(opts: ReviewOpts, scope: "wave" | "run", objective?: string): Promise<ReviewResult | null> {
  const swarm = new Swarm({
    tasks: [{ id: `${scope}-review`, prompt: reviewPrompt(scope, objective), noWorktree: false }],
    concurrency: 1, cwd: opts.cwd, model: opts.plannerModel, permissionMode: opts.permissionMode,
    useWorktrees: opts.useWorktrees, mergeStrategy: opts.mergeStrategy, usageCap: opts.usageCap,
    allowExtraUsage: opts.allowExtraUsage, extraUsageBudget: opts.extraUsageBudget,
    baseCostUsd: opts.baseCostUsd, envForModel: opts.envForModel,
  });
  try {
    await swarm.run();
    return { costUsd: swarm.totalCostUsd, inputTokens: swarm.totalInputTokens, outputTokens: swarm.totalOutputTokens, completed: swarm.completed, failed: swarm.failed };
  } catch { return null; }
}

async function runPostWaveReview(opts: ReviewOpts): Promise<ReviewResult | null> {
  return runReview(opts, "wave");
}

async function runPostRunReview(
  objective: string, opts: ReviewOpts,
): Promise<ReviewResult | null> {
  return runReview(opts, "run", objective);
}

async function promptBudgetExtension(ctx: {
  estimate: number | undefined;
  spent: number;
  sessionsUsed: number;
  budget: number;
}): Promise<number> {
  const avg = ctx.sessionsUsed > 0 ? ctx.spent / ctx.sessionsUsed : 0;
  const base = ctx.estimate && ctx.estimate > 0
    ? ctx.estimate
    : Math.max(10, Math.round(ctx.budget * 0.2));
  // Wiggle room: 30% buffer, minimum 10, rounded up to a nearest-5.
  const withBuffer = Math.max(10, Math.ceil(base * 1.3));
  const suggested = Math.ceil(withBuffer / 5) * 5;
  const estCost = avg > 0 ? ` · ~$${(suggested * avg).toFixed(2)}` : "";
  const estLine = ctx.estimate != null
    ? chalk.dim(`  Planner estimate: ${ctx.estimate} sessions to complete${avg > 0 ? ` (~$${(ctx.estimate * avg).toFixed(2)} at $${avg.toFixed(2)}/session)` : ""}`)
    : chalk.dim(`  No planner estimate available  -- using default${avg > 0 ? ` (~$${avg.toFixed(2)}/session)` : ""}`);
  console.log("");
  console.log(chalk.yellow(`  Budget exhausted  -- run not yet complete.`));
  console.log(estLine);
  console.log(chalk.dim(`  Continue with ${chalk.bold.white(String(suggested))} more sessions${estCost}? Everything stays the same  -- just hit enter.`));
  const action = await selectKey("", [
    { key: "y", desc: "es (↵)" },
    { key: "c", desc: "ustom" },
    { key: "n", desc: "o  -- stop here" },
  ]);
  if (action === "y") return suggested;
  if (action === "n") return 0;
  const custom = await ask(`  How many more sessions? ${chalk.dim(`[${suggested}]: `)}`);
  const n = parseInt(custom);
  if (isNaN(n) || n <= 0) return suggested;
  return n;
}

function checkProjectHealth(cwd: string): Task | undefined {
  let pkg: any;
  try { pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8")); } catch { return undefined; }
  const scripts = pkg.scripts || {};
  let scriptName: string | undefined;
  for (const name of ["typecheck", "check:types", "type-check", "build"]) {
    if (scripts[name]) { scriptName = name; break; }
  }
  if (!scriptName) return undefined;
  const pm = existsSync(join(cwd, "pnpm-lock.yaml")) ? "pnpm"
    : existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock")) ? "bun"
    : existsSync(join(cwd, "yarn.lock")) ? "yarn" : "npm";
  const cmd = `${pm} run ${scriptName}`;
  try {
    execSync(cmd, { cwd, encoding: "utf-8", stdio: "pipe", timeout: 60_000 });
    return undefined;
  } catch (err: any) {
    if (err.killed) return undefined;
    const output = ((err.stdout || "") + "\n" + (err.stderr || "")).trim();
    const trimmed = output.length > 4000 ? output.slice(0, 2000) + "\n…\n" + output.slice(-2000) : output;
    return {
      id: "heal-0",
      prompt: `Fix the broken build. \`${cmd}\` fails after merging parallel work:\n\`\`\`\n${trimmed}\n\`\`\`\nFix every error. Run \`${cmd}\` when done to verify.`,
    };
  }
}

// ── Pre-wave rate limit gate ──

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

interface ThrottleRLInfo {
  utilization: number;
  windows: Map<string, { type: string; utilization: number; status: string; resetsAt?: number }>;
  resetsAt?: number;
}

/**
 * Proactive rate-limit gate called before spawning a new wave. Prevents
 * starting a batch of agents when the API is already near or at a limit,
 * which would waste sessions on instant rejections.
 *
 * Thresholds:
 *   - any window rejected → wait until resetsAt (or 60s fallback)
 *   - utilization >= 90% → wait 60s
 *   - utilization >= 75% → wait 15s
 */
async function throttleBeforeWave(
  getRL: () => ThrottleRLInfo,
  log: (text: string) => void,
  shouldStop: () => boolean,
): Promise<void> {
  const MAX_ATTEMPTS = 4;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (shouldStop()) return;

    const rl = getRL();
    // Check for rejected windows
    let rejectedReset: number | undefined;
    for (const w of rl.windows.values()) {
      if (w.status === "rejected" && w.resetsAt && w.resetsAt > Date.now()) {
        if (!rejectedReset || w.resetsAt < rejectedReset) rejectedReset = w.resetsAt;
      }
    }

    const highUtil = rl.utilization >= 0.9;
    const elevatedUtil = rl.utilization >= 0.75;
    const explicitRejected = rl.resetsAt && rl.resetsAt > Date.now();

    if (!rejectedReset && !explicitRejected && !highUtil && !elevatedUtil) return;

    const waitMs = rejectedReset
      ? Math.max(10_000, rejectedReset - Date.now())
      : explicitRejected
        ? Math.max(10_000, rl.resetsAt! - Date.now())
        : highUtil
          ? 60_000 * (1 + attempt)
          : 15_000;

    const reason = rejectedReset ? `Rate limit window blocked`
      : explicitRejected ? "Rate limited"
      : `Utilization ${Math.round(rl.utilization * 100)}%`;
    log(`${reason}  -- waiting ${Math.ceil(waitMs / 1000)}s before wave${attempt > 0 ? ` (attempt ${attempt + 1})` : ""}`);
    await sleep(waitMs);
  }
  // Exhausted attempts — proceed anyway, swarm's internal retry will handle rejections.
}
