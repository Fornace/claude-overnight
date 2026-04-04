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
import { planTasks, refinePlan, detectModelTier, steerWave } from "./planner.js";
import type { WaveSummary } from "./planner.js";
import { startRenderLoop, renderSummary } from "./ui.js";
import type { Task, TaskFile, PermMode, MergeStrategy } from "./types.js";

// ── CLI flag parsing ──

function parseCliFlags(argv: string[]) {
  const known = new Set(["concurrency", "model", "timeout", "budget", "usage-cap"]);
  const booleans = new Set(["--dry-run", "-h", "--help", "-v", "--version", "--no-flex"]);
  const flags: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (booleans.has(arg)) continue;
    const eq = arg.match(/^--(\w[\w-]*)=(.+)$/);
    if (eq && known.has(eq[1])) { flags[eq[1]] = eq[2]; continue; }
    const bare = arg.match(/^--(\w[\w-]*)$/);
    if (bare && known.has(bare[1]) && i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
      flags[bare[1]] = argv[++i]; continue;
    }
    if (!arg.startsWith("--")) positional.push(arg);
  }
  return { flags, positional };
}

// ── Auth error detection ──

const AUTH_PATTERNS = ["unauthorized", "forbidden", "invalid_api_key", "authentication"];

function isAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return AUTH_PATTERNS.some((p) => msg.toLowerCase().includes(p));
}

// ── Fetch models via SDK ──

async function fetchModels(timeoutMs = 10_000): Promise<ModelInfo[]> {
  let q: ReturnType<typeof query> | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    q = query({ prompt: "", options: { persistSession: false } });
    const models = await Promise.race([
      q.supportedModels(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("model_fetch_timeout")), timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    q.close();
    return models;
  } catch (err: any) {
    clearTimeout(timer);
    q?.close();
    if (err.message === "model_fetch_timeout") {
      console.warn(chalk.yellow("\n  Model fetch timed out — continuing with defaults"));
    } else if (isAuthError(err)) {
      console.error(chalk.red("\n  Authentication failed — check your API key or run: claude auth\n"));
      process.exit(1);
    } else {
      console.warn(chalk.yellow(`\n  Could not fetch models: ${String(err.message || err).slice(0, 80)} — continuing with defaults`));
    }
    return [];
  }
}

// ── Interactive primitives ──

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question(question, (answer) => { rl.close(); res(answer.trim()); });
  });
}

async function select<T>(label: string, items: { name: string; value: T; hint?: string }[], defaultIdx = 0): Promise<T> {
  const { stdin, stdout } = process;
  let idx = defaultIdx;

  const draw = (first = false) => {
    if (!first) stdout.write(`\x1B[${items.length}A`);
    for (let i = 0; i < items.length; i++) {
      const arrow = i === idx ? chalk.green("  → ") : "    ";
      const name = i === idx ? chalk.green(items[i].name) : chalk.dim(items[i].name);
      const hint = items[i].hint ? chalk.dim(` — ${items[i].hint}`) : "";
      stdout.write(`\x1B[2K${arrow}${name}${hint}\n`);
    }
  };

  stdout.write(`\n  ${chalk.bold(label)}\n`);
  draw(true);

  return new Promise((resolve) => {
    stdin.setRawMode!(true);
    stdin.resume();
    const done = (val: T) => {
      stdin.setRawMode!(false);
      stdin.removeListener("data", handler);
      stdin.pause();
      resolve(val);
    };
    const handler = (buf: Buffer) => {
      const s = buf.toString();
      if (s === "\x1B[A") { idx = (idx - 1 + items.length) % items.length; draw(); }
      else if (s === "\x1B[B") { idx = (idx + 1) % items.length; draw(); }
      else if (s === "\r") done(items[idx].value);
      else if (s === "\x03") { stdin.setRawMode!(false); process.exit(0); }
      else if (/^[1-9]$/.test(s)) {
        const n = parseInt(s) - 1;
        if (n < items.length) { idx = n; draw(); done(items[idx].value); }
      }
    };
    stdin.on("data", handler);
  });
}

