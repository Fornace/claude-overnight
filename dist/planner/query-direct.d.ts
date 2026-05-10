import type { PlannerOpts } from "./query.js";
import type { PlannerLog } from "./throttle.js";
export declare function shouldUseDirectFetch(env: Record<string, string> | undefined): boolean;
export declare function runViaDirectFetch(prompt: string, opts: PlannerOpts, env: Record<string, string> | undefined, onLog: PlannerLog): Promise<string>;
