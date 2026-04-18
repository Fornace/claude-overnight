import type { Task } from "../core/types.js";
/** Detect build errors and return one or more heal tasks. If errors span ≥2 files,
 *  emit one task per file so they heal in parallel without merge conflicts. */
export declare function checkProjectHealth(cwd: string): Task[];
export declare function detectHealthCommand(cwd: string): string | undefined;
