import { readFileSync } from "fs";
import type { AITurn, Task } from "../core/types.js";
import { runPlannerQuery, extractTaskJson, attemptJsonParse, postProcess } from "./query.js";
import { contextConstraintNote } from "../core/models.js";
import { createTurn, beginTurn, endTurn } from "../core/turns.js";
import { renderPrompt } from "../prompts/load.js";

// Resilience: if the planner query throws but the agent already wrote valid
// tasks to `outFile` (via its Write tool), salvage them instead of discarding
// expensive work. Returns salvaged tasks on success, null if nothing usable on
// disk  -- caller should then re-throw the original error.
export function salvageFromFile(outFile: string | undefined, budget: number | undefined, onLog: (text: string, kind?: "status" | "event") => void, why: string): Task[] | null {
  if (!outFile) return null;
  try {
    const parsed = attemptJsonParse(readFileSync(outFile, "utf-8"));
    if (!parsed?.tasks?.length) return null;
    let tasks: Task[] = parsed.tasks.map((t: any, i: number) => ({
      id: String(i), prompt: typeof t === "string" ? t : t.prompt, type: "execute",
    }));
    tasks = postProcess(tasks, budget, onLog);
    if (tasks.length === 0) return null;
    onLog(`Planner errored (${why})  -- salvaged ${tasks.length} tasks from ${outFile}`, "event");
    return tasks;
  } catch { return null; }
}

// Read-only recon tools for the themes picker. Includes cclsp + serena LSP
// tools so runs under the LSP enforcement kit (which blocks Grep/Glob on code
// symbols) still have a path forward. Unknown MCP tool names are ignored by
// the SDK when their server isn't connected, so this is a no-op otherwise.
const THEMES_RECON_TOOLS = [
  "Read", "Glob", "Grep",
  "mcp__cclsp__find_workspace_symbols",
  "mcp__cclsp__find_definition",
  "mcp__cclsp__find_references",
  "mcp__cclsp__get_hover",
  "mcp__serena__find_symbol",
  "mcp__serena__find_referencing_symbols",
  "mcp__serena__get_symbols_overview",
];


// ── JSON schemas for structured output ──

const TASKS_SCHEMA = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    properties: { tasks: { type: "array", items: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] } } },
    required: ["tasks"],
  },
};

const THEMES_SCHEMA = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    properties: { themes: { type: "array", items: { type: "string" } } },
    required: ["themes"],
  },
};

// ── Budget breakpoints for prompt strategy ──

const BUDGET_FOCUSED = 10; // ≤ this → surgical, file-specific tasks
const BUDGET_SUBSTANTIAL = 30; // ≤ this → mission-level, autonomous agents

function plannerPrompt(objective: string, workerModel: string, budget?: number, concurrency?: number, flexNote?: string): string {
  const b = budget ?? BUDGET_FOCUSED;
  const variant = b <= BUDGET_FOCUSED ? "TIGHT" : b <= BUDGET_SUBSTANTIAL ? "STANDARD" : "LARGE";
  return renderPrompt("10_planning/10-3_plan", {
    variant,
    vars: {
      objective, budget: b, concurrency, flexNote,
      contextConstraintNote: contextConstraintNote(workerModel),
    },
  });
}

// ── Shared structured-planning pipeline ──
//
// `planTasks`, `orchestrate`, and `refinePlan` all follow the same shape:
// run a structured-output planner query, salvage from disk if it crashes
// mid-write, retry the JSON parse with a `_shared/retry-json` wrapper, then
// shape into Task[] and postProcess. This helper folds that boilerplate.
//
// `mainPrompt` is what the model sees on the first attempt; `retryPrompt`
// is wrapped by the retry-json template if the first parse fails. They differ
// only when callers append per-call file instructions to the main run that
// they don't want carried forward into the retry (`planTasks`).

interface StructuredPlanningArgs {
  mainPrompt: string;
  retryPrompt: string;
  cwd: string;
  plannerModel: string;
  budget: number | undefined;
  onLog: (text: string, kind?: "status" | "event") => void;
  transcriptName: string;
  turn: AITurn;
  mainTools?: string[];
  mainMaxTurns: number;
  retryMaxTurns: number;
  outFile?: string;
  failureLabel: string;
}

async function runStructuredPlanningQuery(args: StructuredPlanningArgs): Promise<Task[]> {
  const { mainPrompt, retryPrompt, cwd, plannerModel, budget, onLog,
          transcriptName, turn, mainTools, mainMaxTurns, retryMaxTurns,
          outFile, failureLabel } = args;

  let resultText: string;
  try {
    resultText = await runPlannerQuery(mainPrompt, {
      cwd, model: plannerModel, outputFormat: TASKS_SCHEMA,
      transcriptName, maxTurns: mainMaxTurns, turnId: turn.id,
      ...(mainTools && { tools: mainTools }),
    }, onLog);
  } catch (err: any) {
    const salvaged = salvageFromFile(outFile, budget, onLog, err?.message ?? String(err));
    endTurn(turn, salvaged ? "done" : "error");
    if (salvaged) return salvaged;
    throw err;
  }

  let tasks: Task[];
  try {
    const parsed = await extractTaskJson(resultText, async () => {
      onLog("Retrying...");
      return runPlannerQuery(
        renderPrompt("_shared/retry-json", { vars: { originalPrompt: retryPrompt } }),
        { cwd, model: plannerModel, outputFormat: TASKS_SCHEMA,
          transcriptName: `${transcriptName}-retry`, maxTurns: retryMaxTurns, turnId: turn.id },
        onLog,
      );
    }, onLog, outFile);
    tasks = (parsed.tasks || []).map((t: any, i: number) => ({
      id: String(i), prompt: typeof t === "string" ? t : t.prompt, type: "execute",
    }));
    tasks = postProcess(tasks, budget, onLog);
  } catch { endTurn(turn, "error"); throw new Error(failureLabel); }

  endTurn(turn, tasks.length === 0 ? "error" : "done");
  if (tasks.length === 0) throw new Error(failureLabel);
  onLog(`${tasks.length} tasks`);
  return tasks;
}

