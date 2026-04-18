/** Single-frame character of a spinner. Exported so any caller can prefix its
 *  own line with a consistent animation without importing the frame arrays. */
export declare function spinnerFrame(kind?: "line" | "dots"): string;
/** Reusable indicator for any in-flight wait. Always shows animation + elapsed
 *  time so no phase ever appears frozen. `eta` (future timestamp) adds a
 *  countdown; `hint` appends a short secondary label.
 *
 *  style:
 *    - "thinking" (cyan): planner/AI reasoning
 *    - "wait"     (magenta): rate-limit / cooldown
 *    - "warn"     (yellow): degraded / blocked
 *    - "info"     (blue): default */
export declare function renderWaitingIndicator(label: string, startedAt: number | undefined, opts?: {
    eta?: number;
    hint?: string;
    style?: "info" | "warn" | "wait" | "thinking";
}): string;
export declare function truncate(s: string, max: number): string;
/** Word-wrap text into lines of at most `max` chars.
 *  Splits on spaces; if a single word exceeds `max` it is hard-broken.
 *  Ignores ANSI escape codes for length calculation. */
export declare function wrap(s: string, max: number): string[];
export declare function fmtTokens(n: number): string;
export declare function fmtDur(ms: number): string;
/** Color a free-form event string by heuristic: green for successes,
 *  magenta for rate-limits, red for failures, yellow for short status tags. */
export declare function colorEvent(text: string): string;
/** Push a grey section divider of the form `--- title ----` into `out`. */
export declare function section(out: string[], w: number, title: string): void;
