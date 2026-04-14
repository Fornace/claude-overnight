import { readFileSync } from "fs";
import type { Task, PermMode } from "./types.js";
import { runPlannerQuery, extractTaskJson, attemptJsonParse, postProcess, detectModelTier, modelCapabilityBlock } from "./planner-query.js";

// Resilience: if the planner query throws but the agent already wrote valid
// tasks to `outFile` (via its Write tool), salvage them instead of discarding
// expensive work. Returns salvaged tasks on success, null if nothing usable on
// disk — caller should then re-throw the original error.
export function salvageFromFile(outFile: string | undefined, budget: number | undefined, onLog: (text: string, kind?: "status" | "event") => void, why: string): Task[] | null {
  if (!outFile) return null;
  try {
    const parsed = attemptJsonParse(readFileSync(outFile, "utf-8"));
    if (!parsed?.tasks?.length) return null;
    let tasks: Task[] = parsed.tasks.map((t: any, i: number) => ({
      id: String(i), prompt: typeof t === "string" ? t : t.prompt,
    }));
    tasks = postProcess(tasks, budget, onLog);
    if (tasks.length === 0) return null;
    onLog(`Planner errored (${why}) — salvaged ${tasks.length} tasks from ${outFile}`, "event");
    return tasks;
  } catch { return null; }
}

// The core framing for all planning. Not a checklist — a way of thinking.
export const DESIGN_THINKING = `
HOW TO THINK ABOUT EVERY TASK:

Start from the user's job. What is someone hiring this product to do? "I need to send money abroad cheaply" — not "I need a currency conversion API." Every decision — what to build, how fast it responds, what happens on error — flows from the job.

The experience IS the product. A 200ms server response is not a "performance metric" — it's the difference between an app that feels alive and one that feels broken. A loading state is not "polish" — it's the user knowing the app heard them. An error message is not "error handling" — it's the app being honest. There is no line between backend and UX. The server, the API, the database query, the render — they're all one experience the user either trusts or doesn't.

Build the core, verify it works, learn, iterate. Don't plan 20 features and build them all. Build the ONE thing that matters most, run it, see if it actually works from a user's chair. What you learn from seeing it run will change what you build next. Each wave should make what exists better before adding what doesn't exist yet.

Consistency is what makes complex things feel simple. One design system, rigid rules, no exceptions. This is how Revolut ships a super-app with 30+ features that doesn't feel like chaos.
`;

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

// ── Budget + model aware prompt strategy ──

