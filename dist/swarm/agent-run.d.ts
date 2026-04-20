import { type Query } from "@anthropic-ai/claude-agent-sdk";
import type { Task, AgentState } from "../core/types.js";
import { type SwarmConfig } from "./config.js";
import { type MessageHandlerHost } from "./message-handler.js";
export { buildErroredBranchEvaluator } from "./branch-evaluator.js";
export interface AgentRunHost extends MessageHandlerHost {
    readonly agents: AgentState[];
    readonly queue: Task[];
    readonly config: SwarmConfig;
    readonly activeQueries: Set<Query>;
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
    /** Skill scribe context — populated when allowSkillProposals is true. */
    readonly repoFingerprint?: string;
    readonly runId?: string;
    readonly waveNum?: number;
    windowTag(): string;
    rateLimitSleep(ms: number): Promise<void>;
    checkStall(): void;
    agentSummary(agent: AgentState): string;
}
export declare function runAgent(host: AgentRunHost, task: Task): Promise<void>;
