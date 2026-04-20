// Single source of truth for constructing a RunState snapshot for persistence.
//
// Two writers used to exist (run.ts and wave-loop.ts) and one drifted —
// silently omitting cwd, which made saved runs invisible to findIncompleteRuns.
// Now both call this. Adding a field to RunState forces an edit here.
//
// `saveRunState` enforces required fields at the write boundary; this module
// enforces them at the call boundary.

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
  runBranch?: string;
  originalRef?: string;
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

export function composeRunState(
  base: RunStateBase,
  live: RunStateLive,
  varying: RunStateVarying,
): RunState {
  return {
    id: base.id, objective: base.objective, budget: base.budget,
    remaining: live.remaining,
    workerModel: base.workerModel, plannerModel: base.plannerModel, fastModel: base.fastModel,
    workerProviderId: base.workerProviderId, plannerProviderId: base.plannerProviderId,
    fastProviderId: base.fastProviderId,
    concurrency: base.concurrency,
    usageCap: base.usageCap, allowExtraUsage: base.allowExtraUsage, extraUsageBudget: base.extraUsageBudget,
    flex: base.flex, useWorktrees: base.useWorktrees, mergeStrategy: base.mergeStrategy,
    waveNum: live.waveNum,
    currentTasks: varying.currentTasks,
    accCost: live.accCost, accCompleted: live.accCompleted, accFailed: live.accFailed,
    accIn: live.accIn, accOut: live.accOut, accTools: live.accTools,
    branches: live.branches,
    phase: varying.phase,
    startedAt: base.startedAt, cwd: base.cwd,
    repoFingerprint: base.repoFingerprint,
    coachedObjective: base.coachedObjective,
    coachedAt: base.coachedAt,
    runBranch: base.runBranch,
    originalRef: base.originalRef,
  };
}
