// Single source of truth for constructing a RunState snapshot for persistence.
//
// Two writers used to exist (run.ts and wave-loop.ts) and one drifted —
// silently omitting cwd, which made saved runs invisible to findIncompleteRuns.
// Now both call this. Adding a field to RunState forces an edit here.
//
// `saveRunState` enforces required fields at the write boundary; this module
// enforces them at the call boundary.
export function composeRunState(base, live, varying) {
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
    };
}
