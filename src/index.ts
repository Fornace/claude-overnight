#!/usr/bin/env node
import { readFileSync, existsSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { createInterface } from "readline";
import chalk from "chalk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { Swarm } from "./swarm.js";
import { planTasks } from "./planner.js";
import { startRenderLoop } from "./ui.js";
import type { Task, TaskFile, PermMode, MergeStrategy } from "./types.js";

// ── Fetch models via SDK (works with OAuth / Max / API key) ──

async function fetchModels(): Promise<ModelInfo[]> {
  try {
    const q = query({ prompt: "", options: { persistSession: false } });
    const models = await q.supportedModels();
    q.close();
    return models;
  } catch {
    return [];
  }
}

// ── Interactive prompts ──

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question(question, (answer) => {
      rl.close();
      res(answer.trim());
    });
  });
}

async function pickModel(models: ModelInfo[]): Promise<string> {
  if (models.length === 0) {
    console.log(chalk.yellow("  Could not fetch models. Enter model ID manually."));
    const ans = await ask(chalk.dim("  Model: "));
    return ans || "claude-sonnet-4-6";
  }
  console.log(chalk.bold("\n  Model:"));
  for (let i = 0; i < models.length; i++) {
    const marker = i === 0 ? chalk.green("→") : " ";
    const name = models[i].displayName;
    const desc = models[i].description ? chalk.dim(` — ${models[i].description}`) : "";
    const label = i === 0 ? chalk.green(name) + desc : chalk.dim(name) + desc;
    console.log(`  ${marker} ${i + 1}. ${label}`);
  }
  const ans = await ask(chalk.dim(`  Choose [1]: `));
  const idx = ans ? parseInt(ans) - 1 : 0;
  const pick = models[idx] ?? models[0];
  console.log(chalk.dim(`  Using ${pick.displayName}`));
  return pick.value;
}

async function pickConcurrency(): Promise<number> {
  const ans = await ask(chalk.dim("  Concurrency [5]: "));
  return parseInt(ans) || 5;
}

async function pickWorktrees(): Promise<boolean> {
  const ans = await ask(chalk.dim("  Use git worktrees? [Y/n]: "));
  return ans.toLowerCase() !== "n";
}

async function pickMergeStrategy(): Promise<MergeStrategy> {
  console.log(chalk.bold("\n  Merge strategy:"));
  console.log(`  ${chalk.green("→")} 1. ${chalk.green("YOLO")}${chalk.dim(" — merge into current branch")}`);
  console.log(`    2. ${chalk.dim("New branch")}${chalk.dim(" — merge into a new branch (safe for PRs)")}`);
  const ans = await ask(chalk.dim("  Choose [1]: "));
  const pick = ans === "2" ? "branch" : "yolo";
  console.log(chalk.dim(`  Using ${pick === "yolo" ? "YOLO (merge into current)" : "new branch"}`));
  return pick;
}

const PERM_MODES: { label: string; value: PermMode; desc: string }[] = [
  { label: "Auto", value: "auto", desc: "AI decides what's safe" },
  { label: "Bypass permissions", value: "bypassPermissions", desc: "skip all prompts (dangerous)" },
  { label: "Default", value: "default", desc: "prompt for dangerous ops" },
];

async function pickPermissionMode(): Promise<PermMode> {
  console.log(chalk.bold("\n  Permission mode:"));
  for (let i = 0; i < PERM_MODES.length; i++) {
    const marker = i === 0 ? chalk.green("→") : " ";
    const name = i === 0 ? chalk.green(PERM_MODES[i].label) : chalk.dim(PERM_MODES[i].label);
    const desc = chalk.dim(` — ${PERM_MODES[i].desc}`);
    console.log(`  ${marker} ${i + 1}. ${name}${desc}`);
  }
  const ans = await ask(chalk.dim("  Choose [1]: "));
  const idx = ans ? parseInt(ans) - 1 : 0;
  const pick = PERM_MODES[idx] ?? PERM_MODES[0];
  console.log(chalk.dim(`  Using ${pick.label}`));
  return pick.value;
}

async function pickObjective(): Promise<string> {
  console.log("");
  const ans = await ask(chalk.bold("  What should the swarm do?\n  > "));
  return ans;
}

// ── File-based task loading (non-interactive) ──

