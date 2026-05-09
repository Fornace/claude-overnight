// Task-file / plan-file loading. Pure: throws on bad input, no stdio.

import { readFileSync } from "fs";
import { resolve } from "path";
import type { Task, MergeStrategy } from "../core/types.js";
import { validateConcurrency } from "./argv.js";

export interface FileArgs {
  tasks: Task[];
  objective?: string;
  concurrency?: number;
  model?: string;
  cwd?: string;
  allowedTools?: string[];
  beforeWave?: string | string[];
  afterWave?: string | string[];
  afterRun?: string | string[];
  useWorktrees?: boolean;
  mergeStrategy?: MergeStrategy;
  usageCap?: number;
  flexiblePlan?: boolean;
}

const KNOWN_TASK_FILE_KEYS = new Set([
  "tasks", "objective", "concurrency", "cwd", "model", "allowedTools",
  "beforeWave", "afterWave", "afterRun", "worktrees", "mergeStrategy",
  "usageCap", "flexiblePlan",
]);

/** Load a markdown plan file. Extracts the first H1 as objective and returns the full body as planContent. */
export function loadPlanFile(file: string): { objective: string; planContent: string } {
  const path = resolve(file);
  let raw: string;
  try { raw = readFileSync(path, "utf-8"); } catch { throw new Error(`Cannot read plan file: ${path}`); }
  const body = raw.trim();
  if (!body) throw new Error(`Plan file is empty: ${path}`);
  const h1 = body.match(/^#\s+(.+)$/m);
  const objective = (h1?.[1] ?? body.split("\n").find(l => l.trim())!).trim();
  return { objective, planContent: body };
}

export function loadTaskFile(file: string): FileArgs {
  const path = resolve(file);
  let raw: string;
  try { raw = readFileSync(path, "utf-8"); } catch { throw new Error(`Cannot read task file: ${path}`); }

  let json: unknown;
  try { json = JSON.parse(raw); } catch { throw new Error(`Task file is not valid JSON: ${path}`); }

  const parsed: any = Array.isArray(json) ? { tasks: json } : json;

  if (!Array.isArray(json) && typeof json === "object" && json !== null) {
    const unknown = Object.keys(json).filter((k) => !KNOWN_TASK_FILE_KEYS.has(k));
    if (unknown.length > 0) {
      throw new Error(`Unknown key${unknown.length > 1 ? "s" : ""} in task file: ${unknown.join(", ")}. Allowed: ${[...KNOWN_TASK_FILE_KEYS].join(", ")}`);
    }
  }

  if (!Array.isArray(parsed.tasks)) throw new Error(`Task file must contain a "tasks" array (got ${typeof parsed.tasks})`);

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

  const usageCap = parsed.usageCap;
  if (usageCap != null && (typeof usageCap !== "number" || usageCap < 0 || usageCap > 100)) {
    throw new Error(`usageCap must be a number between 0 and 100 (got ${JSON.stringify(usageCap)})`);
  }

  if (parsed.flexiblePlan && typeof parsed.objective !== "string") {
    throw new Error(`flexiblePlan requires an "objective" string in the task file`);
  }

  return {
    tasks,
    objective: typeof parsed.objective === "string" ? parsed.objective : undefined,
    concurrency: parsed.concurrency,
    model: parsed.model,
    cwd: parsed.cwd ? resolve(parsed.cwd) : undefined,
    allowedTools: parsed.allowedTools,
    beforeWave: parsed.beforeWave,
    afterWave: parsed.afterWave,
    afterRun: parsed.afterRun,
    useWorktrees: parsed.worktrees,
    mergeStrategy: parsed.mergeStrategy,
    usageCap,
    flexiblePlan: parsed.flexiblePlan,
  };
}