function plannerPrompt(objective: string, workerModel: string, budget?: number, concurrency?: number, flexNote?: string): string {
  const b = budget ?? 10;
  const tier = detectModelTier(workerModel);
  const capability = modelCapabilityBlock(workerModel);
  const concLine = concurrency
    ? `\n- ${concurrency} agents run in parallel — tasks that run concurrently must touch DIFFERENT files to avoid merge conflicts`
    : "";
  const flexLine = flexNote ? `\n\n${flexNote}` : "";

  if (tier === "haiku") {
    return `You are a task coordinator for a parallel agent system. Analyze this codebase and break the following objective into independent tasks.

Objective: ${objective}

AGENT CAPABILITY: ${capability}

Requirements:
- Target exactly ~${b} tasks
- Each task MUST be independent — no task depends on another
- Each task should target specific files/areas to avoid merge conflicts
- Be specific: mention exact file paths, function names, what to change
- Keep tasks focused: one concrete change per task — Haiku agents work best with clear, scoped instructions${concLine}${flexLine}

Respond with ONLY a JSON object (no markdown fences):
{
  "tasks": [
    { "prompt": "In src/foo.ts, refactor the bar() function to..." },
    { "prompt": "Add unit tests for the baz module in test/baz.test.ts..." }
  ]
}`;
  }

  const smallThreshold = tier === "opus" ? 5 : 15;
  const mediumThreshold = tier === "opus" ? 30 : 50;

  if (b <= smallThreshold) {
    return `You are a task coordinator for a parallel agent system. Analyze this codebase and break the following objective into independent tasks.

Objective: ${objective}

AGENT CAPABILITY: ${capability}

Requirements:
- Each task MUST be independent — no task depends on another
- Each task should target specific files/areas to avoid merge conflicts
- Be specific: mention exact file paths, function names, what to change
- Keep tasks focused: one logical change per task
- Target exactly ~${b} tasks${concLine}${flexLine}

Respond with ONLY a JSON object (no markdown fences):
{
  "tasks": [
    { "prompt": "In src/foo.ts, refactor the bar() function to..." },
    { "prompt": "Add unit tests for the baz module in test/baz.test.ts..." }
  ]
}`;
  }

  if (b <= mediumThreshold) {
    return `You are a task coordinator for a parallel agent system with ${b} agent sessions available.

Objective: ${objective}

AGENT CAPABILITY: ${capability}

Do NOT over-specify. Give each agent a MISSION, not step-by-step instructions. Let agents make their own decisions about implementation details.

Requirements:
- Target exactly ~${b} tasks
- Each task should be a substantial piece of work (5-30 minutes of agent time)
- Each task MUST be independent — no task depends on another
- Tasks that run concurrently must touch DIFFERENT files/areas to avoid merge conflicts
- Give agents scope and autonomy: "Design and implement X" not "In file Y, add function Z"
- Include research/exploration tasks, design tasks, implementation tasks, testing tasks, and polish tasks
- Think in terms of workstreams: architecture, features, tests, docs, UX, performance, etc.${concLine}${flexLine}

Respond with ONLY a JSON object (no markdown fences):
{
  "tasks": [
    { "prompt": "Design and implement the complete user favorites system: database schema, API routes, client hooks, and error handling. Research existing patterns in the codebase first." },
    { "prompt": "Audit all existing API routes for consistency, error handling, and input validation. Fix any issues found." }
  ]
}`;
  }

  return `You are a task coordinator for a parallel agent system with ${b} agent sessions available. This is a LARGE budget — equivalent to months of professional engineering work.

Objective: ${objective}

AGENT CAPABILITY: ${capability}

With ${b} sessions, you should think BIG:
- Full feature implementations spanning multiple files
- Deep refactoring of entire subsystems
- Comprehensive test suites for each module
- UX audits and polishing passes
- Performance optimization investigations
- Security audits and hardening
- Documentation and code quality passes
- Multiple iterations of the same area (implement, then separately review/improve)
- Edge case handling, error recovery, accessibility
- Integration testing across features

Requirements:
- Target exactly ~${b} tasks
- Each task should be substantial: 10-30 minutes of autonomous agent work
- Each task MUST be independent — no task depends on another
- Tasks that run concurrently must target DIFFERENT files/areas to avoid merge conflicts
- Give agents missions with full autonomy: "Own the entire X subsystem" not "edit line 42 of Y.ts"
- Cover ALL aspects: architecture, implementation, testing, UX, performance, security, polish
- It's OK to have multiple tasks for the same area if they target different concerns (e.g. one implements, another writes tests, another does a UX polish pass)
- Organize by workstreams: core features, supporting infrastructure, quality, polish
- Think about what a team of ${b} senior engineers could accomplish in parallel${concLine}${flexLine}

Respond with ONLY a JSON object (no markdown fences):
{
  "tasks": [
    { "prompt": "Own the complete implementation of [feature X]: research the codebase for patterns, design the architecture, implement the database layer, API routes, and client hooks. Make it production-ready." },
    { "prompt": "Comprehensive test suite for [module Y]: unit tests, integration tests, edge cases, error scenarios. Aim for high coverage and meaningful assertions." },
    { "prompt": "UX audit and polish pass on [area Z]: review all user-facing flows, improve error messages, loading states, empty states, and micro-interactions." }
  ]
}`;
}

// ── Planning functions ──