interface FileArgs {
  tasks: Task[];
  concurrency?: number;
  model?: string;
  permissionMode?: PermMode;
  cwd?: string;
  allowedTools?: string[];
  useWorktrees?: boolean;
  mergeStrategy?: MergeStrategy;
}

const KNOWN_TASK_FILE_KEYS = new Set([
  "tasks", "concurrency", "cwd", "model", "permissionMode", "allowedTools", "worktrees", "mergeStrategy",
]);

function loadTaskFile(file: string): FileArgs {
  const path = resolve(file);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    throw new Error(`Cannot read task file: ${path}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`Task file is not valid JSON: ${path}`);
  }

  const parsed: TaskFile & { worktrees?: boolean; permissionMode?: PermMode } = Array.isArray(json)
    ? { tasks: json }
    : json as any;

  // Reject unknown top-level keys
  if (!Array.isArray(json) && typeof json === "object" && json !== null) {
    const unknown = Object.keys(json).filter((k) => !KNOWN_TASK_FILE_KEYS.has(k));
    if (unknown.length > 0) {
      throw new Error(
        `Unknown key${unknown.length > 1 ? "s" : ""} in task file: ${unknown.join(", ")}. ` +
        `Allowed keys: ${[...KNOWN_TASK_FILE_KEYS].join(", ")}`,
      );
    }
  }

  // Validate tasks array
  if (!Array.isArray(parsed.tasks)) {
    throw new Error(`Task file must contain a "tasks" array (got ${typeof parsed.tasks})`);
  }

  const tasks: Task[] = [];
  for (let i = 0; i < parsed.tasks.length; i++) {
    const t = parsed.tasks[i];
    const id = String(tasks.length);
    if (typeof t === "string") {
      if (!t.trim()) throw new Error(`Task ${i} is an empty string`);
      tasks.push({ id, prompt: t });
    } else if (typeof t === "object" && t !== null) {
      if (typeof t.prompt !== "string" || !t.prompt.trim()) {
        throw new Error(`Task ${i} is missing a "prompt" string`);
      }
      tasks.push({ id, prompt: t.prompt, cwd: t.cwd ? resolve(t.cwd) : undefined, model: t.model });
    } else {
      throw new Error(`Task ${i} must be a string or object with a "prompt" field (got ${typeof t})`);
    }
  }

  // Validate concurrency if present
  if (parsed.concurrency !== undefined) {
    validateConcurrency(parsed.concurrency);
  }

  return {
    tasks,
    concurrency: parsed.concurrency,
    model: parsed.model,
    cwd: parsed.cwd ? resolve(parsed.cwd) : undefined,
    permissionMode: parsed.permissionMode,
    allowedTools: parsed.allowedTools,
    useWorktrees: parsed.worktrees,
    mergeStrategy: (parsed as any).mergeStrategy,
  };
}

// ── Validation helpers ──

function validateConcurrency(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`Concurrency must be a positive integer (got ${JSON.stringify(value)})`);
  }
}

function validateCwd(cwd: string): void {
  if (!existsSync(cwd)) {
    throw new Error(`Working directory does not exist: ${cwd}`);
  }
}

function isGitRepo(cwd: string): boolean {
  try {
    execSync("git rev-parse --git-dir", { cwd, encoding: "utf-8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function validateGitRepo(cwd: string): void {
  if (!isGitRepo(cwd)) {
    throw new Error(
      `Worktrees require a git repository, but ${cwd} is not inside one. ` +
      `Run "git init" first or disable worktrees.`,
    );
  }
}

// ── Main ──

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes("-v") || argv.includes("--version")) {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
    console.log(`claude-swarm v${pkg.version}`);
    process.exit(0);
  }

  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(`
  ${chalk.bold("claude-swarm")} — parallel Claude Code agents with real-time UI

  ${chalk.dim("Usage:")}
    claude-swarm                          ${chalk.dim("interactive — pick model, concurrency, objective")}
    claude-swarm tasks.json               ${chalk.dim("run tasks defined in a JSON file")}
    claude-swarm "fix auth" "add tests"   ${chalk.dim("run inline tasks in parallel")}

  ${chalk.dim("Flags:")}
    -h, --help       Show this help
    -v, --version    Print version
    --dry-run        Show planned tasks without running them

  ${chalk.dim("Permission modes")} ${chalk.dim("(task file: \"permissionMode\", interactive: prompted)")}
    auto               AI decides which ops are safe ${chalk.dim("(default)")}
    bypassPermissions  Skip all permission prompts ${chalk.yellow("(dangerous)")}
    default            Prompt before destructive operations

  ${chalk.dim("Non-interactive defaults (task file / inline / piped):")}
    model: first available    concurrency: 5    worktrees: auto (git repo)    perms: auto
    `);
    process.exit(0);
  }

  const dryRun = argv.includes("--dry-run");
  const args = argv.filter((a) => !a.startsWith("--"));

  // ── Load tasks from file or inline args ──
  let tasks: Task[] = [];
  let fileCfg: FileArgs | undefined;

  for (const arg of args) {
    if (arg.endsWith(".json")) {
      fileCfg = loadTaskFile(arg);
      tasks = fileCfg.tasks;
    } else {
      tasks.push({ id: String(tasks.length), prompt: arg });
    }
  }

  // ── Config: defaults for non-interactive, prompts for interactive ──
  console.log(chalk.bold("\n  🐝 claude-swarm\n"));

  const noTTY = !process.stdin.isTTY;
  const nonInteractive = noTTY || fileCfg !== undefined || tasks.length > 0;
  const cwd = fileCfg?.cwd ?? process.cwd();
  const allowedTools = fileCfg?.allowedTools;
  validateCwd(cwd);

  if (noTTY) {
    console.log(chalk.dim("  Non-interactive mode — using defaults"));
  }

  let models: ModelInfo[] = [];
  if (!nonInteractive) {
    process.stdout.write(chalk.dim("  Fetching available models..."));
    models = await fetchModels();
    process.stdout.write(`\x1B[2K\r`);
  }

  const model = fileCfg?.model ?? (nonInteractive ? (models[0]?.value || "claude-sonnet-4-6") : await pickModel(models));
  const permissionMode = fileCfg?.permissionMode ?? (nonInteractive ? "auto" as PermMode : await pickPermissionMode());
  const concurrency = fileCfg?.concurrency ?? (nonInteractive ? 5 : await pickConcurrency());
  validateConcurrency(concurrency);
  const useWorktrees = fileCfg?.useWorktrees ?? (nonInteractive ? (noTTY ? false : isGitRepo(cwd)) : await pickWorktrees());
  if (useWorktrees) validateGitRepo(cwd);
  const mergeStrategy = fileCfg?.mergeStrategy ?? (useWorktrees && !nonInteractive ? await pickMergeStrategy() : "yolo");

  if (nonInteractive) {
    console.log(chalk.dim(`  ${model}  concurrency=${concurrency}  worktrees=${useWorktrees}  merge=${mergeStrategy}  perms=${permissionMode}`));
  }

  // If no tasks yet, ask for an objective and plan
  let planMode = tasks.length === 0;
  let objective: string | undefined;

  if (planMode) {
    if (noTTY) {
      console.error(chalk.red("\n  No tasks provided and stdin is not a TTY. Provide tasks via args or a JSON file."));
      process.exit(1);
    }
    objective = await pickObjective();
    if (!objective) {
      console.error(chalk.red("\n  No objective provided."));
      process.exit(1);
    }
  }

  // Hide cursor + graceful shutdown (swarm-aware handler installed after swarm is created)
  process.stdout.write("\x1B[?25l");
  const restore = () => process.stdout.write("\x1B[?25h\n");
  process.on("SIGINT", () => { restore(); process.exit(0); });
  process.on("SIGTERM", () => { restore(); process.exit(0); });


  // ── Plan phase ──
  if (planMode && objective) {
    console.log(chalk.magenta("\n  Planning...\n"));
    try {
      tasks = await planTasks(objective, cwd, model, permissionMode, (text) => {
        process.stdout.write(`\x1B[2K\r  ${chalk.dim(text)}`);
      });
      process.stdout.write(
        `\x1B[2K\r  ${chalk.green(`Generated ${tasks.length} tasks`)}\n\n`,
      );
      for (const t of tasks) {
        console.log(chalk.dim(`    ${t.id}. ${t.prompt.slice(0, 70)}`));
      }
      console.log("");
      await sleep(1500);
    } catch (err: any) {
      restore();
      console.error(chalk.red(`\n  Planning failed: ${err.message}\n`));
      process.exit(1);
    }
  }

  if (tasks.length === 0) {
    restore();
    console.error("No tasks provided.");
    process.exit(1);
  }

  if (dryRun) {
    restore();
    console.log(chalk.bold("  Tasks:"));
    for (const t of tasks) {
      console.log(`  ${chalk.dim(`${Number(t.id) + 1}.`)} ${t.prompt}`);
    }
    console.log("");
    process.exit(0);
  }

  const swarm = new Swarm({
    tasks,
    concurrency,
    cwd,
    model,
    permissionMode,
    allowedTools,
    useWorktrees,
    mergeStrategy,
  });

  // Replace simple handlers with graceful drain: first signal stops queue, second force-exits
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
  let stopping = false;

  const gracefulStop = (signal: string) => {
    if (stopping) { swarm.cleanup(); restore(); process.exit(0); }
    stopping = true;
    process.stdout.write(`\n  ${chalk.yellow(`${signal}: stopping... waiting for ${swarm.active} active agent(s) to finish (send again to force)`)}\n`);
    swarm.abort();
  };

  process.on("SIGINT", () => gracefulStop("SIGINT"));
  process.on("SIGTERM", () => gracefulStop("SIGTERM"));

  process.on("uncaughtException", (err) => {
    swarm.abort();
    swarm.cleanup();
    restore();
    console.error(chalk.red(`\n  Uncaught exception: ${err.message}`));
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    swarm.abort();
    swarm.cleanup();
    restore();
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error(chalk.red(`\n  Unhandled rejection: ${msg}`));
    process.exit(1);
  });

  const stopRender = startRenderLoop(swarm);

  try {
    await swarm.run();
  } finally {
    stopRender();

    const summary =
      swarm.failed > 0
        ? chalk.yellow(`${swarm.completed} done, ${swarm.failed} failed`)
        : chalk.green(`${swarm.completed} done`);
    const cost =
      swarm.totalCostUsd > 0
        ? ` ($${swarm.totalCostUsd.toFixed(3)})`
        : "";
    console.log(`\n  ${chalk.bold("Complete:")} ${summary}${chalk.dim(cost)}`);

    const elapsed = Math.round((Date.now() - swarm.startedAt) / 1000);
    const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
    const tools = swarm.agents.reduce((sum, a) => sum + a.toolCalls, 0);
    console.log(chalk.dim(`  ${elapsedStr}  ${fmtTokens(swarm.totalInputTokens)} in / ${fmtTokens(swarm.totalOutputTokens)} out  ${tools} tool calls`));

    if (swarm.mergeResults.length > 0) {
      const merged = swarm.mergeResults.filter((r) => r.ok);
      const autoResolved = merged.filter((r) => r.autoResolved).length;
      const conflicts = swarm.mergeResults.filter((r) => !r.ok);
      const target = swarm.mergeBranch || "HEAD";
      if (merged.length > 0) {
        const extra = autoResolved > 0 ? chalk.yellow(` (${autoResolved} auto-resolved)`) : "";
        console.log(chalk.green(`  Merged ${merged.length} branch(es) into ${target}`) + extra);
      }
      if (swarm.mergeBranch) {
        console.log(chalk.dim(`  Branch: ${swarm.mergeBranch} — create a PR or: git merge ${swarm.mergeBranch}`));
      }
      if (conflicts.length > 0) {
        console.log(chalk.red(`  ${conflicts.length} branch(es) had unresolved conflicts:`));
        for (const c of conflicts) {
          console.log(chalk.red(`    ${c.branch}`));
        }
        console.log(chalk.dim("  Branches preserved — merge manually with: git merge <branch>"));
      }
    }

    if (swarm.logFile) {
      console.log(chalk.dim(`  Log: ${swarm.logFile}`));
    }
    console.log("");
  }

  // Exit codes: 0 = all succeeded, 1 = some failed, 2 = all failed or aborted
  if (swarm.aborted || swarm.completed === 0) {
    process.exit(2);
  }
  if (swarm.failed > 0) {
    process.exit(1);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

main().catch((err) => {
  process.stdout.write("\x1B[?25h");
  console.error(chalk.red(err.message || err));
  process.exit(1);
});
