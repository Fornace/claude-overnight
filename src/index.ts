#!/usr/bin/env node
import { readFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, symlinkSync, unlinkSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { createInterface } from "readline";
import chalk from "chalk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { Swarm } from "./swarm.js";
import { planTasks, refinePlan, detectModelTier, steerWave, identifyThemes, buildThinkingTasks, orchestrate, getTotalPlannerCost, getPlannerRateLimitInfo } from "./planner.js";
import type { WaveSummary, RunMemory } from "./planner.js";
import { RunDisplay, renderSummary } from "./ui.js";
import type { LiveConfig, RunInfo } from "./ui.js";
import type { Task, TaskFile, PermMode, MergeStrategy, RunState, BranchRecord } from "./types.js";

// ── CLI flag parsing ──

function parseCliFlags(argv: string[]) {
  const known = new Set(["concurrency", "model", "timeout", "budget", "usage-cap", "extra-usage-budget"]);
  const booleans = new Set(["--dry-run", "-h", "--help", "-v", "--version", "--no-flex", "--allow-extra-usage"]);
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
      const sel = i === idx;
      const radio = sel ? chalk.cyan("  ● ") : chalk.dim("  ○ ");
      const name = sel ? chalk.white(items[i].name) : chalk.dim(items[i].name);
      const hint = items[i].hint ? chalk.dim(` · ${items[i].hint}`) : "";
      stdout.write(`\x1B[2K${radio}${name}${hint}\n`);
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
  const optStr = options.map((o) => `${chalk.cyan.bold(o.key.toUpperCase())}${chalk.dim(o.desc)}`).join(chalk.dim("  │  "));
  stdout.write(`\n  ${label}\n  ${optStr}\n  `);

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
  const w = Math.max((process.stdout.columns ?? 80) - 6, 40);
  const ruleLen = Math.min(w, 70);
  console.log(chalk.dim(`  ─── ${tasks.length} tasks ${"─".repeat(Math.max(0, ruleLen - String(tasks.length).length - 10))}`));
  for (const t of tasks) {
    const num = chalk.dim(String(Number(t.id) + 1).padStart(4) + ".");
    console.log(`${num} ${t.prompt.slice(0, w)}`);
  }
  console.log(chalk.dim(`  ${"─".repeat(ruleLen)}\n`));
}

function readMdDir(dir: string): string {
  try {
    const files = readdirSync(dir).filter(f => f.endsWith(".md")).sort();
    return files.map(f => {
      const content = readFileSync(join(dir, f), "utf-8");
      return `### ${f}\n${content}`;
    }).join("\n\n");
  } catch { return ""; }
}

function readRunMemory(runDir: string, previousRuns?: string): RunMemory {
  let goal = "", status = "";
  try { goal = readFileSync(join(runDir, "goal.md"), "utf-8"); } catch {}
  try { status = readFileSync(join(runDir, "status.md"), "utf-8"); } catch {}
  return {
    designs: readMdDir(join(runDir, "designs")),
    reflections: readMdDir(join(runDir, "reflections")),
    verifications: readMdDir(join(runDir, "verifications")),
    milestones: readMdDir(join(runDir, "milestones")),
    status,
    goal,
    previousRuns,
  };
}

function writeStatus(baseDir: string, status: string): void {
  writeFileSync(join(baseDir, "status.md"), status, "utf-8");
}

function saveRunState(runDir: string, state: RunState): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "run.json"), JSON.stringify(state, null, 2), "utf-8");
}

function loadRunState(runDir: string): RunState | null {
  try {
    return JSON.parse(readFileSync(join(runDir, "run.json"), "utf-8"));
  } catch { return null; }
}

/** Find all incomplete runs for a given working directory, newest first. */
function findIncompleteRuns(rootDir: string, filterCwd: string): { dir: string; state: RunState }[] {
  const runsDir = join(rootDir, "runs");
  try {
    const dirs = readdirSync(runsDir).sort().reverse();
    const results: { dir: string; state: RunState }[] = [];
    for (const d of dirs) {
      const state = loadRunState(join(runsDir, d));
      if (state && state.phase !== "done" && state.cwd === filterCwd) {
        results.push({ dir: join(runsDir, d), state });
      }
    }
    return results;
  } catch { return []; }
}

/** Find orphaned designs: a run where thinking succeeded but orchestration crashed (has designs, no run.json). */
function findOrphanedDesigns(rootDir: string): string | null {
  const runsDir = join(rootDir, "runs");
  try {
    const dirs = readdirSync(runsDir).sort().reverse();
    for (const d of dirs) {
      const runDir = join(runsDir, d);
      const hasState = existsSync(join(runDir, "run.json"));
      if (hasState) continue; // has state — either complete or properly resumable
      const designs = readMdDir(join(runDir, "designs"));
      if (designs) return runDir;
    }
  } catch {}
  return null;
}

function formatTimeAgo(isoStr: string): string {
  const ms = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function showRunHistory(allRuns: { dir: string; state: RunState }[], filterCwd: string): void {
  const runs = allRuns.filter(r => r.state.cwd === filterCwd);
  if (runs.length === 0) { console.log(chalk.dim("\n  No run history.\n")); return; }
  const w = Math.min((process.stdout.columns ?? 80) - 6, 50);
  console.log(chalk.dim(`\n  ── Run History ${"─".repeat(Math.max(0, w - 16))}\n`));
  let resumeIdx = 0;
  for (const run of runs) {
    const s = run.state;
    const done = s.phase === "done";
    const icon = done ? chalk.green("✓") : chalk.yellow("⚠");
    const date = s.startedAt?.slice(0, 16).replace("T", " ") || "unknown";
    const cost = s.accCost > 0 ? ` · $${s.accCost.toFixed(2)}` : "";
    const obj = s.objective?.slice(0, 50) || "";
    const num = done ? " " : chalk.cyan(String(++resumeIdx));
    const merged = s.branches.filter(b => b.status === "merged").length;
    console.log(`  ${icon} ${num} ${chalk.dim(date)} · ${s.phase} · ${s.accCompleted}/${s.budget}${cost}${merged ? ` · ${merged} merged` : ""}`);
    console.log(`      ${obj}${obj.length >= 50 ? "…" : ""}`);
    let status = "";
    try { status = readFileSync(join(run.dir, "status.md"), "utf-8").trim().split("\n")[0].slice(0, 70); } catch {}
    if (status) console.log(chalk.dim(`      ${status}`));
    console.log("");
  }
}

/** Read final status + goal from all completed previous runs (newest first, max 5). */
function readPreviousRunKnowledge(rootDir: string): string {
  const runsDir = join(rootDir, "runs");
  try {
    const dirs = readdirSync(runsDir).sort().reverse();
    const summaries: string[] = [];
    for (const d of dirs) {
      if (summaries.length >= 5) break;
      const state = loadRunState(join(runsDir, d));
      if (!state || state.phase !== "done") continue;
      let status = "";
      try { status = readFileSync(join(runsDir, d, "status.md"), "utf-8"); } catch {}
      let goal = "";
      try { goal = readFileSync(join(runsDir, d, "goal.md"), "utf-8"); } catch {}
      const date = d.replace("T", " ").slice(0, 19);
      const cost = state.accCost > 0 ? ` · $${state.accCost.toFixed(2)}` : "";
      summaries.push(`### Run ${date} (${state.accCompleted} tasks${cost})\n${status || "(no status recorded)"}\n${goal ? `Goal: ${goal.slice(0, 500)}` : ""}`);
    }
    return summaries.join("\n\n");
  } catch { return ""; }
}

function createRunDir(rootDir: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runDir = join(rootDir, "runs", ts);
  mkdirSync(join(runDir, "designs"), { recursive: true });
  mkdirSync(join(runDir, "reflections"), { recursive: true });
  mkdirSync(join(runDir, "verifications"), { recursive: true });
  mkdirSync(join(runDir, "milestones"), { recursive: true });
  mkdirSync(join(runDir, "sessions"), { recursive: true });
  updateLatestSymlink(rootDir, runDir);
  return runDir;
}

function updateLatestSymlink(rootDir: string, runDir: string): void {
  const link = join(rootDir, "latest");
  try { unlinkSync(link); } catch {}
  try { symlinkSync(runDir, link); } catch {}
}

function saveWaveSession(baseDir: string, waveNum: number, kind: string, swarm: Swarm): void {
  const dir = join(baseDir, "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `wave-${waveNum}.json`), JSON.stringify({
    wave: waveNum, kind,
    agents: swarm.agents.map(a => ({
      id: a.id,
      prompt: a.task.prompt,
      status: a.status,
      error: a.error,
      cost: a.costUsd,
      toolCalls: a.toolCalls,
      filesChanged: a.filesChanged,
      duration: a.finishedAt && a.startedAt ? a.finishedAt - a.startedAt : 0,
      branch: a.branch,
    })),
    totalCost: swarm.totalCostUsd,
  }, null, 2), "utf-8");
}

