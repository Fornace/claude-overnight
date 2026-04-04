import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Task, PermMode } from "./types.js";

const INACTIVITY_MS = 5 * 60 * 1000;

interface PlannerOpts {
  cwd: string;
  model: string;
  permissionMode: PermMode;
}

// ── Budget-aware prompt strategy ──

function plannerPrompt(objective: string, budget?: number, concurrency?: number): string {
  const b = budget ?? 10;
  const concLine = concurrency
    ? `\n- ${concurrency} agents run in parallel — tasks that run concurrently must touch DIFFERENT files to avoid merge conflicts`
    : "";

  // Small budget: specific tasks, one change each (original behavior)
  if (b <= 15) {
    return `You are a task coordinator for a parallel agent system. Analyze this codebase and break the following objective into independent tasks.

Objective: ${objective}

Requirements:
- Each task MUST be independent — no task depends on another
- Each task should target specific files/areas to avoid merge conflicts
- Be specific: mention exact file paths, function names, what to change
- Keep tasks focused: one logical change per task
- Target exactly ~${b} tasks${concLine}

Respond with ONLY a JSON object (no markdown fences):
{
  "tasks": [
    { "prompt": "In src/foo.ts, refactor the bar() function to..." },
    { "prompt": "Add unit tests for the baz module in test/baz.test.ts..." }
  ]
}`;
  }

  // Medium budget (16-50): substantial missions, each agent gets real autonomy
  if (b <= 50) {
    return `You are a task coordinator for a parallel agent system with ${b} agent sessions available.

Objective: ${objective}

IMPORTANT — what each agent session is:
Each task you create will be executed by a powerful AI agent (Claude with 1M context window) that has full access to the codebase, can read files, write code, run commands, and work for up to 30 minutes. These are NOT micro-tasks for humans — each agent is a capable engineer that can research, design, and implement.

Do NOT over-specify. Give each agent a MISSION, not step-by-step instructions. Let agents make their own decisions about implementation details.

Requirements:
- Target exactly ~${b} tasks
- Each task should be a substantial piece of work (5-30 minutes of agent time)
- Each task MUST be independent — no task depends on another
- Tasks that run concurrently must touch DIFFERENT files/areas to avoid merge conflicts
- Give agents scope and autonomy: "Design and implement X" not "In file Y, add function Z"
- Include research/exploration tasks, design tasks, implementation tasks, testing tasks, and polish tasks
- Think in terms of workstreams: architecture, features, tests, docs, UX, performance, etc.${concLine}

Respond with ONLY a JSON object (no markdown fences):
{
  "tasks": [
    { "prompt": "Design and implement the complete user favorites system: database schema, API routes, client hooks, and error handling. Research existing patterns in the codebase first." },
    { "prompt": "Audit all existing API routes for consistency, error handling, and input validation. Fix any issues found." }
  ]
}`;
  }

  // Large budget (50+): ambitious multi-workstream decomposition
  return `You are a task coordinator for a parallel agent system with ${b} agent sessions available. This is a LARGE budget — equivalent to months of professional engineering work.

Objective: ${objective}

CRITICAL — what each agent session is:
Each task you create will be executed by a powerful AI agent (Claude with 1M context window) that has full access to the codebase, can read files, write code, run commands, and work for up to 30 minutes autonomously. These are NOT micro-tasks. Each agent is a senior engineer that can research, design, architect, implement, test, and refactor independently. Do NOT waste sessions on trivial single-file edits.

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
- Think about what a team of ${b} senior engineers could accomplish in parallel${concLine}

Respond with ONLY a JSON object (no markdown fences):
{
  "tasks": [
    { "prompt": "Own the complete implementation of [feature X]: research the codebase for patterns, design the architecture, implement the database layer, API routes, and client hooks. Make it production-ready." },
    { "prompt": "Comprehensive test suite for [module Y]: unit tests, integration tests, edge cases, error scenarios. Aim for high coverage and meaningful assertions." },
    { "prompt": "UX audit and polish pass on [area Z]: review all user-facing flows, improve error messages, loading states, empty states, and micro-interactions." }
  ]
}`;
}

