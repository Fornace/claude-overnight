import { EventEmitter } from "events";
export type StallType = "thinking" | "action" | "betweenTool";
export interface StallThresholds {
    thinking: number;
    action: number;
    betweenTool: number;
}
/** Minimal sink — StreamSink satisfies this; planner passes an inline stub. */
export interface StallGuardSink {
    lastByteAt: number;
    /** Empty string disables the transcript-bus subscription (planner mode). */
    streamId: string;
    finished: boolean;
    path?: string;
}
export type FallbackProviderFn = (model: string | undefined) => Record<string, string> | undefined;
export declare class StallError extends Error {
    readonly elapsedMs: number;
    readonly thresholdMs: number;
    readonly activityType: StallType;
    readonly salvagedText?: string | undefined;
    constructor(elapsedMs: number, thresholdMs: number, activityType: StallType, salvagedText?: string | undefined);
}
export declare function isStallError(err: unknown): err is StallError;
export declare class StallGuard extends EventEmitter {
    readonly thresholds: StallThresholds;
    private _sink;
    private _abort;
    private _interval?;
    private _stopped;
    private _unsub?;
    private _salvagedText?;
    private _assembledDelta;
    private _lastActivityType;
    constructor(sink: StallGuardSink, abortController: AbortController, thresholds?: Partial<StallThresholds>);
    private _onEvent;
    private _tick;
    get salvagedText(): string | undefined;
    stop(): void;
}
export declare class StallMonitor extends EventEmitter {
    private static _instance?;
    private _active;
    private _peakActive;
    private _outageActive;
    private _fallbackProvider?;
    static get instance(): StallMonitor;
    static reset(): void;
    setFallbackProvider(fn: FallbackProviderFn): void;
    getFallbackEnv(model: string | undefined): Record<string, string> | undefined;
    get outageActive(): boolean;
    resetOutage(): void;
    get activeCount(): number;
    register(guard: StallGuard): void;
    unregister(guard: StallGuard): void;
    private _onStall;
    requestRotation(guard?: StallGuard): void;
}
export declare function buildStallResumePrompt(salvaged: string | undefined, fallback?: string): string;
export interface RunWithStallRotationOpts {
    run: (isResume: boolean, prompt: string, env: Record<string, string> | undefined) => Promise<void>;
    initialPrompt: string;
    initialIsResume: boolean;
    initialEnv: Record<string, string> | undefined;
    resolveFallbackEnv: () => Record<string, string> | undefined;
    log: (text: string) => void;
    defaultResumePrompt?: string;
    isAborted?: () => boolean;
    maxRetries?: number;
}
export declare function runWithStallRotation(opts: RunWithStallRotationOpts): Promise<void>;
