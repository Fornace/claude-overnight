// SDK streaming consumer for the planner.
//
// Reads the @anthropic-ai/claude-agent-sdk `query()` async generator,
// surfaces progress to the UI, persists transcript events, applies
// rate-limit info to the shared throttle state, and returns the final
// result text (preferring `structured_output` when present).
//
// Watchdogs: a NUDGE / HARD timer for silent streams + a separate
// `runWithStallRotation` byte-level guard. Both raise from the same
// Promise.race so cleanup runs in `finally`.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { NudgeError, extractToolTarget, sumUsageTokens } from "../core/types.js";
import { writeTranscriptEvent } from "../core/transcripts.js";
import { getTurn, updateTurn } from "../core/turns.js";
import { addPlannerCost, recordPeakContext, setContextTokens, applyRateLimitEvent, getPlannerRateLimitInfo, } from "./throttle.js";
import { sdkQueryRateLimiter, acquireSdkQueryRateLimit } from "../core/rate-limiter.js";
import { StallGuard, runWithStallRotation, StallMonitor } from "../core/stall-guard.js";
import { writeCandidate } from "../skills/scribe.js";
import { buildL0Stub, buildRecipeStub } from "../skills/injection.js";
const DEFAULT_TOOLS = ["Read", "Glob", "Grep", "Write", "Bash", "WebFetch", "WebSearch", "TodoWrite", "Agent"];
const DEFAULT_MAX_TURNS = 20;
const NUDGE_MS = 15 * 60 * 1000;
const HARD_TIMEOUT_MS = 30 * 60 * 1000;
const WALL_CLOCK_LIMIT_MS = 45 * 60 * 1000;
/** Driver wrapping `runOneStream` with stall-rotation + transcript framing. */
export async function runPlannerStreamWithRotation(prompt, opts, onLog, initialEnv, isResume, tname) {
    const startedAt = Date.now();
    if (tname)
        writeTranscriptEvent(tname, {
            kind: "session_start", model: opts.model, isResume,
            resumeSessionId: opts.resumeSessionId,
            promptPreview: prompt.slice(0, 2000), promptBytes: prompt.length,
        });
    let resultText = "";
    await runWithStallRotation({
        initialPrompt: prompt, initialIsResume: isResume, initialEnv,
        resolveFallbackEnv: () => StallMonitor.instance.getFallbackEnv(opts.model),
        log: (text) => onLog(text, "event"),
        run: async (resumeFlag, promptText, env) => {
            resultText = await runOneStream(promptText, opts, onLog, env, resumeFlag, startedAt, tname);
        },
    });
    return resultText;
}
/** Single SDK streaming session. Caller wraps with retry/throttle/stall-rotation. */
async function runOneStream(prompt, opts, onLog, envOverride, isResume, startedAt, tname) {
    // Prepend L0 + recipe skill stubs when a fingerprint is available.
    let finalPrompt = prompt;
    if (opts.repoFingerprint) {
        const stub = buildL0Stub({ fingerprint: opts.repoFingerprint, role: opts.plannerRole, tools: opts.tools });
        if (stub.text)
            finalPrompt = stub.text + "\n\n" + finalPrompt;
        const recipeStub = buildRecipeStub({ fingerprint: opts.repoFingerprint, tools: opts.tools });
        if (recipeStub)
            finalPrompt = recipeStub.text + "\n\n" + finalPrompt;
    }
    const rl = sdkQueryRateLimiter;
    await acquireSdkQueryRateLimit();
    const pq = query({
        prompt: finalPrompt,
        options: {
            cwd: opts.cwd, model: opts.model,
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
    let resultText = "";
    let structuredOutput;
    let sessionId;
    let lastActivity = Date.now();
    let msgCount = 0;
    let toolCount = 0;
    let costUsd = 0;
    let jsonCharCount = 0;
    // Default so the ticker shows meaning during pre-output reasoning;
    // thinking models can sit silent 60-90s without forwarding deltas.
    let lastLogText = "thinking…";
    // Dedup identical text: cursor-agent with json_schema-ignoring proxies loops same JSON.
    let lastTextSeen = "";
    // Dedup tool_use between stream_event and full-assistant-message paths.
    const seenToolIds = new Set();
    let pendingTool = null;
    const isJsonOutput = opts.outputFormat?.type === "json_schema";
    const logTool = (name, input) => {
        const target = extractToolTarget(input);
        lastLogText = target ? `${name} ${target}` : name;
        onLog(target ? `${name} → ${target}` : name, "event");
    };
    const ticker = setInterval(() => {
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        const m = Math.floor(elapsed / 60);
        const timeStr = m > 0 ? `${m}m ${elapsed % 60}s` : `${elapsed}s`;
        const toolStr = toolCount > 0 ? ` · ${toolCount} tools` : "";
        const costStr = costUsd > 0 ? ` · $${costUsd.toFixed(3)}` : "";
        const rlPct = getPlannerRateLimitInfo().utilization;
        const rlStr = rlPct > 0 ? ` · ${Math.round(rlPct * 100)}%` : "";
        // msg count distinguishes "model thinking silently" from "proxy/network stuck".
        const msgStr = ` · ${msgCount} msg${msgCount === 1 ? "" : "s"}`;
        const extra = lastLogText ? ` · ${lastLogText}` : "";
        onLog(`${timeStr}${toolStr}${costStr}${rlStr}${msgStr}${extra}`, "status");
    }, 500);
    const stallSink = { lastByteAt: Date.now(), streamId: "", finished: false };
    const stallGuard = new StallGuard(stallSink, new AbortController());
    const stallPromise = new Promise((_, reject) => { stallGuard.on("stall", reject); });
    const timeoutMs = isResume ? HARD_TIMEOUT_MS : NUDGE_MS;
    let watchdogTimer;
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
                watchdogTimer = setTimeout(check, Math.min(30_000, timeoutMs - silent + 1000));
            }
        };
        watchdogTimer = setTimeout(check, timeoutMs);
    });
    const handleStreamEvent = (msg) => {
        const ev = msg.event;
        if (ev.type === "content_block_start") {
            const cb = ev.content_block;
            if (cb?.type === "tool_use") {
                toolCount++;
                const input = (cb.input ?? {});
                const hasInput = Object.keys(input).length > 0;
                if (cb.id)
                    seenToolIds.add(cb.id);
                pendingTool = { name: cb.name, id: cb.id, input, buf: "", logged: hasInput };
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
            return;
        }
        if (ev.type === "content_block_delta") {
            const delta = ev.delta;
            if (!delta)
                return;
            if (delta.type === "input_json_delta" && pendingTool) {
                pendingTool.buf += delta.partial_json;
                return;
            }
            const raw = delta.type === "text_delta" ? delta.text
                : delta.type === "thinking_delta" ? delta.thinking
                    : undefined;
            if (typeof raw === "string" && raw) {
                if (isJsonOutput && delta.type === "text_delta") {
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
            return;
        }
        if (ev.type === "content_block_stop" && pendingTool) {
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
    };
    // Fallback progress surfacing: when stream events are sparse, mine full
    // assistant turn messages for tool_use / thinking / text.
    const handleAssistant = (msg) => {
        const usage = msg.message?.usage;
        if (usage) {
            const turnTotal = sumUsageTokens(usage);
            setContextTokens(turnTotal);
            recordPeakContext(turnTotal, opts.model);
            if (opts.turnId) {
                const turn = getTurn(opts.turnId);
                if (turn) {
                    const totalCost = msg.total_cost_usd;
                    updateTurn(turn, {
                        contextTokens: turnTotal,
                        peakContextTokens: Math.max(turn.peakContextTokens ?? 0, turnTotal),
                        costUsd: typeof totalCost === "number" ? totalCost : undefined,
                    });
                }
            }
        }
        const content = msg.message?.content;
        if (!Array.isArray(content))
            return;
        // Iterate as untyped parts: BetaContentBlock is a discriminated union we
        // narrow at runtime via `part.type`; reaching for typed access pulls in
        // a transitive Anthropic SDK type and isn't worth the coupling.
        for (const part of content) {
            const t = part.type;
            if (t === "tool_use" && typeof part.id === "string" && !seenToolIds.has(part.id)) {
                seenToolIds.add(part.id);
                toolCount++;
                const input = (part.input ?? {});
                const name = String(part.name ?? "");
                logTool(name, input);
                if (tname)
                    writeTranscriptEvent(tname, { kind: "tool_use", tool: name, input });
            }
            else if (t === "thinking" && typeof part.thinking === "string" && part.thinking) {
                const snippet = part.thinking.trim().replace(/\s+/g, " ").slice(-60);
                if (snippet)
                    lastLogText = snippet;
                if (tname)
                    writeTranscriptEvent(tname, { kind: "thinking", text: part.thinking });
            }
            else if (t === "text" && typeof part.text === "string" && part.text) {
                if (part.text === lastTextSeen)
                    continue;
                lastTextSeen = part.text;
                if (isJsonOutput) {
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
    };
    const handleRateLimit = (msg) => {
        const info = msg.rate_limit_info;
        if (!info)
            return;
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
    };
    const handleResult = (msg) => {
        if (typeof msg.total_cost_usd === "number") {
            costUsd = msg.total_cost_usd;
            addPlannerCost(costUsd);
            if (opts.turnId) {
                const turn = getTurn(opts.turnId);
                if (turn)
                    updateTurn(turn, { costUsd: (turn.costUsd ?? 0) + costUsd });
            }
        }
        if (msg.subtype === "success") {
            structuredOutput = msg.structured_output;
            resultText = msg.result || "";
            if (tname)
                writeTranscriptEvent(tname, {
                    kind: "result", subtype: "success",
                    costUsd, durationMs: Date.now() - startedAt, toolCount,
                    resultPreview: typeof resultText === "string" ? resultText.slice(0, 4000) : undefined,
                    hasStructuredOutput: structuredOutput != null,
                });
            return;
        }
        if (tname)
            writeTranscriptEvent(tname, {
                kind: "result", subtype: msg.subtype,
                costUsd, durationMs: Date.now() - startedAt, toolCount,
                error: msg.errors?.join("; "),
            });
        throw new Error(`Planner failed: ${msg.subtype}`);
    };
    const consume = async () => {
        for await (const msg of pq) {
            lastActivity = Date.now();
            stallSink.lastByteAt = Date.now();
            msgCount++;
            if (!sessionId && "session_id" in msg)
                sessionId = msg.session_id;
            switch (msg.type) {
                case "stream_event":
                    handleStreamEvent(msg);
                    break;
                case "assistant":
                    handleAssistant(msg);
                    break;
                case "rate_limit_event":
                    handleRateLimit(msg);
                    break;
                case "result":
                    handleResult(msg);
                    break;
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
                durationMs: Date.now() - startedAt, toolCount,
            });
        throw err;
    }
    finally {
        stallSink.finished = true;
        stallGuard.stop();
        if (watchdogTimer)
            clearTimeout(watchdogTimer);
        clearInterval(ticker);
        rl.record();
    }
    // Skill scribe: planner/steerer/verifier may emit heuristic candidates.
    if (opts.repoFingerprint && opts.runId && resultText) {
        const proposal = extractSkillProposal(resultText);
        if (proposal) {
            writeCandidate({
                kind: "skill", proposedBy: opts.plannerRole ?? "planner", wave: 0,
                runId: opts.runId, fingerprint: opts.repoFingerprint,
                trigger: proposal.trigger, body: proposal.body,
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
