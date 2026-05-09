// Main wave loop for executeRun.
//
// Mutable state lives in `WaveState` — a plain struct shared with run.ts.
// `WaveLoopDeps` carries config + callbacks (cwd, display, runSteering, …).

import { readFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import chalk from "chalk";
import type { Task, MergeStrategy, BranchRecord, WaveSummary, RLGetter, RunState } from "../core/types.js";
import { Swarm } from "../swarm/swarm.js";
import { contextFillInfo } from "../ui/primitives.js";
import { getModelCapability } from "../core/models.js";
import { RunDisplay } from "../ui/ui.js";
import type { LiveConfig, SteeringContext } from "../ui/ui.js";
import { isJWTAuthError } from "../core/auth.js";
import { renderPrompt } from "../prompts/load.js";
import { renderSummary } from "../ui/summary.js";
import { recordBranches, saveWaveSession } from "../state/state.js";
import { throttleBeforeWave } from "./throttle.js";
import { updateCircuitBreakerStreak } from "./circuit-breaker-state.js";
import { checkProjectHealth } from "./health.js";
import { runPostWaveReview } from "./review.js";
import { promptBudgetExtension } from "./budget.js";
import { writeCandidate } from "../skills/scribe.js";
import { runLibrarian } from "../skills/librarian.js";
import { pickAbSkill, recordAbOutcome, type AbAssignment } from "../skills/ab.js";

/** Mutable state shared between run.ts and the wave loop.
 *  Both modules read and write these fields directly — no getter/setter
 *  shim — so updates from either side are visible to the other. */
export interface WaveState {
  currentSwarm: Swarm | undefined;
  remaining: number;
  currentTasks: Task[];
  waveNum: number;
  accCost: number;
  accIn: number;
  accOut: number;
  accCompleted: number;
  accFailed: number;
  accTools: number;
  peakWorkerCtxPct: number;
  peakWorkerCtxTokens: number;
  lastCapped: boolean;
  lastAborted: boolean;
  objectiveComplete: boolean;
  /** Planner's most recent "sessions to complete" estimate; used to size the
   *  budget-extension prompt when the run runs out of sessions. */
  lastEstimate: number | undefined;
  // Mutable model knobs — synced from liveConfig when liveConfig.dirty.
  workerModel: string;
  plannerModel: string;
  fastModel: string | undefined;
  concurrency: number;
  usageCap: number | undefined;
  // Shared arrays — appended by both modules.
  branches: BranchRecord[];
  waveHistory: WaveSummary[];
}

/** Read-only config + callbacks for the wave loop. */
export interface WaveLoopDeps {
  cwd: string;
  runDir: string;
  agentTimeoutMs: number | undefined;
  envForModel: (model?: string) => Record<string, string> | undefined;
  beforeWaveCmds: string | string[] | undefined;
  afterWaveCmds: string | string[] | undefined;
  flex: boolean;
  useWorktrees: boolean;
  waveMerge: MergeStrategy;
  budget: number;
  cursorProxy: boolean;
  allowExtraUsage: boolean;
  extraUsageBudget: number;
  // skill scribe context
  repoFingerprint: string;
  runId: string;
  allowSkillProposals: boolean;
  // shared live UI config (mutations propagate to run.ts via shared ref)
  liveConfig: LiveConfig;
  // callbacks into run.ts closures
  display: RunDisplay;
  runSteering: () => Promise<boolean>;
  /** Verifier invoked between waves in no-flex mode. Mirrors runSteering. */
  runVerifier: () => Promise<boolean>;
  buildSteeringContext: () => SteeringContext;
  rlGetter: RLGetter;
  isStopping: () => boolean;
  syncRunInfo: () => void;
  runDebrief: (label: string) => void;
  onLibrarianResult?: (promoted: number, patched: number, quarantined: number, rejected: number) => void;
  /** Persist a RunState snapshot. Closes over runStateBase + state in run.ts
   *  so callers only supply the per-snapshot phase + (optional) task slice. */
  persistState: (phase: RunState["phase"], currentTasks?: Task[]) => void;
}

export async function runWaveLoop(state: WaveState, deps: WaveLoopDeps): Promise<void> {
  let runAnotherRound = true;
  let healFailStreak = 0;
  let zeroFileWaves = 0;
  let waveScribeWrote = 0;
  let waveScribeDropped = 0;

  while (runAnotherRound) {
    runAnotherRound = false;
    while (state.remaining > 0 && state.currentTasks.length > 0 && !deps.isStopping()) {
      waveScribeWrote = 0; waveScribeDropped = 0;
      // ── Health check ──
      {
        const healTasks = healFailStreak > 0 ? [] : checkProjectHealth(deps.cwd);
        if (healTasks.length > 0 && state.remaining > 0) {
          const healIds = healTasks.map(t => t.id);
          const withoutDup = state.currentTasks.filter(t => !healIds.includes(t.id));
          state.currentTasks = [...healTasks, ...withoutDup];
          deps.display.appendSteeringEvent(`Health check: build broken — queued ${healTasks.length} heal task(s)`);
        } else if (healTasks.length === 0 && healFailStreak > 0 && checkProjectHealth(deps.cwd).length > 0) {
          deps.display.appendSteeringEvent(`Health check: build broken — heal skipped after ${healFailStreak} failed attempts, needs manual intervention`);
          try {
            const statusPath2 = join(deps.runDir, "status.md");
            const existing2 = existsSync(statusPath2) ? readFileSync(statusPath2, "utf-8") : "";
            const marker = "## Heal blocked";
            if (!existing2.includes(marker)) {
              writeFileSync(statusPath2, `${existing2}${existing2 ? "\n\n" : ""}${marker}\nBuild has been broken for ${healFailStreak} waves, heal agents unable to fix — intervene manually.\n`, "utf-8");
            }
          } catch {}
        }
      }
      if (state.currentTasks.length > state.remaining) state.currentTasks = state.currentTasks.slice(0, state.remaining);
      deps.syncRunInfo();

      deps.persistState("steering");

      // ── Pre-wave rate limit gate ──
      await throttleBeforeWave(deps.rlGetter, deps.display.appendSteeringEvent.bind(deps.display), deps.isStopping);
      if (deps.isStopping()) break;

      // ── Before-wave commands ──
      if (deps.beforeWaveCmds) runShellSequence(deps.beforeWaveCmds, "Before-wave", deps);

      // ── A/B assignment ──
      const abAssignment: AbAssignment | null = pickAbSkill({
        fingerprint: deps.repoFingerprint,
        tasks: state.currentTasks,
        wave: state.waveNum,
      });
      if (abAssignment) {
        deps.display.appendSteeringEvent(
          `ab: skill=${abAssignment.skill} treatment=[${abAssignment.treatmentTaskIds.join(",")}] control=[${abAssignment.controlTaskIds.join(",")}]`,
        );
      } else {
        deps.display.appendSteeringEvent("ab: none");
      }

      // ── Swarm run ──
      const swarm = new Swarm({
        tasks: state.currentTasks, concurrency: state.concurrency, cwd: deps.cwd, model: state.workerModel,
        allowedTools: undefined,
        useWorktrees: deps.useWorktrees, mergeStrategy: deps.waveMerge, agentTimeoutMs: deps.agentTimeoutMs,
        usageCap: state.usageCap, allowExtraUsage: deps.allowExtraUsage, extraUsageBudget: deps.extraUsageBudget,
        baseCostUsd: state.accCost, envForModel: deps.envForModel, cursorProxy: deps.cursorProxy,
        repoFingerprint: deps.repoFingerprint,
        runId: deps.runId,
        waveNum: state.waveNum,
        allowSkillProposals: deps.allowSkillProposals,
      });
      state.currentSwarm = swarm;
      deps.display.setWave(swarm);
      deps.display.resume();
      try { await swarm.run(); }
      catch (err: unknown) {
        if (isJWTAuthError(err)) { deps.display.stop(); console.error(chalk.red(`\n  Authentication failed  -- check your API key or run: claude auth\n`)); process.exit(1); }
        if (swarm.agents.length > 0) {
          try { saveWaveSession(deps.runDir, state.waveNum, swarm.agents, swarm.totalCostUsd); } catch {}
        }
        throw err;
      }

      deps.display.pause();
      console.log(renderSummary(swarm));

      // ── Zero-work retry ──
      if (!swarm.aborted && !swarm.cappedOut && state.remaining > 0) {
        await handleZeroWorkRetry(swarm, state, deps);
      }

      // ── A/B outcome capture ──
      if (abAssignment) captureAbOutcome(swarm, abAssignment, state, deps);

      // ── Stats rollup ──
      const totalToolCalls = swarm.agents.reduce((sum, a) => sum + a.toolCalls, 0);
      state.accCost += swarm.totalCostUsd; state.accIn += swarm.totalInputTokens; state.accOut += swarm.totalOutputTokens;
      state.accCompleted += swarm.completed; state.accFailed += swarm.failed;
      state.accTools += totalToolCalls;
      for (const a of swarm.agents) {
        const tok = a.peakContextTokens ?? a.contextTokens ?? 0;
        if (tok <= 0) continue;
        const mdl = a.task.model || swarm.model || "unknown";
        const safe = getModelCapability(mdl).safeContext;
        const { pct } = contextFillInfo(tok, safe);
        if (pct > state.peakWorkerCtxPct) { state.peakWorkerCtxPct = pct; state.peakWorkerCtxTokens = tok; }
      }
      state.remaining = Math.max(0, state.remaining - swarm.completed - swarm.failed);

      // ── Live config dirty check ──
      if (deps.liveConfig.dirty) {
        state.remaining = deps.liveConfig.remaining;
        state.usageCap = deps.liveConfig.usageCap;
        if (deps.liveConfig.workerModel) state.workerModel = deps.liveConfig.workerModel;
        if (deps.liveConfig.plannerModel) state.plannerModel = deps.liveConfig.plannerModel;
        if (deps.liveConfig.fastModel !== undefined) state.fastModel = deps.liveConfig.fastModel;
        state.concurrency = deps.liveConfig.concurrency;
        deps.liveConfig.dirty = false;
      }
      deps.liveConfig.remaining = state.remaining;
      state.lastCapped = swarm.cappedOut; state.lastAborted = swarm.aborted;

      // ── Branch recording + wave save ──
      recordBranches(swarm.agents, swarm.mergeResults, state.branches, state.waveNum);
      saveWaveSession(deps.runDir, state.waveNum, swarm.agents, swarm.totalCostUsd);
      const attemptedPrompts = new Set(swarm.agents.map(a => a.task.prompt));
      const neverStarted = state.currentTasks.filter(t => !attemptedPrompts.has(t.prompt));
      // On user-initiated quit mid-wave, "never started" tasks are real leftover
      // work the user expects to see on resume — save them under "stopped".
      const midWavePhase: RunState["phase"] = (deps.isStopping() || swarm.aborted) ? "stopped" : "steering";
      // Preserve the leftover tasks on state so resume / verifier see the
      // real pending queue (not the full original batch) after each wave.
      state.currentTasks = neverStarted;
      deps.persistState(midWavePhase, neverStarted);

      // ── Overlay merge outcomes into wave history ──
      const failedMergeBranches = new Set(swarm.mergeResults.filter(r => !r.ok).map(r => r.branch));
      const tasks = swarm.agents.map(a => {
        const mergeFailed = a.branch && failedMergeBranches.has(a.branch);
        return {
          prompt: a.task.prompt,
          status: a.status,
          type: a.task.type,
          filesChanged: mergeFailed ? 0 : a.filesChanged,
          toolCalls: a.toolCalls,
          error: mergeFailed ? `merge-failed: branch ${a.branch} did not land` : a.error,
        };
      });
      const nonHealTasks = tasks.filter(t => t.type !== "heal");
      const nonHealFiles = nonHealTasks.reduce((sum, t) => sum + (t.filesChanged ?? 0), 0);
      const nonHealToolCalls = nonHealTasks.reduce((sum, t) => sum + (t.toolCalls ?? 0), 0);
      const suspectedInfraFailure = state.waveNum > 0 && nonHealFiles === 0 && nonHealToolCalls > 0;
      state.waveHistory.push({
        wave: state.waveNum,
        tasks,
        totalToolCalls,
        suspectedInfraFailure,
      });
      deps.display.appendSteeringEvent(`scribe: wrote=${waveScribeWrote} dropped=${waveScribeDropped}`);

      // ── Heal fail streak ──
      const lastWave = state.waveHistory[state.waveHistory.length - 1];
      const healTask = lastWave?.tasks.find(t => t.type === "heal");
      if (healTask && !healTask.filesChanged) {
        healFailStreak++;
      } else if (lastWave?.tasks.some(t => (t.type !== "heal") && (t.filesChanged ?? 0) > 0)) {
        healFailStreak = 0;
      }

      // ── Circuit breaker ──
      const { streak: nextZeroFileWaves, shouldHalt: circuitHalt } = updateCircuitBreakerStreak({
        waveNum: state.waveNum,
        prevStreak: zeroFileWaves,
        nonHealFiles,
        totalToolCallsAllAgents: totalToolCalls,
      });
      if (suspectedInfraFailure) {
        const msg =
          "[circuit-breaker] Agents completed with tool calls but 0 files landed — possible worktree/merge bug, NOT a stuck agent. Continuing run.";
        console.warn(chalk.yellow(`\n  ${msg}`));
        deps.display.appendSteeringEvent(msg);
      }
      zeroFileWaves = nextZeroFileWaves;
      if (circuitHalt) {
        deps.display.appendSteeringEvent(`Circuit breaker: 2 consecutive waves produced no merged changes — halting to prevent budget drain`);
        deps.display.stop();
        deps.persistState("stopped", []);
        console.log(chalk.red(`\n  Circuit breaker: 2 consecutive waves produced no merged changes.`));
        console.log(chalk.red(`  Halting to prevent budget drain. Run preserved at ${deps.runDir}.`));
        process.exit(3);
      }

      // ── Hook-blocked work ──
      const hookBlocked = swarm.agents.filter(a =>
        swarm.logs.some(l => l.agentId === a.id && l.text.includes("did NOT land"))
      );
      if (hookBlocked.length > 0) {
        const msg = `⚠ ${hookBlocked.length} agent(s) touched files that didn't land — check hooks/gitignore/absolute paths`;
        deps.display.appendSteeringEvent(msg);
        try {
          const statusPath = join(deps.runDir, "status.md");
          const existing = readFileSync(statusPath, "utf-8");
          if (!existing.includes(msg)) {
            writeFileSync(statusPath, existing + `\n\n${msg}`, "utf-8");
          }
        } catch {}
      }

      // ── Merge-failed status.md + GC ──
      try {
        const unresolved = state.branches.filter(b => {
          if (b.status !== "merge-failed") return false;
          try { execSync(`git rev-parse --verify "${b.branch}"`, { cwd: deps.cwd, stdio: "ignore" }); return true; }
          catch { return false; }
        });
        const statusPath = join(deps.runDir, "status.md");
        const existing = existsSync(statusPath) ? readFileSync(statusPath, "utf-8") : "";
        const marker = "## Unresolved merge failures";
        const idx = existing.indexOf(marker);
        const base = idx >= 0 ? existing.slice(0, idx).replace(/\n+$/, "") : existing;
        let next = base;
        if (unresolved.length > 0) {
          const list = unresolved.map(b => `  - ${b.branch} — ${b.taskPrompt.slice(0, 120)}`).join("\n");
          next = `${base}${base ? "\n\n" : ""}${marker}\n${unresolved.length} branch(es) contain unmerged agent work. Resolve or discard before relying on those changes:\n${list}\n`;
          deps.display.appendSteeringEvent(`⚠ ${unresolved.length} unresolved merge failure(s) — see status.md`);
        }
        if (next !== existing) writeFileSync(statusPath, next, "utf-8");

        const gcCandidates = state.branches.filter(b =>
          b.status === "merge-failed" && b.firstFailedWave !== undefined && (state.waveNum - b.firstFailedWave) >= 2
        );
        let gcCount = 0;
        for (const b of gcCandidates) {
          try { execSync(`git branch -D "${b.branch}"`, { cwd: deps.cwd, stdio: "ignore" }); } catch {}
          b.status = "discarded";
          gcCount++;
        }
        if (gcCount > 0) deps.display.appendSteeringEvent(`GC: discarded ${gcCount} ghost branch(es) ≥2 waves old`);
      } catch {}

      // Fast-exit on user-quit: don't spend more budget on debrief / after-wave
      // / post-wave review — the user wants to stop NOW.
      if (deps.isStopping() || swarm.aborted) break;

      // ── Debrief ──
      deps.runDebrief(`Wave ${state.waveNum + 1} just finished.`);

      // ── After-wave commands ──
      if (deps.afterWaveCmds && !swarm.aborted && !swarm.cappedOut) {
        runShellSequence(deps.afterWaveCmds, "After-wave", deps);
      }

      // ── Post-wave review ──
      if (deps.flex && state.remaining > 0 && !swarm.aborted && !swarm.cappedOut && state.waveNum > 0) {
        deps.display.appendSteeringEvent(`Review: scanning wave ${state.waveNum + 1} diff…`);
        const reviewResult = await runPostWaveReview({
          cwd: deps.cwd, plannerModel: state.plannerModel, concurrency: state.concurrency,
          remaining: state.remaining, usageCap: state.usageCap, allowExtraUsage: deps.allowExtraUsage,
          extraUsageBudget: deps.extraUsageBudget, baseCostUsd: state.accCost,
          envForModel: deps.envForModel, mergeStrategy: deps.waveMerge, useWorktrees: deps.useWorktrees,
        }, (reviewSwarm) => {
          state.currentSwarm = reviewSwarm;
          deps.display.setWave(reviewSwarm);
          deps.display.resume();
        });
        if (reviewResult) {
          state.accCost += reviewResult.costUsd;
          state.accIn += reviewResult.inputTokens;
          state.accOut += reviewResult.outputTokens;
          state.accCompleted += reviewResult.completed;
          state.remaining = Math.max(0, state.remaining - reviewResult.completed);
          deps.liveConfig.remaining = state.remaining;
          deps.display.appendSteeringEvent(`Post-wave review: ${reviewResult.completed} done${reviewResult.failed > 0 ? ` / ${reviewResult.failed} failed` : ""}`);
        }
      }

      // ── Wave-end heuristic candidate (provenance, not a real skill) ──
      if (deps.repoFingerprint && deps.runId) {
        const filesChanged = swarm.agents.reduce((s, a) => s + (a.filesChanged ?? 0), 0);
        const outcome = swarm.aborted ? "aborted" : swarm.cappedOut ? "capped" : `${swarm.completed}done/${swarm.failed}failed`;
        const body = `wave ${state.waveNum}: ${outcome}, ${filesChanged} files changed`;
        const r = writeCandidate({
          kind: "heuristic",
          proposedBy: `thinking-wave-${state.waveNum}`,
          wave: state.waveNum,
          runId: deps.runId,
          fingerprint: deps.repoFingerprint,
          trigger: `wave-${state.waveNum} ${outcome}`,
          body: body.slice(0, 800),
        });
        if (r.wrote) waveScribeWrote++;
        if (r.dropped) waveScribeDropped++;
      }

      // ── Librarian: curate candidates into canon at end of wave ──
      const librarianStart = Date.now();
      let librarianPromoted = 0, librarianPatched = 0, librarianQuarantined = 0, librarianRejected = 0;
      try {
        const librarianModel = state.fastModel ?? state.workerModel;
        const lr = await runLibrarian({
          fingerprint: deps.repoFingerprint,
          runId: deps.runId,
          wave: state.waveNum,
          cwd: deps.cwd,
          model: librarianModel,
          envForModel: deps.envForModel,
        });
        librarianPromoted = lr.promoted;
        librarianPatched = lr.patched;
        librarianQuarantined = lr.quarantined;
        librarianRejected = lr.rejected;
      } catch {}
      const librarianMs = Date.now() - librarianStart;
      deps.display.appendSteeringEvent(`skills: promoted=${librarianPromoted} patched=${librarianPatched} quarantined=${librarianQuarantined} rejected=${librarianRejected} librarian_ms=${librarianMs}`);
      deps.onLibrarianResult?.(librarianPromoted, librarianPatched, librarianQuarantined, librarianRejected);

      if (state.remaining <= 0 || swarm.aborted || swarm.cappedOut) break;

      // ── Transition: steering (flex) or verifier (no-flex) ──
      deps.syncRunInfo();
      deps.display.setSteering(deps.rlGetter, deps.buildSteeringContext());
      deps.display.resume();
      const transitioned = await (deps.flex ? deps.runSteering() : deps.runVerifier());
      if (!transitioned) break;
      state.waveNum++;
    } // end inner while

    // ── Budget exhaustion: offer to extend ──
    const exhaustedByBudget =
      !state.objectiveComplete && !deps.isStopping() && !state.lastAborted && !state.lastCapped &&
      state.remaining <= 0;
    if (exhaustedByBudget) {
      const ext = await promptBudgetExtension({
        estimate: state.lastEstimate,
        spent: state.accCost,
        sessionsUsed: state.accCompleted + state.accFailed,
        budget: deps.budget,
      });
      if (ext > 0) {
        state.remaining = ext;
        state.lastCapped = false;
        state.lastAborted = false;
        deps.display.setSteering(deps.rlGetter, deps.buildSteeringContext());
        deps.display.start();
        const steered = await deps.runSteering();
        if (steered) {
          state.waveNum++;
          runAnotherRound = true;
          continue;
        }
        deps.display.stop();
      }
    }
  } // end outer while
}

// ── Helpers ──

/** Run a sequence of shell commands, logging output to the steering pane. */
function runShellSequence(cmds: string | string[], label: string, deps: WaveLoopDeps): void {
  const list = Array.isArray(cmds) ? cmds : [cmds];
  for (const cmd of list) {
    deps.display.appendSteeringEvent(`${label}: ${cmd}`);
    try {
      const out = execSync(cmd, { cwd: deps.cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
      if (out.trim()) deps.display.appendSteeringEvent(`  → ${out.trim().slice(0, 200)}`);
    } catch (err: any) {
      const msg = (err.stderr || err.stdout || err.message || "").trim().slice(0, 300);
      deps.display.appendSteeringEvent(`  ✗ ${cmd}: ${msg}`);
    }
  }
}

async function handleZeroWorkRetry(swarm: Swarm, state: WaveState, deps: WaveLoopDeps): Promise<void> {
  const failedBranches = new Set(swarm.mergeResults.filter(r => !r.ok).map(r => r.branch));
  const postResults = new Map<number, { ok: boolean; output: string }>();
  for (const a of swarm.agents) {
    if (a.status !== "done" || !a.task.postcondition) continue;
    if (a.branch && failedBranches.has(a.branch)) continue;
    try {
      const out = execSync(a.task.postcondition, { cwd: deps.cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
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
  if (zeroWork.length === 0) return;

  const noFiles = zeroWork.filter(a => (a.filesChanged ?? 0) === 0).length;
  const badPost = zeroWork.length - noFiles;
  deps.display.appendSteeringEvent(`Retry: ${zeroWork.length} task(s) (${noFiles} with 0 files, ${badPost} failed postcondition)`);
  const retryTasks = zeroWork.map(a => {
    const pr = postResults.get(a.id);
    const postFailed = !!(pr && !pr.ok);
    return {
      id: `${a.task.id}-retry`,
      prompt: renderPrompt("30_wave/30-6_retry-suffix", {
        variant: postFailed ? "POSTFAILED" : "NOFILES",
        vars: {
          taskPrompt: a.task.prompt,
          postcondition: a.task.postcondition,
          output: pr?.output || "(no output)",
        },
      }),
      type: "execute" as const,
      postcondition: a.task.postcondition,
    };
  });
  const retrySwarm = new Swarm({
    tasks: retryTasks, concurrency: Math.min(state.concurrency, retryTasks.length), cwd: deps.cwd, model: state.workerModel,
    allowedTools: undefined, useWorktrees: deps.useWorktrees, mergeStrategy: deps.waveMerge,
    agentTimeoutMs: deps.agentTimeoutMs, usageCap: state.usageCap, allowExtraUsage: deps.allowExtraUsage,
    extraUsageBudget: deps.extraUsageBudget, baseCostUsd: state.accCost, envForModel: deps.envForModel,
    cursorProxy: deps.cursorProxy,
  });
  state.currentSwarm = retrySwarm;
  deps.display.setWave(retrySwarm);
  deps.display.resume();
  try { await retrySwarm.run(); } catch {}
  deps.display.pause();

  state.accIn += retrySwarm.totalInputTokens; state.accOut += retrySwarm.totalOutputTokens;
  state.accTools += retrySwarm.agents.reduce((sum, a) => sum + a.toolCalls, 0);

  const retryFailedBranches = new Set(retrySwarm.mergeResults.filter(r => !r.ok).map(r => r.branch));
  const stillZero = retrySwarm.agents.filter(a => {
    if (a.status !== "done") return false;
    if ((a.filesChanged ?? 0) === 0) return true;
    if (!a.task.postcondition) return false;
    if (a.branch && retryFailedBranches.has(a.branch)) return true;
    try { execSync(a.task.postcondition, { cwd: deps.cwd, stdio: "ignore", timeout: 30_000 }); return false; }
    catch { return true; }
  });
  for (const a of stillZero) {
    const why = (a.filesChanged ?? 0) === 0 ? "still changed 0 files" : "postcondition still failing";
    deps.display.appendSteeringEvent(`RETRY FAILED: agent ${a.id} ${why} — task dropped as error`);
    a.error = a.error ?? `retry failed: ${why}`;
    state.accFailed++;
    state.remaining = Math.max(0, state.remaining - 1);
  }
  state.accCompleted += retrySwarm.completed;
  state.remaining = Math.max(0, state.remaining - retrySwarm.completed);

  swarm.agents.push(...retrySwarm.agents);
  swarm.completed += retrySwarm.completed;
  swarm.failed += stillZero.length;
  swarm.totalCostUsd += retrySwarm.totalCostUsd;
  swarm.totalInputTokens += retrySwarm.totalInputTokens;
  swarm.totalOutputTokens += retrySwarm.totalOutputTokens;
  deps.liveConfig.remaining = state.remaining;
}

function captureAbOutcome(swarm: Swarm, assignment: AbAssignment, state: WaveState, deps: WaveLoopDeps): void {
  const treatmentAgents = swarm.agents.filter(a => assignment.treatmentTaskIds.includes(a.task.id));
  const controlAgents = swarm.agents.filter(a => assignment.controlTaskIds.includes(a.task.id));
  if (treatmentAgents.length === 0 || controlAgents.length === 0) return;

  const tScore = treatmentAgents.reduce((s, a) => s + ((a.filesChanged ?? 0) > 0 ? 1 : 0), 0);
  const cScore = controlAgents.reduce((s, a) => s + ((a.filesChanged ?? 0) > 0 ? 1 : 0), 0);
  const tFiles = treatmentAgents.reduce((s, a) => s + (a.filesChanged ?? 0), 0);
  const cFiles = controlAgents.reduce((s, a) => s + (a.filesChanged ?? 0), 0);
  const tCost = treatmentAgents.reduce((s, a) => s + (a.costUsd ?? 0), 0);
  const cCost = controlAgents.reduce((s, a) => s + (a.costUsd ?? 0), 0);

  recordAbOutcome({
    runId: deps.runId,
    wave: state.waveNum,
    assignment,
    treatmentScore: tScore,
    controlScore: cScore,
    treatmentFilesChanged: tFiles,
    controlFilesChanged: cFiles,
    treatmentCostUsd: tCost,
    controlCostUsd: cCost,
  });

  const outcome = tScore > cScore ? "treatment won" : cScore > tScore ? "control won" : "tie";
  deps.display.appendSteeringEvent(
    `ab: ${assignment.skill} → ${outcome} (t:${tScore}vs${cScore}c, Δ$${(tCost - cCost).toFixed(2)})`,
  );
}
