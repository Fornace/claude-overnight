import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "fs";
import { NudgeError } from "./types.js";
import type { Task, PermMode, RateLimitWindow } from "./types.js";

/** Rate limit info emitted by planner queries for UI display. */
export interface PlannerRateLimitInfo {
  utilization: number;
  status: string;
  isUsingOverage: boolean;
  windows: Map<string, RateLimitWindow>;
  resetsAt?: number;
  costUsd: number;
}

// ── Steering types ──

export interface WaveSummary {
  wave: number;
  kind: string;
  tasks: { prompt: string; status: string; filesChanged?: number; error?: string }[];
}

export interface SteerResult {
  done: boolean;
  tasks: Task[];
  reasoning: string;
  waveKind: string;
  goalUpdate?: string;
  statusUpdate?: string;
}

export interface RunMemory {
  designs: string;
  reflections: string;
  verifications: string;
  milestones: string;
  status: string;
  goal: string;
  previousRuns?: string;
}

// The core framing for all planning. Not a checklist — a way of thinking.
const DESIGN_THINKING = `
HOW TO THINK ABOUT EVERY TASK:

Start from the user's job. What is someone hiring this product to do? "I need to send money abroad cheaply" — not "I need a currency conversion API." Every decision — what to build, how fast it responds, what happens on error — flows from the job.

The experience IS the product. A 200ms server response is not a "performance metric" — it's the difference between an app that feels alive and one that feels broken. A loading state is not "polish" — it's the user knowing the app heard them. An error message is not "error handling" — it's the app being honest. There is no line between backend and UX. The server, the API, the database query, the render — they're all one experience the user either trusts or doesn't.

Build the core, verify it works, learn, iterate. Don't plan 20 features and build them all. Build the ONE thing that matters most, run it, see if it actually works from a user's chair. What you learn from seeing it run will change what you build next. Each wave should make what exists better before adding what doesn't exist yet.

Consistency is what makes complex things feel simple. One design system, rigid rules, no exceptions. This is how Revolut ships a super-app with 30+ features that doesn't feel like chaos.
`;

const NUDGE_MS = 15 * 60 * 1000;   // 15 min — close & restart with "continue"
const HARD_TIMEOUT_MS = 30 * 60 * 1000; // 30 min — give up

interface PlannerOpts {
  cwd: string;
  model: string;
  permissionMode: PermMode;
  /** Resume a previous session instead of starting fresh. */
  resumeSessionId?: string;
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