export async function planTasks(
  objective: string, cwd: string, plannerModel: string, workerModel: string,
  permissionMode: PermMode, budget: number | undefined, concurrency: number,
  onLog: (text: string) => void, flexNote?: string, outFile?: string,
): Promise<Task[]> {
  onLog("Analyzing codebase...");
  const prompt = plannerPrompt(objective, workerModel, budget, concurrency, flexNote);
  const fileInstruction = outFile ? `\n\nAFTER generating the JSON, also write it to ${outFile} using the Write tool.` : "";
  let resultText: string;
  try {
    resultText = await runPlannerQuery(
      prompt + fileInstruction,
      { cwd, model: plannerModel, permissionMode, outputFormat: TASKS_SCHEMA }, onLog,
    );
  } catch (err: any) {
    const salvaged = salvageFromFile(outFile, budget, onLog, err?.message ?? String(err));
    if (salvaged) return salvaged;
    throw err;
  }
  const parsed = await extractTaskJson(resultText, async () => {
    onLog("Retrying...");
    return runPlannerQuery(
      `Your previous response was not valid JSON. Respond with ONLY a JSON object {"tasks":[{"prompt":"..."}]}.\n\n${prompt}`,
      { cwd, model: plannerModel, permissionMode, outputFormat: TASKS_SCHEMA }, onLog,
    );
  }, onLog, outFile);
  let tasks: Task[] = (parsed.tasks || []).map((t: any, i: number) => ({
    id: String(i), prompt: typeof t === "string" ? t : t.prompt,
  }));
  tasks = postProcess(tasks, budget, onLog);
  if (tasks.length === 0) throw new Error("Planner generated 0 tasks");
  onLog(`${tasks.length} tasks`);
  return tasks;
}

export async function identifyThemes(
  objective: string, count: number, cwd: string, model: string, permissionMode: PermMode,
  onLog: (text: string) => void = () => {},
): Promise<string[]> {
  const resultText = await runPlannerQuery(
    `Split this objective into exactly ${count} independent research angles for architects exploring a codebase. Each angle should cover a distinct aspect.\n\nObjective: ${objective}\n\nReturn ONLY a JSON object: {"themes": ["angle description", ...]}`,
    { cwd, model, permissionMode, outputFormat: THEMES_SCHEMA }, onLog,
  );
  const parsed = attemptJsonParse(resultText);
  if (parsed?.themes && Array.isArray(parsed.themes)) return parsed.themes.slice(0, count);
  const fallback = ["architecture, patterns, and conventions", "data models, state, and persistence", "user-facing flows, components, and UX", "APIs, integrations, and services", "testing, quality, and error handling", "security, performance, and infrastructure", "build, deployment, and configuration", "documentation and developer experience"];
  return Array.from({ length: count }, (_, i) => fallback[i % fallback.length]);
}

export function buildThinkingTasks(
  objective: string, themes: string[], designDir: string, plannerModel: string, previousKnowledge?: string,
): Task[] {
  const prevBlock = previousKnowledge ? `\nKNOWLEDGE FROM PREVIOUS RUNS:\n${previousKnowledge}\n\nBuild on this — don't re-discover what's already known.\n` : "";
  return themes.map((theme, i) => ({
    id: `think-${i}`,
    prompt: `## Research: ${theme}

You are a senior architect exploring a codebase to design a solution.

OVERALL OBJECTIVE: ${objective}
${prevBlock}
YOUR FOCUS: ${theme}
${DESIGN_THINKING}
Explore the codebase thoroughly using Read, Glob, and Grep. Then write a design document to ${designDir}/focus-${i}.md with these sections:

## Findings
Key files, patterns, and architecture you discovered. Cite specific file paths and function names.

## The Job
What is someone hiring this product to do? Not the feature — the outcome. Frame everything below through this lens.

## Proposed Work Items
For each item:
- **What**: What to build or change
- **Where**: Specific file paths
- **Why**: How this serves the job — including how fast it needs to respond and what happens when it fails
- **Risk**: Conflicts or complications

## Key Files
Relevant files with one-line descriptions.

Be thorough — your findings drive the execution plan.`,
    model: plannerModel,
  }));
}

