import { readFileSync } from "fs";
import { runPlannerQuery, extractTaskJson, attemptJsonParse, postProcess } from "./query.js";
import { contextConstraintNote } from "../core/models.js";
import { createTurn, beginTurn, endTurn } from "../core/turns.js";
// Resilience: if the planner query throws but the agent already wrote valid
// tasks to `outFile` (via its Write tool), salvage them instead of discarding
// expensive work. Returns salvaged tasks on success, null if nothing usable on
// disk  -- caller should then re-throw the original error.
export function salvageFromFile(outFile, budget, onLog, why) {
    if (!outFile)
        return null;
    try {
        const parsed = attemptJsonParse(readFileSync(outFile, "utf-8"));
        if (!parsed?.tasks?.length)
            return null;
        let tasks = parsed.tasks.map((t, i) => ({
            id: String(i), prompt: typeof t === "string" ? t : t.prompt, type: "execute",
        }));
        tasks = postProcess(tasks, budget, onLog);
        if (tasks.length === 0)
            return null;
        onLog(`Planner errored (${why})  -- salvaged ${tasks.length} tasks from ${outFile}`, "event");
        return tasks;
    }
    catch {
        return null;
    }
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
// The core framing for all planning. Not a checklist  -- a way of thinking.
export const DESIGN_THINKING = `
HOW TO THINK ABOUT EVERY TASK:

Start from the user's job. What is someone hiring this product to do? "I need to send money abroad cheaply"  -- not "I need a currency conversion API." Every decision  -- what to build, how fast it needs to respond, what happens on error  -- flows from the job.

The experience IS the product. A 200ms server response is not a "performance metric"  -- it's the difference between an app that feels alive and one that feels broken. A loading state is not "polish"  -- it's the user knowing the app heard them. An error message is not "error handling"  -- it's the app being honest. There is no line between backend and UX. The server, the API, the database query, the render  -- they're all one experience the user either trusts or doesn't.

Build the core, verify it works, learn, iterate. Don't plan 20 features and build them all. Build the ONE thing that matters most, run it, see if it actually works from a user's chair. What you learn from seeing it run will change what you build next. Each wave should make what exists better before adding what doesn't exist yet.

Consistency is what makes complex things feel simple. One design system, rigid rules, no exceptions. This is how Revolut ships a super-app with 30+ features that doesn't feel like chaos.
`;
// ── JSON schemas for structured output ──
const TASKS_SCHEMA = {
    type: "json_schema",
    schema: {
        type: "object",
        properties: { tasks: { type: "array", items: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] } } },
        required: ["tasks"],
    },
};
const THEMES_SCHEMA = {
    type: "json_schema",
    schema: {
        type: "object",
        properties: { themes: { type: "array", items: { type: "string" } } },
        required: ["themes"],
    },
};
// ── Budget breakpoints for prompt strategy ──
const BUDGET_FOCUSED = 10; // ≤ this → surgical, file-specific tasks
const BUDGET_SUBSTANTIAL = 30; // ≤ this → mission-level, autonomous agents
// ── Context-aware prompt strategy ──
function plannerPrompt(objective, workerModel, budget, concurrency, flexNote) {
    const b = budget ?? BUDGET_FOCUSED;
    const constraint = contextConstraintNote(workerModel);
    const concLine = concurrency
        ? `\n- ${concurrency} agents run in parallel  -- tasks that run concurrently must touch DIFFERENT files to avoid merge conflicts`
        : "";
    const flexLine = flexNote ? `\n\n${flexNote}` : "";
    if (b <= BUDGET_FOCUSED) {
        return `You are a task coordinator for a parallel agent system. Analyze this codebase and break the following objective into independent tasks.

Objective: ${objective}

${constraint}

Requirements:
- Target exactly ~${b} tasks
- Each task MUST be independent  -- no task depends on another
- Each task should target specific files/areas to avoid merge conflicts
- Be specific: mention exact file paths, function names, what to change
- Keep tasks focused: one concrete change per task${concLine}${flexLine}

Respond with ONLY a JSON object (no markdown fences):
{
  "tasks": [
    { "prompt": "In src/foo.ts, refactor the bar() function to..." },
    { "prompt": "Add unit tests for the baz module in test/baz.test.ts..." }
  ]
}`;
    }
    if (b <= BUDGET_SUBSTANTIAL) {
        return `You are a task coordinator for a parallel agent system with ${b} agent sessions available.

Objective: ${objective}

${constraint}

Do NOT over-specify. Give each agent a MISSION, not step-by-step instructions. Let agents make their own decisions about implementation details.

Requirements:
- Target exactly ~${b} tasks
- Each task should be a substantial piece of work
- Each task MUST be independent  -- no task depends on another
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
    return `You are a task coordinator for a parallel agent system with ${b} agent sessions available. This is a LARGE budget  -- equivalent to months of professional engineering work.

Objective: ${objective}

${constraint}

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
- Each task should be substantial: significant autonomous agent work
- Each task MUST be independent  -- no task depends on another
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
export async function planTasks(objective, cwd, plannerModel, workerModel, budget, concurrency, onLog, flexNote, outFile, transcriptName = "plan") {
    onLog("Analyzing codebase...");
    const turn = createTurn("plan", "Plan", "plan-0", plannerModel);
    beginTurn(turn);
    const prompt = plannerPrompt(objective, workerModel, budget, concurrency, flexNote);
    const fileInstruction = outFile ? `\n\nAFTER generating the JSON, also write it to ${outFile} using the Write tool.` : "";
    let resultText;
    try {
        resultText = await runPlannerQuery(prompt + fileInstruction, { cwd, model: plannerModel, outputFormat: TASKS_SCHEMA, transcriptName, maxTurns: 40,
            tools: ["Read", "Glob", "Grep", "Write"], turnId: turn.id }, onLog);
    }
    catch (err) {
        const salvaged = salvageFromFile(outFile, budget, onLog, err?.message ?? String(err));
        endTurn(turn, salvaged ? "done" : "error");
        if (salvaged)
            return salvaged;
        throw err;
    }
    let tasks;
    try {
        const parsed = await extractTaskJson(resultText, async () => {
            onLog("Retrying...");
            return runPlannerQuery(`Your previous response was not valid JSON. Respond with ONLY a JSON object {"tasks":[{"prompt":"..."}]}.\n\n${prompt}`, { cwd, model: plannerModel, outputFormat: TASKS_SCHEMA, transcriptName: `${transcriptName}-retry`, maxTurns: 15, turnId: turn.id }, onLog);
        }, onLog, outFile);
        tasks = (parsed.tasks || []).map((t, i) => ({
            id: String(i), prompt: typeof t === "string" ? t : t.prompt, type: "execute",
        }));
        tasks = postProcess(tasks, budget, onLog);
    }
    catch {
        endTurn(turn, "error");
        throw new Error("Planner generated 0 tasks");
    }
    endTurn(turn, tasks.length === 0 ? "error" : "done");
    if (tasks.length === 0)
        throw new Error("Planner generated 0 tasks");
    onLog(`${tasks.length} tasks`);
    return tasks;
}
export async function identifyThemes(objective, count, cwd, model, onLog = () => { }, transcriptName = "themes") {
    const turn = createTurn("identify-themes", `Themes (${count})`, "themes-0", model);
    beginTurn(turn);
    try {
        const resultText = await runPlannerQuery(`You are picking ${count} research angles for architects who will deeply explore a codebase next.

You are NOT solving the objective. You are NOT reproducing bugs, running builds, running tests, or executing anything. You only have read-only recon tools (Read, Glob, Grep). Do a quick scan (3-6 tool calls): read any manifest/README, glob the top-level tree, peek at one or two config files that reveal the stack. Stop as soon as you can name the pieces.

Then pick ${count} angles that carve up THIS specific codebase orthogonally. Prefer concrete subsystems you saw (e.g. "authentication + session handling", "time-tracking mutation paths") over generic buckets ("data layer", "UX").

The objective below is for CONTEXT ONLY -- do not act on it, do not verify it, do not reproduce it:

<objective>
${objective}
</objective>

Return ONLY a JSON object: {"themes": ["angle description", ...]}`, { cwd, model, outputFormat: THEMES_SCHEMA, transcriptName, maxTurns: 12, turnId: turn.id, tools: THEMES_RECON_TOOLS }, onLog);
        const parsed = attemptJsonParse(resultText);
        endTurn(turn, "done");
        if (parsed?.themes && Array.isArray(parsed.themes))
            return parsed.themes.slice(0, count);
        throw new Error("themes picker returned no themes");
    }
    catch (err) {
        endTurn(turn, "error");
        throw err;
    }
}
export function buildThinkingTasks(objective, themes, designDir, plannerModel, previousKnowledge) {
    const prevBlock = previousKnowledge ? `\nKNOWLEDGE FROM PREVIOUS RUNS:\n${previousKnowledge}\n\nBuild on this  -- don't re-discover what's already known.\n` : "";
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
What is someone hiring this product to do? Not the feature  -- the outcome. Frame everything below through this lens.

## Proposed Work Items
For each item:
- **What**: What to build or change
- **Where**: Specific file paths
- **Why**: How this serves the job  -- including how fast it needs to respond and what happens when it fails
- **Risk**: Conflicts or complications

## Key Files
Relevant files with one-line descriptions.

Be thorough  -- your findings drive the execution plan.`,
        model: plannerModel,
    }));
}
export async function orchestrate(objective, designDocs, cwd, plannerModel, workerModel, budget, concurrency, onLog, flexNote, outFile, transcriptName = "orchestrate") {
    const constraint = contextConstraintNote(workerModel);
    const flexLine = flexNote ? `\n\n${flexNote}` : "";
    const fileInstruction = outFile ? `\n\nAFTER generating the JSON, also write it to ${outFile} using the Write tool.` : "";
    const prompt = `You are a tech lead planning a sprint based on your team's codebase research.

Objective: ${objective}

Your architects explored the codebase and found:

${designDocs}

${constraint}
${DESIGN_THINKING}
Create exactly ~${budget} concrete execution tasks based on these findings.

Requirements:
- Each task is actionable by a single agent session
- Each task MUST be independent  -- no dependencies between tasks
- ${concurrency} agents run in parallel  -- tasks must touch DIFFERENT files
- Trust the research  -- don't tell agents to re-explore what's documented
- Reference specific files and patterns from the findings
- Build the core user job first, then expand. Each task should produce something complete and usable  -- not scaffolding for later
- There is no separate "polish" phase. Loading states, error handling, sub-200ms responses, and edge cases are part of every task${flexLine}

Respond with ONLY a JSON object (no markdown fences):
{"tasks": [{"prompt": "..."}]}${fileInstruction}`;
    onLog("Synthesizing...");
    const turn = createTurn("orchestrate", "Orchestrate", "orchestrate-0", plannerModel);
    beginTurn(turn);
    let resultText;
    try {
        resultText = await runPlannerQuery(prompt, { cwd, model: plannerModel, outputFormat: TASKS_SCHEMA, transcriptName, maxTurns: 25,
            tools: ["Write"], turnId: turn.id }, onLog);
    }
    catch (err) {
        const salvaged = salvageFromFile(outFile, budget, onLog, err?.message ?? String(err));
        endTurn(turn, salvaged ? "done" : "error");
        if (salvaged)
            return salvaged;
        throw err;
    }
    let tasks;
    try {
        const parsed = await extractTaskJson(resultText, async () => {
            onLog("Retrying...");
            return runPlannerQuery(`Your previous response was not valid JSON. Respond with ONLY a JSON object {"tasks":[{"prompt":"..."}]}.\n\n${prompt}`, { cwd, model: plannerModel, outputFormat: TASKS_SCHEMA, transcriptName: `${transcriptName}-retry`, maxTurns: 10, turnId: turn.id }, onLog);
        }, onLog, outFile);
        tasks = (parsed.tasks || []).map((t, i) => ({
            id: String(i), prompt: typeof t === "string" ? t : t.prompt, type: "execute",
        }));
        tasks = postProcess(tasks, budget, onLog);
    }
    catch {
        endTurn(turn, "error");
        throw new Error("Orchestration generated 0 tasks");
    }
    endTurn(turn, tasks.length === 0 ? "error" : "done");
    if (tasks.length === 0)
        throw new Error("Orchestration generated 0 tasks");
    onLog(`${tasks.length} tasks`);
    return tasks;
}
export async function refinePlan(objective, previousTasks, feedback, cwd, plannerModel, workerModel, budget, concurrency, onLog, transcriptName = "refine") {
    onLog("Refining plan...");
    const turn = createTurn("plan-refine", "Refine plan", "refine-0", plannerModel);
    beginTurn(turn);
    const prev = previousTasks.map((t, i) => `${i + 1}. ${t.prompt}`).join("\n");
    const constraint = contextConstraintNote(workerModel);
    const b = budget ?? 10;
    const scaleNote = b > 50 ? `This is a LARGE budget (${b} sessions). Think big  -- missions, not micro-tasks.`
        : b > 15 ? `Each of the ${b} sessions is a capable AI agent. Give substantial missions, not trivial edits.`
            : `Target ~${b} tasks.`;
    const prompt = `You are a task coordinator. You previously planned these tasks for the objective:

Objective: ${objective}

Previous plan:
${prev}

The user wants changes: ${feedback}

${constraint}

${scaleNote} ${concurrency} agents run in parallel. Update the plan accordingly. Keep tasks independent and targeting different files/areas.

Respond with ONLY a JSON object (no markdown):
{"tasks":[{"prompt":"..."}]}`;
    let resultText;
    try {
        resultText = await runPlannerQuery(prompt, { cwd, model: plannerModel, outputFormat: TASKS_SCHEMA, transcriptName, maxTurns: 15, turnId: turn.id }, onLog);
    }
    catch (err) {
        endTurn(turn, "error");
        throw err;
    }
    let tasks;
    try {
        const parsed = await extractTaskJson(resultText, async () => {
            onLog("Retrying...");
            return runPlannerQuery(`Your previous response was not valid JSON. Respond with ONLY a JSON object {"tasks":[{"prompt":"..."}]}.\n\n${prompt}`, { cwd, model: plannerModel, outputFormat: TASKS_SCHEMA, transcriptName: `${transcriptName}-retry`, maxTurns: 8, turnId: turn.id }, onLog);
        }, onLog);
        tasks = (parsed.tasks || []).map((t, i) => ({
            id: String(i), prompt: typeof t === "string" ? t : t.prompt, type: "execute",
        }));
        tasks = postProcess(tasks, budget, onLog);
    }
    catch {
        endTurn(turn, "error");
        throw new Error("Refinement produced 0 tasks");
    }
    endTurn(turn, tasks.length === 0 ? "error" : "done");
    if (tasks.length === 0)
        throw new Error("Refinement produced 0 tasks");
    onLog(`${tasks.length} tasks`);
    return tasks;
}
