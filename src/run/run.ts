import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import chalk from "chalk";
import type { Task, PermMode, MergeStrategy, RunState, RunConfigBase, BranchRecord, WaveSummary, RunMemory } from "../core/types.js";
import { Swarm } from "../swarm/swarm.js";
import { steerWave, STEER_SCHEMA } from "../planner/steering.js";
import { getTotalPlannerCost, getPlannerRateLimitInfo, getPeakPlannerContext, runPlannerQuery, setPlannerEnvResolver, attemptJsonParse } from "../planner/planner-query.js";
import { contextFillInfo } from "../ui/render.js";
import { getModelCapability } from "../core/models.js";
import type { ProviderConfig } from "../providers/index.js";
import { buildEnvResolver, isCursorProxyProvider } from "../providers/index.js";
import { RunDisplay } from "../ui/ui.js";
import type { LiveConfig, RunInfo, SteeringContext } from "../ui/ui.js";
import type { PlannerLog } from "../planner/planner-query.js";
import { renderSummary } from "../ui/render.js";
import { fmtTokens } from "../ui/render.js";
import { isJWTAuthError } from "../core/auth.js";
import { selectKey, ask } from "../cli/cli.js";
import {
  readRunMemory, writeStatus, writeGoalUpdate, saveRunState,
  saveWaveSession, loadWaveHistory, recordBranches, archiveMilestone,
  writeSteerInbox, consumeSteerInbox, countSteerInbox,
  appendOvernightLogStart, updateOvernightLogEnd,
} from "../state/state.js";

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
  /** Original raw objective before the setup coach rewrote it. */
  coachedObjective?: string;
  /** Unix timestamp (ms) when the coach produced the accepted rewrite. */
  coachedAt?: number;
}

