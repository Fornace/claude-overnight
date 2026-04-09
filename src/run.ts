import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import chalk from "chalk";
import type { Task, PermMode, MergeStrategy, RunState, BranchRecord, WaveSummary, RunMemory } from "./types.js";
import { Swarm } from "./swarm.js";
import { steerWave } from "./steering.js";
import { getTotalPlannerCost, getPlannerRateLimitInfo, runPlannerQuery } from "./planner-query.js";
import { RunDisplay } from "./ui.js";
import type { LiveConfig, RunInfo, SteeringContext } from "./ui.js";
import type { PlannerLog } from "./planner-query.js";
import { renderSummary } from "./render.js";
import { fmtTokens } from "./render.js";
import { isAuthError } from "./cli.js";
import {
  readRunMemory, writeStatus, writeGoalUpdate, saveRunState,
  saveWaveSession, loadWaveHistory, recordBranches, archiveMilestone,
  writeSteerInbox, consumeSteerInbox, countSteerInbox,
} from "./state.js";

export interface RunConfig {
  tasks: Task[];
  objective?: string;
  budget: number;
  workerModel: string;
  plannerModel: string;
  concurrency: number;
  permissionMode: PermMode;
  useWorktrees: boolean;
  mergeStrategy: MergeStrategy;
  usageCap?: number;
  allowExtraUsage: boolean;
  extraUsageBudget?: number;
  flex: boolean;
  agentTimeoutMs?: number;
  cwd: string;
  allowedTools?: string[];
  runDir: string;
  previousKnowledge: string;
  resuming: boolean;
  resumeState?: RunState;
  thinkingUsed: number;
  thinkingCost: number;
  thinkingIn: number;
  thinkingOut: number;
  thinkingTools: number;
  thinkingHistory?: WaveSummary;
  runStartedAt: number;
}

