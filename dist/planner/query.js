import { query } from "@anthropic-ai/claude-agent-sdk";
import { NudgeError, extractToolTarget, sumUsageTokens } from "../core/types.js";
import { writeTranscriptEvent } from "../core/transcripts.js";
import { getTurn, updateTurn } from "../core/turns.js";
import { isRateLimitError, throttlePlanner, addPlannerCost, recordPeakContext, resetPlannerRateLimit, setContextTokens, applyRateLimitEvent, getPlannerRateLimitInfo, } from "./throttle.js";
import { cursorProxyRateLimiter, sdkQueryRateLimiter, apiEndpointLimiter, acquireSdkQueryRateLimit } from "../core/rate-limiter.js";
import { sleep } from "../swarm/errors.js";
import { StallGuard, runWithStallRotation, StallMonitor } from "../core/stall-guard.js";
import { writeCandidate } from "../skills/scribe.js";
import { buildL0Stub, buildRecipeStub } from "../skills/injection.js";
export { getTotalPlannerCost, getPeakPlannerContext, getPlannerRateLimitInfo, } from "./throttle.js";
export { attemptJsonParse, extractTaskJson } from "./json.js";
export { postProcess } from "./postprocess.js";
const DEFAULT_TOOLS = ["Read", "Glob", "Grep", "Write", "Bash", "WebFetch", "WebSearch", "TodoWrite", "Agent"];
const DEFAULT_MAX_TURNS = 20;
const NUDGE_MS = 15 * 60 * 1000;
const HARD_TIMEOUT_MS = 30 * 60 * 1000;
const WALL_CLOCK_LIMIT_MS = 45 * 60 * 1000;
// Shared env resolver — set once at run start, used by every planner query.
let _envResolver;
export function setPlannerEnvResolver(fn) {
    _envResolver = fn;
}
// ── Cursor proxy: direct HTTP bypass ──
// SDK spawns 4+ subprocesses (~15s each) for the proxy; one direct POST is 4-10x faster.
function isCursorProxyEnv(env) {
    return !!env?.CURSOR_API_KEY && !env?.ANTHROPIC_API_KEY;
}
async function runViaDirectFetch(prompt, opts, onLog) {
    const env = opts.env ?? _envResolver?.(opts.model);
    const baseUrl = (env?.ANTHROPIC_BASE_URL ?? "http://127.0.0.1:8765").replace(/\/$/, "");
    const authToken = env?.ANTHROPIC_AUTH_TOKEN ?? "";
    const MAX_RETRIES = 3;
    const BACKOFF = [30_000, 60_000, 120_000];
    const rl = cursorProxyRateLimiter;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        // Wait out both budgets — the retry loop catches HTTP 429s but not our own
        // RateLimitError, so hard-asserting would abort the whole fetch path.
        await apiEndpointLimiter.waitIfNeeded();
        const waited = await rl.waitIfNeeded();
        if (waited > 0)
            onLog(`Cursor proxy rate gate — waited ${Math.round(waited / 1000)}s`, "event");
        const res = await fetch(`${baseUrl}/v1/messages`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${authToken}` },
            body: JSON.stringify({ model: opts.model, max_tokens: 8192, messages: [{ role: "user", content: prompt }] }),
        });
        if (res.status === 429 && attempt < MAX_RETRIES) {
            const waitMs = BACKOFF[attempt];
            onLog(`Cursor proxy rate limited — waiting ${Math.round(waitMs / 1000)}s`, "event");
            await sleep(waitMs);
            continue;
        }
        if (!res.ok)
            throw new Error(`Cursor proxy ${res.status}: ${(await res.text().catch(() => ""))}`);
        rl.record();
        apiEndpointLimiter.record();
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
                await sleep(waitMs);
                continue;
            }
            throw err;
        }
    }
    aborted = true;
    throw new Error("Planner query failed after retries");
}
async function runPlannerQueryOnce(prompt, opts, onLog) {
    resetPlannerRateLimit(opts.model);
    const rl = sdkQueryRateLimiter;
    const startedAt = Date.now();
    const isResume = !!opts.resumeSessionId;
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
    let resultText = "";
    await runWithStallRotation({
        initialPrompt: prompt,
        initialIsResume: isResume,
        initialEnv: opts.env ?? _envResolver?.(opts.model),
        resolveFallbackEnv: () => StallMonitor.instance.getFallbackEnv(opts.model),
        log: (text) => onLog(text, "event"),
        run: async (isResume, promptText, env) => {
            resultText = await runPlannerStream(promptText, opts, onLog, env, isResume, startedAt, tname, rl);
        },
    });
    return resultText;
}
async function runPlannerStream(prompt, opts, onLog, envOverride, isResume, startedAt, tname, rl) {
    let resultText = "";
    let structuredOutput;
    // Prepend L0 skill stub if fingerprint is available
    let finalPrompt = prompt;
    if (opts.repoFingerprint) {
        const stub = buildL0Stub({ fingerprint: opts.repoFingerprint, role: opts.plannerRole, tools: opts.tools });
        if (stub.text)
            finalPrompt = stub.text + "\n\n" + prompt;
        const recipeStub = buildRecipeStub({ fingerprint: opts.repoFingerprint, tools: opts.tools });
        if (recipeStub)
            finalPrompt = recipeStub.text + "\n\n" + finalPrompt;
    }
    await acquireSdkQueryRateLimit();
    const pq = query({
        prompt: finalPrompt,
        options: {
            cwd: opts.cwd,
            model: opts.model,
            tools: opts.tools ?? DEFAULT_TOOLS,
            allowedTools: opts.tools ?? DEFAULT_TOOLS,
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            persistSession: true,
            includePartialMessages: true,
            maxTurns: opts.maxTurns ?? DEFAULT_MAX_TURNS,
            ...(isResume && opts.resumeSessionId && { resume: opts.resumeSessionId }),
            ...(opts.outputFormat && { outputFormat: opts.outputFormat }),
            ...(envOverride && { env: envOverride }),
        },
    });
    // "thinking…" default so ticker shows meaning during pre-output reasoning.
    // Thinking models can sit silent 60-90s; cursor-agent doesn't forward thinking deltas.
    let lastLogText = "thinking…";
    let toolCount = 0;
    let costUsd = 0;
    let msgCount = 0;
    const jsonOutput = opts.outputFormat?.type === "json_schema";
    let jsonCharCount = 0;
    // Dedup identical text: cursor-agent with json_schema-ignoring proxies loops same JSON.
    let lastTextSeen = "";
    const ticker = setInterval(() => {
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        const m = Math.floor(elapsed / 60);
        const s = elapsed % 60;
        const timeStr = m > 0 ? `${m}m ${s}s` : `${s}s`;
        const toolStr = toolCount > 0 ? ` · ${toolCount} tools` : "";
        const costStr = costUsd > 0 ? ` · $${costUsd.toFixed(3)}` : "";
        const rlPct = getPlannerRateLimitInfo().utilization;
        const rlStr = rlPct > 0 ? ` · ${Math.round(rlPct * 100)}%` : "";
        // msg count distinguishes "model thinking silently" from "proxy/network stuck".
        const msgStr = ` · ${msgCount} msg${msgCount === 1 ? "" : "s"}`;
        const extra = lastLogText ? ` · ${lastLogText}` : "";
        onLog(`${timeStr}${toolStr}${costStr}${rlStr}${msgStr}${extra}`, "status");
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
    const stallSink = {
        lastByteAt: Date.now(),
        streamId: "",
        finished: false,
    };
    const stallGuard = new StallGuard(stallSink, new AbortController());
    const stallPromise = new Promise((_, reject) => {
        stallGuard.on("stall", (err) => reject(err));
    });
    let pendingTool = null;
    // Dedup tool_use between stream_event and full-assistant-message paths.
    const seenToolIds = new Set();
    const logTool = (name, input) => {
        const target = extractToolTarget(input);
        lastLogText = target ? `${name} ${target}` : name;
        onLog(target ? `${name} → ${target}` : name, "event");
    };
    const consume = async () => {
        for await (const msg of pq) {
            lastActivity = Date.now();
            stallSink.lastByteAt = Date.now();
            msgCount++;
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
                    const raw = delta?.type === "text_delta" ? delta.text
                        : delta?.type === "thinking_delta" ? delta.thinking
                            : undefined;
                    if (typeof raw === "string" && raw) {
                        if (jsonOutput && delta.type === "text_delta") {
                            // Don't surface tail-of-JSON as "progress" — it reads as noise.
                            // Show size growing instead, which is a genuine signal.
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
            // Fallback progress surfacing: when stream events are sparse, mine full
            // assistant turn messages for tool_use / thinking / text.
            if (msg.type === "assistant") {
                const u = msg.message?.usage;
                if (u) {
                    const turnTotal = sumUsageTokens(u);
                    setContextTokens(turnTotal);
                    recordPeakContext(turnTotal, opts.model);
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
                                continue;
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
                    applyRateLimitEvent(info);
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
                    addPlannerCost(costUsd);
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
        await Promise.race([consume(), watchdog, stallPromise]);
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
        stallSink.finished = true;
        stallGuard.stop();
        clearTimeout(timer);
        clearInterval(ticker);
        rl.record();
    }
    // Skill scribe: planner/steerer/verifier may emit heuristic candidates.
    if (opts.repoFingerprint && opts.runId && resultText) {
        const proposal = extractSkillProposal(resultText);
        if (proposal) {
            writeCandidate({
                kind: "skill",
                proposedBy: opts.plannerRole ?? "planner",
                wave: 0,
                runId: opts.runId,
                fingerprint: opts.repoFingerprint,
                trigger: proposal.trigger,
                body: proposal.body,
            });
        }
    }
    if (structuredOutput != null && typeof structuredOutput === "object")
        return JSON.stringify(structuredOutput);
    return resultText;
}
/** Extract a ### SKILL CANDIDATE block from planner text. Returns undefined if not found. */
function extractSkillProposal(text) {
    const m = text.match(/###\s*SKILL CANDIDATE\s*\n([\s\S]+?)$/);
    if (!m)
        return undefined;
    const block = m[1].trim();
    const triggerM = block.match(/^trigger:\s*(.+)$/m);
    if (!triggerM)
        return undefined;
    const trigger = triggerM[1].trim().slice(0, 120);
    const bodyStart = block.indexOf("\nbody:");
    if (bodyStart < 0)
        return undefined;
    const body = block.slice(bodyStart + 6).trim();
    if (!body)
        return undefined;
    return { trigger, body };
}
