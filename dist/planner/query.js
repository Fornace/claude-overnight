// Public planner-query entry point. Decides between the SDK streaming
// path and the direct-HTTP bypass, applies the throttle gate, and
// translates `NudgeError` / rate-limit retries into a single retry loop.
//
// Heavy lifting lives in:
//   - ./query-stream.ts  — SDK streaming consumer + transcript framing
//   - ./query-direct.ts  — HTTP POST path for non-Anthropic proxies
import { NudgeError } from "../core/types.js";
import { isRateLimitError, throttlePlanner, resetPlannerRateLimit, } from "./throttle.js";
import { sleep } from "../swarm/errors.js";
import { runViaDirectFetch, shouldUseDirectFetch } from "./query-direct.js";
import { runPlannerStreamWithRotation } from "./query-stream.js";
export { getTotalPlannerCost, getPeakPlannerContext, getPlannerRateLimitInfo, } from "./throttle.js";
export { attemptJsonParse, extractTaskJson } from "./json.js";
export { postProcess } from "./postprocess.js";
const RETRY_BACKOFF_MS = [30_000, 60_000, 120_000];
const MAX_RETRIES = 3;
// Shared env resolver — set once at run start, used by every planner query.
let _envResolver;
export function setPlannerEnvResolver(fn) {
    _envResolver = fn;
}
function resolveEnv(opts) {
    return opts.env ?? _envResolver?.(opts.model);
}
export async function runPlannerQuery(prompt, opts, onLog) {
    const env = resolveEnv(opts);
    if (shouldUseDirectFetch(env))
        return runViaDirectFetch(prompt, opts, env, onLog);
    let currentPrompt = prompt;
    let currentOpts = opts;
    let aborted = false;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            await throttlePlanner(onLog, () => aborted);
            return await runPlannerQueryOnce(currentPrompt, currentOpts, onLog);
        }
        catch (err) {
            if (err instanceof NudgeError) {
                if (err.sessionId) {
                    onLog("Silent 15m  -- resuming session with continue", "event");
                    currentPrompt = "Continue. Complete the task.";
                    currentOpts = { ...opts, resumeSessionId: err.sessionId };
                }
                else {
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
async function runPlannerQueryOnce(prompt, opts, onLog) {
    resetPlannerRateLimit(opts.model);
    return runPlannerStreamWithRotation(prompt, opts, onLog, resolveEnv(opts), !!opts.resumeSessionId, opts.transcriptName);
}
