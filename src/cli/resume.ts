import { readFileSync } from "fs";
import { join } from "path";
import chalk from "chalk";
import { formatContextWindow } from "../core/models.js";
import {
  saveRunState, findIncompleteRuns, showRunHistory, formatTimeAgo,
  autoMergeBranches, readMdDir,
} from "../state/state.js";
import { orchestrate, salvageFromFile } from "../planner/planner.js";
import { setTranscriptRunDir } from "../core/transcripts.js";
import { wrap } from "../ui/primitives.js";
import { makeProgressLog, selectKey } from "./cli.js";
import { editRunSettings } from "./settings.js";
import type { PermMode, RunState, MutableRunSettings, Task } from "../core/types.js";

export function countTasksInFile(path: string): number {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return Array.isArray(parsed?.tasks) ? parsed.tasks.length : 0;
  } catch { return 0; }
}

export async function promptResumeOverrides(
  state: RunState,
  cliFlags: Record<string, string>,
  argv: string[],
  noTTY: boolean,
  runDir: string,
): Promise<void> {
  // ── Apply CLI flag overrides first ──
  if (cliFlags.model) state.workerModel = cliFlags.model;
  if (cliFlags.concurrency) {
    const n = parseInt(cliFlags.concurrency);
    if (n >= 1) state.concurrency = n;
  }
  if (cliFlags.budget) {
    const n = parseInt(cliFlags.budget);
    if (n > 0) {
      state.remaining = n;
      state.budget = state.accCompleted + state.accFailed + n;
    }
  }
  if (cliFlags["usage-cap"] != null) {
    const v = parseFloat(cliFlags["usage-cap"]);
    if (!isNaN(v) && v >= 0 && v <= 100) state.usageCap = v > 0 ? v / 100 : undefined;
  }
  if (cliFlags["extra-usage-budget"] != null) {
    const v = parseFloat(cliFlags["extra-usage-budget"]);
    if (!isNaN(v) && v > 0) { state.extraUsageBudget = v; state.allowExtraUsage = true; }
  }
  if (argv.includes("--allow-extra-usage")) state.allowExtraUsage = true;
  if (cliFlags.perm) state.permissionMode = cliFlags.perm as PermMode;

  if (noTTY) {
    try { saveRunState(runDir, state); } catch {}
    return;
  }

  // ── Interactive review ──
  const fmtSummary = () => {
    const remaining = Math.max(1, state.remaining);
    const capStr = state.usageCap != null ? `${Math.round(state.usageCap * 100)}%` : "unlimited";
    const extraStr = state.allowExtraUsage
      ? (state.extraUsageBudget ? `$${state.extraUsageBudget}` : "unlimited")
      : "off";
    const modelLine = (label: string, m: string | undefined) =>
      m ? `  ${chalk.dim(label.padEnd(11))}${chalk.white(m)} ${chalk.dim(`(${formatContextWindow(m)} context)`)}` : null;
    console.log();
    console.log(`  ${chalk.dim("Resume settings")}`);
    console.log(`  ${chalk.dim("─".repeat(40))}`);
    const lines = [
      modelLine("planner", state.plannerModel),
      modelLine("worker", state.workerModel),
      modelLine("fast", state.fastModel),
    ].filter(Boolean) as string[];
    for (const l of lines) console.log(l);
    console.log(`  ${chalk.dim("remaining  ")}${chalk.white(String(remaining))} ${chalk.dim("sessions")}`);
    console.log(`  ${chalk.dim("concur     ")}${chalk.white(String(state.concurrency))}`);
    console.log(`  ${chalk.dim("usage cap  ")}${chalk.white(capStr)}`);
    console.log(`  ${chalk.dim("extra      ")}${chalk.white(extraStr)}`);
    console.log(`  ${chalk.dim("perms      ")}${chalk.white(state.permissionMode === "bypassPermissions" ? "yolo" : state.permissionMode)}`);
  };
  fmtSummary();

  const action = await selectKey("", [
    { key: "r", desc: "esume" },
    { key: "e", desc: "dit" },
    { key: "q", desc: "uit" },
  ]);
  if (action === "q") process.exit(0);
  if (action === "r") return;

  const settings: MutableRunSettings = {
    workerModel: state.workerModel,
    plannerModel: state.plannerModel,
    fastModel: state.fastModel,
    workerProviderId: state.workerProviderId,
    plannerProviderId: state.plannerProviderId,
    fastProviderId: state.fastProviderId,
    concurrency: state.concurrency,
    usageCap: state.usageCap,
    allowExtraUsage: state.allowExtraUsage ?? false,
    extraUsageBudget: state.extraUsageBudget,
    permissionMode: state.permissionMode,
  };

  await editRunSettings({
    current: settings,
    cliConcurrencySet: !!cliFlags.concurrency,
  });

  Object.assign(state, settings);
  try { saveRunState(runDir, state); } catch {}
  console.log(chalk.green("\n  ✓ Settings updated"));
  fmtSummary();
  console.log();
}

