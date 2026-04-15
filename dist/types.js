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