// ── Planning functions ──

export async function planTasks(
  objective: string, cwd: string, plannerModel: string, workerModel: string,
  budget: number | undefined, concurrency: number,
  onLog: (text: string) => void, flexNote?: string, outFile?: string,
  transcriptName: string = "plan",
): Promise<Task[]> {
  onLog("Analyzing codebase...");
  const turn = createTurn("plan", "Plan", "plan-0", plannerModel);
  beginTurn(turn);
  const prompt = plannerPrompt(objective, workerModel, budget, concurrency, flexNote);
  const fileInstruction = outFile ? `\n\nAFTER generating the JSON, also write it to ${outFile} using the Write tool.` : "";
  return runStructuredPlanningQuery({
    mainPrompt: prompt + fileInstruction,
    retryPrompt: prompt,
    cwd, plannerModel, budget, onLog, transcriptName, turn,
    mainTools: ["Read", "Glob", "Grep", "Write"],
    mainMaxTurns: 40, retryMaxTurns: 15,
    outFile, failureLabel: "Planner generated 0 tasks",
  });
}

export async function identifyThemes(
  objective: string, count: number, cwd: string, model: string,
  onLog: (text: string) => void = () => {},
  transcriptName: string = "themes",
): Promise<string[]> {
  const turn = createTurn("identify-themes", `Themes (${count})`, "themes-0", model);
  beginTurn(turn);
  try {
    const resultText = await runPlannerQuery(
      renderPrompt("10_planning/10-1_identify-themes", { vars: { count, objective } }),
      { cwd, model, outputFormat: THEMES_SCHEMA, transcriptName, maxTurns: 12, turnId: turn.id, tools: THEMES_RECON_TOOLS }, onLog,
    );
    const parsed = attemptJsonParse(resultText);
    endTurn(turn, "done");
    if (parsed?.themes && Array.isArray(parsed.themes)) return parsed.themes.slice(0, count);
    throw new Error("themes picker returned no themes");
  } catch (err) { endTurn(turn, "error"); throw err; }
}

export function buildThinkingTasks(
  objective: string, themes: string[], designDir: string, plannerModel: string, previousKnowledge?: string,
): Task[] {
  return themes.map((theme, i) => ({
    id: `think-${i}`,
    prompt: renderPrompt("10_planning/10-2_thinking-tasks", {
      vars: { theme, objective, designDir, index: i, previousKnowledge },
    }),
    model: plannerModel,
  }));
}

export async function orchestrate(
  objective: string, designDocs: string, cwd: string, plannerModel: string, workerModel: string,
  budget: number, concurrency: number,
  onLog: (text: string) => void, flexNote?: string, outFile?: string,
  transcriptName: string = "orchestrate",
): Promise<Task[]> {
  const fileInstruction = outFile ? `AFTER generating the JSON, also write it to ${outFile} using the Write tool.` : "";
  const prompt = renderPrompt("10_planning/10-4_orchestrate", {
    vars: {
      objective, designDocs, budget, concurrency, flexNote, fileInstruction,
      contextConstraintNote: contextConstraintNote(workerModel),
    },
  });

  onLog("Synthesizing...");
  const turn = createTurn("orchestrate", "Orchestrate", "orchestrate-0", plannerModel);
  beginTurn(turn);
  return runStructuredPlanningQuery({
    mainPrompt: prompt, retryPrompt: prompt,
    cwd, plannerModel, budget, onLog, transcriptName, turn,
    mainTools: ["Write"],
    mainMaxTurns: 25, retryMaxTurns: 10,
    outFile, failureLabel: "Orchestration generated 0 tasks",
  });
}

export async function refinePlan(
  objective: string, previousTasks: Task[], feedback: string, cwd: string,
  plannerModel: string, workerModel: string,
  budget: number | undefined, concurrency: number, onLog: (text: string) => void,
  transcriptName: string = "refine",
): Promise<Task[]> {
  onLog("Refining plan...");
  const turn = createTurn("plan-refine", "Refine plan", "refine-0", plannerModel);
  beginTurn(turn);
  const previousTasksList = previousTasks.map((t, i) => `${i + 1}. ${t.prompt}`).join("\n");
  const b = budget ?? 10;
  const scaleNote = b > 50 ? `This is a LARGE budget (${b} sessions). Think big  -- missions, not micro-tasks.`
    : b > 15 ? `Each of the ${b} sessions is a capable AI agent. Give substantial missions, not trivial edits.`
    : `Target ~${b} tasks.`;
  const prompt = renderPrompt("10_planning/10-5_refine", {
    vars: {
      objective, previousTasks: previousTasksList, feedback, scaleNote, concurrency,
      contextConstraintNote: contextConstraintNote(workerModel),
    },
  });

  return runStructuredPlanningQuery({
    mainPrompt: prompt, retryPrompt: prompt,
    cwd, plannerModel, budget, onLog, transcriptName, turn,
    mainMaxTurns: 15, retryMaxTurns: 8,
    failureLabel: "Refinement produced 0 tasks",
  });
}
