import type { RunState, Task, BranchRecord } from "../core/types.js";
/** Static inputs that don't change between RunState snapshots within a single run. */
export interface RunStateBase {
    cwd: string;
    id: string;
    startedAt: string;
    objective: string;
    budget: number;
    workerModel: string;
    plannerModel: string;
    fastModel: string | undefined;
    workerProviderId?: string;
    plannerProviderId?: string;
    fastProviderId?: string;
    concurrency: number;
    usageCap: number | undefined;
    allowExtraUsage: boolean;
    extraUsageBudget?: number;
    flex: boolean;
    useWorktrees: boolean;
    mergeStrategy: RunState["mergeStrategy"];
    repoFingerprint: string;
    coachedObjective?: string;
    coachedAt?: number;
}
/** Live counters captured at snapshot time. */
export interface RunStateLive {
    remaining: number;
    waveNum: number;
    accCost: number;
    accCompleted: number;
    accFailed: number;
    accIn: number;
    accOut: number;
    accTools: number;
    branches: BranchRecord[];
}
/** Variable-per-snapshot inputs: phase and the task slice for resume. */
export interface RunStateVarying {
    phase: RunState["phase"];
    currentTasks: Task[];
}
export declare function composeRunState(base: RunStateBase, live: RunStateLive, varying: RunStateVarying): RunState;
