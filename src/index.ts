#!/usr/bin/env node
import { readFileSync, existsSync, readdirSync, mkdirSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import chalk from "chalk";
import { VERSION } from "./_version.js";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Swarm } from "./swarm.js";
import { planTasks, refinePlan, identifyThemes, buildThinkingTasks, orchestrate, salvageFromFile } from "./planner.js";
import { modelDisplayName, formatContextWindow, DEFAULT_MODEL } from "./models.js";
import { setPlannerEnvResolver } from "./planner-query.js";
import {
  pickModel,
  loadProviders,
  preflightProvider,
  buildEnvResolver,
  healthCheckCursorProxy,
  PROXY_DEFAULT_URL,
  isCursorProxyProvider,
  ensureCursorProxyRunning,
  bundledComposerProxyShellCommand,
  warnMacCursorAgentShellPatchIfNeeded,
  hasCursorAgentToken,
} from "./providers.js";
import type { ProviderConfig } from "./providers.js";
import { RunDisplay } from "./ui.js";
import { renderSummary } from "./render.js";
import { executeRun } from "./run.js";
import type { Task, PermMode, MergeStrategy, RunState, WaveSummary } from "./types.js";
import {
  parseCliFlags, isAuthError, fetchModels, ask, select, selectKey,
  loadTaskFile, validateConcurrency, isGitRepo, validateGitRepo,
  showPlan, BRAILLE, makeProgressLog,
} from "./cli.js";
import type { FileArgs } from "./cli.js";
import {
  loadRunState, findIncompleteRuns, findOrphanedDesigns, backfillOrphanedPlans,
  formatTimeAgo, showRunHistory, readPreviousRunKnowledge,
  createRunDir, updateLatestSymlink, readMdDir, saveRunState,
  autoMergeBranches,
} from "./state.js";

function countTasksInFile(path: string): number {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return Array.isArray(parsed?.tasks) ? parsed.tasks.length : 0;
  } catch { return 0; }
}

async function promptResumeOverrides(
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

  // Kick off model fetch in the background so it's ready if the user picks Edit.
  const modelsPromise = fetchModels(20_000).catch(() => [] as Awaited<ReturnType<typeof fetchModels>>);

  // ── Interactive review ──
  const fmtSummary = () => {
    const remaining = Math.max(1, state.remaining);
    const capStr = state.usageCap != null ? `${Math.round(state.usageCap * 100)}%` : "unlimited";
    const extraStr = state.allowExtraUsage
      ? (state.extraUsageBudget ? `$${state.extraUsageBudget}` : "unlimited")
      : "off";
    console.log();
    console.log(`  ${chalk.dim("Resume settings")}`);
    console.log(`  ${chalk.dim("─".repeat(40))}`);
    console.log(`  ${chalk.dim("model      ")}${chalk.white(state.workerModel)} ${chalk.dim(`(${formatContextWindow(state.workerModel)} context)`)}`);
    console.log(`  ${chalk.dim("remaining  ")}${chalk.white(String(remaining))} ${chalk.dim("sessions")}`);
    console.log(`  ${chalk.dim("concur     ")}${chalk.white(String(state.concurrency))}`);
    console.log(`  ${chalk.dim("usage cap  ")}${chalk.white(capStr)}`);
    console.log(`  ${chalk.dim("extra      ")}${chalk.white(extraStr)}`);
  };
  fmtSummary();

  const action = await selectKey("", [
    { key: "r", desc: "esume" },
    { key: "e", desc: "dit" },
    { key: "q", desc: "uit" },
  ]);
  if (action === "q") process.exit(0);
  if (action === "r") return;

  // ── Edit walk ──
  let modelFrame = 0;
  const modelSpinner = setInterval(() => {
    process.stdout.write(`\x1B[2K\r  ${chalk.cyan(BRAILLE[modelFrame++ % BRAILLE.length])} ${chalk.dim("loading models...")}`);
  }, 120);
  let models: Awaited<ReturnType<typeof fetchModels>>;
  try { models = await modelsPromise; } finally { clearInterval(modelSpinner); process.stdout.write(`\x1B[2K\r`); }
  const pick = await pickModel(
    `${chalk.cyan("①")} Worker model:`,
    models,
    state.workerProviderId ?? state.workerModel,
  );
  state.workerModel = pick.model;
  state.workerProviderId = pick.providerId;

  const remAns = await ask(`\n  ${chalk.cyan("②")} Remaining sessions ${chalk.dim(`[${state.remaining}]:`)} `);
  const parsedRem = parseInt(remAns);
  if (!isNaN(parsedRem) && parsedRem > 0) {
    state.remaining = parsedRem;
    state.budget = state.accCompleted + state.accFailed + parsedRem;
  }

  const concAns = await ask(`\n  ${chalk.cyan("③")} Concurrency ${chalk.dim(`[${state.concurrency}]:`)} `);
  const parsedConc = parseInt(concAns);
  if (!isNaN(parsedConc) && parsedConc >= 1) state.concurrency = parsedConc;

  const currentCap = state.usageCap != null ? String(Math.round(state.usageCap * 100)) : "off";
  const capAns = await ask(`\n  ${chalk.cyan("④")} Usage cap % ${chalk.dim(`[${currentCap}]`)} ${chalk.dim("(0 = off):")} `);
  if (capAns.trim()) {
    const v = parseFloat(capAns);
    if (!isNaN(v) && v >= 0 && v <= 100) state.usageCap = v > 0 ? v / 100 : undefined;
  }

  const currentExtra = state.allowExtraUsage
    ? (state.extraUsageBudget ? `$${state.extraUsageBudget}` : "unlimited")
    : "off";
  const extraChoice = await select(`${chalk.cyan("⑤")} Extra usage ${chalk.dim(`[current: ${currentExtra}]`)}:`, [
    { name: "Keep current", value: "keep" },
    { name: "Off", value: "off", hint: "stop at plan limit" },
    { name: "With $ cap", value: "budget", hint: "set a spending cap" },
    { name: "Unlimited", value: "unlimited", hint: "no cap, billed as overage" },
  ]);
  if (extraChoice === "off") {
    state.allowExtraUsage = false;
    state.extraUsageBudget = undefined;
  } else if (extraChoice === "budget") {
    const bAns = await ask(`  ${chalk.dim("Max extra $:")} `);
    const bVal = parseFloat(bAns);
    if (!isNaN(bVal) && bVal > 0) { state.extraUsageBudget = bVal; state.allowExtraUsage = true; }
  } else if (extraChoice === "unlimited") {
    state.allowExtraUsage = true;
    state.extraUsageBudget = undefined;
  }

  try { saveRunState(runDir, state); } catch {}
  console.log(chalk.green("\n  ✓ Settings updated"));
  fmtSummary();
  console.log();
}

