// Error classification + sleep helper for the swarm worker loop.
// Kept free-standing so both swarm.ts and the agent-run split can import them
// without tangling the class surface.
export class AgentTimeoutError extends Error {
    constructor(silentMs) {
        super(`Agent silent for ${Math.round(silentMs / 1000)}s  -- assumed hung`);
        this.name = "AgentTimeoutError";
    }
}
/** Thrown when the SDK query stream stops emitting assistant content for too long while still open. */
export class StreamStalledError extends Error {
    elapsed;
    timeoutMs;
    constructor(elapsed, timeoutMs) {
        super(`Stream stalled: no content for ${timeoutMs}ms (last gap ${Math.round(elapsed)}ms)`);
        this.elapsed = elapsed;
        this.timeoutMs = timeoutMs;
        this.name = "StreamStalledError";
    }
}
export function isStreamStalledError(err) {
    return err instanceof StreamStalledError;
}
const asErrorLike = (e) => (e ?? {});
const errStatus = (e) => {
    const v = e.status ?? e.statusCode;
    return typeof v === "number" ? v : undefined;
};
const errMessage = (e, raw) => String(typeof e.message === "string" ? e.message : raw).toLowerCase();
export function isRateLimitError(err) {
    const e = asErrorLike(err);
    if (errStatus(e) === 429)
        return true;
    const msg = errMessage(e, err);
    if (msg.includes("rate limit") || msg.includes("rate_limit") || msg.includes("too many requests"))
        return true;
    if (e.cause && e.cause !== err)
        return isRateLimitError(e.cause);
    return false;
}
export function isTransientError(err) {
    if (err instanceof AgentTimeoutError || err instanceof StreamStalledError)
        return false;
    const e = asErrorLike(err);
    const msg = errMessage(e, err);
    const status = errStatus(e);
    if (status === 429 || (status != null && status >= 500 && status < 600) ||
        msg.includes("rate limit") || msg.includes("overloaded") || msg.includes("econnreset") ||
        msg.includes("etimedout") || msg.includes("socket hang up") || msg.includes("epipe") ||
        msg.includes("econnrefused") || msg.includes("ehostunreach") || msg.includes("network error") ||
        msg.includes("fetch failed") || msg.includes("aborted"))
        return true;
    if (e.cause && e.cause !== err)
        return isTransientError(e.cause);
    return false;
}
export function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}
