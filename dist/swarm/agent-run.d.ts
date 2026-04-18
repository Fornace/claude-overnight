import { type Query } from "@anthropic-ai/claude-agent-sdk";
import { type PermMode } from "../core/types.js";
import type { Task, AgentState } from "../core/types.js";
import type { ErroredBranchEvaluator } from "./merge.js";
import { type SwarmConfig } from "./config.js";
import { type MessageHandlerHost } from "./message-handler.js";
/** Narrow surface `runAgent` / `buildErroredBranchEvaluator` need from the
 *  Swarm instance. Inherits the message-handler host because the message loop
 *  calls `handleMsg(host, …)`. */
export interface AgentRunHost extends MessageHandlerHost {
    readonly agents: AgentState[];
    readonly queue: Task[];
    readonly config: SwarmConfig;
    readonly activeQueries: Set<Query>;
    readonly _permMode: PermMode | undefined;
    readonly worktreeBase?: string;
    nextId: number;
    paused: boolean;
    aborted: boolean;
    model: string | undefined;
    rateLimitPaused: number;
    rateLimitUtilization: number;
    rateLimitResetsAt?: number;
    isUsingOverage: boolean;
    readonly lastProgressAt: number;
    windowTag(): string;
    rateLimitSleep(ms: number): Promise<void>;
    checkStall(): void;
    agentSummary(agent: AgentState): string;
}
export declare function runAgent(host: AgentRunHost, task: Task): Promise<void>;
/**
 * Build an evaluator that calls the fast model (or worker fallback) to judge
 * whether an errored agent's partial work is coherent enough to merge.
 */
export declare function buildErroredBranchEvaluator(host: AgentRunHost): ErroredBranchEvaluator | undefined;