export interface DetectResumeInput {
  rootDir: string;
  cwd: string;
  noTTY: boolean;
  tasks: Task[];
  allRuns: { dir: string; state: RunState }[];
  completedRuns: { dir: string; state: RunState }[];
  cliFlags: Record<string, string>;
  argv: string[];
}

export interface DetectResumeResult {
  resuming: boolean;
  replanFromScratch: boolean;
  resumeState: RunState | null;
  resumeRunDir: string | undefined;
  continueObjective: string | undefined;
}

export async function detectResume(input: DetectResumeInput): Promise<DetectResumeResult> {
  const { rootDir, cwd, noTTY, tasks, allRuns, completedRuns, cliFlags, argv } = input;

  let resuming = false;
  let replanFromScratch = false;
  let resumeState: RunState | null = null;
  let resumeRunDir: string | undefined;
  let continueObjective: string | undefined;
  const incompleteRuns = findIncompleteRuns(rootDir, cwd);

  // When only completed runs exist, offer to continue from the last one
  if (incompleteRuns.length === 0 && completedRuns.length > 0 && !noTTY && tasks.length === 0) {
    let picked = false;
    while (!picked) {
      const action = await selectKey("", [
        { key: "c", desc: "ontinue last" }, { key: "h", desc: "istory" }, { key: "n", desc: "ew" }, { key: "q", desc: "uit" },
      ]);
      if (action === "q") process.exit(0);
      if (action === "h") { await showRunHistory(allRuns, cwd, incompleteRuns); continue; }
      if (action === "c") { continueObjective = completedRuns[0].state.objective; }
      picked = true;
    }
  }

  if (incompleteRuns.length > 0 && !noTTY && tasks.length === 0) {
    let decided = false;
    while (!decided) {
      if (incompleteRuns.length === 1) {
        const run = incompleteRuns[0];
        const prev = run.state;
        const merged = prev.branches.filter(b => b.status === "merged").length;
        const unmerged = prev.branches.filter(b => b.status === "unmerged").length;
        const failed = prev.branches.filter(b => b.status === "failed" || b.status === "merge-failed").length;
        const obj = prev.objective?.slice(0, 50) || "";
        const ago = formatTimeAgo(prev.startedAt);
        let lastStatus = "";
        try { lastStatus = readFileSync(join(run.dir, "status.md"), "utf-8").trim().slice(0, 200); } catch {}
        const planTaskCount = prev.phase === "planning" ? countTasksInFile(join(run.dir, "tasks.json")) : 0;
        console.log(chalk.yellow(`\n  ⚠ Unfinished run`) + chalk.dim(` · ${ago}`));
        const termW = Math.max(process.stdout.columns ?? 80, 60);
        const statusMaxW = Math.min(termW - 8, 80);
        const boxLines = prev.phase === "planning" ? [
          `${obj}${obj.length >= 50 ? "…" : ""}`,
          `Plan ready · ${planTaskCount} tasks · budget ${prev.budget} · ${prev.concurrency}× concurrent`,
          `Plan phase · not yet executing`,
        ] : [
          `${obj}${obj.length >= 50 ? "…" : ""}`,
          `${prev.accCompleted}/${prev.budget} sessions · ${Math.max(1, (prev.budget ?? 0) - prev.accCompleted)} remaining · $${prev.accCost.toFixed(2)}`,
          `Wave ${prev.waveNum + 1} · ${prev.phase}`,
        ];
        if (lastStatus) {
          for (const wl of wrap(lastStatus, statusMaxW)) boxLines.push(wl);
        }
        if (merged + unmerged + failed > 0) boxLines.push(`${merged} merged · ${unmerged} unmerged · ${failed} failed`);
        const boxW = Math.max(...boxLines.map(l => l.length)) + 4;
        console.log(chalk.dim(`  ╭${"─".repeat(boxW)}╮`));
        for (const line of boxLines) console.log(chalk.dim("  │") + `  ${line.padEnd(boxW - 2)}` + chalk.dim("│"));
        console.log(chalk.dim(`  ╰${"─".repeat(boxW)}╯`));

        const action = await selectKey("", [{ key: "r", desc: "esume" }, { key: "h", desc: "istory" }, { key: "f", desc: "resh" }, { key: "q", desc: "uit" }]);
        if (action === "q") process.exit(0);
        if (action === "f") { decided = true; break; }
        if (action === "h") { await showRunHistory(allRuns, cwd, incompleteRuns); continue; }
        resuming = true; resumeState = prev; resumeRunDir = run.dir; decided = true;
      } else {
        const shown = incompleteRuns.slice(0, 9);
        console.log(chalk.yellow(`\n  ⚠ ${incompleteRuns.length} unfinished runs${incompleteRuns.length > 9 ? ` (showing newest 9)` : ""}\n`));
        for (let i = 0; i < shown.length; i++) {
          const s = shown[i].state;
          const ago = formatTimeAgo(s.startedAt);
          const obj = s.objective?.slice(0, 50) || "";
          const merged = s.branches.filter(b => b.status === "merged").length;
          let lastStatus = "";
          try { lastStatus = readFileSync(join(shown[i].dir, "status.md"), "utf-8").trim().split("\n")[0].slice(0, 120); } catch {}
          console.log(chalk.cyan(`  ${i + 1}`) + `  ${obj}${obj.length >= 50 ? "…" : ""}`);
          if (s.phase === "planning") {
            const n = countTasksInFile(join(shown[i].dir, "tasks.json"));
            console.log(chalk.dim(`     plan ready · ${n} tasks · budget ${s.budget} · ${ago} · not yet executing`));
          } else {
            console.log(chalk.dim(`     ${s.accCompleted}/${s.budget} · $${s.accCost.toFixed(2)} · ${ago} · ${s.phase} at wave ${s.waveNum + 1}${merged ? ` · ${merged} merged` : ""}`));
          }
          if (lastStatus) {
            const termW = Math.max(process.stdout.columns ?? 80, 60);
            for (const wl of wrap(lastStatus, termW - 6)) console.log(chalk.dim(`     ${wl}`));
          }
          console.log("");
        }
        const action = await selectKey(`  ${chalk.dim(`[1-${shown.length}] resume`)}`, [
          ...shown.map((_, i) => ({ key: String(i + 1), desc: "" })),
          { key: "h", desc: "istory" }, { key: "f", desc: "resh" }, { key: "q", desc: "uit" },
        ]);
        if (action === "q") process.exit(0);
        if (action === "f") { decided = true; break; }
        if (action === "h") { await showRunHistory(allRuns, cwd, incompleteRuns); continue; }
        const idx = parseInt(action) - 1;
        if (idx >= 0 && idx < shown.length) {
          resuming = true; resumeState = shown[idx].state; resumeRunDir = shown[idx].dir; decided = true;
        }
      }
    }
    if (resuming && resumeState && resumeRunDir) {
      // If currentTasks is empty but tasks.json exists on disk, reload it.
      // Covers two cases:
      //   1. Planning-phase resumes (the prior run died before executeRun).
      //   2. Stopped/capped runs whose state was saved with currentTasks: []
      //      (saveRunState always stores []  -- the plan is on disk in tasks.json).
      if (resumeState.currentTasks.length === 0) {
        const loaded = salvageFromFile(join(resumeRunDir, "tasks.json"), resumeState.budget, () => {}, "resume");
        if (loaded) {
          resumeState.currentTasks = loaded;
          const label = resumeState.phase === "planning" ? "Resuming plan" : `Resuming ${resumeState.phase} run`;
          console.log(chalk.green(`\n  ✓ ${label} · ${loaded.length} tasks loaded from tasks.json`));
        } else if (resumeState.phase === "planning") {
          // No tasks.json  -- the thinking wave got killed before orchestrate ran.
          // If design docs survived, re-orchestrate from them (salvages the
          // thinking spend instead of throwing it away).
          const designs = readMdDir(join(resumeRunDir, "designs"));
          if (!designs || !resumeState.objective) {
            // Planning died before producing anything — re-run planning from
            // scratch while keeping all saved settings (model, budget, etc.).
            console.log(chalk.yellow(`\n  ⚠ Planning-phase run has no tasks or designs — will re-plan from scratch.\n`));
            replanFromScratch = true;
          } else {
            const remainingBudget = Math.max(resumeState.concurrency, resumeState.budget - resumeState.accCompleted);
            const orchBudget = Math.min(50, Math.max(resumeState.concurrency, Math.ceil(remainingBudget * 0.5)));
            const flexNote = `This is wave 1 of an adaptive multi-wave run (total budget: ${remainingBudget}). Plan the highest-impact foundational work first. Future waves will iterate based on what's learned.`;
            console.log(chalk.cyan(`\n  ◆ Re-orchestrating plan from existing designs...\n`));
            process.stdout.write("\x1B[?25l");
            // Route transcripts into the resumed run so this call's events
            // land alongside the prior run's planning trail.
            setTranscriptRunDir(resumeRunDir);
            try {
              const orchTasks = await orchestrate(
                resumeState.objective, designs, cwd, resumeState.plannerModel, resumeState.workerModel,
                resumeState.permissionMode, orchBudget, resumeState.concurrency, makeProgressLog(),
                flexNote, join(resumeRunDir, "tasks.json"), "orchestrate-resume",
              );
              resumeState.currentTasks = orchTasks;
              process.stdout.write(`\x1B[2K\r  ${chalk.green(`✓ ${orchTasks.length} tasks`)}\n`);
            } catch (err: any) {
              process.stdout.write("\x1B[?25h");
              console.error(chalk.red(`\n  Re-orchestration failed: ${err.message}\n  Start Fresh instead.\n`));
              process.exit(1);
            }
            process.stdout.write("\x1B[?25h");
          }
        }
      }
      const unmerged = resumeState.branches.filter(b => b.status === "unmerged").length;
      if (unmerged > 0) {
        console.log("");
        autoMergeBranches(cwd, resumeState.branches, msg => console.log(chalk.dim(`  ${msg}`)));
        try { saveRunState(resumeRunDir, resumeState); } catch {}
      }
      await promptResumeOverrides(resumeState, cliFlags, argv, noTTY, resumeRunDir);
    }
  }

  return { resuming, replanFromScratch, resumeState, resumeRunDir, continueObjective };
}
