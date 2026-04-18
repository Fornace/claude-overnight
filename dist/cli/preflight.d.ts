import type { ProviderConfig } from "../providers/index.js";
export interface PreflightInput {
    plannerModel: string;
    plannerProvider?: ProviderConfig | undefined;
    workerModel: string;
    workerProvider?: ProviderConfig | undefined;
    fastModel?: string | undefined;
    fastProvider?: ProviderConfig | undefined;
    cwd: string;
}
export interface PreflightResult {
    /** true when the fast provider failed preflight and the caller should drop it */
    fastDegraded: boolean;
}
export declare function runProviderPreflight(input: PreflightInput): Promise<PreflightResult>;
