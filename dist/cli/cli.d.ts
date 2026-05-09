import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { isJWTAuthError } from "../core/auth.js";
export { isJWTAuthError };
export { parseCliFlags, validateConcurrency, isGitRepo, validateGitRepo } from "./argv.js";
export { ask, select, selectKey, PASTE_PLACEHOLDER_MAX } from "./prompts.js";
export { loadTaskFile, loadPlanFile, type FileArgs } from "./files.js";
export { BRAILLE, showPlan, makeProgressLog, numberedLine } from "./display.js";
/** Fetch the SDK's reported model list. Silent on timeout (callers degrade
 *  to a free-form text prompt); hard-fails on auth errors. */
export declare function fetchModels(timeoutMs?: number): Promise<ModelInfo[]>;
