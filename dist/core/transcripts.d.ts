export declare function setTranscriptRunDir(dir: string | undefined): void;
export declare function getTranscriptRunDir(): string | undefined;
export declare function transcriptPath(name: string): string | undefined;
/** Append a single event; log to stderr once per name on failure (C5). */
export declare function writeTranscriptEvent(name: string, event: Record<string, unknown>): void;
