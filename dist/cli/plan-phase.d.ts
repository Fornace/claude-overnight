import type { ProviderConfig, EnvResolver } from "../providers/index.js";
import type { Task, PermMode, MergeStrategy, WaveSummary } from "../core/types.js";
export interface PlanPhaseInput {
    objective: string | undefined;
    noTTY: boolean;
    flex: boolean;
    budget: number | undefined;
    concurrency: number;
    cwd: string;
    plannerModel: string;
    workerModel: string;
    fastModel: string | undefined;
    plannerProvider: ProviderConfig | undefined;
    workerProvider: ProviderConfig | undefined;
    fastProvider: ProviderConfig | undefined;
    permissionMode: PermMode;
    usageCap: number | undefined;
    allowExtraUsage: boolean;
    extraUsageBudget: number | undefined;
    useWorktrees: boolean;
    mergeStrategy: MergeStrategy;
    agentTimeoutMs: number | undefined;
    runDir: string;
    designDir: string;
    previousKnowledge: string;
    envForModel: EnvResolver;
    coachedOriginal: string | undefined;
    coachedAt: number | undefined;
}
export interface PlanPhaseResult {
    tasks: Task[];
    thinkingHistory?: WaveSummary;
    thinkingUsed: number;
    thinkingCost: number;
    thinkingIn: number;
    thinkingOut: number;
    thinkingTools: number;
}
export declare function runPlanPhase(input: PlanPhaseInput): Promise<PlanPhaseResult>;
