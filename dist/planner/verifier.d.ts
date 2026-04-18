import type { Task, SteerResult, WaveSummary } from "../core/types.js";
import { type PlannerLog } from "./query.js";
export declare const VERIFY_SCHEMA: {
    type: "json_schema";
    schema: {
        type: string;
        properties: {
            done: {
                type: string;
            };
            reasoning: {
                type: string;
            };
            statusUpdate: {
                type: string;
            };
            estimatedSessionsRemaining: {
                type: string;
            };
            verifiedCount: {
                type: string;
            };
            retryCount: {
                type: string;
            };
            tasks: {
                type: string;
                items: {
                    type: string;
                    properties: {
                        prompt: {
                            type: string;
                        };
                        model: {
                            type: string;
                        };
                        noWorktree: {
                            type: string;
                        };
                        type: {
                            type: string;
                            enum: string[];
                        };
                        postcondition: {
                            type: string;
                        };
                    };
                    required: string[];
                };
            };
        };
        required: string[];
    };
};
/**
 * Verify the previous wave and compose the next fixed batch of pending tasks.
 *
 * Unlike `steerWave`, the verifier does not invent new tasks — it:
 *   1. Runs the project's build/smoke checks.
 *   2. Fixes shallow regressions in the last wave (edits directly).
 *   3. Picks the next N pending tasks from the user's fixed plan.
 *
 * The model has full tool access so it can actually repair broken commits,
 * not just report on them.
 */
export declare function verifyWave(objective: string, pendingTasks: Task[], lastWave: WaveSummary | undefined, remainingBudget: number, cwd: string, plannerModel: string, concurrency: number, onLog: PlannerLog, transcriptName?: string): Promise<SteerResult>;
