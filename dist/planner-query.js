import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "fs";
import { NudgeError, extractToolTarget, sumUsageTokens } from "./types.js";
import { writeTranscriptEvent } from "./transcripts.js";
import { getTurn, updateTurn } from "./turns.js";
/** Log a tool invocation with a short target for planner queries. */
const logTool = (label, input) => {
    const target = extractToolTarget(input);
    return target ? `${label} \u2192 ${target}` : label;
};
const DEFAULT_TOOLS = ["Read", "Glob", "Grep", "Write", "Bash", "WebFetch", "WebSearch", "TodoWrite", "Agent"];
const DEFAULT_MAX_TURNS = 20;
// ── Shared env resolver (set once at run start, used by every planner query) ──
//
// Swarm and planner calls share a model→env map so a custom provider configured
// as planner or worker routes its traffic without threading extra params
// through every planner.ts / steering.ts function.
let _envResolver;
export function setPlannerEnvResolver(fn) {
    _envResolver = fn;
}
// ── Rate limit tracking ──
const RATE_LIMIT_PATTERNS = ["rate", "limit", "overloaded", "429", "hit your limit", "too many"];
function isRateLimitError(err) {
    const msg = err instanceof Error ? err.message : String(err);
    return RATE_LIMIT_PATTERNS.some((p) => msg.toLowerCase().includes(p));
}
let _totalPlannerCostUsd = 0;
export function getTotalPlannerCost() { return _totalPlannerCostUsd; }
let _peakPlannerContextTokens = 0;
let _peakPlannerContextModel;
export function getPeakPlannerContext() {
    return { tokens: _peakPlannerContextTokens, model: _peakPlannerContextModel };
}
let _plannerRateLimitInfo = {
    utilization: 0, status: "", isUsingOverage: false, windows: new Map(), costUsd: 0,
};
export function getPlannerRateLimitInfo() { return _plannerRateLimitInfo; }
// ── Proactive rate-limit gate ──
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
async function throttlePlanner(onLog, aborted) {
    const MAX_BACKOFF = 3;
    for (let backoff = 0; backoff <= MAX_BACKOFF; backoff++) {
        if (aborted())
            return;
        const rl = _plannerRateLimitInfo;
        const rejected = rl.resetsAt && rl.resetsAt > Date.now();
        const highUtil = rl.utilization >= 0.9;
        const elevatedUtil = rl.utilization >= 0.75;
        if (!rejected && !highUtil && !elevatedUtil)
            return;
        const waitMs = rejected
            ? Math.max(5000, rl.resetsAt - Date.now())
            : highUtil
                ? 30_000 * (1 + backoff)
                : 5000;
        const reason = rejected ? "Rate limited" : `Utilization ${Math.round(rl.utilization * 100)}%`;
        onLog(`${reason}  -- waiting ${Math.ceil(waitMs / 1000)}s before query${backoff > 0 ? ` (backoff ${backoff})` : ""}`, "event");
        await new Promise((r) => setTimeout(r, waitMs));
        if (aborted())
            return;
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
// ── Cursor proxy: direct HTTP bypass ──
//
// When the env routes to a cursor proxy (CURSOR_API_KEY present, no ANTHROPIC_API_KEY),
// the claude-agent-sdk wrapper is harmful, not helpful:
//   - The SDK spawns a `claude` subprocess that makes 4+ sequential HTTP calls to the proxy.
//   - Each call spawns a fresh cursor-agent subprocess (~15s overhead each).
//   - Total: 4 × 15s = 60s for what should be a single 10-15s completion.
// The SDK features (local tool loop, session resume, rate-limit headers) do not apply:
//   - cursor-agent runs its own internal tool loop; local tool_use never fires.
//   - cursor proxy doesn't expose session IDs or rate-limit headers.
// One direct POST is always correct and 4-10× faster.
function isCursorProxyEnv(env) {
    return !!env?.CURSOR_API_KEY && !env?.ANTHROPIC_API_KEY;
}
async function runViaDirectFetch(prompt, opts, onLog) {
    const env = opts.env ?? _envResolver?.(opts.model);
    const baseUrl = (env?.ANTHROPIC_BASE_URL ?? "http://127.0.0.1:8765").replace(/\/$/, "");
    const authToken = env?.ANTHROPIC_AUTH_TOKEN ?? "";
    const MAX_RETRIES = 3;
    const BACKOFF = [30_000, 60_000, 120_000];
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const res = await fetch(`${baseUrl}/v1/messages`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${authToken}` },
            body: JSON.stringify({ model: opts.model, max_tokens: 8192, messages: [{ role: "user", content: prompt }] }),
        });
        if (res.status === 429 && attempt < MAX_RETRIES) {
            const waitMs = BACKOFF[attempt];
            onLog(`Cursor proxy rate limited — waiting ${Math.round(waitMs / 1000)}s`, "event");
            await new Promise(r => setTimeout(r, waitMs));
            continue;
        }
        if (!res.ok)
            throw new Error(`Cursor proxy ${res.status}: ${(await res.text().catch(() => ""))}`);
        const data = await res.json();
        return data.content?.[0]?.text ?? "";
    }
    throw new Error("Cursor proxy direct fetch failed after retries");
}
export async function runPlannerQuery(prompt, opts, onLog) {
    const env = opts.env ?? _envResolver?.(opts.model);
    if (isCursorProxyEnv(env))
        return runViaDirectFetch(prompt, opts, onLog);
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
        }
        catch (err) {
            if (err instanceof NudgeError) {
                if (err.sessionId) {
                    onLog("Silent 15m  -- resuming session with continue", "event");
                    currentPrompt = "Continue. Complete the task.";
                    currentOpts = { ...opts, resumeSessionId: err.sessionId };
                }
                else {
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
async function runPlannerQueryOnce(prompt, opts, onLog) {
    _plannerRateLimitInfo = { utilization: 0, status: "", isUsingOverage: false, windows: new Map(), costUsd: 0, contextTokens: 0, model: opts.model };
    let resultText = "";
    let structuredOutput;
    const startedAt = Date.now();
    const isResume = !!opts.resumeSessionId;
    const envOverride = opts.env ?? _envResolver?.(opts.model);
    const tname = opts.transcriptName;
    if (tname) {
        writeTranscriptEvent(tname, {
            kind: "session_start",
            model: opts.model,
            isResume,
            resumeSessionId: opts.resumeSessionId,
            promptPreview: prompt.slice(0, 2000),
            promptBytes: prompt.length,
        });
    }
    const pq = query({
        prompt,
        options: {
            cwd: opts.cwd,
            model: opts.model,
            tools: opts.tools ?? DEFAULT_TOOLS,
            allowedTools: opts.tools ?? DEFAULT_TOOLS,
            permissionMode: opts.permissionMode,
            ...(opts.permissionMode === "bypassPermissions" && { allowDangerouslySkipPermissions: true }),
            persistSession: true,
            includePartialMessages: true,
            maxTurns: opts.maxTurns ?? DEFAULT_MAX_TURNS,
            ...(isResume && { resume: opts.resumeSessionId }),
            ...(opts.outputFormat && { outputFormat: opts.outputFormat }),
            ...(envOverride && { env: envOverride }),
        },
    });
    // Default to "thinking…" so the ticker conveys meaning during the pre-output
    // reasoning phase. Thinking-variant models (e.g. claude-opus-4-7-thinking-*)
    // can sit silent for 60-90s before emitting any tokens, and cursor-agent
    // doesn't forward thinking deltas — without this, the ticker reads "4m 5s"
    // with nothing else for a minute plus.
    let lastLogText = "thinking…";
    let toolCount = 0;
    let costUsd = 0;
    const jsonOutput = opts.outputFormat?.type === "json_schema";
    let jsonCharCount = 0;
    // Dedup identical text snippets: cursor-agent with json_schema-ignoring
    // proxies causes the SDK to loop multiple turns, each re-emitting the same
    // final JSON. We don't want to spam the ticker or transcript with it.
    let lastTextSeen = "";
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
    let sessionId;
    let lastActivity = Date.now();
    let timer;
    const watchdog = new Promise((_, reject) => {
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
                if (isResume)
                    reject(new Error(`Planner silent for ${Math.round(silent / 1000)}s  -- assumed hung`));
                else
                    reject(new NudgeError(sessionId, silent));
            }
            else {
                timer = setTimeout(check, Math.min(30_000, timeoutMs - silent + 1000));
            }
        };
        timer = setTimeout(check, timeoutMs);
    });
    // Tool-use blocks can arrive in two shapes:
    //  (a) content_block_start carries the full `input` (native Anthropic non-partial)
    //  (b) content_block_start carries `input: {}` and the JSON is streamed via
    //      input_json_delta frames (Anthropic streaming spec, cursor-composer-in-claude v0.9+).
    // Track the open tool block so we can re-log with the enriched target once
    // the input arrives, and write a complete transcript entry on block stop.
    let pendingTool = null;
    // Dedup tool_use logging between stream_event path and full-assistant-message
    // path. The Cursor proxy doesn't always relay content_block_* frames through
    // the Claude CLI's stream-json, so we also mine complete `SDKAssistantMessage`
    // content for progress  -- without double-counting when both paths fire.
    const seenToolIds = new Set();
    const logTool = (name, input) => {
        const target = extractToolTarget(input);
        lastLogText = target ? `${name} ${target}` : name;
        onLog(target ? `${name} → ${target}` : name, "event");
    };
    const consume = async () => {
        for await (const msg of pq) {
            lastActivity = Date.now();
            if (!sessionId && "session_id" in msg)
                sessionId = msg.session_id;
            if (msg.type === "stream_event") {
                const ev = msg.event;
                if (ev?.type === "content_block_start") {
                    const cb = ev.content_block;
                    if (cb?.type === "tool_use") {
                        toolCount++;
                        const input = (cb.input ?? {});
                        const hasInput = Object.keys(input).length > 0;
                        if (cb.id)
                            seenToolIds.add(cb.id);
                        pendingTool = {
                            index: ev.index ?? 0,
                            name: cb.name,
                            id: cb.id,
                            input,
                            buf: "",
                            logged: hasInput,
                        };
                        if (hasInput) {
                            logTool(cb.name, input);
                            if (tname)
                                writeTranscriptEvent(tname, { kind: "tool_use", tool: cb.name, input });
                        }
                    }
                    else if (cb?.type === "thinking" || cb?.type === "redacted_thinking") {
                        lastLogText = "thinking…";
                        if (tname)
                            writeTranscriptEvent(tname, { kind: "thinking_start" });
                    }
                }
                if (ev?.type === "content_block_delta") {
                    const delta = ev.delta;
                    if (delta?.type === "input_json_delta" && pendingTool && typeof delta.partial_json === "string") {
                        pendingTool.buf += delta.partial_json;
                        continue;
                    }
                    // thinking_delta carries reasoning text under `delta.thinking`;
                    // text_delta carries final-answer text under `delta.text`.
                    const raw = delta?.type === "text_delta" ? delta.text
                        : delta?.type === "thinking_delta" ? delta.thinking
                            : undefined;
                    if (typeof raw === "string" && raw) {
                        if (jsonOutput && delta.type === "text_delta") {
                            // Don't surface tail-of-JSON as "progress" — it reads as noise
                            // like `…ppression and optimistic-update rollback`. Show size
                            // growing instead, which is a genuine signal.
                            jsonCharCount += raw.length;
                            lastLogText = `writing JSON (${jsonCharCount} chars)…`;
                        }
                        else {
                            const snippet = raw.trim().replace(/[{}"\\,[\]]+/g, " ").replace(/\s+/g, " ").trim();
                            if (snippet.length > 5)
                                lastLogText = snippet.slice(-60);
                        }
                        if (tname)
                            writeTranscriptEvent(tname, { kind: delta.type, text: raw });
                    }
                }
                if (ev?.type === "content_block_stop" && pendingTool) {
                    if (!pendingTool.logged && pendingTool.buf) {
                        try {
                            pendingTool.input = JSON.parse(pendingTool.buf);
                        }
                        catch { }
                    }
                    if (!pendingTool.logged) {
                        logTool(pendingTool.name, pendingTool.input);
                        if (tname)
                            writeTranscriptEvent(tname, { kind: "tool_use", tool: pendingTool.name, input: pendingTool.input });
                    }
                    pendingTool = null;
                }
            }
            // Fallback progress surfacing: when stream events are sparse (e.g. the
            // Cursor proxy's heartbeat thinking block doesn't always round-trip
            // through the Claude CLI as partial messages), mine the full assistant
            // turn message for tool_use / thinking / text so the ticker still moves
            // every ~6-15s instead of sitting silent for minutes.
            if (msg.type === "assistant") {
                const u = msg.message?.usage;
                if (u) {
                    const turnTotal = sumUsageTokens(u);
                    _plannerRateLimitInfo.contextTokens = turnTotal;
                    if (turnTotal > _peakPlannerContextTokens) {
                        _peakPlannerContextTokens = turnTotal;
                        _peakPlannerContextModel = opts.model;
                    }
                    if (opts.turnId) {
                        const turn = getTurn(opts.turnId);
                        if (turn) {
                            updateTurn(turn, {
                                contextTokens: turnTotal,
                                peakContextTokens: Math.max(turn.peakContextTokens ?? 0, turnTotal),
                                costUsd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : undefined,
                            });
                        }
                    }
                }
                const content = msg.message?.content;
                if (Array.isArray(content)) {
                    for (const part of content) {
                        if (part?.type === "tool_use" && part.id && !seenToolIds.has(part.id)) {
                            seenToolIds.add(part.id);
                            toolCount++;
                            const input = (part.input ?? {});
                            logTool(part.name, input);
                            if (tname)
                                writeTranscriptEvent(tname, { kind: "tool_use", tool: part.name, input });
                        }
                        else if (part?.type === "thinking" && typeof part.thinking === "string" && part.thinking) {
                            const snippet = part.thinking.trim().replace(/\s+/g, " ").slice(-60);
                            if (snippet)
                                lastLogText = snippet;
                            if (tname)
                                writeTranscriptEvent(tname, { kind: "thinking", text: part.thinking });
                        }
                        else if (part?.type === "text" && typeof part.text === "string" && part.text) {
                            if (part.text === lastTextSeen)
                                continue; // dedup repeated turns
                            lastTextSeen = part.text;
                            if (jsonOutput) {
                                lastLogText = `writing JSON (${part.text.length} chars)…`;
                            }
                            else {
                                const snippet = part.text.trim().replace(/[{}"\\,[\]]+/g, " ").replace(/\s+/g, " ").slice(-60);
                                if (snippet.length > 5)
                                    lastLogText = snippet;
                            }
                            if (tname)
                                writeTranscriptEvent(tname, { kind: "text", text: part.text });
                        }
                    }
                }
            }
            if (msg.type === "rate_limit_event") {
                const info = msg.rate_limit_info;
                if (info) {
                    _plannerRateLimitInfo.utilization = info.utilization ?? 0;
                    _plannerRateLimitInfo.status = info.status ?? "";
                    if (info.isUsingOverage)
                        _plannerRateLimitInfo.isUsingOverage = true;
                    if (info.resetsAt)
                        _plannerRateLimitInfo.resetsAt = info.resetsAt;
                    if (info.rateLimitType) {
                        _plannerRateLimitInfo.windows.set(info.rateLimitType, {
                            type: info.rateLimitType,
                            utilization: info.utilization ?? 0,
                            status: info.status,
                            resetsAt: info.resetsAt,
                        });
                    }
                    if (tname)
                        writeTranscriptEvent(tname, {
                            kind: "rate_limit",
                            utilization: info.utilization ?? 0,
                            status: info.status,
                            rateLimitType: info.rateLimitType,
                            resetsAt: info.resetsAt,
                            isUsingOverage: !!info.isUsingOverage,
                        });
                }
            }
            if (msg.type === "result") {
                const r = msg;
                if (typeof r.total_cost_usd === "number") {
                    costUsd = r.total_cost_usd;
                    _plannerRateLimitInfo.costUsd += costUsd;
                    _totalPlannerCostUsd += costUsd;
                    if (opts.turnId) {
                        const turn = getTurn(opts.turnId);
                        if (turn)
                            updateTurn(turn, { costUsd: (turn.costUsd ?? 0) + costUsd });
                    }
                }
                if (msg.subtype === "success") {
                    structuredOutput = r.structured_output;
                    resultText = r.result || "";
                    if (tname)
                        writeTranscriptEvent(tname, {
                            kind: "result",
                            subtype: "success",
                            costUsd,
                            durationMs: Date.now() - startedAt,
                            toolCount,
                            resultPreview: typeof resultText === "string" ? resultText.slice(0, 4000) : undefined,
                            hasStructuredOutput: structuredOutput != null,
                        });
                }
                else {
                    if (tname)
                        writeTranscriptEvent(tname, {
                            kind: "result",
                            subtype: msg.subtype,
                            costUsd,
                            durationMs: Date.now() - startedAt,
                            toolCount,
                            error: r.result,
                        });
                    throw new Error(`Planner failed: ${r.result || msg.subtype}`);
                }
            }
        }
    };
    try {
        await Promise.race([consume(), watchdog]);
    }
    catch (err) {
        if (tname)
            writeTranscriptEvent(tname, {
                kind: "error",
                message: err instanceof Error ? err.message : String(err),
                durationMs: Date.now() - startedAt,
                toolCount,
            });
        throw err;
    }
    finally {
        clearTimeout(timer);
        clearInterval(ticker);
    }
    if (structuredOutput != null && typeof structuredOutput === "object")
        return JSON.stringify(structuredOutput);
    return resultText;
}
// ── Post-processing ──
export function postProcess(raw, budget, onLog) {
    let tasks = raw;
    const before = tasks.length;
    tasks = tasks.filter((t) => t.prompt && t.prompt.trim().length >= 1);
    if (tasks.length < before)
        onLog(`Filtered ${before - tasks.length} task(s) with empty prompt`);
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
    if (readOnly > 0)
        onLog(`${readOnly} read-only task(s) marked noWorktree`);
    const dominated = new Set();
    for (let i = 0; i < tasks.length; i++) {
        if (dominated.has(i))
            continue;
        const setA = new Set(tasks[i].prompt.toLowerCase().split(/\s+/));
        for (let j = i + 1; j < tasks.length; j++) {
            if (dominated.has(j))
                continue;
            const setB = new Set(tasks[j].prompt.toLowerCase().split(/\s+/));
            const shared = [...setA].filter((w) => setB.has(w)).length;
            const overlap = shared / Math.max(setA.size, setB.size);
            if (overlap > 0.8) {
                const drop = setA.size >= setB.size ? j : i;
                dominated.add(drop);
                if (drop === i)
                    break;
            }
        }
    }
    if (dominated.size) {
        tasks = tasks.filter((_, i) => !dominated.has(i));
        onLog(`Deduplicated to ${tasks.length} tasks`);
    }
    // File-path overlap: merge tasks targeting the same file to prevent
    // concurrent edits causing merge conflicts. Only applies to execute tasks.
    if ((budget ?? 10) <= 15) {
        const fileRe = /(?:^|\s)((?:[\w.-]+\/)+[\w.-]+\.\w+)/g;
        // Build adjacency: two tasks conflict if they share a file path.
        const adj = new Map();
        for (let i = 0; i < tasks.length; i++)
            adj.set(i, new Set());
        const pathToIndices = new Map();
        for (let i = 0; i < tasks.length; i++) {
            const t = tasks[i];
            if (t.type && t.type !== "execute")
                continue;
            for (const m of t.prompt.matchAll(fileRe)) {
                const indices = pathToIndices.get(m[1]);
                if (indices) {
                    for (const j of indices) {
                        adj.get(i).add(j);
                        adj.get(j).add(i);
                    }
                    indices.push(i);
                }
                else {
                    pathToIndices.set(m[1], [i]);
                }
            }
        }
        // Find connected components of size > 1 and merge each.
        const visited = new Set();
        let totalMerged = 0;
        for (let i = 0; i < tasks.length; i++) {
            if (visited.has(i) || adj.get(i).size === 0)
                continue;
            const component = [];
            const stack = [i];
            while (stack.length > 0) {
                const curr = stack.pop();
                if (visited.has(curr))
                    continue;
                visited.add(curr);
                component.push(curr);
                for (const nb of adj.get(curr))
                    if (!visited.has(nb))
                        stack.push(nb);
            }
            if (component.length > 1) {
                const prompts = component.map((idx) => tasks[idx].prompt);
                const merged = { ...tasks[component[0]], id: tasks[component[0]].id, prompt: prompts.join("\n\nAlso: ") };
                // Remove overlapping tasks (highest indices first to preserve positions)
                component.sort((a, b) => b - a);
                for (const idx of component.slice(1))
                    tasks.splice(idx, 1);
                tasks[component[0]] = merged;
                totalMerged += component.length - 1;
            }
        }
        if (totalMerged > 0)
            onLog(`Merged ${totalMerged} overlapping task(s) into combined tasks`);
    }
    const cap = budget ? Math.ceil(budget * 1.2) : 30;
    if (tasks.length > cap) {
        onLog(`Truncating ${tasks.length} → ${cap}`);
        tasks = tasks.slice(0, cap);
    }
    tasks.sort((a, b) => Number(/\btest/i.test(a.prompt)) - Number(/\btest/i.test(b.prompt)));
    return tasks.map((t, i) => ({ ...t, id: String(i) }));
}
// ── JSON parsing utilities ──
function extractOutermostBraces(text) {
    const start = text.indexOf("{");
    if (start === -1)
        return null;
    let depth = 0;
    for (let i = start; i < text.length; i++) {
        if (text[i] === "{")
            depth++;
        else if (text[i] === "}")
            depth--;
        if (depth === 0)
            return text.slice(start, i + 1);
    }
    return null;
}
export function attemptJsonParse(text) {
    try {
        const obj = JSON.parse(text);
        if (typeof obj === "object" && obj !== null)
            return obj;
    }
    catch { }
    const braces = extractOutermostBraces(text);
    if (braces) {
        try {
            const obj = JSON.parse(braces);
            if (typeof obj === "object" && obj !== null)
                return obj;
        }
        catch { }
    }
    const stripped = text.replace(/```json?\s*/g, "").replace(/```/g, "").trim();
    if (stripped !== text) {
        try {
            const obj = JSON.parse(stripped);
            if (typeof obj === "object" && obj !== null)
                return obj;
        }
        catch { }
        const b2 = extractOutermostBraces(stripped);
        if (b2) {
            try {
                return JSON.parse(b2);
            }
            catch { }
        }
    }
    const tasksMatch = text.match(/\{\s*"tasks"\s*:\s*\[/);
    if (tasksMatch) {
        const lastBrace = text.lastIndexOf("}");
        if (lastBrace > tasksMatch.index) {
            const salvaged = text.slice(tasksMatch.index, lastBrace + 1) + "]}";
            try {
                const obj = JSON.parse(salvaged);
                if (obj?.tasks?.length > 0)
                    return obj;
            }
            catch { }
        }
    }
    return null;
}
export async function extractTaskJson(raw, retry, onLog, outFile) {
    if (outFile) {
        try {
            const fromFile = attemptJsonParse(readFileSync(outFile, "utf-8"));
            if (fromFile?.tasks)
                return fromFile;
        }
        catch { }
    }
    const first = attemptJsonParse(raw);
    if (first?.tasks)
        return first;
    onLog?.(`Parse failed (${raw.length} chars): ${raw.slice(0, 300)}`);
    const retryText = await retry();
    if (outFile) {
        try {
            const fromFile = attemptJsonParse(readFileSync(outFile, "utf-8"));
            if (fromFile?.tasks)
                return fromFile;
        }
        catch { }
    }
    const second = attemptJsonParse(retryText);
    if (second?.tasks)
        return second;
    onLog?.(`Retry failed (${retryText.length} chars): ${retryText.slice(0, 300)}`);
    throw new Error("Planner did not return valid task JSON after retry");
}
