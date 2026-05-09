import type { Task, MergeStrategy } from "../core/types.js";
export interface FileArgs {
    tasks: Task[];
    objective?: string;
    concurrency?: number;
    model?: string;
    cwd?: string;
    allowedTools?: string[];
    beforeWave?: string | string[];
    afterWave?: string | string[];
    afterRun?: string | string[];
    useWorktrees?: boolean;
    mergeStrategy?: MergeStrategy;
    usageCap?: number;
    flexiblePlan?: boolean;
}
/** Load a markdown plan file. Extracts the first H1 as objective and returns the full body as planContent. */
export declare function loadPlanFile(file: string): {
    objective: string;
    planContent: string;
};
export declare function loadTaskFile(file: string): FileArgs;