async function selectKey(label: string, options: { key: string; desc: string }[]): Promise<string> {
  const { stdin, stdout } = process;
  const keys = options.map((o) => o.key.toLowerCase());
  stdout.write(`\n  ${label}  ${options.map((o) => `[${chalk.bold(o.key.toUpperCase())}]${chalk.dim(o.desc)}`).join("  ")}\n  `);

  return new Promise((resolve) => {
    stdin.setRawMode!(true);
    stdin.resume();
    const handler = (buf: Buffer) => {
      const s = buf.toString().toLowerCase();
      if (s === "\x03") { stdin.setRawMode!(false); process.exit(0); }
      if (s === "\r") { stdin.setRawMode!(false); stdin.removeListener("data", handler); stdin.pause(); resolve(keys[0]); return; }
      if (keys.includes(s)) { stdin.setRawMode!(false); stdin.removeListener("data", handler); stdin.pause(); resolve(s); }
    };
    stdin.on("data", handler);
  });
}

// ── File-based task loading (non-interactive) ──

interface FileArgs {
  tasks: Task[];
  objective?: string;
  concurrency?: number;
  model?: string;
  permissionMode?: PermMode;
  cwd?: string;
  allowedTools?: string[];
  useWorktrees?: boolean;
  mergeStrategy?: MergeStrategy;
  usageCap?: number;
  flexiblePlan?: boolean;
}

const KNOWN_TASK_FILE_KEYS = new Set([
  "tasks", "objective", "concurrency", "cwd", "model", "permissionMode", "allowedTools", "worktrees", "mergeStrategy", "usageCap", "flexiblePlan",
]);

function loadTaskFile(file: string): FileArgs {
  const path = resolve(file);
  let raw: string;
  try { raw = readFileSync(path, "utf-8"); } catch { throw new Error(`Cannot read task file: ${path}`); }

  let json: unknown;
  try { json = JSON.parse(raw); } catch { throw new Error(`Task file is not valid JSON: ${path}`); }

  const parsed: TaskFile & { worktrees?: boolean; permissionMode?: PermMode } = Array.isArray(json)
    ? { tasks: json }
    : json as any;

  if (!Array.isArray(json) && typeof json === "object" && json !== null) {
    const unknown = Object.keys(json).filter((k) => !KNOWN_TASK_FILE_KEYS.has(k));
    if (unknown.length > 0) {
      throw new Error(`Unknown key${unknown.length > 1 ? "s" : ""} in task file: ${unknown.join(", ")}. Allowed: ${[...KNOWN_TASK_FILE_KEYS].join(", ")}`);
    }
  }

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
      if (typeof t.prompt !== "string" || !t.prompt.trim()) throw new Error(`Task ${i} is missing a "prompt" string`);
      tasks.push({ id, prompt: t.prompt, cwd: t.cwd ? resolve(t.cwd) : undefined, model: t.model });
    } else {
      throw new Error(`Task ${i} must be a string or object with a "prompt" field (got ${typeof t})`);
    }
  }

  if (parsed.concurrency !== undefined) validateConcurrency(parsed.concurrency);

  const usageCap = (parsed as any).usageCap;
  if (usageCap != null && (typeof usageCap !== "number" || usageCap < 0 || usageCap > 100)) {
    throw new Error(`usageCap must be a number between 0 and 100 (got ${JSON.stringify(usageCap)})`);
  }

  const flexiblePlan = (parsed as any).flexiblePlan;
  const objective = (parsed as any).objective;
  if (flexiblePlan && typeof objective !== "string") {
    throw new Error(`flexiblePlan requires an "objective" string in the task file`);
  }

  return {
    tasks,
    objective: typeof objective === "string" ? objective : undefined,
    concurrency: parsed.concurrency,
    model: parsed.model,
    cwd: parsed.cwd ? resolve(parsed.cwd) : undefined,
    permissionMode: parsed.permissionMode,
    allowedTools: parsed.allowedTools,
    useWorktrees: parsed.worktrees,
    mergeStrategy: (parsed as any).mergeStrategy,
    usageCap,
    flexiblePlan,
  };
}