export async function executeRun(cfg: RunConfig): Promise<void> {
  const restore = () => { try { process.stdout.write("\x1B[?25h\n"); } catch {} };
  const {
    objective, cwd, workerModel, plannerModel, concurrency, permissionMode,
    allowedTools, runDir, previousKnowledge,
  } = cfg;
  let { usageCap, flex } = cfg;
  const useWorktrees = cfg.useWorktrees;
  const mergeStrategy = cfg.mergeStrategy;

  mkdirSync(join(runDir, "reflections"), { recursive: true });
  mkdirSync(join(runDir, "milestones"), { recursive: true });
  mkdirSync(join(runDir, "sessions"), { recursive: true });

  let currentSwarm: Swarm | undefined;
  let remaining: number;
  let currentTasks: Task[];
  const liveConfig: LiveConfig = { remaining: 0, usageCap, dirty: false };
  let waveNum: number;
  const waveHistory: WaveSummary[] = [];
  let accCost: number, accCompleted: number, accFailed: number, accTools: number;
  let accIn = 0, accOut = 0;
  let lastCapped = false, lastAborted = false, objectiveComplete = false;
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
    console.log(chalk.green(`\n  ✓ Resumed`) + chalk.dim(` · wave ${waveNum + 1} · ${remaining} remaining · $${accCost.toFixed(2)} spent · ${waveHistory.length} prior waves\n`));
    waveNum++;
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
          () => { /* swallow ticker — don't clobber main status */ },
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

  let stopping = false;
  let steeringFailed = false;
  const gracefulStop = () => {
    if (stopping) { currentSwarm?.cleanup(); display.stop(); restore(); process.exit(0); }
    stopping = true;
    currentSwarm?.abort();
  };
  process.on("SIGINT", gracefulStop);
  process.on("SIGTERM", gracefulStop);
  process.on("uncaughtException", (err) => { currentSwarm?.abort(); currentSwarm?.cleanup(); display.stop(); restore(); console.error(chalk.red(`\n  Uncaught: ${err.message}`)); process.exit(1); });
  process.on("unhandledRejection", (reason) => { currentSwarm?.abort(); currentSwarm?.cleanup(); display.stop(); restore(); console.error(chalk.red(`\n  Unhandled: ${reason instanceof Error ? reason.message : reason}`)); process.exit(1); });

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
          objective!, waveHistory, remaining, cwd, plannerModel, workerModel,
          permissionMode, concurrency, steeringLog, memory,
        );
        accCost += getTotalPlannerCost() - plannerCostBefore;
        syncRunInfo();

        if (steer.statusUpdate) writeStatus(runDir, steer.statusUpdate);
        if (steer.goalUpdate) writeGoalUpdate(runDir, steer.goalUpdate);
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
            display.appendSteeringEvent("Done blocked — auto-composing verification wave");
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
          model: t.model === "planner" ? plannerModel : t.model === "worker" ? workerModel : t.model,
        }));
        steered = true;
      } catch (err: any) {
        accCost += getTotalPlannerCost() - plannerCostBefore;
        if (steerAttempts < 3) {
          display.appendSteeringEvent(`Steering failed (attempt ${steerAttempts}/3) — retrying...`);
          continue;
        }
        display.stop();
        console.log(chalk.yellow(`  Steering failed after ${steerAttempts} attempts: ${err.message?.slice(0, 80)} — stopping\n`));
        steeringFailed = true;
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

  // ── Main wave loop ──
  while (remaining > 0 && currentTasks.length > 0 && !stopping) {
    if (currentTasks.length > remaining) currentTasks = currentTasks.slice(0, remaining);
    syncRunInfo();

    const swarm = new Swarm({
      tasks: currentTasks, concurrency, cwd, model: workerModel, permissionMode, allowedTools,
      useWorktrees, mergeStrategy: waveMerge, agentTimeoutMs: cfg.agentTimeoutMs,
      usageCap, allowExtraUsage: cfg.allowExtraUsage, extraUsageBudget: cfg.extraUsageBudget,
      baseCostUsd: accCost,
    });
    currentSwarm = swarm;
    display.setWave(swarm);
    display.resume();
    try { await swarm.run(); }
    catch (err: unknown) {
      if (isAuthError(err)) { display.stop(); restore(); console.error(chalk.red(`\n  Authentication failed — check your API key or run: claude auth\n`)); process.exit(1); }
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
    if (liveConfig.dirty) { remaining = liveConfig.remaining; usageCap = liveConfig.usageCap; liveConfig.dirty = false; }
    liveConfig.remaining = remaining;
    lastCapped = swarm.cappedOut; lastAborted = swarm.aborted;
    recordBranches(swarm.agents, swarm.mergeResults, branches);
    saveWaveSession(runDir, waveNum, swarm.agents, swarm.totalCostUsd);
    saveRunState(runDir, {
      id: `run-${new Date().toISOString().slice(0, 19)}`, objective: objective ?? "", budget: cfg.budget,
      remaining, workerModel, plannerModel, concurrency, permissionMode,
      usageCap, allowExtraUsage: cfg.allowExtraUsage, extraUsageBudget: cfg.extraUsageBudget,
      flex, useWorktrees, mergeStrategy, waveNum, currentTasks: [],
      accCost, accCompleted, accFailed, accIn, accOut, accTools,
      branches, phase: "steering", startedAt: new Date(cfg.runStartedAt).toISOString(), cwd,
    });

    waveHistory.push({
      wave: waveNum,
      tasks: swarm.agents.map(a => ({ prompt: a.task.prompt, status: a.status, filesChanged: a.filesChanged, error: a.error })),
    });

    if (!flex || remaining <= 0 || swarm.aborted || swarm.cappedOut) break;

    syncRunInfo();
    display.setSteering(rlGetter, buildSteeringContext());
    display.resume();
    const steered = await runSteering();
    if (!steered) break;
    waveNum++;
  }

  display.stop();

  // ── Finalize ──
  const trulyDone = objectiveComplete || (!flex && remaining <= 0);
  const wasCapped = lastCapped || lastAborted;
  const finalPhase = trulyDone ? "done" : steeringFailed ? "steering" : wasCapped ? "capped" : remaining <= 0 ? "capped" : "stopped";
  saveRunState(runDir, {
    id: `run-${new Date().toISOString().slice(0, 19)}`, objective: objective ?? "", budget: cfg.budget,
    remaining, workerModel, plannerModel, concurrency, permissionMode,
    usageCap, allowExtraUsage: cfg.allowExtraUsage, extraUsageBudget: cfg.extraUsageBudget,
    flex, useWorktrees, mergeStrategy, waveNum, currentTasks: [],
    accCost, accCompleted, accFailed, accIn, accOut, accTools,
    branches, phase: finalPhase, startedAt: new Date(cfg.runStartedAt).toISOString(), cwd,
  });
  if (trulyDone) {
    try { rmSync(join(runDir, "designs"), { recursive: true, force: true }); } catch {}
    try { rmSync(join(runDir, "reflections"), { recursive: true, force: true }); } catch {}
    try { rmSync(join(runDir, "verifications"), { recursive: true, force: true }); } catch {}
  }
  if (runBranch && originalRef) {
    try { execSync(`git checkout "${originalRef}"`, { cwd, encoding: "utf-8", stdio: "pipe" }); } catch {}
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
  if (trulyDone) console.log(chalk.bold.green(`  CLAUDE OVERNIGHT — COMPLETE`));
  else if (steeringFailed) console.log(chalk.bold.yellow(`  CLAUDE OVERNIGHT — STEERING FAILED`));
  else if (remaining <= 0) console.log(chalk.bold.yellow(`  CLAUDE OVERNIGHT — BUDGET EXHAUSTED`));
  else if (lastCapped) console.log(chalk.bold.yellow(`  CLAUDE OVERNIGHT — RATE LIMITED`));
  else if (stopping || lastAborted) console.log(chalk.bold.yellow(`  CLAUDE OVERNIGHT — INTERRUPTED`));
  else console.log(chalk.bold.yellow(`  CLAUDE OVERNIGHT — STOPPED`));
  console.log(chalk.green(`  ${bannerChar.repeat(Math.min(termW - 4, 60))}`));
  console.log("");

  const statRows = [
    [chalk.bold("Waves"), String(waves), chalk.bold("Sessions"), `${accCompleted} done${accFailed > 0 ? ` / ${accFailed} failed` : ""}${remaining > 0 ? ` (${remaining} remaining)` : ""}`],
    [chalk.bold("Cost"), chalk.green(`$${accCost.toFixed(2)}`), chalk.bold("Elapsed"), elapsedStr],
    [chalk.bold("Merged"), `${totalMerged} branches`, chalk.bold("Conflicts"), totalConflicts > 0 ? chalk.red(String(totalConflicts)) : chalk.green("0")],
    [chalk.bold("Tokens"), `${fmtTokens(accIn)} in / ${fmtTokens(accOut)} out`, chalk.bold("Tool calls"), String(accTools)],
  ];
  for (const [k1, v1, k2, v2] of statRows) console.log(`  ${k1}  ${v1.padEnd(20)}  ${k2}  ${v2}`);
  if (lastCapped) console.log(`  ${chalk.yellow(`Capped at ${usageCap != null ? Math.round(usageCap * 100) : 100}%`)}`);
  console.log("");

  const statusFile = join(runDir, "status.md");
  if (existsSync(statusFile)) {
    const statusContent = readFileSync(statusFile, "utf-8").trim();
    if (statusContent) {
      console.log(chalk.dim(`  ${"─".repeat(Math.min(termW - 4, 60))}`));
      console.log(chalk.bold("  Status"));
      console.log("");
      for (const line of statusContent.split("\n")) console.log(`  ${line}`);
      console.log("");
    }
  }

  if (totalConflicts > 0) {
    console.log(chalk.dim(`  ${"─".repeat(Math.min(termW - 4, 60))}`));
    const conflictBranches = branches.filter(b => b.status === "merge-failed");
    console.log(chalk.red(`  Unresolved conflicts:`));
    for (const c of conflictBranches) console.log(chalk.red(`    ${c.branch}`));
    console.log(chalk.dim("  git merge <branch> to resolve"));
    console.log("");
  }

  console.log(chalk.dim(`  ${"─".repeat(Math.min(termW - 4, 60))}`));
  if (runBranch) console.log(chalk.dim(`  Branch: ${runBranch} — git merge ${runBranch}`));
  console.log(chalk.dim(`  Run: ${runDir}`));
  if (currentSwarm?.logFile) console.log(chalk.dim(`  Log: ${currentSwarm.logFile}`));
  console.log("");

  if (accFailed > 0) process.exit(1);
  if (lastAborted || accCompleted === 0) process.exit(2);
}
