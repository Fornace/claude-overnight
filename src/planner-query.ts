import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "fs";
import { NudgeError } from "./types.js";
import type { Task, PermMode, RateLimitWindow } from "./types.js";

// ── Types ──

/**
 * Logging callback used by planner/steering queries.
 * `kind` distinguishes ephemeral status updates (heartbeat ticker) from
 * discrete events worth persisting in a scrollback log (tool uses, retries).
 * Plain (text) callers still work  -- extra arg is ignored.
 */
export type PlannerLog = (text: string, kind?: "status" | "event") => void;

export interface PlannerRateLimitInfo {
  utilization: number;
  status: string;
  isUsingOverage: boolean;
  windows: Map<string, RateLimitWindow>;
  resetsAt?: number;
  costUsd: number;
}

export interface PlannerOpts {
  cwd: string;
  model: string;
  permissionMode: PermMode;
  resumeSessionId?: string;
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
}

// ── Shared env resolver (set once at run start, used by every planner query) ──
//
// Swarm and planner calls share a model→env map so a custom provider configured
// as planner or worker routes its traffic without threading extra params
// through every planner.ts / steering.ts function.
let _envResolver: ((model?: string) => Record<string, string> | undefined) | undefined;
export function setPlannerEnvResolver(fn: ((model?: string) => Record<string, string> | undefined) | undefined): void {
  _envResolver = fn;
}

// ── Model tier detection ──

export type ModelTier = "opus" | "sonnet" | "haiku" | "unknown";

export function detectModelTier(model: string): ModelTier {
  const m = model.toLowerCase();
  if (m === "default" || m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  // Cursor API Proxy models
  if (m === "auto") return "unknown";
  if (m.startsWith("composer")) return "sonnet";
  return "unknown";
}

export function modelCapabilityBlock(model: string): string {
  switch (detectModelTier(model)) {
    case "opus":
      return `Each agent runs Claude Opus with 1M context  -- a powerhouse. It can own entire epics, do deep codebase research, make architectural decisions, implement complex multi-file systems end-to-end, use browser tools for analysis, and deliver expert-level work. These agents can work for 30+ minutes on the most complex tasks. Do NOT waste them on trivial edits  -- give them ownership and autonomy.`;
    case "sonnet":
      return `Each agent runs Claude Sonnet  -- capable of substantial implementation, refactoring, testing, and design work. Can work autonomously for 10-20 minutes on complex tasks. Give agents meaningful scope  -- not just single-line edits.`;
    case "haiku":
      return `Each agent runs Claude Haiku  -- fast and efficient, best for focused, well-specified tasks. Be explicit about files, functions, and expected changes. Keep each task scoped to a clear, concrete deliverable.`;
    default:
      // Cursor API Proxy or unknown model — generic but mention Cursor context
      if (model.toLowerCase().startsWith("composer") || model.toLowerCase() === "auto") {
        return `Each agent runs a Cursor model with full codebase access. Capable of focused implementation work. Be explicit about files, functions, and expected changes.`;
      }
      return `Each agent has full codebase access and can work autonomously.`;
  }
}

// ── Rate limit tracking ──

const RATE_LIMIT_PATTERNS = ["rate", "limit", "overloaded", "429", "hit your limit", "too many"];

function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return RATE_LIMIT_PATTERNS.some((p) => msg.toLowerCase().includes(p));
}

let _totalPlannerCostUsd = 0;
export function getTotalPlannerCost(): number { return _totalPlannerCostUsd; }

let _plannerRateLimitInfo: PlannerRateLimitInfo = {
  utilization: 0, status: "", isUsingOverage: false, windows: new Map(), costUsd: 0,
};
export function getPlannerRateLimitInfo(): PlannerRateLimitInfo { return _plannerRateLimitInfo; }

// ── Proactive throttle: wait before making API calls when utilization is high ──

/**
 * Proactive rate-limit gate. Called before each planner/steering query to
 * prevent hammering the API when we're already near a limit.
 *
 * Levels:
 *   - rejected -> wait until resetsAt (or 60s fallback)
 *   - utilization >= 90% -> wait 30s with exponential backoff
 *   - utilization >= 75% -> brief 5s cooldown
 *   - utilization < 75% -> pass through immediately
 */
