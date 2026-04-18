import pty from "node-pty";
export declare const __dirname: string;
/** Lightweight expect-style wrapper around node-pty for E2E terminal testing. */
export declare class PTYProcess {
    private ptyProcess;
    private buffer;
    private dataHandlers;
    exited: boolean;
    exitCode: number | undefined;
    constructor(command: string, args: string[], opts?: pty.IPtyForkOptions);
    /** Send raw text to stdin (supports ANSI escape sequences for arrow keys, etc.) */
    write(text: string): void;
    /** Send a keystroke by name. Supports: Enter, Escape, ArrowUp, ArrowDown, ArrowLeft, ArrowRight */
    key(name: string): void;
    /** Wait until the output buffer contains text matching `pattern`. Returns the raw matched string or throws on timeout. */
    waitFor(pattern: RegExp | string, timeoutMs?: number): Promise<string>;
    /** Wait for visible text (ANSI-stripped) to appear in the terminal output. */
    waitForVisible(text: string, timeoutMs?: number): Promise<void>;
    /** Clear the output buffer. */
    clear(): void;
    /** Current raw output (with ANSI codes). */
    raw(): string;
    /** Current output with ANSI codes stripped. */
    text(): string;
    /** Kill the process. */
    kill(signal?: string): void;
}
/** True if node-pty can spawn (fails in some CI/sandbox environments: `posix_spawnp failed`). */
export declare function canSpawnPty(): boolean;
