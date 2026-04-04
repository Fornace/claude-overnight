#!/usr/bin/env node
import { readFileSync } from "fs";
import { resolve } from "path";
import { createInterface } from "readline";
import chalk from "chalk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { Swarm } from "./swarm.js";
import { planTasks } from "./planner.js";
import { startRenderLoop } from "./ui.js";
import type { Task, TaskFile } from "./types.js";

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
  cwd?: string;
  allowedTools?: string[];
  useWorktrees?: boolean;
}

function loadTaskFile(file: string): FileArgs {
  const raw = readFileSync(resolve(file), "utf-8");
  const parsed: TaskFile & { worktrees?: boolean } = Array.isArray(JSON.parse(raw))
    ? { tasks: JSON.parse(raw) }
    : JSON.parse(raw);

  const tasks: Task[] = [];
  for (const t of parsed.tasks || []) {
    const id = String(tasks.length);
    if (typeof t === "string") {
      tasks.push({ id, prompt: t });
    } else {
      tasks.push({ id, prompt: t.prompt, cwd: t.cwd ? resolve(t.cwd) : undefined, model: t.model });
    }
  }

  return {
    tasks,
    concurrency: parsed.concurrency,
    model: parsed.model,
    cwd: parsed.cwd ? resolve(parsed.cwd) : undefined,
    allowedTools: parsed.allowedTools,
    useWorktrees: parsed.worktrees,
  };
}

// ── Main ──

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(`
  ${chalk.bold("claude-swarm")} — parallel Claude Code agents with real-time UI

  ${chalk.dim("Usage:")}
    claude-swarm                                   ${chalk.dim("# interactive mode")}
    claude-swarm tasks.json                        ${chalk.dim("# run task file")}
    claude-swarm "fix auth" "add tests"            ${chalk.dim("# inline tasks")}
    `);
    process.exit(0);
  }

  // ── Load tasks from file or inline args ──
  let tasks: Task[] = [];
  let fileCfg: FileArgs | undefined;

  for (const arg of argv) {
    if (arg.endsWith(".json")) {
      fileCfg = loadTaskFile(arg);
      tasks = fileCfg.tasks;
    } else {
      tasks.push({ id: String(tasks.length), prompt: arg });
    }
  }

  // ── Interactive config ──
  console.log(chalk.bold("\n  🐝 claude-swarm\n"));

  process.stdout.write(chalk.dim("  Fetching available models..."));
  const models = await fetchModels();
  process.stdout.write(`\x1B[2K\r`);

  const model = fileCfg?.model ?? (await pickModel(models));
  const concurrency = fileCfg?.concurrency ?? (await pickConcurrency());
  const useWorktrees = fileCfg?.useWorktrees ?? (await pickWorktrees());
  const cwd = fileCfg?.cwd ?? process.cwd();
  const allowedTools = fileCfg?.allowedTools;

  // If no tasks yet, ask for an objective and plan
  let planMode = tasks.length === 0;
  let objective: string | undefined;

  if (planMode) {
    objective = await pickObjective();
    if (!objective) {
      console.error(chalk.red("\n  No objective provided."));
      process.exit(1);
    }
  }

  // Hide cursor + graceful shutdown
  process.stdout.write("\x1B[?25l");
  const restore = () => process.stdout.write("\x1B[?25h\n");
  process.on("SIGINT", () => { restore(); process.exit(0); });
  process.on("SIGTERM", () => { restore(); process.exit(0); });

  // ── Plan phase ──
  if (planMode && objective) {
    console.log(chalk.magenta("\n  Planning...\n"));
    try {
      tasks = await planTasks(objective, cwd, model, (text) => {
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

  const swarm = new Swarm({
    tasks,
    concurrency,
    cwd,
    model,
    allowedTools,
    useWorktrees,
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
        ? chalk.dim(` ($${swarm.totalCostUsd.toFixed(3)})`)
        : "";
    console.log(`\n  ${chalk.bold("Complete:")} ${summary}${cost}`);

    if (swarm.mergeResults.length > 0) {
      const merged = swarm.mergeResults.filter((r) => r.ok).length;
      const conflicts = swarm.mergeResults.filter((r) => !r.ok);
      if (merged > 0) {
        console.log(chalk.green(`  Merged ${merged} branch(es) into HEAD`));
      }
      if (conflicts.length > 0) {
        console.log(chalk.red(`  ${conflicts.length} branch(es) had merge conflicts:`));
        for (const c of conflicts) {
          console.log(chalk.red(`    ${c.branch}: ${c.error}`));
        }
        console.log(chalk.dim("  Branches preserved — merge manually with: git merge <branch>"));
      }
    }
    console.log("");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  process.stdout.write("\x1B[?25h");
  console.error(chalk.red(err.message || err));
  process.exit(1);
});
