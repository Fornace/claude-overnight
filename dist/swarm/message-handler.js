// SDK message handler for Swarm agents.
//
// `handleMsg` + `logToolUse` used to be methods on `Swarm`, but they touch a
// narrow, well-defined slice of its state. Extracting them keeps `swarm.ts`
// focused on the worker loop and makes the per-message accounting easier to
// audit in isolation.
//
// The split uses the friend-class pattern: `Swarm` implements
// `MessageHandlerHost`, and these free functions operate against that
// interface. No new indirection, just a visible contract.
import { RATE_LIMIT_WINDOW_SHORT, extractToolTarget, sumUsageTokens } from "../core/types.js";
import { getModelCapability } from "../core/models.js";
import { updateTurn } from "../core/turns.js";
/** Log a tool invocation with a short target extracted from its input. */
export function logToolUse(host, agent, name, input) {
    const target = extractToolTarget(input);
    host.log(agent.id, target ? `${name} \u2192 ${target}` : name);
}
export function handleMsg(host, agent, msg) {
    // Any message that isn't a rate-limit event counts as real progress and
    // resets the stall watchdog + clears the per-agent blocked flag.
    if (msg.type !== "rate_limit_event") {
        host.markProgress();
        if (agent.blockedAt != null)
            agent.blockedAt = undefined;
    }
    switch (msg.type) {
        case "assistant": {
            const m = msg;
            const u = m.message?.usage;
            if (u) {
                const turnTotal = sumUsageTokens(u);
                agent.contextTokens = turnTotal;
                if (turnTotal > (agent.peakContextTokens ?? 0))
                    agent.peakContextTokens = turnTotal;
                const turn = host._agentTurns.get(agent.id);
                if (turn)
                    updateTurn(turn, { contextTokens: turnTotal, peakContextTokens: Math.max(turn.peakContextTokens ?? 0, turnTotal) });
                if (!host.ctxWarned.has(agent)) {
                    const mdl = agent.task.model || host.config.model || "unknown";
                    const safe = getModelCapability(mdl).safeContext;
                    if (safe > 0 && turnTotal > safe * 0.8) {
                        host.ctxWarned.add(agent);
                        const pct = Math.round((turnTotal / safe) * 100);
                        host.log(agent.id, `\u26A0 context ${pct}% of safe window — task may degrade`);
                    }
                }
            }
            if (!m.message?.content)
                break;
            for (const block of m.message.content) {
                if (block.type === "text" && block.text) {
                    const line = block.text.trim().split("\n")[0]?.slice(0, 80);
                    if (line)
                        agent.lastText = line;
                }
            }
            break;
        }
        case "stream_event": {
            const s = msg;
            const ev = s.event;
            if (ev.type === "content_block_start") {
                const cb = ev.content_block;
                if (cb?.type === "tool_use") {
                    agent.currentTool = cb.name;
                    agent.toolCalls++;
                    const input = (cb.input ?? {});
                    const hasInput = Object.keys(input).length > 0;
                    host.pendingTools.set(agent, { name: cb.name, input, buf: "", logged: hasInput });
                    if (hasInput)
                        logToolUse(host, agent, cb.name, input);
                }
                else if (cb?.type === "thinking" || cb?.type === "redacted_thinking") {
                    agent.lastText = "thinking…";
                }
            }
            else if (ev.type === "content_block_delta") {
                const delta = ev.delta;
                const pending = host.pendingTools.get(agent);
                if (delta?.type === "input_json_delta" && pending && typeof delta.partial_json === "string") {
                    pending.buf += delta.partial_json;
                    break;
                }
                // thinking_delta: `delta.thinking`; text_delta: `delta.text`.
                const raw = delta?.type === "text_delta" ? delta.text
                    : delta?.type === "thinking_delta" ? delta.thinking
                        : undefined;
                if (typeof raw === "string") {
                    const t = raw.trim();
                    if (t)
                        agent.lastText = t.slice(-80);
                }
            }
            else if (ev.type === "content_block_stop") {
                const pending = host.pendingTools.get(agent);
                if (pending && !pending.logged) {
                    if (pending.buf) {
                        try {
                            pending.input = JSON.parse(pending.buf);
                        }
                        catch { }
                    }
                    logToolUse(host, agent, pending.name, pending.input);
                    pending.logged = true;
                }
                host.pendingTools.delete(agent);
            }
            break;
        }
        case "result": {
            const safeAdd = (v) => typeof v === 'number' && isFinite(v) && v >= 0 ? v : 0;
            const r = msg;
            agent.currentTool = undefined;
            agent.finishedAt = Date.now();
            const cost = safeAdd(r.total_cost_usd);
            agent.costUsd = cost;
            host.totalCostUsd += cost;
            if (host.isUsingOverage)
                host.overageCostUsd += cost;
            if (r.usage) {
                host.totalInputTokens += safeAdd(r.usage.input_tokens);
                host.totalOutputTokens += safeAdd(r.usage.output_tokens);
            }
            // Surface SDK diagnostics so silent failures stop looking like "did no work".
            const denials = r.permission_denials ?? [];
            if (denials.length > 0) {
                const tools = Array.from(new Set(denials.map(d => d.tool_name))).join(", ");
                host.log(agent.id, `${denials.length} permission denial(s): ${tools}`);
            }
            if (r.terminal_reason && r.terminal_reason !== "completed") {
                host.log(agent.id, `terminal: ${r.terminal_reason}`);
            }
            if (r.stop_reason && r.stop_reason !== "end_turn" && r.stop_reason !== "stop_sequence") {
                host.log(agent.id, `stop: ${r.stop_reason}`);
            }
            if (typeof r.num_turns === "number" && r.num_turns > 0) {
                host.log(agent.id, `${r.num_turns} turns`);
            }
            if (r.subtype === "success") {
                agent.status = "done";
                host.completed++;
            }
            else {
                agent.status = "error";
                const parts = [r.subtype];
                if (r.terminal_reason && r.terminal_reason !== "completed")
                    parts.push(r.terminal_reason);
                const errs = r.errors;
                if (Array.isArray(errs) && errs.length > 0) {
                    parts.push(errs[0]);
                    for (const e of errs.slice(1, 3))
                        host.log(agent.id, `err: ${String(e).slice(0, 160)}`);
                }
                agent.error = parts.join("  -- ").slice(0, 180);
                host.failed++;
                host.log(agent.id, agent.error);
            }
            break;
        }
        case "rate_limit_event": {
            const rl = msg;
            const info = rl.rate_limit_info;
            host.rateLimitUtilization = info.utilization ?? 0;
            if (info.resetsAt)
                host.rateLimitResetsAt = info.resetsAt;
            else if (info.status !== "rejected")
                host.rateLimitResetsAt = undefined;
            if (info.isUsingOverage)
                host.isUsingOverage = true;
            const windowType = info.rateLimitType;
            if (windowType) {
                host.rateLimitWindows.set(windowType, {
                    type: windowType, utilization: info.utilization ?? 0, status: info.status, resetsAt: info.resetsAt,
                });
            }
            const pct = info.utilization != null ? `${Math.round(info.utilization * 100)}%` : "";
            const overageTag = host.isUsingOverage ? " [EXTRA]" : "";
            host.log(agent.id, `Rate: ${info.status} ${pct}${overageTag}${windowType ? ` (${windowType})` : ""}`);
            if (info.status === "rejected") {
                if (!host.rateLimitResetsAt || host.rateLimitResetsAt <= Date.now()) {
                    host.rateLimitResetsAt = Date.now() + 60_000;
                }
                if (!host.rateLimitExplained) {
                    host.rateLimitExplained = true;
                    const name = windowType ? (RATE_LIMIT_WINDOW_SHORT[windowType] ?? windowType.replace(/_/g, " ")) : "Anthropic";
                    const overageNote = host.isUsingOverage ? " even on overage" : "";
                    host.log(-1, `${name} window is full${overageNote}  -- plan-level Anthropic limit, not a claude-overnight cap. Press [r] to retry now, [c] to lower concurrency, or wait for reset.`);
                }
                throw new Error("rate limit rejected  -- retrying");
            }
            break;
        }
    }
}
