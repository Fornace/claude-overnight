import type { RunState, Task } from "../core/types.js";
export declare function countTasksInFile(path: string): number;
export declare function promptResumeOverrides(state: RunState, cliFlags: Record<string, string>, argv: string[], noTTY: boolean, runDir: string): Promise<void>;
export interface DetectResumeInput {
    rootDir: string;
    cwd: string;
    noTTY: boolean;
    tasks: Task[];
    allRuns: {
        dir: string;
        state: RunState;
    }[];
    completedRuns: {
        dir: string;
        state: RunState;
    }[];
    cliFlags: Record<string, string>;
    argv: string[];
}
export interface DetectResumeResult {
    resuming: boolean;
    replanFromScratch: boolean;
    resumeState: RunState | null;
    resumeRunDir: string | undefined;
    continueObjective: string | undefined;
}
export declare function detectResume(input: DetectResumeInput): Promise<DetectResumeResult>;
