import type { PermMode, MergeStrategy } from "../core/types.js";
import { Swarm } from "../swarm/swarm.js";
export interface ReviewOpts {
    cwd: string;
    plannerModel: string;
    permissionMode: PermMode;
    concurrency: number;
    remaining: number;
    usageCap: number | undefined;
    allowExtraUsage: boolean;
    extraUsageBudget: number | undefined;
    baseCostUsd: number;
    envForModel: ((model?: string) => Record<string, string> | undefined) | undefined;
    mergeStrategy: MergeStrategy;
    useWorktrees: boolean;
}
export interface ReviewResult {
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    completed: number;
    failed: number;
}
export declare function runPostWaveReview(opts: ReviewOpts, onSwarm?: (swarm: Swarm) => void): Promise<ReviewResult | null>;
export declare function runPostRunReview(objective: string, opts: ReviewOpts, onSwarm?: (swarm: Swarm) => void): Promise<ReviewResult | null>;