/** Rebuild waveHistory from saved session files on resume. */
function loadWaveHistory(runDir: string): WaveSummary[] {
  const dir = join(runDir, "sessions");
  try {
    return readdirSync(dir)
      .filter(f => f.startsWith("wave-") && f.endsWith(".json"))
      .sort((a, b) => {
        const numA = parseInt(a.replace("wave-", "").replace(".json", ""));
        const numB = parseInt(b.replace("wave-", "").replace(".json", ""));
        return numA - numB;
      })
      .map(f => {
        const data = JSON.parse(readFileSync(join(dir, f), "utf-8"));
        return {
          wave: data.wave,
          kind: data.kind,
          tasks: (data.agents || []).map((a: any) => ({
            prompt: a.prompt,
            status: a.status,
            filesChanged: a.filesChanged,
            error: a.error,
          })),
        } as WaveSummary;
      });
  } catch { return []; }
}

function recordBranches(swarm: Swarm, branches: BranchRecord[]): void {
  for (const a of swarm.agents) {
    if (a.branch) {
      branches.push({
        branch: a.branch,
        taskPrompt: a.task.prompt.slice(0, 200),
        status: a.status === "done" ? "unmerged" : "failed",
        filesChanged: a.filesChanged ?? 0,
        costUsd: a.costUsd ?? 0,
      });
    }
  }
  // Update with merge results
  for (const mr of swarm.mergeResults) {
    const br = branches.find(b => b.branch === mr.branch);
    if (br) br.status = mr.ok ? "merged" : "merge-failed";
  }
}

function autoMergeBranches(cwd: string, branches: BranchRecord[], onLog: (msg: string) => void): void {
  const unmerged = branches.filter(b => b.status === "unmerged" && b.filesChanged > 0);
  if (unmerged.length === 0) return;
  onLog(`Merging ${unmerged.length} unmerged branches...`);
  for (const br of unmerged) {
    try {
      execSync(`git merge --no-edit "${br.branch}"`, { cwd, encoding: "utf-8", stdio: "pipe" });
      br.status = "merged";
      onLog(`  ✓ ${br.branch} (${br.filesChanged} files)`);
    } catch {
      try {
        try { execSync("git merge --abort", { cwd, encoding: "utf-8", stdio: "pipe" }); } catch {}
        execSync(`git merge --no-edit -X theirs "${br.branch}"`, { cwd, encoding: "utf-8", stdio: "pipe" });
        br.status = "merged";
        onLog(`  ✓ ${br.branch} (auto-resolved)`);
      } catch {
        try { execSync("git merge --abort", { cwd, encoding: "utf-8", stdio: "pipe" }); } catch {}
        br.status = "merge-failed";
        onLog(`  ✗ ${br.branch} (conflict — preserved for manual merge)`);
      }
    }
  }
}

function archiveMilestone(baseDir: string, waveNum: number): void {
  const statusPath = join(baseDir, "status.md");
  if (!existsSync(statusPath)) return;
  const content = readFileSync(statusPath, "utf-8");
  if (!content.trim()) return;
  const milestoneDir = join(baseDir, "milestones");
  mkdirSync(milestoneDir, { recursive: true });
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
  writeFileSync(join(milestoneDir, `wave-${waveNum}.md`), `# Milestone — Wave ${waveNum} (${ts})\n\n${content}`, "utf-8");
}

function writeGoalUpdate(baseDir: string, update: string): void {
  const goalPath = join(baseDir, "goal.md");
  let existing = "";
  try { existing = readFileSync(goalPath, "utf-8"); } catch {}
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
  const entry = `\n\n## Update — ${ts}\n${update}`;
  const full = existing + entry;
  // Keep it bounded: original + last ~3000 chars of updates
  const trimmed = full.length > 4000 ? full.slice(0, 1000) + "\n\n...\n\n" + full.slice(-3000) : full;
  writeFileSync(goalPath, trimmed, "utf-8");
}

const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

