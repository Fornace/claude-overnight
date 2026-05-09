// Public planner-query entry point. Decides between the SDK streaming
// path and the direct-HTTP bypass, applies the throttle gate, and
// translates `NudgeError` / rate-limit retries into a single retry loop.
//
// Heavy lifting lives in:
//   - ./query-stream.ts  — SDK streaming consumer + transcript framing
//   - ./query-direct.ts  — HTTP POST path for non-Anthropic proxies

import { NudgeError } from "../core/types.js";
import {
  type PlannerLog,
  isRateLimitError,
  throttlePlanner,
  resetPlannerRateLimit,
} from "./throttle.js";
import { sleep } from "../swarm/errors.js";
import { runViaDirectFetch, shouldUseDirectFetch } from "./query-direct.js";
import { runPlannerStreamWithRotation } from "./query-stream.js";

export {
  type PlannerLog,
  type PlannerRateLimitInfo,
  getTotalPlannerCost,
  getPeakPlannerContext,
  getPlannerRateLimitInfo,
} from "./throttle.js";
export { attemptJsonParse, extractTaskJson } from "./json.js";
export { postProcess } from "./postprocess.js";

export interface PlannerOpts {
  cwd: string;
  model: string;
  resumeSessionId?: string;
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  /** When set, stream events are appended to <runDir>/transcripts/<name>.ndjson */
  transcriptName?: string;
  /** Hard cap on conversation turns. Defaults to 20. */
  maxTurns?: number;
  /** Tools the planner agent may use. Defaults to the full Claude tool suite. */
  tools?: string[];
  /** Env overrides for this query (takes precedence over shared env resolver). */
  env?: Record<string, string>;
  /** AITurn ID to update with token/cost info during streaming. */
  turnId?: string;
  /** Skill scribe context. */
  repoFingerprint?: string;
  /** Skill scribe context. */
  runId?: string;
  /** Planner role name for scribe provenance. */
  plannerRole?: string;
}

const RETRY_BACKOFF_MS = [30_000, 60_000, 120_000];
const MAX_RETRIES = 3;

// Shared env resolver — set once at run start, used by every planner query.
let _envResolver: ((model?: string) => Record<string, string> | undefined) | undefined;
export function setPlannerEnvResolver(fn: ((model?: string) => Record<string, string> | undefined) | undefined): void {
  _envResolver = fn;
}

function resolveEnv(opts: PlannerOpts): Record<string, string> | undefined {
  return opts.env ?? _envResolver?.(opts.model);
}

export async function runPlannerQuery(
  prompt: string,
  opts: PlannerOpts,
  onLog: PlannerLog,
): Promise<string> {
  const env = resolveEnv(opts);
  if (shouldUseDirectFetch(env)) return runViaDirectFetch(prompt, opts, env, onLog);

  let currentPrompt = prompt;
  let currentOpts = opts;
  let aborted = false;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await throttlePlanner(onLog, () => aborted);
      return await runPlannerQueryOnce(currentPrompt, currentOpts, onLog);
    } catch (err) {
      if (err instanceof NudgeError) {
        if (err.sessionId) {
          onLog("Silent 15m  -- resuming session with continue", "event");
          currentPrompt = "Continue. Complete the task.";
          currentOpts = { ...opts, resumeSessionId: err.sessionId };
        } else {
          onLog("Silent 15m  -- restarting planner (no session to resume)", "event");
        }
        continue;
      }
      if (attempt < MAX_RETRIES && isRateLimitError(err)) {
        const waitMs = RETRY_BACKOFF_MS[attempt];
        onLog(`Rate limited  -- waiting ${Math.round(waitMs / 1000)}s before retry ${attempt + 1}/${MAX_RETRIES}`, "event");
        await sleep(waitMs);
        continue;
      }
      throw err;
    }
  }
  aborted = true;
  throw new Error("Planner query failed after retries");
}

async function runPlannerQueryOnce(
  prompt: string,
  opts: PlannerOpts,
  onLog: PlannerLog,
): Promise<string> {
  resetPlannerRateLimit(opts.model);
  return runPlannerStreamWithRotation(
    prompt, opts, onLog,
    resolveEnv(opts),
    !!opts.resumeSessionId,
    opts.transcriptName,
  );
}
