import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { Task, MergeStrategy } from "../core/types.js";
export declare function parseCliFlags(argv: string[]): {
    flags: Record<string, string>;
    positional: string[];
};
import { isJWTAuthError } from "../core/auth.js";
/** @deprecated Use isJWTAuthError from auth.ts instead. */
export declare const isAuthError: typeof isJWTAuthError;
export { isJWTAuthError };
export declare function fetchModels(timeoutMs?: number): Promise<ModelInfo[]>;
export declare const PASTE_START = "\u001B[200~";
export declare const PASTE_END = "\u001B[201~";
export declare const PASTE_PLACEHOLDER_MAX = 80;
export type InputSegment = {
    type: "text";
    content: string;
} | {
    type: "paste";
    content: string;
};
/** Split a raw stdin chunk into typed and pasted segments. */
export declare function splitPaste(chunk: string): Array<{
    type: "typed" | "paste";
    text: string;
}>;
export declare function segmentsToString(segs: InputSegment[]): string;
export declare function renderSegments(segs: InputSegment[]): string;
export declare function appendCharToSegments(segs: InputSegment[], ch: string): void;
/** Appends a pasted block. Short single-line pastes inline as text; the rest become placeholders. */
export declare function appendPasteToSegments(segs: InputSegment[], text: string): void;
/** Backspace removes one char, or an entire paste block atomically. */
export declare function backspaceSegments(segs: InputSegment[]): void;
/**
 * Read a line from the user with bracketed-paste awareness.
 * Pasted multi-line text stays in the buffer as a single block  -- only a typed
 * Enter submits. Falls back to cooked readline when stdin isn't a TTY.
 */
export declare function ask(question: string): Promise<string>;
export declare function select<T>(label: string, items: {
    name: string;
    value: T;
    hint?: string;
}[], defaultIdx?: number): Promise<T>;
export declare function selectKey(label: string, options: {
    key: string;
    desc: string;
}[]): Promise<string>;
export interface FileArgs {
    tasks: Task[];
    objective?: string;
    concurrency?: number;
    model?: string;
    cwd?: string;
    allowedTools?: string[];
    beforeWave?: string | string[];
    afterWave?: string | string[];
    afterRun?: string | string[];
    useWorktrees?: boolean;
    mergeStrategy?: MergeStrategy;
    usageCap?: number;
    flexiblePlan?: boolean;
}
/** Load a markdown plan file. Extracts the first H1 as objective and returns the full body as planContent. */
export declare function loadPlanFile(file: string): {
    objective: string;
    planContent: string;
};
export declare function loadTaskFile(file: string): FileArgs;
export declare function validateConcurrency(value: unknown): asserts value is number;
export declare function isGitRepo(cwd: string): boolean;
export declare function validateGitRepo(cwd: string): void;
export declare function showPlan(tasks: Task[]): void;
export declare const BRAILLE: readonly ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Dual-mode progress renderer.
 *
 *  - `status` (default): transient single-line ticker — clears itself each frame.
 *    Use for elapsed-time / cost / rolling tail of model text.
 *  - `event`: permanent log line — scrolls up, ticker redraws underneath.
 *    Use for tool calls and notable state changes.
 *
 *  The two modes cooperate: an event clears the current ticker, writes the
 *  event on its own line, and the next status tick redraws the ticker below.
 *  That gives the user a visible history of what the planner did, with a live
 *  "now" indicator that always stays pinned at the bottom. */
export declare function makeProgressLog(): (text: string, kind?: "status" | "event") => void;
