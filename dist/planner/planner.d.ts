import type { Task } from "../core/types.js";
export declare function salvageFromFile(outFile: string | undefined, budget: number | undefined, onLog: (text: string, kind?: "status" | "event") => void, why: string): Task[] | null;
export declare function planTasks(objective: string, cwd: string, plannerModel: string, workerModel: string, budget: number | undefined, concurrency: number, onLog: (text: string) => void, flexNote?: string, outFile?: string, transcriptName?: string): Promise<Task[]>;
export declare function identifyThemes(objective: string, count: number, cwd: string, model: string, onLog?: (text: string) => void, transcriptName?: string): Promise<string[]>;
export declare function buildThinkingTasks(objective: string, themes: string[], designDir: string, plannerModel: string, previousKnowledge?: string): Task[];
export declare function orchestrate(objective: string, designDocs: string, cwd: string, plannerModel: string, workerModel: string, budget: number, concurrency: number, onLog: (text: string) => void, flexNote?: string, outFile?: string, transcriptName?: string): Promise<Task[]>;
export declare function refinePlan(objective: string, previousTasks: Task[], feedback: string, cwd: string, plannerModel: string, workerModel: string, budget: number | undefined, concurrency: number, onLog: (text: string) => void, transcriptName?: string): Promise<Task[]>;
