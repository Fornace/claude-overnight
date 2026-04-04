import type { Task, AgentState, SwarmPhase } from "./types.js";
export interface SwarmConfig {
    tasks: Task[];
    concurrency: number;
    cwd: string;
    model?: string;
    allowedTools?: string[];
    useWorktrees?: boolean;
}
export interface MergeResult {
    branch: string;
    ok: boolean;
    error?: string;
    filesChanged: number;
}
export declare class Swarm {
    readonly agents: AgentState[];
    readonly logs: {
        time: number;
        agentId: number;
        text: string;
    }[];
    readonly startedAt: number;
    readonly total: number;
    completed: number;
    failed: number;
    totalCostUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    phase: SwarmPhase;
    mergeResults: MergeResult[];
    rateLimitUtilization: number;
    rateLimitStatus: string;
    private rateLimitResetsAt?;
    private queue;
    private config;
    private nextId;
    private worktreeBase?;
    constructor(config: SwarmConfig);
    get active(): number;
    get pending(): number;
    run(): Promise<void>;
    log(agentId: number, text: string): void;
    private worker;
    private throttle;
    private runAgent;
    private autoCommit;
    private mergeAll;
    private handleMsg;
}
