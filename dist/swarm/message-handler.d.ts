import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentState, AITurn, RateLimitWindow } from "../core/types.js";
/** Default: no assistant content for this long means the SDK stream is stuck. */
export declare const NO_CONTENT_TIMEOUT_MS = 15000;
/** @returns false if no stream content has arrived within {@link timeoutMs} of {@link lastContentTimestamp}. */
export declare function checkStreamHealth(lastContentTimestamp: number, timeoutMs: number): boolean;
/** Per-agent pending tool_use block while we wait for the delta stream to
 *  finish materializing the real `input`. */
export interface PendingTool {
    name: string;
    input: Record<string, unknown>;
    buf: string;
    logged: boolean;
}
/** Narrow surface `handleMsg`/`logToolUse` need from the Swarm instance. */
export interface MessageHandlerHost {
    readonly _agentTurns: Map<number, AITurn>;
    readonly pendingTools: WeakMap<AgentState, PendingTool>;
    readonly ctxWarned: WeakSet<AgentState>;
    readonly config: {
        model?: string;
    };
    totalCostUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    completed: number;
    failed: number;
    rateLimitUtilization: number;
    rateLimitResetsAt?: number;
    readonly rateLimitWindows: Map<string, RateLimitWindow>;
    isUsingOverage: boolean;
    overageCostUsd: number;
    rateLimitExplained: boolean;
    markProgress(): void;
    log(agentId: number, text: string): void;
}
/** Log a tool invocation with a short target extracted from its input. */
export declare function logToolUse(host: MessageHandlerHost, agent: AgentState, name: string, input: Record<string, unknown>): void;
export declare function handleMsg(host: MessageHandlerHost, agent: AgentState, msg: SDKMessage): void;
