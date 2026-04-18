import chalk from "chalk";
/** Single-frame character of a spinner. */
export declare function spinnerFrame(kind?: "line" | "dots"): string;
/** Reusable indicator for any in-flight wait. Always shows animation + elapsed
 *  time so no phase ever appears frozen. `eta` (future timestamp) adds a
 *  countdown; `hint` appends a short secondary label.
 *
 *  Returns a chalk-styled string — use inside plain stdout prints or inside an
 *  Ink `<Text>` (ANSI escapes pass through unchanged). */
export declare function renderWaitingIndicator(label: string, startedAt: number | undefined, opts?: {
    eta?: number;
    hint?: string;
    style?: "info" | "warn" | "wait" | "thinking";
}): string;
export declare function truncate(s: string, max: number): string;
/** Visible length of a string — ANSI escapes stripped. Use when aligning
 *  columns of chalk-colored text. */
export declare function visibleLen(s: string): number;
/** `padEnd` that counts visible characters, so ANSI-colored strings align. */
export declare function padVisible(s: string, width: number): string;
/** Word-wrap text into lines of at most `max` chars. Splits on spaces; hard-breaks
 *  single words longer than `max`. Ignores ANSI escape codes for length. */
export declare function wrap(s: string, max: number): string[];
export declare function fmtTokens(n: number): string;
export declare function fmtDur(ms: number): string;
/** Color a free-form event string by heuristic. */
export declare function colorEvent(text: string): string;
/** Context-fill percentage and chalk color for a token count vs safe limit.
 *  Green under 50%, yellow past 50%, red past 80%. */
export declare function contextFillInfo(tokens: number, safe: number): {
    pct: number;
    color: typeof chalk;
};