// ── Validation helpers ──

function validateConcurrency(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`Concurrency must be a positive integer (got ${JSON.stringify(value)})`);
  }
}

function isGitRepo(cwd: string): boolean {
  try { execSync("git rev-parse --git-dir", { cwd, encoding: "utf-8", stdio: "pipe" }); return true; } catch { return false; }
}

function validateGitRepo(cwd: string): void {
  if (!isGitRepo(cwd)) {
    throw new Error(
      `Worktrees require a git repository, but ${cwd} is not inside one.\n` +
      `  Run: cd ${cwd} && git init\n` +
      `  Or set "worktrees": false in your task file.`,
    );
  }
}

// ── Show plan ──

function showPlan(tasks: Task[]) {
  for (const t of tasks) {
    console.log(chalk.dim(`    ${Number(t.id) + 1}. ${t.prompt.slice(0, 90)}`));
  }
  console.log("");
}

// ── Main ──

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes("-v") || argv.includes("--version")) {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
    console.log(`claude-overnight v${pkg.version}`);
    process.exit(0);
  }

  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(`
  ${chalk.bold("claude-overnight")} — fire off Claude agents, come back to shipped work

  ${chalk.dim("Usage:")}
    claude-overnight                          ${chalk.dim("interactive — describe what to do, review plan, run")}
    claude-overnight tasks.json               ${chalk.dim("run tasks defined in a JSON file")}
    claude-overnight "fix auth" "add tests"   ${chalk.dim("run inline tasks in parallel")}

  ${chalk.dim("Flags:")}
    -h, --help             Show this help
    -v, --version          Print version
    --dry-run              Show planned tasks without running them
    --budget=N             Target number of agent runs ${chalk.dim("(planner aims for this many tasks)")}
    --concurrency=N        Max parallel agents ${chalk.dim("(default: 5)")}
    --model=NAME           Worker model override ${chalk.dim("(planner always uses best available)")}
    --usage-cap=N          Stop at N% utilization ${chalk.dim("(e.g. 90 to save 10% for other work)")}
    --timeout=SECONDS      Agent inactivity timeout ${chalk.dim("(default: 300s, kills only silent agents)")}
    --no-flex              Disable adaptive multi-wave planning ${chalk.dim("(run all tasks in one shot)")}

  ${chalk.dim("Non-interactive defaults (task file / inline / piped):")}
    model: first available    concurrency: 5    worktrees: auto    perms: auto
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

  // ── Load tasks from file or inline args ──
  let tasks: Task[] = [];
  let fileCfg: FileArgs | undefined;

  const jsonFiles = args.filter((a) => a.endsWith(".json"));
  if (jsonFiles.length > 1) {
    console.error(chalk.red(`  Multiple task files provided. Only one .json file is supported.`));
    process.exit(1);
  }

  for (const arg of args) {
    if (arg.endsWith(".json")) {
      if (tasks.length > 0) {
        console.error(chalk.red(`  Cannot mix inline tasks with a task file. Use one or the other.`));
        process.exit(1);
      }
      fileCfg = loadTaskFile(arg);
      tasks = fileCfg.tasks;
    } else if (!arg.startsWith("-") && existsSync(resolve(arg))) {
      console.error(chalk.red(`  "${arg}" looks like a file but doesn't end in .json. Rename it or quote the string.`));
      process.exit(1);
    } else {
      if (fileCfg) {
        console.error(chalk.red(`  Cannot mix inline tasks with a task file. Use one or the other.`));
        process.exit(1);
      }
      tasks.push({ id: String(tasks.length), prompt: arg });
    }
  }

  // ── Determine mode ──
  console.log(chalk.bold("\n  \uD83C\uDF19 claude-overnight\n"));

  const noTTY = !process.stdin.isTTY;
  const nonInteractive = noTTY || fileCfg !== undefined || tasks.length > 0;
  const cwd = fileCfg?.cwd ?? process.cwd();
  const allowedTools = fileCfg?.allowedTools;
  if (!existsSync(cwd)) { console.error(chalk.red(`  Working directory does not exist: ${cwd}`)); process.exit(1); }

  if (noTTY) console.log(chalk.dim("  Non-interactive mode — using defaults\n"));

  // ── Interactive flow: Objective → Budget → Model → Usage cap → Plan → Review ──
  let workerModel: string;
  let plannerModel: string;
  let budget: number | undefined;
  let concurrency: number;
  let objective: string | undefined = fileCfg?.objective;
  let usageCap: number | undefined;

  if (!nonInteractive) {
    console.log(chalk.dim("  Fire off Claude agents, come back to shipped work.\n"));

    // 1. Objective first — it's the whole point
    while (true) {
      objective = await ask(chalk.bold("  What should the agents do?\n  > "));
      if (!objective) { console.error(chalk.red("\n  No objective provided.")); process.exit(1); }
      if (objective.split(/\s+/).length >= 5) break;
      console.log(chalk.yellow('  Be specific, e.g. "refactor the auth module, add tests, and update docs"\n'));
    }

    // 2. Budget — how many agent runs to spend
    const budgetAns = await ask(chalk.dim("\n  Agent budget [10]: "));
    budget = parseInt(budgetAns) || 10;
    if (budget < 1) { console.error(chalk.red(`  Budget must be a positive number`)); process.exit(1); }

    // 3. Worker model — planner always uses best available
    process.stdout.write(chalk.dim("  Fetching models..."));
    const models = await fetchModels();
    process.stdout.write(`\x1B[2K\r`);

    // Pick best model for planner (first = most capable)
    plannerModel = models[0]?.value || "claude-sonnet-4-6";

    if (models.length > 0) {
      workerModel = await select("Worker model (planner always uses best available):", models.map((m) => ({
        name: m.displayName,
        value: m.value,
        hint: m.description,
      })));
    } else {
      const ans = await ask(chalk.dim("  Worker model [claude-sonnet-4-6]: "));
      workerModel = ans || "claude-sonnet-4-6";
    }

    if (workerModel !== plannerModel) {
      const tier = detectModelTier(workerModel);
      console.log(chalk.dim(`\n  Planner: ${plannerModel} · Workers: ${workerModel} (${tier})`));
    }

    // 4. Usage cap — how much of your plan to use
    usageCap = await select("Usage limit:", [
      { name: "Unlimited", value: undefined as any, hint: "use full capacity, wait through rate limits" },
      { name: "90%", value: 0.9, hint: "leave 10% for other work" },
      { name: "75%", value: 0.75, hint: "conservative, plenty of headroom" },
      { name: "50%", value: 0.5, hint: "use half, keep the rest" },
    ]);

    // Concurrency defaults based on budget
    concurrency = Math.min(5, budget);
  } else {
    // Non-interactive: resolve config from file/flags/defaults
    let models: ModelInfo[] = [];
    if (!cliFlags.model && !fileCfg?.model) models = await fetchModels(5_000);
    workerModel = cliFlags.model ?? fileCfg?.model ?? (models[0]?.value || "claude-sonnet-4-6");
    plannerModel = models[0]?.value || workerModel;
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
  }

  validateConcurrency(concurrency);
  const permissionMode: PermMode = fileCfg?.permissionMode ?? "auto";
  const useWorktrees = fileCfg?.useWorktrees ?? (isGitRepo(cwd));
  if (useWorktrees) validateGitRepo(cwd);
  const mergeStrategy: MergeStrategy = fileCfg?.mergeStrategy ?? "yolo";

  if (nonInteractive) {
    const capStr = usageCap != null ? `  cap=${Math.round(usageCap * 100)}%` : "";
    console.log(chalk.dim(`  ${workerModel}  concurrency=${concurrency}  worktrees=${useWorktrees}  merge=${mergeStrategy}  perms=${permissionMode}${capStr}`));
  }

  // ── Flex mode: adaptive multi-wave planning ──
  const flex = !argv.includes("--no-flex") && (fileCfg?.flexiblePlan ?? objective != null) && objective != null && (budget ?? 10) > 2;

  // ── Plan phase (interactive: review loop, non-interactive: auto-plan or skip) ──
  const needsPlan = tasks.length === 0;

  if (needsPlan) {
    if (noTTY) {
      console.error(chalk.red("  No tasks provided and stdin is not a TTY. Provide tasks via args or a .json file."));
      process.exit(1);
    }

    // In flex mode, plan ~50% of budget for wave 1, leaving room for steering
    const waveBudget = flex ? Math.max(concurrency, Math.ceil((budget ?? 10) * 0.5)) : budget;
    const flexNote = flex
      ? `This is wave 1 of an adaptive multi-wave run (total budget: ${budget}). Plan the highest-impact foundational work first. Future waves will iterate, polish, and expand based on what's learned.`
      : undefined;

    process.stdout.write("\x1B[?25l");
    const planRestore = () => process.stdout.write("\x1B[?25h");

    console.log(chalk.magenta(`\n  Planning${flex ? " wave 1" : ""}...\n`));
    try {
      tasks = await planTasks(objective!, cwd, plannerModel, workerModel, permissionMode, waveBudget, concurrency, (text) => {
        process.stdout.write(`\x1B[2K\r  ${chalk.dim(text)}`);
      }, flexNote);
      const flexHint = flex ? chalk.dim(` (wave 1, ${(budget ?? 10) - tasks.length} remaining)`) : "";
      process.stdout.write(`\x1B[2K\r  ${chalk.green(`${tasks.length} tasks`)}${flexHint}\n\n`);
    } catch (err: any) {
      planRestore();
      if (isAuthError(err)) console.error(chalk.red(`\n  Authentication failed — check your API key or run: claude auth\n`));
      else console.error(chalk.red(`\n  Planning failed: ${err.message}\n`));
      process.exit(1);
    }

    // ── Review loop ──
    planRestore();
    let reviewing = true;
    while (reviewing) {
      showPlan(tasks);

      const action = await selectKey(
        `${tasks.length} tasks, concurrency ${concurrency}.`,
        [
          { key: "r", desc: "un" },
          { key: "e", desc: "dit" },
          { key: "c", desc: "hat" },
          { key: "q", desc: "uit" },
        ],
      );

      switch (action) {
        case "r":
          reviewing = false;
          break;

        case "e": {
          const feedback = await ask(chalk.bold("\n  What should change?\n  > "));
          if (!feedback) break;
          console.log(chalk.magenta("\n  Re-planning...\n"));
          process.stdout.write("\x1B[?25l");
          try {
            tasks = await refinePlan(objective!, tasks, feedback, cwd, plannerModel, workerModel, permissionMode, budget, concurrency, (text) => {
              process.stdout.write(`\x1B[2K\r  ${chalk.dim(text)}`);
            });
            process.stdout.write(`\x1B[2K\r  ${chalk.green(`${tasks.length} tasks`)}\n\n`);
          } catch (err: any) {
            console.error(chalk.red(`\n  Re-planning failed: ${err.message}\n`));
          }
          planRestore();
          break;
        }

        case "c": {
          const question = await ask(chalk.bold("\n  Ask about the plan:\n  > "));
          if (!question) break;
          process.stdout.write("\x1B[?25l");
          try {
            let answer = "";
            for await (const msg of query({
              prompt: `You planned these tasks for the objective "${objective}":\n${tasks.map((t, i) => `${i + 1}. ${t.prompt}`).join("\n")}\n\nUser question: ${question}`,
              options: { cwd, model: plannerModel, permissionMode, persistSession: false },
            })) {
              if (msg.type === "result" && msg.subtype === "success") answer = (msg as any).result || "";
            }
            planRestore();
            if (answer) console.log(chalk.dim(`\n  ${answer.slice(0, 500)}\n`));
          } catch {
            planRestore();
          }
          break;
        }

        case "q":
          console.log(chalk.dim("\n  Aborted.\n"));
          process.exit(0);
      }
    }
  }

  if (tasks.length === 0) { console.error("No tasks provided."); process.exit(1); }

  if (dryRun) {
    console.log(chalk.bold("  Tasks:"));
    showPlan(tasks);
    process.exit(0);
  }

  // ── Run (wave loop) ──
  process.stdout.write("\x1B[?25l");
  const restore = () => process.stdout.write("\x1B[?25h\n");
  const agentTimeoutMs = cliFlags.timeout ? parseFloat(cliFlags.timeout) * 1000 : undefined;
  const runStartedAt = Date.now();

  // Wave-loop state
  let currentSwarm: Swarm | undefined;
  let remaining = budget ?? tasks.length;
  let currentTasks = tasks;
  let waveNum = 0;
  const waveHistory: WaveSummary[] = [];
  let accCost = 0, accIn = 0, accOut = 0, accCompleted = 0, accFailed = 0, accTools = 0;
  let lastCapped = false, lastAborted = false;

  // For flex + branch strategy: create one target branch, waves merge via yolo into it
  let runBranch: string | undefined;
  let originalRef: string | undefined;
  if (flex && mergeStrategy === "branch" && useWorktrees) {
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

  // Graceful drain
  let stopping = false;
  const gracefulStop = (signal: string) => {
    if (stopping) { currentSwarm?.cleanup(); restore(); process.exit(0); }
    stopping = true;
    process.stdout.write(`\n  ${chalk.yellow(`${signal}: stopping... (send again to force)`)}\n`);
    currentSwarm?.abort();
  };
  process.on("SIGINT", () => gracefulStop("SIGINT"));
  process.on("SIGTERM", () => gracefulStop("SIGTERM"));
  process.on("uncaughtException", (err) => { currentSwarm?.abort(); currentSwarm?.cleanup(); restore(); console.error(chalk.red(`\n  Uncaught: ${err.message}`)); process.exit(1); });
  process.on("unhandledRejection", (reason) => { currentSwarm?.abort(); currentSwarm?.cleanup(); restore(); console.error(chalk.red(`\n  Unhandled: ${reason instanceof Error ? reason.message : reason}`)); process.exit(1); });

  while (remaining > 0 && currentTasks.length > 0 && !stopping) {
    if (currentTasks.length > remaining) currentTasks = currentTasks.slice(0, remaining);

    if (flex) {
      console.log(chalk.magenta(`\n  \u2500\u2500 Wave ${waveNum + 1} (${currentTasks.length} tasks, ${remaining} remaining) \u2500\u2500\n`));
    }

    const swarm = new Swarm({
      tasks: currentTasks, concurrency, cwd, model: workerModel, permissionMode, allowedTools,
      useWorktrees, mergeStrategy: waveMerge, agentTimeoutMs, usageCap,
    });
    currentSwarm = swarm;

    const stopRender = startRenderLoop(swarm);
    try {
      await swarm.run();
    } catch (err: unknown) {
      if (isAuthError(err)) { stopRender(); restore(); console.error(chalk.red(`\n  Authentication failed — check your API key or run: claude auth\n`)); process.exit(1); }
      throw err;
    } finally {
      stopRender();
      console.log(renderSummary(swarm));
    }

    // Accumulate
    accCost += swarm.totalCostUsd;
    accIn += swarm.totalInputTokens;
    accOut += swarm.totalOutputTokens;
    accCompleted += swarm.completed;
    accFailed += swarm.failed;
    accTools += swarm.agents.reduce((sum, a) => sum + a.toolCalls, 0);
    remaining -= swarm.completed + swarm.failed;
    lastCapped = swarm.cappedOut;
    lastAborted = swarm.aborted;

    waveHistory.push({
      wave: waveNum,
      tasks: swarm.agents.map(a => ({
        prompt: a.task.prompt,
        status: a.status,
        filesChanged: a.filesChanged,
        error: a.error,
      })),
    });

    if (!flex || remaining <= 0 || swarm.aborted || swarm.cappedOut) break;

    // ── Steer next wave ──
    console.log(chalk.magenta("\n  Steering...\n"));
    process.stdout.write("\x1B[?25l");
    try {
      const steer = await steerWave(
        objective!, waveHistory, remaining, cwd, plannerModel, workerModel,
        permissionMode, concurrency, (text) => {
          process.stdout.write(`\x1B[2K\r  ${chalk.dim(text)}`);
        },
      );
      process.stdout.write(`\x1B[2K\r`);
      process.stdout.write("\x1B[?25h");

      if (steer.done) {
        console.log(chalk.green(`  \u2713 ${steer.reasoning}\n`));
        break;
      }

      console.log(chalk.dim(`  ${steer.reasoning}\n`));
      currentTasks = steer.tasks;
      waveNum++;
    } catch (err: any) {
      process.stdout.write("\x1B[?25h");
      console.log(chalk.yellow(`  Steering failed: ${err.message?.slice(0, 80)} \u2014 stopping\n`));
      break;
    }
  }

  // Switch back if we created a run branch
  if (runBranch && originalRef) {
    try { execSync(`git checkout "${originalRef}"`, { cwd, encoding: "utf-8", stdio: "pipe" }); } catch {}
  }

  // ── Final summary ──
  const waves = waveNum + 1;
  const cappedNote = lastCapped ? chalk.yellow(` (capped at ${usageCap != null ? Math.round(usageCap * 100) : 100}%)`) : "";
  const summaryText = accFailed > 0
    ? chalk.yellow(`${accCompleted} done, ${accFailed} failed`) + cappedNote
    : chalk.green(`${accCompleted} done`) + cappedNote;
  const costText = accCost > 0 ? ` ($${accCost.toFixed(3)})` : "";
  const wavePart = waves > 1 ? `${waves} waves, ` : "";
  console.log(`\n  ${chalk.bold("Complete:")} ${wavePart}${summaryText}${chalk.dim(costText)}`);

  if (accFailed > 0 && waves === 1) {
    const failedAgents = currentSwarm?.agents.filter((a) => a.status === "error") ?? [];
    if (failedAgents.length > 0) {
      console.log(chalk.red(`\n  Failed agents:`));
      for (const a of failedAgents) {
        console.log(chalk.red(`    \u2717 Agent ${a.id + 1}: ${a.task.prompt.slice(0, 60)}${a.task.prompt.length > 60 ? "\u2026" : ""}`));
        console.log(chalk.dim(`      ${a.error || "unknown error"}`));
      }
    }
  }

  const elapsed = Math.round((Date.now() - runStartedAt) / 1000);
  const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
  console.log(chalk.dim(`  ${elapsedStr}  ${fmtTokens(accIn)} in / ${fmtTokens(accOut)} out  ${accTools} tool calls`));

  if (runBranch) {
    console.log(chalk.dim(`  Branch: ${runBranch} \u2014 create a PR or: git merge ${runBranch}`));
  } else if (currentSwarm?.mergeResults && currentSwarm.mergeResults.length > 0) {
    const merged = currentSwarm.mergeResults.filter((r) => r.ok);
    const autoResolved = merged.filter((r) => r.autoResolved).length;
    const conflicts = currentSwarm.mergeResults.filter((r) => !r.ok);
    const target = currentSwarm.mergeBranch || "HEAD";
    if (merged.length > 0) {
      const extra = autoResolved > 0 ? chalk.yellow(` (${autoResolved} auto-resolved)`) : "";
      console.log(chalk.green(`  Merged ${merged.length} branch(es) into ${target}`) + extra);
    }
    if (currentSwarm.mergeBranch) console.log(chalk.dim(`  Branch: ${currentSwarm.mergeBranch} \u2014 create a PR or: git merge ${currentSwarm.mergeBranch}`));
    if (conflicts.length > 0) {
      console.log(chalk.red(`  ${conflicts.length} unresolved conflict(s):`));
      for (const c of conflicts) console.log(chalk.red(`    ${c.branch}`));
      console.log(chalk.dim("  Merge manually: git merge <branch>"));
    }
  }

  if (currentSwarm?.logFile) console.log(chalk.dim(`  Log: ${currentSwarm.logFile}`));
  console.log("");

  if (accFailed > 0) process.exit(1);
  if (lastAborted || accCompleted === 0) process.exit(2);
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
