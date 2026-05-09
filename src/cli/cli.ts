// Barrel + SDK-bound bits that don't fit the focused split modules.

import chalk from "chalk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { isJWTAuthError } from "../core/auth.js";

export { isJWTAuthError };

// Focused modules (split out of this file). Re-exported so existing callers
// — including src/index.ts — can keep importing from "./cli/cli.js".
export { parseCliFlags, validateConcurrency, isGitRepo, validateGitRepo } from "./argv.js";
export { ask, select, selectKey, PASTE_PLACEHOLDER_MAX } from "./prompts.js";
export { loadTaskFile, loadPlanFile, type FileArgs } from "./files.js";
export { BRAILLE, showPlan, makeProgressLog, numberedLine } from "./display.js";

/** Fetch the SDK's reported model list. Silent on timeout (callers degrade
 *  to a free-form text prompt); hard-fails on auth errors. */
export async function fetchModels(timeoutMs = 10_000): Promise<ModelInfo[]> {
  let q: ReturnType<typeof query> | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    q = query({ prompt: "", options: { persistSession: false } });
    const models = await Promise.race([
      q.supportedModels(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("model_fetch_timeout")), timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    q.close();
    return models;
  } catch (err: any) {
    clearTimeout(timer);
    q?.close();
    if (err.message === "model_fetch_timeout") {
      // Silent: callers fall back to a text prompt with the current value as default.
    } else if (isJWTAuthError(err)) {
      console.error(chalk.red("\n  Authentication failed — check your API key or run: claude auth\n"));
      process.exit(1);
    } else {
      console.warn(chalk.yellow(`\n  Could not fetch models: ${String(err.message || err).slice(0, 80)} — continuing with defaults`));
    }
    return [];
  }
}