async function throttlePlanner(
  onLog: PlannerLog,
  aborted: () => boolean,
): Promise<void> {
  const MAX_BACKOFF = 3;
  for (let backoff = 0; backoff <= MAX_BACKOFF; backoff++) {
    if (aborted()) return;

    const rl = _plannerRateLimitInfo;
    const rejected = rl.resetsAt && rl.resetsAt > Date.now();
    const highUtil = rl.utilization >= 0.9;
    const elevatedUtil = rl.utilization >= 0.75;

    if (!rejected && !highUtil && !elevatedUtil) return;

    const waitMs = rejected
      ? Math.max(5000, rl.resetsAt! - Date.now())
      : highUtil
        ? 30_000 * (1 + backoff)
        : 5000;

    const reason = rejected ? "Rate limited" : `Utilization ${Math.round(rl.utilization * 100)}%`;
    onLog(`${reason}  -- waiting ${Math.ceil(waitMs / 1000)}s before query${backoff > 0 ? ` (backoff ${backoff})` : ""}`, "event");
    await new Promise((r) => setTimeout(r, waitMs));

    if (aborted()) return;
    // After a wait, clear the rejected flag so we don't loop forever if
    // the SDK stopped sending updates.
    if (rejected && rl.resetsAt && rl.resetsAt <= Date.now()) {
      rl.resetsAt = undefined;
      rl.utilization = 0;
    }
  }
  // Exhausted backoffs — proceed anyway, the retry loop will catch a rejection.
}

// ── Query execution ──

const NUDGE_MS = 15 * 60 * 1000;
const HARD_TIMEOUT_MS = 30 * 60 * 1000;
const WALL_CLOCK_LIMIT_MS = 45 * 60 * 1000;

export async function runPlannerQuery(
  prompt: string,
  opts: PlannerOpts,
  onLog: PlannerLog,
): Promise<string> {
  const MAX_RETRIES = 3;
  const BACKOFF = [30_000, 60_000, 120_000];

  let currentPrompt = prompt;
  let currentOpts = opts;
  let aborted = false;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Proactive throttle: wait if utilization is already high
      await throttlePlanner(onLog, () => aborted);
      return await runPlannerQueryOnce(currentPrompt, currentOpts, onLog);
    } catch (err: any) {
      if (err instanceof NudgeError) {
        if (err.sessionId) {
          onLog("Silent 15m  -- resuming session with continue", "event");
          currentPrompt = "Continue. Complete the task.";
          currentOpts = { ...opts, resumeSessionId: err.sessionId };
        } else {
          onLog("Silent 15m  -- restarting planner (no session to resume)", "event");
        }
        continue;
      }
      if (attempt < MAX_RETRIES && isRateLimitError(err)) {
        const waitMs = BACKOFF[attempt];
        onLog(`Rate limited  -- waiting ${Math.round(waitMs / 1000)}s before retry ${attempt + 1}/${MAX_RETRIES}`, "event");
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      throw err;
    }
  }
  aborted = true;
  throw new Error("Planner query failed after retries");
}