  let currentPrompt = prompt;
  let currentOpts = opts;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await runPlannerQueryOnce(currentPrompt, currentOpts, onLog);
    } catch (err: any) {
      if (err instanceof NudgeError) {
        if (err.sessionId) {
          onLog("Silent 15m — resuming session with continue");
          currentPrompt = "Continue. Complete the task.";
          currentOpts = { ...opts, resumeSessionId: err.sessionId };
        } else {
          onLog("Silent 15m — restarting planner (no session to resume)");
          // No session captured, just retry from scratch
        }
        continue;
      }
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

/** Cumulative cost of all planner queries (steering, orchestration, etc.) across the session. */
let _totalPlannerCostUsd = 0;
export function getTotalPlannerCost(): number { return _totalPlannerCostUsd; }

/** Shared mutable rate limit state that planner queries write to for UI display. Reset per query. */
let _plannerRateLimitInfo: PlannerRateLimitInfo = {
  utilization: 0, status: "", isUsingOverage: false, windows: new Map(), costUsd: 0,
};
export function getPlannerRateLimitInfo(): PlannerRateLimitInfo { return _plannerRateLimitInfo; }

async function runPlannerQueryOnce(
  prompt: string,
  opts: PlannerOpts,
  onLog: (text: string) => void,
): Promise<string> {
  _plannerRateLimitInfo = { utilization: 0, status: "", isUsingOverage: false, windows: new Map(), costUsd: 0 };
  let resultText = "";
  const startedAt = Date.now();
  const isResume = !!opts.resumeSessionId;
  const pq = query({
    prompt,
    options: {
      cwd: opts.cwd,
      model: opts.model,
      tools: ["Read", "Glob", "Grep", "Write"],
      allowedTools: ["Read", "Glob", "Grep", "Write"],
      permissionMode: opts.permissionMode,
      ...(opts.permissionMode === "bypassPermissions" && { allowDangerouslySkipPermissions: true }),
      persistSession: true, // needed for interrupt+resume
      includePartialMessages: true,
      ...(isResume && { resume: opts.resumeSessionId }),
    },
  });

  // Progress ticker — fast updates with compact format
  let lastLogText = "";
  let toolCount = 0;
  let costUsd = 0;
  const ticker = setInterval(() => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    const timeStr = m > 0 ? `${m}m ${s}s` : `${s}s`;
    const toolStr = toolCount > 0 ? ` · ${toolCount} tools` : "";
    const costStr = costUsd > 0 ? ` · $${costUsd.toFixed(3)}` : "";
    const rlPct = _plannerRateLimitInfo.utilization;
    const rlStr = rlPct > 0 ? ` · ${Math.round(rlPct * 100)}%` : "";
    const extra = lastLogText ? ` · ${lastLogText}` : "";
    onLog(`${timeStr}${toolStr}${costStr}${rlStr}${extra}`);
  }, 500);

  const timeoutMs = isResume ? HARD_TIMEOUT_MS : NUDGE_MS;
  let sessionId: string | undefined;
  let lastActivity = Date.now();
  let timer: NodeJS.Timeout;
  const watchdog = new Promise<never>((_, reject) => {
    const check = () => {
      const silent = Date.now() - lastActivity;
      if (silent >= timeoutMs) {
        // Try interrupt (graceful), fall back to close (hard kill)
        pq.interrupt().catch(() => pq.close());
        if (isResume) {
          reject(new Error(`Planner silent for ${Math.round(silent / 1000)}s — assumed hung`));
        } else {
          reject(new NudgeError(sessionId, silent));
        }
      }
      else timer = setTimeout(check, Math.min(30_000, timeoutMs - silent + 1000));
    };
    timer = setTimeout(check, timeoutMs);
  });

  const consume = async () => {
    for await (const msg of pq) {
      lastActivity = Date.now();
      if (!sessionId && "session_id" in (msg as any)) {
        sessionId = (msg as any).session_id;
      }
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
      if (msg.type === "rate_limit_event") {
        const info = (msg as any).rate_limit_info;
        if (info) {
          _plannerRateLimitInfo.utilization = info.utilization ?? 0;
          _plannerRateLimitInfo.status = info.status ?? "";
          if (info.isUsingOverage) _plannerRateLimitInfo.isUsingOverage = true;
          if (info.resetsAt) _plannerRateLimitInfo.resetsAt = info.resetsAt;
          if (info.rateLimitType) {
            _plannerRateLimitInfo.windows.set(info.rateLimitType, {
              type: info.rateLimitType,
              utilization: info.utilization ?? 0,
              status: info.status,
              resetsAt: info.resetsAt,
            });
          }
        }
      }
      if (msg.type === "result") {
        const r = msg as any;
        if (typeof r.total_cost_usd === "number") {
          costUsd = r.total_cost_usd;
          _plannerRateLimitInfo.costUsd += costUsd;
          _totalPlannerCostUsd += costUsd;
        }
        if (msg.subtype === "success") resultText = r.result || "";
        else throw new Error(`Planner failed: ${r.result || msg.subtype}`);
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
  outFile?: string,
): Promise<Task[]> {
  onLog("Analyzing codebase...");

  const prompt = plannerPrompt(objective, workerModel, budget, concurrency, flexNote);
  const fileInstruction = outFile ? `\n\nAFTER generating the JSON, also write it to ${outFile} using the Write tool.` : "";
  const resultText = await runPlannerQuery(
    prompt + fileInstruction,
    { cwd, model: plannerModel, permissionMode },
    onLog,
  );

  const parsed = await extractTaskJson(resultText, async () => {
    onLog("Retrying...");
    return runPlannerQuery(
      `Your previous response was not valid JSON. Respond with ONLY a JSON object {"tasks":[{"prompt":"..."}]}.\n\n${prompt}`,
      { cwd, model: plannerModel, permissionMode },
      onLog,
    );
  }, onLog, outFile);

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
  onLog: (text: string) => void = () => {},
): Promise<string[]> {
  const resultText = await runPlannerQuery(
    `Split this objective into exactly ${count} independent research angles for architects exploring a codebase. Each angle should cover a distinct aspect.\n\nObjective: ${objective}\n\nReturn ONLY a JSON object: {"themes": ["angle description", ...]}`,
    { cwd: process.cwd(), model, permissionMode },
    onLog,
  );

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
  previousKnowledge?: string,
): Task[] {
  const prevBlock = previousKnowledge ? `\nKNOWLEDGE FROM PREVIOUS RUNS:\n${previousKnowledge}\n\nBuild on this — don't re-discover what's already known.\n` : "";
  return themes.map((theme, i) => ({
    id: `think-${i}`,
    prompt: `You are a senior architect exploring a codebase to design a solution.

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
  outFile?: string,
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
  const resultText = await runPlannerQuery(prompt, { cwd, model: plannerModel, permissionMode }, onLog);

  const parsed = await extractTaskJson(resultText, async () => {
    onLog("Retrying...");
    return runPlannerQuery(
      `Your previous response was not valid JSON. Respond with ONLY a JSON object {"tasks":[{"prompt":"..."}]}.\n\n${prompt}`,
      { cwd, model: plannerModel, permissionMode },
      onLog,
    );
  }, onLog, outFile);

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
    return runPlannerQuery(
      `Your previous response was not valid JSON. Respond with ONLY a JSON object {"tasks":[{"prompt":"..."}]}.\n\n${prompt}`,
      { cwd, model: plannerModel, permissionMode },
      onLog,
    );
  }, onLog);

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
  // Salvage truncated task JSON — find last complete task object and close
  const tasksMatch = text.match(/\{\s*"tasks"\s*:\s*\[/);
  if (tasksMatch) {
    const lastBrace = text.lastIndexOf("}");
    if (lastBrace > tasksMatch.index!) {
      const salvaged = text.slice(tasksMatch.index!, lastBrace + 1) + "]}";
      try { const obj = JSON.parse(salvaged); if (obj?.tasks?.length > 0) return obj; } catch {}
    }
  }
  return null;
}

/** Extract task JSON: try file first, then in-memory parse, then retry with context. */
async function extractTaskJson(
  raw: string,
  retry: () => Promise<string>,
  onLog?: (text: string) => void,
  outFile?: string,
): Promise<{ tasks: any[] }> {
  // 1. Try reading from file (most resilient — survives truncated output)
  if (outFile) {
    try {
      const fileContent = readFileSync(outFile, "utf-8");
      const fromFile = attemptJsonParse(fileContent);
      if (fromFile?.tasks) return fromFile;
    } catch {}
  }
  // 2. Try parsing result text
  const first = attemptJsonParse(raw);
  if (first?.tasks) return first;
  onLog?.(`Parse failed (${raw.length} chars): ${raw.slice(0, 300)}`);
  // 3. Retry with full context
  const retryText = await retry();
  // Re-check file in case retry wrote it
  if (outFile) {
    try {
      const fileContent = readFileSync(outFile, "utf-8");
      const fromFile = attemptJsonParse(fileContent);
      if (fromFile?.tasks) return fromFile;
    } catch {}
  }
  const second = attemptJsonParse(retryText);
  if (second?.tasks) return second;
  onLog?.(`Retry failed (${retryText.length} chars): ${retryText.slice(0, 300)}`);
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

  const recentWaves = history.slice(-3);
  const recentText = recentWaves.length > 0 ? recentWaves.map(w => {
    const lines = w.tasks.map(t => {
      const files = t.filesChanged ? ` (${t.filesChanged} files)` : "";
      const err = t.error ? ` — ${t.error}` : "";
      return `  - [${t.status}] ${t.prompt.slice(0, 120)}${files}${err}`;
    }).join("\n");
    return `Wave ${w.wave + 1} (${w.kind}):\n${lines}`;
  }).join("\n\n") : "(first wave)";

  const lastKind = history.length > 0 ? history[history.length - 1].kind : "";
  const isSyntheticKind = lastKind.includes("blocked") || lastKind.includes("capped");
  const repeatHint = lastKind && lastKind !== "execute" && !isSyntheticKind
    ? `\nThe previous wave was "${lastKind}". Don't repeat the same wave kind unless you have a strong reason.\n`
    : "";

  const cap = (s: string, max: number) => s.length > max ? s.slice(0, max) + "\n...(truncated)" : s;
  const statusBlock = runMemory?.status ? `\nCurrent project status:\n${runMemory.status}\n` : "";
  const milestoneBlock = runMemory?.milestones ? `\nMilestone snapshots:\n${cap(runMemory.milestones, 4000)}\n` : "";
  const designBlock = runMemory?.designs ? `\nArchitectural research:\n${cap(runMemory.designs, 4000)}\n` : "";
  const reflectionBlock = runMemory?.reflections ? `\nLatest quality reports:\n${cap(runMemory.reflections, 3000)}\n` : "";
  const verificationBlock = runMemory?.verifications ? `\nVerification results (from actually running the app):\n${cap(runMemory.verifications, 3000)}\n` : "";
  const goalBlock = runMemory?.goal ? `\nNorth star — what "amazing" means:\n${runMemory.goal}\n` : "";
  const prevRunBlock = runMemory?.previousRuns ? `\nKnowledge from previous runs:\n${cap(runMemory.previousRuns, 3000)}\n` : "";

  const prompt = `You are the quality director for an autonomous multi-wave agent system. Your job is to push the work toward "amazing," not just "done."

Objective: ${objective}
${goalBlock}${statusBlock}${milestoneBlock}${prevRunBlock}
Recent waves:
${recentText}
${designBlock}${reflectionBlock}${verificationBlock}
Remaining budget: ${remainingBudget} agent sessions. ${concurrency} agents run in parallel — tasks must touch DIFFERENT files.
${capability}
${DESIGN_THINKING}
Total waves completed: ${history.length}

Read the codebase. Assess from the user's chair: does this product do the job someone would hire it for? Does it feel fast, honest, and trustworthy? Not "is the code clean" — "would I use this?"

If verification found issues, those are the priority. Fix what's broken before building what's missing. Iterate on what exists before expanding scope.

## Compose the next wave

You have full creative freedom. Design the wave that will have the highest impact right now. Here are archetypes to draw from — mix, adapt, or invent your own:

**Execute** — Agents implement concrete changes in parallel. Each touches different files. The bread and butter.
  Example: 5 agents each owning a different feature or fix

**Explore** — Multiple agents independently tackle the same problem from different angles. Each writes a design/approach to a separate file. Use when you need creative alternatives before committing.
  Example: 3 agents each design a different navigation approach, writing to designs/nav-{approach}.md

**Critique** — Agents review what exists as skeptical experts. They read the codebase and write findings to files. Use after substantial new code ships.
  Example: 1 code quality reviewer, 1 UX reviewer examining flows end-to-end

**Synthesize** — An agent reads multiple alternatives or review findings and makes a decision. Writes the chosen approach or prioritized fix list.
  Example: 1 agent reads 3 design docs and writes the implementation plan

**Verify** — Agents actually RUN the application: build it, start it, navigate it, click things, try edge cases. They report what works and what's broken. Not code reading — real testing. Always set "noWorktree": true so they run in the real project environment (env files, dependencies, config). Tell verify agents: if the app requires authentication, DO NOT give up — search the codebase for dev login routes, test tokens, seed users, env vars with keys/secrets, CLI auth commands, or any other mechanism that lets you in. Try everything before declaring auth impossible.
  Example: 1 agent does end-to-end QA, writing a report with reproduction steps

**User-test** — Agents emulate specific user personas interacting with the product. Always set "noWorktree": true. "First-time user who just downloaded this." "Power user trying to do X fast." They test from that perspective and report friction.
  Example: 2 agents, one new user, one power user, each writing a report

**Polish** — Agents focus purely on feel: loading states, error messages, micro-interactions, empty states, responsiveness. Not features — the texture that makes users trust the product.
  Example: 2 agents, one on happy paths, one on error/edge states

You can combine these. A wave can have 3 execute agents + 1 verification agent. Or 2 divergent explorers. Whatever the situation calls for.

For non-execute tasks (critique, verify, user-test, synthesize), tell agents to write their output to files in the run directory so findings persist for future waves. Use paths like: .claude-overnight/latest/reflections/wave-N-{topic}.md or .claude-overnight/latest/verifications/wave-N-{topic}.md.

IMPORTANT: You cannot declare "done" unless at least one verification wave has confirmed the app works. If you're considering done but haven't verified, compose a verification wave first.
${repeatHint}
Respond with ONLY a JSON object (no markdown fences):
{
  "done": false,
  "waveKind": "execute",
  "reasoning": "your assessment and why you chose this wave composition",
  "goalUpdate": "optional — refine what 'amazing' means as you learn more",
  "statusUpdate": "REQUIRED — concise project status: what's built, what works, what's rough, quality level, key gaps. This replaces the previous status.",
  "tasks": [
    {"prompt": "task instruction...", "model": "worker"},
    {"prompt": "review task...", "model": "planner"},
    {"prompt": "verify the app end-to-end...", "model": "planner", "noWorktree": true}
  ]
}

The "model" field on each task: use "worker" (${workerModel}) for implementation tasks, "planner" (${plannerModel}) for review/analysis/verification tasks. Default is "worker".
Set "noWorktree": true for verify/user-test tasks — they run in the real project directory instead of an isolated worktree, with access to env files, installed dependencies, and local config.

If done: {"done": true, "waveKind": "done", "reasoning": "...", "statusUpdate": "...", "tasks": []}`;

  onLog("Assessing...");
  const resultText = await runPlannerQuery(prompt, { cwd, model: plannerModel, permissionMode }, onLog);

  const parsed = await (async () => {
    const first = attemptJsonParse(resultText);
    if (first) return first;
    onLog("Retrying...");
    const retryText = await runPlannerQuery(
      `Your previous response was not valid JSON. Respond with ONLY a JSON object {"done":false,"waveKind":"execute","reasoning":"...","statusUpdate":"...","tasks":[{"prompt":"..."}]}.\n\n${prompt}`,
      { cwd, model: plannerModel, permissionMode },
      onLog,
    );
    const retryParsed = attemptJsonParse(retryText);
    if (retryParsed) return retryParsed;
    // Don't return done:true on parse failure — that permanently marks the run complete.
    // Throw so the caller's catch block handles it as a transient steering failure.
    throw new Error("Could not parse steering response after retry");
  })();

  const isDone = parsed.done === true;
  const waveKind: string = parsed.waveKind || parsed.action || (isDone ? "done" : "execute");
  const statusUpdate = parsed.statusUpdate || undefined;

  if (isDone) {
    return { done: true, tasks: [], reasoning: parsed.reasoning || "Objective complete", waveKind: "done", goalUpdate: parsed.goalUpdate, statusUpdate };
  }

  let tasks: Task[] = (parsed.tasks || []).map((t: any, i: number) => ({
    id: String(i),
    prompt: typeof t === "string" ? t : t.prompt,
    ...(t.model && { model: t.model }),
    ...(t.noWorktree && { noWorktree: true }),
  }));

  tasks = postProcess(tasks, remainingBudget, onLog);

  return { done: tasks.length === 0, tasks, reasoning: parsed.reasoning || "", waveKind: tasks.length === 0 ? "done" : waveKind, goalUpdate: parsed.goalUpdate, statusUpdate };
}
