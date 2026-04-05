import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Task, PermMode } from "./types.js";

// ── Steering types ──

export interface WaveSummary {
  wave: number;
  kind: "execute" | "reflect" | "think";
  tasks: { prompt: string; status: string; filesChanged?: number; error?: string }[];
}

export interface SteerResult {
  done: boolean;
  action: "execute" | "reflect" | "done";
  tasks: Task[];
  reasoning: string;
  goalUpdate?: string;
}

export interface RunMemory {
  designs: string;
  reflections: string;
  goal: string;
}

const INACTIVITY_MS = 5 * 60 * 1000;

interface PlannerOpts {
  cwd: string;
  model: string;
  permissionMode: PermMode;
}

// ── Model tier detection ──

export type ModelTier = "opus" | "sonnet" | "haiku" | "unknown";

export function detectModelTier(model: string): ModelTier {
  const m = model.toLowerCase();
  if (m === "default" || m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  return "unknown";
}

function modelCapabilityBlock(model: string): string {
  switch (detectModelTier(model)) {
    case "opus":
      return `Each agent runs Claude Opus with 1M context — a powerhouse. It can own entire epics, do deep codebase research, make architectural decisions, implement complex multi-file systems end-to-end, use browser tools for analysis, and deliver expert-level work. These agents can work for 30+ minutes on the most complex tasks. Do NOT waste them on trivial edits — give them ownership and autonomy.`;
    case "sonnet":
      return `Each agent runs Claude Sonnet — capable of substantial implementation, refactoring, testing, and design work. Can work autonomously for 10-20 minutes on complex tasks. Give agents meaningful scope — not just single-line edits.`;
    case "haiku":
      return `Each agent runs Claude Haiku — fast and efficient, best for focused, well-specified tasks. Be explicit about files, functions, and expected changes. Keep each task scoped to a clear, concrete deliverable.`;
    default:
      return `Each agent has full codebase access and can work autonomously.`;
  }
}

// ── Budget + model aware prompt strategy ──

function plannerPrompt(objective: string, workerModel: string, budget?: number, concurrency?: number, flexNote?: string): string {
  const b = budget ?? 10;
  const tier = detectModelTier(workerModel);
  const capability = modelCapabilityBlock(workerModel);
  const concLine = concurrency
    ? `\n- ${concurrency} agents run in parallel — tasks that run concurrently must touch DIFFERENT files to avoid merge conflicts`
    : "";
  const flexLine = flexNote ? `\n\n${flexNote}` : "";

  // Haiku always gets specific guided tasks regardless of budget
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

  // Opus gets ambitious missions even at moderate budgets
  const smallThreshold = tier === "opus" ? 5 : 15;
  const mediumThreshold = tier === "opus" ? 30 : 50;

  // Small budget: specific tasks
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

  // Medium budget: substantial missions with autonomy
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

  // Large budget: ambitious multi-workstream decomposition
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

const RATE_LIMIT_PATTERNS = ["rate", "limit", "overloaded", "429", "hit your limit", "too many"];

function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return RATE_LIMIT_PATTERNS.some((p) => msg.toLowerCase().includes(p));
}

async function runPlannerQuery(
  prompt: string,
  opts: PlannerOpts,
  onLog: (text: string) => void,
): Promise<string> {
  const MAX_RETRIES = 3;
  const BACKOFF = [30_000, 60_000, 120_000];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await runPlannerQueryOnce(prompt, opts, onLog);
    } catch (err: any) {
      if (attempt < MAX_RETRIES && isRateLimitError(err)) {
        const waitMs = BACKOFF[attempt];
        const waitSec = Math.round(waitMs / 1000);
        onLog(`Rate limited — waiting ${waitSec}s before retry ${attempt + 1}/${MAX_RETRIES}`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Planner query failed after retries");
}

async function runPlannerQueryOnce(
  prompt: string,
  opts: PlannerOpts,
  onLog: (text: string) => void,
): Promise<string> {
  let resultText = "";
  const startedAt = Date.now();
  const pq = query({
    prompt,
    options: {
      cwd: opts.cwd,
      model: opts.model,
      tools: ["Read", "Glob", "Grep"],
      allowedTools: ["Read", "Glob", "Grep"],
      permissionMode: opts.permissionMode,
      ...(opts.permissionMode === "bypassPermissions" && { allowDangerouslySkipPermissions: true }),
      persistSession: false,
      includePartialMessages: true,
    },
  });

  // Progress ticker — fast updates with compact format
  let lastLogText = "";
  let toolCount = 0;
  const ticker = setInterval(() => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    const timeStr = m > 0 ? `${m}m ${s}s` : `${s}s`;
    const toolStr = toolCount > 0 ? ` · ${toolCount} tools` : "";
    const extra = lastLogText ? ` · ${lastLogText}` : "";
    onLog(`${timeStr}${toolStr}${extra}`);
  }, 500);

  let lastActivity = Date.now();
  let timer: NodeJS.Timeout;
  const watchdog = new Promise<never>((_, reject) => {
    const check = () => {
      const silent = Date.now() - lastActivity;
      if (silent >= INACTIVITY_MS) { pq.close(); reject(new Error(`Planner silent for ${Math.round(silent / 1000)}s — assumed hung`)); }
      else timer = setTimeout(check, Math.min(30_000, INACTIVITY_MS - silent + 1000));
    };
    timer = setTimeout(check, INACTIVITY_MS);
  });

  const consume = async () => {
    for await (const msg of pq) {
      lastActivity = Date.now();
      if (msg.type === "stream_event") {
        const ev = (msg as any).event;
        if (ev?.type === "content_block_start" && ev.content_block?.type === "tool_use") {
          toolCount++;
          lastLogText = ev.content_block.name;
          onLog(ev.content_block.name);
        }
        // Stream text snippets so the user sees the planner is thinking
        if (ev?.type === "content_block_delta") {
          const delta = (ev as any).delta;
          if (delta?.type === "text_delta" && delta.text) {
            const snippet = delta.text.trim().replace(/[{}"\\,[\]]+/g, " ").replace(/\s+/g, " ").trim();
            if (snippet.length > 5) {
              lastLogText = snippet.slice(0, 60);
            }
          }
        }
      }
      if (msg.type === "result") {
        if (msg.subtype === "success") resultText = (msg as any).result || "";
        else throw new Error(`Planner failed: ${(msg as any).result || msg.subtype}`);
      }
    }
  };

  try { await Promise.race([consume(), watchdog]); }
  finally { clearTimeout(timer!); clearInterval(ticker); }

  return resultText;
}

function postProcess(raw: Task[], budget: number | undefined, onLog: (text: string) => void): Task[] {
  let tasks = raw;

  // Filter garbage (< 3 words)
  const before = tasks.length;
  tasks = tasks.filter((t) => t.prompt && t.prompt.trim().split(/\s+/).length >= 3);
  if (tasks.length < before) onLog(`Filtered ${before - tasks.length} task(s) with fewer than 3 words`);

  // Dedup >80% word overlap
  const dominated = new Set<number>();
  for (let i = 0; i < tasks.length; i++) {
    if (dominated.has(i)) continue;
    const setA = new Set(tasks[i].prompt.toLowerCase().split(/\s+/));
    for (let j = i + 1; j < tasks.length; j++) {
      if (dominated.has(j)) continue;
      const setB = new Set(tasks[j].prompt.toLowerCase().split(/\s+/));
      const shared = [...setA].filter((w) => setB.has(w)).length;
      const overlap = shared / Math.max(setA.size, setB.size);
      if (overlap > 0.8) {
        const drop = setA.size >= setB.size ? j : i;
        dominated.add(drop);
        if (drop === i) break;
      }
    }
  }
  if (dominated.size) {
    tasks = tasks.filter((_, i) => !dominated.has(i));
    onLog(`Deduplicated to ${tasks.length} tasks`);
  }

  // Warn on file overlap (only for small budgets where tasks are file-specific)
  if ((budget ?? 10) <= 15) {
    const fileRe = /(?:^|\s)((?:[\w.-]+\/)+[\w.-]+\.\w+)/g;
    const pathToTasks = new Map<string, string[]>();
    for (const t of tasks) {
      for (const m of t.prompt.matchAll(fileRe)) {
        const ids = pathToTasks.get(m[1]);
        if (ids) ids.push(t.id); else pathToTasks.set(m[1], [t.id]);
      }
    }
    for (const [path, ids] of pathToTasks) {
      if (ids.length > 1) onLog(`Overlap risk: ${path} in tasks ${ids.join(", ")}`);
    }
  }

  // Cap at budget (with generous headroom) — no arbitrary 30 limit
  const cap = budget ? Math.ceil(budget * 1.2) : 30;
  if (tasks.length > cap) { onLog(`Truncating ${tasks.length} → ${cap}`); tasks = tasks.slice(0, cap); }
  tasks.sort((a, b) => Number(/\btest/i.test(a.prompt)) - Number(/\btest/i.test(b.prompt)));

  // Re-index
  tasks = tasks.map((t, i) => ({ ...t, id: String(i) }));

  return tasks;
}

export async function planTasks(
  objective: string,
  cwd: string,
  plannerModel: string,
  workerModel: string,
  permissionMode: PermMode,
  budget: number | undefined,
  concurrency: number,
  onLog: (text: string) => void,
  flexNote?: string,
): Promise<Task[]> {
  onLog("Analyzing codebase...");

  const resultText = await runPlannerQuery(
    plannerPrompt(objective, workerModel, budget, concurrency, flexNote),
    { cwd, model: plannerModel, permissionMode },
    onLog,
  );

  const parsed = await extractTaskJson(resultText, async () => {
    onLog("Retrying for valid JSON...");
    let retryText = "";
    for await (const msg of query({
      prompt: `Your previous response did not contain valid JSON. Output ONLY a JSON object:\n{"tasks":[{"prompt":"..."}]}`,
      options: { cwd, model: plannerModel, permissionMode, ...(permissionMode === "bypassPermissions" && { allowDangerouslySkipPermissions: true }), persistSession: false },
    })) {
      if (msg.type === "result" && msg.subtype === "success") retryText = (msg as any).result || "";
    }
    return retryText;
  });

  let tasks: Task[] = (parsed.tasks || []).map((t: any, i: number) => ({
    id: String(i),
    prompt: typeof t === "string" ? t : t.prompt,
  }));

  tasks = postProcess(tasks, budget, onLog);
  if (tasks.length === 0) throw new Error("Planner generated 0 tasks");

  onLog(`${tasks.length} tasks`);
  return tasks;
}

// ── Thinking wave ──

export async function identifyThemes(
  objective: string,
  count: number,
  model: string,
  permissionMode: PermMode,
): Promise<string[]> {
  let resultText = "";
  for await (const msg of query({
    prompt: `Split this objective into exactly ${count} independent research angles for architects exploring a codebase. Each angle should cover a distinct aspect.

Objective: ${objective}

Return ONLY a JSON object: {"themes": ["angle description", ...]}`,
    options: {
      model,
      permissionMode,
      ...(permissionMode === "bypassPermissions" && { allowDangerouslySkipPermissions: true }),
      persistSession: false,
    },
  })) {
    if (msg.type === "result" && msg.subtype === "success") resultText = (msg as any).result || "";
  }

  const parsed = attemptJsonParse(resultText);
  if (parsed?.themes && Array.isArray(parsed.themes)) return parsed.themes.slice(0, count);

  const fallback = ["architecture, patterns, and conventions", "data models, state, and persistence", "user-facing flows, components, and UX", "APIs, integrations, and services", "testing, quality, and error handling", "security, performance, and infrastructure", "build, deployment, and configuration", "documentation and developer experience"];
  return Array.from({ length: count }, (_, i) => fallback[i % fallback.length]);
}

export function buildThinkingTasks(
  objective: string,
  themes: string[],
  designDir: string,
  plannerModel: string,
): Task[] {
  return themes.map((theme, i) => ({
    id: `think-${i}`,
    prompt: `You are a senior architect exploring a codebase to design a solution.

OVERALL OBJECTIVE: ${objective}

YOUR FOCUS: ${theme}

Explore the codebase thoroughly using Read, Glob, and Grep. Then write a design document to ${designDir}/focus-${i}.md with these sections:

## Findings
Key files, patterns, and architecture you discovered. Cite specific file paths and function names.

## Proposed Work Items
For each item:
- **What**: What to build or change
- **Where**: Specific file paths
- **Why**: Why this matters
- **Risk**: Conflicts or complications

## Key Files
Relevant files with one-line descriptions.

Be thorough — your findings drive the execution plan.`,
    model: plannerModel,
  }));
}

export function buildReflectionTasks(
  objective: string,
  goal: string,
  reflectionDir: string,
  waveNum: number,
  plannerModel: string,
): Task[] {
  const goalBlock = goal ? `\nEVOLVED GOAL:\n${goal}\n` : "";
  return [
    {
      id: "review-0",
      prompt: `You are a senior code reviewer performing a deep quality audit.

OBJECTIVE: ${objective}
${goalBlock}
Read the codebase thoroughly. Assess:
- **Correctness**: Bugs, missing error handling, broken flows?
- **Architecture**: Clean design? Unnecessary or missing abstractions?
- **Code quality**: Readability, naming, duplication, dead code?
- **Completeness**: What's missing vs. the objective? Half-done work?
- **Polish**: Edge cases, error messages, loading states?

Write findings to ${reflectionDir}/wave-${waveNum}-quality.md.
End with a ## Verdict: is this closer to "good enough" or "amazing"? What would make the biggest difference?`,
      model: plannerModel,
    },
    {
      id: "review-1",
      prompt: `You are a UX and integration reviewer.

OBJECTIVE: ${objective}
${goalBlock}
Read the codebase. Assess:
- **UX coherence**: Do user-facing flows make sense end-to-end? Consistent experience?
- **Integration**: Do pieces fit together? Seams, inconsistencies, broken contracts?
- **Testing**: Meaningful coverage? Testing the right things?
- **Gaps**: Unhandled use cases? What would surprise a user?

Write findings to ${reflectionDir}/wave-${waveNum}-ux.md.
End with ## Priorities: rank the top 3 things that would most improve the result.`,
      model: plannerModel,
    },
  ];
}

export async function orchestrate(
  objective: string,
  designDocs: string,
  cwd: string,
  plannerModel: string,
  workerModel: string,
  permissionMode: PermMode,
  budget: number,
  concurrency: number,
  onLog: (text: string) => void,
  flexNote?: string,
): Promise<Task[]> {
  const capability = modelCapabilityBlock(workerModel);
  const flexLine = flexNote ? `\n\n${flexNote}` : "";

  const prompt = `You are a tech lead planning a sprint based on your team's codebase research.

Objective: ${objective}

Your architects explored the codebase and found:

${designDocs}

AGENT CAPABILITY: ${capability}

Create exactly ~${budget} concrete execution tasks based on these findings.

Requirements:
- Each task is actionable by a single agent session
- Each task MUST be independent — no dependencies between tasks
- ${concurrency} agents run in parallel — tasks must touch DIFFERENT files
- Trust the research — don't tell agents to re-explore what's documented
- Reference specific files and patterns from the findings
- Priority order: foundational first, polish last${flexLine}

Respond with ONLY a JSON object (no markdown fences):
{"tasks": [{"prompt": "..."}]}`;

  onLog("Synthesizing...");
  const resultText = await runPlannerQuery(prompt, { cwd, model: plannerModel, permissionMode }, onLog);

  const parsed = await extractTaskJson(resultText, async () => {
    onLog("Retrying...");
    let retryText = "";
    for await (const msg of query({
      prompt: `Output ONLY a JSON object:\n{"tasks":[{"prompt":"..."}]}`,
      options: { cwd, model: plannerModel, permissionMode, ...(permissionMode === "bypassPermissions" && { allowDangerouslySkipPermissions: true }), persistSession: false },
    })) {
      if (msg.type === "result" && msg.subtype === "success") retryText = (msg as any).result || "";
    }
    return retryText;
  });

  let tasks: Task[] = (parsed.tasks || []).map((t: any, i: number) => ({
    id: String(i),
    prompt: typeof t === "string" ? t : t.prompt,
  }));

  tasks = postProcess(tasks, budget, onLog);
  if (tasks.length === 0) throw new Error("Orchestration generated 0 tasks");
  onLog(`${tasks.length} tasks`);
  return tasks;
}

export async function refinePlan(
  objective: string,
  previousTasks: Task[],
  feedback: string,
  cwd: string,
  plannerModel: string,
  workerModel: string,
  permissionMode: PermMode,
  budget: number | undefined,
  concurrency: number,
  onLog: (text: string) => void,
): Promise<Task[]> {
  onLog("Refining plan...");

  const prev = previousTasks.map((t, i) => `${i + 1}. ${t.prompt}`).join("\n");
  const capability = modelCapabilityBlock(workerModel);
  const b = budget ?? 10;
  const scaleNote = b > 50
    ? `This is a LARGE budget (${b} sessions). Think big — missions, not micro-tasks.`
    : b > 15
      ? `Each of the ${b} sessions is a capable AI agent. Give substantial missions, not trivial edits.`
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

  const resultText = await runPlannerQuery(prompt, { cwd, model: plannerModel, permissionMode }, onLog);

  const parsed = await extractTaskJson(resultText, async () => {
    onLog("Retrying...");
    let retryText = "";
    for await (const msg of query({
      prompt: `Output ONLY a JSON object:\n{"tasks":[{"prompt":"..."}]}`,
      options: { cwd, model: plannerModel, permissionMode, ...(permissionMode === "bypassPermissions" && { allowDangerouslySkipPermissions: true }), persistSession: false },
    })) {
      if (msg.type === "result" && msg.subtype === "success") retryText = (msg as any).result || "";
    }
    return retryText;
  });

  let tasks: Task[] = (parsed.tasks || []).map((t: any, i: number) => ({
    id: String(i),
    prompt: typeof t === "string" ? t : t.prompt,
  }));

  tasks = postProcess(tasks, budget, onLog);
  if (tasks.length === 0) throw new Error("Refinement produced 0 tasks");

  onLog(`${tasks.length} tasks`);
  return tasks;
}

/** Find the outermost balanced { } substring. */
function extractOutermostBraces(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") depth--;
    if (depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/** Try multiple strategies to parse JSON from LLM output. */
function attemptJsonParse(text: string): any | null {
  try { const obj = JSON.parse(text); if (typeof obj === "object" && obj !== null) return obj; } catch {}
  const braces = extractOutermostBraces(text);
  if (braces) { try { const obj = JSON.parse(braces); if (typeof obj === "object" && obj !== null) return obj; } catch {} }
  const stripped = text.replace(/```json?\s*/g, "").replace(/```/g, "").trim();
  if (stripped !== text) {
    try { const obj = JSON.parse(stripped); if (typeof obj === "object" && obj !== null) return obj; } catch {}
    const b2 = extractOutermostBraces(stripped);
    if (b2) { try { return JSON.parse(b2); } catch {} }
  }
  return null;
}

/** Extract task JSON with validation and one retry. */
async function extractTaskJson(
  raw: string,
  retry: () => Promise<string>,
): Promise<{ tasks: any[] }> {
  const first = attemptJsonParse(raw);
  if (first?.tasks) return first;
  const retryText = await retry();
  const second = attemptJsonParse(retryText);
  if (second?.tasks) return second;
  throw new Error("Planner did not return valid task JSON after retry");
}

// ── Wave steering ──

export async function steerWave(
  objective: string,
  history: WaveSummary[],
  remainingBudget: number,
  cwd: string,
  plannerModel: string,
  workerModel: string,
  permissionMode: PermMode,
  concurrency: number,
  onLog: (text: string) => void,
  runMemory?: RunMemory,
): Promise<SteerResult> {
  const capability = modelCapabilityBlock(workerModel);

  // Keep context bounded — show recent history, truncate large blocks
  const recentHistory = history.length > 8 ? history.slice(-8) : history;
  const skipped = history.length - recentHistory.length;
  const historyText = (skipped > 0 ? `(${skipped} earlier waves omitted)\n\n` : "") + recentHistory.map(w => {
    const tag = w.kind === "reflect" ? " (reflection)" : w.kind === "think" ? " (thinking)" : "";
    const lines = w.tasks.map(t => {
      const files = t.filesChanged ? ` (${t.filesChanged} files)` : "";
      const err = t.error ? ` — ${t.error}` : "";
      return `  - [${t.status}] ${t.prompt.slice(0, 120)}${files}${err}`;
    }).join("\n");
    return `Wave ${w.wave + 1}${tag}:\n${lines}`;
  }).join("\n\n");

  const lastWasReflection = history.length > 0 && history[history.length - 1].kind === "reflect";
  const noReflectHint = lastWasReflection ? `\nIMPORTANT: The previous wave was a reflection. You MUST choose "execute" or "done" — not "reflect" again.\n` : "";

  const truncate = (s: string, max: number) => s.length > max ? s.slice(0, max) + "\n\n(truncated)" : s;
  const designBlock = runMemory?.designs ? `\nArchitectural research:\n${truncate(runMemory.designs, 6000)}\n` : "";
  const reflectionBlock = runMemory?.reflections ? `\nPrevious quality reports:\n${truncate(runMemory.reflections, 4000)}\n` : "";
  const goalBlock = runMemory?.goal ? `\nEvolving understanding of the goal:\n${runMemory.goal}\n` : "";

  const prompt = `You are the quality director for an autonomous multi-wave agent system. Your job is to push the work toward "amazing," not just "done."

Objective: ${objective}
${goalBlock}
Work completed so far:
${historyText}
${designBlock}${reflectionBlock}
Remaining budget: ${remainingBudget} agent sessions. ${concurrency} agents run in parallel — tasks must touch DIFFERENT files.
${capability}

Read the codebase. Assess: how close is this to the VISION? Not "what's missing" — "how good is what we built?"

Then choose ONE action:

**"reflect"** — Spin up 1-2 review agents for a deep quality audit. Choose when:
  - Substantial new code shipped and hasn't been reviewed
  - You're unsure about quality and need expert eyes
  - A subsystem just "completed" and deserves verification

**"execute"** — Plan the next batch of tasks. Choose when:
  - You know what needs doing (from reviews or your own assessment)
  - There are clear gaps, bugs, or improvements to make

**"done"** — The objective is met at high quality. Choose when:
  - The code works correctly and handles edge cases
  - The architecture is clean and pieces fit together
  - Further work would be diminishing returns
${noReflectHint}
Respond with ONLY a JSON object (no markdown fences):
{
  "action": "execute" | "reflect" | "done",
  "done": true/false,
  "reasoning": "your assessment and why you chose this action",
  "goalUpdate": "optional — if your understanding of 'amazing' has evolved, write it here",
  "tasks": [{"prompt": "..."}]
}`;

  onLog("Assessing...");
  const resultText = await runPlannerQuery(prompt, { cwd, model: plannerModel, permissionMode }, onLog);

  const parsed = await (async () => {
    const first = attemptJsonParse(resultText);
    if (first) return first;
    onLog("Retrying...");
    let retryText = "";
    for await (const msg of query({
      prompt: `Output ONLY a JSON object: {"action":"execute"|"reflect"|"done","done":true/false,"reasoning":"...","tasks":[{"prompt":"..."}]}`,
      options: { cwd, model: plannerModel, permissionMode, ...(permissionMode === "bypassPermissions" && { allowDangerouslySkipPermissions: true }), persistSession: false },
    })) {
      if (msg.type === "result" && msg.subtype === "success") retryText = (msg as any).result || "";
    }
    return attemptJsonParse(retryText) ?? { action: "done", done: true, reasoning: "Could not parse steering response" };
  })();

  const action: "execute" | "reflect" | "done" = parsed.action || (parsed.done ? "done" : "execute");

  if (action === "done") {
    return { done: true, action: "done", tasks: [], reasoning: parsed.reasoning || "Objective complete", goalUpdate: parsed.goalUpdate };
  }

  if (action === "reflect") {
    return { done: false, action: "reflect", tasks: [], reasoning: parsed.reasoning || "Quality audit needed", goalUpdate: parsed.goalUpdate };
  }

  let tasks: Task[] = (parsed.tasks || []).map((t: any, i: number) => ({
    id: String(i),
    prompt: typeof t === "string" ? t : t.prompt,
  }));

  tasks = postProcess(tasks, remainingBudget, onLog);

  return { done: tasks.length === 0, action: tasks.length === 0 ? "done" : "execute", tasks, reasoning: parsed.reasoning || "", goalUpdate: parsed.goalUpdate };
}
