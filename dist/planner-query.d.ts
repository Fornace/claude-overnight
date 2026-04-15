import type { Task, PermMode, RateLimitWindow } from "./types.js";
/**
 * Logging callback used by planner/steering queries.
 * `kind` distinguishes ephemeral status updates (heartbeat ticker) from
 * discrete events worth persisting in a scrollback log (tool uses, retries).
 * Plain (text) callers still work  -- extra arg is ignored.
 */
export type PlannerLog = (text: string, kind?: "status" | "event") => void;
export interface PlannerRateLimitInfo {
    utilization: number;
    status: string;
    isUsingOverage: boolean;
    windows: Map<string, RateLimitWindow>;
    resetsAt?: number;
    costUsd: number;
}
export interface PlannerOpts {
    cwd: string;
    model: string;
    permissionMode: PermMode;
    resumeSessionId?: string;
    outputFormat?: {
        type: "json_schema";
        schema: Record<string, unknown>;
    };
}
export declare function setPlannerEnvResolver(fn: ((model?: string) => Record<string, string> | undefined) | undefined): void;
export declare function getTotalPlannerCost(): number;
export declare function getPlannerRateLimitInfo(): PlannerRateLimitInfo;
export declare function runPlannerQuery(prompt: string, opts: PlannerOpts, onLog: PlannerLog): Promise<string>;
export declare function postProcess(raw: Task[], budget: number | undefined, onLog: (text: string) => void): Task[];
export declare function attemptJsonParse(text: string): any | null;
export declare function extractTaskJson(raw: string, retry: () => Promise<string>, onLog?: (text: string) => void, outFile?: string): Promise<{
    tasks: any[];
}>;
