import { type PlannerLog } from "./throttle.js";
export { type PlannerLog, type PlannerRateLimitInfo, getTotalPlannerCost, getPeakPlannerContext, getPlannerRateLimitInfo, } from "./throttle.js";
export { attemptJsonParse, extractTaskJson } from "./json.js";
export { postProcess } from "./postprocess.js";
export interface PlannerOpts {
    cwd: string;
    model: string;
    resumeSessionId?: string;
    outputFormat?: {
        type: "json_schema";
        schema: Record<string, unknown>;
    };
    /** When set, stream events are appended to <runDir>/transcripts/<name>.ndjson */
    transcriptName?: string;
    /** Hard cap on conversation turns. Defaults to 20. */
    maxTurns?: number;
    /** Tools the planner agent may use. Defaults to the full Claude tool suite. */
    tools?: string[];
    /** Env overrides for this query (takes precedence over shared env resolver). */
    env?: Record<string, string>;
    /** AITurn ID to update with token/cost info during streaming. */
    turnId?: string;
}
export declare function setPlannerEnvResolver(fn: ((model?: string) => Record<string, string> | undefined) | undefined): void;
export declare function runPlannerQuery(prompt: string, opts: PlannerOpts, onLog: PlannerLog): Promise<string>;