export async function executeRun(cfg: RunConfig): Promise<void> {
  const restore = () => { try { process.stdout.write("\x1B[?25h\n"); } catch {} };
  const { objective, cwd, allowedTools, beforeWave: beforeWaveCmds, afterWave: afterWaveCmds, afterRun: afterRunCmds, runDir, previousKnowledge } = cfg;
  let { workerModel, plannerModel, fastModel, concurrency, permissionMode } = cfg;

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
    workerModel, plannerModel, fastModel, permissionMode,
  };
  let waveNum: number;
  const waveHistory: WaveSummary[] = [];
  let accCost: number, accCompleted: number, accFailed: number, accTools: number;
  let accIn = 0, accOut = 0;
  let peakWorkerCtxPct = 0, peakWorkerCtxTokens = 0;
  let lastCapped = false, lastAborted = false, objectiveComplete = false;
  let lastEstimate: number | undefined;
  const branches: BranchRecord[] = [];
  let healFailStreak = 0; // consecutive waves where heal-0 agent changed 0 files
  let zeroFileWaves = 0; // consecutive waves with 0 files across non-heal tasks

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
    const prompt = `${label}\n\n${ctx}\n\nWrite one short sentence (max 180 chars) summarising progress and what's next. No preamble.`;
    // Show in-flight feedback so the panel isn't empty while the planner thinks.
    display.setDebrief(`Summarizing ${label.toLowerCase().replace(/\.$/, "")}\u2026`);
    void runPlannerQuery(prompt, { cwd, model: debriefModel, permissionMode }, () => {})
      .then(text => { display.setDebrief(text.trim().slice(0, 210), label); })
      .catch(() => { display.setDebrief(undefined); });
  };

  /** Generate a longer narrative summary at run end. Awaited (not fire-and-forget)
   *  because the caller wants the text inline in the final status block. */
  const generateFinalNarrative = async (phase: string): Promise<string> => {
    const debriefModel = fastModel || workerModel;
    const memory = readRunMemory(runDir, previousKnowledge || undefined);
    const cap = (s: string, n: number) => s && s.length > n ? s.slice(0, n) + "…" : (s || "");
    const ctx = [
      objective ? `Objective: ${objective}` : "",
      memory.goal ? `Goal:\n${cap(memory.goal, 1200)}` : "",
      memory.status ? `Status:\n${cap(memory.status, 1200)}` : "",
      waveHistory.length ? `Waves completed: ${waveHistory.length}` : "",
      memory.reflections ? `Reflections:\n${cap(memory.reflections, 800)}` : "",
      memory.verifications ? `Verifications:\n${cap(memory.verifications, 800)}` : "",
    ].filter(Boolean).join("\n\n");
    const prompt = `The autonomous run just ended. Final phase: ${phase}.\n\n${ctx}\n\nWrite 3–5 plain sentences for the user: what was accomplished, what's still open, and any follow-ups they should do manually. No bullet points, no preamble, no markdown headers.`;
    try {
      const text = await runPlannerQuery(prompt, { cwd, model: debriefModel, permissionMode }, () => {});
      return text.trim();
    } catch {
      return "";
    }
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
    coachedObjective: cfg.coachedObjective,
    coachedAt: cfg.coachedAt,
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

    // ── B1: Skip steering when ≥2 unresolved merge-failed branches exist ──
    const mergeFailedBranches = branches.filter(b => b.status === "merge-failed");
    if (mergeFailedBranches.length >= 2) {
      currentTasks = mergeFailedBranches.map((b, i) => ({
        id: `branch-retry-${i}`,
        prompt: `Your previous attempt at this task merge-failed against main. Redo it against the current state of main with minimal, focused edits. Original task:\n\n${b.taskPrompt}`,
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
        if (appliedGuidance) display.appendSteeringEvent(`User directives applied: ${appliedGuidance.slice(0, 80)}`);
        const steer = await steerWave(
          objective!, waveHistory, remaining, cwd, plannerModel, workerModel, fastModel,
          permissionMode, concurrency, steeringLog, memory,
          `steer-wave-${waveNum}-attempt-${steerAttempts}`,
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
              noWorktree: true, model: plannerModel, type: "verify",
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
            prompt: `Your previous attempt at this task merge-failed against main. Redo it against the current state of main with minimal, focused edits. Original task:\n\n${b.taskPrompt}`,
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
          try { statusText = readFileSync(join(runDir, "status.md"), "utf-8"); } catch {}
          const minimalPrompt = `${objective ? `Objective: ${objective}` : ""}\n\nStatus:\n${statusText || "(none)"}\n\nReturn tasks: string[] — 3-6 specific follow-ups. JSON only. {"tasks":[{"prompt":"..."}]}`;
          const minimalText = await runPlannerQuery(minimalPrompt, { cwd, model: plannerModel, permissionMode, outputFormat: STEER_SCHEMA, transcriptName: "decomposer-minimal", maxTurns: 40 }, () => {});
          const parsed = attemptJsonParse(minimalText);
          if (parsed?.tasks?.length > 0) {
            currentTasks = parsed.tasks.map((t: any, i: number) => ({
              id: `decompose-${i}`,
              prompt: typeof t === "string" ? t : t.prompt,
              model: workerModel,
            }));
            display.appendSteeringEvent(`Decomposer: ${currentTasks.length} tasks from minimal planner`);
            steered = true;
            break;
          }
        } catch {}

        // Finally: halt
        display.appendSteeringEvent(`Decomposer: no tasks produced — halting`);
        return false;
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
    // Health check before each wave: a broken build poisons every subsequent
    // agent context, so prepend a heal task when detected. Steering-planned
    // tasks still run, just after the build is green again.
    // Skip if prior heal changed 0 files (heal unable to fix).
    {
      const healTasks = healFailStreak > 0 ? [] : checkProjectHealth(cwd);
      if (healTasks.length > 0 && remaining > 0) {
        const healIds = healTasks.map(t => t.id);
        const withoutDup = currentTasks.filter(t => !healIds.includes(t.id));
        currentTasks = [...healTasks, ...withoutDup];
        display.appendSteeringEvent(`Health check: build broken — queued ${healTasks.length} heal task(s)`);
      } else if (healTasks.length === 0 && healFailStreak > 0 && checkProjectHealth(cwd).length > 0) {
        display.appendSteeringEvent(`Health check: build broken — heal skipped after ${healFailStreak} failed attempts, needs manual intervention`);
        try {
          const statusPath2 = join(runDir, "status.md");
          const existing2 = existsSync(statusPath2) ? readFileSync(statusPath2, "utf-8") : "";
          const marker = "## Heal blocked";
          if (!existing2.includes(marker)) {
            writeFileSync(statusPath2, `${existing2}${existing2 ? "\n\n" : ""}${marker}\nBuild has been broken for ${healFailStreak} waves, heal agents unable to fix — intervene manually.\n`, "utf-8");
          }
        } catch {}
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

    // Retry execute tasks that returned filesChanged=0 OR whose postcondition
    // shell-check failed after merge. One retry with a nudge that includes the
    // failure output; if still failing, fail loudly so steering re-plans.
    if (!swarm.aborted && !swarm.cappedOut && remaining > 0) {
      const failedBranches = new Set(swarm.mergeResults.filter(r => !r.ok).map(r => r.branch));
      const postResults = new Map<number, { ok: boolean; output: string }>();
      for (const a of swarm.agents) {
        if (a.status !== "done" || !a.task.postcondition) continue;
        if (a.branch && failedBranches.has(a.branch)) continue; // merge-failed: postcondition can't pass on main anyway
        try {
          const out = execSync(a.task.postcondition, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
          postResults.set(a.id, { ok: true, output: out.trim().slice(0, 400) });
        } catch (err: any) {
          const output = ((err.stderr || "") + "\n" + (err.stdout || err.message || "")).trim().slice(0, 400);
          postResults.set(a.id, { ok: false, output });
        }
      }
      const zeroWork = swarm.agents.filter(a => {
        if (a.status !== "done" || (a.task.type && a.task.type !== "execute")) return false;
        if ((a.filesChanged ?? 0) === 0) return true;
        const pr = postResults.get(a.id);
        return pr && !pr.ok;
      });
      if (zeroWork.length > 0) {
        const noFiles = zeroWork.filter(a => (a.filesChanged ?? 0) === 0).length;
        const badPost = zeroWork.length - noFiles;
        display.appendSteeringEvent(`Retry: ${zeroWork.length} task(s) (${noFiles} with 0 files, ${badPost} failed postcondition)`);
        const retryTasks = zeroWork.map(a => {
          const pr = postResults.get(a.id);
          const postFailBlock = pr && !pr.ok
            ? `\n\nThe postcondition \`${a.task.postcondition}\` failed after your last attempt:\n${pr.output || "(no output)"}\n\nFix what makes the check fail and try again.`
            : `\n\nIMPORTANT: your last attempt made no file edits. If the fix truly needs no changes, say 'no-op:' at the start and explain why. Otherwise, make the actual edits.`;
          return {
            id: `${a.task.id}-retry`,
            prompt: `${a.task.prompt}${postFailBlock}`,
            type: "execute" as const,
            postcondition: a.task.postcondition,
          };
        });
        const retrySwarm = new Swarm({
          tasks: retryTasks, concurrency: Math.min(concurrency, retryTasks.length), cwd, model: workerModel,
          permissionMode, allowedTools, useWorktrees, mergeStrategy: waveMerge,
          agentTimeoutMs: cfg.agentTimeoutMs, usageCap, allowExtraUsage: cfg.allowExtraUsage,
          extraUsageBudget: cfg.extraUsageBudget, baseCostUsd: accCost, envForModel,
          cursorProxy: [cfg.workerProvider, cfg.plannerProvider, cfg.fastProvider].some(p => p && isCursorProxyProvider(p)),
        });
        currentSwarm = retrySwarm;
        display.setWave(retrySwarm);
        display.resume();
        try { await retrySwarm.run(); } catch {}
        display.pause();

        // Fold retry stats into main counters
        accIn += retrySwarm.totalInputTokens; accOut += retrySwarm.totalOutputTokens;
        accTools += retrySwarm.agents.reduce((sum, a) => sum + a.toolCalls, 0);

        // Any retry that still has 0 files OR a still-failing postcondition → hard fail
        const retryFailedBranches = new Set(retrySwarm.mergeResults.filter(r => !r.ok).map(r => r.branch));
        const stillZero = retrySwarm.agents.filter(a => {
          if (a.status !== "done") return false;
          if ((a.filesChanged ?? 0) === 0) return true;
          if (!a.task.postcondition) return false;
          if (a.branch && retryFailedBranches.has(a.branch)) return true;
          try { execSync(a.task.postcondition, { cwd, stdio: "ignore", timeout: 30_000 }); return false; }
          catch { return true; }
        });
        for (const a of stillZero) {
          const why = (a.filesChanged ?? 0) === 0 ? "still changed 0 files" : "postcondition still failing";
          display.appendSteeringEvent(`RETRY FAILED: agent ${a.id} ${why} — task dropped as error`);
          a.error = a.error ?? `retry failed: ${why}`;
          accFailed++;
          remaining = Math.max(0, remaining - 1);
        }
        accCompleted += retrySwarm.completed;
        remaining = Math.max(0, remaining - retrySwarm.completed);

        // Merge retry agents into the main swarm's agent list so they're
        // included in the wave summary.
        swarm.agents.push(...retrySwarm.agents);
        swarm.completed += retrySwarm.completed;
        swarm.failed += stillZero.length;
        swarm.totalCostUsd += retrySwarm.totalCostUsd;
        swarm.totalInputTokens += retrySwarm.totalInputTokens;
        swarm.totalOutputTokens += retrySwarm.totalOutputTokens;
        liveConfig.remaining = remaining;
      }
    }

    accCost += swarm.totalCostUsd; accIn += swarm.totalInputTokens; accOut += swarm.totalOutputTokens;
    accCompleted += swarm.completed; accFailed += swarm.failed;
    accTools += swarm.agents.reduce((sum, a) => sum + a.toolCalls, 0);
    for (const a of swarm.agents) {
      const tok = a.peakContextTokens ?? a.contextTokens ?? 0;
      if (tok <= 0) continue;
      const mdl = a.task.model || swarm.model || "unknown";
      const safe = getModelCapability(mdl).safeContext;
      const { pct } = contextFillInfo(tok, safe);
      if (pct > peakWorkerCtxPct) { peakWorkerCtxPct = pct; peakWorkerCtxTokens = tok; }
    }
    remaining = Math.max(0, remaining - swarm.completed - swarm.failed);
    const totalConsumed = accCompleted + accFailed + cfg.thinkingUsed;
    const expectedFloor = Math.max(0, cfg.budget - totalConsumed);
    if (remaining < expectedFloor) remaining = expectedFloor;
    if (liveConfig.dirty) {
      remaining = liveConfig.remaining;
      usageCap = liveConfig.usageCap;
      cfg.extraUsageBudget = liveConfig.extraUsageBudget;
      if (liveConfig.workerModel) workerModel = liveConfig.workerModel;
      if (liveConfig.plannerModel) plannerModel = liveConfig.plannerModel;
      if (liveConfig.fastModel !== undefined) fastModel = liveConfig.fastModel;
      if (liveConfig.permissionMode) permissionMode = liveConfig.permissionMode;
      concurrency = liveConfig.concurrency;
      liveConfig.dirty = false;
    }
    liveConfig.remaining = remaining;
    lastCapped = swarm.cappedOut; lastAborted = swarm.aborted;
    recordBranches(swarm.agents, swarm.mergeResults, branches, waveNum);
    saveWaveSession(runDir, waveNum, swarm.agents, swarm.totalCostUsd);
    // Tasks that never made it into the swarm (queue cleared on abort/cap)
    // are preserved as currentTasks so resume picks them up. Budget for these
    // wasn't decremented (only attempted agents were), so no refund needed.
    const attemptedPrompts = new Set(swarm.agents.map(a => a.task.prompt));
    const neverStarted = currentTasks.filter(t => !attemptedPrompts.has(t.prompt));
    saveRunState(runDir, buildRunState({ remaining, phase: "steering", currentTasks: neverStarted }));

    // Overlay merge outcomes: if an agent's branch failed to merge, its changes
    // did NOT land — tell steering the truth (filesChanged=0, error attached)
    // so it can't declare victory on work that didn't reach the codebase.
    const failedMergeBranches = new Set(swarm.mergeResults.filter(r => !r.ok).map(r => r.branch));
    waveHistory.push({
      wave: waveNum,
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

    // Track heal fail streak: if a heal-0 task existed this wave and changed 0 files, increment.
    // If any non-heal execute task changed files, reset.
    const lastWave = waveHistory[waveHistory.length - 1];
    const healTask = lastWave?.tasks.find(t => t.type === "heal");
    if (healTask && !healTask.filesChanged) {
      healFailStreak++;
    } else if (lastWave?.tasks.some(t => (t.type !== "heal") && (t.filesChanged ?? 0) > 0)) {
      healFailStreak = 0;
    }

    // C1: Circuit breaker — halt after 2 consecutive waves with 0 files across non-heal tasks
    const nonHealFiles = lastWave?.tasks.filter(t => t.type !== "heal").reduce((sum, t) => sum + (t.filesChanged ?? 0), 0) ?? 0;
    if (nonHealFiles === 0 && waveNum > 0) {
      zeroFileWaves++;
      if (zeroFileWaves >= 2) {
        display.appendSteeringEvent(`Circuit breaker: 2 consecutive waves produced no merged changes — halting to prevent budget drain`);
        display.stop();
        saveRunState(runDir, buildRunState({ remaining, phase: "stopped", currentTasks: [] }));
        display.stop(); restore();
        console.log(chalk.red(`\n  Circuit breaker: 2 consecutive waves produced no merged changes.`));
        console.log(chalk.red(`  Halting to prevent budget drain. Run preserved at ${runDir}.`));
        process.exit(3);
      }
    } else {
      zeroFileWaves = 0;
    }

    // Hook-blocked work: agents that touched files but nothing landed on the
    // branch (pre-commit hooks, gitignore, writes outside worktree). Surface
    // as a wave-level warning so steering sees it, not just a per-agent log.
    const hookBlocked = swarm.agents.filter(a =>
      swarm.logs.some(l => l.agentId === a.id && l.text.includes("did NOT land"))
    );
    if (hookBlocked.length > 0) {
      const msg = `⚠ ${hookBlocked.length} agent(s) touched files that didn't land — check hooks/gitignore/absolute paths`;
      display.appendSteeringEvent(msg);
      // Append to status.md so steering reads it on the next wave
      try {
        const existing = readFileSync(join(runDir, "status.md"), "utf-8");
        if (!existing.includes(msg)) {
          writeFileSync(join(runDir, "status.md"), existing + `\n\n${msg}`, "utf-8");
        }
      } catch {}
    }

    // Merge-failed branches: changes never reached the codebase. Regenerate a
    // pinned section in status.md every wave from live git state — resolved
    // branches (deleted from git) drop off automatically; still-broken ones
    // keep shouting at steering until a follow-up wave lands them or discards
    // them. This is what turns merge-failed from a silent state into a
    // first-class blocker.
    try {
      const unresolved = branches.filter(b => {
        if (b.status !== "merge-failed") return false;
        try { execSync(`git rev-parse --verify "${b.branch}"`, { cwd, stdio: "ignore" }); return true; }
        catch { return false; } // branch gone → treat as resolved
      });
      const statusPath = join(runDir, "status.md");
      const existing = existsSync(statusPath) ? readFileSync(statusPath, "utf-8") : "";
      const marker = "## Unresolved merge failures";
      const idx = existing.indexOf(marker);
      const base = idx >= 0 ? existing.slice(0, idx).replace(/\n+$/, "") : existing;
      let next = base;
      if (unresolved.length > 0) {
        const list = unresolved.map(b => `  - ${b.branch} — ${b.taskPrompt.slice(0, 120)}`).join("\n");
        next = `${base}${base ? "\n\n" : ""}${marker}\n${unresolved.length} branch(es) contain unmerged agent work. Resolve or discard before relying on those changes:\n${list}\n`;
        display.appendSteeringEvent(`⚠ ${unresolved.length} unresolved merge failure(s) — see status.md`);
      }
      if (next !== existing) writeFileSync(statusPath, next, "utf-8");

      // GC ghost branches: delete merge-failed branches ≥2 waves old and mark discarded.
      // Safe: their work never landed. The decomposer (Phase B) will re-attempt from saved taskPrompt.
      const gcCandidates = branches.filter(b =>
        b.status === "merge-failed" && b.firstFailedWave !== undefined && (waveNum - b.firstFailedWave) >= 2
      );
      let gcCount = 0;
      for (const b of gcCandidates) {
        try { execSync(`git branch -D "${b.branch}"`, { cwd, stdio: "ignore" }); } catch {}
        b.status = "discarded";
        gcCount++;
      }
      if (gcCount > 0) display.appendSteeringEvent(`GC: discarded ${gcCount} ghost branch(es) ≥2 waves old`);
    } catch {}

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
      display.appendSteeringEvent(`Review: scanning wave ${waveNum + 1} diff\u2026`);
      const reviewResult = await runPostWaveReview({
        cwd, plannerModel, permissionMode, concurrency,
        remaining, usageCap, allowExtraUsage: cfg.allowExtraUsage,
        extraUsageBudget: cfg.extraUsageBudget, baseCostUsd: accCost,
        envForModel, mergeStrategy: waveMerge, useWorktrees,
      }, (reviewSwarm) => {
        // Show the review agent live so the long wait isn't silent.
        currentSwarm = reviewSwarm;
        display.setWave(reviewSwarm);
        display.resume();
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
  // This can take several minutes — keep the display alive so the user sees the
  // review agent working in real time instead of staring at a frozen terminal.
  if (flex && remaining > 0 && waveNum > 0) {
    console.log(chalk.dim(`\n  Final review: scanning full run diff\u2026`));
    display.start();
    const finalReview = await runPostRunReview(
      objective || "", {
        cwd, plannerModel, permissionMode, concurrency,
        remaining, usageCap, allowExtraUsage: cfg.allowExtraUsage,
        extraUsageBudget: cfg.extraUsageBudget, baseCostUsd: accCost,
        envForModel, mergeStrategy: waveMerge, useWorktrees,
      },
      (reviewSwarm) => {
        currentSwarm = reviewSwarm;
        display.setWave(reviewSwarm);
        display.resume();
      },
    );
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
  const rule = (c = "─") => chalk.dim(`  ${c.repeat(Math.min(termW - 4, 60))}`);

  // Generate the long-form debrief inline — the user sees a spinner while it
  // runs, then the narrative is printed as part of the final status block.
  const phaseWord = trulyDone ? "complete"
    : remaining <= 0 || lastCapped ? "budget exhausted"
    : stopping || lastAborted ? "interrupted"
    : "stopped";
  process.stdout.write(chalk.dim(`\n  Writing final summary…`));
  const narrative = await generateFinalNarrative(phaseWord);
  process.stdout.write("\r" + " ".repeat(40) + "\r");

  console.log("");
  const bannerChar = accFailed === 0 ? "━" : "─";
  const bannerColor = trulyDone ? chalk.green : (stopping || lastAborted) ? chalk.yellow : chalk.magenta;
  console.log(bannerColor(`  ${bannerChar.repeat(Math.min(termW - 4, 60))}`));
  if (trulyDone) console.log(chalk.bold.green(`  ✓ CLAUDE OVERNIGHT  -- COMPLETE`));
  else if (remaining <= 0 || lastCapped) console.log(chalk.bold.yellow(`  ⚠ CLAUDE OVERNIGHT  -- BUDGET EXHAUSTED`));
  else if (stopping || lastAborted) console.log(chalk.bold.yellow(`  ⚠ CLAUDE OVERNIGHT  -- INTERRUPTED`));
  else console.log(chalk.bold.yellow(`  ⚠ CLAUDE OVERNIGHT  -- STOPPED`));
  console.log(bannerColor(`  ${bannerChar.repeat(Math.min(termW - 4, 60))}`));
  console.log("");

  if (objective) {
    console.log(chalk.bold("  Objective"));
    const objWrapped = objective.replace(/\s+/g, " ").trim();
    const objW = Math.min(termW - 6, 76);
    for (let i = 0; i < objWrapped.length; i += objW) console.log(`  ${objWrapped.slice(i, i + objW)}`);
    console.log("");
  }

  if (narrative) {
    console.log(chalk.bold("  What happened"));
    const narrW = Math.min(termW - 6, 76);
    for (const para of narrative.split(/\n\n+/)) {
      const clean = para.replace(/\s+/g, " ").trim();
      if (!clean) continue;
      for (let i = 0; i < clean.length; i += narrW) console.log(`  ${clean.slice(i, i + narrW)}`);
      console.log("");
    }
  }

  const peakPlanner = getPeakPlannerContext();
  const plannerSafe = peakPlanner.model ? getModelCapability(peakPlanner.model).safeContext : 0;
  const plannerPct = plannerSafe > 0 && peakPlanner.tokens > 0 ? Math.round((peakPlanner.tokens / plannerSafe) * 100) : 0;
  const colorByPct = (pct: number) => pct > 80 ? chalk.red : pct > 50 ? chalk.yellow : chalk.green;
  const fmtCtx = (tok: number, pct: number): string => {
    if (tok <= 0) return chalk.dim("—");
    return colorByPct(pct)(`${fmtTokens(tok)} (${pct}%)`);
  };
  console.log(rule());
  console.log(chalk.bold("  Stats"));
  console.log("");
  const statRows = [
    [chalk.bold("Waves"), String(waves), chalk.bold("Sessions"), `${accCompleted} done${accFailed > 0 ? ` / ${accFailed} failed` : ""}${remaining > 0 ? ` (${remaining} remaining)` : ""}`],
    [chalk.bold("Cost"), chalk.green(`$${accCost.toFixed(2)}`), chalk.bold("Elapsed"), elapsedStr],
    [chalk.bold("Merged"), `${totalMerged} branches`, chalk.bold("Conflicts"), totalConflicts > 0 ? chalk.red(String(totalConflicts)) : chalk.green("0")],
    [chalk.bold("Tokens"), `${fmtTokens(accIn)} in / ${fmtTokens(accOut)} out`, chalk.bold("Tool calls"), String(accTools)],
    [chalk.bold("Peak ctx"), `worker ${fmtCtx(peakWorkerCtxTokens, peakWorkerCtxPct)}`, chalk.bold(""), `planner ${fmtCtx(peakPlanner.tokens, plannerPct)}`],
  ];
  for (const [k1, v1, k2, v2] of statRows) console.log(`  ${k1}  ${v1.padEnd(20)}  ${k2}  ${v2}`);
  if (lastCapped) console.log(`  ${chalk.yellow(`Overage budget exhausted`)}`);
  console.log("");

  // Per-wave recap — a compact timeline so the user can see effort distribution at a glance.
  if (waveHistory.length > 0) {
    console.log(rule());
    console.log(chalk.bold(`  Waves  `) + chalk.dim(`(${waveHistory.length} total)`));
    console.log("");
    for (const w of waveHistory) {
      const done = w.tasks.filter(t => t.status === "done").length;
      const failed = w.tasks.filter(t => t.status === "error").length;
      const running = w.tasks.filter(t => t.status === "running").length;
      const parts: string[] = [];
      if (done) parts.push(chalk.green(`✓ ${done}`));
      if (failed) parts.push(chalk.red(`✗ ${failed}`));
      if (running) parts.push(chalk.blue(`~ ${running}`));
      if (parts.length === 0) parts.push(chalk.dim("—"));
      const head = `  ${chalk.dim(`wave ${String(w.wave + 1).padStart(2)}`)}  ${parts.join(" ")}`;
      console.log(head);
      const firstTask = w.tasks[0];
      if (firstTask) {
        const preview = firstTask.prompt.replace(/\s+/g, " ").trim().slice(0, Math.min(termW - 12, 70));
        console.log(chalk.dim(`    ${preview}${w.tasks.length > 1 ? ` (+${w.tasks.length - 1} more)` : ""}`));
      }
    }
    console.log("");
  }

  const statusFile = join(runDir, "status.md");
  try {
    const statusContent = readFileSync(statusFile, "utf-8").trim();
    if (statusContent) {
      console.log(rule());
      console.log(chalk.bold("  Status"));
      console.log("");
      for (const line of statusContent.split("\n")) console.log(`  ${line}`);
      console.log("");
    }
  } catch {}

  if (totalConflicts > 0) {
    console.log(rule());
    const conflictBranches = branches.filter(b => b.status === "merge-failed");
    console.log(chalk.red(`  Unresolved conflicts:`));
    for (const c of conflictBranches) console.log(chalk.red(`    ${c.branch}`));
    console.log(chalk.dim("  git merge <branch> to resolve"));
    console.log("");
  }

  console.log(rule());
  if (runBranch) console.log(chalk.dim(`  Branch: ${runBranch}  -- git merge ${runBranch}`));
  console.log(chalk.dim(`  Run: ${runDir}`));
  if (currentSwarm?.logFile) console.log(chalk.dim(`  Log: ${currentSwarm.logFile}`));
  console.log("");
  console.log(bannerColor(`  ${bannerChar.repeat(Math.min(termW - 4, 60))}`));
  if (trulyDone) console.log(chalk.bold.green(`  Done. Review the diff, then ship it.`));
  else if (remaining <= 0 || lastCapped) console.log(chalk.bold.yellow(`  Paused on budget. Re-run with --resume to continue.`));
  else if (stopping || lastAborted) console.log(chalk.bold.yellow(`  Interrupted. --resume to pick up where this left off.`));
  else console.log(chalk.bold.yellow(`  Stopped. --resume to continue.`));
  console.log(bannerColor(`  ${bannerChar.repeat(Math.min(termW - 4, 60))}`));
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
    ? "Review and simplify all changes from the most recent wave."
    : `You are the final quality gate before this autonomous run completes.\n\nThe objective was: ${objective || "improve the codebase"}`;

  return `${scopeLine}

Invoke the \`simplify\` skill to review changed code for reuse, quality, and efficiency, then fix any issues found.`;
}

async function runReview(
  opts: ReviewOpts,
  scope: "wave" | "run",
  objective?: string,
  onSwarm?: (swarm: Swarm) => void,
): Promise<ReviewResult | null> {
  const swarm = new Swarm({
    tasks: [{ id: `${scope}-review`, prompt: reviewPrompt(scope, objective), noWorktree: false, type: "review" }],
    concurrency: 1, cwd: opts.cwd, model: opts.plannerModel, permissionMode: opts.permissionMode,
    useWorktrees: opts.useWorktrees, mergeStrategy: opts.mergeStrategy, usageCap: opts.usageCap,
    allowExtraUsage: opts.allowExtraUsage, extraUsageBudget: opts.extraUsageBudget,
    baseCostUsd: opts.baseCostUsd, envForModel: opts.envForModel,
  });
  onSwarm?.(swarm);
  try {
    await swarm.run();
    return { costUsd: swarm.totalCostUsd, inputTokens: swarm.totalInputTokens, outputTokens: swarm.totalOutputTokens, completed: swarm.completed, failed: swarm.failed };
  } catch { return null; }
}

async function runPostWaveReview(opts: ReviewOpts, onSwarm?: (swarm: Swarm) => void): Promise<ReviewResult | null> {
  return runReview(opts, "wave", undefined, onSwarm);
}

async function runPostRunReview(
  objective: string, opts: ReviewOpts, onSwarm?: (swarm: Swarm) => void,
): Promise<ReviewResult | null> {
  return runReview(opts, "run", objective, onSwarm);
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

/** Detect build errors and return one or more heal tasks. If errors span ≥2 files,
 *  emit one task per file so they heal in parallel without merge conflicts. */
function checkProjectHealth(cwd: string): Task[] {
  const cmd = detectHealthCommand(cwd);
  if (!cmd) return [];
  try {
    execSync(cmd, { cwd, encoding: "utf-8", stdio: "pipe", timeout: 60_000 });
    return [];
  } catch (err: any) {
    if (err.killed) return [];
    const output = ((err.stdout || "") + "\n" + (err.stderr || "")).trim();
    const trimmed = output.length > 4000 ? output.slice(0, 2000) + "\n…\n" + output.slice(-2000) : output;

    // B4: Split heal by file — extract distinct source file paths from errors
    const fileRe = /\/src\/[\w./-]+\.(ts|tsx|js|jsx)/g;
    const files = new Set<string>();
    for (const m of trimmed.matchAll(fileRe)) files.add(m[0]);

    if (files.size >= 2) {
      // One task per file — each agent gets only that file's error context
      const fileErrors = new Map<string, string>();
      for (const f of files) {
        // Extract lines mentioning this file
        const lines = trimmed.split("\n").filter(l => l.includes(f));
        fileErrors.set(f, lines.slice(0, 30).join("\n"));
      }
      return Array.from(fileErrors.entries()).map(([file, errs], i) => ({
        id: `heal-${i}`,
        prompt: `Fix the broken build errors in \`${file}\`. \`${cmd}\` fails:\n\`\`\`\n${errs}\n\`\`\`\nFix every error in this file. Run \`${cmd}\` when done to verify.`,
        type: "heal",
      }));
    }

    return [{
      id: "heal-0",
      prompt: `Fix the broken build. \`${cmd}\` fails after merging parallel work:\n\`\`\`\n${trimmed}\n\`\`\`\nFix every error. Run \`${cmd}\` when done to verify.`,
      type: "heal",
    }];
  }
}

function detectHealthCommand(cwd: string): string | undefined {
  const has = (p: string) => existsSync(join(cwd, p));
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8"));
    const scripts = pkg.scripts || {};
    for (const name of ["typecheck", "check:types", "type-check", "build"]) {
      if (scripts[name]) {
        const pm = has("pnpm-lock.yaml") ? "pnpm"
          : has("bun.lockb") || has("bun.lock") ? "bun"
          : has("yarn.lock") ? "yarn" : "npm";
        return `${pm} run ${name}`;
      }
    }
  } catch {}
  if (has("tsconfig.json")) return "npx -y tsc --noEmit";
  if (has("Cargo.toml")) return "cargo check --quiet";
  if (has("go.mod")) return "go build ./...";
  if (has("deno.json") || has("deno.jsonc")) return "deno check .";
  if (has("mix.exs")) return "mix compile --warnings-as-errors";
  return undefined;
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
