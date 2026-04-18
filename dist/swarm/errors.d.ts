export declare class AgentTimeoutError extends Error {
    constructor(silentMs: number);
}
export declare function isRateLimitError(err: unknown): boolean;
export declare function isTransientError(err: unknown): boolean;
export declare function sleep(ms: number): Promise<void>;
