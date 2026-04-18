import type { SteerResult, RunMemory, WaveSummary } from "../core/types.js";
import { type PlannerLog } from "./query.js";
export declare const STEER_SCHEMA: {
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
            goalUpdate: {
                type: string;
            };
            estimatedSessionsRemaining: {
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
export declare function steerWave(objective: string, history: WaveSummary[], remainingBudget: number, cwd: string, plannerModel: string, workerModel: string, fastModel: string | undefined, concurrency: number, onLog: PlannerLog, runMemory?: RunMemory, transcriptName?: string): Promise<SteerResult>;
