import type { Task } from "./types.js";
/**
 * Coordinator: analyzes the codebase, breaks objective into parallel tasks.
 */
export declare function planTasks(objective: string, cwd: string, model: string, onLog: (text: string) => void): Promise<Task[]>;
