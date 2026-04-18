import { Swarm } from "../swarm/swarm.js";
function reviewPrompt(scope, objective) {
    const scopeLine = scope === "wave"
        ? "Review and simplify all changes from the most recent wave."
        : `You are the final quality gate before this autonomous run completes.\n\nThe objective was: ${objective || "improve the codebase"}`;
    return `${scopeLine}

Invoke the \`simplify\` skill to review changed code for reuse, quality, and efficiency, then fix any issues found.`;
}
async function runReview(opts, scope, objective, onSwarm) {
    const swarm = new Swarm({
        tasks: [{ id: `${scope}-review`, prompt: reviewPrompt(scope, objective), noWorktree: false, type: "review" }],
        concurrency: 1, cwd: opts.cwd, model: opts.plannerModel,
        useWorktrees: opts.useWorktrees, mergeStrategy: opts.mergeStrategy, usageCap: opts.usageCap,
        allowExtraUsage: opts.allowExtraUsage, extraUsageBudget: opts.extraUsageBudget,
        baseCostUsd: opts.baseCostUsd, envForModel: opts.envForModel,
    });
    onSwarm?.(swarm);
    try {
        await swarm.run();
        return { costUsd: swarm.totalCostUsd, inputTokens: swarm.totalInputTokens, outputTokens: swarm.totalOutputTokens, completed: swarm.completed, failed: swarm.failed };
    }
    catch {
        return null;
    }
}
export async function runPostWaveReview(opts, onSwarm) {
    return runReview(opts, "wave", undefined, onSwarm);
}
export async function runPostRunReview(objective, opts, onSwarm) {
    return runReview(opts, "run", objective, onSwarm);
}