export async function orchestrate(
  objective: string, designDocs: string, cwd: string, plannerModel: string, workerModel: string,
  permissionMode: PermMode, budget: number, concurrency: number,
  onLog: (text: string) => void, flexNote?: string, outFile?: string,
): Promise<Task[]> {
  const capability = modelCapabilityBlock(workerModel);
  const flexLine = flexNote ? `\n\n${flexNote}` : "";
  const fileInstruction = outFile ? `\n\nAFTER generating the JSON, also write it to ${outFile} using the Write tool.` : "";

  const prompt = `You are a tech lead planning a sprint based on your team's codebase research.

Objective: ${objective}

Your architects explored the codebase and found:

${designDocs}

AGENT CAPABILITY: ${capability}
${DESIGN_THINKING}
Create exactly ~${budget} concrete execution tasks based on these findings.

Requirements:
- Each task is actionable by a single agent session
- Each task MUST be independent — no dependencies between tasks
- ${concurrency} agents run in parallel — tasks must touch DIFFERENT files
- Trust the research — don't tell agents to re-explore what's documented
- Reference specific files and patterns from the findings
- Build the core user job first, then expand. Each task should produce something complete and usable — not scaffolding for later
- There is no separate "polish" phase. Loading states, error handling, sub-200ms responses, and edge cases are part of every task${flexLine}

Respond with ONLY a JSON object (no markdown fences):
{"tasks": [{"prompt": "..."}]}${fileInstruction}`;

  onLog("Synthesizing...");
  let resultText: string;
  try {
    resultText = await runPlannerQuery(prompt, { cwd, model: plannerModel, permissionMode, outputFormat: TASKS_SCHEMA }, onLog);
  } catch (err: any) {
    const salvaged = salvageFromFile(outFile, budget, onLog, err?.message ?? String(err));
    if (salvaged) return salvaged;
    throw err;
  }
  const parsed = await extractTaskJson(resultText, async () => {
    onLog("Retrying...");
    return runPlannerQuery(
      `Your previous response was not valid JSON. Respond with ONLY a JSON object {"tasks":[{"prompt":"..."}]}.\n\n${prompt}`,
      { cwd, model: plannerModel, permissionMode, outputFormat: TASKS_SCHEMA }, onLog,
    );
  }, onLog, outFile);
  let tasks: Task[] = (parsed.tasks || []).map((t: any, i: number) => ({
    id: String(i), prompt: typeof t === "string" ? t : t.prompt,
  }));
  tasks = postProcess(tasks, budget, onLog);
  if (tasks.length === 0) throw new Error("Orchestration generated 0 tasks");
  onLog(`${tasks.length} tasks`);
  return tasks;
}

export async function refinePlan(
  objective: string, previousTasks: Task[], feedback: string, cwd: string,
  plannerModel: string, workerModel: string, permissionMode: PermMode,
  budget: number | undefined, concurrency: number, onLog: (text: string) => void,
): Promise<Task[]> {
  onLog("Refining plan...");
  const prev = previousTasks.map((t, i) => `${i + 1}. ${t.prompt}`).join("\n");
  const capability = modelCapabilityBlock(workerModel);
  const b = budget ?? 10;
  const scaleNote = b > 50 ? `This is a LARGE budget (${b} sessions). Think big — missions, not micro-tasks.`
    : b > 15 ? `Each of the ${b} sessions is a capable AI agent. Give substantial missions, not trivial edits.`
    : `Target ~${b} tasks.`;
  const prompt = `You are a task coordinator. You previously planned these tasks for the objective:

Objective: ${objective}

Previous plan:
${prev}

The user wants changes: ${feedback}

AGENT CAPABILITY: ${capability}

${scaleNote} ${concurrency} agents run in parallel. Update the plan accordingly. Keep tasks independent and targeting different files/areas.

Respond with ONLY a JSON object (no markdown):
{"tasks":[{"prompt":"..."}]}`;

  const resultText = await runPlannerQuery(prompt, { cwd, model: plannerModel, permissionMode, outputFormat: TASKS_SCHEMA }, onLog);
  const parsed = await extractTaskJson(resultText, async () => {
    onLog("Retrying...");
    return runPlannerQuery(
      `Your previous response was not valid JSON. Respond with ONLY a JSON object {"tasks":[{"prompt":"..."}]}.\n\n${prompt}`,
      { cwd, model: plannerModel, permissionMode, outputFormat: TASKS_SCHEMA }, onLog,
    );
  }, onLog);
  let tasks: Task[] = (parsed.tasks || []).map((t: any, i: number) => ({
    id: String(i), prompt: typeof t === "string" ? t : t.prompt,
  }));
  tasks = postProcess(tasks, budget, onLog);
  if (tasks.length === 0) throw new Error("Refinement produced 0 tasks");
  onLog(`${tasks.length} tasks`);
  return tasks;
}