async function main() {
  // Do not use ??= — parent shell can set CURSOR_SKIP_KEYCHAIN=0.
  // CI=true is only set in child process envs (proxy, agents) — setting it here
  // kills chalk color detection (supports-color sees CI → returns level 0).
  process.env.CURSOR_SKIP_KEYCHAIN = "1";

  const argv = process.argv.slice(2);

  if (argv.includes("-v") || argv.includes("--version")) {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
    console.log(`claude-overnight v${pkg.version}`);
    process.exit(0);
  }

  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(`
  ${chalk.bold("🌙  claude-overnight")} ${chalk.dim("v" + VERSION + "  -- background lane for your Claude Max plan")}
  ${chalk.dim("─".repeat(60))}

  ${chalk.cyan("Usage")}
    claude-overnight                          ${chalk.dim("interactive mode")}
    claude-overnight tasks.json               ${chalk.dim("task file mode")}
    claude-overnight "fix auth" "add tests"   ${chalk.dim("inline tasks")}

  ${chalk.cyan("Flags")}
    -h, --help             Show this help
    -v, --version          Print version
    --dry-run              Show planned tasks without running them
    --budget=N             Target number of agent runs ${chalk.dim("(default: 10)")}
    --concurrency=N        Max parallel agents ${chalk.dim("(default: 5)")}
    --model=NAME           Worker model override ${chalk.dim("(interactive mode picks planner + executor separately  -- supports 'Other…' for Qwen / OpenRouter / etc.)")}
    --fast-model=NAME      Fast model for quick tasks ${chalk.dim("(optional  -- checked by worker model in next wave)")}
    --usage-cap=N          Stop at N% utilization ${chalk.dim("(e.g. 90 to save 10% for other work)")}
    --allow-extra-usage    Allow extra/overage usage ${chalk.dim("(default: stop when plan limits hit)")}
    --extra-usage-budget=N Max $ for extra usage ${chalk.dim("(implies --allow-extra-usage)")}
    --timeout=SECONDS      Agent inactivity timeout ${chalk.dim("(default: 900s, nudges at timeout, kills at 2×)")}
    --no-flex              Disable adaptive multi-wave planning ${chalk.dim("(run all tasks in one shot)")}
    --worktrees            Force worktree isolation on ${chalk.dim("(default: auto-detect git repo)")}
    --no-worktrees         Disable worktree isolation ${chalk.dim("(all agents work in real cwd)")}
    --merge=MODE           Merge strategy: yolo or branch ${chalk.dim("(default: yolo)")}
    --perm=MODE            Permission mode: auto, bypassPermissions, default ${chalk.dim("(default: auto)")}
    --yolo                 Shorthand for --perm=bypassPermissions --no-worktrees

  ${chalk.cyan("Defaults")} ${chalk.dim("(non-interactive)")}
    model: first available    concurrency: 5    worktrees: auto    merge: yolo    perms: auto
    `);
    process.exit(0);
  }

  const dryRun = argv.includes("--dry-run");
  const { flags: cliFlags, positional: args } = parseCliFlags(argv);

  if (cliFlags.concurrency !== undefined) {
    const n = parseInt(cliFlags.concurrency);
    if (!Number.isInteger(n) || n < 1) { console.error(chalk.red(`  --concurrency must be a positive integer`)); process.exit(1); }
  }
  if (cliFlags.timeout !== undefined) {
    const n = parseFloat(cliFlags.timeout);
    if (isNaN(n) || n <= 0) { console.error(chalk.red(`  --timeout must be a positive number`)); process.exit(1); }
  }

  // ── Pre-check: warn if saved Cursor providers exist but proxy is down ──
  const savedCursorProviders = loadProviders().filter(isCursorProxyProvider);
  if (savedCursorProviders.length > 0 && !dryRun) {
    warnMacCursorAgentShellPatchIfNeeded();
    const proxyUp = await healthCheckCursorProxy();
    if (!proxyUp) {
      console.warn(chalk.yellow(`\n  ⚠ ${savedCursorProviders.length} Cursor provider(s) saved but proxy is not running at ${PROXY_DEFAULT_URL}`));
      {
        const cmd = bundledComposerProxyShellCommand();
        console.warn(chalk.yellow(cmd ? `    Start bundled proxy: ${cmd}` : `    Run npm install where claude-overnight is installed, then retry`));
      }
      console.warn(chalk.dim(`    (Continuing — you can still use Anthropic models)\n`));
    }
  }

  // ── Load tasks ──
  let tasks: Task[] = [];
  let fileCfg: FileArgs | undefined;
  const jsonFiles = args.filter(a => a.endsWith(".json"));
  if (jsonFiles.length > 1) { console.error(chalk.red(`  Multiple task files provided. Only one .json file is supported.`)); process.exit(1); }

  for (const arg of args) {
    if (arg.endsWith(".json")) {
      if (tasks.length > 0) { console.error(chalk.red(`  Cannot mix inline tasks with a task file. Use one or the other.`)); process.exit(1); }
      fileCfg = loadTaskFile(arg);
      tasks = fileCfg.tasks;
    } else if (!arg.startsWith("-") && existsSync(resolve(arg))) {
      console.error(chalk.red(`  "${arg}" looks like a file but doesn't end in .json. Rename it or quote the string.`));
      process.exit(1);
    } else {
      if (fileCfg) { console.error(chalk.red(`  Cannot mix inline tasks with a task file. Use one or the other.`)); process.exit(1); }
      tasks.push({ id: String(tasks.length), prompt: arg });
    }
  }

  // ── Mode detection ──
  // Stop the bin.ts startup splash (if any) before printing our header.
  (globalThis as any).__coStopSplash?.();
  console.log(`  ${chalk.bold("🌙  claude-overnight")} ${chalk.dim("v" + VERSION)}`);
  console.log(chalk.dim(`  ${"─".repeat(36)}`));

  const noTTY = !process.stdin.isTTY;
  const nonInteractive = noTTY || fileCfg !== undefined || tasks.length > 0;
  const cwd = fileCfg?.cwd ?? process.cwd();
  const allowedTools = fileCfg?.allowedTools;
  const beforeWave = fileCfg?.beforeWave;
  const afterWave = fileCfg?.afterWave;
  const afterRun = fileCfg?.afterRun;
  if (!existsSync(cwd)) { console.error(chalk.red(`  Working directory does not exist: ${cwd}`)); process.exit(1); }
  if (noTTY) console.log(chalk.dim("  Non-interactive mode  -- using defaults\n"));

  // ── Run history ──
  const rootDir = join(cwd, ".claude-overnight");
  const runsDir = join(rootDir, "runs");

  // Backfill run.json for pre-1.11.7 orphaned plans so they become visible
  // to the resume picker. One-shot, idempotent, silent if there's nothing.
  const backfilled = backfillOrphanedPlans(rootDir, cwd);
  if (backfilled > 0 && !noTTY) {
    console.log(chalk.dim(`\n  ↻ Recovered ${backfilled} orphaned plan${backfilled > 1 ? "s" : ""} from disk`));
  }

  const allRuns: { dir: string; state: RunState }[] = [];
  try {
    for (const d of readdirSync(runsDir).sort().reverse()) {
      const s = loadRunState(join(runsDir, d));
      if (s) allRuns.push({ dir: join(runsDir, d), state: s });
    }
  } catch {}
  const completedRuns = allRuns.filter(r => r.state.phase === "done" && r.state.cwd === cwd);
  if (completedRuns.length > 0 && !noTTY) {
    console.log(chalk.dim(`\n  ${completedRuns.length} previous run${completedRuns.length > 1 ? "s" : ""}`));
    for (const r of completedRuns.slice(0, 3)) {
      const date = r.state.startedAt?.slice(0, 10) || "unknown";
      const obj = r.state.objective?.slice(0, 50) || "";
      const cost = r.state.accCost > 0 ? ` · $${r.state.accCost.toFixed(0)}` : "";
      const merged = r.state.branches.filter(b => b.status === "merged").length;
      console.log(chalk.dim(`     ${date} · ${r.state.accCompleted} done · ${merged} merged${cost}${obj ? ` · ${obj}` : ""}${obj.length >= 50 ? "…" : ""}`));
      let status = "";
      try { status = readFileSync(join(r.dir, "status.md"), "utf-8").trim().split("\n")[0].slice(0, 80); } catch {}
      if (status) console.log(chalk.dim(`       ${status}`));
    }
  }

  // ── Resume / continue detection ──
  let resuming = false;
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
        try { lastStatus = readFileSync(join(run.dir, "status.md"), "utf-8").trim().slice(0, 120); } catch {}
        const planTaskCount = prev.phase === "planning" ? countTasksInFile(join(run.dir, "tasks.json")) : 0;
        console.log(chalk.yellow(`\n  ⚠ Unfinished run`) + chalk.dim(` · ${ago}`));
        const boxLines = prev.phase === "planning" ? [
          `${obj}${obj.length >= 50 ? "…" : ""}`,
          `Plan ready · ${planTaskCount} tasks · budget ${prev.budget} · ${prev.concurrency}× concurrent`,
          `Plan phase · not yet executing`,
        ] : [
          `${obj}${obj.length >= 50 ? "…" : ""}`,
          `${prev.accCompleted}/${prev.budget} sessions · ${Math.max(1, (prev.budget ?? 0) - prev.accCompleted)} remaining · $${prev.accCost.toFixed(2)}`,
          `Wave ${prev.waveNum + 1} · ${prev.phase}`,
        ];
        if (lastStatus) boxLines.push(lastStatus);
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
          try { lastStatus = readFileSync(join(shown[i].dir, "status.md"), "utf-8").trim().split("\n")[0].slice(0, 70); } catch {}
          console.log(chalk.cyan(`  ${i + 1}`) + `  ${obj}${obj.length >= 50 ? "…" : ""}`);
          if (s.phase === "planning") {
            const n = countTasksInFile(join(shown[i].dir, "tasks.json"));
            console.log(chalk.dim(`     plan ready · ${n} tasks · budget ${s.budget} · ${ago} · not yet executing`));
          } else {
            console.log(chalk.dim(`     ${s.accCompleted}/${s.budget} · $${s.accCost.toFixed(2)} · ${ago} · ${s.phase} at wave ${s.waveNum + 1}${merged ? ` · ${merged} merged` : ""}`));
          }
          if (lastStatus) console.log(chalk.dim(`     ${lastStatus}`));
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
            console.error(chalk.red(`\n  Planning-phase run has no usable tasks.json or designs  -- start Fresh instead.\n`));
            process.exit(1);
          }
          const remainingBudget = Math.max(resumeState.concurrency, resumeState.budget - resumeState.accCompleted);
          const orchBudget = Math.min(50, Math.max(resumeState.concurrency, Math.ceil(remainingBudget * 0.5)));
          const flexNote = `This is wave 1 of an adaptive multi-wave run (total budget: ${remainingBudget}). Plan the highest-impact foundational work first. Future waves will iterate based on what's learned.`;
          console.log(chalk.cyan(`\n  ◆ Re-orchestrating plan from existing designs...\n`));
          process.stdout.write("\x1B[?25l");
          try {
            const orchTasks = await orchestrate(
              resumeState.objective, designs, cwd, resumeState.plannerModel, resumeState.workerModel,
              resumeState.permissionMode, orchBudget, resumeState.concurrency, makeProgressLog(),
              flexNote, join(resumeRunDir, "tasks.json"),
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
      const unmerged = resumeState.branches.filter(b => b.status === "unmerged").length;
      if (unmerged > 0) {
        console.log("");
        autoMergeBranches(cwd, resumeState.branches, msg => console.log(chalk.dim(`  ${msg}`)));
        try { saveRunState(resumeRunDir, resumeState); } catch {}
      }
      await promptResumeOverrides(resumeState, cliFlags, argv, noTTY, resumeRunDir);
    }
  }

  // ── Config resolution ──
  let workerModel: string;
  let plannerModel: string;
  let fastModel: string | undefined;
  let workerProvider: ProviderConfig | undefined;
  let plannerProvider: ProviderConfig | undefined;
  let fastProvider: ProviderConfig | undefined;
  let budget: number | undefined;
  let concurrency: number;
  let objective: string | undefined = fileCfg?.objective;
  let usageCap: number | undefined;
  let allowExtraUsage = false;
  let extraUsageBudget: number | undefined;
  let permissionMode: PermMode = "auto";
  let useWorktrees = false;
  let mergeStrategy: MergeStrategy = "yolo";

  if (resuming) {
    workerModel = resumeState!.workerModel; plannerModel = resumeState!.plannerModel;
    fastModel = resumeState!.fastModel;
    const saved = loadProviders();
    const resolveProvider = (providerId: string | undefined, role: string): ProviderConfig | undefined => {
      if (!providerId) return undefined;
      const p = saved.find(s => s.id === providerId);
      if (!p) {
        console.error(chalk.red(`\n  Resume aborted: ${role} provider "${providerId}" is no longer in ~/.claude/claude-overnight/providers.json`));
        console.error(chalk.dim(`  Re-add it via a fresh run's "Other…" flow, or start Fresh instead.\n`));
        process.exit(1);
      }
      return p;
    };
    workerProvider = resolveProvider(resumeState!.workerProviderId, "worker");
    plannerProvider = resolveProvider(resumeState!.plannerProviderId, "planner");
    fastProvider = resolveProvider(resumeState!.fastProviderId, "fast");
    budget = resumeState!.budget; concurrency = resumeState!.concurrency;
    objective = resumeState!.objective; usageCap = resumeState!.usageCap;
    allowExtraUsage = resumeState!.allowExtraUsage ?? false;
    extraUsageBudget = resumeState!.extraUsageBudget;
    permissionMode = resumeState!.permissionMode;
    useWorktrees = resumeState!.useWorktrees;
    mergeStrategy = resumeState!.mergeStrategy;
  } else if (!nonInteractive) {
    if (continueObjective) {
      console.log(`\n  ${chalk.cyan("①")} ${chalk.bold("What should the agents do?")} ${chalk.dim("(Enter to continue last)")}\n  ${chalk.dim(continueObjective.slice(0, 80))}${continueObjective.length > 80 ? "…" : ""}`);
    }
    const objInput = (await ask(continueObjective
      ? `  ${chalk.cyan(">")} `
      : `\n  ${chalk.cyan("①")} ${chalk.bold("What should the agents do?")}\n  ${chalk.cyan(">")} `,
    )).trim();
    objective = objInput || continueObjective;
    if (!objective) { console.error(chalk.red("\n  No objective provided.")); process.exit(1); }
    const modelsPromise = fetchModels();
    const budgetAns = await ask(`\n  ${chalk.cyan("②")} ${chalk.dim("Budget")} ${chalk.dim("[")}${chalk.white("10")}${chalk.dim("]:")} `);
    budget = parseInt(budgetAns) || 10;
    if (budget < 1) { console.error(chalk.red(`  Budget must be a positive number`)); process.exit(1); }

    // ③ Max concurrency (skip if --concurrency set)
    if (cliFlags.concurrency) {
      concurrency = parseInt(cliFlags.concurrency);
    } else {
      const defaultC = Math.min(5, budget);
      const concAns = await ask(`\n  ${chalk.cyan("③")} ${chalk.dim("Max concurrency")} ${chalk.dim("[")}${chalk.white(String(defaultC))}${chalk.dim("]:")} `);
      concurrency = parseInt(concAns) || defaultC;
      if (concurrency < 1) concurrency = 1;
    }

    let modelFrame = 0;
    const modelSpinner = setInterval(() => {
      process.stdout.write(`\x1B[2K\r  ${chalk.cyan(BRAILLE[modelFrame++ % BRAILLE.length])} ${chalk.dim("loading models...")}`);
    }, 120);
    let models: Awaited<ReturnType<typeof fetchModels>>;
    try { models = await modelsPromise; } finally { clearInterval(modelSpinner); process.stdout.write(`\x1B[2K\r`); }
    const plannerPick = await pickModel(`${chalk.cyan("④")} Planner model ${chalk.dim("(thinking, steering  -- use your strongest)")}:`, models);
    plannerModel = plannerPick.model; plannerProvider = plannerPick.provider;
    const workerPick = await pickModel(`${chalk.cyan("⑤")} Executor model ${chalk.dim("(what runs the tasks  -- Qwen 3.6 Plus / OpenRouter / etc via Other…)")}:`, models);
    workerModel = workerPick.model; workerProvider = workerPick.provider;

    // ⑤b Optional fast model for quick tasks that will be verified
    const fastChoice = await select(`${chalk.cyan("⑤b")} Fast model ${chalk.dim("(optional  -- Haiku/Qwen for quick tasks, checked by worker)")}:`, [
      { name: "Skip", value: "skip" as const, hint: "two-tier mode only (current setup)" },
      { name: "Pick a fast model", value: "pick" as const, hint: "Haiku, Qwen, or any provider  -- for well-scoped tasks" },
    ]);
    if (fastChoice === "pick") {
      const fastPick = await pickModel(`${chalk.cyan("⑤c")} Fast model:`, models);
      fastModel = fastPick.model; fastProvider = fastPick.provider;
    }

    usageCap = await select(`${chalk.cyan("⑥")} Usage cap:`, [
      { name: "Unlimited", value: undefined as any, hint: "full capacity, wait through rate limits" },
      { name: "90%", value: 0.9, hint: "leave 10% for other work" },
      { name: "75%", value: 0.75, hint: "conservative, plenty of headroom" },
      { name: "50%", value: 0.5, hint: "use half, keep the rest" },
    ]);
    const extraChoice = await select(`${chalk.cyan("⑦")} Allow extra usage ${chalk.dim("(billed separately)")}:`, [
      { name: "No", value: "no", hint: "stop when plan limits are reached" },
      { name: "Yes, with $ limit", value: "budget", hint: "set a spending cap" },
      { name: "Yes, unlimited", value: "unlimited", hint: "keep going no matter what" },
    ]);
    if (extraChoice === "budget") {
      const budgetAns2 = await ask(`  ${chalk.dim("Max extra usage $:")} `);
      extraUsageBudget = parseFloat(budgetAns2);
      if (!extraUsageBudget || extraUsageBudget <= 0) extraUsageBudget = 5;
      allowExtraUsage = true;
    } else if (extraChoice === "unlimited") allowExtraUsage = true;

    // ⑧ Permission mode (skip if --yolo or --perm set)
    const cliYolo = argv.includes("--yolo");
    if (cliFlags.perm) {
      permissionMode = cliFlags.perm as PermMode;
    } else if (cliYolo) {
      permissionMode = "bypassPermissions";
    } else {
      permissionMode = await select(`${chalk.cyan("⑧")} Permissions:`, [
        { name: "Auto", value: "auto" as PermMode, hint: "accept low-risk, reject high-risk" },
        { name: "Bypass all", value: "bypassPermissions" as PermMode, hint: "agents can run anything (yolo)" },
        { name: "Prompt each", value: "default" as PermMode, hint: "ask for every dangerous op" },
      ]);
    }

    // ⑨ Worktrees + merge (skip if --yolo, --worktrees, --no-worktrees, or --merge set)
    const gitRepo = isGitRepo(cwd);
    if (cliYolo || argv.includes("--no-worktrees")) {
      useWorktrees = false;
      mergeStrategy = (cliFlags.merge as MergeStrategy) || "yolo";
    } else if (argv.includes("--worktrees")) {
      useWorktrees = true;
      mergeStrategy = (cliFlags.merge as MergeStrategy) || "yolo";
    } else if (gitRepo) {
      const wtChoice = await select(`${chalk.cyan("⑨")} Git isolation:`, [
        { name: "Worktrees + yolo merge", value: "wt-yolo", hint: "isolate agents, merge into current branch" },
        { name: "Worktrees + new branch", value: "wt-branch", hint: "isolate agents, merge into a new branch" },
        { name: "No worktrees", value: "no-wt", hint: "all agents share the working directory" },
      ]);
      useWorktrees = wtChoice !== "no-wt";
      mergeStrategy = wtChoice === "wt-branch" ? "branch" : "yolo";
    } else {
      useWorktrees = false;
      mergeStrategy = "yolo";
    }

    const parts: string[] = [];
    if (fastModel) parts.push(`${modelDisplayName(plannerModel)} → ${modelDisplayName(workerModel)} + ${modelDisplayName(fastModel)}`);
    else if (workerModel !== plannerModel) parts.push(`${modelDisplayName(workerModel)} → ${modelDisplayName(plannerModel)}`);
    else parts.push(modelDisplayName(workerModel));
    parts.push(`budget ${budget}`, `${concurrency}×`);
    if (budget > 2) parts.push("flex");
    if (usageCap != null) parts.push(`cap ${Math.round(usageCap * 100)}%`);
    parts.push(allowExtraUsage ? (extraUsageBudget ? `extra $${extraUsageBudget}` : "extra ∞") : "no extra");
    if (permissionMode !== "auto") parts.push(permissionMode === "bypassPermissions" ? "yolo" : "prompt");
    if (useWorktrees) parts.push(mergeStrategy === "branch" ? "wt→branch" : "wt→yolo");
    else parts.push("no wt");
    if (completedRuns.length > 0) parts.push(`${completedRuns.length} prior`);
    const inner = parts.join(chalk.dim(" · "));
    const innerLen = parts.join(" · ").length;
    console.log(chalk.dim(`\n  ╭${"─".repeat(innerLen + 4)}╮`));
    console.log(chalk.dim("  │") + `  ${inner}  ` + chalk.dim("│"));
    console.log(chalk.dim(`  ╰${"─".repeat(innerLen + 4)}╯`));
  } else {
    let models: Awaited<ReturnType<typeof fetchModels>> = [];
    if (!cliFlags.model && !fileCfg?.model) models = await fetchModels(5_000);
    // Multi-provider default resolution: match current ANTHROPIC_BASE_URL against
    // saved providers first, then fetched models, then other providers, then hardcoded
    // Anthropic default. Adding a new provider to providers.json automatically affects
    // the default without code changes.
    const activeBaseURL = process.env.ANTHROPIC_BASE_URL;
    const savedForCLI = loadProviders();
    const activeProvider = activeBaseURL ? savedForCLI.find(p => p.baseURL === activeBaseURL) : undefined;
    const defaultModel = activeProvider?.model
      ?? models[0]?.value
      ?? savedForCLI.find(p => p !== activeProvider)?.model
      ?? DEFAULT_MODEL;
    workerModel = cliFlags.model ?? fileCfg?.model ?? defaultModel;
    plannerModel = activeProvider?.model ?? models[0]?.value ?? workerModel;
    // Auto-resolve a saved custom provider if --model matches its id or model id.
    // Lets `claude-overnight --model=qwen3-coder-plus` route correctly without a separate flag.
    const matched = savedForCLI.find(p => p.id === workerModel || p.model === workerModel);
    if (matched) { workerProvider = matched; workerModel = matched.model; }
    // Fast model: --fast-model flag
    if (cliFlags["fast-model"]) {
      fastModel = cliFlags["fast-model"];
      const matchedFast = savedForCLI.find(p => p.id === fastModel || p.model === fastModel);
      if (matchedFast) { fastProvider = matchedFast; fastModel = matchedFast.model; }
    }
    concurrency = cliFlags.concurrency ? parseInt(cliFlags.concurrency) : (fileCfg?.concurrency ?? 5);
    budget = cliFlags.budget ? parseInt(cliFlags.budget) : undefined;
    if (budget != null && (isNaN(budget) || budget < 1)) { console.error(chalk.red(`  --budget must be a positive integer`)); process.exit(1); }
    const capFlag = cliFlags["usage-cap"];
    if (capFlag != null) {
      const capVal = parseFloat(capFlag);
      if (isNaN(capVal) || capVal < 0 || capVal > 100) { console.error(chalk.red(`  --usage-cap must be between 0 and 100 (got ${capFlag})`)); process.exit(1); }
      usageCap = capVal / 100;
    } else {
      usageCap = fileCfg?.usageCap != null ? fileCfg.usageCap / 100 : undefined;
    }
    allowExtraUsage = argv.includes("--allow-extra-usage");
    const extraBudgetFlag = cliFlags["extra-usage-budget"];
    if (extraBudgetFlag != null) {
      extraUsageBudget = parseFloat(extraBudgetFlag);
      if (isNaN(extraUsageBudget) || extraUsageBudget <= 0) { console.error(chalk.red(`  --extra-usage-budget must be a positive number`)); process.exit(1); }
      allowExtraUsage = true;
    }
  }

  validateConcurrency(concurrency);
  // Resolve permissionMode, useWorktrees, mergeStrategy for non-interactive + non-resume
  if (!resuming && nonInteractive) {
    const yolo = argv.includes("--yolo");
    permissionMode = cliFlags.perm ? cliFlags.perm as PermMode
      : yolo ? "bypassPermissions"
      : (fileCfg?.permissionMode ?? "auto");
    if (!["auto", "bypassPermissions", "default"].includes(permissionMode)) {
      console.error(chalk.red(`  --perm must be auto, bypassPermissions, or default (got ${permissionMode})`)); process.exit(1);
    }
    useWorktrees = argv.includes("--no-worktrees") || yolo ? false
      : argv.includes("--worktrees") ? true
      : (fileCfg?.useWorktrees ?? isGitRepo(cwd));
    mergeStrategy = cliFlags.merge ? cliFlags.merge as MergeStrategy
      : (fileCfg?.mergeStrategy ?? "yolo");
    if (!["yolo", "branch"].includes(mergeStrategy)) {
      console.error(chalk.red(`  --merge must be yolo or branch (got ${mergeStrategy})`)); process.exit(1);
    }
  }
  if (useWorktrees) validateGitRepo(cwd);

  // Custom-provider routing: build a model→env resolver so planner, worker,
  // and fast queries hit the right endpoint without touching process.env globally.
  const envForModel = buildEnvResolver({ plannerModel, plannerProvider, workerModel, workerProvider, fastModel, fastProvider });
  setPlannerEnvResolver(envForModel);

  // Fail fast if a custom provider is misconfigured  -- one bad key would
  // otherwise surface as N agent failures scattered across the run.
  // Skip when NO_PREFLIGHT=1 (used by e2e tests).
  if ((plannerProvider || workerProvider || fastProvider) && process.env.NO_PREFLIGHT !== "1") {
    const seen = new Set<string>();
    const all: Array<[string, ProviderConfig | undefined]> = [
      ["planner", plannerProvider],
      ["executor", workerProvider],
      ["fast", fastProvider],
    ];
    const pending: Array<[string, ProviderConfig]> = [];
    const cursorProxies: ProviderConfig[] = [];
    for (const [role, p] of all) {
      if (p && !seen.has(p.id)) {
        seen.add(p.id);
        pending.push([role, p]);
        if (isCursorProxyProvider(p)) cursorProxies.push(p);
      }
    }

    // Auto-start cursor proxy before pinging (restarts when a token exists so stale listeners get CURSOR_API_KEY).
    if (cursorProxies.length > 0) {
      await ensureCursorProxyRunning();
      if (!hasCursorAgentToken()) {
        console.error(chalk.red(
          `  ✗ Cursor models require a User API key — add it via ${chalk.bold("Cursor…")} setup, or set ` +
          `${chalk.bold("CURSOR_API_KEY")} / ${chalk.bold("CURSOR_BRIDGE_API_KEY")}, or ${chalk.bold("cursorApiKey")} in providers.json.`,
        ));
        console.error(chalk.dim(`    Without it the Cursor CLI falls back to macOS Keychain (\`cursor-user\`).`));
        process.exit(1);
      }
    }

    process.stdout.write(`  ${chalk.dim(`◆ Pinging ${pending.map(([r, p]) => `${r} (${p.displayName})`).join(", ")}…`)}\n`);
    // Cursor proxy: each saved model is a distinct provider id (`cursor-composer-2`, etc.), so
    // planner + executor + fast can schedule multiple preflights. The bundled proxy typically
    // handles one agent query at a time — parallel preflights starve each other and hit the
    // 20s timeout. Run non-proxy checks in parallel, then cursor proxy checks one at a time
    // (preserve original `pending` order for messages).
    const progress = (msg: string) => process.stdout.write(chalk.dim(`    ${msg}\n`));
    /** Cursor agent cold start + model variance can exceed 20s; API providers stay tight. */
    const preflightMs = (p: ProviderConfig) =>
      isCursorProxyProvider(p) ? 60_000 : 20_000;
    const nonCursorIdx: number[] = [];
    const cursorIdx: number[] = [];
    for (let i = 0; i < pending.length; i++) {
      if (isCursorProxyProvider(pending[i]![1])) cursorIdx.push(i);
      else nonCursorIdx.push(i);
    }
    const slot: Array<{ role: string; provider: ProviderConfig; result: Awaited<ReturnType<typeof preflightProvider>> } | undefined> =
      Array.from({ length: pending.length });
    await Promise.all(nonCursorIdx.map(async (i) => {
      const [role, p] = pending[i]!;
      slot[i] = { role, provider: p, result: await preflightProvider(p, cwd, preflightMs(p), { onProgress: progress }) };
    }));
    for (const i of cursorIdx) {
      const [role, p] = pending[i]!;
      slot[i] = { role, provider: p, result: await preflightProvider(p, cwd, preflightMs(p), { onProgress: progress }) };
    }
    const results = slot as Array<{ role: string; provider: ProviderConfig; result: Awaited<ReturnType<typeof preflightProvider>> }>;
    for (const { role, provider, result } of results) {
      if (!result.ok) {
        console.error(chalk.red(`  ✗ ${role} preflight failed: ${chalk.dim(result.error)}`));
        if (isCursorProxyProvider(provider)) {
          {
            const cmd = bundledComposerProxyShellCommand();
            console.error(chalk.yellow(
              `  The proxy at ${PROXY_DEFAULT_URL} may have crashed or timed out (e.g. keychain/UI). Retry, or start the bundled proxy: ${cmd ?? "npm install in the claude-overnight package, then re-run"}`,
            ));
          }
        } else {
          console.error(chalk.red(`  Fix the provider at ~/.claude/claude-overnight/providers.json and retry.`));
        }
        console.error("");
        process.exit(1);
      }
      console.log(`  ${chalk.green(`✓ ${role} ready`)} ${chalk.dim(`· ${provider.displayName} · ${provider.model}`)}`);
    }
  }

  if (nonInteractive) {
    const capStr = usageCap != null ? `  cap=${Math.round(usageCap * 100)}%` : "";
    const extraStr = allowExtraUsage ? (extraUsageBudget ? `  extra=$${extraUsageBudget}` : "  extra=∞") : "  extra=off";
    console.log(chalk.dim(`  ${workerModel}  concurrency=${concurrency}  worktrees=${useWorktrees}  merge=${mergeStrategy}  perms=${permissionMode}${capStr}${extraStr}`));
  }

  // ── Plan phase ──
  let flex = !argv.includes("--no-flex") && (fileCfg?.flexiblePlan ?? objective != null) && objective != null && (budget ?? 10) > 2;
  const agentTimeoutMs = cliFlags.timeout ? parseFloat(cliFlags.timeout) * 1000 : undefined;
  let thinkingUsed = 0, thinkingCost = 0, thinkingIn = 0, thinkingOut = 0, thinkingTools = 0;
  let thinkingHistory: WaveSummary | undefined;

  const orphanedDir = !resuming ? findOrphanedDesigns(rootDir) : null;
  const runDir = resuming && resumeRunDir ? resumeRunDir : (orphanedDir ?? createRunDir(rootDir));
  if (resuming && resumeRunDir) updateLatestSymlink(rootDir, resumeRunDir);
  const previousKnowledge = readPreviousRunKnowledge(rootDir);

  const needsPlan = tasks.length === 0 && !resuming;
  const designDir = join(runDir, "designs");

  // Persist an early planning-phase state so the run is visible to the resume
  // picker even if orchestrate dies before executeRun gets a chance to run.
  // Without this, a crashed plan phase leaves no run.json and the run vanishes
  // from findIncompleteRuns  -- you pay for orchestration and can't see it.
  if (needsPlan && objective) {
    try {
      saveRunState(runDir, {
        id: runDir.split(/[/\\]/).pop() ?? "",
        objective, budget: budget ?? 10, remaining: budget ?? 10,
        workerModel, plannerModel,
        workerProviderId: workerProvider?.id, plannerProviderId: plannerProvider?.id,
        concurrency, permissionMode,
        usageCap, allowExtraUsage, extraUsageBudget,
        flex, useWorktrees, mergeStrategy,
        waveNum: 0, currentTasks: [],
        accCost: 0, accCompleted: 0, accFailed: 0,
        accIn: 0, accOut: 0, accTools: 0,
        branches: [],
        phase: "planning",
        startedAt: new Date().toISOString(),
        cwd,
      });
    } catch {}
  }

  if (needsPlan) {
    if (noTTY) { console.error(chalk.red("  No tasks provided and stdin is not a TTY.")); process.exit(1); }
    process.stdout.write("\x1B[?25l");
    const planRestore = () => process.stdout.write("\x1B[?25h");
    const useThinking = flex && (budget ?? 10) > concurrency * 3;
    const thinkingCount = useThinking ? Math.min(Math.max(concurrency, Math.ceil((budget ?? 10) * 0.005)), 10) : 0;

    try {
      if (useThinking) {
        let themes = await identifyThemes(objective!, thinkingCount, cwd, plannerModel, permissionMode, makeProgressLog());
        process.stdout.write(`\x1B[2K\r  ${chalk.green(`✓ ${themes.length} themes`)}\n\n`);
        planRestore();
        let reviewing = true;
        while (reviewing) {
          for (let i = 0; i < themes.length; i++) console.log(chalk.dim(`  ${String(i + 1).padStart(3)}.`) + ` ${themes[i]}`);
          console.log(chalk.dim(`\n  ${thinkingCount} thinking agents → orchestrate → ${(budget ?? 10) - thinkingCount} execution sessions\n`));
          const action = await selectKey(`${chalk.white(`${themes.length} themes`)} ${chalk.dim(`· ${thinkingCount} thinking · ${concurrency} concurrent`)}`, [{ key: "r", desc: "un" }, { key: "e", desc: "dit" }, { key: "c", desc: "hat" }, { key: "q", desc: "uit" }]);
          if (action === "r") { reviewing = false; break; }
          if (action === "e") {
            const feedback = await ask(`\n  ${chalk.bold("What should change?")}\n  ${chalk.cyan(">")} `);
            if (!feedback) continue;
            process.stdout.write("\x1B[?25l");
            try { themes = await identifyThemes(`${objective!}\n\nUser feedback: ${feedback}`, thinkingCount, cwd, plannerModel, permissionMode, makeProgressLog()); process.stdout.write(`\x1B[2K\r  ${chalk.green(`✓ ${themes.length} themes`)}\n\n`); }
            catch (err: any) { console.error(chalk.red(`\n  Re-planning failed: ${err.message}\n`)); }
            planRestore();
          } else if (action === "c") {
            const question = await ask(`\n  ${chalk.bold("Ask about the themes:")}\n  ${chalk.cyan(">")} `);
            if (!question) continue;
            process.stdout.write("\x1B[?25l");
            try {
              let answer = "";
              const plannerEnv = envForModel(plannerModel);
              for await (const msg of query({
                prompt: `You're planning work for: "${objective}"\n\nThemes identified:\n${themes.map((t, i) => `${i + 1}. ${t}`).join("\n")}\n\nUser question: ${question}`,
                options: { cwd, model: plannerModel, permissionMode, persistSession: false, ...(plannerEnv && { env: plannerEnv }) },
              })) { if (msg.type === "result" && msg.subtype === "success") answer = (msg as any).result || ""; }
              planRestore();
              if (answer) console.log(chalk.dim(`\n  ${answer.slice(0, 500)}\n`));
            } catch { planRestore(); }
          } else { console.log(chalk.dim("\n  Aborted.\n")); process.exit(0); }
        }
        process.stdout.write("\x1B[?25l");

        mkdirSync(designDir, { recursive: true });
        const existingDesigns = readMdDir(designDir);
        if (existingDesigns) {
          const designFiles = readdirSync(designDir).filter(f => f.endsWith(".md")).sort();
          console.log(chalk.green(`\n  ✓ Reusing ${designFiles.length} design docs`) + chalk.dim(` (from prior attempt)`));
          for (const f of designFiles) {
            try { const firstLine = readFileSync(join(designDir, f), "utf-8").split("\n")[0].replace(/^#+\s*/, "").trim(); if (firstLine) console.log(chalk.dim(`    ${firstLine.slice(0, 80)}`)); } catch {}
          }
          console.log("");
        } else {
          const thinkingTasks = buildThinkingTasks(objective!, themes, designDir, plannerModel, previousKnowledge || undefined);
          console.log(chalk.cyan(`\n  ◆ Thinking: ${thinkingTasks.length} agents exploring...\n`));
          const thinkingSwarm = new Swarm({
            tasks: thinkingTasks, concurrency, cwd, model: plannerModel, permissionMode,
            useWorktrees: false, mergeStrategy: "yolo", agentTimeoutMs, usageCap, allowExtraUsage, extraUsageBudget,
            envForModel,
            cursorProxy: [plannerProvider, workerProvider, fastProvider].some(p => p && isCursorProxyProvider(p)),
          });
          const thinkRunInfo = { accIn: 0, accOut: 0, accCost: 0, accCompleted: 0, accFailed: 0, sessionsBudget: budget ?? 10, waveNum: -1, remaining: budget ?? 10, model: plannerModel, startedAt: Date.now() };
          const thinkDisplay = new RunDisplay(thinkRunInfo, { remaining: 0, usageCap, concurrency, paused: false, dirty: false });
          thinkDisplay.setWave(thinkingSwarm);
          thinkDisplay.start();
          // Save thinking-wave state on every exit path (normal, abort, double-q).
          const saveThinkingState = () => {
            thinkingUsed = thinkingSwarm.completed + thinkingSwarm.failed;
            thinkingCost = thinkingSwarm.totalCostUsd; thinkingIn = thinkingSwarm.totalInputTokens; thinkingOut = thinkingSwarm.totalOutputTokens;
            thinkingTools = thinkingSwarm.agents.reduce((sum, a) => sum + a.toolCalls, 0);
            try {
              saveRunState(runDir, {
                id: runDir.split(/[/\\]/).pop() ?? "",
                objective: objective!, budget: budget ?? 10, remaining: (budget ?? 10) - thinkingUsed,
                workerModel, plannerModel,
                workerProviderId: workerProvider?.id, plannerProviderId: plannerProvider?.id,
                concurrency, permissionMode,
                usageCap, allowExtraUsage, extraUsageBudget,
                flex, useWorktrees, mergeStrategy,
                waveNum: 0, currentTasks: [],
                accCost: thinkingCost, accCompleted: thinkingUsed, accFailed: 0,
                accIn: thinkingIn, accOut: thinkingOut, accTools: thinkingTools,
                branches: [],
                phase: "planning",
                startedAt: new Date().toISOString(),
                cwd,
              });
            } catch {}
          };
          // Catch double-q / hard exit during thinking wave
          const exitHandler = () => { try { saveThinkingState(); } catch {} };
          process.on("exit", exitHandler);
          try { await thinkingSwarm.run(); } finally {
            thinkDisplay.pause(); console.log(renderSummary(thinkingSwarm)); thinkDisplay.stop();
            saveThinkingState();
            process.removeListener("exit", exitHandler);
          }
          thinkingHistory = { wave: -1, tasks: thinkingSwarm.agents.map(a => ({ prompt: a.task.prompt.slice(0, 200), status: a.status, filesChanged: a.filesChanged, error: a.error })) };
          if (thinkingSwarm.rateLimitResetsAt) {
            const waitMs = thinkingSwarm.rateLimitResetsAt - Date.now();
            if (waitMs > 0) { console.log(chalk.dim(`  Waiting ${Math.ceil(waitMs / 1000)}s for rate limit reset...`)); await new Promise(r => setTimeout(r, waitMs + 2000)); }
          }
        }

        const designs = readMdDir(designDir);
        const taskFile = join(runDir, "tasks.json");
        if (designs) {
          const orchBudget = Math.min(50, Math.max(concurrency, Math.ceil(((budget ?? 10) - thinkingUsed) * 0.5)));
          const flexNote = `This is wave 1 of an adaptive multi-wave run (total budget: ${(budget ?? 10) - thinkingUsed}). Plan the highest-impact foundational work first. Future waves will iterate based on what's learned.`;
          console.log(chalk.cyan(`\n  ◆ Orchestrating plan...\n`));
          tasks = await orchestrate(objective!, designs, cwd, plannerModel, workerModel, permissionMode, orchBudget, concurrency, makeProgressLog(), flexNote, taskFile);
          process.stdout.write(`\x1B[2K\r  ${chalk.green(`✓ ${tasks.length} tasks`)}\n\n`);
        } else {
          console.log(chalk.yellow(`\n  No design docs  -- falling back to direct planning\n`));
          const waveBudget = Math.min(50, Math.max(concurrency, Math.ceil(((budget ?? 10) - thinkingUsed) * 0.5)));
          tasks = await planTasks(objective!, cwd, plannerModel, workerModel, permissionMode, waveBudget, concurrency, makeProgressLog(), undefined, taskFile);
          process.stdout.write(`\x1B[2K\r  ${chalk.green(`✓ ${tasks.length} tasks`)}\n\n`);
        }
      } else {
        const waveBudget = flex ? Math.min(50, Math.max(concurrency, Math.ceil((budget ?? 10) * 0.5))) : budget;
        const flexNote = flex ? `This is wave 1 of an adaptive multi-wave run (total budget: ${budget}). Plan the highest-impact foundational work first. Future waves will iterate, polish, and expand based on what's learned.` : undefined;
        console.log(chalk.cyan(`\n  ◆ Planning${flex ? " wave 1" : ""}...\n`));
        tasks = await planTasks(objective!, cwd, plannerModel, workerModel, permissionMode, waveBudget, concurrency, makeProgressLog(), flexNote);
        process.stdout.write(`\x1B[2K\r  ${chalk.green(`✓ ${tasks.length} tasks`)}${flex ? chalk.dim(` · wave 1`) : ""}\n\n`);
        planRestore();
        let reviewing = true;
        while (reviewing) {
          showPlan(tasks);
          const action = await selectKey(`${chalk.white(`${tasks.length} tasks`)} ${chalk.dim(`· ${concurrency} concurrent`)}`, [{ key: "r", desc: "un" }, { key: "e", desc: "dit" }, { key: "c", desc: "hat" }, { key: "q", desc: "uit" }]);
          switch (action) {
            case "r": reviewing = false; break;
            case "e": {
              const feedback = await ask(`\n  ${chalk.bold("What should change?")}\n  ${chalk.cyan(">")} `);
              if (!feedback) break;
              console.log(chalk.cyan("\n  ◆ Re-planning...\n"));
              process.stdout.write("\x1B[?25l");
              try { tasks = await refinePlan(objective!, tasks, feedback, cwd, plannerModel, workerModel, permissionMode, budget, concurrency, makeProgressLog()); process.stdout.write(`\x1B[2K\r  ${chalk.green(`✓ ${tasks.length} tasks`)}\n\n`); }
              catch (err: any) { console.error(chalk.red(`\n  Re-planning failed: ${err.message}\n`)); }
              planRestore();
              break;
            }
            case "c": {
              const question = await ask(`\n  ${chalk.bold("Ask about the plan:")}\n  ${chalk.cyan(">")} `);
              if (!question) break;
              process.stdout.write("\x1B[?25l");
              try {
                let answer = "";
                const plannerEnv = envForModel(plannerModel);
                for await (const msg of query({
                  prompt: `You planned these tasks for the objective "${objective}":\n${tasks.map((t, i) => `${i + 1}. ${t.prompt}`).join("\n")}\n\nUser question: ${question}`,
                  options: { cwd, model: plannerModel, permissionMode, persistSession: false, ...(plannerEnv && { env: plannerEnv }) },
                })) { if (msg.type === "result" && msg.subtype === "success") answer = (msg as any).result || ""; }
                planRestore();
                if (answer) console.log(chalk.dim(`\n  ${answer.slice(0, 500)}\n`));
              } catch { planRestore(); }
              break;
            }
            case "q": console.log(chalk.dim("\n  Aborted.\n")); process.exit(0);
          }
        }
      }
    } catch (err: any) {
      planRestore();
      if (isAuthError(err)) console.error(chalk.red(`\n  Authentication failed  -- check your API key or run: claude auth\n`));
      else console.error(chalk.red(`\n  Planning failed: ${err.message}\n`));
      process.exit(1);
    }
  }

  if (tasks.length === 0 && !resuming) { console.error("No tasks provided."); process.exit(1); }

  if (dryRun) { showPlan(tasks); console.log(chalk.dim("  --dry-run: exiting without running\n")); process.exit(0); }

  // ── Execute ──
  await executeRun({
    tasks, objective, budget: budget ?? tasks.length, workerModel, plannerModel, fastModel,
    workerProvider, plannerProvider, fastProvider, concurrency,
    permissionMode, useWorktrees, mergeStrategy, usageCap, allowExtraUsage, extraUsageBudget,
    flex, agentTimeoutMs, cwd, allowedTools, beforeWave, afterWave, afterRun, runDir, previousKnowledge,
    resuming, resumeState: resumeState ?? undefined,
    thinkingUsed, thinkingCost, thinkingIn, thinkingOut, thinkingTools, thinkingHistory,
    runStartedAt: resuming && resumeState?.startedAt ? new Date(resumeState.startedAt).getTime() : Date.now(),
  });
}

main().catch((err) => {
  process.stdout.write("\x1B[?25h");
  console.error(chalk.red(err.message || err));
  process.exit(1);
});