function makeProgressLog(): (text: string) => void {
  let frame = 0;
  return (text: string) => {
    const spin = chalk.cyan(BRAILLE[frame++ % BRAILLE.length]);
    const maxW = (process.stdout.columns ?? 80) - 6;
    const clean = text.replace(/\n/g, " ");
    const line = clean.length > maxW ? clean.slice(0, maxW - 1) + "\u2026" : clean;
    process.stdout.write(`\x1B[2K\r  ${spin} ${chalk.dim(line)}`);
  };
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
  ${chalk.bold("🌙  claude-overnight")} ${chalk.dim("— fire off Claude agents, come back to shipped work")}
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
    --model=NAME           Worker model override ${chalk.dim("(planner always uses best available)")}
    --usage-cap=N          Stop at N% utilization ${chalk.dim("(e.g. 90 to save 10% for other work)")}
    --allow-extra-usage    Allow extra/overage usage ${chalk.dim("(default: stop when plan limits hit)")}
    --extra-usage-budget=N Max $ for extra usage ${chalk.dim("(implies --allow-extra-usage)")}
    --timeout=SECONDS      Agent inactivity timeout ${chalk.dim("(default: 900s, nudges at timeout, kills at 2×)")}
    --no-flex              Disable adaptive multi-wave planning ${chalk.dim("(run all tasks in one shot)")}

  ${chalk.cyan("Defaults")} ${chalk.dim("(non-interactive)")}
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
  console.log(`\n  ${chalk.bold("🌙  claude-overnight")}`);
  console.log(chalk.dim(`  ${"─".repeat(36)}`));

  const noTTY = !process.stdin.isTTY;
  const nonInteractive = noTTY || fileCfg !== undefined || tasks.length > 0;
  const cwd = fileCfg?.cwd ?? process.cwd();
  const allowedTools = fileCfg?.allowedTools;
  if (!existsSync(cwd)) { console.error(chalk.red(`  Working directory does not exist: ${cwd}`)); process.exit(1); }

  if (noTTY) console.log(chalk.dim("  Non-interactive mode — using defaults\n"));

  // ── Show run history ──
  const rootDir = join(cwd, ".claude-overnight");
  const runsDir = join(rootDir, "runs");
  const allRuns: { dir: string; state: RunState }[] = [];
  try {
    const dirs = readdirSync(runsDir).sort().reverse();
    for (const d of dirs) {
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

  // ── Resume detection ──
  let resuming = false;
  let resumeState: RunState | null = null;
  let resumeRunDir: string | undefined;
  const incompleteRuns = findIncompleteRuns(rootDir, cwd);

  if (incompleteRuns.length > 0 && !noTTY && tasks.length === 0) {
    let decided = false;
    while (!decided) {
      if (incompleteRuns.length === 1) {
        // Single incomplete run — show detailed box
        const run = incompleteRuns[0];
        const prev = run.state;
        const merged = prev.branches.filter(b => b.status === "merged").length;
        const unmerged = prev.branches.filter(b => b.status === "unmerged").length;
        const failed = prev.branches.filter(b => b.status === "failed" || b.status === "merge-failed").length;
        const obj = prev.objective?.slice(0, 50) || "";
        const ago = formatTimeAgo(prev.startedAt);

        let lastStatus = "";
        try { lastStatus = readFileSync(join(run.dir, "status.md"), "utf-8").trim().slice(0, 120); } catch {}

        console.log(chalk.yellow(`\n  ⚠ Unfinished run`) + chalk.dim(` · ${ago}`));
        const boxLines = [
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

        const action = await selectKey("", [
          { key: "r", desc: "esume" },
          { key: "h", desc: "istory" },
          { key: "f", desc: "resh" },
          { key: "q", desc: "uit" },
        ]);
        if (action === "q") process.exit(0);
        if (action === "f") { decided = true; break; }
        if (action === "h") { showRunHistory(allRuns, cwd); continue; }
        resuming = true;
        resumeState = prev;
        resumeRunDir = run.dir;
        decided = true;
      } else {
        // Multiple incomplete runs — show numbered list (cap at 9 for single-keystroke selection)
        const shown = incompleteRuns.slice(0, 9);
        console.log(chalk.yellow(`\n  ⚠ ${incompleteRuns.length} unfinished runs${incompleteRuns.length > 9 ? ` (showing newest 9)` : ""}\n`));
        for (let i = 0; i < shown.length; i++) {
          const run = shown[i];
          const s = run.state;
          const ago = formatTimeAgo(s.startedAt);
          const obj = s.objective?.slice(0, 50) || "";
          const merged = s.branches.filter(b => b.status === "merged").length;
          let lastStatus = "";
          try { lastStatus = readFileSync(join(run.dir, "status.md"), "utf-8").trim().split("\n")[0].slice(0, 70); } catch {}
          console.log(chalk.cyan(`  ${i + 1}`) + `  ${obj}${obj.length >= 50 ? "…" : ""}`);
          console.log(chalk.dim(`     ${s.accCompleted}/${s.budget} · $${s.accCost.toFixed(2)} · ${ago} · ${s.phase} at wave ${s.waveNum + 1}${merged ? ` · ${merged} merged` : ""}`));
          if (lastStatus) console.log(chalk.dim(`     ${lastStatus}`));
          console.log("");
        }

        const action = await selectKey(
          `  ${chalk.dim(`[1-${shown.length}] resume`)}`,
          [
            ...shown.map((_, i) => ({ key: String(i + 1), desc: "" })),
            { key: "h", desc: "istory" },
            { key: "f", desc: "resh" },
            { key: "q", desc: "uit" },
          ],
        );
        if (action === "q") process.exit(0);
        if (action === "f") { decided = true; break; }
        if (action === "h") { showRunHistory(allRuns, cwd); continue; }
        const idx = parseInt(action) - 1;
        if (idx >= 0 && idx < shown.length) {
          resuming = true;
          resumeState = shown[idx].state;
          resumeRunDir = shown[idx].dir;
          decided = true;
        }
      }
    }

    if (resuming && resumeState && resumeRunDir) {
      const unmerged = resumeState.branches.filter(b => b.status === "unmerged").length;
      if (unmerged > 0) {
        console.log("");
        autoMergeBranches(cwd, resumeState.branches, (msg) => console.log(chalk.dim(`  ${msg}`)));
        try { saveRunState(resumeRunDir, resumeState); } catch {}
      }
    }
  }

  // ── Interactive flow: Objective → Budget → Model → Usage cap → Plan → Review ──
  let workerModel: string;
  let plannerModel: string;
  let budget: number | undefined;
  let concurrency: number;
  let objective: string | undefined = fileCfg?.objective;
  let usageCap: number | undefined;
  let allowExtraUsage = false;
  let extraUsageBudget: number | undefined;

  if (resuming) {
    // Skip interactive flow entirely — all config is restored from saved state later
    workerModel = resumeState!.workerModel;
    plannerModel = resumeState!.plannerModel;
    budget = resumeState!.budget;
    concurrency = resumeState!.concurrency;
    objective = resumeState!.objective;
    usageCap = resumeState!.usageCap;
    allowExtraUsage = resumeState!.allowExtraUsage ?? false;
    extraUsageBudget = resumeState!.extraUsageBudget;
  } else if (!nonInteractive) {
    // ① Objective
    while (true) {
      objective = await ask(`\n  ${chalk.cyan("①")} ${chalk.bold("What should the agents do?")}\n  ${chalk.cyan(">")} `);
      if (!objective) { console.error(chalk.red("\n  No objective provided.")); process.exit(1); }
      if (objective.split(/\s+/).length >= 5) break;
      console.log(chalk.yellow('  Be specific, e.g. "refactor the auth module, add tests, and update docs"'));
    }

    // Start fetching models while user enters budget
    const modelsPromise = fetchModels();

    // ② Budget
    const budgetAns = await ask(`\n  ${chalk.cyan("②")} ${chalk.dim("Budget")} ${chalk.dim("[")}${chalk.white("10")}${chalk.dim("]:")} `);
    budget = parseInt(budgetAns) || 10;
    if (budget < 1) { console.error(chalk.red(`  Budget must be a positive number`)); process.exit(1); }

    // ③ Worker model — show spinner if models aren't ready yet
    let modelFrame = 0;
    const modelSpinner = setInterval(() => {
      const spin = chalk.cyan(BRAILLE[modelFrame++ % BRAILLE.length]);
      process.stdout.write(`\x1B[2K\r  ${spin} ${chalk.dim("loading models...")}`);
    }, 120);
    let models: ModelInfo[];
    try { models = await modelsPromise; } finally { clearInterval(modelSpinner); process.stdout.write(`\x1B[2K\r`); }
    plannerModel = models[0]?.value || "claude-sonnet-4-6";

    if (models.length > 0) {
      workerModel = await select(`${chalk.cyan("③")} Worker model:`, models.map((m) => ({
        name: m.displayName,
        value: m.value,
        hint: m.description,
      })));
    } else {
      const ans = await ask(`  ${chalk.cyan("③")} ${chalk.dim("Worker model [claude-sonnet-4-6]:")} `);
      workerModel = ans || "claude-sonnet-4-6";
    }

    // ④ Usage cap
    usageCap = await select(`${chalk.cyan("④")} Usage cap:`, [
      { name: "Unlimited", value: undefined as any, hint: "full capacity, wait through rate limits" },
      { name: "90%", value: 0.9, hint: "leave 10% for other work" },
      { name: "75%", value: 0.75, hint: "conservative, plenty of headroom" },
      { name: "50%", value: 0.5, hint: "use half, keep the rest" },
    ]);

    // ⑤ Extra usage
    const extraChoice = await select(`${chalk.cyan("⑤")} Allow extra usage ${chalk.dim("(billed separately)")}:`, [
      { name: "No", value: "no", hint: "stop when plan limits are reached" },
      { name: "Yes, with $ limit", value: "budget", hint: "set a spending cap" },
      { name: "Yes, unlimited", value: "unlimited", hint: "keep going no matter what" },
    ]);
    if (extraChoice === "budget") {
      const budgetAns = await ask(`  ${chalk.dim("Max extra usage $:")} `);
      extraUsageBudget = parseFloat(budgetAns);
      if (!extraUsageBudget || extraUsageBudget <= 0) extraUsageBudget = 5;
      allowExtraUsage = true;
    } else if (extraChoice === "unlimited") {
      allowExtraUsage = true;
    }

    concurrency = Math.min(5, budget);

    // Config summary box
    const parts: string[] = [];
    if (workerModel !== plannerModel) {
      const tier = detectModelTier(workerModel);
      parts.push(`${tier} → ${detectModelTier(plannerModel)}`);
    } else {
      parts.push(detectModelTier(workerModel));
    }
    parts.push(`budget ${budget}`);
    parts.push(`${concurrency}×`);
    if (budget > 2) parts.push("flex");
    if (usageCap != null) parts.push(`cap ${Math.round(usageCap * 100)}%`);
    if (allowExtraUsage) parts.push(extraUsageBudget ? `extra $${extraUsageBudget}` : "extra ∞");
    else parts.push("no extra");
    if (completedRuns.length > 0) parts.push(`${completedRuns.length} prior`);
    const inner = parts.join(chalk.dim(" · "));
    const innerLen = parts.join(" · ").length;
    console.log(chalk.dim(`\n  ╭${"─".repeat(innerLen + 4)}╮`));
    console.log(chalk.dim("  │") + `  ${inner}  ` + chalk.dim("│"));
    console.log(chalk.dim(`  ╰${"─".repeat(innerLen + 4)}╯`));
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
    // Extra usage: default OFF for non-interactive
    allowExtraUsage = argv.includes("--allow-extra-usage");
    const extraBudgetFlag = cliFlags["extra-usage-budget"];
    if (extraBudgetFlag != null) {
      extraUsageBudget = parseFloat(extraBudgetFlag);
      if (isNaN(extraUsageBudget) || extraUsageBudget <= 0) { console.error(chalk.red(`  --extra-usage-budget must be a positive number`)); process.exit(1); }
      allowExtraUsage = true;
    }
  }

  validateConcurrency(concurrency);
  let permissionMode: PermMode = resuming ? resumeState!.permissionMode : (fileCfg?.permissionMode ?? "auto");
  let useWorktrees = resuming ? resumeState!.useWorktrees : (fileCfg?.useWorktrees ?? isGitRepo(cwd));
  if (useWorktrees) validateGitRepo(cwd);
  let mergeStrategy: MergeStrategy = resuming ? resumeState!.mergeStrategy : (fileCfg?.mergeStrategy ?? "yolo");

  if (nonInteractive) {
    const capStr = usageCap != null ? `  cap=${Math.round(usageCap * 100)}%` : "";
    const extraStr = allowExtraUsage ? (extraUsageBudget ? `  extra=$${extraUsageBudget}` : "  extra=∞") : "  extra=off";
    console.log(chalk.dim(`  ${workerModel}  concurrency=${concurrency}  worktrees=${useWorktrees}  merge=${mergeStrategy}  perms=${permissionMode}${capStr}${extraStr}`));
  }

  // ── Flex mode: adaptive multi-wave planning ──
  let flex = !argv.includes("--no-flex") && (fileCfg?.flexiblePlan ?? objective != null) && objective != null && (budget ?? 10) > 2;
  const agentTimeoutMs = cliFlags.timeout ? parseFloat(cliFlags.timeout) * 1000 : undefined;
  let thinkingUsed = 0;
  let thinkingCost = 0, thinkingIn = 0, thinkingOut = 0, thinkingTools = 0;
  let thinkingHistory: WaveSummary | undefined;

  // Create run directory — reuse orphaned run (thinking succeeded, orchestration crashed) if available
  const orphanedDir = !resuming ? findOrphanedDesigns(rootDir) : null;
  const runDir = resuming && resumeRunDir ? resumeRunDir : (orphanedDir ?? createRunDir(rootDir));
  if (resuming && resumeRunDir) updateLatestSymlink(rootDir, resumeRunDir);
  const previousKnowledge = readPreviousRunKnowledge(rootDir);

  // ── Plan phase (interactive: review loop, non-interactive: auto-plan or skip) ──
  const needsPlan = tasks.length === 0 && !resuming;
  const designDir = join(runDir, "designs");

  if (needsPlan) {
    if (noTTY) {
      console.error(chalk.red("  No tasks provided and stdin is not a TTY. Provide tasks via args or a .json file."));
      process.exit(1);
    }

    process.stdout.write("\x1B[?25l");
    const planRestore = () => process.stdout.write("\x1B[?25h");

    const useThinking = flex && (budget ?? 10) > concurrency * 3;
    const thinkingCount = useThinking ? Math.min(Math.max(concurrency, Math.ceil((budget ?? 10) * 0.005)), 10) : 0;

    try {
      if (useThinking) {
        // Phase 1: Quick theme identification → review → then autonomous
        let themes: string[];
        themes = await identifyThemes(objective!, thinkingCount, plannerModel, permissionMode, makeProgressLog());
        process.stdout.write(`\x1B[2K\r  ${chalk.green(`\u2713 ${themes.length} themes`)}\n\n`);

        // Show themes for review — this is the LAST user interaction
        planRestore();
        let reviewing = true;
        while (reviewing) {
          for (let i = 0; i < themes.length; i++) {
            console.log(chalk.dim(`  ${String(i + 1).padStart(3)}.`) + ` ${themes[i]}`);
          }
          console.log(chalk.dim(`\n  ${thinkingCount} thinking agents → orchestrate → ${(budget ?? 10) - thinkingCount} execution sessions\n`));

          const action = await selectKey(
            `${chalk.white(`${themes.length} themes`)} ${chalk.dim(`· ${thinkingCount} thinking · ${concurrency} concurrent`)}`,
            [
              { key: "r", desc: "un" },
              { key: "e", desc: "dit" },
              { key: "q", desc: "uit" },
            ],
          );

          switch (action) {
            case "r": reviewing = false; break;
            case "e": {
              const feedback = await ask(`\n  ${chalk.bold("What should change?")}\n  ${chalk.cyan(">")} `);
              if (!feedback) break;
              process.stdout.write("\x1B[?25l");
              try {
                themes = await identifyThemes(`${objective!}\n\nUser feedback: ${feedback}`, thinkingCount, plannerModel, permissionMode, makeProgressLog());
                process.stdout.write(`\x1B[2K\r  ${chalk.green(`\u2713 ${themes.length} themes`)}\n\n`);
              } catch (err: any) { console.error(chalk.red(`\n  Re-planning failed: ${err.message}\n`)); }
              planRestore();
              break;
            }
            case "q": console.log(chalk.dim("\n  Aborted.\n")); process.exit(0);
          }
        }

        // ── From here, fully autonomous — no more user interaction ──
        process.stdout.write("\x1B[?25l");

        // Phase 2: Thinking wave — skip if design docs already exist (e.g. previous orchestration failed)
        mkdirSync(designDir, { recursive: true });
        const existingDesigns = readMdDir(designDir);
        if (existingDesigns) {
          const designFiles = readdirSync(designDir).filter(f => f.endsWith(".md")).sort();
          console.log(chalk.green(`\n  ✓ Reusing ${designFiles.length} design docs`) + chalk.dim(` (from prior attempt)`));
          for (const f of designFiles) {
            try {
              const firstLine = readFileSync(join(designDir, f), "utf-8").split("\n")[0].replace(/^#+\s*/, "").trim();
              if (firstLine) console.log(chalk.dim(`    ${firstLine.slice(0, 80)}`));
            } catch {}
          }
          console.log("");
        } else {
          const thinkingTasks = buildThinkingTasks(objective!, themes, designDir, plannerModel, previousKnowledge || undefined);
          console.log(chalk.cyan(`\n  ◆ Thinking: ${thinkingTasks.length} agents exploring...\n`));

          const thinkingSwarm = new Swarm({
            tasks: thinkingTasks, concurrency, cwd,
            model: plannerModel,
            permissionMode,
            useWorktrees: false,
            mergeStrategy: "yolo",
            agentTimeoutMs,
            usageCap, allowExtraUsage, extraUsageBudget,
          });
          const thinkRunInfo: RunInfo = {
            accIn: 0, accOut: 0, accCost: 0, accCompleted: 0, accFailed: 0,
            sessionsBudget: budget ?? 10, waveNum: -1, remaining: (budget ?? 10),
            model: plannerModel, startedAt: Date.now(),
          };
          const thinkDisplay = new RunDisplay(thinkRunInfo, { remaining: 0, usageCap, dirty: false });
          thinkDisplay.setWave(thinkingSwarm);
          thinkDisplay.start();
          try { await thinkingSwarm.run(); } finally {
            thinkDisplay.pause();
            console.log(renderSummary(thinkingSwarm));
            thinkDisplay.stop();
          }
          thinkingUsed = thinkingSwarm.completed + thinkingSwarm.failed;
          thinkingCost = thinkingSwarm.totalCostUsd;
          thinkingIn = thinkingSwarm.totalInputTokens;
          thinkingOut = thinkingSwarm.totalOutputTokens;
          thinkingTools = thinkingSwarm.agents.reduce((sum, a) => sum + a.toolCalls, 0);
          // Record thinking wave so steering knows what happened
          thinkingHistory = {
            wave: -1,
            kind: "think" as const,
            tasks: thinkingSwarm.agents.map(a => ({
              prompt: a.task.prompt.slice(0, 200),
              status: a.status,
              filesChanged: a.filesChanged,
              error: a.error,
            })),
          };

          // Wait for rate limit reset before orchestration
          if (thinkingSwarm.rateLimitResetsAt) {
            const waitMs = thinkingSwarm.rateLimitResetsAt - Date.now();
            if (waitMs > 0) {
              console.log(chalk.dim(`  Waiting ${Math.ceil(waitMs / 1000)}s for rate limit reset...`));
              await new Promise(r => setTimeout(r, waitMs + 2000));
            }
          }
        }

        // Phase 3: Orchestrate from design docs
        const designs = readMdDir(designDir);
        const taskFile = join(runDir, "tasks.json");
        if (designs) {
          const orchBudget = Math.min(50, Math.max(concurrency, Math.ceil(((budget ?? 10) - thinkingUsed) * 0.5)));
          const flexNote = `This is wave 1 of an adaptive multi-wave run (total budget: ${(budget ?? 10) - thinkingUsed}). Plan the highest-impact foundational work first. Future waves will iterate based on what's learned.`;
          console.log(chalk.cyan(`\n  ◆ Orchestrating plan...\n`));
          tasks = await orchestrate(objective!, designs, cwd, plannerModel, workerModel, permissionMode, orchBudget, concurrency, makeProgressLog(), flexNote, taskFile);
          process.stdout.write(`\x1B[2K\r  ${chalk.green(`\u2713 ${tasks.length} tasks`)}\n\n`);
        } else {
          console.log(chalk.yellow(`\n  No design docs — falling back to direct planning\n`));
          const waveBudget = Math.min(50, Math.max(concurrency, Math.ceil(((budget ?? 10) - thinkingUsed) * 0.5)));
          tasks = await planTasks(objective!, cwd, plannerModel, workerModel, permissionMode, waveBudget, concurrency, makeProgressLog(), undefined, taskFile);
          process.stdout.write(`\x1B[2K\r  ${chalk.green(`\u2713 ${tasks.length} tasks`)}\n\n`);
        }
      } else {
        // Small budget: direct planning → review → run
        const waveBudget = flex ? Math.min(50, Math.max(concurrency, Math.ceil((budget ?? 10) * 0.5))) : budget;
        const flexNote = flex
          ? `This is wave 1 of an adaptive multi-wave run (total budget: ${budget}). Plan the highest-impact foundational work first. Future waves will iterate, polish, and expand based on what's learned.`
          : undefined;

        console.log(chalk.cyan(`\n  ◆ Planning${flex ? " wave 1" : ""}...\n`));
        tasks = await planTasks(objective!, cwd, plannerModel, workerModel, permissionMode, waveBudget, concurrency, makeProgressLog(), flexNote);
        const flexHint = flex ? chalk.dim(` · wave 1`) : "";
        process.stdout.write(`\x1B[2K\r  ${chalk.green(`\u2713 ${tasks.length} tasks`)}${flexHint}\n\n`);

        // Review loop for small-budget path
        planRestore();
        let reviewing = true;
        while (reviewing) {
          showPlan(tasks);
          const action = await selectKey(
            `${chalk.white(`${tasks.length} tasks`)} ${chalk.dim(`· ${concurrency} concurrent`)}`,
            [
              { key: "r", desc: "un" },
              { key: "e", desc: "dit" },
              { key: "c", desc: "hat" },
              { key: "q", desc: "uit" },
            ],
          );
          switch (action) {
            case "r": reviewing = false; break;
            case "e": {
              const feedback = await ask(`\n  ${chalk.bold("What should change?")}\n  ${chalk.cyan(">")} `);
              if (!feedback) break;
              console.log(chalk.cyan("\n  ◆ Re-planning...\n"));
              process.stdout.write("\x1B[?25l");
              try {
                tasks = await refinePlan(objective!, tasks, feedback, cwd, plannerModel, workerModel, permissionMode, budget, concurrency, makeProgressLog());
                process.stdout.write(`\x1B[2K\r  ${chalk.green(`\u2713 ${tasks.length} tasks`)}\n\n`);
              } catch (err: any) { console.error(chalk.red(`\n  Re-planning failed: ${err.message}\n`)); }
              planRestore();
              break;
            }
            case "c": {
              const question = await ask(`\n  ${chalk.bold("Ask about the plan:")}\n  ${chalk.cyan(">")} `);
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
              } catch { planRestore(); }
              break;
            }
            case "q": console.log(chalk.dim("\n  Aborted.\n")); process.exit(0);
          }
        }
      }
    } catch (err: any) {
      planRestore();
      if (isAuthError(err)) console.error(chalk.red(`\n  Authentication failed — check your API key or run: claude auth\n`));
      else console.error(chalk.red(`\n  Planning failed: ${err.message}\n`));
      process.exit(1);
    }
  }

  if (tasks.length === 0 && !resuming) { console.error("No tasks provided."); process.exit(1); }

  if (dryRun) {
    showPlan(tasks);
    console.log(chalk.dim("  --dry-run: exiting without running\n"));
    process.exit(0);
  }

  // ── Run (wave loop) ──
  const restore = () => { try { process.stdout.write("\x1B[?25h\n"); } catch {} };
  const runStartedAt = resuming && resumeState?.startedAt ? new Date(resumeState.startedAt).getTime() : Date.now();

  // Wave-loop state — either fresh or resumed
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
  let lastWaveKind: string;
  let overheadBudgetUsed: number;
  const branches: BranchRecord[] = [];

  if (resuming && resumeState) {
    // Restore wave-loop state (config already restored in the early resume block + ternaries above)
    // Recalculate remaining from budget — don't trust saved value which counts failures
    // and may have been zeroed by a premature "done" signal from the steerer.
    // The user explicitly chose Resume, so give back budget not yet successfully used.
    remaining = Math.max(1, (resumeState.budget ?? 0) - resumeState.accCompleted);
    currentTasks = resumeState.currentTasks;
    waveNum = resumeState.waveNum;
    accCost = resumeState.accCost;
    accCompleted = resumeState.accCompleted;
    accFailed = resumeState.accFailed;
    accTools = resumeState.accTools ?? 0;
    accIn = resumeState.accIn ?? 0;
    accOut = resumeState.accOut ?? 0;
    lastWaveKind = resumeState.lastWaveKind;
    overheadBudgetUsed = resumeState.overheadBudgetUsed ?? ((resumeState as any).reflectionBudgetUsed ?? 0) + ((resumeState as any).verificationBudgetUsed ?? 0);
    branches.push(...resumeState.branches);
    flex = resumeState.flex; // override computed flex with saved value
    waveHistory.push(...loadWaveHistory(runDir));
    console.log(chalk.green(`\n  ✓ Resumed`) + chalk.dim(` · wave ${waveNum + 1} · ${remaining} remaining · $${accCost.toFixed(2)} spent · ${waveHistory.length} prior waves\n`));
    waveNum++; // advance past last completed wave so next session file doesn't overwrite
  } else {
    // Fresh run
    if (objective && !existsSync(join(runDir, "goal.md"))) {
      writeFileSync(join(runDir, "goal.md"), `## Original Objective\n${objective}`, "utf-8");
    }
    remaining = (budget ?? tasks.length) - thinkingUsed;
    currentTasks = tasks;
    waveNum = 0;
    if (thinkingHistory) waveHistory.push(thinkingHistory);
    accCost = thinkingCost;
    accCompleted = 0;
    accFailed = 0;
    accTools = thinkingTools;
    accIn = thinkingIn;
    accOut = thinkingOut;
    lastWaveKind = "execute";
    overheadBudgetUsed = 0;
  }
  liveConfig.remaining = remaining;
  liveConfig.usageCap = usageCap;
  const maxOverheadBudget = Math.max(4, Math.ceil((budget ?? 10) * 0.15));

  // Unified display — one instance for the entire run
  const runInfoRef: RunInfo = {
    accIn, accOut, accCost, accCompleted, accFailed,
    sessionsBudget: budget ?? tasks.length, waveNum, remaining,
    model: workerModel, startedAt: runStartedAt,
  };
  const display = new RunDisplay(runInfoRef, liveConfig);
  const rlGetter = () => {
    const rl = getPlannerRateLimitInfo();
    return { utilization: rl.utilization, isUsingOverage: rl.isUsingOverage, windows: rl.windows, resetsAt: rl.resetsAt };
  };

  // For flex + branch strategy: create one target branch, waves merge via yolo into it
  let runBranch: string | undefined;
  let originalRef: string | undefined;
  if (flex && mergeStrategy === "branch" && useWorktrees && !resuming) {
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
  let steeringFailed = false;
  const gracefulStop = (signal: string) => {
    if (stopping) { currentSwarm?.cleanup(); display.stop(); restore(); process.exit(0); }
    stopping = true;
    currentSwarm?.abort();
  };
  process.on("SIGINT", () => gracefulStop("SIGINT"));
  process.on("SIGTERM", () => gracefulStop("SIGTERM"));
  process.on("uncaughtException", (err) => { currentSwarm?.abort(); currentSwarm?.cleanup(); display.stop(); restore(); console.error(chalk.red(`\n  Uncaught: ${err.message}`)); process.exit(1); });
  process.on("unhandledRejection", (reason) => { currentSwarm?.abort(); currentSwarm?.cleanup(); display.stop(); restore(); console.error(chalk.red(`\n  Unhandled: ${reason instanceof Error ? reason.message : reason}`)); process.exit(1); });

  // Helper: sync mutable runInfo with accumulated state
  const syncRunInfo = () => Object.assign(runInfoRef, { accIn, accOut, accCost, accCompleted, accFailed, waveNum, remaining });

  // When resuming a flex run with no queued tasks, steer immediately to get the next wave
  if (resuming && flex && currentTasks.length === 0 && remaining > 0) {
    let steerAttempts = 0;
    display.setSteering(rlGetter);
    display.start();

    while (currentTasks.length === 0 && remaining > 0 && !objectiveComplete && steerAttempts < 3) {
      steerAttempts++;
      const plannerCostBefore = getTotalPlannerCost();
      try {
        const memory = readRunMemory(runDir, previousKnowledge || undefined);
        const steer = await steerWave(
          objective!, waveHistory, remaining, cwd, plannerModel, workerModel,
          permissionMode, concurrency, (text) => display.updateText(text), memory,
        );
        const steerCost = getTotalPlannerCost() - plannerCostBefore;
        accCost += steerCost;
        syncRunInfo();

        if (steer.statusUpdate) writeStatus(runDir, steer.statusUpdate);
        if (steer.goalUpdate) writeGoalUpdate(runDir, steer.goalUpdate);

        if (steer.done || steer.tasks.length === 0) {
          const hasVerification = waveHistory.some(w => w.kind.includes("verif"));
          if (!hasVerification && remaining >= 1) {
            display.updateText(`Done blocked \u2014 verification required`);
            lastWaveKind = "done-blocked";
            continue;
          }
          objectiveComplete = true;
          remaining = 0;
        } else {
          const isOverhead = steer.waveKind !== "execute";
          if (isOverhead && overheadBudgetUsed + steer.tasks.length > maxOverheadBudget) {
            display.updateText(`Overhead budget exhausted (${overheadBudgetUsed}/${maxOverheadBudget}) \u2014 re-assessing`);
            lastWaveKind = "overhead-capped";
            continue;
          }
          currentTasks = steer.tasks.map(t => ({
            ...t,
            model: t.model === "planner" ? plannerModel : t.model === "worker" ? workerModel
              : isOverhead && !t.model ? plannerModel : t.model,
          }));
          lastWaveKind = steer.waveKind;
          if (isOverhead) overheadBudgetUsed += currentTasks.length;
        }
      } catch (err: any) {
        const steerCost = getTotalPlannerCost() - plannerCostBefore;
        accCost += steerCost;
        display.stop();
        console.log(chalk.yellow(`  Steering failed: ${err.message?.slice(0, 80)} \u2014 stopping\n`));
        break;
      }
    }
  }

  // Start unified display (first call — idempotent)
  if (!display.runInfo.startedAt) display.runInfo.startedAt = runStartedAt;
  display.start();

  while (remaining > 0 && currentTasks.length > 0 && !stopping) {
    if (currentTasks.length > remaining) currentTasks = currentTasks.slice(0, remaining);
    syncRunInfo();

    const swarm = new Swarm({
      tasks: currentTasks, concurrency, cwd, model: workerModel, permissionMode, allowedTools,
      useWorktrees, mergeStrategy: waveMerge, agentTimeoutMs, usageCap, allowExtraUsage, extraUsageBudget,
      baseCostUsd: accCost,
    });
    currentSwarm = swarm;

    display.setWave(swarm);
    display.resume();
    try {
      await swarm.run();
    } catch (err: unknown) {
      if (isAuthError(err)) { display.stop(); restore(); console.error(chalk.red(`\n  Authentication failed — check your API key or run: claude auth\n`)); process.exit(1); }
      throw err;
    }

    // Show wave summary (pauses render, prints, then we switch to steering)
    display.pause();
    console.log(renderSummary(swarm));

    // Accumulate
    accCost += swarm.totalCostUsd;
    accIn += swarm.totalInputTokens;
    accOut += swarm.totalOutputTokens;
    accCompleted += swarm.completed;
    accFailed += swarm.failed;
    accTools += swarm.agents.reduce((sum, a) => sum + a.toolCalls, 0);
    remaining = Math.max(0, remaining - swarm.completed - swarm.failed);
    const expectedFloor = Math.max(0, (budget ?? 0) - accCompleted - accFailed);
    if (remaining < expectedFloor) remaining = expectedFloor;
    if (liveConfig.dirty) {
      remaining = liveConfig.remaining;
      usageCap = liveConfig.usageCap;
      liveConfig.dirty = false;
    }
    liveConfig.remaining = remaining;
    lastCapped = swarm.cappedOut;
    lastAborted = swarm.aborted;
    recordBranches(swarm, branches);
    saveWaveSession(runDir, waveNum, lastWaveKind, swarm);
    saveRunState(runDir, {
      id: `run-${new Date().toISOString().slice(0, 19)}`, objective: objective!, budget: budget ?? tasks.length,
      remaining, workerModel, plannerModel, concurrency, permissionMode,
      usageCap, allowExtraUsage, extraUsageBudget, flex, useWorktrees, mergeStrategy, waveNum, currentTasks: [],
      lastWaveKind, overheadBudgetUsed, accCost, accCompleted, accFailed, accIn, accOut, accTools,
      branches, phase: "steering", startedAt: new Date(runStartedAt).toISOString(), cwd,
    });

    waveHistory.push({
      wave: waveNum,
      kind: lastWaveKind,
      tasks: swarm.agents.map(a => ({
        prompt: a.task.prompt,
        status: a.status,
        filesChanged: a.filesChanged,
        error: a.error,
      })),
    });

    if (!flex || remaining <= 0 || swarm.aborted || swarm.cappedOut) break;

    // ── Steer: assess and compose the next wave ──
    syncRunInfo();
    display.setSteering(rlGetter);
    display.resume();

    let steered = false;
    let steerAttempts = 0;
    while (!steered && remaining > 0 && !stopping && steerAttempts < 3) {
      steerAttempts++;
      const plannerCostBefore = getTotalPlannerCost();
      try {
        const memory = readRunMemory(runDir, previousKnowledge || undefined);
        const steer = await steerWave(
          objective!, waveHistory, remaining, cwd, plannerModel, workerModel,
          permissionMode, concurrency, (text) => display.updateText(text), memory,
        );
        const steerCost = getTotalPlannerCost() - plannerCostBefore;
        accCost += steerCost;
        syncRunInfo();

        if (steer.statusUpdate) writeStatus(runDir, steer.statusUpdate);
        if (steer.goalUpdate) writeGoalUpdate(runDir, steer.goalUpdate);
        const execWaves = waveHistory.filter(w => w.kind === "execute").length;
        if (execWaves > 0 && execWaves % 5 === 0) archiveMilestone(runDir, waveNum);

        if (steer.done || steer.tasks.length === 0) {
          const hasVerification = waveHistory.some(w => w.kind.includes("verif"));
          if (!hasVerification && remaining >= 1) {
            display.updateText(`Done blocked \u2014 verification required`);
            lastWaveKind = "done-blocked";
            continue;
          }
          objectiveComplete = true;
          remaining = 0;
          break;
        }

        const isOverhead = steer.waveKind !== "execute";
        if (isOverhead && overheadBudgetUsed + steer.tasks.length > maxOverheadBudget) {
          display.updateText(`Overhead budget exhausted (${overheadBudgetUsed}/${maxOverheadBudget}) \u2014 re-assessing`);
          lastWaveKind = "overhead-capped";
          continue;
        }

        currentTasks = steer.tasks.map(t => ({
          ...t,
          model: t.model === "planner" ? plannerModel : t.model === "worker" ? workerModel
            : isOverhead && !t.model ? plannerModel : t.model,
        }));
        lastWaveKind = steer.waveKind;
        if (isOverhead) overheadBudgetUsed += currentTasks.length;
        steered = true;
      } catch (err: any) {
        const steerCost = getTotalPlannerCost() - plannerCostBefore;
        accCost += steerCost;
        if (steerAttempts < 3) {
          display.updateText(`Steering failed (attempt ${steerAttempts}/3) — retrying...`);
          continue;
        }
        display.stop();
        console.log(chalk.yellow(`  Steering failed after ${steerAttempts} attempts: ${err.message?.slice(0, 80)} — stopping\n`));
        steeringFailed = true;
        break;
      }
    }
    if (!steered) break;
    waveNum++;
  }

  display.stop();

  // Only truly "done" if steering explicitly completed the objective (or non-flex single wave with budget exhausted)
  const trulyDone = objectiveComplete || (!flex && remaining <= 0);
  const finalPhase = trulyDone ? "done" : steeringFailed ? "steering" : "capped";
  saveRunState(runDir, {
    id: `run-${new Date().toISOString().slice(0, 19)}`, objective: objective ?? "", budget: budget ?? tasks.length,
    remaining, workerModel, plannerModel, concurrency, permissionMode,
    usageCap, allowExtraUsage, extraUsageBudget, flex, useWorktrees, mergeStrategy, waveNum, currentTasks: [],
    lastWaveKind, overheadBudgetUsed, accCost, accCompleted, accFailed, accIn, accOut, accTools,
    branches, phase: finalPhase, startedAt: new Date(runStartedAt).toISOString(), cwd,
  });
  if (trulyDone) {
    try { rmSync(join(runDir, "designs"), { recursive: true, force: true }); } catch {}
    try { rmSync(join(runDir, "reflections"), { recursive: true, force: true }); } catch {}
    try { rmSync(join(runDir, "verifications"), { recursive: true, force: true }); } catch {}
  }

  // Switch back if we created a run branch
  if (runBranch && originalRef) {
    try { execSync(`git checkout "${originalRef}"`, { cwd, encoding: "utf-8", stdio: "pipe" }); } catch {}
  }

  // ── Final summary ──
  const waves = waveNum + 1;
  const elapsed = Math.round((Date.now() - runStartedAt) / 1000);
  const elapsedStr = elapsed < 60 ? `${elapsed}s` : elapsed < 3600 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${Math.floor(elapsed / 3600)}h ${Math.floor((elapsed % 3600) / 60)}m`;

  const totalMerged = branches.filter(b => b.status === "merged").length;
  const totalConflicts = branches.filter(b => b.status === "merge-failed").length;
  const termW = Math.max((process.stdout.columns ?? 80) || 80, 50);

  // Banner
  console.log("");
  const bannerChar = accFailed === 0 ? "=" : "-";
  console.log(chalk.green(`  ${bannerChar.repeat(Math.min(termW - 4, 60))}`));
  if (trulyDone) {
    console.log(chalk.bold.green(`  CLAUDE OVERNIGHT — COMPLETE`));
  } else if (steeringFailed) {
    console.log(chalk.bold.yellow(`  CLAUDE OVERNIGHT — STEERING FAILED`));
  } else {
    console.log(chalk.bold.yellow(`  CLAUDE OVERNIGHT — BUDGET EXHAUSTED`));
  }
  console.log(chalk.green(`  ${bannerChar.repeat(Math.min(termW - 4, 60))}`));
  console.log("");

  // Stats grid
  const statRows = [
    [chalk.bold("Waves"), String(waves), chalk.bold("Sessions"), `${accCompleted} done${accFailed > 0 ? ` / ${accFailed} failed` : ""}`],
    [chalk.bold("Cost"), chalk.green(`$${accCost.toFixed(2)}`), chalk.bold("Elapsed"), elapsedStr],
    [chalk.bold("Merged"), `${totalMerged} branches`, chalk.bold("Conflicts"), totalConflicts > 0 ? chalk.red(String(totalConflicts)) : chalk.green("0")],
    [chalk.bold("Tokens"), `${fmtTokens(accIn)} in / ${fmtTokens(accOut)} out`, chalk.bold("Tool calls"), String(accTools)],
  ];
  for (const [k1, v1, k2, v2] of statRows) {
    console.log(`  ${k1}  ${v1.padEnd(20)}  ${k2}  ${v2}`);
  }
  if (overheadBudgetUsed > 0) console.log(`  ${chalk.bold("Overhead")}  ${overheadBudgetUsed} agents (review/verify/explore)`);
  if (lastCapped) console.log(`  ${chalk.yellow(`Capped at ${usageCap != null ? Math.round(usageCap * 100) : 100}%`)}`);
  console.log("");

  // Status summary (the product-level assessment from the planner)
  const statusFile = join(runDir, "status.md");
  if (existsSync(statusFile)) {
    const statusContent = readFileSync(statusFile, "utf-8").trim();
    if (statusContent) {
      console.log(chalk.dim(`  ${"─".repeat(Math.min(termW - 4, 60))}`));
      console.log(chalk.bold("  Status"));
      console.log("");
      for (const line of statusContent.split("\n")) {
        console.log(`  ${line}`);
      }
      console.log("");
    }
  }

  // Conflicts detail
  if (totalConflicts > 0) {
    console.log(chalk.dim(`  ${"─".repeat(Math.min(termW - 4, 60))}`));
    const conflictBranches = branches.filter(b => b.status === "merge-failed");
    console.log(chalk.red(`  Unresolved conflicts:`));
    for (const c of conflictBranches) console.log(chalk.red(`    ${c.branch}`));
    console.log(chalk.dim("  git merge <branch> to resolve"));
    console.log("");
  }

  // Footer
  console.log(chalk.dim(`  ${"─".repeat(Math.min(termW - 4, 60))}`));
  if (runBranch) console.log(chalk.dim(`  Branch: ${runBranch} — git merge ${runBranch}`));
  console.log(chalk.dim(`  Run: ${runDir}`));
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
