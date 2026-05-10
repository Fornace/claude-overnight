import { type PlannerLog } from "./throttle.js";
import type { PlannerOpts } from "./query.js";
/** Driver wrapping `runOneStream` with stall-rotation + transcript framing. */
export declare function runPlannerStreamWithRotation(prompt: string, opts: PlannerOpts, onLog: PlannerLog, initialEnv: Record<string, string> | undefined, isResume: boolean, tname: string | undefined): Promise<string>;