async function runPlannerQuery(
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

  // Progress ticker — show elapsed time so it doesn't look frozen
  let lastLogText = "";
  let toolCount = 0;
  const ticker = setInterval(() => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    const timeStr = m > 0 ? `${m}m ${s}s` : `${s}s`;
    const extra = lastLogText ? ` — ${lastLogText}` : "";
    onLog(`${timeStr} elapsed, ${toolCount} tool calls${extra}`);
  }, 3000);

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
            const snippet = delta.text.trim();
            if (snippet.length > 3) {
              lastLogText = snippet.slice(0, 60);
            }
          }
        }
      }
      if (msg.type === "result") {
        if (msg.subtype === "success") resultText = (msg as any).result || "";
        else throw new Error(`Planner failed: ${msg.subtype}`);
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
      const overlap = shared / Math.min(setA.size, setB.size);
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
  model: string,
  permissionMode: PermMode,
  budget: number | undefined,
  concurrency: number,
  onLog: (text: string) => void,
): Promise<Task[]> {
  onLog("Analyzing codebase...");

  const resultText = await runPlannerQuery(
    plannerPrompt(objective, budget, concurrency),
    { cwd, model, permissionMode },
    onLog,
  );

  const parsed = await extractTaskJson(resultText, async () => {
    onLog("Retrying for valid JSON...");
    let retryText = "";
    for await (const msg of query({
      prompt: `Your previous response did not contain valid JSON. Output ONLY a JSON object:\n{"tasks":[{"prompt":"..."}]}`,
      options: { cwd, model, permissionMode, ...(permissionMode === "bypassPermissions" && { allowDangerouslySkipPermissions: true }), persistSession: false },
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

export async function refinePlan(
  objective: string,
  previousTasks: Task[],
  feedback: string,
  cwd: string,
  model: string,
  permissionMode: PermMode,
  budget: number | undefined,
  concurrency: number,
  onLog: (text: string) => void,
): Promise<Task[]> {
  onLog("Refining plan...");

  const prev = previousTasks.map((t, i) => `${i + 1}. ${t.prompt}`).join("\n");
  const b = budget ?? 10;
  const scaleNote = b > 50
    ? `This is a LARGE budget (${b} sessions). Each session is a powerful AI agent with 1M context that can work for 30 minutes. Think big — missions, not micro-tasks.`
    : b > 15
      ? `Each of the ${b} sessions is a capable AI agent that can work autonomously for up to 30 minutes. Give substantial missions, not trivial edits.`
      : `Target ~${b} tasks.`;
  const prompt = `You are a task coordinator. You previously planned these tasks for the objective:

Objective: ${objective}

Previous plan:
${prev}

The user wants changes: ${feedback}

${scaleNote} ${concurrency} agents run in parallel. Update the plan accordingly. Keep tasks independent and targeting different files/areas.

Respond with ONLY a JSON object (no markdown):
{"tasks":[{"prompt":"..."}]}`;

  const resultText = await runPlannerQuery(prompt, { cwd, model, permissionMode }, onLog);

  const parsed = await extractTaskJson(resultText, async () => {
    onLog("Retrying...");
    let retryText = "";
    for await (const msg of query({
      prompt: `Output ONLY a JSON object:\n{"tasks":[{"prompt":"..."}]}`,
      options: { cwd, model, permissionMode, ...(permissionMode === "bypassPermissions" && { allowDangerouslySkipPermissions: true }), persistSession: false },
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

/** Try multiple strategies to parse task JSON, with one retry callback. */
async function extractTaskJson(
  raw: string,
  retry: () => Promise<string>,
): Promise<{ tasks: any[] }> {
  const attempt = (text: string): { tasks: any[] } | null => {
    try { const obj = JSON.parse(text); if (obj?.tasks) return obj; } catch {}
    const braces = extractOutermostBraces(text);
    if (braces) { try { const obj = JSON.parse(braces); if (obj?.tasks) return obj; } catch {} }
    const stripped = text.replace(/```json?\s*/g, "").replace(/```/g, "").trim();
    if (stripped !== text) {
      try { const obj = JSON.parse(stripped); if (obj?.tasks) return obj; } catch {}
      const b2 = extractOutermostBraces(stripped);
      if (b2) { try { const obj = JSON.parse(b2); if (obj?.tasks) return obj; } catch {} }
    }
    return null;
  };

  const first = attempt(raw);
  if (first) return first;
  const retryText = await retry();
  const second = attempt(retryText);
  if (second) return second;
  throw new Error("Planner did not return valid task JSON after retry");
}
