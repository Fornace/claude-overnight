import { Swarm } from "../swarm/swarm.js";
import { renderPrompt } from "../prompts/load.js";
async function runReview(opts, scope, objective, onSwarm) {
    const prompt = renderPrompt("50_review/50-1_review", {
        variant: scope === "wave" ? "WAVE" : "RUN",
        vars: { objective: objective || "improve the codebase" },
    });
    const swarm = new Swarm({
        tasks: [{ id: `${scope}-review`, prompt, noWorktree: false, type: "review" }],
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
