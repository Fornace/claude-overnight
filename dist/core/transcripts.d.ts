export declare function setTranscriptRunDir(dir: string | undefined): void;
export declare function getTranscriptRunDir(): string | undefined;
export declare function transcriptPath(name: string): string | undefined;
export declare function writeTranscriptEvent(name: string, event: Record<string, unknown>): void;
export interface TranscriptEvent {
    t: number;
    type: string;
    payload: Record<string, unknown>;
    meta?: {
        streamId?: string;
        agentId?: number;
    };
}
type StreamListener = (evt: TranscriptEvent) => void;
export declare function onStreamEvent(streamId: string, fn: StreamListener): () => void;
export declare class StreamSink {
    readonly streamId: string;
    readonly agentId?: number;
    lastByteAt: number;
    eventCount: number;
    finished: boolean;
    private _path;
    constructor(streamId: string, agentId?: number);
    append(msg: {
        type: string;
    } & Record<string, unknown>): void;
    markFinished(): void;
    get path(): string | undefined;
}
export {};
