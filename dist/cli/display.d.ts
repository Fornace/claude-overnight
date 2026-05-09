import type { Task } from "../core/types.js";
export declare const BRAILLE: readonly ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export declare function showPlan(tasks: Task[]): void;
/** Numbered list line: `  N. text` with a dim N. Use for themes, plan reviews, etc. */
export declare function numberedLine(i: number, text: string, padStart?: number): string;
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
