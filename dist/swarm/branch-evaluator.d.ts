import { query } from "@anthropic-ai/claude-agent-sdk";
import { type SwarmConfig } from "./config.js";
import type { ErroredBranchEvaluator } from "./merge.js";
export interface BranchEvaluatorHost {
    readonly config: SwarmConfig;
    readonly activeQueries: Set<ReturnType<typeof query>>;
    model: string | undefined;
    log(agentId: number, text: string): void;
}
/** Build an evaluator that judges whether partial work is coherent enough to merge. */
export declare function buildErroredBranchEvaluator(host: BranchEvaluatorHost): ErroredBranchEvaluator | undefined;
