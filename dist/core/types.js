export const RATE_LIMIT_WINDOW_SHORT = {
    five_hour: "5h", seven_day: "7d", seven_day_opus: "7d opus",
    seven_day_sonnet: "7d sonnet", overage: "extra",
};
/** Thrown when a query goes silent  -- carries session ID for interrupt+resume. */
export class NudgeError extends Error {
    sessionId;
    constructor(sessionId, silentMs) {
        super(`Silent for ${Math.round(silentMs / 1000)}s  -- nudging`);
        this.sessionId = sessionId;
        this.name = "NudgeError";
    }
}
/** Pick a short, human-readable target for a tool invocation (Read/Grep/Bash/...). */
export function extractToolTarget(input) {
    if (!input)
        return "";
    const p = input.path ?? input.file_path ?? input.pattern;
    if (typeof p === "string" && p)
        return p;
    if (typeof input.command === "string" && input.command) {
        return input.command.split(" ").slice(0, 3).join(" ");
    }
    return "";
}
/** Sum input + cache read + cache creation tokens from a usage object. */
export function sumUsageTokens(u) {
    return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
}
