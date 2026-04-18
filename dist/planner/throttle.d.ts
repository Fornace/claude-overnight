import type { RateLimitWindow } from "../core/types.js";
export interface PlannerRateLimitInfo {
    utilization: number;
    status: string;
    isUsingOverage: boolean;
    windows: Map<string, RateLimitWindow>;
    resetsAt?: number;
    costUsd: number;
    /** Total input tokens (input + cache) from the most recent planner turn — proxy for context-window occupancy. */
    contextTokens?: number;
    /** Model used by the current planner query (for safeContext lookup). */
    model?: string;
}
/**
 * Logging callback used by planner/steering queries.
 * `kind` distinguishes ephemeral status updates (heartbeat ticker) from
 * discrete events worth persisting in a scrollback log (tool uses, retries).
 */
export type PlannerLog = (text: string, kind?: "status" | "event") => void;
export declare function isRateLimitError(err: unknown): boolean;
export declare function getTotalPlannerCost(): number;
export declare function addPlannerCost(costUsd: number): void;
export declare function getPeakPlannerContext(): {
    tokens: number;
    model?: string;
};
export declare function recordPeakContext(tokens: number, model: string): void;
export declare function getPlannerRateLimitInfo(): PlannerRateLimitInfo;
export declare function resetPlannerRateLimit(model: string): void;
export declare function setContextTokens(n: number): void;
export declare function applyRateLimitEvent(info: {
    utilization?: number;
    status?: string;
    isUsingOverage?: boolean;
    resetsAt?: number;
    rateLimitType?: string;
}): void;
/**
 * Proactive rate-limit gate. Called before each planner/steering query to
 * prevent hammering the API when we're already near a limit.
 *
 * Levels:
 *   - rejected -> wait until resetsAt (or 60s fallback)
 *   - utilization >= 90% -> wait 30s with exponential backoff
 *   - utilization >= 75% -> brief 5s cooldown
 *   - utilization < 75% -> pass through immediately
 */
export declare function throttlePlanner(onLog: PlannerLog, aborted: () => boolean): Promise<void>;
