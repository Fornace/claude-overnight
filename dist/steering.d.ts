import type { PermMode, SteerResult, RunMemory, WaveSummary } from "./types.js";
import { type PlannerLog } from "./planner-query.js";
export declare function steerWave(objective: string, history: WaveSummary[], remainingBudget: number, cwd: string, plannerModel: string, workerModel: string, fastModel: string | undefined, permissionMode: PermMode, concurrency: number, onLog: PlannerLog, runMemory?: RunMemory): Promise<SteerResult>;
