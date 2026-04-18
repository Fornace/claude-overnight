export declare class AgentTimeoutError extends Error {
    constructor(silentMs: number);
}
/** Thrown when the SDK query stream stops emitting assistant content for too long while still open. */
export declare class StreamStalledError extends Error {
    readonly elapsed: number;
    readonly timeoutMs: number;
    constructor(elapsed: number, timeoutMs: number);
}
export declare function isStreamStalledError(err: unknown): err is StreamStalledError;
export declare function isRateLimitError(err: unknown): boolean;
export declare function isTransientError(err: unknown): boolean;
export declare function sleep(ms: number): Promise<void>;
