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
import { planTasks, refinePlan } from "./planner.js";
import { startRenderLoop, renderSummary } from "./ui.js";
import type { Task, TaskFile, PermMode, MergeStrategy } from "./types.js";

// ── CLI flag parsing ──

function parseCliFlags(argv: string[]) {
  const known = new Set(["concurrency", "model", "timeout", "budget"]);
  const booleans = new Set(["--dry-run", "-h", "--help", "-v", "--version"]);
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
  try {
    q = query({ prompt: "", options: { persistSession: false } });
    const models = await Promise.race([
      q.supportedModels(),
      sleep(timeoutMs).then(() => { throw new Error("model_fetch_timeout"); }),
    ]);
    q.close();
    return models;
  } catch (err: any) {
    q?.close();
    if (err.message === "model_fetch_timeout") {
      console.warn(chalk.yellow("\n  Model fetch timed out — continuing with defaults"));
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
    --model=NAME           Model override
    --timeout=SECONDS      Agent inactivity timeout ${chalk.dim("(default: 300s, kills only silent agents)")}

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
      fileCfg = loadTaskFile(arg);
      tasks = fileCfg.tasks;
    } else if (!arg.startsWith("-") && existsSync(resolve(arg))) {
      console.error(chalk.red(`  "${arg}" looks like a file but doesn't end in .json. Rename it or quote the string.`));
      process.exit(1);
    } else {
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

  // ── Interactive flow: Objective → Budget → Model → Plan → Review ──
  let model: string;
  let budget: number | undefined;
  let concurrency: number;
  let objective: string | undefined;

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

    // 3. Model — arrow keys
    process.stdout.write(chalk.dim("  Fetching models..."));
    const models = await fetchModels();
    process.stdout.write(`\x1B[2K\r`);

    if (models.length > 0) {
      model = await select("Model:", models.map((m) => ({
        name: m.displayName,
        value: m.value,
        hint: m.description,
      })));
    } else {
      const ans = await ask(chalk.dim("  Model [claude-sonnet-4-6]: "));
      model = ans || "claude-sonnet-4-6";
    }

    // Concurrency defaults based on budget
    concurrency = Math.min(5, budget);
  } else {
    // Non-interactive: resolve config from file/flags/defaults
    let models: ModelInfo[] = [];
    if (!cliFlags.model && !fileCfg?.model) models = await fetchModels(5_000);
    model = cliFlags.model ?? fileCfg?.model ?? (models[0]?.value || "claude-sonnet-4-6");
    concurrency = cliFlags.concurrency ? parseInt(cliFlags.concurrency) : (fileCfg?.concurrency ?? 5);
    budget = cliFlags.budget ? parseInt(cliFlags.budget) : undefined;
  }

  validateConcurrency(concurrency);
  const permissionMode: PermMode = fileCfg?.permissionMode ?? "auto";
  const useWorktrees = fileCfg?.useWorktrees ?? (isGitRepo(cwd));
  if (useWorktrees) validateGitRepo(cwd);
  const mergeStrategy: MergeStrategy = fileCfg?.mergeStrategy ?? "yolo";

  if (nonInteractive) {
    console.log(chalk.dim(`  ${model}  concurrency=${concurrency}  worktrees=${useWorktrees}  merge=${mergeStrategy}  perms=${permissionMode}`));
  }

  // ── Plan phase (interactive: review loop, non-interactive: auto-plan or skip) ──
  const needsPlan = tasks.length === 0;

  if (needsPlan) {
    if (noTTY) {
      console.error(chalk.red("  No tasks provided and stdin is not a TTY. Provide tasks via args or a .json file."));
      process.exit(1);
    }

    process.stdout.write("\x1B[?25l");
    const restore = () => process.stdout.write("\x1B[?25h");

    console.log(chalk.magenta("\n  Planning...\n"));
    try {
      tasks = await planTasks(objective!, cwd, model, permissionMode, budget, concurrency, (text) => {
        process.stdout.write(`\x1B[2K\r  ${chalk.dim(text)}`);
      });
      process.stdout.write(`\x1B[2K\r  ${chalk.green(`${tasks.length} tasks`)}\n\n`);
    } catch (err: any) {
      restore();
      if (isAuthError(err)) console.error(chalk.red(`\n  Authentication failed — check your API key or run: claude auth\n`));
      else console.error(chalk.red(`\n  Planning failed: ${err.message}\n`));
      process.exit(1);
    }

    // ── Review loop ──
    restore();
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
            tasks = await refinePlan(objective!, tasks, feedback, cwd, model, permissionMode, budget, concurrency, (text) => {
              process.stdout.write(`\x1B[2K\r  ${chalk.dim(text)}`);
            });
            process.stdout.write(`\x1B[2K\r  ${chalk.green(`${tasks.length} tasks`)}\n\n`);
          } catch (err: any) {
            console.error(chalk.red(`\n  Re-planning failed: ${err.message}\n`));
          }
          restore();
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
              options: { cwd, model, permissionMode, persistSession: false },
            })) {
              if (msg.type === "result" && msg.subtype === "success") answer = (msg as any).result || "";
            }
            restore();
            if (answer) console.log(chalk.dim(`\n  ${answer.slice(0, 500)}\n`));
          } catch {
            restore();
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

  // ── Run ──
  process.stdout.write("\x1B[?25l");
  const restore = () => process.stdout.write("\x1B[?25h\n");

  const agentTimeoutMs = cliFlags.timeout ? parseFloat(cliFlags.timeout) * 1000 : undefined;

  const swarm = new Swarm({
    tasks, concurrency, cwd, model, permissionMode, allowedTools,
    useWorktrees, mergeStrategy, agentTimeoutMs,
  });

  // Graceful drain
  let stopping = false;
  const gracefulStop = (signal: string) => {
    if (stopping) { swarm.cleanup(); restore(); process.exit(0); }
    stopping = true;
    process.stdout.write(`\n  ${chalk.yellow(`${signal}: stopping... ${swarm.active} active (send again to force)`)}\n`);
    swarm.abort();
  };

  process.on("SIGINT", () => gracefulStop("SIGINT"));
  process.on("SIGTERM", () => gracefulStop("SIGTERM"));
  process.on("uncaughtException", (err) => { swarm.abort(); swarm.cleanup(); restore(); console.error(chalk.red(`\n  Uncaught: ${err.message}`)); process.exit(1); });
  process.on("unhandledRejection", (reason) => { swarm.abort(); swarm.cleanup(); restore(); console.error(chalk.red(`\n  Unhandled: ${reason instanceof Error ? reason.message : reason}`)); process.exit(1); });

  const stopRender = startRenderLoop(swarm);

  try {
    await swarm.run();
  } catch (err: unknown) {
    if (isAuthError(err)) { stopRender(); restore(); console.error(chalk.red(`\n  Authentication failed — check your API key or run: claude auth\n`)); process.exit(1); }
    throw err;
  } finally {
    stopRender();
    console.log(renderSummary(swarm));

    const failedAgents = swarm.agents.filter((a) => a.status === "error");
    const summary = failedAgents.length > 0
      ? chalk.yellow(`${swarm.completed} done, ${failedAgents.length} failed`)
      : chalk.green(`${swarm.completed} done`);
    const cost = swarm.totalCostUsd > 0 ? ` ($${swarm.totalCostUsd.toFixed(3)})` : "";
    console.log(`\n  ${chalk.bold("Complete:")} ${summary}${chalk.dim(cost)}`);

    if (failedAgents.length > 0) {
      console.log(chalk.red(`\n  Failed agents:`));
      for (const a of failedAgents) {
        console.log(chalk.red(`    \u2717 Agent ${a.id + 1}: ${a.task.prompt.slice(0, 60)}${a.task.prompt.length > 60 ? "\u2026" : ""}`));
        console.log(chalk.dim(`      ${a.error || "unknown error"}`));
      }
    }

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
      if (swarm.mergeBranch) console.log(chalk.dim(`  Branch: ${swarm.mergeBranch} — create a PR or: git merge ${swarm.mergeBranch}`));
      if (conflicts.length > 0) {
        console.log(chalk.red(`  ${conflicts.length} unresolved conflict(s):`));
        for (const c of conflicts) console.log(chalk.red(`    ${c.branch}`));
        console.log(chalk.dim("  Merge manually: git merge <branch>"));
      }
    }

    if (swarm.logFile) console.log(chalk.dim(`  Log: ${swarm.logFile}`));
    console.log("");
  }

  if (swarm.aborted || swarm.completed === 0) process.exit(2);
  if (swarm.failed > 0) process.exit(1);
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

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
