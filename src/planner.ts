import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Task, PermMode } from "./types.js";

/**
 * Coordinator: analyzes the codebase, breaks objective into parallel tasks.
 */
export async function planTasks(
  objective: string,
  cwd: string,
  model: string,
  permissionMode: PermMode,
  onLog: (text: string) => void,
): Promise<Task[]> {
  onLog("Analyzing codebase...");

  const INACTIVITY_MS = 5 * 60 * 1000;
  let resultText = "";

  const plannerQuery = query({
    prompt: `You are a task coordinator for a parallel agent swarm. Analyze this codebase and break the following objective into independent tasks.

Objective: ${objective}

Requirements:
- Each task MUST be independent — no task depends on another
- Each task should target specific files/areas to avoid merge conflicts
- Be specific: mention exact file paths, function names, what to change
- Keep tasks focused: one logical change per task
- Aim for 3-15 tasks depending on scope

Respond with ONLY a JSON object (no markdown fences):
{
  "tasks": [
    { "prompt": "In src/foo.ts, refactor the bar() function to..." },
    { "prompt": "Add unit tests for the baz module in test/baz.test.ts..." }
  ]
}`,
    options: {
      cwd,
      model,
      tools: ["Read", "Glob", "Grep"],
      allowedTools: ["Read", "Glob", "Grep"],
      permissionMode: permissionMode,
      ...(permissionMode === "bypassPermissions" && { allowDangerouslySkipPermissions: true }),
      persistSession: false,
      includePartialMessages: true,
    },
  });

  // Inactivity watchdog — only kills planner if it goes completely silent
  let lastActivity = Date.now();
  let timer: NodeJS.Timeout;
  const watchdog = new Promise<never>((_, reject) => {
    const check = () => {
      const silent = Date.now() - lastActivity;
      if (silent >= INACTIVITY_MS) {
        plannerQuery.close();
        reject(new Error(`Planner silent for ${Math.round(silent / 1000)}s — assumed hung`));
      } else {
        timer = setTimeout(check, Math.min(30_000, INACTIVITY_MS - silent + 1000));
      }
    };
    timer = setTimeout(check, INACTIVITY_MS);
  });

  const consume = async () => {
    for await (const msg of plannerQuery) {
      lastActivity = Date.now();
      if (msg.type === "stream_event") {
        const ev = (msg as any).event;
        if (
          ev?.type === "content_block_start" &&
          ev.content_block?.type === "tool_use"
        ) {
          onLog(ev.content_block.name);
        }
      }
      if (msg.type === "result") {
        if (msg.subtype === "success") {
          resultText = (msg as any).result || "";
        } else {
          throw new Error(`Planner failed: ${msg.subtype}`);
        }
      }
    }
  };

  try {
    await Promise.race([consume(), watchdog]);
  } finally {
    clearTimeout(timer!);
  }

  const parsed = await extractTaskJson(resultText, async () => {
    onLog("Retrying for valid JSON...");
    let retryText = "";
    for await (const msg of query({
      prompt: `Your previous response did not contain valid JSON. Output ONLY a JSON object with this shape, nothing else:\n{"tasks":[{"prompt":"..."}]}`,
      options: {
        cwd,
        model,
        permissionMode,
        ...(permissionMode === "bypassPermissions" && { allowDangerouslySkipPermissions: true }),
        persistSession: false,
      },
    })) {
      if (msg.type === "result" && msg.subtype === "success") {
        retryText = (msg as any).result || "";
      }
    }
    return retryText;
  });

  let tasks: Task[] = (parsed.tasks || []).map((t: any, i: number) => ({
    id: String(i),
    prompt: typeof t === "string" ? t : t.prompt,
  }));

  // Filter garbage tasks (require at least 3 space-separated words)
  const before = tasks.length;
  tasks = tasks.filter((t) => t.prompt && t.prompt.trim().split(/\s+/).length >= 3);
  if (tasks.length < before) {
    onLog(`Filtered ${before - tasks.length} task(s) with fewer than 3 words`);
  }

  // Deduplicate tasks with very similar prompts (>80% word overlap)
  {
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
          // Keep the more specific (longer) prompt
          const drop = setA.size >= setB.size ? j : i;
          const keep = drop === j ? i : j;
          onLog(
            `Dedup: task ${tasks[drop].id} >${Math.round(overlap * 100)}% overlap with ${tasks[keep].id}, dropping`,
          );
          dominated.add(drop);
          if (drop === i) break;
        }
      }
    }
    if (dominated.size) {
      tasks = tasks.filter((_, i) => !dominated.has(i));
      onLog(`Deduplicated to ${tasks.length} tasks`);
    }
  }

  // Warn on compound tasks joining unrelated changes with 'and'
  for (const t of tasks) {
    const parts = t.prompt.split(/\s+and\s+/i);
    if (
      parts.length >= 2 &&
      parts.every((p) => p.trim().split(/\s+/).length >= 3)
    ) {
      onLog(
        `⚠ Task ${t.id} looks compound ("…and…") — consider splitting into separate tasks`,
      );
    }
  }

  // Warn on file overlap between tasks
  const fileRe = /(?:^|\s)((?:[\w.-]+\/)+[\w.-]+\.\w+)/g;
  const pathToTasks = new Map<string, string[]>();
  for (const t of tasks) {
    for (const m of t.prompt.matchAll(fileRe)) {
      const ids = pathToTasks.get(m[1]);
      if (ids) ids.push(t.id);
      else pathToTasks.set(m[1], [t.id]);
    }
  }
  for (const [path, ids] of pathToTasks) {
    if (ids.length > 1) onLog(`Overlap risk: ${path} in tasks ${ids.join(", ")}`);
  }

  // Warn if every task targets the same file — high merge conflict risk
  if (tasks.length > 1 && pathToTasks.size === 1) {
    const [singlePath] = pathToTasks.keys();
    onLog(`⚠ All ${tasks.length} tasks target ${singlePath} — high merge conflict risk`);
  }

  // Cap at 20 tasks
  if (tasks.length > 20) {
    onLog(`Too many tasks (${tasks.length}), truncating to 20`);
    tasks = tasks.slice(0, 20);
  }

  if (tasks.length === 0) throw new Error("Planner generated 0 tasks");

  // Sort test-related tasks last — they benefit from other changes landing first
  tasks.sort(
    (a, b) =>
      Number(/\btest/i.test(a.prompt)) - Number(/\btest/i.test(b.prompt)),
  );

  onLog(`Generated ${tasks.length} tasks`);
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
    // 1) Direct parse
    try {
      const obj = JSON.parse(text);
      if (obj?.tasks) return obj;
    } catch {}

    // 2) Outermost braces
    const braces = extractOutermostBraces(text);
    if (braces) {
      try {
        const obj = JSON.parse(braces);
        if (obj?.tasks) return obj;
      } catch {}
    }

    // 3) Strip markdown fences and retry
    const stripped = text.replace(/```json?\s*/g, "").replace(/```/g, "").trim();
    if (stripped !== text) {
      try {
        const obj = JSON.parse(stripped);
        if (obj?.tasks) return obj;
      } catch {}
      const braces2 = extractOutermostBraces(stripped);
      if (braces2) {
        try {
          const obj = JSON.parse(braces2);
          if (obj?.tasks) return obj;
        } catch {}
      }
    }

    return null;
  };

  const first = attempt(raw);
  if (first) return first;

  // One retry with a shorter prompt
  const retryText = await retry();
  const second = attempt(retryText);
  if (second) return second;

  throw new Error("Planner did not return valid task JSON after retry");
}