async function runPlannerQueryOnce(
  prompt: string,
  opts: PlannerOpts,
  onLog: PlannerLog,
): Promise<string> {
  _plannerRateLimitInfo = { utilization: 0, status: "", isUsingOverage: false, windows: new Map(), costUsd: 0 };
  let resultText = "";
  let structuredOutput: unknown;
  const startedAt = Date.now();
  const isResume = !!opts.resumeSessionId;
  const envOverride = _envResolver?.(opts.model);
  const pq = query({
    prompt,
    options: {
      cwd: opts.cwd,
      model: opts.model,
      tools: ["Read", "Glob", "Grep", "Write"],
      allowedTools: ["Read", "Glob", "Grep", "Write"],
      permissionMode: opts.permissionMode,
      ...(opts.permissionMode === "bypassPermissions" && { allowDangerouslySkipPermissions: true }),
      persistSession: true,
      includePartialMessages: true,
      ...(isResume && { resume: opts.resumeSessionId }),
      ...(opts.outputFormat && { outputFormat: opts.outputFormat }),
      ...(envOverride && { env: envOverride }),
    },
  });

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
    onLog(`${timeStr}${toolStr}${costStr}${rlStr}${extra}`, "status");
  }, 500);

  const timeoutMs = isResume ? HARD_TIMEOUT_MS : NUDGE_MS;
  let sessionId: string | undefined;
  let lastActivity = Date.now();
  let timer: NodeJS.Timeout;
  const watchdog = new Promise<never>((_, reject) => {
    const check = () => {
      const elapsed = Date.now() - startedAt;
      const silent = Date.now() - lastActivity;
      if (elapsed >= WALL_CLOCK_LIMIT_MS) {
        pq.interrupt().catch(() => pq.close());
        reject(new Error(`Planner hit wall-clock limit (${Math.round(elapsed / 60000)}min)  -- likely rate limited`));
        return;
      }
      if (silent >= timeoutMs) {
        pq.interrupt().catch(() => pq.close());
        if (isResume) reject(new Error(`Planner silent for ${Math.round(silent / 1000)}s  -- assumed hung`));
        else reject(new NudgeError(sessionId, silent));
      } else {
        timer = setTimeout(check, Math.min(30_000, timeoutMs - silent + 1000));
      }
    };
    timer = setTimeout(check, timeoutMs);
  });

  const consume = async () => {
    for await (const msg of pq) {
      lastActivity = Date.now();
      if (!sessionId && "session_id" in (msg as any)) sessionId = (msg as any).session_id;
      if (msg.type === "stream_event") {
        const ev = (msg as any).event;
        if (ev?.type === "content_block_start" && ev.content_block?.type === "tool_use") {
          toolCount++;
          const toolName = ev.content_block.name;
          const input = ev.content_block.input as Record<string, unknown> | undefined;
          // Enrich event with target file/path for readability
          const target = input?.path ?? input?.file_path ?? input?.command
            ? (typeof input?.command === "string" ? input.command.split(" ").slice(0, 3).join(" ") : "")
            : "";
          lastLogText = target ? `${toolName} ${target}` : toolName;
          onLog(target ? `${toolName} → ${target}` : toolName, "event");
        }
        if (ev?.type === "content_block_delta") {
          const delta = (ev as any).delta;
          if (delta?.type === "text_delta" && delta.text) {
            const snippet = delta.text.trim().replace(/[{}"\\,[\]]+/g, " ").replace(/\s+/g, " ").trim();
            if (snippet.length > 5) lastLogText = snippet.slice(0, 60);
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
        if (msg.subtype === "success") {
          structuredOutput = r.structured_output;
          resultText = r.result || "";
        } else {
          throw new Error(`Planner failed: ${r.result || msg.subtype}`);
        }
      }
    }
  };

  try { await Promise.race([consume(), watchdog]); }
  finally { clearTimeout(timer!); clearInterval(ticker); }

  if (structuredOutput != null && typeof structuredOutput === "object") return JSON.stringify(structuredOutput);
  return resultText;
}

// ── Post-processing ──

export function postProcess(raw: Task[], budget: number | undefined, onLog: (text: string) => void): Task[] {
  let tasks = raw;

  const before = tasks.length;
  tasks = tasks.filter((t) => t.prompt && t.prompt.trim().split(/\s+/).length >= 3);
  if (tasks.length < before) onLog(`Filtered ${before - tasks.length} task(s) with fewer than 3 words`);

  // Read-only tasks (verify/audit/user-test) shouldn't get a worktree: they
  // don't change files, so they'd just create empty swarm branches that show
  // up as "0 files changed" noise. Run them in the real project directory so
  // env files, dependencies, and local config are available.
  let readOnly = 0;
  for (const t of tasks) {
    if (!t.noWorktree && /^\s*(verify|audit|user[- ]?test)\b/i.test(t.prompt)) {
      t.noWorktree = true;
      readOnly++;
    }
  }
  if (readOnly > 0) onLog(`${readOnly} read-only task(s) marked noWorktree`);

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

  const cap = budget ? Math.ceil(budget * 1.2) : 30;
  if (tasks.length > cap) { onLog(`Truncating ${tasks.length} → ${cap}`); tasks = tasks.slice(0, cap); }
  tasks.sort((a, b) => Number(/\btest/i.test(a.prompt)) - Number(/\btest/i.test(b.prompt)));
  return tasks.map((t, i) => ({ ...t, id: String(i) }));
}

// ── JSON parsing utilities ──

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

export function attemptJsonParse(text: string): any | null {
  try { const obj = JSON.parse(text); if (typeof obj === "object" && obj !== null) return obj; } catch {}
  const braces = extractOutermostBraces(text);
  if (braces) { try { const obj = JSON.parse(braces); if (typeof obj === "object" && obj !== null) return obj; } catch {} }
  const stripped = text.replace(/```json?\s*/g, "").replace(/```/g, "").trim();
  if (stripped !== text) {
    try { const obj = JSON.parse(stripped); if (typeof obj === "object" && obj !== null) return obj; } catch {}
    const b2 = extractOutermostBraces(stripped);
    if (b2) { try { return JSON.parse(b2); } catch {} }
  }
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

export async function extractTaskJson(
  raw: string,
  retry: () => Promise<string>,
  onLog?: (text: string) => void,
  outFile?: string,
): Promise<{ tasks: any[] }> {
  if (outFile) {
    try {
      const fromFile = attemptJsonParse(readFileSync(outFile, "utf-8"));
      if (fromFile?.tasks) return fromFile;
    } catch {}
  }
  const first = attemptJsonParse(raw);
  if (first?.tasks) return first;
  onLog?.(`Parse failed (${raw.length} chars): ${raw.slice(0, 300)}`);
  const retryText = await retry();
  if (outFile) {
    try {
      const fromFile = attemptJsonParse(readFileSync(outFile, "utf-8"));
      if (fromFile?.tasks) return fromFile;
    } catch {}
  }
  const second = attemptJsonParse(retryText);
  if (second?.tasks) return second;
  onLog?.(`Retry failed (${retryText.length} chars): ${retryText.slice(0, 300)}`);
  throw new Error("Planner did not return valid task JSON after retry");
}
