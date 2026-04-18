import type { MergeStrategy } from "../core/types.js";
import { Swarm } from "../swarm/swarm.js";

// ── Review helpers: post-wave and post-run quality gates ──

export interface ReviewOpts {
  cwd: string;
  plannerModel: string;
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

function reviewPrompt(scope: "wave" | "run", objective?: string): string {
  const scopeLine = scope === "wave"
    ? "Review and simplify all changes from the most recent wave."
    : `You are the final quality gate before this autonomous run completes.\n\nThe objective was: ${objective || "improve the codebase"}`;

  return `${scopeLine}

Invoke the \`simplify\` skill to review changed code for reuse, quality, and efficiency, then fix any issues found.`;
}

async function runReview(
  opts: ReviewOpts,
  scope: "wave" | "run",
  objective?: string,
  onSwarm?: (swarm: Swarm) => void,
): Promise<ReviewResult | null> {
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
  } catch { return null; }
}

export async function runPostWaveReview(opts: ReviewOpts, onSwarm?: (swarm: Swarm) => void): Promise<ReviewResult | null> {
  return runReview(opts, "wave", undefined, onSwarm);
}

export async function runPostRunReview(
  objective: string, opts: ReviewOpts, onSwarm?: (swarm: Swarm) => void,
): Promise<ReviewResult | null> {
  return runReview(opts, "run", objective, onSwarm);
}
